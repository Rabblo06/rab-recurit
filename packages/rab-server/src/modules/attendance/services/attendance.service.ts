import {
  assertTransition,
  computeWorkedMinutes,
  payForMinutes,
  SHIFT_ASSIGNMENT_TRANSITIONS,
  SHIFT_TRANSITIONS,
  ShiftAssignmentStatus,
  ShiftStatus,
} from '@rab/shared';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';

import { Shift } from '../../scheduling/entities/shift.entity';
import { ShiftAssignment } from '../../scheduling/entities/shift-assignment.entity';
import { StaffProfile } from '../../staff/entities/staff-profile.entity';
import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { PaginationDto, paginationSkipTake } from '../../../engine/dto/pagination.dto';
import { toIlikePattern } from '../../../engine/utils/ilike-pattern.util';
import { AttendanceStatus } from '../constants/attendance-status';
import { ClockInDto } from '../dto/clock-in.dto';
import { ListAttendanceDto } from '../dto/list-attendance.dto';
import { Attendance } from '../entities/attendance.entity';

/** Same allowlist-via-lookup-map pattern as `StaffService`'s `STAFF_SORT_COLUMNS` — see that file's comment. Raw SQL column expressions, never a client-supplied string. */
const ATTENDANCE_SORT_COLUMNS: Record<string, string> = {
  clockInAt: 'a.clock_in_at',
  staff: 'u.first_name',
  venue: 'v.name',
  workedMinutes: 'a.worked_minutes',
  earnedPence: 'a.earned_pence',
};

/** Postgres SQLSTATE for a unique-constraint violation (the partial "one active attendance per staff" index). */
const POSTGRES_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION;
}

export interface AttendanceSummary {
  id: string;
  status: string;
  clockInAt: Date;
  clockOutAt: Date | null;
  workedMinutes: number | null;
  earnedPence: number | null;
  shiftId: string;
  startsAt: Date;
  endsAt: Date;
  venueName: string;
  roleName: string;
  staffProfileId: string;
  staffName: string;
}

const ATTENDANCE_SUMMARY_SELECT = `
  SELECT
    a.id, a.status, a.clock_in_at, a.clock_out_at, a.worked_minutes, a.earned_pence,
    s.id AS shift_id, s.starts_at, s.ends_at,
    v.name AS venue_name, jr.name AS role_name,
    sp.id AS staff_profile_id, u.first_name, u.last_name
  FROM core.attendance a
  JOIN core.shift s ON s.id = a.shift_id
  JOIN core.venue v ON v.id = s.venue_id
  JOIN core.job_role jr ON jr.id = s.job_role_id
  JOIN core.staff_profile sp ON sp.id = a.staff_profile_id
  JOIN core."user" u ON u.id = sp.user_id
`;

function toAttendanceSummary(r: Record<string, unknown>): AttendanceSummary {
  return {
    id: r.id as string,
    status: r.status as string,
    clockInAt: r.clock_in_at as Date,
    clockOutAt: (r.clock_out_at as Date) ?? null,
    workedMinutes: r.worked_minutes === null || r.worked_minutes === undefined ? null : Number(r.worked_minutes),
    earnedPence: r.earned_pence === null || r.earned_pence === undefined ? null : Number(r.earned_pence),
    shiftId: r.shift_id as string,
    startsAt: r.starts_at as Date,
    endsAt: r.ends_at as Date,
    venueName: r.venue_name as string,
    roleName: r.role_name as string,
    staffProfileId: r.staff_profile_id as string,
    staffName: `${r.first_name} ${r.last_name}`,
  };
}

/**
 * Real Clock In/Out — every timestamp is server-authoritative (`now()` at
 * the moment the request is processed), never accepted from the client.
 * `staffProfileId` is always resolved from `ctx.userId` (the verified JWT),
 * never a client-supplied id — a Staff account can only ever act on its own
 * `StaffProfile`, so Staff A structurally cannot clock into or read Staff
 * B's attendance, even by guessing an id (rab-workforce-architecture.md §5.2).
 */
