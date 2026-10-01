import { effectiveAssignmentBreakMinutes } from '../../scheduling/utils/assignment-time';
import { assignmentTimeSql } from '../../scheduling/utils/assignment-time';
import { isReportReady } from './report-readiness';
import { assertTransition, ATTENDANCE_TRANSITIONS, AttendanceStatus, ShiftAssignmentStatus } from '@rab/shared';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';

import { Shift } from '../../scheduling/entities/shift.entity';
import { ShiftAssignment } from '../../scheduling/entities/shift-assignment.entity';
import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { Attendance } from '../entities/attendance.entity';
import { AttendanceCorrection } from '../entities/attendance-correction.entity';
import { ShiftReport } from '../entities/shift-report.entity';

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
  originalFileId: string | null;
  signedFileId: string | null;
  finalisedByName: string | null;
}

const REPORT_SUMMARY_SELECT = `
  SELECT s.id, s.starts_at, s.ends_at, v.name AS venue_name, jr.name AS role_name
  FROM core.shift s
  JOIN core.venue v ON v.id = s.venue_id
  JOIN core.job_role jr ON jr.id = s.job_role_id
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

  async getReport(ctx: AuthContext, shiftId: string): Promise<ShiftReportDetail> {
    return this.tenantContext.runInTenantContext(ctx, manager => this.getReportWithManager(manager, ctx, shiftId));
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
      EXISTS (SELECT 1 FROM core.attendance_correction ac WHERE ac.attendance_id=a.id) AS corrected
      FROM core.shift_assignment sa JOIN core.shift s ON s.id=sa.shift_id JOIN core.staff_profile sp ON sp.id=sa.staff_profile_id JOIN core."user" u ON u.id=sp.user_id
      LEFT JOIN core.attendance a ON a.shift_assignment_id=sa.id
      WHERE sa.shift_id=$1 AND sa.status IN ('confirmed','completed','no_show') ORDER BY u.first_name,u.last_name,sa.id`, [shiftId]);
    const staff: ShiftReportStaffRow[] = rows.map((r: any) => ({ ...r, roleName: summary.role_name, scheduledBreakMinutes: effectiveAssignmentBreakMinutes({ breakMinutes: r.assignmentBreakMinutes }, shift),
      clockInAt: r.clockInAt ? new Date(r.clockInAt).toISOString() : null, clockOutAt: r.clockOutAt ? new Date(r.clockOutAt).toISOString() : null,
      earnedPence: r.earnedPence == null ? null : Number(r.earnedPence), locationVerified: !!r.locationVerified }));
    const finaliser = report?.finalisedBy ? (await manager.query('SELECT first_name || \' \' || last_name AS name FROM core."user" WHERE id=$1', [report.finalisedBy]))[0] : null;
    return { shiftId, venueName: summary.venue_name, roleName: summary.role_name, startsAt: new Date(summary.starts_at).toISOString(), endsAt: new Date(summary.ends_at).toISOString(),
      reportStatus: (report?.status as ShiftReportDetail['reportStatus']) ?? 'pending', finalisedAt: report?.finalisedAt?.toISOString() ?? null, finalisedBy: report?.finalisedBy ?? null,
      finalisedByName: finaliser?.name ?? null, originalFileId: report?.originalFileId ?? null, signedFileId: report?.finalFileId ?? null, ready: isReportReady(staff), staff };
  }

  /**
   * Fast/synchronous — flips `Attendance` rows to `APPROVED` and marks the
   * `ShiftReport` finalised, but never renders or sends anything. The
   * worker's `final-timesheet.job.ts` (Phase L) picks up
   * `status='finalised' AND final_pdf_sent_at IS NULL` on its next tick.
   */
  async finalise(ctx: AuthContext, shiftId: string): Promise<void> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const shift = await manager.findOne(Shift, { where: { id: shiftId } });
      if (!shift) throw new NotFoundException('Shift not found.');
      await this.assertShiftOwned(manager, ctx, shift);
      // Serialises concurrent finalise/correct calls for THIS shift (the report row may not exist yet, so a row lock alone
      // can't). Distinct name from the worker's `shift_report:<id>` session locks — same lock space, so it must not collide.
      await manager.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`finalise:${shiftId}`]);

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

      await this.auditService.record(manager, ctx, AuditAction.ATTENDANCE_REPORT_FINALISED, {
        entityType: 'shift_report',
        entityId: report.id,
        metadata: { shiftId, staffCount: attendances.length },
      });
    });
  }
}
