import 'reflect-metadata';
import { ManagerType, ShiftAssignmentStatus, UserStatus } from '@rab/shared';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { Organisation, Role, User, UserRole } from '@rab/server/modules/identity/entities/index';
import { ManagerProfile } from '@rab/server/modules/manager/entities/manager-profile.entity';
import { ManagerWorkspace } from '@rab/server/modules/manager-workspace/entities/manager-workspace.entity';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { JobRole } from '@rab/server/modules/scheduling/entities/job-role.entity';
import { Shift } from '@rab/server/modules/scheduling/entities/shift.entity';
import { ShiftAssignment } from '@rab/server/modules/scheduling/entities/shift-assignment.entity';
import { toTstzRange } from '@rab/server/modules/scheduling/utils/tstzrange';
import { StaffProfile } from '@rab/server/modules/staff/entities/staff-profile.entity';
import { Venue } from '@rab/server/modules/venue/entities/venue.entity';
import { runShiftMonitorCycle } from '../../queues/rab-shifts/shift-monitor.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { generateFixturePassword } from './helpers/fixture-password';

const FIXTURE_PASSWORD = generateFixturePassword();

/**
 * Owner rule 2026-10-21: missing attendance is NOT a confirmed no-show. The shift monitor may only FLAG a provisional
 * no-show (`shift_assignment.status = 'no_show'`, `attendance_reviewed_at` NULL); it never confirms, reviews or
 * finalises, and it never overrides a manager's action — including one committed while the worker is mid-cycle (it
 * takes the assignment row lock and compare-and-sets). Real Postgres, RLS on; fixture shape from
 * worker-event-idempotency.integration.spec.ts.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(90_000);

describeIfDb('provisional no-show (shift monitor) never overrides a manager (integration)', () => {
  let app: import('@nestjs/common').INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;
  let auditService: AuditService;
  let notificationService: NotificationService;

  interface Fx { organisationId: string; workspaceId: string; managerUserId: string; staffProfileId: string; venueId: string; jobRoleId: string }

  async function withContext<T>(fx: { organisationId: string; workspaceId: string | null; managerUserId: string }, fn: (m: DataSource['manager']) => Promise<T>): Promise<T> {
    return dataSource.transaction(async (m) => {
      await m.query(`SELECT set_config('search_path', 'core', true)`);
      await m.query(`SELECT set_config('rab.organisation_id', $1, true)`, [fx.organisationId]);
      await m.query(`SELECT set_config('rab.workspace_id', $1, true)`, [fx.workspaceId ?? '']);
      await m.query(`SELECT set_config('rab.user_id', $1, true)`, [fx.managerUserId]);
      await m.query(`SELECT set_config('rab.role', '', true)`);
      return fn(m);
    });
  }

  async function seed(label: string): Promise<Fx> {
    const organisationId = (await adminDataSource.manager.insert(Organisation, { name: `${label}-${randomUUID()}`, slug: `${label}-${randomUUID()}` })).identifiers[0]!.id as string;
    const out = { organisationId } as Fx;
    await withContext({ organisationId, workspaceId: null, managerUserId: randomUUID() }, async (m) => {
      const roleId = (await m.insert(Role, { organisationId, key: 'manager', name: 'Manager', isSystem: true })).identifiers[0]!.id as string;
      const hash = await passwordHashing.hash(FIXTURE_PASSWORD);
      out.managerUserId = (await m.insert(User, { organisationId, email: `${label}-mgr-${randomUUID()}@example.test`, passwordHash: hash, firstName: label, lastName: 'Manager', status: UserStatus.ACTIVE })).identifiers[0]!.id as string;
      await m.insert(UserRole, { userId: out.managerUserId, roleId, organisationId });
      await m.query(`SELECT set_config('rab.user_id', $1, true)`, [out.managerUserId]);
      const ws = await m.save(ManagerWorkspace, { organisationId, ownerUserId: out.managerUserId, name: `${label} WS ${out.managerUserId}`, subdomain: `${label}-${out.managerUserId.slice(0, 8)}`, status: 'active' });
      out.workspaceId = ws.id;
      await m.query(`SELECT set_config('rab.workspace_id', $1, true)`, [ws.id]);
      await m.insert(ManagerProfile, { organisationId, userId: out.managerUserId, type: ManagerType.INTERNAL, workspaceId: ws.id });
      const staffRoleId = (await m.insert(Role, { organisationId, key: 'staff', name: 'Staff', isSystem: true })).identifiers[0]!.id as string;
      const staffUserId = (await m.insert(User, { organisationId, email: `${label}-staff-${randomUUID()}@example.test`, passwordHash: hash, firstName: label, lastName: 'Staff', status: UserStatus.ACTIVE })).identifiers[0]!.id as string;
      await m.insert(UserRole, { userId: staffUserId, roleId: staffRoleId, organisationId });
      out.staffProfileId = (await m.save(StaffProfile, { organisationId, userId: staffUserId, staffRef: `STF-${randomUUID().slice(0, 8)}`, createdBy: out.managerUserId, workspaceId: ws.id })).id;
      out.venueId = (await m.save(Venue, { organisationId, name: `${label} Venue`, createdBy: out.managerUserId, workspaceId: ws.id })).id;
      out.jobRoleId = (await m.save(JobRole, { organisationId, name: `${label} Role ${randomUUID().slice(0, 6)}`, defaultRatePence: 1500, createdBy: out.managerUserId, workspaceId: ws.id })).id;
    });
    return out;
  }

  /** A confirmed seat on a shift that started 45 minutes ago (past the 30-minute grace). */
  async function overdueSeat(fx: Fx, hoursEarlier = 0): Promise<{ shiftId: string; assignmentId: string }> {
    const startsAt = new Date(Date.now() - 45 * 60_000 - hoursEarlier * 3_600_000);
    const endsAt = new Date(startsAt.getTime() + 8 * 3_600_000);
    return withContext(fx, async (m) => {
      const shift = await m.save(Shift, {
        organisationId: fx.organisationId, venueId: fx.venueId, jobRoleId: fx.jobRoleId, startsAt, endsAt, breakMinutes: 0, requiredCount: 1,
        payRatePence: 1500, status: 'confirmed', createdBy: fx.managerUserId, workspaceId: fx.workspaceId,
      });
      const assignment = await m.save(ShiftAssignment, {
        organisationId: fx.organisationId, shiftId: shift.id, staffProfileId: fx.staffProfileId, status: ShiftAssignmentStatus.CONFIRMED,
        payRateSnapshotPence: 1500, assignedBy: fx.managerUserId, confirmedAt: new Date(), period: toTstzRange(startsAt, endsAt), workspaceId: fx.workspaceId,
      });
      return { shiftId: shift.id, assignmentId: assignment.id };
    });
  }

  /** Exactly what `AttendanceService.recordAttendance` commits for a seat with no attendance (row + assignment completed). */
  const managerRecordSql = `
    INSERT INTO attendance (organisation_id, workspace_id, shift_assignment_id, shift_id, staff_profile_id, clock_in_at, clock_out_at, status, worked_minutes, earned_pence, clock_out_method)
    SELECT sa.organisation_id, sa.workspace_id, sa.id, sa.shift_id, sa.staff_profile_id, now() - interval '40 minutes', now() - interval '1 minute', 'under_review', 39, 975, 'manager_correction'
      FROM shift_assignment sa WHERE sa.id = $1`;

  const seatOf = (fx: Fx, assignmentId: string) => withContext(fx, async (m) =>
    (await m.query(`SELECT status, attendance_reviewed_at FROM shift_assignment WHERE id = $1`, [assignmentId]))[0] as { status: string; attendance_reviewed_at: Date | null });
  const noShowAudits = (fx: Fx, assignmentId: string) => withContext(fx, async (m) =>
    m.query(`SELECT metadata FROM core.audit_log WHERE action = 'shift_assignment.no_show' AND metadata->>'assignmentId' = $1`, [assignmentId]) as Promise<Array<{ metadata: Record<string, unknown> }>>);
  const eventStatus = (fx: Fx, assignmentId: string) => withContext(fx, async (m) =>
    ((await m.query(`SELECT status FROM core.worker_event WHERE event_key = $1`, [`no-show:${assignmentId}`]))[0]?.status ?? null) as string | null);
  const cycle = () => runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 0);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
    passwordHashing = app.get(PasswordHashingService);
    tenantContext = app.get(TenantContextService);
    auditService = app.get(AuditService);
    notificationService = app.get(NotificationService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  it('flags a PROVISIONAL no-show only: no review, no attendance, no report finalisation; retries change nothing', async () => {
    const fx = await seed('provisional');
    const { shiftId, assignmentId } = await overdueSeat(fx);
    await cycle();
    expect(await seatOf(fx, assignmentId)).toEqual({ status: 'no_show', attendance_reviewed_at: null });
    const audits = await noShowAudits(fx, assignmentId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({ provisional: true });
    await withContext(fx, async (m) => {
      expect(await m.query(`SELECT 1 FROM attendance WHERE shift_assignment_id = $1`, [assignmentId])).toHaveLength(0);
      expect(await m.query(`SELECT 1 FROM shift_report WHERE shift_id = $1 AND status = 'finalised'`, [shiftId])).toHaveLength(0);
      const [n] = await m.query(`SELECT message FROM notification WHERE related_entity_id = $1 AND type = 'shift_assignment_no_show'`, [assignmentId]);
      expect(n.message).toContain('Record their attendance or confirm the no-show');
    });
    await cycle();
    await cycle();
    expect(await noShowAudits(fx, assignmentId)).toHaveLength(1);
    expect(await seatOf(fx, assignmentId)).toEqual({ status: 'no_show', attendance_reviewed_at: null });
  });

  it('does nothing to a seat a manager already acted on (recorded attendance, or confirmed then reopened no-show)', async () => {
    const fx = await seed('manageracted');
    const recorded = await overdueSeat(fx);
    await withContext(fx, async (m) => {
      await m.query(managerRecordSql, [recorded.assignmentId]);
      await m.query(`UPDATE shift_assignment SET status = 'completed' WHERE id = $1`, [recorded.assignmentId]);
    });
    const confirmed = await overdueSeat(fx, 10); // same staff member: a non-overlapping earlier shift
    await withContext(fx, (m) => m.query(`UPDATE shift_assignment SET status = 'no_show', attendance_reviewed_at = now(), attendance_reviewed_by = $2 WHERE id = $1`, [confirmed.assignmentId, fx.managerUserId]));
    await cycle();
    await cycle();
    expect((await seatOf(fx, recorded.assignmentId)).status).toBe('completed');
    expect(await noShowAudits(fx, recorded.assignmentId)).toHaveLength(0);
    const conf = await seatOf(fx, confirmed.assignmentId);
    expect(conf.status).toBe('no_show');
    expect(conf.attendance_reviewed_at).not.toBeNull(); // the manager's confirmation is untouched
    expect(await noShowAudits(fx, confirmed.assignmentId)).toHaveLength(0);
    // Reopened by the manager (back to provisional): still not re-flagged or re-audited by later cycles.
    await withContext(fx, (m) => m.query(`UPDATE shift_assignment SET attendance_reviewed_at = NULL, attendance_reviewed_by = NULL WHERE id = $1`, [confirmed.assignmentId]));
    await cycle();
    expect(await noShowAudits(fx, confirmed.assignmentId)).toHaveLength(0);
  });

  it('race: a manager recording attendance while the worker is mid-cycle wins — the worker waits on the row lock, re-reads and cancels', async () => {
    const fx = await seed('workerrace');
    const { assignmentId } = await overdueSeat(fx);
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    let workerDone = false;
    let cyclePromise: Promise<unknown> | null = null;
    try {
      await runner.query(`SELECT set_config('search_path', 'core', true)`);
      await runner.query(`SELECT set_config('rab.organisation_id', $1, true)`, [fx.organisationId]);
      await runner.query(`SELECT set_config('rab.workspace_id', $1, true)`, [fx.workspaceId]);
      await runner.query(`SELECT set_config('rab.user_id', $1, true)`, [fx.managerUserId]);
      await runner.query(`SELECT set_config('rab.role', '', true)`);
      // The manager's transaction holds the assignment lock (as recordAttendance does) before the worker reaches Pass B.
      await runner.query(`SELECT 1 FROM shift_assignment WHERE id = $1 FOR UPDATE`, [assignmentId]);
      cyclePromise = cycle().finally(() => { workerDone = true; });
      // Wait until the worker is genuinely blocked on the manager's row lock (Pass B), not merely still discovering.
      let blocked = false;
      for (let i = 0; i < 300 && !blocked && !workerDone; i++) {
        const [{ n }] = await adminDataSource.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'SELECT 1 FROM shift_assignment WHERE id = $1 FOR UPDATE%'`);
        blocked = n > 0;
        if (!blocked) await new Promise((r) => setTimeout(r, 200));
      }
      expect(blocked).toBe(true);
      expect(workerDone).toBe(false); // blocked on the manager's row lock, not deciding on stale data
      await runner.query(managerRecordSql, [assignmentId]);
      await runner.query(`UPDATE shift_assignment SET status = 'completed' WHERE id = $1`, [assignmentId]);
      await runner.commitTransaction();
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
    await cyclePromise;
    expect((await seatOf(fx, assignmentId)).status).toBe('completed');
    expect(await noShowAudits(fx, assignmentId)).toHaveLength(0);
    expect(await eventStatus(fx, assignmentId)).toBe('cancelled');
  });

  /** Exactly what `AttendanceService.checkIn` commits (server time, source, verified flag; no coordinates). */
  const checkInSql = `UPDATE shift_assignment SET checked_in_at = now() - interval '50 minutes', check_in_source = 'staff', check_in_location_verified = false WHERE id = $1 AND status = 'confirmed'`;

  it('a CHECKED-IN seat with no clock-in is never flagged as a no-show (arrival evidence); the manager decides', async () => {
    const fx = await seed('checkedin');
    const { assignmentId } = await overdueSeat(fx);
    await withContext(fx, (m) => m.query(checkInSql, [assignmentId]));
    await cycle();
    await cycle();
    expect(await seatOf(fx, assignmentId)).toEqual({ status: 'confirmed', attendance_reviewed_at: null });
    expect(await noShowAudits(fx, assignmentId)).toHaveLength(0);
  });

  it('race: a staff Check In committing while the worker is mid-cycle wins — the worker waits on the row lock, re-reads and cancels', async () => {
    const fx = await seed('checkinrace');
    const { assignmentId } = await overdueSeat(fx);
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    let workerDone = false;
    let cyclePromise: Promise<unknown> | null = null;
    try {
      await runner.query(`SELECT set_config('search_path', 'core', true)`);
      await runner.query(`SELECT set_config('rab.organisation_id', $1, true)`, [fx.organisationId]);
      await runner.query(`SELECT set_config('rab.workspace_id', $1, true)`, [fx.workspaceId]);
      await runner.query(`SELECT set_config('rab.user_id', $1, true)`, [fx.managerUserId]);
      await runner.query(`SELECT set_config('rab.role', '', true)`);
      // The staff check-in transaction holds the booking's row lock (as AttendanceService.checkIn does).
      await runner.query(`SELECT 1 FROM shift_assignment WHERE id = $1 FOR UPDATE`, [assignmentId]);
      cyclePromise = cycle().finally(() => { workerDone = true; });
      let blocked = false;
      for (let i = 0; i < 300 && !blocked && !workerDone; i++) {
        const [{ n }] = await adminDataSource.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'SELECT 1 FROM shift_assignment WHERE id = $1 FOR UPDATE%'`);
        blocked = n > 0;
        if (!blocked) await new Promise((r) => setTimeout(r, 200));
      }
      expect(blocked).toBe(true);
      expect(workerDone).toBe(false);
      await runner.query(checkInSql, [assignmentId]);
      await runner.commitTransaction();
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
    await cyclePromise;
    expect(await seatOf(fx, assignmentId)).toEqual({ status: 'confirmed', attendance_reviewed_at: null });
    expect(await noShowAudits(fx, assignmentId)).toHaveLength(0);
    expect(await eventStatus(fx, assignmentId)).toBe('cancelled');
  });
});
