import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { StaffService } from '../../modules/staff/services/staff.service';
import { createAdminDataSource, createCrewflowOwnerProbeDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Staff / Venue Manager RLS redesign: adversarial suite. The database answers "which rows may this caller address?"
 *
 * Product rule (owner):
 *   STAFF          -> own staff profile only.
 *   MANAGER        -> Staff inside the Manager's own workspace (ownership and permissions are enforced by the service).
 *   VENUE MANAGER  -> the Staff pool of the Venue Manager's own workspace. ACTIVE eligibility and the projection are service rules.
 *   Nobody crosses workspace or organisation.
 *
 * Every probe runs as rab_app under an explicit tenant context, which is how production code reaches the database.
 */
const RUN = Boolean(process.env.DATABASE_URL);
(RUN ? describe : describe.skip)('staff profile and venue staff RLS: adversarial abuse cases', () => {
  let app: INestApplication;
  let owner: DataSource;
  let crewflowOwnerProbe: DataSource;
  let appDs: DataSource;
  let tenantContext: TenantContextService;
  let staffService: StaffService;

  let org: { id: string };
  let managerA: TestIdentity; // Workspace A
  let managerB: TestIdentity; // Workspace B
  let staffA1: TestIdentity;
  let staffA2: TestIdentity;
  let staffB1: TestIdentity;
  let vmA: TestIdentity; // Venue Manager, Workspace A, venue in A
  let vmB: TestIdentity; // Venue Manager, Workspace B, venue in B
  let venueA: string;
  let venueB: string;
  let orgX: { id: string };
  let staffX: TestIdentity;

  const ctxOf = (id: { organisationId: string; workspaceId: string | null; userId: string | null }): AuthContext => ({
    organisationId: id.organisationId,
    workspaceId: id.workspaceId,
    userId: id.userId!,
    role: '',
  });

  /** Runs `sql` as rab_app under the identity's tenant context and returns the rows. */
  async function asCaller<T = Record<string, unknown>>(
    who: { organisationId: string; workspaceId: string | null; userId: string | null },
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const result: unknown = await tenantContext.runInTenantContext(ctxOf(who), (m) => m.query(sql, params));
    // UPDATE and DELETE come back from TypeORM as [rows, rowCount]; SELECT and RETURNING come back as rows.
    if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0]) && typeof result[1] === "number") return result[0] as T[];
    return result as T[];
  }

  /** The staff profile id of a Staff user, read through that user's own context (FORCE RLS hides it from the owner). */
  async function profileIdOf(userId: string): Promise<string> {
    const who = [staffA1, staffA2, staffB1, staffX].find((s) => s.userId === userId);
    if (!who) throw new Error("unknown staff identity");
    const rows = await asCaller<{ id: string }>(who, `SELECT id FROM core.staff_profile WHERE user_id = $1`, [userId]);
    return rows[0]!.id;
  }

  /** Visible staff profile ids for a caller, as rab_app under the caller's context. */
  async function visibleStaff(who: { organisationId: string; workspaceId: string | null; userId: string | null }): Promise<string[]> {
    const rows = await asCaller<{ id: string }>(who, `SELECT id FROM core.staff_profile`);
    return rows.map((r) => r.id);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    crewflowOwnerProbe = createCrewflowOwnerProbeDataSource();
    await crewflowOwnerProbe.initialize();
    appDs = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    staffService = moduleRef.get(StaffService, { strict: false });
    const factory = new TestIdentityFactory({
      app,
      dataSource: appDs,
      adminDataSource: owner,
      tenantContext,
      passwordHashing: moduleRef.get(PasswordHashingService),
    });

    const a = await factory.createOrganisationWithManagers(2, { permissions: 'production', workspace: true, label: 'rlsorg' });
    org = a.organisation;
    managerA = a.managers[0]!;
    managerB = a.managers[1]!;
    staffA1 = await factory.createStaff(org, { owner: managerA, label: 'rls-a1' });
    staffA2 = await factory.createStaff(org, { owner: managerA, label: 'rls-a2' });
    staffB1 = await factory.createStaff(org, { owner: managerB, label: 'rls-b1' });

    venueA = randomUUID();
    venueB = randomUUID();
    // Venues are created through each manager's own tenant context, as the product does.
    await tenantContext.runInTenantContext(ctxOf(managerA), (m) =>
      m.query(`INSERT INTO core.venue (id, organisation_id, name, workspace_id) VALUES ($1, $2, 'Venue A', $3)`, [venueA, org.id, managerA.workspaceId]),
    );
    await tenantContext.runInTenantContext(ctxOf(managerB), (m) =>
      m.query(`INSERT INTO core.venue (id, organisation_id, name, workspace_id) VALUES ($1, $2, 'Venue B', $3)`, [venueB, org.id, managerB.workspaceId]),
    );
    vmA = await factory.createVenueManager(org, { owner: managerA, venueIds: [venueA], label: 'rls-vma' });
    vmB = await factory.createVenueManager(org, { owner: managerB, venueIds: [venueB], label: 'rls-vmb' });

    const x = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'rlsx' });
    orgX = x.organisation;
    staffX = await factory.createStaff(orgX, { owner: x.managers[0]!, label: 'rls-x' });
  });

  afterAll(async () => {
    await app?.close();
    await crewflowOwnerProbe?.destroy();
    await owner?.destroy();
  });

  // ------------------------------------------------------------------ Staff: self only

  it('Staff A1 reads their own profile', async () => {
    expect(await visibleStaff(staffA1)).toContain(await profileIdOf(staffA1.userId!));
  });

  it('Staff A1 cannot read Staff A2, and cannot enumerate Workspace A Staff', async () => {
    const ids = await visibleStaff(staffA1);
    expect(ids).not.toContain(await profileIdOf(staffA2.userId!));
    expect(ids).toEqual([await profileIdOf(staffA1.userId!)]);
  });

  it('Staff A2 cannot read Staff A1', async () => {
    expect(await visibleStaff(staffA2)).not.toContain(await profileIdOf(staffA1.userId!));
  });

  // ------------------------------------------------------------------ Managers

  it('Manager A reads Staff A1 and A2 but never Workspace B Staff', async () => {
    const ids = await visibleStaff(managerA);
    expect(ids).toEqual(expect.arrayContaining([await profileIdOf(staffA1.userId!), await profileIdOf(staffA2.userId!)]));
    expect(ids).not.toContain(await profileIdOf(staffB1.userId!));
  });

  it('Manager B cannot read Staff A1', async () => {
    expect(await visibleStaff(managerB)).not.toContain(await profileIdOf(staffA1.userId!));
  });

  // ------------------------------------------------------------------ Venue Managers

  it('Venue Manager A reads the Workspace A Staff pool, and no Workspace B Staff', async () => {
    const ids = await visibleStaff(vmA);
    expect(ids).toEqual(expect.arrayContaining([await profileIdOf(staffA1.userId!), await profileIdOf(staffA2.userId!)]));
    expect(ids).not.toContain(await profileIdOf(staffB1.userId!));
  });

  it('Venue Manager B cannot read Workspace A Staff', async () => {
    const ids = await visibleStaff(vmB);
    expect(ids).not.toContain(await profileIdOf(staffA1.userId!));
    expect(ids).not.toContain(await profileIdOf(staffA2.userId!));
  });

  it('the Venue Manager staff pool service returns only ACTIVE Staff of the caller workspace', async () => {
    await owner.query(`UPDATE core."user" SET status = 'suspended' WHERE id = $1`, [staffA2.userId]);
    try {
      const pool = await staffService.venueStaffPool(ctxOf(vmA), {});
      const ids = (pool.data as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toContain(await profileIdOf(staffA1.userId!));
      expect(ids).not.toContain(await profileIdOf(staffA2.userId!));
      expect(ids).not.toContain(await profileIdOf(staffB1.userId!));
    } finally {
      await owner.query(`UPDATE core."user" SET status = 'active' WHERE id = $1`, [staffA2.userId]);
    }
  });

  // ------------------------------------------------------------------ wrong or missing context fails closed

  it('wrong workspace context (Manager A in Workspace B) yields zero rows', async () => {
    const rows = await asCaller(
      { organisationId: org.id, workspaceId: managerB.workspaceId, userId: managerA.userId },
      `SELECT id FROM core.staff_profile`,
    );
    expect(rows).toHaveLength(0);
  });

  it('wrong organisation context (Organisation X with Workspace A) yields zero rows', async () => {
    const rows = await asCaller(
      { organisationId: orgX.id, workspaceId: managerA.workspaceId, userId: managerA.userId },
      `SELECT id FROM core.staff_profile`,
    );
    expect(rows).toHaveLength(0);
  });

  it('missing context: the runtime role with no tenant bound sees zero Staff rows', async () => {
    const rows = await appDs.query(`SELECT id FROM core.staff_profile`);
    expect(rows).toHaveLength(0);
  });

  it('FORCE RLS applies to rab_app and to the table owner: the owner without context sees zero Staff rows', async () => {
    // crewflowOwnerProbe, not `owner`: `owner` is the Postgres superuser locally (createAdminDataSource's whole
    // purpose, used everywhere else in this file for ordinary fixture bootstrap) — superusers bypass RLS
    // unconditionally regardless of table ownership, which would make THIS specific assertion vacuous. `crewflow`
    // actually owns `staff_profile`, so it is the real "owner" FORCE must bind, per createCrewflowOwnerProbeDataSource's
    // own doc comment. Found live: this assertion returned every row (not 0) when run over the superuser connection.
    const [{ n }] = await crewflowOwnerProbe.query(`SELECT count(*)::int AS n FROM core.staff_profile`);
    expect(n).toBe(0);
    const forced = await owner.query(`SELECT relforcerowsecurity FROM pg_class WHERE oid = 'core.staff_profile'::regclass`);
    expect(forced[0].relforcerowsecurity).toBe(true);
  });

  // ------------------------------------------------------------------ writes

  it('Staff A1 can update their own profile', async () => {
    const id = await profileIdOf(staffA1.userId!);
    const rows = await asCaller(staffA1, `UPDATE core.staff_profile SET preferred_name = 'Self' WHERE id = $1 RETURNING id`, [id]);
    expect(rows).toHaveLength(1);
  });

  it('Staff A1 cannot modify Staff A2 (zero rows affected)', async () => {
    const id = await profileIdOf(staffA2.userId!);
    const rows = await asCaller(staffA1, `UPDATE core.staff_profile SET preferred_name = 'Hijack' WHERE id = $1 RETURNING id`, [id]);
    expect(rows).toHaveLength(0);
  });

  it('Manager A cannot insert a Staff profile into Workspace B', async () => {
    await expect(
      asCaller(
        managerA,
        `INSERT INTO core.staff_profile (organisation_id, user_id, workspace_id, staff_ref) VALUES ($1, $2, $3, 'XWS-1')`,
        [org.id, randomUUID(), managerB.workspaceId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('Manager A cannot delete Workspace B Staff (zero rows affected)', async () => {
    const id = await profileIdOf(staffB1.userId!);
    const rows = await asCaller(managerA, `DELETE FROM core.staff_profile WHERE id = $1 RETURNING id`, [id]);
    expect(rows).toHaveLength(0);
  });

  it('Venue Manager A cannot insert Staff (a venue manager does not write staff profiles)', async () => {
    await expect(
      asCaller(
        vmA,
        `INSERT INTO core.staff_profile (organisation_id, user_id, workspace_id, staff_ref) VALUES ($1, $2, $3, 'VMS-1')`,
        [org.id, randomUUID(), vmA.workspaceId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('cross-workspace team relationship: Venue Manager A cannot add Staff B1 to their team', async () => {
    await expect(
      asCaller(
        vmA,
        `INSERT INTO core.venue_manager_staff (manager_profile_id, staff_profile_id, organisation_id, workspace_id) VALUES ($1, $2, $3, $4)`,
        [vmA.profileId, await profileIdOf(staffB1.userId!), org.id, vmA.workspaceId],
      ),
    ).rejects.toThrow();
  });

  it('cross-organisation team relationship: Venue Manager A cannot add Organisation X Staff', async () => {
    await expect(
      asCaller(
        vmA,
        `INSERT INTO core.venue_manager_staff (manager_profile_id, staff_profile_id, organisation_id, workspace_id) VALUES ($1, $2, $3, $4)`,
        [vmA.profileId, await profileIdOf(staffX.userId!), org.id, vmA.workspaceId],
      ),
    ).rejects.toThrow();
  });

  it('a same-workspace team relationship is still allowed', async () => {
    const rows = await asCaller(
      vmA,
      `INSERT INTO core.venue_manager_staff (manager_profile_id, staff_profile_id, organisation_id, workspace_id) VALUES ($1, $2, $3, $4) RETURNING staff_profile_id`,
      [vmA.profileId, await profileIdOf(staffA1.userId!), org.id, vmA.workspaceId],
    );
    expect(rows).toHaveLength(1);
  });

  // ------------------------------------------------------------------ no policy recursion

  it('reading venue_manager_staff under a Staff context completes without a recursion error', async () => {
    await expect(asCaller(staffA1, `SELECT count(*)::int AS n FROM core.venue_manager_staff`)).resolves.toBeDefined();
  });

  it('venue_manager_staff under the Venue Manager context completes without a recursion error', async () => {
    await expect(asCaller(vmA, `SELECT count(*)::int AS n FROM core.venue_manager_staff`)).resolves.toBeDefined();
  });
});
