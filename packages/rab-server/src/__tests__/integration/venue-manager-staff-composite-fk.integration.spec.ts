import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { BootstrapTimer } from './helpers/bootstrap-trace';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Structural tests for the venue_manager_staff composite foreign keys (Hyper Workspace Phase 3, GO closure).
 *
 * These test the DATABASE invariant, not authorisation. Every probe runs inside a transaction that always rolls back, and
 * RLS is disabled for that transaction on the three tables involved, because RLS is not what is under test here.
 * Foreign-key checks run regardless of RLS, so the outcome shown is the structural one.
 *
 * SQLSTATE 23503 = foreign_key_violation. A probe that succeeds is reported as 'ok'.
 */
const RUN = Boolean(process.env.DATABASE_URL);
(RUN ? describe : describe.skip)('venue_manager_staff composite workspace FKs (structural, integration)', () => {
  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let qr: QueryRunner;

  let orgA: { id: string };
  let orgX: { id: string };
  let mA: TestIdentity; // manager, org A, workspace A
  let mB: TestIdentity; // manager, org A, workspace B
  let mNullWs: TestIdentity; // manager, org A, NULL workspace
  let mX: TestIdentity; // manager, org X, workspace X
  let staffA: TestIdentity; // org A, workspace A
  let staffB: TestIdentity; // org A, workspace B
  let staffX: TestIdentity; // org X, workspace X

  class RollbackMarker extends Error {}

  /** Runs `write` on the dedicated connection in a transaction and ALWAYS rolls it back. Returns ok, or the SQLSTATE of the refusal. */
  async function probe(write: (m: EntityManager) => Promise<unknown>): Promise<{ ok: true } | { ok: false; code: string }> {
    await qr.startTransaction();
    try {
      await write(qr.manager);
      await qr.rollbackTransaction();
      return { ok: true };
    } catch (error) {
      await qr.rollbackTransaction();
      return { ok: false, code: (error as { code?: string }).code ?? 'unknown' };
    }
  }

  /** Session-local mirrors of the parents and the child. Created once, on the dedicated connection, before any probe runs. */
  async function createMirrors(): Promise<void> {
    await qr.query(`CREATE TEMP TABLE mp_probe (id uuid PRIMARY KEY, organisation_id uuid NOT NULL, workspace_id uuid, UNIQUE (id, organisation_id, workspace_id))`);
    await qr.query(`CREATE TEMP TABLE sp_probe (id uuid PRIMARY KEY, organisation_id uuid NOT NULL, workspace_id uuid, UNIQUE (id, organisation_id, workspace_id))`);
    await qr.query(`CREATE TEMP TABLE vms_probe (manager_profile_id uuid NOT NULL, staff_profile_id uuid NOT NULL, organisation_id uuid NOT NULL, workspace_id uuid NOT NULL)`);
    // The child's composite keys, exactly as declared on the real table, re-pointed at the mirror parents.
    const keys = await owner.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'core.venue_manager_staff'::regclass AND conname LIKE '%org_ws_fkey'`,
    );
    if (keys.length !== 2) throw new Error(`expected 2 composite keys on core.venue_manager_staff, found ${keys.length}`);
    for (const k of keys) {
      // pg_get_constraintdef() renders the referenced table unqualified whenever it is visible via the
      // connection's search_path (this admin connection sets `-c search_path=core`), so it returns
      // "REFERENCES manager_profile(...)", not "REFERENCES core.manager_profile(...)". Match both forms —
      // a literal "core." replace alone silently no-ops and leaves the mirror FK pointing at the real,
      // permanent core.manager_profile table instead of the temp mirror.
      const def = String(k.def)
        .replace(/REFERENCES (?:core\.)?manager_profile\(/, 'REFERENCES pg_temp.mp_probe(')
        .replace(/REFERENCES (?:core\.)?staff_profile\(/, 'REFERENCES pg_temp.sp_probe(');
      if (/REFERENCES (?:core\.)?(manager_profile|staff_profile)\(/.test(def)) throw new Error(`mirror FK still points at a shared table: ${k.conname}`);
      await qr.query(`ALTER TABLE pg_temp.vms_probe ADD CONSTRAINT ${k.conname} ${def}`);
    }
    const parents: Array<[string, string, string | null]> = [];
    const mp = (t: TestIdentity, org: string) => parents.push([t.profileId!, org, t.workspaceId]);
    mp(mA, orgA.id); mp(mB, orgA.id); mp(mNullWs, orgA.id); mp(mX, orgX.id);
    for (const [id, org, ws] of parents) await qr.query('INSERT INTO mp_probe (id, organisation_id, workspace_id) VALUES ($1, $2, $3)', [id, org, ws]);
    const staff: Array<[string, string, string | null]> = [[staffA.profileId!, orgA.id, staffA.workspaceId], [staffB.profileId!, orgA.id, staffB.workspaceId], [staffX.profileId!, orgX.id, staffX.workspaceId]];
    for (const [id, org, ws] of staff) await qr.query('INSERT INTO sp_probe (id, organisation_id, workspace_id) VALUES ($1, $2, $3)', [id, org, ws]);
  }

  const insertTeam = (m: EntityManager, manager: string, staff: string, organisation: string, workspace: string) =>
    m.query(
      `INSERT INTO pg_temp.vms_probe (manager_profile_id, staff_profile_id, organisation_id, workspace_id) VALUES ($1, $2, $3, $4)`,
      [manager, staff, organisation, workspace],
    );

  beforeAll(async () => {
    const __bt = new BootstrapTimer('venue-manager-staff-composite-fk');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    __bt.mark('compile');
    app = moduleRef.createNestApplication();
    await app.init();
    __bt.mark('init');
    await app.get(DataSource).query('SELECT 1');
    __bt.mark('dbPing');
    __bt.log();
    owner = createAdminDataSource();
    await owner.initialize();
    factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource: owner,
      tenantContext: moduleRef.get(TenantContextService),
      passwordHashing: moduleRef.get(PasswordHashingService),
    });

    const a = await factory.createOrganisationWithManagers(2, { permissions: 'production', workspace: true, label: 'vmsa' });
    orgA = a.organisation;
    mA = a.managers[0]!;
    mB = a.managers[1]!;
    mNullWs = await factory.createInternalManager(orgA, { permissions: 'production', workspace: false, label: 'vmsnull' });
    staffA = await factory.createStaff(orgA, { owner: mA, label: 'vmsstaffa' });
    staffB = await factory.createStaff(orgA, { owner: mB, label: 'vmsstaffb' });

    const x = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'vmsx' });
    orgX = x.organisation;
    mX = x.managers[0]!;
    staffX = await factory.createStaff(orgX, { owner: mX, label: 'vmsstaffx' });
    qr = owner.createQueryRunner();
    await qr.connect();
    await createMirrors();
  });

  afterAll(async () => {
    await qr?.release();
    await app?.close();
    await owner?.destroy();
  });

  // ------------------------------------------------------------ positive and negative cases (staff side)

  it('valid: Staff A with Organisation A and Workspace A succeeds', async () => {
    expect(await probe((m) => insertTeam(m, mA.profileId!, staffA.profileId!, orgA.id, mA.workspaceId!))).toEqual({ ok: true });
  });

  it('refused: Staff B (Workspace B) with Workspace A → 23503', async () => {
    expect(await probe((m) => insertTeam(m, mA.profileId!, staffB.profileId!, orgA.id, mA.workspaceId!))).toEqual({ ok: false, code: '23503' });
  });

  it('refused: Staff from Organisation X attempted under Organisation A and its own workspace → 23503', async () => {
    expect(await probe((m) => insertTeam(m, mA.profileId!, staffX.profileId!, orgA.id, mX.workspaceId!))).toEqual({ ok: false, code: '23503' });
  });

  it('refused: Staff from Organisation X attempted under Organisation A with Organisation A workspace → 23503', async () => {
    expect(await probe((m) => insertTeam(m, mA.profileId!, staffX.profileId!, orgA.id, mA.workspaceId!))).toEqual({ ok: false, code: '23503' });
  });

  // ------------------------------------------------------------ manager side

  it('valid: Manager A with Organisation A and Workspace A succeeds', async () => {
    expect(await probe((m) => insertTeam(m, mA.profileId!, staffA.profileId!, orgA.id, mA.workspaceId!))).toEqual({ ok: true });
  });

  it('refused: Manager B (Workspace B) placed in a Workspace A team → 23503', async () => {
    expect(await probe((m) => insertTeam(m, mB.profileId!, staffA.profileId!, orgA.id, mA.workspaceId!))).toEqual({ ok: false, code: '23503' });
  });

  it('refused: Manager from Organisation X attempted under Organisation A → 23503', async () => {
    expect(await probe((m) => insertTeam(m, mX.profileId!, staffA.profileId!, orgA.id, mA.workspaceId!))).toEqual({ ok: false, code: '23503' });
  });

  // ------------------------------------------------------------ NULL semantics

  it('a manager profile with NULL workspace_id is not referenced by a team row with a non-null workspace → 23503', async () => {
    expect(await probe((m) => insertTeam(m, mNullWs.profileId!, staffA.profileId!, orgA.id, mA.workspaceId!))).toEqual({ ok: false, code: '23503' });
  });

  it('the NULL-workspace manager profile itself is unchanged by the constraints (its row still exists with NULL workspace)', async () => {
    // manager_profile is FORCE RLS and workspace-private: bind the organisation and the profile's own user to read it.
    const [row] = await owner.transaction(async (m) => {
      await m.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true)`, [orgA.id, mNullWs.userId]);
      return m.query(`SELECT workspace_id FROM core.manager_profile WHERE id = $1`, [mNullWs.profileId]);
    });
    expect(row.workspace_id).toBeNull();
  });

  // ------------------------------------------------------------ cascade behaviour preserved

  it('deleting a referenced staff profile cascades its team rows (intended ON DELETE CASCADE)', async () => {
    const result = await probe(async (m) => {
      await insertTeam(m, mA.profileId!, staffA.profileId!, orgA.id, mA.workspaceId!);
      await m.query(`DELETE FROM pg_temp.sp_probe WHERE id = $1`, [staffA.profileId]);
      const [{ n }] = await m.query(`SELECT count(*)::int AS n FROM pg_temp.vms_probe WHERE staff_profile_id = $1`, [staffA.profileId]);
      if (n !== 0) throw new Error(`cascade did not remove team rows: ${n}`);
    });
    expect(result).toEqual({ ok: true });
  });

  it('deleting a referenced manager profile cascades its team rows (intended ON DELETE CASCADE)', async () => {
    const result = await probe(async (m) => {
      const [{ id: vm }] = await m.query(`SELECT id FROM pg_temp.mp_probe WHERE id = $1`, [mA.profileId]);
      await insertTeam(m, vm, staffA.profileId!, orgA.id, mA.workspaceId!);
      await m.query(`DELETE FROM pg_temp.vms_probe WHERE manager_profile_id = $1`, [vm]);
      await insertTeam(m, vm, staffA.profileId!, orgA.id, mA.workspaceId!);
      await m.query(`DELETE FROM pg_temp.mp_probe WHERE id = $1`, [vm]);
      const [{ n }] = await m.query(`SELECT count(*)::int AS n FROM pg_temp.vms_probe WHERE manager_profile_id = $1`, [vm]);
      if (n !== 0) throw new Error(`cascade did not remove team rows: ${n}`);
    });
    // Deleting a manager profile may be blocked by other children (manager_venue etc.). Either the cascade worked, or a
    // non-team child refused the delete. Both are structural; only a team row surviving the delete is a failure.
    if (!result.ok) expect(result.code).toMatch(/^(23503|23001)$/);
  });

  // ------------------------------------------------------------ catalogue properties of the new keys

  it('the new keys are NOT DEFERRABLE, ON DELETE CASCADE, ON UPDATE NO ACTION (as declared)', async () => {
    const rows = await owner.query(
      `SELECT conname, condeferrable, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'core.venue_manager_staff'::regclass AND conname LIKE '%org_ws_fkey'`,
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.condeferrable).toBe(false);
      expect(String(r.def)).toMatch(/ON DELETE CASCADE/);
      expect(String(r.def)).not.toMatch(/ON UPDATE/);
    }
  });
});
