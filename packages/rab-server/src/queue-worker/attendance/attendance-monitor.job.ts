import { assertTransition, ATTENDANCE_TRANSITIONS, AttendanceStatus, NotificationType } from '@rab/shared';
import { DataSource } from 'typeorm';

import { AuditAction, AuditService } from '../../engine/core-modules/audit/audit.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { NotificationService } from '../../modules/notification/services/notification.service';
import { Notification } from '../../modules/notification/entities/notification.entity';
import { Attendance } from '../../modules/attendance/entities/attendance.entity';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
import { StaffProfile } from '../../modules/staff/entities/staff-profile.entity';
import { User } from '../../modules/identity/entities';
import { runScopedForOrg } from '../shared/scoped-job';

/**
 * Missing-clock-out detection — flags and notifies, never auto-clocks
 * anyone out (explicit instruction: attendance TRUTH — `clockOutAt`,
 * `workedMinutes`, `earnedPence` — stays under `AttendanceService`'s own
 * rules; this job never writes any of those three). It does move
 * `Attendance.status` to `AttendanceStatus.MISSING_CLOCK_OUT` via the shared
 * `ATTENDANCE_TRANSITIONS` table (the same `assertTransition` guard
 * `AttendanceService` itself uses) — that's a status *label* change only,
 * not a clock-out, and it's what lets the Venue Manager Report show a real
 * "missing clock-out" status instead of inferring one from a null
 * `clockOutAt`. Same two-phase owner-scan + `rab_app`-scoped-mutation shape
 * as `shift-monitor.job.ts` — see that file's doc comment for the full
 * rationale, identical here.
 *
 * Idempotency: the `Attendance.status` write above naturally excludes an
 * already-flagged row from the next scan (`WHERE a.status = 'clocked_in'`
 * below no longer matches it) — but the explicit `Notification` existence
 * check is kept too, as a second, independent guard against a duplicate
 * notification specifically (the same idiom `shift-monitor.job.ts` already
 * uses for reminders), in case the status write and the notification ever
 * become decoupled in a future change.
 */
const MISSING_CLOCK_OUT_GRACE_MS = 30 * 60 * 1000;

export interface AttendanceMonitorResult {
  flagged: number;
}

interface ScanCandidate {
  attendance_id: string;
  organisation_id: string;
  workspace_id: string | null;
}

export async function runAttendanceMonitorCycle(
  ownerDataSource: DataSource,
  tenantContext: TenantContextService,
  notificationService: NotificationService,
  auditService: AuditService,
): Promise<AttendanceMonitorResult> {
  const candidates = await ownerDataSource.transaction(async (manager) => {
    await manager.query(`SELECT pg_advisory_xact_lock(hashtext('rab_attendance_monitor'))`);
    await manager.query(`ALTER TABLE core.attendance DISABLE ROW LEVEL SECURITY;`);
    await manager.query(`ALTER TABLE core.shift DISABLE ROW LEVEL SECURITY;`);
    try {
      return await manager.query<ScanCandidate[]>(`
        SELECT a.id AS attendance_id, a.organisation_id, a.workspace_id
        FROM core.attendance a
        JOIN core.shift s ON s.id = a.shift_id
        WHERE a.status = 'clocked_in'
          AND a.clock_out_at IS NULL
          AND s.ends_at < now() - interval '${MISSING_CLOCK_OUT_GRACE_MS / 60000} minutes'
        ORDER BY s.ends_at ASC
        LIMIT 500
      `);
    } finally {
      await manager.query(`ALTER TABLE core.attendance ENABLE ROW LEVEL SECURITY;`);
      await manager.query(`ALTER TABLE core.shift ENABLE ROW LEVEL SECURITY;`);
    }
  });

  let flagged = 0;
  for (const candidate of candidates) {
    const didFlag = await runScopedForOrg(tenantContext, candidate.organisation_id, candidate.workspace_id, async (manager) => {
      const attendance = await manager.findOne(Attendance, { where: { id: candidate.attendance_id } });
      if (!attendance || attendance.status !== AttendanceStatus.CLOCKED_IN || attendance.clockOutAt) return false;
      const shift = await manager.findOne(Shift, { where: { id: attendance.shiftId } });
      if (!shift || shift.endsAt.getTime() > Date.now() - MISSING_CLOCK_OUT_GRACE_MS) return false;

      const alreadyFlagged = await manager.findOne(Notification, {
        where: { relatedEntityType: 'attendance', relatedEntityId: attendance.id, type: NotificationType.ATTENDANCE_MISSING_CLOCK_OUT },
      });
      if (alreadyFlagged) return false;

      const staffProfile = await manager.findOne(StaffProfile, { where: { id: attendance.staffProfileId } });
      const user = staffProfile ? await manager.findOne(User, { where: { id: staffProfile.userId } }) : null;
      const recipientUserId = staffProfile?.createdBy ?? user?.id;
      if (!recipientUserId) return false; // no manager on record and no resolvable staff user — nobody to notify

      // Status label only — clockOutAt/workedMinutes/earnedPence are never
      // touched here (see the class doc comment).
      assertTransition(ATTENDANCE_TRANSITIONS, attendance.status, AttendanceStatus.MISSING_CLOCK_OUT);
      await manager.update(Attendance, attendance.id, { status: AttendanceStatus.MISSING_CLOCK_OUT });

      await notificationService.notify(manager, {
        organisationId: candidate.organisation_id,
        userId: recipientUserId,
        type: NotificationType.ATTENDANCE_MISSING_CLOCK_OUT,
        title: 'Missing clock-out',
        message: `${user ? `${user.firstName} ${user.lastName}` : 'A staff member'} has not clocked out from a shift that ended at ${shift.endsAt.toISOString()}.`,
        relatedEntityType: 'attendance',
        relatedEntityId: attendance.id,
      });
      await auditService.record(manager, { organisationId: candidate.organisation_id, userId: '' }, AuditAction.SHIFT_ASSIGNMENT_MISSING_CLOCK_OUT_FLAGGED, {
        targetUserId: user?.id,
        metadata: { attendanceId: attendance.id },
        actorUserId: null,
      });
      return true;
    });
    if (didFlag) flagged += 1;
  }

  return { flagged };
}
