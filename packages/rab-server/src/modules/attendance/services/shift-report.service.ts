import { effectiveAssignmentBreakMinutes } from '../../scheduling/utils/assignment-time';
import { assignmentTimeSql } from '../../scheduling/utils/assignment-time';
import { isReportFinalisable, isReportReady } from './report-readiness';
import { ReportActions, reportActions } from './report-actions';
import { DeliveryCounts, REPORT_IN_HISTORY_SQL, REPORT_NEEDS_ATTENTION_SQL, ReportLifecycle, reportLifecycle } from './report-lifecycle';
import { ListShiftReportsDto } from '../dto/list-shift-reports.dto';
import { FinaliseReportDto } from '../dto/staff-review.dto';
import { paginationSkipTake } from '../../../engine/dto/pagination.dto';
import { assertTransition, ATTENDANCE_TRANSITIONS, AttendanceStatus, PermissionFlag, SHIFT_ASSIGNMENT_TRANSITIONS, ShiftAssignmentStatus } from '@rab/shared';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';

import { Shift } from '../../scheduling/entities/shift.entity';
import { ShiftAssignment } from '../../scheduling/entities/shift-assignment.entity';
import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { EnvironmentService } from '../../../engine/core-modules/environment/environment.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { Attendance } from '../entities/attendance.entity';
import { AttendanceCorrection } from '../entities/attendance-correction.entity';
import { ShiftReport } from '../entities/shift-report.entity';
import { PayrollService } from '../../payroll/services/payroll.service';
import { NO_SHOW_GRACE_MINUTES } from './no-show-policy';
import { loadShiftVacancy } from '../../offer/services/shift-vacancy';

/** Opaque optimistic-concurrency token of one attendance row (microsecond `updated_at`), exposed as `attendanceVersion`. */
export const ATTENDANCE_VERSION_SQL = (alias: string) =>
  `to_char(${alias}.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface ShiftReportStaffRow {
  staffProfileId: string;
  avatarFileId: string | null;
  staffName: string;
  roleName: string;
  assignmentStatus: string;
  attendanceId: string | null;
  attendanceStatus: string | null;
  clockInAt: string | null;
  clockOutAt: string | null;
  breakMinutes: number | null;
  scheduledBreakMinutes: number;
  scheduledStart: string;
  scheduledEnd: string;
  workedMinutes: number | null;
  earnedPence: number | null;
  locationVerified: boolean;
  clockOutMethod: string | null;
  corrected: boolean;
  /** A per-shift staff PERFORMANCE rating has been saved (shift_staff_review). Not the attendance review. */
  performanceReviewed: boolean;
  /** The manager completed this seat's ATTENDANCE review (shift_assignment.attendance_reviewed_at). */
  attendanceReviewed: boolean;
  attendanceReviewedAt: string | null;
  attendanceReviewedByName: string | null;
  /**
   * The attendance was ENTERED by a manager (the staff member never clocked in with the app): its clock-in exists only
   * as a manager correction from nothing (`attendance_correction` clockInAt with an empty old value).
   */
  manuallyEntered: boolean;
  /** Optimistic-concurrency token for "Record attendance" (`expectedVersion`); null when no attendance exists. */
  attendanceVersion: string | null;
  /**
   * `assignmentStatus = 'no_show'` alone is the worker's PROVISIONAL mark (owner rule 2026-10-21). It is a confirmed
   * no-show only once a manager reviewed it (`attendanceReviewed`). No hours or pay either way.
   */
  noShowConfirmed: boolean;
  /** Earliest moment a manager may confirm this seat as a no-show (scheduled start + NO_SHOW_GRACE_MINUTES). */
  noShowConfirmableAt: string;
  /** The booking must be checked in before clock-in (false only for bookings made before Check In shipped). */
  checkInRequired: boolean;
  /** Server time of the staff member's Check In (arrival evidence, not worked time), or null. */
  checkedInAt: string | null;
  /** 'staff' (app) | 'qr' (Shift QR scanned) | null. */
  checkInSource: string | null;
  /** The Check In passed the venue's enforced geofence. */
  checkInLocationVerified: boolean;
  /** 'staff' | 'manager_on_behalf' | 'manager_correction' | null (attendance recorded before this existed / none). */
  clockInMethod: string | null;
  /** On-behalf punches: the Venue Manager's name and the reason they gave (null otherwise). */
  clockInByName: string | null;
  clockInReason: string | null;
  clockOutByName: string | null;
  clockOutReason: string | null;
}

export interface ShiftReportDetail {
  shiftId: string;
  venueName: string;
  roleName: string;
  startsAt: string;
  endsAt: string;
  reportStatus: 'pending' | 'ready' | 'finalised';
  finalisedAt: string | null;
  finalisedBy: string | null;
  staff: ShiftReportStaffRow[];
  ready: boolean;
  /** Finalise & send is allowed: attendance resolved AND every seat's attendance reviewed (server authority). */
  finalisable: boolean;
  /** Seats whose attendance review is still outstanding. */
  reviewsRemaining: number;
  originalFileId: string | null;
  signedFileId: string | null;
  finalisedByName: string | null;
  /** Server-time lifecycle (five-hour policy, `report-lifecycle.ts`). */
  lifecycle: ReportLifecycle;
  serverNow: string;
  /** Pre-shift roster + Shift QR PDF (download via /files/:id/download, ReportFilePolicy). */
  preShiftFile: ReportFileRef | null;
  /** Final signed timesheet PDF. */
  finalFile: ReportFileRef | null;
  /**
   * The QR clock-in/out window (CLOCK_IN_EARLY_MINUTES before start .. QR_POST_SHIFT_GRACE_MINUTES after end), the same
   * bounds AttendanceQrService signs into the Shift QR. Display only; clock-in/out enforcement is unchanged.
   */
  qrWindow: { opensAt: string; closesAt: string; state: 'not_open' | 'open' | 'closed' };
  /** Footer + Time-sheet document, decided from DB time (`report-actions.ts`). */
  actions: ReportActions;
  /** Typed sign-off recorded with finalisation (null for reports finalised before sign-off existed). */
  signOff: { name: string; breakConfirmed: boolean; signedBy: string | null; signedAt: string | null } | null;
  /**
   * On-behalf punch rules for this shift's venue (display hints; the server enforces them): the venue enforces its
   * geofence → clock-in on behalf needs a location-verified Check In, clock-out on behalf is unavailable.
   */
  attendancePolicy: { geofenceEnforced: boolean; onBehalfClockOutAllowed: boolean; onBehalfReasonMinWords: number };
}

export interface ReportFileRef {
  fileId: string;
  filename: string;
}

/** One row of the Reports / History lists. Counts only; never staff identities. */
export interface ShiftReportSummary {
  shiftId: string;
  venueName: string;
  roleName: string;
  startsAt: string;
  endsAt: string;
  shiftStatus: string;
  requiredCount: number;
  filledCount: number;
  staffCount: number;
  clockedOut: number;
  noShows: number;
  reportStatus: 'pending' | 'ready' | 'finalised';
  lifecycle: ReportLifecycle;
}

const REPORT_SUMMARY_SELECT = `
  SELECT s.id, s.starts_at, s.ends_at, v.name AS venue_name, jr.name AS role_name, v.enforce_geofence
  FROM shift s
  JOIN venue v ON v.id = s.venue_id
  JOIN job_role jr ON jr.id = s.job_role_id
  WHERE s.id = $1
