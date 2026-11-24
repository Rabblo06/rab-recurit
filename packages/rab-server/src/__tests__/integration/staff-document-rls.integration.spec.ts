import 'reflect-metadata';
import './helpers/use-local-storage-env'; // MUST be imported before AppModule — see that file's own doc comment

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * StaffDocumentSchema1786722300000 at the database layer (layers 4–5), real PostgreSQL with FORCE RLS, no HTTP.
 * The service / HTTP abuse cases live in staff-documents.integration.spec.ts.
 *
 * Abuse cases (rab-workforce-architecture.md §1.2 floor): no tenant context bound = zero rows on both tables; another
 * organisation's and another workspace's manager see nothing; a staff member sees only their own documents and can neither
 * write one for somebody else nor change a decision; a manager can never decide their own document; identity, file and
 * dates are immutable and the status machine is enforced in the database; DELETE removes nothing and TRUNCATE is refused
 * for the runtime login; a "clean" scan verdict without scanner evidence is refused.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

jest.setTimeout(120_000);

const pgCode = (error: unknown): string | undefined =>
  (error as { driverError?: { code?: string }; code?: string })?.driverError
    ?.code ?? (error as { code?: string })?.code;

/** Resolves to the SQLSTATE the promise was rejected with (fails the test when it resolves). */
async function sqlState(
  promise: Promise<unknown>,
): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return pgCode(error);
  }
  throw new Error('expected the statement to be refused, but it succeeded');
}

