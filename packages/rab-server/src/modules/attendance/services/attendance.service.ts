import { effectiveAssignmentBreakMinutes } from '../../scheduling/utils/assignment-time';
import { effectiveAssignmentTime, assignmentTimeSql, ScheduledWindow } from '../../scheduling/utils/assignment-time';
import {
  assertTransition,
  ATTENDANCE_TRANSITIONS,
  AttendanceStatus,
  AttendanceStatusType,
  assessCaptureTime,
  computeWorkedMinutes,
  evaluateLocationEvidence,
  haversineDistanceMeters,
  isGeofenceConfigured,
  LocationEvidencePolicy,
  payForMinutes,
  PermissionFlag,
  SHIFT_ASSIGNMENT_TRANSITIONS,
  SHIFT_TRANSITIONS,
  ShiftAssignmentStatus,
  ShiftStatus,
} from '@rab/shared';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';

import { Shift } from '../../scheduling/entities/shift.entity';
import { ShiftAssignment } from '../../scheduling/entities/shift-assignment.entity';
import { StaffProfile } from '../../staff/entities/staff-profile.entity';
import { Venue } from '../../venue/entities/venue.entity';
import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { EnvironmentService } from '../../../engine/core-modules/environment/environment.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { FieldPolicyService } from '../../identity/member-access/field-policy.service';
import { ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { PaginationDto, paginationSkipTake } from '../../../engine/dto/pagination.dto';
import { toIlikePattern } from '../../../engine/utils/ilike-pattern.util';
import { AttendanceLocationDto } from '../dto/attendance-location.dto';
import { CheckInDto, OnBehalfPunchDto } from '../dto/check-in.dto';
import { ClockInDto } from '../dto/clock-in.dto';
import { ClockOutDto } from '../dto/clock-out.dto';
import { CorrectAttendanceDto } from '../dto/correct-attendance.dto';
import { GeofenceExitDto } from '../dto/geofence-exit.dto';
import { ATTENDANCE_RECORD_REASONS, RecordAttendanceDto } from '../dto/record-attendance.dto';
import { ListAttendanceDto } from '../dto/list-attendance.dto';
import { Attendance } from '../entities/attendance.entity';
import { AttendanceCorrection } from '../entities/attendance-correction.entity';
import { ShiftReport } from '../entities/shift-report.entity';
import {
  AlreadyClockedInException,
  AttendanceFlaggedMissingException,
  CheckInRequiredException,
  CheckInTooEarlyException,
  CheckInWindowClosedException,
  ClockInTooEarlyException,
  ClockWindowClosedException,
  GeofenceMisconfiguredException,
  LocationAccuracyTooLowException,
  locationEvidenceException,
  NotClockedInException,
  PresenceEvidenceRequiredException,
  PresenceNotVerifiedException,
  ReasonTooShortException,
  StaffNotCheckedInException,
} from '../exceptions/attendance.exceptions';
import { AttendanceQrService } from './attendance-qr.service';
import { MISSING_CLOCK_OUT_GRACE_MINUTES } from './missing-clock-out-policy';
import { ATTENDANCE_VERSION_SQL, ShiftReportDetail, ShiftReportService } from './shift-report.service';
import { pinWrittenJoinOrder } from '../../../engine/utils/pin-join-order';

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
  /** Opaque stored_file id of the venue's profile photo (load with GET /files/:id), or null. */
  venuePhotoFileId: string | null;
  /**
   * This attendance's payroll record status (`PayrollRecordStatus`), or null when no record exists yet (report not
   * finalised) or the caller may not read it (payroll_record RLS: own record for Staff, non-venue workspace managers).
   * Staff History shows a shift only when this is approved / processing / paid (owner rule 2026-10-20).
   */
  payrollStatus: string | null;
  /** Approved gross pay in integer pence, set ONLY while `payrollStatus` is approved / processing / paid; else null. */
  payrollApprovedPence: number | null;
  /** `ClockInMethod` ('staff' | 'manager_on_behalf' | 'manager_correction'), or null for rows recorded before it existed. */
  clockInMethod: string | null;
  /** This booking must be checked in before clock-in (false only for bookings made before Check In shipped). */
  checkInRequired: boolean;
  /** Server time of the booking's Check In, or null. */
  checkedInAt: Date | null;
  /** 'staff' | 'qr' | null. */
  checkInSource: string | null;
}

/** Minimum words in a Venue Manager on-behalf punch reason (owner design: "Add a 10 words reason"). */
export const ON_BEHALF_REASON_MIN_WORDS = 10;

/** Staff-facing Check In state of one booking (POST /attendance/check-in, GET /attendance/me/shift/:shiftId/check-in). */
export interface CheckInState {
  shiftId: string;
  /** false only for bookings made before Check In shipped (Clock In does not need it then; Check In is still allowed). */
  checkInRequired: boolean;
  checkedInAt: string | null;
  checkInSource: string | null;
  /** The venue enforced its geofence and the check-in fix passed it. */
  locationVerified: boolean;
  distanceM: number | null;
  accuracyM: number | null;
  /** The venue requires location evidence (lat, lng, accuracyM, capturedAt) for Check In, Clock In and Clock Out. */
  geofenceEnforced: boolean;
  /** Check In / Clock In window (CLOCK_IN_EARLY_MINUTES before the booking's start .. QR_POST_SHIFT_GRACE_MINUTES after its end). */
  window: { opensAt: string; closesAt: string };
  /** An attendance row (clock-in) already exists for this booking. */
  clockedIn: boolean;
  /** true when this call found an existing Check In and changed nothing (idempotent repeat). */
  alreadyCheckedIn: boolean;
  serverNow: string;
}

