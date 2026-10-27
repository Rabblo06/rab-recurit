import './helpers/use-s3-env'; // FIRST: env is frozen when AppModule is imported
import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../../app.module';
import { ReconcileReport, STORAGE_RECONCILE_LOCK, StorageReconcileCommand } from '../../command/storage-reconcile.command';
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
 * Phase A (storage) review — discovery reliability and recovery of `storage:reconcile` in LIST mode, against REAL
 * PostgreSQL (FORCE RLS, restricted `crewflow_app`) and REAL MinIO (gated on RAB_TEST_S3=1 like every S3 suite).
 * Complements storage-reconcile-list-lock.integration.spec.ts:
 *
 *  1. PAGINATION + PREFIX: with the provider forced to small pages (MaxKeys 7 → many continuation tokens) the listing is
 *     complete (LIST-mode report == HEAD-mode report, 0 HEAD); objects outside `{STORAGE_KEY_PREFIX}/organisations/` in
 *     the same bucket are never listed, reported, HEAD-ed or deleted, even with the Worker's modifying flags.
 *  2. CHANGES DURING A SCAN (after the listing snapshot): a new AVAILABLE row+object is never reported missing (one HEAD
 *     confirms it); a new orphan is not judged until the next run; an object deleted out-of-band after the listing is
 *     NOT reported missing in that run (LIST false negative, one-run window) and IS reported by the next run.
 *  3. S3 OUTAGE IN THE MIDDLE OF THE METADATA PASS, after mutations already committed (Worker flags): the run fails, the
 *     lock is released, committed work stays committed (stale PENDING → FAILED, eligible old image object purged),
 *     evidence (timesheet / shift statement / payslip / roster PDFs, AVAILABLE or DELETED) is untouched, the outage never
 *     produced a false "missing", and the re-run is idempotent: no action is repeated and nothing else is deleted.
 */
jest.setTimeout(300_000);

const describeIf = S3_TEST.enabled ? describe : describe.skip;
type Op = { name: string; key?: string };