`;

/**
 * Venue Manager attendance Report (Parts 38-51) — read (`getReport`) and
 * finalisation (`finalise`). Deliberately does NOT generate or store PDFs;
 * that's the worker's job (`packages/rab-worker/src/queues/rab-reports/*.job.ts`, Phase J/L) —
 * this service only ever touches `Attendance`/`ShiftReport` rows
 * synchronously, keeping `finalise()` fast for the manager (PDF+email
 * happen on the worker's next tick, per Part 46's "no PDF/email work in the
 * request path" rule).
 */
@Injectable()
export class ShiftReportService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly resourceScope: ResourceScopeService,
    private readonly auditService: AuditService,
    private readonly env: EnvironmentService,
    private readonly permissions: PermissionsService,
    private readonly payroll: PayrollService,
  ) {}

  /**
   * The ONE definition of "may this caller see this shift's report": a Venue Manager sees only their assigned venues'
   * reports; a plain Manager only shifts they created. Shared by the report endpoint AND by report-file downloads
   * (`ReportFilePolicy`) so the two can never drift apart.
   */
  async canReadShift(manager: EntityManager, ctx: AuthContext, shift: Shift): Promise<boolean> {
    const scope = await this.resourceScope.resolveTx(manager, ctx);
    if (scope.kind === 'owner' && shift.createdBy === ctx.userId) return true;
    if (scope.kind === 'venue' && scope.venueIds.includes(shift.venueId)) return true;
    return false;
  }

  /** Same shape as `SchedulingService.assertShiftOwned`. 404, not 403, when out of scope. */
  private async assertShiftOwned(manager: EntityManager, ctx: AuthContext, shift: Shift): Promise<void> {
    if (await this.canReadShift(manager, ctx, shift)) return;
    throw new NotFoundException('Shift not found.');
  }

  /**
   * Reports (`bucket=current`) and History (`bucket=history`), filtered and paginated in SQL against DB time with the
   * SAME scope rule as `canReadShift` (Venue Manager: assigned venues; Manager: shifts they created). Workspace RLS
   * applies underneath. Draft / pending-approval / declined requests are not shifts with a report and are excluded.
   */
  async listReports(ctx: AuthContext, dto: ListShiftReportsDto): Promise<{ data: ShiftReportSummary[]; total: number; serverNow: string }> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const scope = await this.resourceScope.resolveTx(manager, ctx);
      const params: unknown[] = [ctx.organisationId];
      let scopeSql: string;
      if (scope.kind === 'venue') {
        params.push(scope.venueIds);
        scopeSql = `s.venue_id = ANY($${params.length}::uuid[])`;
      } else {
        params.push(ctx.userId);
        scopeSql = `s.created_by = $${params.length}`;
      }
      const { skip, take } = paginationSkipTake({ page: dto.page, limit: dto.limit ?? 50 });
      params.push(take, skip);
      const bucketSql = dto.bucket === 'history' ? REPORT_IN_HISTORY_SQL : `(NOT ${REPORT_IN_HISTORY_SQL} OR ${REPORT_NEEDS_ATTENTION_SQL})`;
      const order = dto.bucket === 'history' ? 'r.ends_at DESC, r.shift_id' : `${REPORT_NEEDS_ATTENTION_SQL} DESC, r.starts_at ASC, r.shift_id`;
      const rows = await manager.query(`${REPORT_ROWS_SQL(scopeSql)}
        SELECT r.*, now() AS db_now, count(*) OVER () AS total FROM rows r
        WHERE ${bucketSql}
        ORDER BY ${order}
        LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
      const dbNow = rows[0]?.db_now ? new Date(rows[0].db_now) : new Date((await manager.query('SELECT now() AS n'))[0].n);
      return {
        data: rows.map((r: Record<string, any>) => toSummary(r, dbNow)),
        total: rows[0] ? Number(rows[0].total) : 0,
        serverNow: dbNow.toISOString(),
      };
    });
  }

  async getReport(ctx: AuthContext, shiftId: string): Promise<ShiftReportDetail> {
    return this.tenantContext.runInWorkspaceContext(ctx, manager => this.getReportWithManager(manager, ctx, shiftId));
  }

  /** Existing report projection, batched and callable inside the pipeline transaction. */
  async getReportWithManager(manager: EntityManager, ctx: AuthContext, shiftId: string): Promise<ShiftReportDetail> {
    const shift = await manager.findOne(Shift, { where: { id: shiftId } });
    if (!shift || shift.organisationId !== ctx.organisationId) throw new NotFoundException('Shift not found.');
    await this.assertShiftOwned(manager, ctx, shift);
    const [summary] = await manager.query(REPORT_SUMMARY_SELECT, [shiftId]);
    const report = await manager.findOne(ShiftReport, { where: { shiftId } });
    const rows = await manager.query(`SELECT sp.id AS "staffProfileId", u.first_name || ' ' || u.last_name AS "staffName", u.avatar_file_id AS "avatarFileId",
      ${assignmentTimeSql().start} AS "scheduledStart", ${assignmentTimeSql().end} AS "scheduledEnd", sa.status AS "assignmentStatus", a.id AS "attendanceId", a.status AS "attendanceStatus", a.clock_in_at AS "clockInAt", a.clock_out_at AS "clockOutAt",
      sa.break_minutes AS "assignmentBreakMinutes", a.break_minutes AS "breakMinutes", a.worked_minutes AS "workedMinutes", a.earned_pence AS "earnedPence", a.location_verified AS "locationVerified", a.clock_out_method AS "clockOutMethod",
      EXISTS (SELECT 1 FROM attendance_correction ac WHERE ac.attendance_id=a.id) AS corrected,
      EXISTS (SELECT 1 FROM attendance_correction ac WHERE ac.attendance_id=a.id AND ac.field='clockInAt' AND ac.old_value='') AS "manuallyEntered",
      CASE WHEN a.id IS NULL THEN NULL ELSE ${ATTENDANCE_VERSION_SQL('a')} END AS "attendanceVersion",
      EXISTS (SELECT 1 FROM shift_staff_review rv WHERE rv.shift_id=sa.shift_id AND rv.staff_profile_id=sa.staff_profile_id) AS "performanceReviewed",
      sa.attendance_reviewed_at AS "attendanceReviewedAt",
      (SELECT ru.first_name || ' ' || ru.last_name FROM core."user" ru WHERE ru.id = sa.attendance_reviewed_by) AS "attendanceReviewedByName",
      sa.check_in_required AS "checkInRequired", sa.checked_in_at AS "checkedInAt", sa.check_in_source AS "checkInSource",
      sa.check_in_location_verified AS "checkInLocationVerified", a.clock_in_method AS "clockInMethod",
      a.clock_in_reason AS "clockInReason", a.clock_out_reason AS "clockOutReason",
      (SELECT cu.first_name || ' ' || cu.last_name FROM core."user" cu WHERE cu.id = a.clock_in_by) AS "clockInByName",
      (SELECT ou.first_name || ' ' || ou.last_name FROM core."user" ou WHERE ou.id = a.clock_out_by) AS "clockOutByName"
      FROM shift_assignment sa JOIN shift s ON s.id=sa.shift_id JOIN staff_profile sp ON sp.id=sa.staff_profile_id JOIN core."user" u ON u.id=sp.user_id
      LEFT JOIN attendance a ON a.shift_assignment_id=sa.id
      WHERE sa.shift_id=$1 AND sa.status IN ('confirmed','completed','no_show') ORDER BY u.first_name,u.last_name,sa.id`, [shiftId]);
    const staff: ShiftReportStaffRow[] = rows.map((r: any) => ({ ...r, roleName: summary.role_name, scheduledBreakMinutes: effectiveAssignmentBreakMinutes({ breakMinutes: r.assignmentBreakMinutes }, shift),
      clockInAt: r.clockInAt ? new Date(r.clockInAt).toISOString() : null, clockOutAt: r.clockOutAt ? new Date(r.clockOutAt).toISOString() : null,
      earnedPence: r.earnedPence == null ? null : Number(r.earnedPence), locationVerified: !!r.locationVerified, performanceReviewed: !!r.performanceReviewed,
      attendanceReviewed: !!r.attendanceReviewedAt, attendanceReviewedAt: r.attendanceReviewedAt ? new Date(r.attendanceReviewedAt).toISOString() : null,
      manuallyEntered: !!r.manuallyEntered, attendanceVersion: r.attendanceVersion ?? null,
      noShowConfirmed: r.assignmentStatus === 'no_show' && !!r.attendanceReviewedAt,
      noShowConfirmableAt: new Date(new Date(r.scheduledStart).getTime() + NO_SHOW_GRACE_MINUTES * 60_000).toISOString(),
      checkInRequired: !!r.checkInRequired, checkedInAt: r.checkedInAt ? new Date(r.checkedInAt).toISOString() : null,
      checkInSource: r.checkInSource ?? null, checkInLocationVerified: !!r.checkInLocationVerified, clockInMethod: r.clockInMethod ?? null,
      clockInByName: r.clockInByName ?? null, clockInReason: r.clockInReason ?? null,
      clockOutByName: r.clockOutByName ?? null, clockOutReason: r.clockOutReason ?? null }));
    const finaliser = report?.finalisedBy ? (await manager.query('SELECT first_name || \' \' || last_name AS name FROM core."user" WHERE id=$1', [report.finalisedBy]))[0] : null;
    const reportStatus = (report?.status as ShiftReportDetail['reportStatus']) ?? 'pending';
    const [{ db_now: dbNowRaw }] = await manager.query('SELECT now() AS db_now');
    const dbNow = new Date(dbNowRaw);
    const delivery = await this.deliveryCounts(manager, report?.finalFileId ?? null);
    const files = await this.fileRefs(manager, [report?.preShiftFileId ?? null, report?.finalFileId ?? null]);
    const [signOffRow] = report ? await manager.query(`SELECT signed_off_name, break_confirmed FROM shift_report WHERE id = $1`, [report.id]) : [];
    const lifecycle = reportLifecycle({
      now: dbNow, shiftStatus: shift.status, startsAt: new Date(summary.starts_at), endsAt: new Date(summary.ends_at),
      staffCount: staff.length,
      openAttendance: staff.filter((r) => r.attendanceStatus === 'clocked_in' || r.attendanceStatus === 'on_break').length,
      unresolved: staff.filter((r) => r.assignmentStatus !== 'no_show' && !r.clockOutAt).length,
      unreviewed: staff.filter((r) => !r.attendanceReviewed).length,
      anyClockIn: staff.some((r) => r.attendanceId !== null),
      reportStatus, finalQueuedAt: report?.finalPdfSentAt ?? null, delivery,
    });
    return { shiftId, venueName: summary.venue_name, roleName: summary.role_name, startsAt: new Date(summary.starts_at).toISOString(), endsAt: new Date(summary.ends_at).toISOString(),
      reportStatus, finalisedAt: report?.finalisedAt?.toISOString() ?? null, finalisedBy: report?.finalisedBy ?? null,
      finalisedByName: finaliser?.name ?? null, originalFileId: report?.originalFileId ?? null, signedFileId: report?.finalFileId ?? null, ready: isReportReady(staff), staff,
      finalisable: reportStatus !== 'finalised' && isReportFinalisable(staff), reviewsRemaining: staff.filter((r) => !r.attendanceReviewed).length,
      lifecycle, serverNow: dbNow.toISOString(), qrWindow: this.qrWindow(new Date(summary.starts_at), new Date(summary.ends_at), dbNow),
      actions: reportActions({
        now: dbNow, startsAt: new Date(summary.starts_at), shiftStatus: shift.status,
        reportAvailableBeforeMinutes: this.env.get('REPORT_AVAILABLE_BEFORE_MINUTES'), reportStatus, ready: isReportFinalisable(staff),
        preShiftFile: report?.preShiftFileId ? files.get(report.preShiftFileId) ?? null : null,
        finalFile: report?.finalFileId ? files.get(report.finalFileId) ?? null : null,
      }),
      preShiftFile: report?.preShiftFileId ? files.get(report.preShiftFileId) ?? null : null,
      finalFile: report?.finalFileId ? files.get(report.finalFileId) ?? null : null,
      signOff: signOffRow?.signed_off_name ? { name: signOffRow.signed_off_name, breakConfirmed: !!signOffRow.break_confirmed, signedBy: finaliser?.name ?? null, signedAt: report?.finalisedAt?.toISOString() ?? null } : null,
      attendancePolicy: { geofenceEnforced: !!summary.enforce_geofence, onBehalfClockOutAllowed: !summary.enforce_geofence, onBehalfReasonMinWords: 10 } };
  }

  private qrWindow(startsAt: Date, endsAt: Date, now: Date): ShiftReportDetail['qrWindow'] {
    const opens = startsAt.getTime() - this.env.get('CLOCK_IN_EARLY_MINUTES') * 60_000;
    const closes = endsAt.getTime() + this.env.get('QR_POST_SHIFT_GRACE_MINUTES') * 60_000;
    const t = now.getTime();
    return { opensAt: new Date(opens).toISOString(), closesAt: new Date(closes).toISOString(), state: t < opens ? 'not_open' : t < closes ? 'open' : 'closed' };
  }

  /**
   * The shared opening of every seat-level attendance action (review, confirm / reopen no-show): permission re-check
   * (layer 2) → report scope (`canReadShift`, 404 out of scope) → the shift's finalise lock → refused once the report
   * is finalised → the seat row locked (`FOR UPDATE OF sa`), so a concurrent "Record attendance", another manager's
   * action or the worker's provisional no-show is serialised against this one and decided on committed state.
   */
  private async lockSeat(manager: EntityManager, ctx: AuthContext, shiftId: string, staffProfileId: string, finalisedMessage: string, lockShift = false) {
    if (!(await this.permissions.userHasPermissionTx(manager, ctx, PermissionFlag.ATTENDANCE_EDIT))) throw new ForbiddenException('Permission required.');
    const shift = await manager.findOne(Shift, { where: { id: shiftId } });
    if (!shift || shift.organisationId !== ctx.organisationId) throw new NotFoundException('Shift not found.');
    await this.assertShiftOwned(manager, ctx, shift);
    await manager.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`finalise:${shiftId}`]);
    const [report] = await manager.query(`SELECT status FROM shift_report WHERE shift_id = $1`, [shiftId]);
    if (report?.status === 'finalised') throw new ConflictException(finalisedMessage);
    // Seat-capacity decisions take the shift row lock BEFORE the seat lock — the same parent-first order as clock-in,
    // Record attendance and the replacement approval claim (`applyOfferConfirmation`), so they serialise, never deadlock.
    if (lockShift) await manager.query(`SELECT 1 FROM shift WHERE id = $1 FOR UPDATE`, [shiftId]);
    const [seat] = await manager.query(
      `SELECT sa.id, sa.status AS assignment_status, sa.attendance_reviewed_at, a.id AS attendance_id, a.status AS attendance_status, a.clock_out_at,
              now() >= s.starts_at AS shift_started,
              now() >= ${assignmentTimeSql().start} + make_interval(mins => $3) AS no_show_due
         FROM shift_assignment sa JOIN shift s ON s.id = sa.shift_id LEFT JOIN attendance a ON a.shift_assignment_id = sa.id
        WHERE sa.shift_id = $1 AND sa.staff_profile_id = $2 AND sa.status IN ('confirmed','completed','no_show')
        FOR UPDATE OF sa`,
      [shiftId, staffProfileId, NO_SHOW_GRACE_MINUTES],
    );
    if (!seat) throw new NotFoundException('Staff member not found on this shift.');
    return seat as {
      id: string; assignment_status: string; attendance_reviewed_at: Date | null; attendance_id: string | null;
      attendance_status: string | null; clock_out_at: Date | null; shift_started: boolean; no_show_due: boolean;
    };
  }

  /**
   * Completes ONE seat's attendance review (owner brief 2026-10-18). Five layers: route PermissionGuard(ATTENDANCE_EDIT)
   * → `lockSeat` (permission re-check, scope 404, finalise lock, seat row lock) → shift_assignment RLS. Only a RESOLVED
   * seat can be reviewed: a recorded clock-out, or a no-show (reviewing a provisional no-show confirms it — kept for
   * older clients; new clients use the explicit `confirmNoShow`). Still clocked in / missing clock-out / no attendance
   * → 409. Idempotent; refused once the report is finalised. Any later correction clears the review.
   */
  async reviewAttendance(ctx: AuthContext, shiftId: string, staffProfileId: string): Promise<ShiftReportDetail> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const seat = await this.lockSeat(manager, ctx, shiftId, staffProfileId, 'This shift report has been finalised; attendance can no longer be reviewed.');
      if (!seat.shift_started) throw new ConflictException('Attendance can be reviewed once the shift has started.');
      if (!seat.attendance_reviewed_at) {
        const open = ['clocked_in', 'on_break'].includes(seat.attendance_status ?? '');
        if (open) throw new ConflictException('This staff member is still clocked in. Their attendance can be reviewed after they clock out.');
        if (seat.assignment_status !== 'no_show' && !seat.clock_out_at) {
          throw new ConflictException(seat.attendance_status
            ? 'The clock-out time is missing. Add it as a correction before marking attendance as reviewed.'
            : 'No attendance has been recorded yet. Record the attendance, or confirm the no-show.');
        }
        await manager.query(`UPDATE shift_assignment SET attendance_reviewed_at = now(), attendance_reviewed_by = $2 WHERE id = $1`, [seat.id, ctx.userId]);
        await this.auditService.record(manager, ctx, AuditAction.ATTENDANCE_REVIEWED, {
          entityType: 'shift_assignment',
          entityId: seat.id,
          metadata: { shiftId, staffProfileId, outcome: seat.assignment_status === 'no_show' ? 'no_show' : 'attended' },
        });
      }
      return this.getReportWithManager(manager, ctx, shiftId);
    });
  }

  /**
   * "Confirm no-show" (owner rule 2026-10-21): the manager's explicit decision that the staff member did not attend.
   * The worker's `no_show` is only provisional; this sets the seat's attendance review (the existing finalise gate),
   * which is what makes it final — no hours, no pay. Refused (409) when ANY attendance exists for the seat (valid
   * recorded attendance is never overridden by a no-show), before NO_SHOW_GRACE_MINUTES past the scheduled start, and
   * after finalisation. If the worker has not flagged the seat yet but the grace has passed, the manager's confirmation
   * performs the same `confirmed → no_show` transition itself (SHIFT_ASSIGNMENT_TRANSITIONS). Idempotent.
   */
  async confirmNoShow(ctx: AuthContext, shiftId: string, staffProfileId: string): Promise<ShiftReportDetail> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const seat = await this.lockSeat(manager, ctx, shiftId, staffProfileId, 'This shift report has been finalised; attendance can no longer be changed.');
      if (seat.attendance_id) {
        throw new ConflictException('Attendance has been recorded for this staff member, so they cannot be confirmed as a no-show. Review the recorded attendance instead.');
      }
      if (seat.assignment_status === 'no_show' && seat.attendance_reviewed_at) return this.getReportWithManager(manager, ctx, shiftId);
      if (seat.assignment_status === 'confirmed') {
        if (!seat.no_show_due) {
          throw new ConflictException(`A no-show can be confirmed ${NO_SHOW_GRACE_MINUTES} minutes after the scheduled start.`);
        }
        assertTransition(SHIFT_ASSIGNMENT_TRANSITIONS, ShiftAssignmentStatus.CONFIRMED, ShiftAssignmentStatus.NO_SHOW);
        await manager.query(`UPDATE shift_assignment SET status = 'no_show' WHERE id = $1 AND status = 'confirmed'`, [seat.id]);
      } else if (seat.assignment_status !== 'no_show') {
        throw new ConflictException('This staff member cannot be confirmed as a no-show in their current booking state.');
      }
      await manager.query(`UPDATE shift_assignment SET attendance_reviewed_at = now(), attendance_reviewed_by = $2 WHERE id = $1`, [seat.id, ctx.userId]);
      await this.auditService.record(manager, ctx, AuditAction.ATTENDANCE_NO_SHOW_CONFIRMED, {
        entityType: 'shift_assignment',
        entityId: seat.id,
        metadata: { shiftId, staffProfileId, provisionalMarkedBy: seat.assignment_status === 'no_show' ? 'worker' : 'manager' },
      });
      return this.getReportWithManager(manager, ctx, shiftId);
    });
  }

  /**
   * Reopens a CONFIRMED no-show back to provisional (review cleared; the seat stays `no_show`, nothing is deleted), so a
   * manager can then record verified attendance. Authorised exactly like the confirmation (ATTENDANCE_EDIT, same report
   * scope), reason required and audited, refused once the report is finalised (FLAGGED: no post-finalisation reopen
   * exists in v1). A provisional no-show or an attended seat has nothing to reopen (409).
   */
  async reopenNoShow(ctx: AuthContext, shiftId: string, staffProfileId: string, reason: string): Promise<ShiftReportDetail> {
    const why = reason.trim();
    if (why.length < 10) throw new BadRequestException('Explain why the no-show is being reopened in at least 10 characters.');
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const seat = await this.lockSeat(manager, ctx, shiftId, staffProfileId, 'This shift report has been finalised; the no-show can no longer be reopened.', true);
      if (seat.assignment_status !== 'no_show' || !seat.attendance_reviewed_at) {
        throw new ConflictException('Only a confirmed no-show can be reopened.');
      }
      // A confirmed no-show frees its seat (shift-vacancy.ts); reopening makes it occupy one again. If a replacement has
      // taken that seat since, reopening would book more staff than required — refused (agent R's seat rule, not re-derived).
      if ((await loadShiftVacancy(manager, shiftId)).vacancy < 1) {
        throw new ConflictException({
          statusCode: 409,
          code: 'SEAT_TAKEN_BY_REPLACEMENT',
          message: "A replacement already holds this staff member's seat, so the no-show can no longer be reopened.",
        });
      }
      await manager.query(`UPDATE shift_assignment SET attendance_reviewed_at = NULL, attendance_reviewed_by = NULL WHERE id = $1`, [seat.id]);
      await this.auditService.record(manager, ctx, AuditAction.ATTENDANCE_NO_SHOW_REOPENED, {
        entityType: 'shift_assignment',
        entityId: seat.id,
        metadata: { shiftId, staffProfileId, reason: why, previouslyConfirmedAt: new Date(seat.attendance_reviewed_at).toISOString() },
      });
      return this.getReportWithManager(manager, ctx, shiftId);
    });
  }

  /** Delivery of the FINAL timesheet file: its outbox rows (one per recipient), CANCELLED excluded. */
  private async deliveryCounts(manager: EntityManager, finalFileId: string | null): Promise<DeliveryCounts> {
    if (!finalFileId) return { pending: 0, sent: 0, failed: 0, lastSentAt: null };
    const [row] = await manager.query(`SELECT ${DELIVERY_AGG_SQL} FROM core.email_outbox eo WHERE eo.attachment_file_id = $1 AND eo.status <> 'CANCELLED'`, [finalFileId]);
    return { pending: Number(row.d_pending), sent: Number(row.d_sent), failed: Number(row.d_failed), lastSentAt: row.d_last_sent_at ? new Date(row.d_last_sent_at) : null };
  }

  /** Only AVAILABLE files are offered; RLS + `ReportFilePolicy` still decide the actual download. */
  private async fileRefs(manager: EntityManager, ids: Array<string | null>): Promise<Map<string, ReportFileRef>> {
    const wanted = ids.filter((id): id is string => !!id);
    if (wanted.length === 0) return new Map();
    const rows: Array<{ id: string; original_filename: string }> = await manager.query(
      `SELECT id, original_filename FROM core.stored_file WHERE id = ANY($1::uuid[]) AND status = 'AVAILABLE'`, [wanted]);
    return new Map(rows.map((r) => [r.id, { fileId: r.id, filename: r.original_filename }]));
  }

  /**
   * Fast/synchronous — flips `Attendance` rows to `APPROVED` and marks the
   * `ShiftReport` finalised, but never renders or sends anything. The
   * worker's `final-timesheet.job.ts` (Phase L) picks up
   * `status='finalised' AND final_pdf_sent_at IS NULL` on its next tick.
   */
  async finalise(ctx: AuthContext, shiftId: string, signOff: FinaliseReportDto = {}): Promise<void> {
    // Typed sign-off is all-or-nothing; the signer and time are never client-supplied (finalised_by / finalised_at).
    if ((signOff.signedOffName === undefined) !== (signOff.breakConfirmed === undefined)) {
      throw new BadRequestException('Signing off needs both your full name and the break confirmation.');
    }
    const signedOffName = signOff.signedOffName?.trim();
    if (signOff.signedOffName !== undefined && (!signedOffName || signedOffName.length < 2)) throw new BadRequestException('Enter your full name to sign off.');
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const shift = await manager.findOne(Shift, { where: { id: shiftId } });
      if (!shift) throw new NotFoundException('Shift not found.');
      await this.assertShiftOwned(manager, ctx, shift);
      // Serialises concurrent finalise/correct calls for THIS shift (the report row may not exist yet, so a row lock alone
      // can't). Distinct name from the worker's `shift_report:<id>` session locks — same lock space, so it must not collide.
      await manager.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`finalise:${shiftId}`]);

      const [{ started }] = await manager.query(`SELECT now() >= starts_at AS started FROM shift WHERE id = $1`, [shiftId]);
      if (!started) throw new ConflictException('This shift has not started yet, so its report cannot be finalised.');

      const assignments = await manager.find(ShiftAssignment, {
        where: { shiftId, status: In([ShiftAssignmentStatus.CONFIRMED, ShiftAssignmentStatus.COMPLETED, ShiftAssignmentStatus.NO_SHOW]) },
      });
      if (assignments.length === 0) {
        throw new ConflictException('This shift has no staff to finalise a report for.');
      }

      // Idempotent: finalising an already-finalised report changes nothing — same finalisedAt/finalisedBy, no second audit
      // entry — so a double-click or a retried request can never re-stamp who/when, or trigger a second delivery.
      const existingReport = await manager.findOne(ShiftReport, { where: { shiftId }, lock: { mode: 'pessimistic_write' } });
      if (existingReport?.status === 'finalised') return;

      const attendances = await manager.find(Attendance, {
        where: { shiftAssignmentId: In(assignments.map((a) => a.id)) },
      });

      if (!isReportReady(assignments.map(assignment => {
        const attendance = attendances.find(a => a.shiftAssignmentId === assignment.id);
        return { assignmentStatus: assignment.status, clockOutAt: attendance?.clockOutAt, attendanceStatus: attendance?.status };
      }))) throw new ConflictException('Wait for every confirmed staff member to clock out or receive a no-show outcome.');

      // Every seat's attendance must have been explicitly reviewed (owner brief 2026-10-18) — server authority, under
      // the same lock, so a correction that clears a review cannot slip past a concurrent finalise.
      const [{ remaining }] = await manager.query(
        `SELECT count(*)::int AS remaining FROM shift_assignment
          WHERE shift_id = $1 AND status IN ('confirmed','completed','no_show') AND attendance_reviewed_at IS NULL`,
        [shiftId],
      );
      if (remaining > 0) {
        throw new ConflictException(`${remaining} attendance review${remaining === 1 ? '' : 's'} remaining. Review every staff member's attendance before finalising.`);
      }

      const stillOpen = attendances.filter(
        (a) => a.status === AttendanceStatus.CLOCKED_IN || a.status === AttendanceStatus.ON_BREAK,
      );
      if (stillOpen.length > 0) {
        throw new ConflictException(`${stillOpen.length} staff member(s) are still clocked in — finalise once everyone has clocked out.`);
      }

      for (const attendance of attendances) {
        if (attendance.status === AttendanceStatus.APPROVED) continue;
        assertTransition(ATTENDANCE_TRANSITIONS, attendance.status, AttendanceStatus.APPROVED);
        await manager.update(Attendance, attendance.id, { status: AttendanceStatus.APPROVED });
      }

      let report = existingReport;
      if (!report) {
        report = manager.create(ShiftReport, { organisationId: ctx.organisationId!, workspaceId: shift.workspaceId, shiftId });
      }
      report.status = 'finalised';
      report.finalisedAt = new Date();
      report.finalisedBy = ctx.userId;
      await manager.save(ShiftReport, report);
      if (signedOffName) {
        await manager.query(`UPDATE shift_report SET signed_off_name = $2, break_confirmed = true WHERE id = $1`, [report.id, signedOffName]);
      }

      // Same transaction: every approved attendance gets its pending_approval payroll record, or the finalisation rolls
      // back. Staff History shows the shift only after a payroll.approve manager approves it (owner rule 2026-10-20).
      const payrollRecords = await this.payroll.createPendingForShift(manager, ctx, shiftId);

      await this.auditService.record(manager, ctx, AuditAction.ATTENDANCE_REPORT_FINALISED, {
        entityType: 'shift_report',
        entityId: report.id,
        metadata: { shiftId, staffCount: attendances.length, signedOff: !!signedOffName, payrollRecords },
      });
    });
  }
}

