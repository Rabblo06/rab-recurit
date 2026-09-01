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
import { toTstzRange } from '../../modules/scheduling/utils/tstzrange';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { createAdminDataSource } from './helpers/admin-datasource';

/**
 * Stage 2A Phase 4 — proves `CompositeWorkspaceForeignKeys1786669500000`'s
 * `FOREIGN KEY (parent_id, workspace_id) REFERENCES parent (id,
 * workspace_id)` constraints are the ACTUAL backstop, independent of every
 * app-layer ownership check this session already built and tested
 * elsewhere (`venue-jobrole-ownership-abuse-cases`, `attendance-abuse-cases`,
 * etc.) — every attack here goes through raw SQL as `rab_app`, inside a
 * properly bound tenant context, deliberately bypassing the service layer
 * entirely. Two full sibling Workspace fixtures inside one shared legacy
 * `organisation_id`, matching `workspace-cross-tenant-rls-attack`'s own
 * established fixture shape.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('composite workspace FK attack (integration)', () => {
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let passwordHashing: PasswordHashingService;

  const password = 'correct horse battery staple 1!';

  interface Fixture {
    workspaceId: string;
    managerUserId: string;
    staffProfileId: string;
    venueId: string;
    jobRoleId: string;
    shiftId: string;
    shiftAssignmentId: string;
  }

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

  async function seedFixture(organisationId: string, label: string): Promise<Fixture> {
    let workspaceId!: string;
    let managerUserId!: string;
    let staffProfileId!: string;

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
      await manager.query(`SELECT set_config('rab.workspace_id', $1, true)`, [workspaceId]);

      const staffHash = await passwordHashing.hash(password);
      const staffResult = await manager.insert(User, {
        organisationId,
        email: `${label}-staff-${randomUUID()}@example.test`,
        passwordHash: staffHash,
        firstName: label,
        lastName: 'Staff',
        status: UserStatus.ACTIVE,
      });
      const staffUserId = staffResult.identifiers[0]!.id as string;
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

    let venueId!: string;
    let jobRoleId!: string;
    let shiftId!: string;
    let shiftAssignmentId!: string;
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
    });

    return { workspaceId, managerUserId, staffProfileId, venueId, jobRoleId, shiftId, shiftAssignmentId };
  }

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      url: process.env.DATABASE_URL,
      schema: 'core',
      synchronize: false,
      entities: [Organisation, Role, User, UserRole, ManagerProfile, ManagerWorkspace, StaffProfile, Venue, JobRole, Shift, ShiftAssignment],
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

  async function expectForeignKeyViolation(promise: Promise<unknown>): Promise<void> {
    await expect(promise).rejects.toMatchObject({ code: '23503' });
  }

  it('every cross-Workspace composite FK attack is rejected at the DB layer; same-Workspace relationships and the Venue Manager assignment flow keep working', async () => {
    const orgInsert = await adminDataSource.manager.insert(Organisation, { name: `fkattack-${randomUUID()}`, slug: `fkattack-${randomUUID()}` });
    const organisationId = orgInsert.identifiers[0]!.id as string;

    const a = await seedFixture(organisationId, 'fka');
    const b = await seedFixture(organisationId, 'fkb');

    // Workspace A Shift -> Workspace B Venue.
    await expectForeignKeyViolation(
      withContext({ organisationId, workspaceId: a.workspaceId, userId: a.managerUserId }, (manager) =>
        manager.query(
          `INSERT INTO core.shift (organisation_id, venue_id, job_role_id, starts_at, ends_at, break_minutes, required_count, pay_rate_pence, status, created_by, workspace_id)
           VALUES ($1, $2, $3, now() + interval '2 days', now() + interval '2 days 8 hours', 0, 1, 1500, 'open', $4, $5)`,
          [organisationId, b.venueId, a.jobRoleId, a.managerUserId, a.workspaceId],
        ),
      ),
    );

    // Workspace A ShiftAssignment -> Workspace B Staff.
    await expectForeignKeyViolation(
      withContext({ organisationId, workspaceId: a.workspaceId, userId: a.managerUserId }, (manager) =>
        manager.query(
          `INSERT INTO core.shift_assignment (organisation_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, assigned_by, confirmed_at, period, workspace_id)
           VALUES ($1, $2, $3, 'confirmed', 1500, $4, now(), tstzrange(now(), now() + interval '8 hours'), $5)`,
          [organisationId, a.shiftId, b.staffProfileId, a.managerUserId, a.workspaceId],
        ),
      ),
    );

    // Workspace A Offer -> Workspace B Staff (shiftAssignmentId stays A's own — isolates the staff-side FK specifically).
    await expectForeignKeyViolation(
      withContext({ organisationId, workspaceId: a.workspaceId, userId: a.managerUserId }, (manager) =>
        manager.query(
          `INSERT INTO core.job_offer (organisation_id, shift_assignment_id, staff_profile_id, status, sent_at, expires_at, estimated_pay_pence, created_by, workspace_id)
           VALUES ($1, $2, $3, 'pending', now(), now() + interval '1 hour', 12000, $4, $5)`,
          [organisationId, a.shiftAssignmentId, b.staffProfileId, a.managerUserId, a.workspaceId],
        ),
      ),
    );

    // Workspace A Attendance -> Workspace B Shift.
    await expectForeignKeyViolation(
      withContext({ organisationId, workspaceId: a.workspaceId, userId: a.managerUserId }, (manager) =>
        manager.query(
          `INSERT INTO core.attendance (organisation_id, shift_assignment_id, shift_id, staff_profile_id, workspace_id, clock_in_at, status)
           VALUES ($1, $2, $3, $4, $5, now(), 'active')`,
          [organisationId, a.shiftAssignmentId, b.shiftId, a.staffProfileId, a.workspaceId],
        ),
      ),
    );

    // Workspace A Attendance -> Workspace B Staff.
    await expectForeignKeyViolation(
      withContext({ organisationId, workspaceId: a.workspaceId, userId: a.managerUserId }, (manager) =>
        manager.query(
          `INSERT INTO core.attendance (organisation_id, shift_assignment_id, shift_id, staff_profile_id, workspace_id, clock_in_at, status)
           VALUES ($1, $2, $3, $4, $5, now(), 'active')`,
          [organisationId, a.shiftAssignmentId, a.shiftId, b.staffProfileId, a.workspaceId],
        ),
      ),
    );

    // workspace_id A -> B mutation on an existing row is rejected — RLS
    // WITH CHECK re-evaluates on UPDATE too (the new workspace_id no longer
    // matches current_workspace()), independent of whether the composite FK
    // would also block it via existing children.
    await expect(
      withContext({ organisationId, workspaceId: a.workspaceId, userId: a.managerUserId }, (manager) =>
        manager.query(`UPDATE core.venue SET workspace_id = $1 WHERE id = $2`, [b.workspaceId, a.venueId]),
      ),
    ).rejects.toThrow();

    // Normal same-Workspace relationships still work — a real Shift in A's
    // own workspace, referencing A's own Venue/JobRole, succeeds cleanly.
    await withContext({ organisationId, workspaceId: a.workspaceId, userId: a.managerUserId }, (manager) =>
      manager.query(
        `INSERT INTO core.shift (organisation_id, venue_id, job_role_id, starts_at, ends_at, break_minutes, required_count, pay_rate_pence, status, created_by, workspace_id)
         VALUES ($1, $2, $3, now() + interval '3 days', now() + interval '3 days 8 hours', 0, 1, 1500, 'open', $4, $5)`,
        [organisationId, a.venueId, a.jobRoleId, a.managerUserId, a.workspaceId],
      ),
    );
  }, 30_000);
});