describeIf('storage:reconcile — LIST discovery reliability and recovery (PostgreSQL FORCE RLS + MinIO)', () => {
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
  let maxKeysOverride: number | undefined;
  const sdk = new S3Client({
    region: S3_TEST.region,
    endpoint: S3_TEST.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: S3_TEST.accessKeyId, secretAccessKey: S3_TEST.secretAccessKey },
  });
  const WORKER_FLAGS = { failStalePending: true, purgeDeletedImagesOlderThanDays: 30, lockWaitSeconds: 0 } as const;

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
    const factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
    org = await factory.createOrganisation('pa-storage-recovery');
    owner = await factory.createInternalManager(org);
    ctx = { organisationId: org.id, workspaceId: owner.workspaceId!, userId: owner.userId, role: '' };
    expect(drivers.getDriver().name).toBe('S3');
    expect(env.get('STORAGE_RECONCILE_METHOD')).toBe('list'); // the default

    // Count every request the driver's S3 client sends; optionally force small LIST pages (provider-side pagination).
    const client = (drivers.getDriver() as unknown as { client: S3Client }).client;
    const send = client.send.bind(client);
    jest.spyOn(client, 'send').mockImplementation(((command: { constructor: { name: string }; input?: { Key?: string; MaxKeys?: number } }, ...rest: unknown[]) => {
      const name = command.constructor.name.replace(/Command$/, '');
      if (name === 'ListObjectsV2' && maxKeysOverride !== undefined && command.input) command.input.MaxKeys = maxKeysOverride;
      if (recording) ops.push({ name, key: command.input?.Key });
      return (send as (...a: unknown[]) => unknown)(command, ...rest);
    }) as never);
  });

  afterAll(async () => {
    await app?.close();
    await adminDataSource?.destroy();
    sdk.destroy();
  });

  beforeEach(async () => {
    const [flags] = await dataSource.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'core.stored_file'::regclass");
    expect(flags).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect(await dataSource.query('SELECT id FROM core.stored_file')).toEqual([]); // no tenant context → zero rows
  });

  afterEach(() => {
    recording = false;
    ops.length = 0;
    maxKeysOverride = undefined;
    process.exitCode = undefined; // the command sets 1 (integrity problems) / 3 (locked) for the CLI — never leak it into Jest
  });

  // ------------------------------------------------------------------------------------------------------- helpers
  function keyFor(kind: FileKindType, ext: string): string {
    return files.buildObjectKey({ organisationId: org.id, workspaceId: ctx.workspaceId, kind, resourceId: randomUUID(), ext });
  }
  /** A v4-shaped uuid whose FIRST hex digit is fixed, so the row's position in the id-ordered page walk is deterministic. */
  const idStartingWith = (hex: string) => hex + randomUUID().slice(1);

  async function seedRow(
    m: EntityManager,
    opts: { status: string; kind?: FileKindType; withObject?: boolean; deletedAtSql?: string; expiresAtSql?: string; id?: string },
  ): Promise<{ id: string; object_key: string }> {
    const kind = opts.kind ?? FileKind.PROFILE_IMAGE;
    const isPdf = kind.endsWith('_PDF');
    const key = keyFor(kind, isPdf ? 'pdf' : 'png');
    const body = Buffer.from(isPdf ? `%PDF-1.4 ${randomUUID()}` : `png ${randomUUID()}`);
    if (opts.withObject !== false) await drivers.getDriver().put(key, body, { contentType: isPdf ? 'application/pdf' : 'image/png' });
    const [row] = await m.query(
      `INSERT INTO core.stored_file (id, organisation_id, workspace_id, kind, resource_type, resource_id, storage_driver, bucket, object_key,
         original_filename, mime_type, size_bytes, sha256, status, created_by, expires_at, deleted_at)
       VALUES ($1,$2,$3,$4,'user',$5,'S3',$6,$7,'f','application/octet-stream',$8,$9,$10,$11,${opts.expiresAtSql ?? 'NULL'},${opts.deletedAtSql ?? (opts.status === 'DELETED' ? "now() - interval '1 day'" : 'NULL')})
       RETURNING id, object_key`,
      [
        opts.id ?? randomUUID(),
        org.id,
        ctx.workspaceId,
        kind,
        randomUUID(),
        S3_TEST.bucket,
        key,
        body.length,
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
  const tombstone = (ids: string[]) =>
    tenantContext.runInTenantContext(ctx, (m) => m.query(`UPDATE core.stored_file SET status = 'DELETED', deleted_at = now() WHERE id = ANY($1::uuid[])`, [ids]));
  const count = (list: Op[], name: string) => list.filter((o) => o.name === name).length;

  async function listedObjectCount(prefix: string): Promise<number> {
    let token: string | undefined;
    let n = 0;
    do {
      const page = await sdk.send(new ListObjectsV2Command({ Bucket: S3_TEST.bucket, Prefix: prefix, ContinuationToken: token }));
      n += page.KeyCount ?? 0;
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return n;
  }

  async function lockHolders(): Promise<number> {
    const rows = await dataSource.query(
      `SELECT l.pid FROM pg_locks l WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
          AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended($1, 0)`,
      [STORAGE_RECONCILE_LOCK],
    );
    return rows.length;
  }

  async function measured(
    method: 'list' | 'head',
    options: Parameters<StorageReconcileCommand['run']>[1] = {},
  ): Promise<{ report: ReconcileReport | undefined; ops: Op[] }> {
    const original = env.get.bind(env);
    const spy = jest
      .spyOn(env, 'get')
      .mockImplementation(((name: string) => (name === 'STORAGE_RECONCILE_METHOD' ? method : original(name as never))) as never);
    ops.length = 0;
    recording = true;
    const c = new StorageReconcileCommand(dataSource, drivers, env, tenantContext);
    try {
      await c.run([], options);
    } finally {
      recording = false;
      spy.mockRestore();
    }
    return { report: c.lastReport, ops: [...ops] };
  }

  // ======================================================================================================= 1. pagination
  it('1: many small provider pages are followed to the end (LIST report == HEAD report); keys outside the prefix are never listed or touched', async () => {
    const rows = await Promise.all(Array.from({ length: 40 }, () => seed({ status: 'AVAILABLE', kind: FileKind.FINAL_TIMESHEET_PDF })));
    const outside = [
      `other-env/organisations/${org.id}/workspaces/${ctx.workspaceId}/reports/${randomUUID()}.pdf`,
      `test/organisations-archive/${randomUUID()}.pdf`,
      `${randomUUID()}.pdf`,
    ];
    for (const Key of outside) await sdk.send(new PutObjectCommand({ Bucket: S3_TEST.bucket, Key, Body: '%PDF-1.4 outside', ServerSideEncryption: 'AES256' }));

    const objects = await listedObjectCount('test/organisations/');
    expect(objects).toBeGreaterThanOrEqual(rows.length);
    maxKeysOverride = 7;
    const viaHead = await measured('head');
    const viaList = await measured('list', WORKER_FLAGS);
    maxKeysOverride = undefined;

    expect(count(viaList.ops, 'ListObjectsV2')).toBe(Math.ceil(objects / 7)); // every continuation page fetched, once
    expect(count(viaList.ops, 'HeadObject')).toBe(0);
    expect(count(viaList.ops, 'DeleteObject')).toBe(0);
    expect(viaList.report!.checkedRows).toBe(viaHead.report!.checkedRows);
    expect(viaList.report!.orphan_objects).toEqual(viaHead.report!.orphan_objects);
    expect(viaList.report!.missing_objects).toEqual(viaHead.report!.missing_objects);
    expect(viaList.report!.summary).toEqual({ integrityProblems: 0, orphans: 0, stalePending: 0 });
    for (const op of [...viaList.ops, ...viaHead.ops]) for (const key of outside) expect(op.key).not.toBe(key);
    for (const key of outside) {
      expect(viaList.report!.orphan_objects.map((o) => o.key)).not.toContain(key);
      expect(await exists(key)).toBe(true); // never deleted
      await sdk.send(new DeleteObjectCommand({ Bucket: S3_TEST.bucket, Key: key })); // test-created; keep later counts exact
    }
    // Cleanup: tombstone AND remove the test objects, so later tests see no DELETED-with-object rows (each would cost a HEAD).
    await tombstone(rows.map((r) => r.id));
    for (const r of rows) await drivers.getDriver().delete(r.object_key);
  });

  // ======================================================================================================= 2. concurrent change
  it('2: changes after the listing — new file never "missing", new orphan judged next run, out-of-band delete reported next run', async () => {
    const goneLater = await seed({ status: 'AVAILABLE', kind: FileKind.APPROVED_SHIFT_STATEMENT_PDF });
    const lateKey = keyFor(FileKind.FINAL_TIMESHEET_PDF, 'pdf');
    const orphanKey = keyFor(FileKind.FINAL_TIMESHEET_PDF, 'pdf');
    let late: { id: string; object_key: string } | undefined;

    const driver = drivers.getDriver();
    const originalList = driver.list.bind(driver);
    const listSpy = jest.spyOn(driver, 'list').mockImplementationOnce(async function* (prefix: string) {
      yield* originalList(prefix);
      // The listing snapshot is complete; the metadata pass has not started. Now the world changes:
      const body = Buffer.from('%PDF-1.4 written after the listing');
      await driver.put(lateKey, body, { contentType: 'application/pdf' });
      late = await tenantContext.runInTenantContext(ctx, async (m) => {
        const [row] = await m.query(
          `INSERT INTO core.stored_file (organisation_id, workspace_id, kind, resource_type, resource_id, storage_driver, bucket, object_key,
             original_filename, mime_type, size_bytes, sha256, status, created_by)
           VALUES ($1,$2,'FINAL_TIMESHEET_PDF','shift_report',$3,'S3',$4,$5,'t.pdf','application/pdf',$6,$7,'AVAILABLE',$8) RETURNING id, object_key`,
          [org.id, ctx.workspaceId, randomUUID(), S3_TEST.bucket, lateKey, body.length, createHash('sha256').update(body).digest('hex'), ctx.userId],
        );
        return row;
      });
      await driver.put(orphanKey, Buffer.from('%PDF-1.4 orphan after listing'), { contentType: 'application/pdf' });
      await driver.delete(goneLater.object_key); // deleted out of band after the listing saw it
    });

    const first = await measured('list');
    listSpy.mockRestore();
    expect(late).toBeDefined();
    // New AVAILABLE file: absent from the snapshot → exactly one confirming HEAD → not missing.
    expect(first.ops.filter((o) => o.name === 'HeadObject').map((o) => o.key)).toEqual([lateKey]);
    expect(first.report!.missing_objects.map((f) => f.fileId)).not.toContain(late!.id);
    // New orphan: not judged in this run.
    expect(first.report!.orphan_objects.map((o) => o.key)).not.toContain(orphanKey);
    // Out-of-band delete after the snapshot: a one-run false negative of LIST mode (HEAD mode's own window is per row).
    expect(first.report!.missing_objects.map((f) => f.fileId)).not.toContain(goneLater.id);
    expect(first.report!.summary.integrityProblems).toBe(0);

    const second = await measured('list');
    expect(second.report!.missing_objects.map((f) => f.fileId)).toEqual([goneLater.id]); // found by the next run
    expect(second.report!.orphan_objects.map((o) => o.key)).toEqual([orphanKey]); // reported, never deleted
    expect(second.ops.filter((o) => o.name === 'HeadObject').map((o) => o.key)).toEqual([goneLater.object_key]); // late file now settled by the listing
    expect(await exists(orphanKey)).toBe(true);
    expect(await exists(lateKey)).toBe(true);

    await tombstone([goneLater.id, late!.id]);
    for (const key of [orphanKey, lateKey]) await drivers.getDriver().delete(key); // test-created; keep later counts exact
  });

  // ======================================================================================================= 3. outage mid-pass
  it('3: S3 outage mid metadata pass after committed mutations — fails, lock released, evidence untouched, re-run idempotent', async () => {
    // Deterministic page order inside this workspace scope (rows are walked by id).
    const stalePending = await seed({ id: idStartingWith('0'), status: 'PENDING', kind: FileKind.PROFILE_IMAGE, expiresAtSql: "now() - interval '1 hour'" });
    const oldImage = await seed({ id: idStartingWith('1'), status: 'DELETED', kind: FileKind.PROFILE_IMAGE, deletedAtSql: "now() - interval '90 days'" });
    const evidence = await Promise.all([
      seed({ id: idStartingWith('8'), status: 'AVAILABLE', kind: FileKind.FINAL_TIMESHEET_PDF }),
      seed({ id: idStartingWith('8'), status: 'AVAILABLE', kind: FileKind.APPROVED_SHIFT_STATEMENT_PDF }),
      seed({ id: idStartingWith('8'), status: 'AVAILABLE', kind: FileKind.PAYSLIP_PDF }),
      seed({ id: idStartingWith('8'), status: 'AVAILABLE', kind: FileKind.SHIFT_ROSTER_PDF }),
      seed({ id: idStartingWith('9'), status: 'DELETED', kind: FileKind.PAYSLIP_PDF, deletedAtSql: "now() - interval '9999 days'" }),
      seed({ id: idStartingWith('9'), status: 'DELETED', kind: FileKind.FINAL_TIMESHEET_PDF, deletedAtSql: "now() - interval '9999 days'" }),
    ]);
    const statusBefore = await Promise.all(evidence.map((e) => statusOf(e.id)));
    // Last in the walk: an AVAILABLE row whose object is absent → LIST mode HEADs it → the outage hits here.
    const victim = await seed({ id: idStartingWith('f'), status: 'AVAILABLE', kind: FileKind.PROFILE_IMAGE, withObject: false });

    const driver = drivers.getDriver();
    const originalHead = driver.head.bind(driver);
    const headSpy = jest.spyOn(driver, 'head').mockImplementation(async (key: string) => {
      if (key === victim.object_key) throw new Error('simulated S3 outage mid-scan');
      return originalHead(key);
    });
    ops.length = 0;
    recording = true;
    const failing = new StorageReconcileCommand(dataSource, drivers, env, tenantContext);
    await expect(failing.run([], WORKER_FLAGS)).rejects.toThrow('simulated S3 outage mid-scan');
    recording = false;
    headSpy.mockRestore();
    const firstOps = [...ops];

    expect(failing.lastReport).toBeUndefined(); // a failed run reports nothing (the Worker counts it as a failure)
    expect(await lockHolders()).toBe(0); // released by the finally
    // Work committed before the outage stays committed — and it is exactly the two allowed actions.
    expect(await statusOf(stalePending.id)).toBe('FAILED');
    expect(await exists(stalePending.object_key)).toBe(false);
    expect(await statusOf(oldImage.id)).toBe('DELETED');
    expect(await exists(oldImage.object_key)).toBe(false);
    expect(firstOps.filter((o) => o.name === 'DeleteObject').map((o) => o.key).sort()).toEqual([stalePending.object_key, oldImage.object_key].sort());
    // Evidence: rows unchanged, objects present.
    expect(await Promise.all(evidence.map((e) => statusOf(e.id)))).toEqual(statusBefore);
    for (const e of evidence) expect(await exists(e.object_key)).toBe(true);

    // Recovery: the next run completes, repeats nothing, reports the genuinely missing object, deletes nothing else.
    const rerun = await measured('list', WORKER_FLAGS);
    expect(rerun.report).toBeDefined();
    expect(rerun.report!.actions).toEqual([]);
    expect(count(rerun.ops, 'DeleteObject')).toBe(0);
    expect(rerun.report!.missing_objects.map((f) => f.fileId)).toEqual([victim.id]);
    expect(rerun.report!.stale_pending.map((f) => f.fileId)).not.toContain(stalePending.id);
    expect(rerun.report!.failed_with_object.map((f) => f.fileId)).not.toContain(stalePending.id);
    expect(await Promise.all(evidence.map((e) => statusOf(e.id)))).toEqual(statusBefore);
    for (const e of evidence) expect(await exists(e.object_key)).toBe(true);
    expect(await lockHolders()).toBe(0);
  });
});
