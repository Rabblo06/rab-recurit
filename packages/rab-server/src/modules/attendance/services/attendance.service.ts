import {
  assertTransition,
  ATTENDANCE_TRANSITIONS,
  AttendanceStatus,
  computeWorkedMinutes,
  haversineDistanceMeters,
  payForMinutes,
  SHIFT_ASSIGNMENT_TRANSITIONS,
  SHIFT_TRANSITIONS,
  ShiftAssignmentStatus,
  ShiftStatus,
} from '@rab/shared';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';

import { Shift } from '../../scheduling/entities/shift.entity';
import { ShiftAssignment } from '../../scheduling/entities/shift-assignment.entity';
import { StaffProfile } from '../../staff/entities/staff-profile.entity';
import { Venue } from '../../venue/entities/venue.entity';
import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { EnvironmentService } from '../../../engine/core-modules/environment/environment.service';
import { ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { PaginationDto, paginationSkipTake } from '../../../engine/dto/pagination.dto';
import { toIlikePattern } from '../../../engine/utils/ilike-pattern.util';
import { AttendanceLocationDto } from '../dto/attendance-location.dto';
import { ClockInDto } from '../dto/clock-in.dto';
import { ClockOutDto } from '../dto/clock-out.dto';
import { CorrectAttendanceDto } from '../dto/correct-attendance.dto';
import { GeofenceExitDto } from '../dto/geofence-exit.dto';
import { ListAttendanceDto } from '../dto/list-attendance.dto';
import { Attendance } from '../entities/attendance.entity';
import { AttendanceCorrection } from '../entities/attendance-correction.entity';
import {
  ClockInTooEarlyException,
  ClockWindowClosedException,
  LocationAccuracyTooLowException,
  LocationRequiredException,
  OutsideVenueException,
} from '../exceptions/attendance.exceptions';
import { AttendanceQrService } from './attendance-qr.service';

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
  breakMinutes: number | null;
  locationVerified: boolean;
  clockOutMethod: string | null;
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
    a.break_minutes, a.location_verified, a.clock_out_method,
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
    breakMinutes: r.break_minutes === null || r.break_minutes === undefined ? null : Number(r.break_minutes),
    locationVerified: Boolean(r.location_verified),
    clockOutMethod: (r.clock_out_method as string) ?? null,
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
  private readonly logger = new Logger(AttendanceService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly auditService: AuditService,
    private readonly resourceScope: ResourceScopeService,
    private readonly env: EnvironmentService,
    private readonly attendanceQr: AttendanceQrService,
  ) {}

  /**
   * Server-authoritative clock-in/out window: `[shift.startsAt -
   * CLOCK_IN_EARLY_MINUTES, shift.endsAt + QR_POST_SHIFT_GRACE_MINUTES]`.
   * Pure UTC delta arithmetic against `timestamptz` columns — correctly
   * handles overnight shifts and DST for free, since neither `Shift` nor
   * `Venue` carries (or needs) a timezone column (confirmed: none exists).
   * Throws the structured `ClockInTooEarlyException`/`ClockWindowClosedException`
   * — never a generic message the client can't branch on.
   */
  private assertClockWindow(shift: Shift): void {
    const now = Date.now();
    const earliestClockIn = shift.startsAt.getTime() - this.env.get('CLOCK_IN_EARLY_MINUTES') * 60_000;
    const latestClockOut = shift.endsAt.getTime() + this.env.get('QR_POST_SHIFT_GRACE_MINUTES') * 60_000;
    if (now < earliestClockIn) {
      throw new ClockInTooEarlyException(shift.startsAt.toISOString(), new Date(earliestClockIn).toISOString());
    }
    if (now > latestClockOut) {
      throw new ClockWindowClosedException();
    }
  }

  /**
   * Reused identically by `clockIn`, `clockOut`, and
   * `autoClockOutOnGeofenceExit` — Venue coordinates/radius are
   * server-controlled data (`Venue.lat`/`lng`/`geofenceRadiusM`, set only by
   * an Internal Manager via the Venue form); the device's own reported
   * location is never trusted for venue identity, only compared against it.
   * Returns whether the check actually ran and passed — `false` both when
   * geofencing isn't enforced at this venue AND when the venue is
   * misconfigured (flag on, no coordinates set) — `locationVerified` must
   * never claim a check that didn't genuinely happen.
   */
  private enforceGeofence(venue: Venue, dto: AttendanceLocationDto): { verified: boolean } {
    if (!venue.enforceGeofence) return { verified: false };
    if (venue.lat == null || venue.lng == null) {
      // Operator misconfiguration (flag on, no coordinates) — fail soft, not
      // a 500; the flag being on with nothing to check against is not the
      // requester's fault.
      this.logger.warn(`Venue ${venue.id} has enforceGeofence=true but no lat/lng set — skipping geofence check.`);
      return { verified: false };
    }
    if (dto.lat == null || dto.lng == null) {
      throw new LocationRequiredException();
    }
    const maxAccuracy = this.env.get('GEOFENCE_MAX_ACCURACY_M');
    if (dto.accuracyM != null && dto.accuracyM > maxAccuracy) {
      throw new LocationAccuracyTooLowException();
    }
    const distance = haversineDistanceMeters({ lat: dto.lat, lng: dto.lng }, { lat: venue.lat, lng: venue.lng });
    if (distance > venue.geofenceRadiusM) {
      throw new OutsideVenueException(venue.name);
    }
    return { verified: true };
  }

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
      this.assertClockWindow(shift);

      // Strictly additional to the ShiftAssignment/status checks above — a
      // cryptographically valid QR never substitutes for them (Part 54).
      await this.attendanceQr.validateQr(manager, shift.id, dto.qrToken);

      const venue = await manager.findOneByOrFail(Venue, { id: shift.venueId });
      const { verified: locationVerified } = this.enforceGeofence(venue, dto);

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
        status: AttendanceStatus.CLOCKED_IN,
        clockInLat: dto.lat,
        clockInLng: dto.lng,
        clockInAccuracyM: dto.accuracyM,
        locationVerified,
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
   * attendance id), validates the same Shift QR used at clock-in and the
   * same venue geofence, and closes it via the shared `performClockOut`.
   */
  async clockOut(ctx: AuthContext, dto: ClockOutDto): Promise<AttendanceSummary> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const staffProfile = await this.ownStaffProfile(manager, ctx);

      const attendance = await manager.findOne(Attendance, {
        where: { staffProfileId: staffProfile.id, status: In([AttendanceStatus.CLOCKED_IN, AttendanceStatus.ON_BREAK]) },
      });
      if (!attendance) throw new NotFoundException('No active clock-in found.');

      const shift = await manager.findOneByOrFail(Shift, { id: attendance.shiftId });
      await this.attendanceQr.validateQr(manager, shift.id, dto.qrToken);

      const venue = await manager.findOneByOrFail(Venue, { id: shift.venueId });
      const { verified: locationVerified } = this.enforceGeofence(venue, dto);

      return this.performClockOut(manager, ctx, attendance, dto, locationVerified, 'manual');
    });
  }

  /**
   * Part 37: geofence exit is security/transaction-critical and commits
   * synchronously in THIS request — never queued through a worker. Never
   * trusts the client's bare claim "I left the venue" — re-verifies the
   * distance server-side (the same `enforceGeofence` math, inverted) before
   * ever touching attendance state; if the recomputed position is still
   * inside, this is a safe 409 no-op, not a clock-out.
   */
  async autoClockOutOnGeofenceExit(ctx: AuthContext, dto: GeofenceExitDto): Promise<AttendanceSummary> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const staffProfile = await this.ownStaffProfile(manager, ctx);

      const attendance = await manager.findOne(Attendance, {
        where: { staffProfileId: staffProfile.id, status: In([AttendanceStatus.CLOCKED_IN, AttendanceStatus.ON_BREAK]) },
      });
      if (!attendance) throw new NotFoundException('No active clock-in found.');

      const shift = await manager.findOneByOrFail(Shift, { id: attendance.shiftId });
      const venue = await manager.findOneByOrFail(Venue, { id: shift.venueId });

      if (venue.lat == null || venue.lng == null) {
        throw new ConflictException('This venue has no geofence configured — automatic clock-out is unavailable.');
      }
      if (dto.accuracyM != null && dto.accuracyM > this.env.get('GEOFENCE_MAX_ACCURACY_M')) {
        throw new LocationAccuracyTooLowException();
      }
      const distance = haversineDistanceMeters({ lat: dto.lat, lng: dto.lng }, { lat: venue.lat, lng: venue.lng });
      if (distance <= venue.geofenceRadiusM) {
        throw new ConflictException('You are still within the venue geofence.');
      }

      return this.performClockOut(manager, ctx, attendance, dto, true, 'auto_geofence');
    });
  }

  /**
   * The one clock-out code path — shared by the manual QR-scan flow and the
   * automatic geofence-exit flow, so there is exactly one place worked
   * minutes/earned pence are computed and exactly one atomic-claim UPDATE,
   * never two drifted copies. The atomic `WHERE status = $N` claim (using
   * the status this call site already confirmed, moments earlier) is the
   * real race-safety backstop for a concurrent double clock-out.
   */
  private async performClockOut(
    manager: EntityManager,
    ctx: AuthContext,
    attendance: Attendance,
    dto: AttendanceLocationDto,
    locationVerified: boolean,
    method: 'manual' | 'auto_geofence',
  ): Promise<AttendanceSummary> {
    const assignment = await manager.findOneByOrFail(ShiftAssignment, { id: attendance.shiftAssignmentId });
    const shift = await manager.findOneByOrFail(Shift, { id: attendance.shiftId });

    // Never a hard 500 on a state this call site just confirmed is valid —
    // `assertTransition` is the same guard `SHIFT_TRANSITIONS`/
    // `SHIFT_ASSIGNMENT_TRANSITIONS` already use elsewhere in this file.
    assertTransition(ATTENDANCE_TRANSITIONS, attendance.status, AttendanceStatus.CLOCKED_OUT);

    const now = new Date();
    const { workedMinutes } = computeWorkedMinutes({
      clockInAt: attendance.clockInAt,
      clockOutAt: now,
      // A Venue-Manager-confirmed actual break (Phase K's correction
      // endpoint) overrides the shift's scheduled default once set; at
      // clock-out time itself `attendance.breakMinutes` is always still
      // null (nothing sets it before then), so this always falls back to
      // `shift.breakMinutes` here — the `??` is forward-compatible with a
      // later re-run of this same calculation during correction/finalise.
      scheduledBreakMinutes: attendance.breakMinutes ?? shift.breakMinutes,
    });
    const earnedPence = payForMinutes(assignment.payRateSnapshotPence, workedMinutes);

    const [, updatedCount] = (await manager.query(
      `UPDATE core.attendance
          SET clock_out_at = $1, status = $2, worked_minutes = $3, earned_pence = $4,
              clock_out_lat = $5, clock_out_lng = $6, clock_out_accuracy_m = $7,
              location_verified = location_verified OR $8, clock_out_method = $9, updated_at = now()
        WHERE id = $10 AND status = $11`,
      [
        now,
        AttendanceStatus.CLOCKED_OUT,
        workedMinutes,
        earnedPence,
        dto.lat ?? null,
        dto.lng ?? null,
        dto.accuracyM ?? null,
        locationVerified,
        method,
        attendance.id,
        attendance.status,
      ],
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

    await this.auditService.record(
      manager,
      ctx,
      method === 'manual' ? AuditAction.STAFF_CLOCKED_OUT : AuditAction.STAFF_AUTO_CLOCKED_OUT_GEOFENCE,
      {
        entityType: 'attendance',
        entityId: attendance.id,
        metadata: { shiftId: shift.id, workedMinutes, earnedPence, method },
      },
    );

    return this.loadSummary(manager, attendance.id);
  }

  /** Staff-facing (mobile): the caller's own active attendance, or null — plus a server clock the mobile timer always re-anchors to. */
  async getActive(ctx: AuthContext): Promise<{ attendance: AttendanceSummary | null; serverNow: string }> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const serverNow = new Date().toISOString();
      const staffProfile = await manager.findOne(StaffProfile, { where: { userId: ctx.userId } });
      if (!staffProfile) return { attendance: null, serverNow };
      // "Currently on shift" — on_break is never written by this feature's
      // own code (no staff-facing break button — see the class doc comment)
      // but is included for correctness alongside clocked_in, matching the
      // same future-proofing as the `attendance_one_active_per_staff` index.
      const attendance = await manager.findOne(Attendance, {
        where: { staffProfileId: staffProfile.id, status: In([AttendanceStatus.CLOCKED_IN, AttendanceStatus.ON_BREAK]) },
      });
      return { attendance: attendance ? await this.loadSummary(manager, attendance.id) : null, serverNow };
    });
  }

  /** Staff-facing (mobile): the caller's own past-clocking attendance history, newest first — anything no longer actively clocked in, regardless of manager review/approval state. */
  getHistory(ctx: AuthContext, pagination: PaginationDto = {}): Promise<AttendanceSummary[]> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const staffProfile = await manager.findOne(StaffProfile, { where: { userId: ctx.userId } });
      if (!staffProfile) return [];
      const { skip, take } = paginationSkipTake(pagination);
      const rows = await manager.query(
        `${ATTENDANCE_SUMMARY_SELECT} WHERE a.staff_profile_id = $1 AND a.status = ANY($2::text[])
           ORDER BY a.clock_in_at DESC LIMIT $3 OFFSET $4`,
        [
          staffProfile.id,
          [
            AttendanceStatus.CLOCKED_OUT,
            AttendanceStatus.UNDER_REVIEW,
            AttendanceStatus.APPROVED,
            AttendanceStatus.DISPUTED,
            AttendanceStatus.MISSING_CLOCK_OUT,
          ],
          take,
          skip,
        ],
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

  /**
   * Same scope every manager-facing endpoint on this service already
   * enforces (`list`'s own WHERE-clause logic, applied here to one record
   * instead of a filtered set): a Venue Manager may act on an attendance
   * row only at one of their own assigned venues; a normal Manager only on
   * Staff they created. 404, not 403, when out of scope — a record outside
   * the caller's scope must be indistinguishable from one that doesn't
   * exist (CLAUDE.md §"404, not 403").
   */
  private async assertCanManageAttendance(manager: EntityManager, ctx: AuthContext, attendance: Attendance): Promise<void> {
    const scope = await this.resourceScope.resolveTx(manager, ctx);
    if (scope.kind === 'venue') {
      const shift = await manager.findOneByOrFail(Shift, { id: attendance.shiftId });
      if (!scope.venueIds.includes(shift.venueId)) throw new NotFoundException('Attendance not found.');
      return;
    }
    const staffProfile = await manager.findOneByOrFail(StaffProfile, { id: attendance.staffProfileId });
    if (staffProfile.createdBy !== ctx.userId) throw new NotFoundException('Attendance not found.');
  }

  /**
   * Manager correction (Parts 42-44) — the only way `clockInAt`/`clockOutAt`/
   * `breakMinutes` can change after the fact. Always: scope-checked,
   * reason-required (enforced by `CorrectAttendanceDto`'s own
   * `@MinLength(10)`), inserted as a first-class `AttendanceCorrection` row
   * (never a silent overwrite), audited, and followed by a fresh
   * `computeWorkedMinutes`/`payForMinutes` recompute so the row's derived
   * numbers never go stale relative to a corrected timestamp/break.
   */
  async correct(ctx: AuthContext, attendanceId: string, dto: CorrectAttendanceDto): Promise<AttendanceSummary> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const attendance = await manager.findOne(Attendance, { where: { id: attendanceId } });
      if (!attendance) throw new NotFoundException('Attendance not found.');
      await this.assertCanManageAttendance(manager, ctx, attendance);

      const shift = await manager.findOneByOrFail(Shift, { id: attendance.shiftId });
      const assignment = await manager.findOneByOrFail(ShiftAssignment, { id: attendance.shiftAssignmentId });

      let oldValue: string;
      let clockInAt = attendance.clockInAt;
      let clockOutAt = attendance.clockOutAt ?? null;
      let breakMinutes = attendance.breakMinutes ?? null;

      if (dto.field === 'clockInAt') {
        oldValue = attendance.clockInAt.toISOString();
        const parsed = new Date(dto.newValue);
        if (Number.isNaN(parsed.getTime())) throw new BadRequestException('newValue must be a valid ISO-8601 timestamp for clockInAt.');
        clockInAt = parsed;
      } else if (dto.field === 'clockOutAt') {
        oldValue = attendance.clockOutAt?.toISOString() ?? '';
        const parsed = new Date(dto.newValue);
        if (Number.isNaN(parsed.getTime())) throw new BadRequestException('newValue must be a valid ISO-8601 timestamp for clockOutAt.');
        clockOutAt = parsed;
      } else {
        oldValue = attendance.breakMinutes != null ? String(attendance.breakMinutes) : '';
        const parsed = Number(dto.newValue);
        if (!Number.isInteger(parsed) || parsed < 0) throw new BadRequestException('newValue must be a non-negative integer for breakMinutes.');
        breakMinutes = parsed;
      }

      if (clockOutAt && clockOutAt.getTime() < clockInAt.getTime()) {
        throw new BadRequestException('clockOutAt cannot be before clockInAt.');
      }

      // A correction is what reopens a terminal record — CLOCKED_OUT moves
      // to UNDER_REVIEW as the natural "a manager has touched this, it's
      // not yet approved" signal; an already-APPROVED record is explicitly
      // reopened the same way, matching ATTENDANCE_TRANSITIONS' own
      // documented intent ("reopening an approved record requires an
      // attendance_correction row").
      let newStatus = attendance.status;
      if (attendance.status === AttendanceStatus.CLOCKED_OUT || attendance.status === AttendanceStatus.APPROVED) {
        assertTransition(ATTENDANCE_TRANSITIONS, attendance.status, AttendanceStatus.UNDER_REVIEW);
        newStatus = AttendanceStatus.UNDER_REVIEW;
      } else if (attendance.status !== AttendanceStatus.UNDER_REVIEW && attendance.status !== AttendanceStatus.DISPUTED) {
        // Still actively clocked in/on break — nothing to correct yet.
        throw new ConflictException('This attendance cannot be corrected until the staff member has clocked out.');
      }

      const recompute = clockOutAt
        ? computeWorkedMinutes({ clockInAt, clockOutAt, scheduledBreakMinutes: breakMinutes ?? shift.breakMinutes })
        : null;
      const workedMinutes = recompute?.workedMinutes ?? attendance.workedMinutes ?? null;
      const earnedPence = recompute ? payForMinutes(assignment.payRateSnapshotPence, recompute.workedMinutes) : (attendance.earnedPence ?? null);

      await manager.update(Attendance, attendance.id, {
        clockInAt,
        clockOutAt: clockOutAt ?? undefined,
        breakMinutes: breakMinutes ?? undefined,
        status: newStatus,
        workedMinutes: workedMinutes ?? undefined,
        earnedPence: earnedPence ?? undefined,
      });

      await manager.save(AttendanceCorrection, {
        organisationId: ctx.organisationId!,
        workspaceId: attendance.workspaceId,
        attendanceId: attendance.id,
        field: dto.field,
        oldValue,
        newValue: dto.newValue,
        reason: dto.reason,
        correctedBy: ctx.userId,
      });

      await this.auditService.record(manager, ctx, AuditAction.ATTENDANCE_CORRECTED, {
        entityType: 'attendance',
        entityId: attendance.id,
        metadata: { field: dto.field, oldValue, newValue: dto.newValue, reason: dto.reason },
      });

      return this.loadSummary(manager, attendance.id);
    });
  }
}