const DELIVERY_AGG_SQL = `count(*) FILTER (WHERE eo.status IN ('PENDING','QUEUED','PROCESSING','RETRY')) AS d_pending,
  count(*) FILTER (WHERE eo.status = 'SENT') AS d_sent, count(*) FILTER (WHERE eo.status = 'FAILED') AS d_failed, max(eo.sent_at) AS d_last_sent_at`;

/** Per-shift report rows for the lists (`rows` CTE). One attendance row per assignment (unique shift_assignment_id). */
const REPORT_ROWS_SQL = (scopeSql: string) => `WITH base AS (
  SELECT s.id AS shift_id, s.status AS shift_status, s.starts_at, s.ends_at, s.required_count, s.filled_count,
    v.name AS venue_name, jr.name AS role_name,
    COALESCE(sr.status, 'pending') AS report_status, sr.final_pdf_sent_at AS final_queued_at, sr.final_file_id,
    count(sa.id) AS staff_count,
    count(sa.id) FILTER (WHERE sa.status = 'no_show') AS no_shows,
    count(a.id) FILTER (WHERE a.status IN ('clocked_in','on_break')) AS open_attendance,
    count(a.id) AS any_attendance,
    count(a.id) FILTER (WHERE a.clock_out_at IS NOT NULL) AS clocked_out,
    count(sa.id) FILTER (WHERE sa.status <> 'no_show' AND a.clock_out_at IS NULL) AS unresolved,
    count(sa.id) FILTER (WHERE sa.attendance_reviewed_at IS NULL) AS unreviewed
  FROM shift s
  JOIN venue v ON v.id = s.venue_id
  JOIN job_role jr ON jr.id = s.job_role_id
  LEFT JOIN shift_assignment sa ON sa.shift_id = s.id AND sa.status IN ('confirmed','completed','no_show')
  LEFT JOIN attendance a ON a.shift_assignment_id = sa.id
  LEFT JOIN shift_report sr ON sr.shift_id = s.id
  WHERE s.organisation_id = $1 AND ${scopeSql}
    AND s.status NOT IN ('draft','pending_manager_approval','declined')
  GROUP BY s.id, v.name, jr.name, sr.id
), rows AS (
  SELECT b.*, d.* FROM base b
  LEFT JOIN LATERAL (SELECT ${DELIVERY_AGG_SQL} FROM core.email_outbox eo
    WHERE b.final_file_id IS NOT NULL AND eo.attachment_file_id = b.final_file_id AND eo.status <> 'CANCELLED') d ON true
)`;