const ATTENDANCE_SUMMARY_SELECT = `
  SELECT
    a.id, a.status, a.clock_in_at, a.clock_out_at, a.worked_minutes, a.earned_pence,
    a.break_minutes, a.location_verified, a.clock_out_method, a.clock_in_method,
    sa.check_in_required, sa.checked_in_at, sa.check_in_source,
    s.id AS shift_id, ${assignmentTimeSql().start} AS starts_at, ${assignmentTimeSql().end} AS ends_at,
    v.name AS venue_name, v.photo_file_id AS venue_photo_file_id, jr.name AS role_name,
    sp.id AS staff_profile_id, u.first_name, u.last_name,
    pr.status AS payroll_status,
    CASE WHEN pr.status IN ('approved','processing','paid') THEN pr.amount_pence END AS payroll_approved_pence
  FROM attendance a
  JOIN shift_assignment sa ON sa.id = a.shift_assignment_id
  JOIN shift s ON s.id = a.shift_id
  JOIN venue v ON v.id = s.venue_id
  JOIN job_role jr ON jr.id = s.job_role_id
  JOIN staff_profile sp ON sp.id = a.staff_profile_id
  JOIN core."user" u ON u.id = sp.user_id
  LEFT JOIN payroll_record pr ON pr.attendance_id = a.id
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
    venuePhotoFileId: (r.venue_photo_file_id as string) ?? null,
    payrollStatus: (r.payroll_status as string) ?? null,
    payrollApprovedPence: r.payroll_approved_pence === null || r.payroll_approved_pence === undefined ? null : Number(r.payroll_approved_pence),
    clockInMethod: (r.clock_in_method as string) ?? null,
    checkInRequired: Boolean(r.check_in_required),
    checkedInAt: (r.checked_in_at as Date) ?? null,
    checkInSource: (r.check_in_source as string) ?? null,
  };
}

/** Words that carry a letter or digit ("- - -" is not a reason). */
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
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

  /** Wave 5: field-level read policy (money needs payroll.view) for every MANAGER-facing attendance read. */
  @Inject(FieldPolicyService)
  private readonly fieldPolicy!: FieldPolicyService;

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly auditService: AuditService,
    private readonly resourceScope: ResourceScopeService,
    private readonly env: EnvironmentService,
    private readonly attendanceQr: AttendanceQrService,
    private readonly permissions: PermissionsService,
    private readonly shiftReports: ShiftReportService,
  ) {}

  /**
   * Server-authoritative attendance window: `[startsAt - CLOCK_IN_EARLY_MINUTES, endsAt + QR_POST_SHIFT_GRACE_MINUTES]`
   * (the same bounds the Shift QR is signed for). Check In uses the SAME window (FLAGGED owner decision 2026-10-21:
   * opening reuses CLOCK_IN_EARLY_MINUTES, closing reuses the QR post-shift grace — never unlimited). Pure UTC delta
   * arithmetic against `timestamptz` columns: overnight shifts and DST need nothing special. Structured exceptions only.
   */
  private attendanceWindow(shift: ScheduledWindow): { opensAt: Date; closesAt: Date } {
    return {
      opensAt: new Date(shift.startsAt.getTime() - this.env.get('CLOCK_IN_EARLY_MINUTES') * 60_000),
      closesAt: new Date(shift.endsAt.getTime() + this.env.get('QR_POST_SHIFT_GRACE_MINUTES') * 60_000),
    };
  }

  private assertClockWindow(shift: ScheduledWindow, kind: 'clock' | 'check_in' = 'clock'): void {
    const now = Date.now();
    const { opensAt, closesAt } = this.attendanceWindow(shift);
    if (now < opensAt.getTime()) {
      throw kind === 'check_in'
        ? new CheckInTooEarlyException(shift.startsAt.toISOString(), opensAt.toISOString())
        : new ClockInTooEarlyException(shift.startsAt.toISOString(), opensAt.toISOString());
    }
    if (now > closesAt.getTime()) {
      throw kind === 'check_in' ? new CheckInWindowClosedException() : new ClockWindowClosedException();
    }
  }

  private locationPolicy(strict: boolean): LocationEvidencePolicy {
    return {
      maxAccuracyM: this.env.get('GEOFENCE_MAX_ACCURACY_M'),
      maxAgeMs: this.env.get('LOCATION_EVIDENCE_MAX_AGE_SECONDS') * 1000,
      maxFutureSkewMs: this.env.get('LOCATION_EVIDENCE_MAX_FUTURE_SKEW_SECONDS') * 1000,
      strict,
    };
  }

  /**
   * The one geofence gate for Check In, Clock In and Clock Out (`evaluateLocationEvidence` in @rab/shared decides).
   * Venue coordinates/radius are server data; the device fix is only compared to them. `strict` is the booking's
   * `check_in_required` (rollout rule): bookings made before Check In keep the pre-existing geofence behaviour
   * (lat/lng only; a misconfigured venue fails soft and is NOT verified). `notBefore` is the capture time of the
   * previous step's fix for the same booking — the new fix must be strictly newer (replay guard). Returns only what may
   * be stored: verified flag, rounded distance/accuracy and the capture time — never raw coordinates.
   */
  private verifyLocation(venue: Venue, dto: AttendanceLocationDto, strict: boolean, notBefore?: Date | null) {
    const result = evaluateLocationEvidence(
      { enforceGeofence: venue.enforceGeofence, lat: venue.lat, lng: venue.lng, geofenceRadiusM: venue.geofenceRadiusM },
      { lat: dto.lat, lng: dto.lng, accuracyM: dto.accuracyM, capturedAt: dto.capturedAt ? new Date(dto.capturedAt) : null },
      new Date(),
      this.locationPolicy(strict),
      strict ? notBefore : null,
    );
    if (!result.ok) throw locationEvidenceException(result.code, venue.name);
    if (result.enforced && !result.verified) {
      this.logger.warn(`Venue ${venue.id} has enforceGeofence=true but no usable lat/lng/radius — legacy booking allowed unverified.`);
    }
    return {
      verified: result.verified,
      distanceM: result.distanceM == null ? null : Math.round(result.distanceM),
      accuracyM: result.accuracyM == null ? null : Math.ceil(result.accuracyM),
      capturedAt: result.capturedAt,
    };
  }

  private async markShiftInProgress(manager: EntityManager, shift: Shift): Promise<void> {
    if (shift.status === ShiftStatus.IN_PROGRESS) return;
    assertTransition(SHIFT_TRANSITIONS, shift.status, ShiftStatus.IN_PROGRESS);
    // Compare-and-set on the status we observed, NOT an unconditional write. When a whole roster
    // clocks in at shift start, every concurrent transaction read the pre-start status; an
    // unconditional UPDATE would make each one queue on the shift row lock and then hold it for
    // its own commit — a serial chain (measured: 9 of 10 backends waiting). With the CAS, the
    // waiters wake after the first commit, no longer match, and skip the write.
    const flipped = await manager.update(Shift, { id: shift.id, status: shift.status }, { status: ShiftStatus.IN_PROGRESS });
    if (!flipped.affected) {
      const current = await manager.findOneByOrFail(Shift, { id: shift.id });
      if (current.status !== ShiftStatus.IN_PROGRESS) {
        throw new ConflictException('This shift is no longer open for clock-in.');
      }
    }
  }

  private assertOnBehalfReason(reason: string): string {
    const trimmed = (reason ?? '').trim();
    if (countWords(trimmed) < ON_BEHALF_REASON_MIN_WORDS) throw new ReasonTooShortException(ON_BEHALF_REASON_MIN_WORDS);
    return trimmed;
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

  private async checkInState(
    manager: EntityManager,
    assignment: ShiftAssignment,
    shift: Shift,
    venue: Venue,
    alreadyCheckedIn: boolean,
  ): Promise<CheckInState> {
    const window = this.attendanceWindow(effectiveAssignmentTime(assignment, shift));
    const clockedIn = (await manager.count(Attendance, { where: { shiftAssignmentId: assignment.id } })) > 0;
    return {
      shiftId: shift.id,
      checkInRequired: assignment.checkInRequired,
      checkedInAt: assignment.checkedInAt ? new Date(assignment.checkedInAt).toISOString() : null,
      checkInSource: assignment.checkInSource ?? null,
      locationVerified: !!assignment.checkInLocationVerified,
      distanceM: assignment.checkInDistanceM ?? null,
      accuracyM: assignment.checkInAccuracyM ?? null,
      geofenceEnforced: venue.enforceGeofence,
      window: { opensAt: window.opensAt.toISOString(), closesAt: window.closesAt.toISOString() },
      clockedIn,
      alreadyCheckedIn,
      serverNow: new Date().toISOString(),
    };
  }

  /**
   * Staff CHECK IN — "I am physically at the venue" (owner brief 2026-10-21). Arrival evidence only: it is NOT worked
   * time, creates no attendance row and never feeds payroll. Clock In for this booking then requires it (unless the
   * booking predates Check In — `check_in_required = false`).
   *
   * Layers: route PermissionGuard(ATTENDANCE_CLOCK) + staff_app → the booking is resolved from the verified session's
   * own staff profile + `shiftId` (another staff member's shift is a 404, never a 403) → workspace-bound transaction →
   * shift_assignment RLS. Validated under the booking's row lock: booking confirmed (provisional no-show →
   * ATTENDANCE_FLAGGED_MISSING), shift open, the attendance window, the optional Shift QR (source 'qr'), and — when the
   * venue enforces its geofence — fresh location evidence inside the radius (strict policy, always). Idempotent: a repeat
   * returns the original check-in unchanged (no new timestamp, no new evidence, no second audit row).
   */
  async checkIn(ctx: AuthContext, dto: CheckInDto): Promise<CheckInState> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const staffProfile = await this.ownStaffProfile(manager, ctx);
      const assignment = await manager.findOne(ShiftAssignment, {
        where: { shiftId: dto.shiftId, staffProfileId: staffProfile.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!assignment) throw new NotFoundException('Shift not found.');
      const shift = await manager.findOneByOrFail(Shift, { id: assignment.shiftId });
      const venue = await manager.findOneByOrFail(Venue, { id: shift.venueId });
      if (assignment.checkedInAt) return this.checkInState(manager, assignment, shift, venue, true);

      if (assignment.status === ShiftAssignmentStatus.NO_SHOW) throw new AttendanceFlaggedMissingException();
      if (assignment.status !== ShiftAssignmentStatus.CONFIRMED) {
        throw new ConflictException({ statusCode: 409, code: 'SHIFT_NOT_CONFIRMED', message: 'This shift is not confirmed for you.' });
      }
      if (shift.status === ShiftStatus.CANCELLED || shift.status === ShiftStatus.COMPLETED) {
        throw new ConflictException({ statusCode: 409, code: 'SHIFT_NOT_OPEN', message: 'This shift is not open for attendance.' });
      }
      if ((await manager.count(Attendance, { where: { shiftAssignmentId: assignment.id } })) > 0) {
        throw new AlreadyClockedInException('You have already clocked in for this shift.');
      }
      this.assertClockWindow(effectiveAssignmentTime(assignment, shift), 'check_in');

      let source: 'staff' | 'qr' = 'staff';
      if (dto.qrToken) {
        await this.attendanceQr.validateQr(manager, shift.id, dto.qrToken);
        source = 'qr';
      }
      const evidence = this.verifyLocation(venue, dto, true);

      // Compare-and-set under the row lock: still confirmed, still not checked in. Server time, never client time.
      const [, updated] = (await manager.query(
        `UPDATE shift_assignment
            SET checked_in_at = now(), check_in_source = $2, check_in_location_verified = $3,
                check_in_distance_m = $4, check_in_accuracy_m = $5, check_in_captured_at = $6
          WHERE id = $1 AND status = 'confirmed' AND checked_in_at IS NULL`,
        [assignment.id, source, evidence.verified, evidence.distanceM, evidence.accuracyM, evidence.capturedAt],
      )) as [unknown, number];
      if (!updated) throw new ConflictException('This booking changed while checking in. Refresh and try again.');

      await this.auditService.record(manager, ctx, AuditAction.STAFF_CHECKED_IN, {
        entityType: 'shift_assignment',
        entityId: assignment.id,
        metadata: {
          shiftId: shift.id,
          source,
          locationVerified: evidence.verified,
          distanceM: evidence.distanceM,
          accuracyM: evidence.accuracyM,
          geofenceEnforced: venue.enforceGeofence,
        },
      });
      const fresh = await manager.findOneByOrFail(ShiftAssignment, { id: assignment.id });
      return this.checkInState(manager, fresh, shift, venue, false);
    });
  }

  /** Staff-facing read of one booking's Check In state (404 for a shift that is not the caller's). */
  async getCheckIn(ctx: AuthContext, shiftId: string): Promise<CheckInState> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const staffProfile = await this.ownStaffProfile(manager, ctx);
      const assignment = await manager.findOne(ShiftAssignment, { where: { shiftId, staffProfileId: staffProfile.id } });
      if (!assignment) throw new NotFoundException('Shift not found.');
      const shift = await manager.findOneByOrFail(Shift, { id: assignment.shiftId });
      const venue = await manager.findOneByOrFail(Venue, { id: shift.venueId });
      return this.checkInState(manager, assignment, shift, venue, !!assignment.checkedInAt);
    });
  }

  /**
   * Validates, in order: caller is Staff with a profile; the shift is actually assigned+confirmed for THIS staff
   * profile (never a client-supplied staffId — see class doc comment); the shift itself isn't cancelled/already
   * completed; the attendance window; the booking's Check In (CHECK_IN_REQUIRED — before the QR, so a valid QR can
   * never stand in for it); the Shift QR; the venue geofence (strict for bookings that need Check In: fresh fix, newer
   * than the check-in fix). No other attendance may exist for the booking or the staff member (`attendance_shift_
   * assignment_id_key` and the partial unique `attendance_one_active_per_staff` are the backstops for two simultaneous
   * clock-ins, e.g. the staff member and a Venue Manager on their behalf — exactly one wins).
   */
  async clockIn(ctx: AuthContext, dto: ClockInDto): Promise<AttendanceSummary> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const staffProfile = await this.ownStaffProfile(manager, ctx);

      // Same parent-first lock order as offer confirmation/cancellation. Re-read assignment after the lock.
      await manager.findOne(Shift, { where: { id: dto.shiftId }, lock: { mode: 'pessimistic_write' } });
      const assignment = await manager.findOne(ShiftAssignment, {
        where: { shiftId: dto.shiftId, staffProfileId: staffProfile.id },
        lock: { mode: 'pessimistic_write' },
      });
      // 404, not 403 — a shift assigned to a different staff member must be
      // indistinguishable from a shift that doesn't exist at all.
      if (!assignment) throw new NotFoundException('Shift not found.');
      if (assignment.status === ShiftAssignmentStatus.NO_SHOW && !(await this.hasAttendance(manager, assignment.id))) {
        throw new AttendanceFlaggedMissingException();
      }
      if (assignment.status !== ShiftAssignmentStatus.CONFIRMED) {
        throw new ConflictException('This shift is not confirmed for you.');
      }

      const shift = await manager.findOneByOrFail(Shift, { id: assignment.shiftId });
      if (shift.status === ShiftStatus.CANCELLED || shift.status === ShiftStatus.COMPLETED) {
        throw new ConflictException('This shift is not open for attendance.');
      }
      if (await this.hasAttendance(manager, assignment.id)) {
        throw new AlreadyClockedInException('You have already clocked in for this shift.');
      }
      this.assertClockWindow(effectiveAssignmentTime(assignment, shift));
      if (assignment.checkInRequired && !assignment.checkedInAt) throw new CheckInRequiredException();

      // Strictly additional to the ShiftAssignment/status/check-in checks above — a
      // cryptographically valid QR never substitutes for them (Part 54).
      await this.attendanceQr.validateQr(manager, shift.id, dto.qrToken);

      const venue = await manager.findOneByOrFail(Venue, { id: shift.venueId });
      const evidence = this.verifyLocation(venue, dto, assignment.checkInRequired, assignment.checkInCapturedAt ?? null);

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
        locationVerified: evidence.verified,
        clockInMethod: 'staff',
        clockInCapturedAt: evidence.capturedAt,
      });
      try {
        await manager.save(attendance);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictException('You already have an active clock-in — clock out first.');
        }
        throw error;
      }

      await this.markShiftInProgress(manager, shift);

      await this.auditService.record(manager, ctx, AuditAction.STAFF_CLOCKED_IN, {
        entityType: 'attendance',
        entityId: attendance.id,
        metadata: { shiftId: shift.id, method: 'staff', checkedIn: !!assignment.checkedInAt },
      });

      return this.loadSummary(manager, attendance.id);
    });
  }

  private async hasAttendance(manager: EntityManager, assignmentId: string): Promise<boolean> {
    return (await manager.count(Attendance, { where: { shiftAssignmentId: assignmentId } })) > 0;
  }

  /**
   * Finds the caller's own active attendance (never a client-supplied
   * attendance id), validates the same Shift QR used at clock-in and the
   * same venue geofence (strict for bookings that need Check In: a fresh fix,
   * newer than the clock-in fix), and closes it via the shared `performClockOut`.
   */
  async clockOut(ctx: AuthContext, dto: ClockOutDto): Promise<AttendanceSummary> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const staffProfile = await this.ownStaffProfile(manager, ctx);

      const attendance = await manager.findOne(Attendance, {
        where: { staffProfileId: staffProfile.id, status: In([AttendanceStatus.CLOCKED_IN, AttendanceStatus.ON_BREAK]) },
      });
      if (!attendance) throw new NotFoundException('No active clock-in found.');

      const shift = await manager.findOneByOrFail(Shift, { id: attendance.shiftId });
      await this.attendanceQr.validateQr(manager, shift.id, dto.qrToken);

      const assignment = await manager.findOneByOrFail(ShiftAssignment, { id: attendance.shiftAssignmentId });
      const venue = await manager.findOneByOrFail(Venue, { id: shift.venueId });
      const evidence = this.verifyLocation(venue, dto, assignment.checkInRequired, attendance.clockInCapturedAt ?? null);

      return this.performClockOut(manager, ctx, attendance, dto, evidence.verified, 'manual');
    });
  }

  /**
   * Part 37: geofence exit is security/transaction-critical and commits
   * synchronously in THIS request — never queued through a worker. Never
   * trusts the client's bare claim "I left the venue" — re-verifies the
   * distance server-side (the same geofence math, inverted) before
   * ever touching attendance state; if the recomputed position is still
   * inside, this is a safe 409 no-op, not a clock-out. Bookings that need
   * Check In also need a fresh fix newer than the clock-in fix (replay guard).
   */
  async autoClockOutOnGeofenceExit(ctx: AuthContext, dto: GeofenceExitDto): Promise<AttendanceSummary> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const staffProfile = await this.ownStaffProfile(manager, ctx);

      const attendance = await manager.findOne(Attendance, {
        where: { staffProfileId: staffProfile.id, status: In([AttendanceStatus.CLOCKED_IN, AttendanceStatus.ON_BREAK]) },
      });
      if (!attendance) throw new NotFoundException('No active clock-in found.');

      const shift = await manager.findOneByOrFail(Shift, { id: attendance.shiftId });
      const venue = await manager.findOneByOrFail(Venue, { id: shift.venueId });
      const assignment = await manager.findOneByOrFail(ShiftAssignment, { id: attendance.shiftAssignmentId });

      if (!isGeofenceConfigured(venue)) {
        throw new ConflictException('This venue has no geofence configured — automatic clock-out is unavailable.');
      }
      if (dto.accuracyM != null && dto.accuracyM > this.env.get('GEOFENCE_MAX_ACCURACY_M')) {
        throw new LocationAccuracyTooLowException();
      }
      const staleness = assessCaptureTime(
        dto.capturedAt ? new Date(dto.capturedAt) : null,
        new Date(),
        this.locationPolicy(assignment.checkInRequired),
        assignment.checkInRequired ? (attendance.clockInCapturedAt ?? null) : null,
      );
      if (staleness) throw locationEvidenceException(staleness, venue.name);
      const distance = haversineDistanceMeters({ lat: dto.lat, lng: dto.lng }, { lat: venue.lat!, lng: venue.lng! });
      if (distance <= venue.geofenceRadiusM) {
        throw new ConflictException('You are still within the venue geofence.');
      }

      return this.performClockOut(manager, ctx, attendance, dto, true, 'auto_geofence');
    });
  }

  /**
   * The one clock-out code path — shared by the manual QR-scan flow, the
   * automatic geofence-exit flow and the Venue Manager on-behalf clock-out,
   * so there is exactly one place worked minutes/earned pence are computed
   * and exactly one atomic-claim UPDATE, never drifted copies. The atomic
   * `WHERE status = $N` claim (using the status this call site already
   * confirmed, moments earlier) is the real race-safety backstop for a
   * concurrent double clock-out (staff + manager: exactly one wins).
   */
  private async performClockOut(
    manager: EntityManager,
    ctx: AuthContext,
    attendance: Attendance,
    dto: AttendanceLocationDto,
    locationVerified: boolean,
    method: 'manual' | 'auto_geofence' | 'manager_on_behalf',
    onBehalf?: { by: string; reason: string },
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
      scheduledBreakMinutes: attendance.breakMinutes ?? effectiveAssignmentBreakMinutes(assignment, shift),
    });
    const earnedPence = payForMinutes(assignment.payRateSnapshotPence, workedMinutes);

    const [, updatedCount] = (await manager.query(
      `UPDATE attendance
          SET clock_out_at = $1, status = $2, worked_minutes = $3, earned_pence = $4,
              clock_out_lat = $5, clock_out_lng = $6, clock_out_accuracy_m = $7,
              location_verified = location_verified OR $8, clock_out_method = $9,
              clock_out_by = $12, clock_out_reason = $13, updated_at = now()
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
        onBehalf?.by ?? null,
        onBehalf?.reason ?? null,
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

    const action =
      method === 'manual'
        ? AuditAction.STAFF_CLOCKED_OUT
        : method === 'auto_geofence'
          ? AuditAction.STAFF_AUTO_CLOCKED_OUT_GEOFENCE
          : AuditAction.ATTENDANCE_CLOCKED_OUT_ON_BEHALF;
    await this.auditService.record(manager, ctx, action, {
      entityType: 'attendance',
      entityId: attendance.id,
      metadata: {
        shiftId: shift.id,
        workedMinutes,
        earnedPence,
        method,
        ...(onBehalf ? { staffProfileId: attendance.staffProfileId, reason: onBehalf.reason, serverTime: now.toISOString() } : {}),
      },
    });

    return this.loadSummary(manager, attendance.id);
  }

  /**
   * The shared opening of a Venue Manager on-behalf punch: permission re-check (layer 2; the route guard is layer 1) →
   * report scope (`canReadShift`: assigned venue for a Venue Manager, own shift for a Manager; 404 outside, as for a
   * shift in another workspace) → the seat (404 when the staff member is not booked on it) → the shift's finalise lock
   * (refused once the report is finalised).
   */
  private async openOnBehalf(manager: EntityManager, ctx: AuthContext, shiftId: string, staffProfileId: string) {
    if (!(await this.permissions.userHasPermissionTx(manager, ctx, PermissionFlag.ATTENDANCE_EDIT))) throw new ForbiddenException('Permission required.');
    const shift = await manager.findOne(Shift, { where: { id: shiftId } });
    if (!shift || shift.organisationId !== ctx.organisationId || !(await this.shiftReports.canReadShift(manager, ctx, shift))) {
      throw new NotFoundException('Shift not found.');
    }
    const seat = await manager.findOne(ShiftAssignment, {
      where: { shiftId, staffProfileId, status: In([ShiftAssignmentStatus.CONFIRMED, ShiftAssignmentStatus.COMPLETED, ShiftAssignmentStatus.NO_SHOW]) },
    });
    if (!seat) throw new NotFoundException('Staff member not found on this shift.');
    await this.lockOpenReport(manager, shiftId);
    return { shift, seat };
  }

  /**
   * Venue Manager live CLOCK IN on behalf of a staff member (owner brief 2026-10-21, design "Clock in Lusy?").
   *
   * Presence rule (FLAGGED): the manager's phone location proves nothing about the staff member, so the presence proof
   * is the staff member's OWN Check In for this booking — required always (STAFF_NOT_CHECKED_IN otherwise, including for
   * bookings that predate Check In). At a geofence-enforcing venue that Check In must itself have been geofence-verified
   * (PRESENCE_NOT_VERIFIED otherwise; GEOFENCE_MISCONFIGURED when the venue has no usable coordinates). The Check In is by
   * construction inside this booking's attendance window, and the clock-in must be too.
   *
   * Records the manager (`clock_in_by`), the reason (≥ 10 words, `clock_in_reason`), provenance `clock_in_method =
   * 'manager_on_behalf'` and SERVER time (no time is accepted from the client). Same locks as the staff clock-in (report
   * advisory lock, then shift, then booking), so a simultaneous staff clock-in and manager clock-in produce exactly one
   * attendance row; the other gets 409 ALREADY_CLOCKED_IN. Returns the authoritative shift report.
   */
  async clockInOnBehalf(ctx: AuthContext, shiftId: string, staffProfileId: string, dto: OnBehalfPunchDto): Promise<ShiftReportDetail> {
    const reason = this.assertOnBehalfReason(dto.reason);
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const { seat } = await this.openOnBehalf(manager, ctx, shiftId, staffProfileId);
      const shift = await manager.findOneOrFail(Shift, { where: { id: shiftId }, lock: { mode: 'pessimistic_write' } });
      const assignment = await manager.findOneOrFail(ShiftAssignment, { where: { id: seat.id }, lock: { mode: 'pessimistic_write' } });

      if (await this.hasAttendance(manager, assignment.id)) throw new AlreadyClockedInException('This staff member has already clocked in for this shift.');
      if (assignment.status === ShiftAssignmentStatus.NO_SHOW) {
        throw new ConflictException({
          statusCode: 409,
          code: 'ATTENDANCE_FLAGGED_MISSING',
          message: "This staff member's attendance was flagged as missing. Record their attendance in the shift report instead.",
        });
      }
      if (assignment.status !== ShiftAssignmentStatus.CONFIRMED) {
        throw new ConflictException({ statusCode: 409, code: 'SHIFT_NOT_CONFIRMED', message: 'This staff member is not confirmed for this shift.' });
      }
      if (shift.status === ShiftStatus.CANCELLED || shift.status === ShiftStatus.COMPLETED) {
        throw new ConflictException({ statusCode: 409, code: 'SHIFT_NOT_OPEN', message: 'This shift is not open for attendance.' });
      }
      this.assertClockWindow(effectiveAssignmentTime(assignment, shift));

      if (!assignment.checkedInAt) {
        const [who] = await manager.query(`SELECT u.first_name FROM staff_profile sp JOIN core."user" u ON u.id = sp.user_id WHERE sp.id = $1`, [staffProfileId]);
        throw new StaffNotCheckedInException(who?.first_name ?? 'The staff member');
      }
      const venue = await manager.findOneByOrFail(Venue, { id: shift.venueId });
      if (venue.enforceGeofence) {
        if (!isGeofenceConfigured(venue)) throw new GeofenceMisconfiguredException();
        if (!assignment.checkInLocationVerified) throw new PresenceNotVerifiedException();
      }

      const attendance = manager.create(Attendance, {
        organisationId: ctx.organisationId!,
        workspaceId: shift.workspaceId,
        shiftAssignmentId: assignment.id,
        shiftId: shift.id,
        staffProfileId: assignment.staffProfileId,
        clockInAt: new Date(),
        status: AttendanceStatus.CLOCKED_IN,
        // The punch itself carries no device location: it was made on the manager's phone.
        locationVerified: false,
        clockInMethod: 'manager_on_behalf',
        clockInBy: ctx.userId,
        clockInReason: reason,
        // The staff member's own check-in fix stays the replay baseline for their clock-out fix.
        clockInCapturedAt: assignment.checkInCapturedAt ?? null,
      });
      try {
        await manager.save(attendance);
      } catch (error) {
        if (isUniqueViolation(error)) throw new AlreadyClockedInException('This staff member has already clocked in for this shift.');
        throw error;
      }
      await this.markShiftInProgress(manager, shift);

      await this.auditService.record(manager, ctx, AuditAction.ATTENDANCE_CLOCKED_IN_ON_BEHALF, {
        entityType: 'attendance',
        entityId: attendance.id,
        metadata: {
          shiftId,
          staffProfileId,
          assignmentId: assignment.id,
          method: 'manager_on_behalf',
          reason,
          serverTime: attendance.clockInAt.toISOString(),
          checkedInAt: new Date(assignment.checkedInAt).toISOString(),
          checkInSource: assignment.checkInSource ?? null,
          checkInLocationVerified: !!assignment.checkInLocationVerified,
          geofenceEnforced: venue.enforceGeofence,
        },
      });
      return this.shiftReports.getReportWithManager(manager, ctx, shiftId);
    });
  }

  /**
   * Venue Manager live CLOCK OUT on behalf of a staff member, only after a valid clock-in, with a ≥ 10-word reason,
   * the manager and SERVER time recorded (`clock_out_method = 'manager_on_behalf'`, `clock_out_by`, `clock_out_reason`).
   *
   * Geofence rule (FLAGGED): at a venue that enforces its geofence a manager cannot attest where the staff member is, so
   * the on-behalf clock-out is refused (PRESENCE_EVIDENCE_REQUIRED): the staff member clocks out on their own phone, or —
   * once the shift has ended — the manager records the clock-out time through the existing "Record attendance"
   * correction (which is reviewed before finalisation). Without an enforced geofence it is allowed inside the attendance
   * window. The staff member's own clock-out racing this one: the shared `performClockOut` claim lets exactly one win.
   */
  async clockOutOnBehalf(ctx: AuthContext, shiftId: string, staffProfileId: string, dto: OnBehalfPunchDto): Promise<ShiftReportDetail> {
    const reason = this.assertOnBehalfReason(dto.reason);
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const { shift, seat } = await this.openOnBehalf(manager, ctx, shiftId, staffProfileId);
      const attendance = await manager.findOne(Attendance, { where: { shiftAssignmentId: seat.id }, lock: { mode: 'pessimistic_write' } });
      if (!attendance) throw new NotClockedInException("This staff member hasn't clocked in.");
      if (attendance.status !== AttendanceStatus.CLOCKED_IN && attendance.status !== AttendanceStatus.ON_BREAK) {
        throw new NotClockedInException('This staff member is no longer clocked in.');
      }
      const venue = await manager.findOneByOrFail(Venue, { id: shift.venueId });
      if (venue.enforceGeofence) throw new PresenceEvidenceRequiredException();
      const assignment = await manager.findOneByOrFail(ShiftAssignment, { id: seat.id });
      if (Date.now() > this.attendanceWindow(effectiveAssignmentTime(assignment, shift)).closesAt.getTime()) {
        throw new ClockWindowClosedException();
      }
      await this.performClockOut(manager, ctx, attendance, {}, false, 'manager_on_behalf', { by: ctx.userId, reason });
      return this.shiftReports.getReportWithManager(manager, ctx, shiftId);
    });
  }

  /** Staff-facing (mobile): the caller's own active attendance, or null — plus a server clock the mobile timer always re-anchors to. */
  async getActive(ctx: AuthContext): Promise<{
    attendance: AttendanceSummary | null;
    serverNow: string;
    clockInEarlyMinutes: number;
    /** What a location fix must satisfy at a geofence-enforcing venue (Check In / Clock In / Clock Out). */
    locationEvidence: { maxAccuracyM: number; maxAgeSeconds: number; maxFutureSkewSeconds: number };
  }> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const serverNow = new Date().toISOString();
      const clockInEarlyMinutes = this.env.get('CLOCK_IN_EARLY_MINUTES');
      const locationEvidence = {
        maxAccuracyM: this.env.get('GEOFENCE_MAX_ACCURACY_M'),
        maxAgeSeconds: this.env.get('LOCATION_EVIDENCE_MAX_AGE_SECONDS'),
        maxFutureSkewSeconds: this.env.get('LOCATION_EVIDENCE_MAX_FUTURE_SKEW_SECONDS'),
      };
      const staffProfile = await manager.findOne(StaffProfile, { where: { userId: ctx.userId } });
      if (!staffProfile) return { attendance: null, serverNow, clockInEarlyMinutes, locationEvidence };
      // "Currently on shift" — on_break is never written by this feature's
      // own code (no staff-facing break button — see the class doc comment)
      // but is included for correctness alongside clocked_in, matching the
      // same future-proofing as the `attendance_one_active_per_staff` index.
      const attendance = await manager.findOne(Attendance, {
        where: { staffProfileId: staffProfile.id, status: In([AttendanceStatus.CLOCKED_IN, AttendanceStatus.ON_BREAK]) },
      });
      return { attendance: attendance ? await this.loadSummary(manager, attendance.id) : null, serverNow, clockInEarlyMinutes, locationEvidence };
    });
  }

  /** Staff-facing (mobile): the caller's own past-clocking attendance history, newest first — anything no longer actively clocked in, regardless of manager review/approval state. */
  getHistory(ctx: AuthContext, pagination: PaginationDto = {}): Promise<AttendanceSummary[]> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
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
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
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
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
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
      // Layer 2 field policy: a hidden field is never returned, filtered on or sorted by (no probing through the
      // result set or its order). Money is hidden from callers without payroll.view.
      const fields = await this.fieldPolicy.resolveTx(manager, ctx, 'attendance');
      const earningsVisible = this.fieldPolicy.isVisible(fields, 'earnings');
      const workedVisible = this.fieldPolicy.isVisible(fields, 'workedTime');

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
      if (workedVisible && dto.workedMinutesMin !== undefined) conditions.push(`a.worked_minutes >= ${nextParam(dto.workedMinutesMin)}`);
      if (workedVisible && dto.workedMinutesMax !== undefined) conditions.push(`a.worked_minutes <= ${nextParam(dto.workedMinutesMax)}`);
      if (earningsVisible && dto.earnedPenceMin !== undefined) conditions.push(`a.earned_pence >= ${nextParam(dto.earnedPenceMin)}`);
      if (earningsVisible && dto.earnedPenceMax !== undefined) conditions.push(`a.earned_pence <= ${nextParam(dto.earnedPenceMax)}`);

      const where = `WHERE ${conditions.join(' AND ')}`;
      const sortKey = (dto.sort === 'earnedPence' && !earningsVisible) || (dto.sort === 'workedMinutes' && !workedVisible) ? 'clockInAt' : dto.sort;
      const sortColumn = ATTENDANCE_SORT_COLUMNS[sortKey ?? 'clockInAt'] ?? ATTENDANCE_SORT_COLUMNS.clockInAt;
      const direction = (dto.direction ?? 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

      // W6-E2E-06: fact-table-first join order for the count and the page (RLS hides the GUC values from the planner).
      await pinWrittenJoinOrder(manager);
      const [{ count }] = await manager.query(
        `SELECT count(*)::int AS count FROM attendance a
           JOIN shift s ON s.id = a.shift_id
           JOIN venue v ON v.id = s.venue_id
           JOIN job_role jr ON jr.id = s.job_role_id
           JOIN staff_profile sp ON sp.id = a.staff_profile_id
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
      return { data: rows.map((r: Record<string, unknown>) => this.fieldPolicy.omit(fields, toAttendanceSummary(r))), total: count };
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
   * Serialises every manager attendance write for one shift against finalisation (the same advisory lock `finalise`,
   * `reviewAttendance` and the no-show actions take), then refuses once the report is finalised: its final timesheet
   * has been delivered and payroll records exist, so a later change would silently disagree with both. There is no
   * reopen-report flow in v1 — post-finalisation changes go through the payroll correction path, not here.
   */
  private async lockOpenReport(manager: EntityManager, shiftId: string): Promise<void> {
    await manager.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`finalise:${shiftId}`]);
    const finalisedReport = await manager.count(ShiftReport, { where: { shiftId, status: 'finalised' } });
    if (finalisedReport > 0) {
      throw new ConflictException('This shift report has been finalised and can no longer be corrected.');
    }
  }

  private async dbNow(manager: EntityManager): Promise<Date> {
    const [{ now }] = await manager.query('SELECT now() AS now');
    return new Date(now);
  }

  /**
   * Which status a manager time change leaves the row in, validated against ATTENDANCE_TRANSITIONS. A recorded
   * (clocked-out/approved) row is reopened for review; one already in review stays there; an open or flagged
   * missing-clock-out row is recovered only once the monitor threshold has passed AND a clock-out is being recorded —
   * never for a shift still running.
   */
  private resolveCorrectionStatus(
    attendance: Attendance,
    assignment: ShiftAssignment,
    shift: Shift,
    now: Date,
    nextClockOutAt: Date | null,
  ): { status: AttendanceStatusType; recovered: boolean } {
    if (attendance.status === AttendanceStatus.CLOCKED_OUT || attendance.status === AttendanceStatus.APPROVED) {
      assertTransition(ATTENDANCE_TRANSITIONS, attendance.status, AttendanceStatus.UNDER_REVIEW);
      return { status: AttendanceStatus.UNDER_REVIEW, recovered: false };
    }
    if (attendance.status === AttendanceStatus.UNDER_REVIEW || attendance.status === AttendanceStatus.DISPUTED) {
      return { status: attendance.status, recovered: false };
    }
    if (
      attendance.status === AttendanceStatus.MISSING_CLOCK_OUT ||
      attendance.status === AttendanceStatus.CLOCKED_IN ||
      attendance.status === AttendanceStatus.ON_BREAK
    ) {
      // Forgotten clock-out recovery (owner brief 2026-10-18): only for a record the monitor has flagged
      // MISSING_CLOCK_OUT, or an open record already past that same threshold — never for a shift still running.
      const flagAt = effectiveAssignmentTime(assignment, shift).endsAt.getTime() + MISSING_CLOCK_OUT_GRACE_MINUTES * 60_000;
      if (attendance.status !== AttendanceStatus.MISSING_CLOCK_OUT && now.getTime() < flagAt) {
        throw new ConflictException('This staff member is still on shift. A missing clock-out can be recovered once the shift has ended.');
      }
      if (!nextClockOutAt) {
        throw new ConflictException('Add the missing clock-out time first.');
      }
      assertTransition(ATTENDANCE_TRANSITIONS, attendance.status, AttendanceStatus.CLOCKED_OUT);
      assertTransition(ATTENDANCE_TRANSITIONS, AttendanceStatus.CLOCKED_OUT, AttendanceStatus.UNDER_REVIEW);
      return { status: AttendanceStatus.UNDER_REVIEW, recovered: true };
    }
    throw new ConflictException('This attendance cannot be corrected in its current state.');
  }

  /**
   * The one write path for manager-changed times on an EXISTING attendance row (single-field `correct` and the
   * multi-field `recordAttendance`): recompute worked minutes (`@rab/shared` duration.ts) and pay (the assignment's
   * confirmation-time rate snapshot, never re-resolved), clear any earlier attendance review (changed times must be
   * reviewed again), insert one `attendance_correction` row per changed field (before/after, reason, manager) and
   * audit it.
   */
  private async persistManagerTimes(
    manager: EntityManager,
    ctx: AuthContext,
    attendance: Attendance,
    assignment: ShiftAssignment,
    shift: Shift,
    next: { clockInAt: Date; clockOutAt: Date | null; breakMinutes: number | null },
    opts: {
      status: AttendanceStatusType;
      recovered: boolean;
      corrections: Array<{ field: string; oldValue: string; newValue: string }>;
      reason: string;
      audit: Record<string, unknown>;
    },
  ): Promise<void> {
    const recompute = next.clockOutAt
      ? computeWorkedMinutes({
          clockInAt: next.clockInAt,
          clockOutAt: next.clockOutAt,
          scheduledBreakMinutes: next.breakMinutes ?? effectiveAssignmentBreakMinutes(assignment, shift),
        })
      : null;
    const workedMinutes = recompute?.workedMinutes ?? attendance.workedMinutes ?? null;
    const earnedPence = recompute ? payForMinutes(assignment.payRateSnapshotPence, recompute.workedMinutes) : (attendance.earnedPence ?? null);

    await manager.update(Attendance, attendance.id, {
      clockInAt: next.clockInAt,
      clockOutAt: next.clockOutAt ?? undefined,
      breakMinutes: next.breakMinutes ?? undefined,
      status: opts.status,
      workedMinutes: workedMinutes ?? undefined,
      earnedPence: earnedPence ?? undefined,
      ...(opts.recovered ? { clockOutMethod: 'manager_correction' } : {}),
    });
    // Any change to the recorded times invalidates an earlier attendance review: it must be reviewed again.
    await manager.query(
      `UPDATE shift_assignment SET attendance_reviewed_at = NULL, attendance_reviewed_by = NULL WHERE id = $1 AND attendance_reviewed_at IS NOT NULL`,
      [attendance.shiftAssignmentId],
    );
    for (const change of opts.corrections) {
      await manager.save(AttendanceCorrection, {
        organisationId: ctx.organisationId!,
        workspaceId: attendance.workspaceId,
        attendanceId: attendance.id,
        field: change.field,
        oldValue: change.oldValue,
        newValue: change.newValue,
        reason: opts.reason,
        correctedBy: ctx.userId,
      });
    }
    await this.auditService.record(manager, ctx, AuditAction.ATTENDANCE_CORRECTED, {
      entityType: 'attendance',
      entityId: attendance.id,
      metadata: opts.audit,
    });
  }

  /**
   * Manager correction (Parts 42-44) — one field at a time. Always: permission re-checked, scope-checked,
   * reason-required (`CorrectAttendanceDto`'s `@MinLength(10)`), inserted as a first-class `AttendanceCorrection` row
   * (never a silent overwrite), audited, and followed by a fresh `computeWorkedMinutes`/`payForMinutes` recompute so
   * the row's derived numbers never go stale relative to a corrected timestamp/break.
   */
  async correct(ctx: AuthContext, attendanceId: string, dto: CorrectAttendanceDto): Promise<AttendanceSummary> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      // Layer 2: re-checked here, not only by the route guard (other services and jobs call services directly).
      if (!(await this.permissions.userHasPermissionTx(manager, ctx, PermissionFlag.ATTENDANCE_EDIT))) throw new ForbiddenException('Permission required.');
      const attendance = await manager.findOne(Attendance, { where: { id: attendanceId } });
      if (!attendance) throw new NotFoundException('Attendance not found.');
      await this.assertCanManageAttendance(manager, ctx, attendance);

      const shift = await manager.findOneByOrFail(Shift, { id: attendance.shiftId });
      const assignment = await manager.findOneByOrFail(ShiftAssignment, { id: attendance.shiftAssignmentId });

      await this.lockOpenReport(manager, attendance.shiftId);
      // Re-read under a row lock, AFTER the shift lock (same order as finalise): a staff clock-out committing at the
      // same moment is serialised against this correction, and the decision below uses the committed state.
      Object.assign(attendance, await manager.findOneOrFail(Attendance, { where: { id: attendanceId }, lock: { mode: 'pessimistic_write' } }));
      const now = await this.dbNow(manager);

      let oldValue: string;
      let clockInAt = attendance.clockInAt;
      let clockOutAt = attendance.clockOutAt ?? null;
      let breakMinutes = attendance.breakMinutes ?? null;

      if (dto.field === 'clockInAt') {
        oldValue = attendance.clockInAt.toISOString();
        const parsed = new Date(dto.newValue);
        if (Number.isNaN(parsed.getTime())) throw new BadRequestException('newValue must be a valid ISO-8601 timestamp for clockInAt.');
        if (parsed.getTime() > now.getTime()) throw new BadRequestException('A clock-in time cannot be in the future.');
        clockInAt = parsed;
      } else if (dto.field === 'clockOutAt') {
        oldValue = attendance.clockOutAt?.toISOString() ?? '';
        const parsed = new Date(dto.newValue);
        if (Number.isNaN(parsed.getTime())) throw new BadRequestException('newValue must be a valid ISO-8601 timestamp for clockOutAt.');
        if (parsed.getTime() > now.getTime()) throw new BadRequestException('A clock-out time cannot be in the future.');
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

      // Idempotent: re-submitting the value that is already recorded changes nothing — no second correction row, no
      // second audit entry, no status change (a retried or double-tapped save).
      const unchanged =
        (dto.field === 'clockInAt' && clockInAt.getTime() === attendance.clockInAt.getTime()) ||
        (dto.field === 'clockOutAt' && !!attendance.clockOutAt && clockOutAt!.getTime() === attendance.clockOutAt.getTime()) ||
        (dto.field === 'breakMinutes' && attendance.breakMinutes != null && breakMinutes === attendance.breakMinutes);
      if (unchanged) return this.fieldPolicy.omit(await this.fieldPolicy.resolveTx(manager, ctx, 'attendance'), await this.loadSummary(manager, attendance.id));

      const { status, recovered } = this.resolveCorrectionStatus(attendance, assignment, shift, now, clockOutAt);
      await this.persistManagerTimes(manager, ctx, attendance, assignment, shift, { clockInAt, clockOutAt, breakMinutes }, {
        status,
        recovered,
        corrections: [{ field: dto.field, oldValue, newValue: dto.newValue }],
        reason: dto.reason,
        audit: { field: dto.field, oldValue, newValue: dto.newValue, reason: dto.reason, recoveredMissingClockOut: recovered },
      });
      return this.fieldPolicy.omit(await this.fieldPolicy.resolveTx(manager, ctx, 'attendance'), await this.loadSummary(manager, attendance.id));
    });
  }

  /**
   * Validation shared by every manager-ENTERED time (`recordAttendance`). Times are absolute instants, so overnight
   * shifts and the Europe/London DST change are plain millisecond arithmetic. Bounds (FLAGGED ASSUMPTION, owner to
   * confirm): the same window the Shift QR accepts punches in — clock-in no earlier than CLOCK_IN_EARLY_MINUTES before
   * the seat's scheduled start, clock-out no later than QR_POST_SHIFT_GRACE_MINUTES after its scheduled end — never in
   * the future, clock-out strictly after clock-in, and the (recorded or scheduled) unpaid break shorter than the span.
   */
  private assertManagerEnteredTimes(
    window: ScheduledWindow,
    now: Date,
    clockInAt: Date,
    clockOutAt: Date | null,
    effectiveBreakMinutes: number,
  ): void {
    const invalid = (message: string) => new BadRequestException({ statusCode: 400, code: 'INVALID_ATTENDANCE_TIMES', message });
    const early = this.env.get('CLOCK_IN_EARLY_MINUTES');
    const grace = this.env.get('QR_POST_SHIFT_GRACE_MINUTES');
    const earliest = window.startsAt.getTime() - early * 60_000;
    const latest = window.endsAt.getTime() + grace * 60_000;
    if (clockInAt.getTime() > now.getTime()) throw invalid('The clock-in time cannot be in the future.');
    if (clockOutAt && clockOutAt.getTime() > now.getTime()) throw invalid('The clock-out time cannot be in the future.');
    if (clockInAt.getTime() < earliest) throw invalid(`The clock-in time cannot be more than ${early} minutes before the scheduled start.`);
    if (clockInAt.getTime() > latest) throw invalid(`The clock-in time cannot be more than ${grace} minutes after the scheduled end.`);
    if (!clockOutAt) return;
    if (clockOutAt.getTime() > latest) throw invalid(`The clock-out time cannot be more than ${grace} minutes after the scheduled end.`);
    if (clockOutAt.getTime() <= clockInAt.getTime()) throw invalid('The clock-out time must be after the clock-in time.');
    const spanMinutes = Math.round((clockOutAt.getTime() - clockInAt.getTime()) / 60_000);
    if (effectiveBreakMinutes >= spanMinutes) throw invalid('The break must be shorter than the time between clock-in and clock-out.');
  }

  /** Opaque optimistic-concurrency token for one attendance row (microsecond `updated_at`); the report exposes it as `attendanceVersion`. */
  private async attendanceVersion(manager: EntityManager, attendanceId: string): Promise<string> {
    const [row] = await manager.query(`SELECT ${ATTENDANCE_VERSION_SQL('a')} AS v FROM attendance a WHERE a.id = $1`, [attendanceId]);
    return row.v as string;
  }

  /**
   * Venue Manager "Record attendance" for ONE seat of a shift report (owner rule 2026-10-21: missing attendance is not
   * a confirmed no-show). Five layers: route PermissionGuard(ATTENDANCE_EDIT) + venue_manager_app → this permission
   * re-check + report scope (`canReadShift`: assigned venue / own shift; 404 outside) → workspace-bound transaction
   * (organisation/workspace from the session, never the body) → attendance / shift_assignment RLS.
   *
   * - No attendance row (staff never clocked in): creates one marked as manager-entered — `clock_out_method =
   *   'manager_correction'` plus `attendance_correction` rows whose old value is empty (`manuallyEntered` on the
   *   report) — never pretending the app recorded it (no coordinates, `location_verified = false`). Both times are
   *   required. The seat's assignment moves to `completed` through SHIFT_ASSIGNMENT_TRANSITIONS: from `confirmed`, or
   *   from a PROVISIONAL (unreviewed) `no_show`, which this supersedes. A confirmed no-show is refused (reopen first).
   * - Existing row (partial / incorrect): only fields that actually change are written, through the same path as
   *   `correct` (one correction row per field, recompute, review cleared, audit). Valid evidence the manager did not
   *   change is never overwritten.
   *
   * Idempotent (an identical resubmission changes nothing); `expectedVersion` refuses a lost update with 409 when a
   * different manager action landed first. Refused (409) once the report is finalised (payroll records exist from
   * then on). Never marks the attendance review complete: the manager still reviews the seat explicitly.
   */
  async recordAttendance(ctx: AuthContext, shiftId: string, staffProfileId: string, dto: RecordAttendanceDto): Promise<ShiftReportDetail> {
    const note = dto.reasonNote?.trim() ?? '';
    if (dto.reasonCode === 'other' && note.length < 10) {
      throw new BadRequestException('Explain the reason in at least 10 characters.');
    }
    const label = ATTENDANCE_RECORD_REASONS[dto.reasonCode];
    const reason = dto.reasonCode === 'other' ? `Other: ${note}` : note ? `${label}: ${note}` : label;
    const reqIn = dto.clockInAt === undefined ? undefined : new Date(dto.clockInAt);
    const reqOut = dto.clockOutAt === undefined ? undefined : new Date(dto.clockOutAt);

    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      if (!(await this.permissions.userHasPermissionTx(manager, ctx, PermissionFlag.ATTENDANCE_EDIT))) throw new ForbiddenException('Permission required.');
      const shift = await manager.findOne(Shift, { where: { id: shiftId } });
      if (!shift || shift.organisationId !== ctx.organisationId || !(await this.shiftReports.canReadShift(manager, ctx, shift))) {
        throw new NotFoundException('Shift not found.');
      }
      const seat = await manager.findOne(ShiftAssignment, {
        where: { shiftId, staffProfileId, status: In([ShiftAssignmentStatus.CONFIRMED, ShiftAssignmentStatus.COMPLETED, ShiftAssignmentStatus.NO_SHOW]) },
      });
      if (!seat) throw new NotFoundException('Staff member not found on this shift.');

      await this.lockOpenReport(manager, shiftId);
      if (shift.status === ShiftStatus.CANCELLED) throw new ConflictException('This shift was cancelled, so attendance cannot be recorded.');
      const now = await this.dbNow(manager);
      const window = effectiveAssignmentTime(seat, shift);
      const scheduledBreak = effectiveAssignmentBreakMinutes(seat, shift);

      const existing = await manager.findOne(Attendance, { where: { shiftAssignmentId: seat.id } });
      if (existing) {
        await this.recordOnExisting(manager, ctx, existing.id, seat, shift, { reqIn, reqOut, breakMinutes: dto.breakMinutes, scheduledBreak, now, window, reason, dto });
        return this.shiftReports.getReportWithManager(manager, ctx, shiftId);
      }

      // No attendance yet. Parent-first lock order, the same as clock-in (shift, then assignment), so a staff clock-in
      // racing this request is serialised against it; the worker's provisional no-show takes the assignment lock too.
      await manager.findOne(Shift, { where: { id: shiftId }, lock: { mode: 'pessimistic_write' } });
      const assignment = await manager.findOneOrFail(ShiftAssignment, { where: { id: seat.id }, lock: { mode: 'pessimistic_write' } });
      const raced = await manager.findOne(Attendance, { where: { shiftAssignmentId: assignment.id } });
      if (raced) {
        const same =
          !!reqIn && !!reqOut && raced.clockInAt.getTime() === reqIn.getTime() && raced.clockOutAt?.getTime() === reqOut.getTime() &&
          (dto.breakMinutes === undefined || dto.breakMinutes === (raced.breakMinutes ?? scheduledBreak));
        if (same) return this.shiftReports.getReportWithManager(manager, ctx, shiftId);
        throw new ConflictException('Attendance was just recorded for this staff member. Refresh to see it.');
      }
      if (assignment.status === ShiftAssignmentStatus.NO_SHOW) {
        const [{ reviewed }] = await manager.query(`SELECT attendance_reviewed_at IS NOT NULL AS reviewed FROM shift_assignment WHERE id = $1`, [assignment.id]);
        if (reviewed) throw new ConflictException('This no-show has been confirmed. Reopen it before recording attendance.');
      } else if (assignment.status !== ShiftAssignmentStatus.CONFIRMED) {
        throw new ConflictException('Attendance cannot be recorded for this staff member in their current booking state.');
      }
      if (!reqIn || !reqOut) {
        throw new BadRequestException({ statusCode: 400, code: 'INVALID_ATTENDANCE_TIMES', message: 'Enter both the clock-in and clock-out times.' });
      }
      const breakMinutes = dto.breakMinutes ?? null;
      this.assertManagerEnteredTimes(window, now, reqIn, reqOut, breakMinutes ?? scheduledBreak);

      const { workedMinutes } = computeWorkedMinutes({ clockInAt: reqIn, clockOutAt: reqOut, scheduledBreakMinutes: breakMinutes ?? scheduledBreak });
      const earnedPence = payForMinutes(assignment.payRateSnapshotPence, workedMinutes);
      const supersededProvisionalNoShow = assignment.status === ShiftAssignmentStatus.NO_SHOW;
      assertTransition(SHIFT_ASSIGNMENT_TRANSITIONS, assignment.status, ShiftAssignmentStatus.COMPLETED);
      assertTransition(ATTENDANCE_TRANSITIONS, AttendanceStatus.CLOCKED_OUT, AttendanceStatus.UNDER_REVIEW);

      const attendance = manager.create(Attendance, {
        organisationId: ctx.organisationId!,
        workspaceId: shift.workspaceId,
        shiftAssignmentId: assignment.id,
        shiftId: shift.id,
        staffProfileId: assignment.staffProfileId,
        clockInAt: reqIn,
        clockOutAt: reqOut,
        breakMinutes: breakMinutes ?? undefined,
        status: AttendanceStatus.UNDER_REVIEW,
        workedMinutes,
        earnedPence,
        // Provenance: never presented as an app punch — no location, not verified, manager-recorded clock-in/out.
        locationVerified: false,
        clockInMethod: 'manager_correction',
        clockOutMethod: 'manager_correction',
      });
      try {
        await manager.save(attendance);
        const moved = await manager.query(`UPDATE shift_assignment SET status = $3 WHERE id = $1 AND status = $2`, [
          assignment.id,
          assignment.status,
          ShiftAssignmentStatus.COMPLETED,
        ]);
        if (!(moved as [unknown, number])[1]) throw new ConflictException('This booking changed while saving. Refresh and try again.');
      } catch (error) {
        const code = (error as { code?: string })?.code;
        if (code === '23P01') throw new ConflictException('This staff member has another booking that overlaps this shift, so attendance cannot be recorded here.');
        if (isUniqueViolation(error)) throw new ConflictException('Attendance was just recorded for this staff member. Refresh to see it.');
        throw error;
      }

      // Same shift roll-up as a staff clock-out: the shift completes only once no sibling seat is still open.
      const openSiblings = await manager.count(ShiftAssignment, {
        where: { shiftId: shift.id, status: In([ShiftAssignmentStatus.OFFERED, ShiftAssignmentStatus.STAFF_ACCEPTED, ShiftAssignmentStatus.CONFIRMED]) },
      });
      const freshShift = await manager.findOneByOrFail(Shift, { id: shift.id });
      if (openSiblings === 0 && freshShift.status === ShiftStatus.IN_PROGRESS) {
        assertTransition(SHIFT_TRANSITIONS, freshShift.status, ShiftStatus.COMPLETED);
        await manager.update(Shift, shift.id, { status: ShiftStatus.COMPLETED });
      }

      const corrections = [
        { field: 'clockInAt', oldValue: '', newValue: reqIn.toISOString() },
        { field: 'clockOutAt', oldValue: '', newValue: reqOut.toISOString() },
        ...(breakMinutes != null ? [{ field: 'breakMinutes', oldValue: '', newValue: String(breakMinutes) }] : []),
      ];
      for (const change of corrections) {
        await manager.save(AttendanceCorrection, {
          organisationId: ctx.organisationId!,
          workspaceId: attendance.workspaceId,
          attendanceId: attendance.id,
          field: change.field,
          oldValue: change.oldValue,
          newValue: change.newValue,
          reason,
          correctedBy: ctx.userId,
        });
      }
      await this.auditService.record(manager, ctx, AuditAction.ATTENDANCE_MANAGER_RECORDED, {
        entityType: 'attendance',
        entityId: attendance.id,
        metadata: {
          shiftId,
          staffProfileId,
          assignmentId: assignment.id,
          reasonCode: dto.reasonCode,
          reason,
          before: { assignmentStatus: assignment.status, clockInAt: null, clockOutAt: null, breakMinutes: null },
          after: { assignmentStatus: ShiftAssignmentStatus.COMPLETED, clockInAt: reqIn.toISOString(), clockOutAt: reqOut.toISOString(), breakMinutes },
          workedMinutes,
          earnedPence,
          supersededProvisionalNoShow,
        },
      });
      return this.shiftReports.getReportWithManager(manager, ctx, shiftId);
    });
  }

  /** `recordAttendance` on a seat that already has attendance: change only what differs, through the shared write path. */
  private async recordOnExisting(
    manager: EntityManager,
    ctx: AuthContext,
    attendanceId: string,
    seat: ShiftAssignment,
    shift: Shift,
    input: {
      reqIn?: Date;
      reqOut?: Date;
      breakMinutes?: number;
      scheduledBreak: number;
      now: Date;
      window: ScheduledWindow;
      reason: string;
      dto: RecordAttendanceDto;
    },
  ): Promise<void> {
    // Row lock after the report lock — the same order as `correct` and a staff clock-out's claim.
    const attendance = await manager.findOneOrFail(Attendance, { where: { id: attendanceId }, lock: { mode: 'pessimistic_write' } });
    const assignment = await manager.findOneByOrFail(ShiftAssignment, { id: seat.id });
    const currentVersion = await this.attendanceVersion(manager, attendance.id);

    const clockInAt = input.reqIn ?? attendance.clockInAt;
    const clockOutAt = input.reqOut ?? attendance.clockOutAt ?? null;
    // A break equal to what already applies (stored, or the scheduled default when none is stored) is no change.
    const storedBreak = attendance.breakMinutes ?? null;
    const breakMinutes =
      input.breakMinutes === undefined || input.breakMinutes === (storedBreak ?? input.scheduledBreak) ? storedBreak : input.breakMinutes;

    const corrections: Array<{ field: string; oldValue: string; newValue: string }> = [];
    if (clockInAt.getTime() !== attendance.clockInAt.getTime()) {
      corrections.push({ field: 'clockInAt', oldValue: attendance.clockInAt.toISOString(), newValue: clockInAt.toISOString() });
    }
    if (clockOutAt && clockOutAt.getTime() !== attendance.clockOutAt?.getTime()) {
      corrections.push({ field: 'clockOutAt', oldValue: attendance.clockOutAt?.toISOString() ?? '', newValue: clockOutAt.toISOString() });
    }
    if (breakMinutes !== storedBreak) {
      corrections.push({ field: 'breakMinutes', oldValue: storedBreak != null ? String(storedBreak) : '', newValue: String(breakMinutes) });
    }
    if (corrections.length === 0) return; // idempotent: an identical resubmission writes nothing

    if ((input.dto.expectedVersion ?? null) !== currentVersion) {
      throw new ConflictException('This attendance was changed by someone else. Refresh to see the latest times.');
    }
    this.assertManagerEnteredTimes(input.window, input.now, clockInAt, clockOutAt, breakMinutes ?? input.scheduledBreak);
    const { status, recovered } = this.resolveCorrectionStatus(attendance, assignment, shift, input.now, clockOutAt);
    const before = {
      clockInAt: attendance.clockInAt.toISOString(),
      clockOutAt: attendance.clockOutAt?.toISOString() ?? null,
      breakMinutes: storedBreak,
      status: attendance.status,
    };
    await this.persistManagerTimes(manager, ctx, attendance, assignment, shift, { clockInAt, clockOutAt, breakMinutes }, {
      status,
      recovered,
      corrections,
      reason: input.reason,
      audit: {
        source: 'record_attendance',
        fields: corrections.map((c) => c.field),
        reasonCode: input.dto.reasonCode,
        reason: input.reason,
        before,
        after: { clockInAt: clockInAt.toISOString(), clockOutAt: clockOutAt?.toISOString() ?? null, breakMinutes, status },
        recoveredMissingClockOut: recovered,
      },
    });
  }
}