describeIfDb('staff documents: RLS and database guard (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let factory: TestIdentityFactory;
  let tenantContext: TenantContextService;

  interface World {
    orgId: string;
    a: TestIdentity; // manager, workspace A
    b: TestIdentity; // manager, workspace B (same organisation)
    s1: TestIdentity; // staff in workspace A
    s2: TestIdentity; // staff in workspace A
    other: TestIdentity; // manager of another organisation
  }

  const as = <T>(
    who: Pick<TestIdentity, 'organisationId' | 'workspaceId' | 'userId'>,
    fn: (m: EntityManager) => Promise<T>,
  ) =>
    tenantContext.runInTenantContext(
      {
        organisationId: who.organisationId,
        workspaceId: who.workspaceId,
        userId: who.userId,
        role: '',
      },
      fn,
    );

  async function world(): Promise<World> {
    const { organisation, managers } =
      await factory.createOrganisationWithManagers(2, { workspace: true });
    const [a, b] = managers as [TestIdentity, TestIdentity];
    const s1 = await factory.createStaff(
      { id: organisation.id },
      { owner: a, label: 's1' },
    );
    const s2 = await factory.createStaff(
      { id: organisation.id },
      { owner: a, label: 's2' },
    );
    const { managers: others } = await factory.createOrganisationWithManagers(
      1,
      { workspace: true },
    );
    // a is the organisation's current Initial Manager (review M2: only the CEO or the Initial Manager writes requirements).
    await adminDataSource.query(`UPDATE core.manager_profile SET is_initial_manager = true WHERE user_id = $1`, [a.userId]);
    return { orgId: organisation.id, a, b, s1, s2, other: others[0]! };
  }

  /** A STAFF_DOCUMENT file row written as `who` (stored_file's own policy: tenant + workspace). */
  async function fileRow(m: EntityManager, who: TestIdentity): Promise<string> {
    const [row] = await m.query(
      `INSERT INTO core.stored_file (organisation_id, workspace_id, kind, resource_type, resource_id, storage_driver, object_key, original_filename, mime_type, size_bytes, sha256, status, created_by)
       VALUES ($1, $2, 'STAFF_DOCUMENT', 'staff_document', $3, 'LOCAL', $4, 'doc.pdf', 'application/pdf', 10, repeat('a', 64), 'AVAILABLE', $3) RETURNING id`,
      [
        who.organisationId,
        who.workspaceId,
        who.userId,
        `test/${randomUUID()}.pdf`,
      ],
    );
    return row.id as string;
  }

  /** Inserts a pending document for `staffUserId` as `who`; returns its id. */
  async function insertDoc(
    who: TestIdentity,
    staffUserId: string,
    extra: { expiresOn?: string; scanStatus?: string; clean?: boolean } = {},
  ): Promise<string> {
    return as(who, async (m) => {
      const fileId = await fileRow(m, who);
      const [row] = await m.query(
        `INSERT INTO core.staff_document (organisation_id, workspace_id, staff_user_id, document_type, file_id, expires_on, uploaded_by, scan_status)
         VALUES ($1, $2, $3, 'right_to_work', $4, $5, $6, $7) RETURNING id`,
        [
          who.organisationId,
          who.workspaceId,
          staffUserId,
          fileId,
          extra.expiresOn ?? null,
          who.userId,
          extra.scanStatus ?? 'not_scanned',
        ],
      );
      if (extra.clean) {
        // The only scanner path: the crewflow-owned definer, in the uploading transaction.
        const [scan] = await m.query(`SELECT core.staff_document_record_scan($1, 'test-engine') AS ok`, [row.id]);
        expect(scan.ok).toBe(true);
      }
      return row.id as string;
    });
  }

  const visibleIds = (who: TestIdentity) =>
    as(who, async (m) =>
      (await m.query(`SELECT id FROM core.staff_document`)).map(
        (r: { id: string }) => r.id,
      ),
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({
      app,
      dataSource,
      adminDataSource,
      tenantContext,
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  it('with no tenant context bound, the runtime login reads zero rows from both tables', async () => {
    const w = await world();
    await insertDoc(w.a, w.s1.userId);
    await as(w.a, (m) =>
      m.query(
        `INSERT INTO core.staff_document_requirement (organisation_id, document_type, required, updated_by) VALUES ($1, 'dbs_check', true, $2)`,
        [w.orgId, w.a.userId],
      ),
    );
    expect(
      await dataSource.manager.query(`SELECT id FROM core.staff_document`),
    ).toHaveLength(0);
    expect(
      await dataSource.manager.query(
        `SELECT organisation_id FROM core.staff_document_requirement`,
      ),
    ).toHaveLength(0);
    // The rows exist (the superuser admin connection bypasses RLS) — the zero above is RLS, not an empty table.
    expect(
      await adminDataSource.query(
        `SELECT id FROM core.staff_document WHERE organisation_id = $1`,
        [w.orgId],
      ),
    ).toHaveLength(1);
  });

  it('a workspace manager sees the workspace documents; another workspace and another organisation see none', async () => {
    const w = await world();
    const d1 = await insertDoc(w.a, w.s1.userId);
    const d2 = await insertDoc(w.a, w.s2.userId);
    expect((await visibleIds(w.a)).sort()).toEqual([d1, d2].sort());
    expect(await visibleIds(w.b)).toEqual([]);
    expect(await visibleIds(w.other)).toEqual([]);
  });

  it('a staff member sees only their own documents, and the worker marker sees the workspace for expiry alerts', async () => {
    const w = await world();
    const d1 = await insertDoc(w.a, w.s1.userId);
    await insertDoc(w.a, w.s2.userId);
    expect(await visibleIds(w.s1)).toEqual([d1]);
    const workerSees = await tenantContext.runInTenantContext(
      {
        organisationId: w.orgId,
        workspaceId: w.a.workspaceId,
        userId: '',
        role: '',
        actorType: 'worker',
      },
      async (m) => (await m.query(`SELECT id FROM core.staff_document`)).length,
    );
    expect(workerSees).toBe(2);
  });

  it('a staff member can upload their own pending document but never one for somebody else, nor a pre-verified one', async () => {
    const w = await world();
    await expect(insertDoc(w.s1, w.s1.userId)).resolves.toEqual(
      expect.any(String),
    );
    expect(await sqlState(insertDoc(w.s1, w.s2.userId))).toBe('42501');
    expect(
      await sqlState(
        as(w.s1, async (m) => {
          const fileId = await fileRow(m, w.s1);
          await m.query(
            `INSERT INTO core.staff_document (organisation_id, workspace_id, staff_user_id, document_type, file_id, uploaded_by, status, verified_by, verified_at)
           VALUES ($1, $2, $3, 'right_to_work', $4, $3, 'verified', $3, now())`,
            [w.orgId, w.s1.workspaceId, w.s1.userId, fileId],
          );
        }),
      ),
    ).toBe('42501');
  });

  it('a staff member cannot change a decision on their own document (UPDATE reaches no row)', async () => {
    const w = await world();
    const d = await insertDoc(w.s1, w.s1.userId);
    const res = await as(w.s1, (m) =>
      m.query(
        `UPDATE core.staff_document SET status = 'verified', verified_by = $2, verified_at = now() WHERE id = $1`,
        [d, w.s1.userId],
      ),
    );
    expect(res[1]).toBe(0);
  });

  it('a manager can never verify their own document (guard / WITH CHECK)', async () => {
    const w = await world();
    const own = await insertDoc(w.a, w.a.userId, { clean: true });
    expect(['23514', '42501']).toContain(
      await sqlState(
        as(w.a, (m) =>
          m.query(
            `UPDATE core.staff_document SET status = 'verified', verified_by = $2, verified_at = now() WHERE id = $1`,
            [own, w.a.userId],
          ),
        ),
      ),
    );
  });

  it('review M1 / M3: verify needs a clean scan, the decider is the current user, and never the uploader', async () => {
    const w = await world();
    const verify = (doc: string, by: string) =>
      as(w.a, (m) => m.query(`UPDATE core.staff_document SET status = 'verified', verified_by = $2, verified_at = now() WHERE id = $1`, [doc, by]));
    // Not scanned clean -> refused in the database.
    const unscanned = await insertDoc(w.s1, w.s1.userId);
    expect(await sqlState(verify(unscanned, w.a.userId))).toBe('23514');
    // verified_by must be the current user.
    const own = await insertDoc(w.s1, w.s1.userId, { clean: true });
    expect(await sqlState(verify(own, w.b.userId))).toBe('42501');
    // Maker-checker: the manager who uploaded it cannot verify it.
    const managerUpload = await insertDoc(w.a, w.s1.userId, { clean: true });
    expect(await sqlState(verify(managerUpload, w.a.userId))).toBe('23514');
    // The legitimate path: uploaded by the staff member, scanned clean, verified by a manager.
    await verify(own, w.a.userId);
    const [row] = await as(w.a, (m) => m.query(`SELECT status, verified_by FROM core.staff_document WHERE id = $1`, [own]));
    expect(row).toEqual({ status: 'verified', verified_by: w.a.userId });
    // rejected_by must be the current user too.
    const other = await insertDoc(w.s1, w.s1.userId);
    expect(
      await sqlState(as(w.a, (m) => m.query(`UPDATE core.staff_document SET status = 'rejected', rejected_by = $2, rejected_at = now(), rejection_reason = 'spoofed' WHERE id = $1`, [other, w.b.userId]))),
    ).toBe('42501');
  });

  it('review M1: scan columns are written only by core.staff_document_record_scan(), only in the uploading transaction', async () => {
    const w = await world();
    const d = await insertDoc(w.a, w.s1.userId);
    expect(
      await sqlState(as(w.a, (m) => m.query(`UPDATE core.staff_document SET scan_status = 'clean', scan_engine = 'x', scanned_at = now() WHERE id = $1`, [d]))),
    ).toBe('42501');
    // A later transaction cannot claim a verdict for an earlier upload.
    const [later] = await as(w.a, (m) => m.query(`SELECT core.staff_document_record_scan($1, 'test-engine') AS ok`, [d]));
    expect(later.ok).toBe(false);
    // Somebody else cannot claim a verdict for my upload, even in my transaction's lifetime (uploaded_by = current uid).
    const [byOther] = await as(w.s1, (m) => m.query(`SELECT core.staff_document_record_scan($1, 'test-engine') AS ok`, [d]));
    expect(byOther.ok).toBe(false);
    const [row] = await adminDataSource.query(`SELECT scan_status FROM core.staff_document WHERE id = $1`, [d]);
    expect(row.scan_status).toBe('not_scanned');
  });

  it('the guard: identity, file and dates never change; the status machine holds in the database', async () => {
    const w = await world();
    const d = await insertDoc(w.a, w.s1.userId, { expiresOn: '2030-01-01' });
    expect(
      await sqlState(
        as(w.a, (m) =>
          m.query(
            `UPDATE core.staff_document SET expires_on = '2099-01-01' WHERE id = $1`,
            [d],
          ),
        ),
      ),
    ).toBe('42501');
    expect(
      await sqlState(
        as(w.a, (m) =>
          m.query(
            `UPDATE core.staff_document SET staff_user_id = $2 WHERE id = $1`,
            [d, w.s2.userId],
          ),
        ),
      ),
    ).toBe('42501');
    await as(w.a, (m) =>
      m.query(
        `UPDATE core.staff_document SET status = 'rejected', rejected_by = $2, rejected_at = now(), rejection_reason = 'blurred scan' WHERE id = $1`,
        [d, w.a.userId],
      ),
    );
    expect(
      await sqlState(
        as(w.a, (m) =>
          m.query(
            `UPDATE core.staff_document SET status = 'verified', verified_by = $2, verified_at = now(), rejected_by = NULL, rejected_at = NULL, rejection_reason = NULL WHERE id = $1`,
            [d, w.a.userId],
          ),
        ),
      ),
    ).toBe('23514');
    const [row] = await as(w.a, (m) =>
      m.query(`SELECT status FROM core.staff_document WHERE id = $1`, [d]),
    );
    expect(row.status).toBe('rejected');
  });

  it('DELETE removes nothing (no policy) and TRUNCATE is refused for the runtime login', async () => {
    const w = await world();
    const d = await insertDoc(w.a, w.s1.userId);
    const res = await as(w.a, (m) =>
      m.query(`DELETE FROM core.staff_document WHERE id = $1`, [d]),
    );
    expect(res[1]).toBe(0);
    expect(await visibleIds(w.a)).toEqual([d]);
    expect(
      await sqlState(as(w.a, (m) => m.query(`TRUNCATE core.staff_document`))),
    ).toBe('42501');
  });

  it('a document cannot be inserted already "clean" (only the scanner path records a verdict)', async () => {
    const w = await world();
    expect(await sqlState(insertDoc(w.a, w.s1.userId, { scanStatus: 'clean' }))).toBe('42501');
  });

  it('requirements: everyone in the organisation reads them; only the CEO / Initial Manager writes them; other organisations see none', async () => {
    const w = await world();
    // Review M2: an ordinary internal manager (b) cannot switch the organisation's requirements.
    expect(
      await sqlState(
        as(w.b, (m) =>
          m.query(`INSERT INTO core.staff_document_requirement (organisation_id, document_type, required, updated_by) VALUES ($1, 'right_to_work', false, $2)`, [
            w.orgId,
            w.b.userId,
          ]),
        ),
      ),
    ).toBe('42501');
    await as(w.a, (m) =>
      m.query(
        `INSERT INTO core.staff_document_requirement (organisation_id, document_type, required, updated_by) VALUES ($1, 'dbs_check', true, $2)`,
        [w.orgId, w.a.userId],
      ),
    );
    expect(
      await as(w.s1, (m) =>
        m.query(`SELECT document_type FROM core.staff_document_requirement`),
      ),
    ).toEqual([{ document_type: 'dbs_check' }]);
    expect(
      await as(w.other, (m) =>
        m.query(`SELECT document_type FROM core.staff_document_requirement`),
      ),
    ).toEqual([]);
    expect(
      await sqlState(
        as(w.s1, (m) =>
          m.query(
            `INSERT INTO core.staff_document_requirement (organisation_id, document_type, required, updated_by) VALUES ($1, 'first_aid', true, $2)`,
            [w.orgId, w.s1.userId],
          ),
        ),
      ),
    ).toBe('42501');
    const deleted = await as(w.s1, (m) =>
      m.query(
        `DELETE FROM core.staff_document_requirement WHERE document_type = 'dbs_check'`,
      ),
    );
    expect(deleted[1]).toBe(0);
  });
});