@Injectable()
export class AttendanceService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly auditService: AuditService,
    private readonly resourceScope: ResourceScopeService,
  ) {}

  private async ownStaffProfile(manager: EntityManager, ctx: AuthContext): Promise<StaffProfile> {
    const staffProfile = await manager.findOne(StaffProfile, { where: { userId: ctx.userId } });
    if (!staffProfile) throw new NotFoundException('Staff profile not found.');
    return staffProfile;
  }

  private async loadSummary(manager: EntityManager, attendanceId: string): Promise<AttendanceSummary> {
    const rows = await manager.query(`${ATTENDANCE_SUMMARY_SELECT} WHERE a.id = $1`, [attendanceId]);
    return toAttendanceSummary(rows[0] as Record<string, unknown>);
  }

  /**
   * Validates, in order: caller is Staff with a profile; the shift is
   * actually assigned+confirmed for THIS staff profile (never a client-
   * supplied staffId — see class doc comment); the shift itself isn't
   * cancelled/already completed; no other active attendance exists for this
   * staff (the partial unique index `attendance_one_active_per_staff` is
   * the real backstop for two simultaneous clock-in requests — this method
   * never depends on a bare SELECT-then-INSERT alone).
   */
  async clockIn(ctx: AuthContext, dto: ClockInDto): Promise<AttendanceSummary> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const staffProfile = await this.ownStaffProfile(manager, ctx);

      const assignment = await manager.findOne(ShiftAssignment, {
        where: { shiftId: dto.shiftId, staffProfileId: staffProfile.id },
      });
      // 404, not 403 — a shift assigned to a different staff member must be
      // indistinguishable from a shift that doesn't exist at all.
      if (!assignment) throw new NotFoundException('Shift not found.');
      if (assignment.status !== ShiftAssignmentStatus.CONFIRMED) {
        throw new ConflictException('This shift is not confirmed for you.');
      }

      const shift = await manager.findOneByOrFail(Shift, { id: assignment.shiftId });
      if (shift.status === ShiftStatus.CANCELLED || shift.status === ShiftStatus.COMPLETED) {
        throw new ConflictException('This shift is not open for attendance.');
      }

      const attendance = manager.create(Attendance, {
        organisationId: ctx.organisationId!,
        // Inherited from the parent Shift — keeps Attendance.workspaceId =
        // Shift.workspaceId (= ShiftAssignment.workspaceId) true by
        // construction.
        workspaceId: shift.workspaceId,
        shiftAssignmentId: assignment.id,
        shiftId: shift.id,
        staffProfileId: staffProfile.id,
        clockInAt: new Date(),
        status: AttendanceStatus.ACTIVE,
      });
      try {
        await manager.save(attendance);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictException('You already have an active clock-in — clock out first.');
        }
        throw error;
      }

      if (shift.status !== ShiftStatus.IN_PROGRESS) {
        assertTransition(SHIFT_TRANSITIONS, shift.status, ShiftStatus.IN_PROGRESS);
        await manager.update(Shift, shift.id, { status: ShiftStatus.IN_PROGRESS });
      }

      await this.auditService.record(manager, ctx, AuditAction.STAFF_CLOCKED_IN, {
        entityType: 'attendance',
        entityId: attendance.id,
        metadata: { shiftId: shift.id },
      });

      return this.loadSummary(manager, attendance.id);
    });
  }

  /**
   * Finds the caller's own active attendance (never a client-supplied
   * attendance id) and closes it. Worked minutes/earned pence are computed
   * once, here, from the two server timestamps via `@rab/shared`'s
   * canonical `computeWorkedMinutes`/`payForMinutes` — never trusted from
   * the client, never recalculated later. The atomic `WHERE status =
   * 'active'` claim is what makes a double clock-out a clean, safe 409
   * instead of double-processing the same row.
   */
  async clockOut(ctx: AuthContext): Promise<AttendanceSummary> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const staffProfile = await this.ownStaffProfile(manager, ctx);

      const attendance = await manager.findOne(Attendance, {
        where: { staffProfileId: staffProfile.id, status: AttendanceStatus.ACTIVE },
      });
      if (!attendance) throw new NotFoundException('No active clock-in found.');

      const assignment = await manager.findOneByOrFail(ShiftAssignment, { id: attendance.shiftAssignmentId });
      const shift = await manager.findOneByOrFail(Shift, { id: attendance.shiftId });

      const now = new Date();
      const { workedMinutes } = computeWorkedMinutes({
        clockInAt: attendance.clockInAt,
        clockOutAt: now,
        scheduledBreakMinutes: shift.breakMinutes,
      });
      const earnedPence = payForMinutes(assignment.payRateSnapshotPence, workedMinutes);

      const [, updatedCount] = (await manager.query(
        `UPDATE core.attendance SET clock_out_at = $1, status = $2, worked_minutes = $3, earned_pence = $4, updated_at = now()
           WHERE id = $5 AND status = $6`,
        [now, AttendanceStatus.COMPLETED, workedMinutes, earnedPence, attendance.id, AttendanceStatus.ACTIVE],
      )) as [unknown, number];
      if (updatedCount === 0) {
        throw new ConflictException('This attendance was already clocked out.');
      }

      assertTransition(SHIFT_ASSIGNMENT_TRANSITIONS, assignment.status, ShiftAssignmentStatus.COMPLETED);
      await manager.update(ShiftAssignment, assignment.id, { status: ShiftAssignmentStatus.COMPLETED });

      // Shift-level rollup: the shift only completes once every sibling
      // assignment has reached a terminal state — a shift with requiredCount
      // > 1 doesn't complete just because the first staff member clocked out.
      const openSiblings = await manager.count(ShiftAssignment, {
        where: {
          shiftId: shift.id,
          status: In([ShiftAssignmentStatus.OFFERED, ShiftAssignmentStatus.STAFF_ACCEPTED, ShiftAssignmentStatus.CONFIRMED]),
        },
      });
      if (openSiblings === 0 && shift.status === ShiftStatus.IN_PROGRESS) {
        assertTransition(SHIFT_TRANSITIONS, shift.status, ShiftStatus.COMPLETED);
        await manager.update(Shift, shift.id, { status: ShiftStatus.COMPLETED });
      }

      await this.auditService.record(manager, ctx, AuditAction.STAFF_CLOCKED_OUT, {
        entityType: 'attendance',
        entityId: attendance.id,
        metadata: { shiftId: shift.id, workedMinutes, earnedPence },
      });

      return this.loadSummary(manager, attendance.id);
    });
  }

  /** Staff-facing (mobile): the caller's own active attendance, or null — plus a server clock the mobile timer always re-anchors to. */
  async getActive(ctx: AuthContext): Promise<{ attendance: AttendanceSummary | null; serverNow: string }> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const serverNow = new Date().toISOString();
      const staffProfile = await manager.findOne(StaffProfile, { where: { userId: ctx.userId } });
      if (!staffProfile) return { attendance: null, serverNow };
      const attendance = await manager.findOne(Attendance, {
        where: { staffProfileId: staffProfile.id, status: AttendanceStatus.ACTIVE },
      });
      return { attendance: attendance ? await this.loadSummary(manager, attendance.id) : null, serverNow };
    });
  }

  /** Staff-facing (mobile): the caller's own completed attendance history, newest first. */
  getHistory(ctx: AuthContext, pagination: PaginationDto = {}): Promise<AttendanceSummary[]> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const staffProfile = await manager.findOne(StaffProfile, { where: { userId: ctx.userId } });
      if (!staffProfile) return [];
      const { skip, take } = paginationSkipTake(pagination);
      const rows = await manager.query(
        `${ATTENDANCE_SUMMARY_SELECT} WHERE a.staff_profile_id = $1 AND a.status = $2
           ORDER BY a.clock_in_at DESC LIMIT $3 OFFSET $4`,
        [staffProfile.id, AttendanceStatus.COMPLETED, take, skip],
      );
      return rows.map(toAttendanceSummary);
    });
  }

  /** Staff-facing: the caller's own attendance for one shift (any status), or null — "have I already clocked in for this one?" */
  async getForShift(ctx: AuthContext, shiftId: string): Promise<AttendanceSummary | null> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const staffProfile = await manager.findOne(StaffProfile, { where: { userId: ctx.userId } });
      if (!staffProfile) return null;
      const rows = await manager.query(`${ATTENDANCE_SUMMARY_SELECT} WHERE a.staff_profile_id = $1 AND a.shift_id = $2`, [
        staffProfile.id,
        shiftId,
      ]);
      return rows.length > 0 ? toAttendanceSummary(rows[0] as Record<string, unknown>) : null;
    });
  }

  /**
   * Manager-facing: the same scope every other manager-list endpoint
   * already uses (`SchedulingService.list`, `OfferService.list`) — a normal
   * Manager sees only attendance for Staff in their own private scope
   * (`staff_profile.created_by = ctx.userId`), a Venue Manager sees
   * attendance at their assigned venues. Manager A structurally cannot see
   * Manager B's Staff's attendance; cross-Manager visibility is available
   * only through the audited Admin Inspect mechanism.
   */
  list(ctx: AuthContext, dto: ListAttendanceDto = {}): Promise<{ data: AttendanceSummary[]; total: number }> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const scope = await this.resourceScope.resolveTx(manager, ctx);
      if (scope.kind === 'venue' && scope.venueIds.length === 0) return { data: [], total: 0 };

      // Existing ownership/venue-assignment scoping is the FIRST condition,
      // never replaced — every filter below is ANDed onto it, so a caller
      // can only ever narrow within their own already-authorized scope.
      // Read-only throughout — this never writes workedMinutes/earnedPence/
      // status/approval state, matching the payroll-safety invariant that
      // filtering/sorting must never be able to alter financial data.
      const conditions: string[] = [];
      const params: unknown[] = [];
      const nextParam = (value: unknown) => { params.push(value); return `$${params.length}`; };

      if (scope.kind === 'venue') {
        conditions.push(`s.venue_id = ANY(${nextParam(scope.venueIds)}::uuid[])`);
      } else {
        conditions.push(`sp.created_by = ${nextParam(ctx.userId)}`);
      }
      if (dto.q) {
        const q = nextParam(toIlikePattern(dto.q));
        conditions.push(`(u.first_name ILIKE ${q} OR u.last_name ILIKE ${q} OR v.name ILIKE ${q})`);
      }
      if (dto.status) conditions.push(`a.status = ${nextParam(dto.status)}`);
      if (dto.staffProfileId) conditions.push(`a.staff_profile_id = ${nextParam(dto.staffProfileId)}`);
      if (dto.venueId) conditions.push(`s.venue_id = ${nextParam(dto.venueId)}`);
      if (dto.clockInFrom) conditions.push(`a.clock_in_at >= ${nextParam(new Date(dto.clockInFrom))}`);
      if (dto.clockInTo) {
        const exclusive = new Date(dto.clockInTo);
        exclusive.setUTCDate(exclusive.getUTCDate() + 1);
        conditions.push(`a.clock_in_at < ${nextParam(exclusive)}`);
      }
      if (dto.workedMinutesMin !== undefined) conditions.push(`a.worked_minutes >= ${nextParam(dto.workedMinutesMin)}`);
      if (dto.workedMinutesMax !== undefined) conditions.push(`a.worked_minutes <= ${nextParam(dto.workedMinutesMax)}`);
      if (dto.earnedPenceMin !== undefined) conditions.push(`a.earned_pence >= ${nextParam(dto.earnedPenceMin)}`);
      if (dto.earnedPenceMax !== undefined) conditions.push(`a.earned_pence <= ${nextParam(dto.earnedPenceMax)}`);

      const where = `WHERE ${conditions.join(' AND ')}`;
      const sortColumn = ATTENDANCE_SORT_COLUMNS[dto.sort ?? 'clockInAt'] ?? ATTENDANCE_SORT_COLUMNS.clockInAt;
      const direction = (dto.direction ?? 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

      const [{ count }] = await manager.query(
        `SELECT count(*)::int AS count FROM core.attendance a
           JOIN core.shift s ON s.id = a.shift_id
           JOIN core.venue v ON v.id = s.venue_id
           JOIN core.job_role jr ON jr.id = s.job_role_id
           JOIN core.staff_profile sp ON sp.id = a.staff_profile_id
           JOIN core."user" u ON u.id = sp.user_id
         ${where}`,
        params,
      );

      const { skip, take } = paginationSkipTake(dto);
      const takeIdx = nextParam(take);
      const skipIdx = nextParam(skip);
      const rows = await manager.query(
        `${ATTENDANCE_SUMMARY_SELECT} ${where} ORDER BY ${sortColumn} ${direction} LIMIT ${takeIdx} OFFSET ${skipIdx}`,
        params,
      );
      return { data: rows.map(toAttendanceSummary), total: count };
    });
  }
}
