import 'reflect-metadata';
import { ManagerType, UserStatus } from '@rab/shared';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { Organisation, Role, User, UserRole } from '../../modules/identity/entities';
import { ManagerProfile } from '../../modules/manager/entities/manager-profile.entity';
import { ManagerWorkspace } from '../../modules/manager-workspace/entities/manager-workspace.entity';
import { StaffProfile } from '../../modules/staff/entities/staff-profile.entity';
import { Venue } from '../../modules/venue/entities/venue.entity';
import { JobRole } from '../../modules/scheduling/entities/job-role.entity';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
import { ShiftAssignment } from '../../modules/scheduling/entities/shift-assignment.entity';
import { JobOffer } from '../../modules/offer/entities/job-offer.entity';
import { Attendance } from '../../modules/attendance/entities/attendance.entity';
import { toTstzRange } from '../../modules/scheduling/utils/tstzrange';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { createAdminDataSource } from './helpers/admin-datasource';

/**
 * MANDATORY Stage 2A step 6 proof, required before Step 7 could begin.
 * Proves the actual, load-bearing security property this whole migration
 * exists for: two Managers who legitimately share one legacy
 * `organisation_id` (the pre-workspace tenant boundary, still bound in
 * every session) are nonetheless FULLY isolated from each other's
 * operational data purely by the `workspace_id` RLS dimension — never by
 * `created_by`, which this test deliberately never filters on. Every
 * verification query below is `WHERE organisation_id = $1` ONLY (the
 * shared legacy org, matching both workspaces) — if `workspace_id`-based
 * RLS weren't doing the real work, both workspaces' rows would come back
 * for both contexts.
 *
 * Runs as `rab_app` (`DATABASE_URL`) — the real runtime role RLS actually
 * has to hold against in production, not `rab_owner`. Bootstrap-only
 * operations (creating the shared `Organisation`, which structurally can't
 * happen over `rab_app` at all — see `admin-datasource.ts`) use
 * `adminDataSource` (`rab_owner`, via `DATABASE_URL_UNPOOLED`) — every
 * actual attack-proof query below uses `dataSource` (`rab_app`).
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('workspace cross-tenant RLS attack (integration)', () => {
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let passwordHashing: PasswordHashingService;

  const password = 'correct horse battery staple 1!';

  interface WorkspaceFixture {
    workspaceId: string;
    managerUserId: string;
    staffProfileId: string;
    staffUserId: string;
    venueId: string;
    jobRoleId: string;
    shiftId: string;
    shiftAssignmentId: string;
    jobOfferId: string;
    attendanceId: string;
  }

  /** Binds session GUCs directly on the `rab_app` connection — the same mechanism `TenantContextService` uses, exposed here for raw attack-proof queries outside any service layer. */
  async function withContext<T>(
    ctx: { organisationId: string; workspaceId: string | null; userId: string },
    fn: (manager: DataSource['manager']) => Promise<T>,
  ): Promise<T> {
    return dataSource.transaction(async (manager) => {
      await manager.query(`SELECT set_config('rab.organisation_id', $1, true)`, [ctx.organisationId]);
      await manager.query(`SELECT set_config('rab.workspace_id', $1, true)`, [ctx.workspaceId ?? '']);
      await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [ctx.userId]);
      await manager.query(`SELECT set_config('rab.role', '', true)`);
      return fn(manager);
    });
  }

  /**
   * Builds one complete, real operational fixture (Manager owning a
   * private Workspace, Staff, Venue, JobRole, Shift, ShiftAssignment,
   * JobOffer, Attendance) inside the given shared organisation — every row
   * genuinely written through the same `workspace_id`-inheritance chain
   * production code uses (Venue → Shift → ShiftAssignment → JobOffer /
   * Attendance), not synthesized independently per table.
   */
  async function seedWorkspaceFixture(organisationId: string, label: string): Promise<WorkspaceFixture> {
    let workspaceId!: string;
    let managerUserId!: string;
    let staffUserId!: string;
    let staffProfileId!: string;

    // Phase 1: bootstrap the Manager + their own ManagerWorkspace, bound to
    // a throwaway actor identity (the workspace doesn't exist yet — same
    // chicken-and-egg this whole migration set already resolved for every
    // other seed helper).
    await withContext({ organisationId, workspaceId: null, userId: randomUUID() }, async (manager) => {
      let role = await manager.findOne(Role, { where: { organisationId, key: 'manager' } });
      if (!role) {
        const roleResult = await manager.insert(Role, { organisationId, key: 'manager', name: 'Manager', isSystem: true });
        role = await manager.findOneByOrFail(Role, { id: roleResult.identifiers[0]!.id as string });
      }
      const managerHash = await passwordHashing.hash(password);
      const managerResult = await manager.insert(User, {
        organisationId,
        email: `${label}-mgr-${randomUUID()}@example.test`,
        passwordHash: managerHash,
        firstName: label,
        lastName: 'Manager',
        status: UserStatus.ACTIVE,
      });
      managerUserId = managerResult.identifiers[0]!.id as string;
      await manager.insert(UserRole, { userId: managerUserId, roleId: role.id, organisationId });

      // manager_workspace_write's own WITH CHECK requires owner_user_id =
      // current_uid() — rebind to the real new manager, not the throwaway
      // bootstrap identity this phase is bound to.
      await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [managerUserId]);
      const workspace = await manager.save(ManagerWorkspace, {
        organisationId,
        ownerUserId: managerUserId,
        name: `${label} Workspace ${managerUserId}`,
        subdomain: `${label}-${managerUserId.slice(0, 8)}`,
        status: 'active',
      });
      workspaceId = workspace.id;
      await manager.insert(ManagerProfile, { organisationId, userId: managerUserId, type: ManagerType.INTERNAL, workspaceId });

      // The Staff insert below stamps the now-real workspaceId onto the
      // row, but this transaction's own session is still bound to
      // workspaceId: null (from Phase 1's outer context) — rebind
      // rab.workspace_id too, or staff_profile's combined org+workspace
      // WITH CHECK sees a mismatch (NULL session vs a real row value) and
      // rejects the insert, the same lesson every other two-phase seed
      // helper in this migration set already applies.
      await manager.query(`SELECT set_config('rab.workspace_id', $1, true)`, [workspaceId]);

      // A Staff account, workspace-stamped exactly as StaffService.create
      // stamps a real one.
      const staffHash = await passwordHashing.hash(password);
      const staffResult = await manager.insert(User, {
        organisationId,
        email: `${label}-staff-${randomUUID()}@example.test`,
        passwordHash: staffHash,
        firstName: label,
        lastName: 'Staff',
        status: UserStatus.ACTIVE,
      });
      staffUserId = staffResult.identifiers[0]!.id as string;
      let staffRole = await manager.findOne(Role, { where: { organisationId, key: 'staff' } });
      if (!staffRole) {
        const staffRoleResult = await manager.insert(Role, { organisationId, key: 'staff', name: 'Staff', isSystem: true });
        staffRole = await manager.findOneByOrFail(Role, { id: staffRoleResult.identifiers[0]!.id as string });
      }
      await manager.insert(UserRole, { userId: staffUserId, roleId: staffRole.id, organisationId });
      const staffProfile = await manager.save(StaffProfile, {
        organisationId,
        userId: staffUserId,
        staffRef: `STF-${label}-${randomUUID().slice(0, 8)}`,
        createdBy: managerUserId,
        workspaceId,
      });
      staffProfileId = staffProfile.id;
    });

    // Phase 2: bound to the now-real Workspace, as the Manager themselves —
    // Venue/JobRole/Shift/ShiftAssignment/JobOffer/Attendance's own combined
    // org+workspace WITH CHECK needs the SESSION context to match, not just
    // each row's own workspace_id value (the same lesson every other
    // two-phase seed helper in this migration set already applies).
    let venueId!: string;
    let jobRoleId!: string;
    let shiftId!: string;
    let shiftAssignmentId!: string;
    let jobOfferId!: string;
    let attendanceId!: string;
    await withContext({ organisationId, workspaceId, userId: managerUserId }, async (manager) => {
      const venue = await manager.save(Venue, { organisationId, name: `${label} Venue`, createdBy: managerUserId, workspaceId });
      venueId = venue.id;

      const jobRole = await manager.save(JobRole, {
        organisationId,
        name: `${label} Role ${randomUUID().slice(0, 6)}`,
        defaultRatePence: 1500,
        createdBy: managerUserId,
        workspaceId,
      });
      jobRoleId = jobRole.id;

      const startsAt = new Date(Date.now() + 48 * 3600 * 1000);
      const endsAt = new Date(startsAt.getTime() + 8 * 3600 * 1000);
      const shift = await manager.save(Shift, {
        organisationId,
        venueId,
        jobRoleId,
        startsAt,
        endsAt,
        breakMinutes: 0,
        requiredCount: 1,
        payRatePence: 1500,
        status: 'open',
        createdBy: managerUserId,
        workspaceId,
      });
      shiftId = shift.id;

      const assignment = await manager.save(ShiftAssignment, {
        organisationId,
        shiftId,
        staffProfileId,
        status: 'confirmed',
        payRateSnapshotPence: 1500,
        assignedBy: managerUserId,
        confirmedAt: new Date(),
        period: toTstzRange(startsAt, endsAt),
        workspaceId,
      });
      shiftAssignmentId = assignment.id;

      const offer = await manager.save(JobOffer, {
        organisationId,
        shiftAssignmentId: assignment.id,
        staffProfileId,
        status: 'manager_confirmed',
        sentAt: new Date(),
        expiresAt: new Date(Date.now() + 3600 * 1000),
        estimatedPayPence: 12000,
        createdBy: managerUserId,
        workspaceId,
      });
      jobOfferId = offer.id;

      const attendance = await manager.save(Attendance, {
        organisationId,
        shiftAssignmentId: assignment.id,
        shiftId,
        staffProfileId,
        workspaceId,
        clockInAt: new Date(),
        status: 'active',
      });
      attendanceId = attendance.id;
    });

    return {
      workspaceId,
      managerUserId,
      staffProfileId,
      staffUserId,
      venueId,
      jobRoleId,
      shiftId,
      shiftAssignmentId,
      jobOfferId,
      attendanceId,
    };
  }

  /** manager_venue: a Venue Manager assigned INTO one workspace's venue — its own cross-workspace isolation surface, separate from the owner-workspace fixtures above. */
  async function seedVenueManagerAssignment(
    organisationId: string,
    workspaceId: string,
    venueId: string,
    ownerUserId: string,
  ): Promise<string> {
    return withContext({ organisationId, workspaceId, userId: ownerUserId }, async (manager) => {
      let vmRole = await manager.findOne(Role, { where: { organisationId, key: 'venue_manager' } });
      if (!vmRole) {
        const roleResult = await manager.insert(Role, { organisationId, key: 'venue_manager', name: 'Venue Manager', isSystem: true });
        vmRole = await manager.findOneByOrFail(Role, { id: roleResult.identifiers[0]!.id as string });
      }
      const hash = await passwordHashing.hash(password);
      const userResult = await manager.insert(User, {
        organisationId,
        email: `vm-${randomUUID()}@example.test`,
        passwordHash: hash,
        firstName: 'Venue',
        lastName: 'Manager',
        status: UserStatus.ACTIVE,
      });
      const vmUserId = userResult.identifiers[0]!.id as string;
      await manager.insert(UserRole, { userId: vmUserId, roleId: vmRole.id, organisationId });
      const profileResult = await manager.query(
        `INSERT INTO core.manager_profile (organisation_id, user_id, type) VALUES ($1, $2, $3) RETURNING id`,
        [organisationId, vmUserId, ManagerType.VENUE],
      );
      const vmProfileId = profileResult[0].id as string;
      await manager.query(
        `INSERT INTO core.manager_venue (organisation_id, manager_profile_id, venue_id, workspace_id) VALUES ($1, $2, $3, $4)`,
        [organisationId, vmProfileId, venueId, workspaceId],
      );
      return vmProfileId as string;
    });
  }

  beforeAll(async () => {
    // A bare DataSource is enough here — this suite issues raw SQL/ORM
    // queries directly (the whole point is to bypass every service layer
    // and prove the DB-level RLS boundary alone), it never needs a real
    // NestJS HTTP app or its controllers.
    dataSource = new DataSource({
      type: 'postgres',
      url: process.env.DATABASE_URL,
      schema: 'core',
      synchronize: false,
      entities: [Organisation, Role, User, UserRole, ManagerProfile, ManagerWorkspace, StaffProfile, Venue, JobRole, Shift, ShiftAssignment, JobOffer, Attendance],
    });
    await dataSource.initialize();
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    passwordHashing = new PasswordHashingService();
  });

  afterAll(async () => {
    await dataSource.destroy();
    await adminDataSource.destroy();
  });

  it('two Managers sharing one legacy organisation_id are fully isolated by workspace_id alone, in both directions, without relying on created_by, and a request with no workspace bound sees neither', async () => {
    const orgInsert = await adminDataSource.manager.insert(Organisation, { name: `attack-${randomUUID()}`, slug: `attack-${randomUUID()}` });
    const organisationId = orgInsert.identifiers[0]!.id as string;

    const a = await seedWorkspaceFixture(organisationId, 'wsa');
    const b = await seedWorkspaceFixture(organisationId, 'wsb');
    const vmProfileIdA = await seedVenueManagerAssignment(organisationId, a.workspaceId, a.venueId, a.managerUserId);
    const vmProfileIdB = await seedVenueManagerAssignment(organisationId, b.workspaceId, b.venueId, b.managerUserId);

    // Every query below filters ONLY on organisation_id (the one thing A
    // and B legitimately share) — never created_by, never staff/manager
    // user id. If workspace_id-based RLS weren't doing the real work here,
    // every one of these would return both workspaces' rows.
    type Row = { id: string };
    const tables: Array<{ name: string; sql: string; aId: string; bId: string }> = [
      { name: 'staff_profile', sql: `SELECT id FROM core.staff_profile WHERE organisation_id = $1`, aId: a.staffProfileId, bId: b.staffProfileId },
      { name: 'venue', sql: `SELECT id FROM core.venue WHERE organisation_id = $1`, aId: a.venueId, bId: b.venueId },
      { name: 'job_role', sql: `SELECT id FROM core.job_role WHERE organisation_id = $1`, aId: a.jobRoleId, bId: b.jobRoleId },
      { name: 'shift', sql: `SELECT id FROM core.shift WHERE organisation_id = $1`, aId: a.shiftId, bId: b.shiftId },
      {
        name: 'shift_assignment',
        sql: `SELECT id FROM core.shift_assignment WHERE organisation_id = $1`,
        aId: a.shiftAssignmentId,
        bId: b.shiftAssignmentId,
      },
      { name: 'job_offer', sql: `SELECT id FROM core.job_offer WHERE organisation_id = $1`, aId: a.jobOfferId, bId: b.jobOfferId },
      { name: 'attendance', sql: `SELECT id FROM core.attendance WHERE organisation_id = $1`, aId: a.attendanceId, bId: b.attendanceId },
      {
        name: 'manager_venue',
        sql: `SELECT manager_profile_id AS id FROM core.manager_venue WHERE organisation_id = $1`,
        aId: vmProfileIdA,
        bId: vmProfileIdB,
      },
    ];

    for (const table of tables) {
      // Workspace A's own bound context sees ONLY A's row, never B's.
      const asA = await withContext(
        { organisationId, workspaceId: a.workspaceId, userId: a.managerUserId },
        (manager) => manager.query<Row[]>(table.sql, [organisationId]),
      );
      const idsAsA = asA.map((r) => r.id);
      expect(idsAsA).toContain(table.aId);
      expect(idsAsA).not.toContain(table.bId);

      // Reverse direction: Workspace B's own bound context sees ONLY B's
      // row, never A's.
      const asB = await withContext(
        { organisationId, workspaceId: b.workspaceId, userId: b.managerUserId },
        (manager) => manager.query<Row[]>(table.sql, [organisationId]),
      );
      const idsAsB = asB.map((r) => r.id);
      expect(idsAsB).toContain(table.bId);
      expect(idsAsB).not.toContain(table.aId);

      // Fail-closed: no workspace context bound at all (still the correct
      // shared organisation_id, still a real authenticated-shaped user id —
      // only workspace_id is missing) sees NEITHER row.
      const noContext = await withContext(
        { organisationId, workspaceId: null, userId: randomUUID() },
        (manager) => manager.query<Row[]>(table.sql, [organisationId]),
      );
      const idsNoContext = noContext.map((r) => r.id);
      expect(idsNoContext).not.toContain(table.aId);
      expect(idsNoContext).not.toContain(table.bId);
    }
    // Two full 8-table fixtures + two Venue Manager assignments + 24
    // context-bound verification queries is a lot of sequential DB
    // round-trips — past this suite's own 5s default under a loaded
    // machine, independent of RLS correctness.
  }, 30_000);
});
