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
import { AttendanceCorrection } from '../../modules/attendance/entities/attendance-correction.entity';
import { ShiftReport } from '../../modules/attendance/entities/shift-report.entity';
import { toTstzRange } from '../../modules/scheduling/utils/tstzrange';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { generateFixturePassword } from './helpers/fixture-password';
import { integrationTestDatabase, integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { provisionFixtureWorkspace } from './helpers/test-identities';
import { businessSchema, businessTable, hwsRuntimeOn, withCutoverInactive } from './helpers/hws-fixtures';

const FIXTURE_PASSWORD = generateFixturePassword();

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
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('workspace cross-tenant RLS attack (integration)', () => {
  let restoreCutover: (() => Promise<void>) | undefined;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let passwordHashing: PasswordHashingService;

  const password = FIXTURE_PASSWORD;

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
    shiftReportId: string;
    attendanceCorrectionId: string;
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
      await provisionFixtureWorkspace(manager, workspace.id); // Part C1: READY schema, as the product builds it
      await manager.query(`SELECT set_config('search_path', $1, true)`, [businessSchema(workspace.id)]); // later fixture writes in this transaction land in the workspace's schema
      workspaceId = workspace.id;
      // manager_profile WITH CHECK: a profile in a workspace is written only with that workspace bound to the session (the server
      // binds it the same way in ManagerWorkspaceService.create).
      await manager.query(`SELECT set_config('rab.workspace_id', $1, true)`, [workspaceId]);
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
    let shiftReportId!: string;
    let attendanceCorrectionId!: string;
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
        status: 'clocked_in',
      });
      attendanceId = attendance.id;

      const report = await manager.save(ShiftReport, {
        organisationId,
        workspaceId,
        shiftId,
        status: 'ready',
      });
      shiftReportId = report.id;

      const correction = await manager.save(AttendanceCorrection, {
        organisationId,
        workspaceId,
        attendanceId,
        field: 'breakMinutes',
        oldValue: '0',
        newValue: '30',
        reason: `${label} correction for cross-tenant RLS attack fixture`,
        correctedBy: managerUserId,
      });
      attendanceCorrectionId = correction.id;
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
      shiftReportId,
      attendanceCorrectionId,
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
        `INSERT INTO core.manager_profile (organisation_id, user_id, type, workspace_id) VALUES ($1, $2, $3, $4) RETURNING id`,
        [organisationId, vmUserId, ManagerType.VENUE, workspaceId],
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
      url: integrationTestDatabase().appUrl,
      schema: 'core',
      synchronize: false,
      entities: [
        Organisation,
        Role,
        User,
        UserRole,
        ManagerProfile,
        ManagerWorkspace,
        StaffProfile,
        Venue,
        JobRole,
        Shift,
        ShiftAssignment,
        JobOffer,
        Attendance,
        ShiftReport,
        AttendanceCorrection,
      ],
    });
    await dataSource.initialize();
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    // Release 0.7.0: this describe proves workspace_id RLS on the CORE copies (the pre-cutover world, read-only once activated);
    // the activated variant below proves the cross-schema isolation. Sentinel restored after.
    restoreCutover = await withCutoverInactive(adminDataSource);
    passwordHashing = new PasswordHashingService();
  });

  afterAll(async () => {
    await restoreCutover?.();
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
      { name: 'shift_report', sql: `SELECT id FROM core.shift_report WHERE organisation_id = $1`, aId: a.shiftReportId, bId: b.shiftReportId },
      {
        name: 'attendance_correction',
        sql: `SELECT id FROM core.attendance_correction WHERE organisation_id = $1`,
        aId: a.attendanceCorrectionId,
        bId: b.attendanceCorrectionId,
      },
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

/**
 * Release 0.7.0: the SAME isolation proof in the ACTIVATED state production runs after the HWS cutover (the in-band CI
 * database is built by a 0.7.0 start with HWS on: sentinel written, new workspaces verified at creation, core copies
 * read-only). Business rows live in each workspace's own schema. The attack now is a cross-SCHEMA read: bound to A, read B's
 * schema (and the reverse), every query filtering ONLY on the shared organisation_id. Expected: A sees A's row in A's schema
 * and nothing in B's; B the reverse; no workspace bound sees neither schema's row. HWS-off runs skip it (that state does not
 * exist with HWS off).
 */
const describeActivated = RUN && hwsRuntimeOn() ? describe : describe.skip;

describeActivated('workspace cross-tenant RLS attack, activated (post-cutover) state (integration)', () => {
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let passwordHashing: PasswordHashingService;

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
  const one = async (manager: DataSource['manager'], sql: string, params: unknown[]) => ((await manager.query(sql, params)) as Array<{ id: string }>)[0]!.id;

  async function newUser(manager: DataSource['manager'], organisationId: string, label: string, roleKey: string, roleName: string): Promise<string> {
    let role = await manager.findOne(Role, { where: { organisationId, key: roleKey } });
    if (!role) {
      const roleResult = await manager.insert(Role, { organisationId, key: roleKey, name: roleName, isSystem: true });
      role = await manager.findOneByOrFail(Role, { id: roleResult.identifiers[0]!.id as string });
    }
    const result = await manager.insert(User, {
      organisationId,
      email: `${label}-${roleKey}-${randomUUID()}@example.test`,
      passwordHash: await passwordHashing.hash(FIXTURE_PASSWORD),
      firstName: label,
      lastName: roleName,
      status: UserStatus.ACTIVE,
    });
    const userId = result.identifiers[0]!.id as string;
    await manager.insert(UserRole, { userId, roleId: role.id, organisationId });
    return userId;
  }

  /** One workspace with every isolation surface: identities in core, business rows in the workspace's own schema. */
  async function seedActivated(organisationId: string, label: string) {
    let workspaceId!: string;
    let managerUserId!: string;
    await withContext({ organisationId, workspaceId: null, userId: randomUUID() }, async (manager) => {
      managerUserId = await newUser(manager, organisationId, label, 'manager', 'Manager');
      await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [managerUserId]);
      const workspace = await manager.save(ManagerWorkspace, {
        organisationId,
        ownerUserId: managerUserId,
        name: `${label} Workspace ${managerUserId}`,
        subdomain: `${label}-${managerUserId.slice(0, 8)}`,
        status: 'active',
      });
      await provisionFixtureWorkspace(manager, workspace.id);
      workspaceId = workspace.id;
      await manager.query(`SELECT set_config('rab.workspace_id', $1, true)`, [workspaceId]);
      await manager.insert(ManagerProfile, { organisationId, userId: managerUserId, type: ManagerType.INTERNAL, workspaceId });
    });
    const ids = await withContext({ organisationId, workspaceId, userId: managerUserId }, async (manager) => {
      const t = (table: string) => businessTable(workspaceId, table);
      const staffUserId = await newUser(manager, organisationId, label, 'staff', 'Staff');
      const staffProfileId = await one(manager, `INSERT INTO ${t('staff_profile')} (organisation_id, user_id, staff_ref, created_by, workspace_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
        organisationId,
        staffUserId,
        `STF-${label}-${randomUUID().slice(0, 8)}`,
        managerUserId,
        workspaceId,
      ]);
      const venueId = await one(manager, `INSERT INTO ${t('venue')} (organisation_id, name, created_by, workspace_id) VALUES ($1, $2, $3, $4) RETURNING id`, [
        organisationId,
        `${label} Venue`,
        managerUserId,
        workspaceId,
      ]);
      const jobRoleId = await one(manager, `INSERT INTO ${t('job_role')} (organisation_id, name, default_rate_pence, created_by, workspace_id) VALUES ($1, $2, 1500, $3, $4) RETURNING id`, [
        organisationId,
        `${label} Role ${randomUUID().slice(0, 6)}`,
        managerUserId,
        workspaceId,
      ]);
      const shiftId = await one(
        manager,
        `INSERT INTO ${t('shift')} (organisation_id, venue_id, job_role_id, starts_at, ends_at, break_minutes, required_count, pay_rate_pence, status, created_by, workspace_id)
         VALUES ($1, $2, $3, now() + interval '2 days', now() + interval '2 days 8 hours', 0, 1, 1500, 'open', $4, $5) RETURNING id`,
        [organisationId, venueId, jobRoleId, managerUserId, workspaceId],
      );
      const shiftAssignmentId = await one(
        manager,
        `INSERT INTO ${t('shift_assignment')} (organisation_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, assigned_by, confirmed_at, period, workspace_id)
         VALUES ($1, $2, $3, 'confirmed', 1500, $4, now(), tstzrange(now() + interval '2 days', now() + interval '2 days 8 hours'), $5) RETURNING id`,
        [organisationId, shiftId, staffProfileId, managerUserId, workspaceId],
      );
      const jobOfferId = await one(
        manager,
        `INSERT INTO ${t('job_offer')} (organisation_id, shift_assignment_id, staff_profile_id, status, sent_at, expires_at, estimated_pay_pence, created_by, workspace_id)
         VALUES ($1, $2, $3, 'manager_confirmed', now(), now() + interval '1 hour', 12000, $4, $5) RETURNING id`,
        [organisationId, shiftAssignmentId, staffProfileId, managerUserId, workspaceId],
      );
      const attendanceId = await one(
        manager,
        `INSERT INTO ${t('attendance')} (organisation_id, shift_assignment_id, shift_id, staff_profile_id, workspace_id, clock_in_at, status)
         VALUES ($1, $2, $3, $4, $5, now(), 'clocked_in') RETURNING id`,
        [organisationId, shiftAssignmentId, shiftId, staffProfileId, workspaceId],
      );
      const shiftReportId = await one(manager, `INSERT INTO ${t('shift_report')} (organisation_id, workspace_id, shift_id, status) VALUES ($1, $2, $3, 'ready') RETURNING id`, [
        organisationId,
        workspaceId,
        shiftId,
      ]);
      const attendanceCorrectionId = await one(
        manager,
        `INSERT INTO ${t('attendance_correction')} (organisation_id, workspace_id, attendance_id, field, old_value, new_value, reason, corrected_by)
         VALUES ($1, $2, $3, 'breakMinutes', '0', '30', $4, $5) RETURNING id`,
        [organisationId, workspaceId, attendanceId, `${label} correction for the activated RLS attack fixture`, managerUserId],
      );
      // manager_venue: a Venue Manager assigned INTO this workspace's venue (its own isolation surface).
      const vmUserId = await newUser(manager, organisationId, label, 'venue_manager', 'Venue Manager');
      const vmProfileId = await one(manager, `INSERT INTO core.manager_profile (organisation_id, user_id, type, workspace_id) VALUES ($1, $2, $3, $4) RETURNING id`, [
        organisationId,
        vmUserId,
        ManagerType.VENUE,
        workspaceId,
      ]);
      await manager.query(`INSERT INTO ${t('manager_venue')} (organisation_id, manager_profile_id, venue_id, workspace_id) VALUES ($1, $2, $3, $4)`, [
        organisationId,
        vmProfileId,
        venueId,
        workspaceId,
      ]);
      return { staffProfileId, venueId, jobRoleId, shiftId, shiftAssignmentId, jobOfferId, attendanceId, shiftReportId, attendanceCorrectionId, vmProfileId };
    });
    return { workspaceId, managerUserId, ...ids };
  }

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      url: process.env.DATABASE_URL,
      schema: 'core',
      synchronize: false,
      entities: [Organisation, Role, User, UserRole, ManagerProfile, ManagerWorkspace, StaffProfile, Venue, JobRole, Shift, ShiftAssignment, JobOffer, Attendance, ShiftReport, AttendanceCorrection],
    });
    await dataSource.initialize();
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    passwordHashing = new PasswordHashingService();
    // The state under test: the cutover is active on this database.
    expect(((await adminDataSource.query('SELECT count(*)::int AS n FROM core.hws_cutover_activation')) as Array<{ n: number }>)[0]!.n).toBe(1);
  });

  afterAll(async () => {
    await dataSource.destroy();
    await adminDataSource.destroy();
  });

  it('two Managers sharing one organisation_id are isolated across their workspace schemas, in both directions, without relying on created_by; no workspace bound sees neither', async () => {
    const orgInsert = await adminDataSource.manager.insert(Organisation, { name: `attack-act-${randomUUID()}`, slug: `attack-act-${randomUUID()}` });
    const organisationId = orgInsert.identifiers[0]!.id as string;
    const a = await seedActivated(organisationId, 'wsaa');
    const b = await seedActivated(organisationId, 'wsab');

    type Row = { id: string };
    const surfaces: Array<{ table: string; idCol: string; aId: string; bId: string }> = [
      { table: 'staff_profile', idCol: 'id', aId: a.staffProfileId, bId: b.staffProfileId },
      { table: 'venue', idCol: 'id', aId: a.venueId, bId: b.venueId },
      { table: 'job_role', idCol: 'id', aId: a.jobRoleId, bId: b.jobRoleId },
      { table: 'shift', idCol: 'id', aId: a.shiftId, bId: b.shiftId },
      { table: 'shift_assignment', idCol: 'id', aId: a.shiftAssignmentId, bId: b.shiftAssignmentId },
      { table: 'job_offer', idCol: 'id', aId: a.jobOfferId, bId: b.jobOfferId },
      { table: 'attendance', idCol: 'id', aId: a.attendanceId, bId: b.attendanceId },
      { table: 'shift_report', idCol: 'id', aId: a.shiftReportId, bId: b.shiftReportId },
      { table: 'attendance_correction', idCol: 'id', aId: a.attendanceCorrectionId, bId: b.attendanceCorrectionId },
      { table: 'manager_venue', idCol: 'manager_profile_id', aId: a.vmProfileId, bId: b.vmProfileId },
    ];
    const read = (ctx: { workspaceId: string | null; userId: string }, schemaOf: string, s: (typeof surfaces)[number]) =>
      withContext({ organisationId, ...ctx }, async (m) =>
        ((await m.query(`SELECT ${s.idCol} AS id FROM ${businessTable(schemaOf, s.table)} WHERE organisation_id = $1`, [organisationId])) as Row[]).map((r) => r.id),
      );
    for (const s of surfaces) {
      const ctxA = { workspaceId: a.workspaceId, userId: a.managerUserId };
      const ctxB = { workspaceId: b.workspaceId, userId: b.managerUserId };
      const none = { workspaceId: null, userId: randomUUID() };
      // A, in its own schema: its row. A, reading B's schema: nothing.
      expect([s.table, await read(ctxA, a.workspaceId, s)]).toEqual([s.table, expect.arrayContaining([s.aId])]);
      expect([s.table, await read(ctxA, b.workspaceId, s)]).toEqual([s.table, []]);
      // The reverse direction.
      expect([s.table, await read(ctxB, b.workspaceId, s)]).toEqual([s.table, expect.arrayContaining([s.bId])]);
      expect([s.table, await read(ctxB, a.workspaceId, s)]).toEqual([s.table, []]);
      // Fail closed: no workspace bound sees neither schema's row.
      expect([s.table, await read(none, a.workspaceId, s)]).toEqual([s.table, []]);
      expect([s.table, await read(none, b.workspaceId, s)]).toEqual([s.table, []]);
    }
    // Writes across the schema boundary: bound to A, B's schema takes no row and changes no row.
    const bVenue = businessTable(b.workspaceId, 'venue');
    const asA = <T>(fn: (m: DataSource['manager']) => Promise<T>) => withContext({ organisationId, workspaceId: a.workspaceId, userId: a.managerUserId }, fn);
    await expect(
      asA((m) => m.query(`INSERT INTO ${bVenue} (organisation_id, name, created_by, workspace_id) VALUES ($1, 'planted by A', $2, $3)`, [organisationId, a.managerUserId, b.workspaceId])),
    ).rejects.toMatchObject({ code: '42501' });
    const updated = await asA((m) => m.query(`UPDATE ${bVenue} SET name = 'renamed by A' WHERE id = $1 RETURNING id`, [b.venueId]));
    expect(updated).toEqual([[], 0]);
    const deleted = await asA((m) => m.query(`DELETE FROM ${bVenue} WHERE id = $1 RETURNING id`, [b.venueId]));
    expect(deleted).toEqual([[], 0]);
    const bRow = (await adminDataSource.query(`SELECT name FROM ${bVenue} WHERE id = $1`, [b.venueId])) as Array<{ name: string }>;
    expect(bRow).toEqual([{ name: 'wsab Venue' }]);
    expect(((await adminDataSource.query(`SELECT count(*)::int AS n FROM ${bVenue} WHERE name = 'planted by A'`)) as Array<{ n: number }>)[0]!.n).toBe(0);
  }, 60_000);
});
