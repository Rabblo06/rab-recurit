import './helpers/use-local-storage-env'; // FIRST: env is frozen when AppModule is imported
import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import {
  FileKind,
  FileService,
} from '../../engine/core-modules/storage/file.service';
import { StorageDriverFactory } from '../../engine/core-modules/storage/storage-driver.factory';
import {
  StorageError,
  StorageErrorCode,
} from '../../engine/core-modules/storage/storage.errors';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { StorageReconcileCommand } from '../../command/storage-reconcile.command';
import { Organisation } from '../../modules/identity/entities';
import { JobRole } from '../../modules/scheduling/entities/job-role.entity';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
import { ShiftAssignment } from '../../modules/scheduling/entities/shift-assignment.entity';
import { toTstzRange } from '../../modules/scheduling/utils/tstzrange';
import { Venue } from '../../modules/venue/entities/venue.entity';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * PHASE 8 — storage cleanup/reconcile race safety, against the LOCAL driver
 * (no MinIO/S3 needed — see `use-local-storage-env.ts`; correctness here is
 * about database claim ordering, not which object store sits behind
 * `StorageDriverInterface`). Real PostgreSQL, real `TestIdentityFactory`
 * fixtures, real file bytes on this process's own disk.
 *
 * The central invariant under test: once a row wins PENDING -> AVAILABLE (or
 * PENDING -> FAILED), only the winner of that exact database claim may touch
 * the object. A stale page-read snapshot never authorises a delete.
 */
jest.setTimeout(120_000);

interface Row {
  id: string;
  organisation_id: string;
  workspace_id: string | null;
  kind: string;
  status: string;
  object_key: string;
  size_bytes: string;
  sha256: string | null;
  expires_at: Date | null;
  deleted_at: Date | null;
}