function toSummary(r: Record<string, any>, now: Date): ShiftReportSummary {
  const delivery: DeliveryCounts = { pending: Number(r.d_pending), sent: Number(r.d_sent), failed: Number(r.d_failed), lastSentAt: r.d_last_sent_at ? new Date(r.d_last_sent_at) : null };
  const reportStatus = r.report_status as ShiftReportSummary['reportStatus'];
  return {
    shiftId: r.shift_id, venueName: r.venue_name, roleName: r.role_name,
    startsAt: new Date(r.starts_at).toISOString(), endsAt: new Date(r.ends_at).toISOString(), shiftStatus: r.shift_status,
    requiredCount: Number(r.required_count), filledCount: Number(r.filled_count), staffCount: Number(r.staff_count),
    clockedOut: Number(r.clocked_out), noShows: Number(r.no_shows), reportStatus,
    lifecycle: reportLifecycle({
      now, shiftStatus: r.shift_status, startsAt: new Date(r.starts_at), endsAt: new Date(r.ends_at), staffCount: Number(r.staff_count),
      openAttendance: Number(r.open_attendance), unresolved: Number(r.unresolved), unreviewed: Number(r.unreviewed), anyClockIn: Number(r.any_attendance) > 0,
      reportStatus, finalQueuedAt: r.final_queued_at ? new Date(r.final_queued_at) : null, delivery,
    }),
  };
}
