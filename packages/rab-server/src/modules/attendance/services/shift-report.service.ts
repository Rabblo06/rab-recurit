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
  staffName: string;
  roleName: string;
  assignmentStatus: string;
  attendanceId: string | null;
  attendanceStatus: string | null;
  clockInAt: string | null;
  clockOutAt: string | null;
  breakMinutes: number | null;
  scheduledBreakMinutes: number;
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
 * that's the worker's job (`queue-worker/reports/*.job.ts`, Phase J/L) —
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

  /** Same shape as `SchedulingService.assertShiftOwned` — a Venue Manager sees only their assigned venues' reports; a plain Manager only shifts they created. 404, not 403, when out of scope. */
  private async assertShiftOwned(manager: EntityManager, ctx: AuthContext, shift: Shift): Promise<void> {
    const scope = await this.resourceScope.resolveTx(manager, ctx);
    if (scope.kind === 'owner' && shift.createdBy === ctx.userId) return;
    if (scope.kind === 'venue' && scope.venueIds.includes(shift.venueId)) return;
    throw new NotFoundException('Shift not found.');
  }

  async getReport(ctx: AuthContext, shiftId: string): Promise<ShiftReportDetail> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const shift = await manager.findOne(Shift, { where: { id: shiftId } });
      if (!shift) throw new NotFoundException('Shift not found.');
      await this.assertShiftOwned(manager, ctx, shift);

      const summaryRows = await manager.query(REPORT_SUMMARY_SELECT, [shiftId]);
      const summary = summaryRows[0] as { starts_at: Date; ends_at: Date; venue_name: string; role_name: string };

      const report = await manager.findOne(ShiftReport, { where: { shiftId } });

      const assignments = await manager.find(ShiftAssignment, {
        where: { shiftId, status: In([ShiftAssignmentStatus.CONFIRMED, ShiftAssignmentStatus.COMPLETED, ShiftAssignmentStatus.NO_SHOW]) },
      });

      const staff: ShiftReportStaffRow[] = [];
      for (const assignment of assignments) {
        const rows = await manager.query(
          `SELECT a.id, a.status, a.clock_in_at, a.clock_out_at, a.break_minutes, a.worked_minutes, a.earned_pence,
                  a.location_verified, a.clock_out_method,
                  sp.id AS staff_profile_id, u.first_name, u.last_name
             FROM core.attendance a
             JOIN core.staff_profile sp ON sp.id = a.staff_profile_id
             JOIN core."user" u ON u.id = sp.user_id
            WHERE a.shift_assignment_id = $1`,
          [assignment.id],
        );
        const a = rows[0] as
          | {
              id: string;
              status: string;
              clock_in_at: Date;
              clock_out_at: Date | null;
              break_minutes: number | null;
              worked_minutes: number | null;
              earned_pence: number | null;
              location_verified: boolean;
              clock_out_method: string | null;
              staff_profile_id: string;
              first_name: string;
              last_name: string;
            }
          | undefined;

        // No attendance row yet (assignment confirmed but staff never
        // clocked in) — still resolve the staff's name for the roster.
        const staffProfileRow = a ?? (await manager.query(
          `SELECT sp.id AS staff_profile_id, u.first_name, u.last_name
             FROM core.staff_profile sp JOIN core."user" u ON u.id = sp.user_id WHERE sp.id = $1`,
          [assignment.staffProfileId],
        ))[0];

        const correctionCount = a
          ? await manager.count(AttendanceCorrection, { where: { attendanceId: a.id } })
          : 0;

        staff.push({
          staffProfileId: staffProfileRow.staff_profile_id,
          staffName: `${staffProfileRow.first_name} ${staffProfileRow.last_name}`,
          roleName: summary.role_name,
          assignmentStatus: assignment.status,
          attendanceId: a?.id ?? null,
          attendanceStatus: a?.status ?? null,
          clockInAt: a?.clock_in_at ? new Date(a.clock_in_at).toISOString() : null,
          clockOutAt: a?.clock_out_at ? new Date(a.clock_out_at).toISOString() : null,
          breakMinutes: a?.break_minutes ?? null,
          scheduledBreakMinutes: shift.breakMinutes,
          workedMinutes: a?.worked_minutes ?? null,
          earnedPence: a?.earned_pence ?? null,
          locationVerified: Boolean(a?.location_verified),
          clockOutMethod: a?.clock_out_method ?? null,
          corrected: correctionCount > 0,
        });
      }

      return {
        shiftId,
        venueName: summary.venue_name,
        roleName: summary.role_name,
        startsAt: new Date(summary.starts_at).toISOString(),
        endsAt: new Date(summary.ends_at).toISOString(),
        reportStatus: (report?.status as ShiftReportDetail['reportStatus']) ?? 'pending',
        finalisedAt: report?.finalisedAt ? new Date(report.finalisedAt).toISOString() : null,
        finalisedBy: report?.finalisedBy ?? null,
        staff,
      };
    });
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