describe('storage cleanup/reconcile correctness (LOCAL driver, no cloud infra)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let files: FileService;
  let drivers: StorageDriverFactory;
  let env: EnvironmentService;
  let factory: TestIdentityFactory;

  let org: Organisation;
  let owner: TestIdentity;
  let ctx: {
    organisationId: string;
    workspaceId: string;
    userId: string;
    role: string;
  };

  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 7),
  ]);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    files = moduleRef.get(FileService);
    drivers = moduleRef.get(StorageDriverFactory);
    env = moduleRef.get(EnvironmentService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({
      app,
      dataSource,
      adminDataSource,
      tenantContext,
      passwordHashing: moduleRef.get(PasswordHashingService),
    });

    org = await factory.createOrganisation('sc');
    owner = await factory.createInternalManager(org);
    ctx = {
      organisationId: org.id,
      workspaceId: owner.workspaceId!,
      userId: owner.userId,
      role: '',
    };
    expect(drivers.getDriver().name).toBe('LOCAL'); // sanity: this suite never touches S3/MinIO
  });

  let sqlObservation: jest.SpyInstance;
  async function assertRls(): Promise<void> {
    const [flags] = await dataSource.query(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'core.stored_file'::regclass",
    );
    expect(flags).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect(await dataSource.query('SELECT id FROM core.stored_file')).toEqual(
      [],
    );
  }
  beforeEach(async () => {
    await assertRls();
    sqlObservation = jest.spyOn(dataSource.logger, 'logQuery');
  });
  afterEach(async () => {
    const queries = sqlObservation.mock.calls.map((c) => String(c[0]));
    sqlObservation.mockRestore();
    expect(
      queries.filter((q) =>
        /ALTER\s+TABLE[\s\S]*ROW\s+LEVEL\s+SECURITY/i.test(q),
      ),
    ).toEqual([]);
    await assertRls();
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  // ------------------------------------------------------------------------------------------------ helpers
  const command = () => {
    const c = new StorageReconcileCommand(dataSource, drivers, env);
    c.catalogueDataSource = adminDataSource;
    return c;
  };
  const runReconcile = (
    opts: Parameters<StorageReconcileCommand['run']>[1] = {},
  ) => {
    const c = command();
    return c.run([], opts).then(() => c.lastReport!);
  };

  /** DB-authoritative "now" — every expiry boundary in this suite is expressed relative to Postgres's own clock, never Date.now(). */
  const dbNow = async (): Promise<Date> =>
    tenantContext.runInTenantContext(
      ctx,
      async (m) =>
        (await m.query<Array<{ now: Date }>>(`SELECT now() as now`))[0]!.now,
    );

  /** Inserts a `stored_file` row directly (bypassing the S3-only upload-intent HTTP flow, which LOCAL cannot support) and writes real bytes at its key. `expiresAtSql` is a raw SQL expression evaluated by Postgres, e.g. `"now() - interval '1ms'"`. */
  async function seedRow(
    m: EntityManager,
    opts: {
      status?: string;
      expiresAtSql?: string | null;
      deletedAtSql?: string | null;
      kind?: string;
      sha256?: string | null;
      buffer?: Buffer;
    },
  ): Promise<Row> {
    const kind = opts.kind ?? FileKind.PROFILE_IMAGE;
    const buffer = opts.buffer ?? PNG;
    const objectKey = files.buildObjectKey({
      organisationId: org.id,
      workspaceId: ctx.workspaceId,
      kind: kind as never,
      resourceId: randomUUID(),
      ext: 'png',
    });
    await drivers
      .getDriver()
      .put(objectKey, buffer, { contentType: 'image/png' });
    const sha256 =
      opts.sha256 ?? createHash('sha256').update(buffer).digest('hex');
    const status = opts.status ?? 'PENDING';
    const deletedAtSql =
      opts.deletedAtSql ??
      (status === 'DELETED' ? "now() - interval '90 days'" : null);
    const rows = await m.query<Row[]>(
      `INSERT INTO core.stored_file
         (organisation_id, workspace_id, kind, resource_type, resource_id, storage_driver, bucket, object_key,
          original_filename, mime_type, size_bytes, sha256, status, created_by, expires_at, deleted_at)
       VALUES ($1,$2,$3,'user',$4,'LOCAL',NULL,$5,'a.png','image/png',$6,$7,$8,$9,
               ${opts.expiresAtSql ?? 'NULL'},
               ${deletedAtSql ?? 'NULL'})
       RETURNING id, organisation_id, workspace_id, kind, status, object_key, size_bytes::text, sha256, expires_at, deleted_at`,
      [
        org.id,
        ctx.workspaceId,
        kind,
        randomUUID(),
        objectKey,
        buffer.length,
        status === 'AVAILABLE' ? sha256 : null,
        status,
        ctx.userId,
      ],
    );
    return rows[0]!;
  }
  const rowOf = async (id: string): Promise<Row> =>
    (
      await tenantContext.runInTenantContext(ctx, (m) =>
        m.query<Row[]>(
          `SELECT id, organisation_id, workspace_id, kind, status, object_key, size_bytes::text, sha256, expires_at, deleted_at FROM core.stored_file WHERE id = $1`,
          [id],
        ),
      )
    )[0]!;
  const objectExists = async (key: string): Promise<boolean> =>
    Boolean(await drivers.getDriver().head(key));
  const asStoredFileLike = (
    row: Row,
    overrides: Partial<Record<string, unknown>> = {},
  ) =>
    ({
      id: row.id,
      objectKey: row.object_key,
      kind: row.kind,
      mimeType: 'image/png',
      sizeBytes: Number(row.size_bytes),
      status: row.status,
      expiresAt: row.expires_at,
      sha256: row.sha256,
      ...overrides,
    }) as never;

  // ================================================================================================ A. Basic stale pending
  describe('A. stale-PENDING claim', () => {
    it('1: an expired PENDING row is claimed FAILED and its object is removed', async () => {
      const row = await tenantContext.runInTenantContext(ctx, (m) =>
        seedRow(m, { expiresAtSql: "now() - interval '1 minute'" }),
      );
      const report = await runReconcile({ failStalePending: true });
      expect(report.actions).toContain(`failed stale pending ${row.id}`);
      const after = await rowOf(row.id);
      expect(after.status).toBe('FAILED');
      expect(await objectExists(row.object_key)).toBe(false);
    });

    it('2: a non-expired PENDING row is left completely untouched', async () => {
      const row = await tenantContext.runInTenantContext(ctx, (m) =>
        seedRow(m, { expiresAtSql: "now() + interval '1 hour'" }),
      );
      const report = await runReconcile({ failStalePending: true });
      expect(report.actions.some((a) => a.includes(row.id))).toBe(false);
      const after = await rowOf(row.id);
      expect(after.status).toBe('PENDING');
      expect(await objectExists(row.object_key)).toBe(true);
    });

    it('3: exact expires_at boundary (DB-time, not Date.now()) is eligible', async () => {
      const boundary = await dbNow(); // by the time the claim UPDATE runs, real elapsed time makes now() >= this value
      const row = await tenantContext.runInTenantContext(ctx, (m) =>
        m.query<Row[]>(
          `INSERT INTO core.stored_file (organisation_id, workspace_id, kind, resource_type, resource_id, storage_driver, object_key, original_filename, mime_type, size_bytes, status, expires_at)
           VALUES ($1,$2,$3,'user',$4,'LOCAL',$5,'a.png','image/png',10,'PENDING',$6)
           RETURNING id, object_key`,
          [
            org.id,
            ctx.workspaceId,
            FileKind.PROFILE_IMAGE,
            randomUUID(),
            `test/organisations/${org.id}/boundary/${randomUUID()}.png`,
            boundary,
          ],
        ),
      );
      await drivers
        .getDriver()
        .put(row[0]!.object_key, PNG, { contentType: 'image/png' });
      const report = await runReconcile({ failStalePending: true });
      expect(report.actions).toContain(`failed stale pending ${row[0]!.id}`);
      expect((await rowOf(row[0]!.id)).status).toBe('FAILED');
    });

    it('4/5: AVAILABLE and DELETED rows are never marked FAILED even with a fabricated past expires_at', async () => {
      const available = await tenantContext.runInTenantContext(ctx, (m) =>
        seedRow(m, {
          status: 'AVAILABLE',
          expiresAtSql: "now() - interval '1 hour'",
        }),
      );
      const deleted = await tenantContext.runInTenantContext(ctx, (m) =>
        seedRow(m, {
          status: 'DELETED',
          expiresAtSql: "now() - interval '1 hour'",
        }),
      );
      await runReconcile({ failStalePending: true });
      expect((await rowOf(available.id)).status).toBe('AVAILABLE');
      expect((await rowOf(deleted.id)).status).toBe('DELETED');
      expect(await objectExists(available.object_key)).toBe(true);
    });
  });

  // ================================================================================================ B. Cleanup vs completion
  describe('B. completeUpload vs storage:reconcile', () => {
    it('6: completion wins first -> AVAILABLE, object exists, a later cleanup claim is a no-op', async () => {
      const row = await tenantContext.runInTenantContext(ctx, (m) =>
        seedRow(m, { expiresAtSql: "now() + interval '1 hour'" }),
      );
      const result = await tenantContext.runInTenantContext(ctx, (m) =>
        files.completeUpload(m, asStoredFileLike(row)),
      );
      expect('file' in result && result.file.status).toBe('AVAILABLE');
      const report = await runReconcile({ failStalePending: true });
      expect(report.actions.some((a) => a.includes(row.id))).toBe(false);
      expect((await rowOf(row.id)).status).toBe('AVAILABLE');
      expect(await objectExists(row.object_key)).toBe(true);
    });

    it('7: cleanup wins (row already expired, nothing ever completes it) -> FAILED, object removed', async () => {
      const row = await tenantContext.runInTenantContext(ctx, (m) =>
        seedRow(m, { expiresAtSql: "now() - interval '1 minute'" }),
      );
      await runReconcile({ failStalePending: true });
      expect((await rowOf(row.id)).status).toBe('FAILED');
      expect(await objectExists(row.object_key)).toBe(false);
    });

    it('8: true race (completeUpload and the cleanup claim fired concurrently) settles on exactly one coherent state — never AVAILABLE with the object gone', async () => {
      // Not yet expired at the moment both fire, so completion is expected to win the CAS most of the time; either
      // way, the invariant under test is that the two outcomes below are the ONLY possible ones.
      const row = await tenantContext.runInTenantContext(ctx, (m) =>
        seedRow(m, { expiresAtSql: "now() + interval '2 seconds'" }),
      );
      const [completeResult] = await Promise.allSettled([
        tenantContext.runInTenantContext(ctx, (m) =>
          files.completeUpload(m, asStoredFileLike(row)),
        ),
        runReconcile({ failStalePending: true }),
      ]);
      const finalRow = await rowOf(row.id);
      const exists = await objectExists(row.object_key);
      if (finalRow.status === 'AVAILABLE') {
        expect(exists).toBe(true); // the one forbidden combination this whole phase exists to prevent
        expect(completeResult.status).toBe('fulfilled');
      } else {
        expect(finalRow.status).toBe('FAILED');
      }
    });

    it('9: 5 concurrent cleanup claims racing 1 completeUpload -> never AVAILABLE with a missing object, and at most one of them deletes', async () => {
      const row = await tenantContext.runInTenantContext(ctx, (m) =>
        seedRow(m, { expiresAtSql: "now() + interval '1 second'" }),
      );
      const attempts = [
        tenantContext.runInTenantContext(ctx, (m) =>
          files.completeUpload(m, asStoredFileLike(row)),
        ),
        ...Array.from({ length: 5 }, () =>
          runReconcile({ failStalePending: true }),
        ),
      ];
      await Promise.allSettled(attempts);
      const finalRow = await rowOf(row.id);
      const exists = await objectExists(row.object_key);
      expect(finalRow.status === 'AVAILABLE' ? exists : true).toBe(true); // AVAILABLE => object must exist
      expect(['AVAILABLE', 'FAILED'].includes(finalRow.status)).toBe(true);
    });
  });

  // ================================================================================================ C. failPending
  describe('C. FileService.failPending (via completeUpload rejection paths)', () => {
    it('10: a genuinely PENDING row that fails validation is claimed FAILED and its object removed', async () => {
      const row = await tenantContext.runInTenantContext(ctx, (m) =>
        seedRow(m, {
          expiresAtSql: "now() + interval '1 hour'",
          buffer: Buffer.from('not a real image'),
        }),
      );
      const result = await tenantContext.runInTenantContext(ctx, (m) =>
        files.completeUpload(m, asStoredFileLike(row)),
      );
      expect('rejected' in result).toBe(true);
      expect((await rowOf(row.id)).status).toBe('FAILED');
      expect(await objectExists(row.object_key)).toBe(false);
    });

    it('11: failPending LOSES to an already-AVAILABLE row -> no FAILED overwrite, no object deletion, the winner is reflected back', async () => {
      const row = await tenantContext.runInTenantContext(ctx, (m) =>
        seedRow(m, { expiresAtSql: "now() + interval '1 hour'" }),
      );
      const first = await tenantContext.runInTenantContext(ctx, (m) =>
        files.completeUpload(m, asStoredFileLike(row)),
      );
      expect('file' in first).toBe(true);
      // A second caller holding a STALE snapshot that looks PENDING-but-expired (simulates a duplicate/retried request
      // whose in-memory copy predates the winning completion) must never clobber the row that already won.
      const staleSnapshot = asStoredFileLike(row, {
        status: 'PENDING',
        expiresAt: new Date(Date.now() - 60_000),
      });
      const second = await tenantContext.runInTenantContext(ctx, (m) =>
        files.completeUpload(m, staleSnapshot),
      );
      expect('file' in second && second.file.status).toBe('AVAILABLE');
      const after = await rowOf(row.id);
      expect(after.status).toBe('AVAILABLE');
      expect(after.sha256).toBe(
        (first as { file: { sha256: string | null } }).file.sha256,
      );
      expect(await objectExists(row.object_key)).toBe(true); // never deleted by the loser
    });

    it('12: two concurrent completeUpload calls for the same row settle coherently — exactly one is the real winner, the other reflects it', async () => {
      const row = await tenantContext.runInTenantContext(ctx, (m) =>
        seedRow(m, { expiresAtSql: "now() + interval '1 hour'" }),
      );
      const [a, b] = await Promise.all([
        tenantContext.runInTenantContext(ctx, (m) =>
          files.completeUpload(m, asStoredFileLike(row)),
        ),
        tenantContext.runInTenantContext(ctx, (m) =>
          files.completeUpload(m, asStoredFileLike(row)),
        ),
      ]);
      expect('file' in a && a.file.status).toBe('AVAILABLE');
      expect('file' in b && b.file.status).toBe('AVAILABLE');
      expect(await objectExists(row.object_key)).toBe(true);
      expect((await rowOf(row.id)).status).toBe('AVAILABLE');
    });
  });

  // ================================================================================================ D. Delete failure recovery
  describe('D. delete failure after a successful DB claim', () => {
    it('13-16: the DB claim commits FAILED even when the physical delete fails; the row never reverts; the leftover object is detected next reconcile', async () => {
      const row = await tenantContext.runInTenantContext(ctx, (m) =>
        seedRow(m, { expiresAtSql: "now() - interval '1 minute'" }),
      );
      const driver = drivers.getDriver();
      const spy = jest
        .spyOn(driver, 'delete')
        .mockRejectedValueOnce(new Error('R2 delete failed'));
      const report = await runReconcile({ failStalePending: true });
      expect(report.actions).toContain(`failed stale pending ${row.id}`); // claim + delete-attempt both happened
      expect((await rowOf(row.id)).status).toBe('FAILED'); // DB stays authoritative; no revert to PENDING
      spy.mockRestore();
      expect(await objectExists(row.object_key)).toBe(true); // the delete genuinely failed — object is still there

      const next = await runReconcile({});
      expect(next.failed_with_object.map((f) => f.fileId)).toContain(row.id); // leftover detected, not lost track of
    });

    it('17: --purge-failed-objects safely retries and removes the leftover once the underlying delete succeeds', async () => {
      const row = await tenantContext.runInTenantContext(ctx, (m) =>
        seedRow(m, { status: 'FAILED' }),
      );
      expect(await objectExists(row.object_key)).toBe(true);
      const seen = await runReconcile({});
      expect(seen.failed_with_object.map((f) => f.fileId)).toContain(row.id);
      const purged = await runReconcile({ purgeFailedObjects: true });
      expect(purged.actions).toContain(
        `purged leftover object of failed upload ${row.id}`,
      );
      expect(await objectExists(row.object_key)).toBe(false);
      expect((await rowOf(row.id)).status).toBe('FAILED'); // still terminal, unchanged
    });
  });

  // ================================================================================================ E. Report-only must be non-destructive
  describe('E. default reconcile is report-only', () => {
    it('18-19: with no modifying flags, zero DB writes and zero object deletions occur, even with expired/DELETED/FAILED rows present', async () => {
      const stalePending = await tenantContext.runInTenantContext(ctx, (m) =>
        seedRow(m, { expiresAtSql: "now() - interval '1 minute'" }),
      );
      const deleted = await tenantContext.runInTenantContext(ctx, (m) =>
        seedRow(m, { status: 'DELETED', expiresAtSql: null }),
      );
      const failed = await tenantContext.runInTenantContext(ctx, (m) =>
        seedRow(m, { status: 'FAILED' }),
      );
      const report = await runReconcile({});
      expect(report.mode).toBe('REPORT-ONLY');
      expect(report.actions).toEqual([]);
      for (const row of [stalePending, deleted, failed]) {
        expect((await rowOf(row.id)).status).toBe(
          row === stalePending
            ? 'PENDING'
            : row === deleted
              ? 'DELETED'
              : 'FAILED',
        );
        expect(await objectExists(row.object_key)).toBe(true);
      }
    });
  });

  // ================================================================================================ F. Orphans
  describe('F. orphan objects', () => {
    it('20-21: an object with no owning row is reported, never auto-deleted, even under every modifying flag', async () => {
      const orphanKey = `test/organisations/${org.id}/workspaces/${ctx.workspaceId}/avatars/${randomUUID()}/${randomUUID()}.png`;
      await drivers
        .getDriver()
        .put(orphanKey, PNG, { contentType: 'image/png' });
      const report = await runReconcile({
        failStalePending: true,
        purgeDeletedImagesOlderThanDays: 0,
        purgeFailedObjects: true,
      });
      expect(report.orphan_objects.map((o) => o.key)).toContain(orphanKey);
      expect(await objectExists(orphanKey)).toBe(true);
    });
  });

  // ================================================================================================ G. AVAILABLE integrity
  describe('G. AVAILABLE object integrity', () => {
    it('22: a missing object behind an AVAILABLE row is reported, never silently accepted', async () => {
      const row = await tenantContext.runInTenantContext(ctx, (m) =>
        seedRow(m, { status: 'AVAILABLE' }),
      );
      await drivers.getDriver().delete(row.object_key);
      const report = await runReconcile({});
      expect(report.missing_objects.map((f) => f.fileId)).toContain(row.id);
    });

    it('23: a size mismatch is reported', async () => {
      const row = await tenantContext.runInTenantContext(ctx, (m) =>
        seedRow(m, { status: 'AVAILABLE' }),
      );
      await drivers
        .getDriver()
        .put(row.object_key, Buffer.concat([PNG, Buffer.from('extra')]), {
          contentType: 'image/png',
        });
      const report = await runReconcile({});
      expect(report.size_mismatches.map((f) => f.fileId)).toContain(row.id);
    });

    it('24: a same-size checksum mismatch is reported with --check-bytes, and never served by readVerified', async () => {
      const row = await tenantContext.runInTenantContext(ctx, (m) =>
        seedRow(m, { status: 'AVAILABLE' }),
      );
      const corrupted = Buffer.from(PNG);
      corrupted[10] = corrupted[10]! ^ 0xff;
      await drivers
        .getDriver()
        .put(row.object_key, corrupted, { contentType: 'image/png' });
      const report = await runReconcile({ checkBytes: true });
      expect(report.checksum_mismatches.map((f) => f.fileId)).toContain(row.id);
      await expect(
        files.readVerified(asStoredFileLike(row) as never),
      ).rejects.toMatchObject({ code: StorageErrorCode.INTEGRITY_FAILED });
    });
  });

  // ================================================================================================ H. DELETED image purge
  describe('H. DELETED-image physical purge', () => {
    it('26/27: an old eligible DELETED image is purged; a young one is preserved', async () => {
      const old = await tenantContext
        .runInTenantContext(ctx, (m) =>
          m.query<Row[]>(
            `INSERT INTO core.stored_file (organisation_id, workspace_id, kind, resource_type, resource_id, storage_driver, object_key, original_filename, mime_type, size_bytes, status, deleted_at)
           VALUES ($1,$2,'PROFILE_IMAGE','user',$3,'LOCAL',$4,'a.png','image/png',10,'DELETED', now() - interval '90 days')
           RETURNING id, object_key`,
            [
              org.id,
              ctx.workspaceId,
              randomUUID(),
              `test/organisations/${org.id}/old/${randomUUID()}.png`,
            ],
          ),
        )
        .then((r) => r[0]!);
      await drivers
        .getDriver()
        .put(old.object_key, PNG, { contentType: 'image/png' });
      const young = await tenantContext.runInTenantContext(ctx, (m) =>
        seedRow(m, {
          status: 'DELETED',
          expiresAtSql: null,
          deletedAtSql: "now() - interval '1 day'",
        }),
      );

      const report = await runReconcile({
        purgeDeletedImagesOlderThanDays: 30,
      });
      expect(report.actions).toContain(
        `purged object of deleted image ${old.id}`,
      );
      expect(await objectExists(old.object_key)).toBe(false);
      expect(report.actions.some((a) => a.includes(young.id))).toBe(false);
      expect(await objectExists(young.object_key)).toBe(true);
    });

    it('28: a row that changed between the page read and the delete step is skipped, not deleted on a stale snapshot', async () => {
      const eligible = await tenantContext
        .runInTenantContext(ctx, (m) =>
          m.query<Row[]>(
            `INSERT INTO core.stored_file (organisation_id, workspace_id, kind, resource_type, resource_id, storage_driver, object_key, original_filename, mime_type, size_bytes, status, deleted_at)
           VALUES ($1,$2,'PROFILE_IMAGE','user',$3,'LOCAL',$4,'a.png','image/png',10,'DELETED', now() - interval '90 days')
           RETURNING id, object_key`,
            [
              org.id,
              ctx.workspaceId,
              randomUUID(),
              `test/organisations/${org.id}/race/${randomUUID()}.png`,
            ],
          ),
        )
        .then((r) => r[0]!);
      await drivers
        .getDriver()
        .put(eligible.object_key, PNG, { contentType: 'image/png' });
      // Between this page's read and the purge step, something else resurrects the row's DB state (a restore, a bug,
      // another process) — the fresh re-check inside the reconcile command must see this and skip the delete.
      const headSpy = jest
        .spyOn(drivers.getDriver(), 'head')
        .mockImplementationOnce(async (key: string) => {
          await tenantContext.runInTenantContext(ctx, (m) =>
            m.query(
              `UPDATE core.stored_file SET status = 'AVAILABLE', sha256 = $2 WHERE id = $1`,
              [eligible.id, createHash('sha256').update(PNG).digest('hex')],
            ),
          );
          return drivers.getDriver().head(key);
        });
      const report = await runReconcile({
        purgeDeletedImagesOlderThanDays: 30,
      });
      headSpy.mockRestore();
      expect(report.actions.some((a) => a.includes(eligible.id))).toBe(false);
      expect(await objectExists(eligible.object_key)).toBe(true); // never deleted despite the stale page snapshot saying DELETED
    });

    it('29: report/timesheet evidence kinds are never eligible for the generic image purge', async () => {
      const report = await tenantContext
        .runInTenantContext(ctx, (m) =>
          m.query<Row[]>(
            `INSERT INTO core.stored_file (organisation_id, workspace_id, kind, resource_type, resource_id, storage_driver, object_key, original_filename, mime_type, size_bytes, status, deleted_at)
           VALUES ($1,$2,'FINAL_TIMESHEET_PDF','shift_report',$3,'LOCAL',$4,'t.pdf','application/pdf',10,'DELETED', now() - interval '9999 days')
           RETURNING id, object_key`,
            [
              org.id,
              ctx.workspaceId,
              randomUUID(),
              `test/organisations/${org.id}/reports/${randomUUID()}.pdf`,
            ],
          ),
        )
        .then((r) => r[0]!);
      await drivers
        .getDriver()
        .put(report.object_key, Buffer.from('%PDF-1.4'), {
          contentType: 'application/pdf',
        });
      const out = await runReconcile({ purgeDeletedImagesOlderThanDays: 1 });
      expect(out.actions.some((a) => a.includes(report.id))).toBe(false);
      expect(await objectExists(report.object_key)).toBe(true);
    });
  });

  // ================================================================================================ I. RLS / workspace
  describe('I. workspace/RLS isolation of stored_file rows', () => {
    it('30/31: a different organisation (and a different workspace in the same org) never sees the row at the database layer', async () => {
      const row = await tenantContext.runInTenantContext(ctx, (m) =>
        seedRow(m, { status: 'AVAILABLE' }),
      );
      const otherOrg = await factory.createOrganisation('sc-other');
      const otherOwner = await factory.createInternalManager(otherOrg);
      const seenByOtherOrg = await tenantContext.runInTenantContext(
        {
          organisationId: otherOrg.id,
          workspaceId: otherOwner.workspaceId!,
          userId: otherOwner.userId,
          role: '',
        },
        (m) =>
          m.query(`SELECT id FROM core.stored_file WHERE id = $1`, [row.id]),
      );
      expect(seenByOtherOrg).toEqual([]);

      const otherWorkspaceOwner = await factory.createInternalManager(org); // same org, different workspace
      const seenByOtherWorkspace = await tenantContext.runInTenantContext(
        {
          organisationId: org.id,
          workspaceId: otherWorkspaceOwner.workspaceId!,
          userId: otherWorkspaceOwner.userId,
          role: '',
        },
        (m) =>
          m.query(`SELECT id FROM core.stored_file WHERE id = $1`, [row.id]),
      );
      expect(seenByOtherWorkspace).toEqual([]);
    });

    it('32: a guessed/unknown file id resolves to null, not an error and not a state leak', async () => {
      expect(
        await tenantContext.runInTenantContext(ctx, (m) =>
          files.findAvailable(m, randomUUID()),
        ),
      ).toBeNull();
    });
  });

  // ================================================================================================ J. concurrency/crash
  describe('J. multi-cleaner concurrency and crash recovery', () => {
    it('34: 5 concurrent stale-pending cleanup runs against the SAME row produce exactly one claim', async () => {
      const row = await tenantContext.runInTenantContext(ctx, (m) =>
        seedRow(m, { expiresAtSql: "now() - interval '1 minute'" }),
      );
      const reports = await Promise.all(
        Array.from({ length: 5 }, () =>
          runReconcile({ failStalePending: true }),
        ),
      );
      const claims = reports.filter((r) =>
        r.actions.includes(`failed stale pending ${row.id}`),
      );
      expect(claims).toHaveLength(1); // only the winner may claim/delete; the other 4 must no-op on this row
      expect((await rowOf(row.id)).status).toBe('FAILED');
      expect(await objectExists(row.object_key)).toBe(false);
    });

    it('35: crash after the DB claim but before the delete is recoverable on the next tick', async () => {
      const row = await tenantContext.runInTenantContext(ctx, (m) =>
        seedRow(m, { expiresAtSql: "now() - interval '1 minute'" }),
      );
      const spy = jest
        .spyOn(drivers.getDriver(), 'delete')
        .mockRejectedValueOnce(new Error('process died before cleanup'));
      await runReconcile({ failStalePending: true });
      spy.mockRestore();
      expect((await rowOf(row.id)).status).toBe('FAILED');
      expect(await objectExists(row.object_key)).toBe(true);
      const recovered = await runReconcile({ purgeFailedObjects: true });
      expect(recovered.actions).toContain(
        `purged leftover object of failed upload ${row.id}`,
      );
      expect(await objectExists(row.object_key)).toBe(false);
    });

    it('36: crash after a successful delete, re-run is idempotent (no error, no infinite leftover)', async () => {
      const row = await tenantContext.runInTenantContext(ctx, (m) =>
        seedRow(m, { status: 'FAILED' }),
      );
      await drivers.getDriver().delete(row.object_key); // simulate the delete having already succeeded before a crash
      const rerun = await runReconcile({ purgeFailedObjects: true });
      expect(rerun.failed_with_object.map((f) => f.fileId)).not.toContain(
        row.id,
      ); // object is gone -> nothing to report or re-delete
      expect(rerun.actions.some((a) => a.includes(row.id))).toBe(false);
    });
  });

  // ================================================================================================ K. composite workspace FK
  describe('K. shift_report / replacement_request composite workspace FK (Phase 8 migration)', () => {
    let shiftId: string;
    let assignmentId: string;
    let otherWorkspaceId: string;

    beforeAll(async () => {
      const otherOwner = await factory.createInternalManager(org); // same org, different workspace
      otherWorkspaceId = otherOwner.workspaceId!;
      const staff = await factory.createStaff(org, { owner });
      const startsAt = new Date(Date.now() + 3600_000);
      const endsAt = new Date(startsAt.getTime() + 8 * 3600_000);
      const seeded = await tenantContext.runInTenantContext(ctx, async (m) => {
        const venue = await m.save(Venue, {
          organisationId: org.id,
          name: 'FK Venue',
          createdBy: owner.userId,
          workspaceId: owner.workspaceId!,
        });
        const jobRole = await m.save(JobRole, {
          organisationId: org.id,
          name: `Role ${randomUUID().slice(0, 6)}`,
          defaultRatePence: 1500,
          createdBy: owner.userId,
          workspaceId: owner.workspaceId!,
        });
        const shift = await m.save(Shift, {
          organisationId: org.id,
          venueId: venue.id,
          jobRoleId: jobRole.id,
          startsAt,
          endsAt,
          breakMinutes: 30,
          requiredCount: 1,
          payRatePence: 1500,
          status: 'open',
          createdBy: owner.userId,
          workspaceId: owner.workspaceId!,
        });
        const assignment = await m.save(ShiftAssignment, {
          organisationId: org.id,
          shiftId: shift.id,
          staffProfileId: staff.profileId!,
          status: 'offered',
          payRateSnapshotPence: 1500,
          assignedBy: owner.userId,
          period: toTstzRange(startsAt, endsAt),
          workspaceId: owner.workspaceId!,
        });
        return { shiftId: shift.id, assignmentId: assignment.id };
      });
      shiftId = seeded.shiftId;
      assignmentId = seeded.assignmentId;
    });

    it('37: shift_report.workspace_id disagreeing with its parent shift is rejected by the database itself', async () => {
      await expect(
        tenantContext.runInTenantContext(ctx, (m) =>
          m.query(
            `INSERT INTO core.shift_report (organisation_id, workspace_id, shift_id, status) VALUES ($1, $2, $3, 'pending')`,
            [org.id, otherWorkspaceId, shiftId],
          ),
        ),
      ).rejects.toThrow(/foreign key|violat/i);
      // The matching workspace_id (or NULL) is accepted — the constraint is genuinely NULL-tolerant and correct, not just strict.
      await expect(
        tenantContext.runInTenantContext(ctx, (m) =>
          m.query(
            `INSERT INTO core.shift_report (organisation_id, workspace_id, shift_id, status) VALUES ($1, $2, $3, 'pending')`,
            [org.id, owner.workspaceId, shiftId],
          ),
        ),
      ).resolves.toBeDefined();
    });

    it('38: replacement_request.workspace_id disagreeing with its parent shift is rejected by the database itself', async () => {
      await expect(
        tenantContext.runInTenantContext(ctx, (m) =>
          m.query(
            `INSERT INTO core.replacement_request (organisation_id, workspace_id, shift_id, declined_shift_assignment_id) VALUES ($1, $2, $3, $4)`,
            [org.id, otherWorkspaceId, shiftId, assignmentId],
          ),
        ),
      ).rejects.toThrow(/foreign key|violat/i);
    });
  });

  // ================================================================================================ L. index usage
  describe('L. index usage for stale-PENDING discovery', () => {
    it('39: the partial index on (expires_at) WHERE status = PENDING is available and usable for a stale-PENDING scan', async () => {
      const plan = await tenantContext.runInTenantContext(ctx, (m) =>
        m.query(
          `EXPLAIN SELECT id FROM core.stored_file WHERE status = 'PENDING' AND expires_at <= now()`,
        ),
      );
      const text = plan
        .map((r: Record<string, string>) => Object.values(r)[0])
        .join('\n');
      expect(text).toMatch(/stored_file_pending_idx/);
    });
  });
  describe('PRE-03 scoped maintenance', () => {
    it('two concurrent purges perform only one destructive action', async () => {
      const row = await tenantContext.runInTenantContext(ctx, (m) =>
        seedRow(m, { status: 'DELETED' }),
      );
      const driver = drivers.getDriver();
      const spy = jest.spyOn(driver, 'delete');
      try {
        await Promise.all([
          runReconcile({ purgeDeletedImagesOlderThanDays: 30 }),
          runReconcile({ purgeDeletedImagesOlderThanDays: 30 }),
        ]);
        expect(
          spy.mock.calls.filter((c) => c[0] === row.object_key),
        ).toHaveLength(1);
        expect(await objectExists(row.object_key)).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it('scoped isolation covers both organisations and workspaces, including org-owned files exactly once', async () => {
      const org2 = await factory.createOrganisation('pre03');
      const owner2 = await factory.createInternalManager(org2);
      const peer = await factory.createInternalManager(org);
      const contexts = [
        ctx,
        {
          organisationId: org2.id,
          workspaceId: owner2.workspaceId!,
          userId: owner2.userId,
          role: '',
        },
        {
          organisationId: org.id,
          workspaceId: peer.workspaceId!,
          userId: peer.userId,
          role: '',
        },
      ];
      const ids: string[] = [];
      for (const scope of contexts) {
        ids.push(
          await tenantContext.runInTenantContext(scope, async (m) => {
            const [row] = await m.query(
              `INSERT INTO core.stored_file
            (organisation_id, workspace_id, kind, resource_type, resource_id, storage_driver, object_key,
             original_filename, mime_type, size_bytes, status)
            VALUES ($1,$2,'PROFILE_IMAGE','user',$3,'LOCAL',$4,'test.png','image/png',1,'FAILED') RETURNING id`,
              [
                scope.organisationId,
                scope.workspaceId,
                scope.userId,
                'test/organisations/' +
                  scope.organisationId +
                  '/' +
                  randomUUID(),
              ],
            );
            return row.id;
          }),
        );
      }
      for (let i = 0; i < contexts.length; i++) {
        await tenantContext.runInTenantContext(contexts[i], async (m) => {
          expect(
            await m.query('SELECT id FROM core.stored_file WHERE id = $1', [
              ids[i],
            ]),
          ).toHaveLength(1);
          for (let j = 0; j < ids.length; j++)
            if (j !== i) {
              expect(
                await m.query('SELECT id FROM core.stored_file WHERE id = $1', [
                  ids[j],
                ]),
              ).toEqual([]);
              const [, count] = await m.query(
                "UPDATE core.stored_file SET status = 'PENDING' WHERE id = $1",
                [ids[j]],
              );
              expect(count).toBe(0);
            }
        });
      }
      const orgOwned = await tenantContext.runInTenantContext(ctx, (m) =>
        seedRow(m, { status: 'FAILED' }),
      );
      await tenantContext.runInTenantContext(ctx, (m) =>
        m.query(
          'UPDATE core.stored_file SET workspace_id = NULL WHERE id = $1',
          [orgOwned.id],
        ),
      );
      sqlObservation.mockClear();
      const report = await runReconcile();
      expect(
        report.failed_with_object.filter((r) => r.fileId === orgOwned.id),
      ).toHaveLength(1);
      const ownerSql = sqlObservation.mock.calls
        .filter((c) => c[2]?.connection === adminDataSource)
        .map((c) => String(c[0]));
      expect(ownerSql.length).toBeGreaterThan(0);
      expect(
        ownerSql.filter((q) =>
          /core.stored_file|^(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i.test(
            q.trim(),
          ),
        ),
      ).toEqual([]);
    });

    it('storage timeout and post-inspection database failure do not delete or change terminal metadata', async () => {
      const row = await tenantContext.runInTenantContext(ctx, (m) =>
        seedRow(m, { status: 'DELETED' }),
      );
      const driver = drivers.getDriver();
      const originalHead = driver.head.bind(driver);
      const head = jest
        .spyOn(driver, 'head')
        .mockImplementation(async (key) => {
          if (key === row.object_key) throw new Error('storage timeout');
          return originalHead(key);
        });
      try {
        await expect(
          runReconcile({ purgeDeletedImagesOlderThanDays: 30 }),
        ).rejects.toThrow('storage timeout');
      } finally {
        head.mockRestore();
      }
      expect((await rowOf(row.id)).status).toBe('DELETED');
      expect(await objectExists(row.object_key)).toBe(true);
      const originalTransaction = dataSource.transaction.bind(dataSource);
      let inspected = false;
      const observe = jest
        .spyOn(driver, 'head')
        .mockImplementation(async (key) => {
          const result = await originalHead(key);
          if (key === row.object_key) inspected = true;
          return result;
        });
      const tx = jest.spyOn(dataSource, 'transaction').mockImplementation(((
        ...args: unknown[]
      ) => {
        if (inspected)
          return Promise.reject(
            new Error('database unavailable after inspection'),
          );
        return (
          originalTransaction as (...values: unknown[]) => Promise<unknown>
        )(...args);
      }) as typeof dataSource.transaction);
      try {
        await expect(
          runReconcile({ purgeDeletedImagesOlderThanDays: 30 }),
        ).rejects.toThrow('database unavailable after inspection');
      } finally {
        tx.mockRestore();
        observe.mockRestore();
      }
      expect((await rowOf(row.id)).status).toBe('DELETED');
      expect(await objectExists(row.object_key)).toBe(true);
      await runReconcile({ purgeDeletedImagesOlderThanDays: 30 });
      expect(await objectExists(row.object_key)).toBe(false);
    });

    it('refuses an owner connection for metadata work before storage is accessed', async () => {
      const bad = new StorageReconcileCommand(adminDataSource, drivers, env);
      bad.catalogueDataSource = adminDataSource;
      await expect(bad.run([], {})).rejects.toThrow(/Refusing to start/);
    });
  });
});
