import './helpers/use-s3-env'; // FIRST: env is frozen when AppModule is imported
import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { ChildProcess, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../../app.module';
import {
  RECONCILE_LOCKED_EXIT_CODE,
  ReconcileReport,
  STORAGE_RECONCILE_LOCK,
  StorageReconcileCommand,
} from '../../command/storage-reconcile.command';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { FileKind, FileKindType } from '../../engine/core-modules/storage/file-kinds';
import { FileService } from '../../engine/core-modules/storage/file.service';
import { StorageDriverFactory } from '../../engine/core-modules/storage/storage-driver.factory';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { Organisation } from '../../modules/identity/entities';
import { createAdminDataSource } from './helpers/admin-datasource';
import { S3_TEST } from './helpers/s3-env';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Phase A (storage) — `storage:reconcile` cost and leader-lock behaviour against REAL PostgreSQL (FORCE RLS, restricted
 * `crewflow_app` runtime role) and REAL MinIO (gated on RAB_TEST_S3=1, like every S3 suite).
 *
 * S3 operations are counted at the SDK boundary: every command the driver's one S3Client sends is recorded (type + key),
 * so the counts below are exactly the requests MinIO served for this command, nothing inferred.
 */
jest.setTimeout(300_000);

const describeIf = S3_TEST.enabled ? describe : describe.skip;
const SEEDED_AVAILABLE = 1_050; // > one 1000-key LIST page, so pagination is part of what is measured

type Op = { name: string; key?: string };

describeIf('storage:reconcile — LIST comparison and cluster-wide lock (PostgreSQL FORCE RLS + MinIO)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let files: FileService;
  let drivers: StorageDriverFactory;
  let env: EnvironmentService;
  let org: Organisation;
  let owner: TestIdentity;
  let ctx: { organisationId: string; workspaceId: string; userId: string; role: string };
  const ops: Op[] = [];
  let recording = false;
  const sdk = new S3Client({
    region: S3_TEST.region,
    endpoint: S3_TEST.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: S3_TEST.accessKeyId, secretAccessKey: S3_TEST.secretAccessKey },
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    files = moduleRef.get(FileService);
    drivers = moduleRef.get(StorageDriverFactory);
    env = moduleRef.get(EnvironmentService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    const factory = new TestIdentityFactory({
      app,
      dataSource,
      adminDataSource,
      tenantContext,
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
    org = await factory.createOrganisation('pa-storage');
    owner = await factory.createInternalManager(org);
    ctx = { organisationId: org.id, workspaceId: owner.workspaceId!, userId: owner.userId, role: '' };
    expect(drivers.getDriver().name).toBe('S3');
    expect(env.get('STORAGE_RECONCILE_METHOD')).toBe('list'); // the default

    // Count every request the driver's S3 client sends.
    const client = (drivers.getDriver() as unknown as { client: S3Client }).client;
    const send = client.send.bind(client);
    jest.spyOn(client, 'send').mockImplementation(((command: { constructor: { name: string }; input?: { Key?: string } }, ...rest: unknown[]) => {
      if (recording) ops.push({ name: command.constructor.name.replace(/Command$/, ''), key: command.input?.Key });
      return (send as (...a: unknown[]) => unknown)(command, ...rest);
    }) as never);

    // Seed: SEEDED_AVAILABLE consistent AVAILABLE rows with real objects of varying size.
    const seeded: Array<{ key: string; body: Buffer }> = Array.from({ length: SEEDED_AVAILABLE }, (_, i) => ({
      key: keyFor(FileKind.FINAL_TIMESHEET_PDF, 'pdf'),
      body: Buffer.from(`%PDF-1.4 seeded ${i} ${'x'.repeat(i % 97)}`),
    }));
    await pool(seeded, 16, ({ key, body }) => drivers.getDriver().put(key, body, { contentType: 'application/pdf' }));
    await tenantContext.runInTenantContext(ctx, (m) =>
      m.query(
        `INSERT INTO core.stored_file (organisation_id, workspace_id, kind, resource_type, resource_id, storage_driver, bucket, object_key,
           original_filename, mime_type, size_bytes, sha256, status, created_by)
         SELECT $1, $2, 'FINAL_TIMESHEET_PDF', 'shift_report', gen_random_uuid(), 'S3', $3, k, 't.pdf', 'application/pdf', s, h, 'AVAILABLE', $4
           FROM unnest($5::text[], $6::bigint[], $7::text[]) AS u(k, s, h)`,
        [
          org.id,
          ctx.workspaceId,
          S3_TEST.bucket,
          ctx.userId,
          seeded.map((s) => s.key),
          seeded.map((s) => s.body.length),
          seeded.map((s) => createHash('sha256').update(s.body).digest('hex')),
        ],
      ),
    );
  });

  afterAll(async () => {
    await app?.close();
    await adminDataSource?.destroy();
    sdk.destroy();
  });

  beforeEach(async () => {
    // FORCE RLS on stored_file, and the runtime role sees zero rows with no tenant context bound.
    const [flags] = await dataSource.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'core.stored_file'::regclass");
    expect(flags).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect(await dataSource.query('SELECT id FROM core.stored_file')).toEqual([]);
  });

  afterEach(() => {
    recording = false;
    ops.length = 0;
    process.exitCode = undefined; // the command sets 1 (integrity problems) / 3 (locked) for the CLI — never leak it into Jest
  });

  // ------------------------------------------------------------------------------------------------------- helpers
  function keyFor(kind: FileKindType, ext: string, workspaceId: string | null = ctx.workspaceId): string {
    return files.buildObjectKey({ organisationId: org.id, workspaceId, kind, resourceId: randomUUID(), ext });
  }

  async function pool<T>(items: T[], width: number, fn: (item: T) => Promise<unknown>): Promise<void> {
    let next = 0;
    await Promise.all(
      Array.from({ length: width }, async () => {
        while (next < items.length) await fn(items[next++]!);
      }),
    );
  }

  const command = () => new StorageReconcileCommand(dataSource, drivers, env, tenantContext);

  /** Runs one reconcile with the given method and records exactly the S3 requests it sent. */
  async function measured(
    method: 'list' | 'head',
    options: Parameters<StorageReconcileCommand['run']>[1] = {},
  ): Promise<{ report: ReconcileReport | undefined; ops: Op[]; c: StorageReconcileCommand }> {
    const original = env.get.bind(env);
    const spy = jest
      .spyOn(env, 'get')
      .mockImplementation(((name: string) => (name === 'STORAGE_RECONCILE_METHOD' ? method : original(name as never))) as never);
    ops.length = 0;
    recording = true;
    const c = command();
    try {
      await c.run([], options);
    } finally {
      recording = false;
      spy.mockRestore();
    }
    return { report: c.lastReport, ops: [...ops], c };
  }

  const count = (list: Op[], name: string) => list.filter((o) => o.name === name).length;

  async function listedObjectCount(): Promise<number> {
    let token: string | undefined;
    let n = 0;
    do {
      const page = await sdk.send(new ListObjectsV2Command({ Bucket: S3_TEST.bucket, Prefix: 'test/organisations/', ContinuationToken: token }));
      n += page.KeyCount ?? 0;
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return n;
  }

  async function seedRow(
    m: EntityManager,
    opts: { status: string; kind?: FileKindType; withObject?: boolean; deletedAtSql?: string; expiresAtSql?: string; sizeOverride?: number },
  ): Promise<{ id: string; object_key: string }> {
    const kind = opts.kind ?? FileKind.PROFILE_IMAGE;
    const isPdf = kind.endsWith('_PDF');
    const key = keyFor(kind, isPdf ? 'pdf' : 'png');
    const body = Buffer.from(isPdf ? `%PDF-1.4 ${randomUUID()}` : `png ${randomUUID()}`);
    if (opts.withObject !== false) await drivers.getDriver().put(key, body, { contentType: isPdf ? 'application/pdf' : 'image/png' });
    const [row] = await m.query(
      `INSERT INTO core.stored_file (organisation_id, workspace_id, kind, resource_type, resource_id, storage_driver, bucket, object_key,
         original_filename, mime_type, size_bytes, sha256, status, created_by, expires_at, deleted_at)
       VALUES ($1,$2,$3,'user',$4,'S3',$5,$6,'f','application/octet-stream',$7,$8,$9,$10,${opts.expiresAtSql ?? 'NULL'},${opts.deletedAtSql ?? (opts.status === 'DELETED' ? "now() - interval '1 day'" : 'NULL')})
       RETURNING id, object_key`,
      [
        org.id,
        ctx.workspaceId,
        kind,
        randomUUID(),
        S3_TEST.bucket,
        key,
        opts.sizeOverride ?? body.length,
        opts.status === 'AVAILABLE' ? createHash('sha256').update(body).digest('hex') : null,
        opts.status,
        ctx.userId,
      ],
    );
    return row;
  }
  const seed = (opts: Parameters<typeof seedRow>[1]) => tenantContext.runInTenantContext(ctx, (m) => seedRow(m, opts));
  const exists = async (key: string) => Boolean(await drivers.getDriver().head(key));
  const statusOf = async (id: string) =>
    (await tenantContext.runInTenantContext(ctx, (m) => m.query('SELECT status FROM core.stored_file WHERE id = $1', [id])))[0]?.status;

  // ======================================================================================================= 1. op counts
  it('1: head mode = 1 HEAD per row + LIST pages; list mode = 0 HEAD + the same LIST pages, and an identical report', async () => {
    const objects = await listedObjectCount();
    expect(objects).toBeGreaterThanOrEqual(SEEDED_AVAILABLE);
    const pages = Math.max(1, Math.ceil(objects / 1000));

    const before = await measured('head');
    const after = await measured('list');
    const inNamespace = before.report!.checkedRows - before.report!.key_outside_namespace.length;

    // Evidence line (grepped into the hand-back): exact request counts for the same data, before vs after.
    // eslint-disable-next-line no-console
    console.log(
      `PA-STORAGE-OPS ${JSON.stringify({
        rows: before.report!.checkedRows,
        objects,
        head: { HEAD: count(before.ops, 'HeadObject'), LIST: count(before.ops, 'ListObjectsV2'), total: before.ops.length },
        list: { HEAD: count(after.ops, 'HeadObject'), LIST: count(after.ops, 'ListObjectsV2'), total: after.ops.length },
      })}`,
    );
    expect(before.report!.checkedRows).toBeGreaterThanOrEqual(SEEDED_AVAILABLE);
    expect(count(before.ops, 'HeadObject')).toBe(inNamespace);
    expect(count(before.ops, 'ListObjectsV2')).toBe(pages);
    expect(count(after.ops, 'HeadObject')).toBe(0);
    expect(count(after.ops, 'ListObjectsV2')).toBe(pages);
    expect(after.ops.length).toBe(pages); // nothing else: no GET, PUT or DELETE in a report-only run
    expect(after.report).toEqual(before.report);
    expect(after.report!.summary).toEqual({ integrityProblems: 0, orphans: 0, stalePending: 0 });
  });

  // ======================================================================================================= 2. integrity
  it('2: a missing object and a size mismatch are still detected — HEAD-confirmed for exactly those two rows', async () => {
    const missing = await seed({ status: 'AVAILABLE' });
    await drivers.getDriver().delete(missing.object_key);
    const mismatch = await seed({ status: 'AVAILABLE', sizeOverride: 999_999 });

    const viaList = await measured('list');
    const viaHead = await measured('head');
    expect(viaList.report!.missing_objects.map((f) => f.fileId)).toEqual([missing.id]);
    expect(viaList.report!.size_mismatches).toEqual([{ fileId: mismatch.id, expected: 999_999, actual: expect.any(Number) }]);
    expect(viaList.report!.summary.integrityProblems).toBe(2);
    // Same categories and values as the historical per-row HEAD.
    expect(viaList.report!.missing_objects).toEqual(viaHead.report!.missing_objects);
    expect(viaList.report!.size_mismatches).toEqual(viaHead.report!.size_mismatches);
    // Only the two unresolved rows cost a HEAD.
    expect(viaList.ops.filter((o) => o.name === 'HeadObject').map((o) => o.key).sort()).toEqual([missing.object_key, mismatch.object_key].sort());
    expect(process.exitCode).toBe(1); // CLI contract unchanged: integrity problems → exit 1

    // Clean up so later counts stay exact: tombstone both (status change through the runtime role, as FileService would).
    await tenantContext.runInTenantContext(ctx, (m) =>
      m.query(`UPDATE core.stored_file SET status = 'DELETED', deleted_at = now() WHERE id = ANY($1::uuid[])`, [[missing.id, mismatch.id]]),
    );
    await drivers.getDriver().delete(mismatch.object_key);
  });

  // ======================================================================================================= 3. terminal rows
  it('3: terminal rows (FAILED/DELETED) with no object cost no storage call; with an object, one HEAD each; PENDING never', async () => {
    const goneFailed = await seed({ status: 'FAILED', withObject: false });
    const goneDeleted = await seed({ status: 'DELETED', withObject: false });
    const keptFailed = await seed({ status: 'FAILED' });
    const keptDeleted = await seed({ status: 'DELETED', kind: FileKind.PAYSLIP_PDF, deletedAtSql: "now() - interval '9999 days'" });
    const pending = await seed({ status: 'PENDING', expiresAtSql: "now() + interval '1 hour'" });

    const run = await measured('list');
    const headKeys = run.ops.filter((o) => o.name === 'HeadObject').map((o) => o.key);
    expect(headKeys.sort()).toEqual([keptFailed.object_key, keptDeleted.object_key].sort());
    for (const skipped of [goneFailed, goneDeleted, pending]) expect(headKeys).not.toContain(skipped.object_key);
    expect(run.report!.failed_with_object.map((f) => f.fileId)).toContain(keptFailed.id);
    expect(run.report!.deleted_with_object.map((f) => f.fileId)).toContain(keptDeleted.id);
    expect(run.report!.failed_with_object.map((f) => f.fileId)).not.toContain(goneFailed.id);
    expect(run.report!.deleted_with_object.map((f) => f.fileId)).not.toContain(goneDeleted.id);
    expect(run.report!.actions).toEqual([]); // report-only: nothing mutated
    expect(await exists(keptFailed.object_key)).toBe(true);
    expect(await exists(keptDeleted.object_key)).toBe(true);
    expect(await statusOf(pending.id)).toBe('PENDING');
  });

  // ======================================================================================================= 4. evidence
  it('4: the Worker flags never delete payroll/timesheet evidence or orphans — only the eligible old DELETED image', async () => {
    const eligibleImage = await seed({ status: 'DELETED', kind: FileKind.PROFILE_IMAGE, deletedAtSql: "now() - interval '90 days'" });
    const youngImage = await seed({ status: 'DELETED', kind: FileKind.PROFILE_IMAGE, deletedAtSql: "now() - interval '2 days'" });
    const evidence = await Promise.all(
      [FileKind.FINAL_TIMESHEET_PDF, FileKind.APPROVED_SHIFT_STATEMENT_PDF, FileKind.PAYSLIP_PDF, FileKind.SHIFT_ROSTER_PDF].map((kind) =>
        seed({ status: 'DELETED', kind, deletedAtSql: "now() - interval '9999 days'" }),
      ),
    );
    const liveEvidence = await seed({ status: 'AVAILABLE', kind: FileKind.PAYSLIP_PDF });
    const orphanKey = keyFor(FileKind.FINAL_TIMESHEET_PDF, 'pdf');
    await drivers.getDriver().put(orphanKey, Buffer.from('%PDF-1.4 orphan'), { contentType: 'application/pdf' });

    // Exactly what the scheduled job passes.
    const run = await measured('list', { failStalePending: true, purgeDeletedImagesOlderThanDays: 30, lockWaitSeconds: 0 });
    expect(run.ops.filter((o) => o.name === 'DeleteObject').map((o) => o.key)).toEqual([eligibleImage.object_key]);
    expect(run.report!.actions).toEqual([`purged object of deleted image ${eligibleImage.id}`]);
    expect(await exists(eligibleImage.object_key)).toBe(false);
    for (const kept of [youngImage, ...evidence, liveEvidence]) expect(await exists(kept.object_key)).toBe(true);
    expect(await exists(orphanKey)).toBe(true);
    expect(run.report!.orphan_objects.map((o) => o.key)).toContain(orphanKey);
    for (const row of evidence) expect(await statusOf(row.id)).toBe('DELETED');
    expect(await statusOf(liveEvidence.id)).toBe('AVAILABLE');
    await drivers.getDriver().delete(orphanKey); // keep later counts exact
  });

  // ======================================================================================================= 5. lock
  it('5: two concurrent reconcilers — exactly one runs; the other (Worker, wait 0) skips with no storage or metadata work', async () => {
    const driver = drivers.getDriver();
    const originalList = driver.list.bind(driver);
    let entered!: () => void;
    const enteredList = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const listSpy = jest.spyOn(driver, 'list').mockImplementationOnce(async function* (prefix: string) {
      entered();
      await gate;
      yield* originalList(prefix);
    });

    const a = command();
    const aRun = a.run([], { lockWaitSeconds: 0 });
    await enteredList; // A holds the lock and is mid-reconciliation

    // The lock is held by a crewflow_app session (the restricted runtime role), under the documented key.
    const holders = await dataSource.query(
      `SELECT a.usename FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
          AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended($1, 0)`,
      [STORAGE_RECONCILE_LOCK],
    );
    expect(holders).toEqual([{ usename: 'crewflow_app' }]);

    const readPage = jest.spyOn(StorageReconcileCommand.prototype as unknown as { readPage: () => unknown }, 'readPage');
    ops.length = 0;
    recording = true;
    const losers = [command(), command(), command()];
    await Promise.all(losers.map((c) => c.run([], { lockWaitSeconds: 0 })));
    recording = false;
    for (const loser of losers) {
      expect(loser.lastSkipped).toBe('locked');
      expect(loser.lastReport).toBeUndefined();
    }
    expect(ops).toEqual([]); // no S3 request at all from the losers
    expect(readPage).not.toHaveBeenCalled(); // and no stored_file read
    expect(process.exitCode).toBe(RECONCILE_LOCKED_EXIT_CODE);
    process.exitCode = undefined;

    // A CLI-style run (bounded wait) queues behind A and runs once A releases.
    let aFinishedAt = 0;
    const cli = command();
    const cliRun = cli.run([], { lockWaitSeconds: 60 }).then(() => Date.now());
    await new Promise((r) => setTimeout(r, 1_200)); // the CLI run is polling the lock now
    release();
    await aRun.then(() => (aFinishedAt = Date.now()));
    const cliFinishedAt = await cliRun;
    readPage.mockRestore();
    listSpy.mockRestore();
    expect(a.lastReport).toBeDefined();
    expect(cli.lastSkipped).toBeUndefined();
    expect(cli.lastReport).toBeDefined();
    expect(cliFinishedAt).toBeGreaterThanOrEqual(aFinishedAt);
    // Released afterwards: a fresh non-blocking attempt succeeds.
    const after = command();
    await after.run([], { lockWaitSeconds: 0 });
    expect(after.lastSkipped).toBeUndefined();
  });

  // ======================================================================================================= 6. crash
  it('6a: a run that throws mid-way releases the lock (the next non-blocking run proceeds)', async () => {
    const driver = drivers.getDriver();
    const listSpy = jest.spyOn(driver, 'list').mockImplementationOnce(async function* () {
      throw new Error('simulated storage outage mid-run');
    });
    await expect(command().run([], { lockWaitSeconds: 0 })).rejects.toThrow('simulated storage outage mid-run');
    listSpy.mockRestore();
    const next = command();
    await next.run([], { lockWaitSeconds: 0 });
    expect(next.lastSkipped).toBeUndefined();
    expect(next.lastReport).toBeDefined();
  });

  it('6b: a holder process that is KILLED releases the lock with its session (no stale lease, no manual cleanup)', async () => {
    const script = `
      const { Client } = require('pg');
      const c = new Client({ connectionString: process.env.DATABASE_URL });
      c.connect()
        .then(() => c.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [process.argv[1]]))
        .then((r) => { process.stdout.write(r.rows[0].locked ? 'held\\n' : 'not-held\\n'); setInterval(() => {}, 1000); })
        .catch((e) => { process.stdout.write('error ' + e.message + '\\n'); process.exit(2); });
    `;
    const child: ChildProcess = spawn(process.execPath, ['-e', script, STORAGE_RECONCILE_LOCK], {
      env: { ...process.env, NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
      const first = await new Promise<string>((resolve) => child.stdout!.once('data', (d: Buffer) => resolve(d.toString().trim())));
      expect(first).toBe('held');
      const blocked = command();
      await blocked.run([], { lockWaitSeconds: 0 });
      expect(blocked.lastSkipped).toBe('locked');
      process.exitCode = undefined;

      child.kill('SIGKILL'); // a crash: no unlock, no clean disconnect
      const recovered = command();
      const startedAt = Date.now();
      await recovered.run([], { lockWaitSeconds: 60 });
      expect(recovered.lastSkipped).toBeUndefined();
      expect(recovered.lastReport).toBeDefined();
      expect(Date.now() - startedAt).toBeLessThan(60_000);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });

  // ======================================================================================================= 7. role guard
  it('7: an owner connection is still refused before any lock or storage access', async () => {
    ops.length = 0;
    recording = true;
    const bad = new StorageReconcileCommand(adminDataSource, drivers, env, tenantContext);
    await expect(bad.run([], {})).rejects.toThrow(/Refusing to start/);
    recording = false;
    expect(ops).toEqual([]);
  });
});
