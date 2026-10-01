import { assignmentTimeSql, effectiveAssignmentTime } from '@rab/server/modules/scheduling/utils/assignment-time';
import { ShiftAssignment } from '@rab/server/modules/scheduling/entities/shift-assignment.entity';
import { assertTransition, ATTENDANCE_TRANSITIONS, AttendanceStatus, NotificationType, ShiftStatus } from '@rab/shared';
import { DataSource } from 'typeorm';

import { AuditAction, AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { Attendance } from '@rab/server/modules/attendance/entities/attendance.entity';
import { Shift } from '@rab/server/modules/scheduling/entities/shift.entity';
import { StaffProfile } from '@rab/server/modules/staff/entities/staff-profile.entity';
import { User } from '@rab/server/modules/identity/entities/index';
import { runScopedForOrg } from '../../core/database/scoped-job';
import { claimWorkerEvent, completeWorkerEvent } from '../../core/database/worker-event';
import { resolveResponsibleManager } from '../../core/domain/resolve-responsible-manager';
import { discoverInWorkspaces } from '../../core/database/workspace-discovery';

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
 * Idempotency is a `core.worker_event` claim (`event_key =
 * "missing-clock-out:{attendanceId}"`), the real cross-replica guard — NOT
 * a `Notification` row's existence, which is only ever inserted `if
 * (inAppEnabled)` and would otherwise let two replicas both pass the
 * status check and both flip/notify/audit redundantly. The
 * `Attendance.status` write is still a secondary, independent guard against
 * a THIRD scan from ever re-selecting this row at all (`WHERE a.status =
 * 'clocked_in'` below no longer matches it), kept for defense in depth.
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
  const scopes = await discoverInWorkspaces(ownerDataSource, tenantContext, async (manager) => {
      return await manager.query<Omit<ScanCandidate, 'attendance_id'>[]>(`
        SELECT DISTINCT a.organisation_id, a.workspace_id
        FROM core.attendance a
        JOIN core.shift s ON s.id = a.shift_id
        WHERE a.status = 'clocked_in'
          AND a.clock_out_at IS NULL
          AND s.status != 'cancelled'

      `);
  });

  // Discover eligible assignment IDs with all assignment RLS policies active.
  // Filtering before the per-workspace limit prevents later-ending attendance
  // from hiding shorter assignments that are already overdue.
  const candidates: ScanCandidate[] = [];
  for (const scope of scopes) {
    const due = await runScopedForOrg(tenantContext, scope.organisation_id, scope.workspace_id, manager =>
      manager.query<ScanCandidate[]>(`
        SELECT a.id AS attendance_id, a.organisation_id, a.workspace_id
        FROM core.attendance a
        JOIN core.shift s ON s.id=a.shift_id
        JOIN core.shift_assignment sa ON sa.id=a.shift_assignment_id
        WHERE a.status='clocked_in' AND a.clock_out_at IS NULL
          AND s.status!='cancelled'
          AND ${assignmentTimeSql().end} <= now() - interval '${MISSING_CLOCK_OUT_GRACE_MS / 60000} minutes'
        ORDER BY ${assignmentTimeSql().end}, a.id LIMIT 500
      `));
    candidates.push(...due);
  }

  let flagged = 0;
  for (const candidate of candidates) {
    const didFlag = await runScopedForOrg(tenantContext, candidate.organisation_id, candidate.workspace_id, async (manager) => {
      const attendance = await manager.findOne(Attendance, { where: { id: candidate.attendance_id } });
      if (!attendance || attendance.status !== AttendanceStatus.CLOCKED_IN || attendance.clockOutAt) return false;
      const shift = await manager.findOne(Shift, { where: { id: attendance.shiftId } });
      const assignment = await manager.findOne(ShiftAssignment, { where: { id: attendance.shiftAssignmentId } });
      if (!shift || !assignment || effectiveAssignmentTime(assignment, shift).endsAt.getTime() > Date.now() - MISSING_CLOCK_OUT_GRACE_MS) return false;
      // PHASE 5 (§9) — the discovery scan already excludes `s.status =
      // 'cancelled'`, but this per-candidate re-check never repeated that
      // exclusion, so a cancellation landing between the scan and this
      // candidate's own transaction could still flag/notify a missing
      // clock-out for a shift that's since been cancelled. This does NOT
      // suppress missing-clock-out handling for genuine attendance — the
      // row only ever reaches here once `status = 'clocked_in'` already
      // (someone really did clock in) — it only closes the race so the
      // per-candidate check matches the discovery query's own already-
      // decided exclusion, exactly like every other job in this package.
      // `clockInAt`/`clockOutAt`/`workedMinutes`/`earnedPence` are never
      // touched by this job either way (see the class doc comment) — a
      // cancelled shift's real attendance facts are preserved regardless.
      if (shift.status === ShiftStatus.CANCELLED) return false;

      const staffProfile = await manager.findOne(StaffProfile, { where: { id: attendance.staffProfileId } });
      const user = staffProfile ? await manager.findOne(User, { where: { id: staffProfile.userId } }) : null;
      // WORK-02 — `staffProfile.createdBy` records who onboarded the STAFF
      // MEMBER (an HR relationship), never who is responsible for THIS
      // shift assignment; falling back to the staff member's own user id
      // sent an "operational manager" notification to the staff member
      // themselves. Replaced with the same canonical resolver
      // `late-clock-in.job.ts` already uses — see its own doc comment for
      // the full rationale. `null` (no valid manager found) is handled
      // below: the event still completes and the status transition still
      // happens, there is simply no one to notify — never an invented
      // fallback recipient.
      const resolvedManager = await resolveResponsibleManager(manager, candidate.organisation_id, assignment, shift);

      const eventId = await claimWorkerEvent(manager, {
        organisationId: candidate.organisation_id,
        workspaceId: candidate.workspace_id,
        eventKey: `missing-clock-out:${attendance.id}`,
        eventType: 'missing_clock_out',
        entityType: 'attendance',
        entityId: attendance.id,
      });
      if (!eventId) return false; // another replica/tick already claimed this occurrence

      // Status label only — clockOutAt/workedMinutes/earnedPence are never
      // touched here (see the class doc comment).
      assertTransition(ATTENDANCE_TRANSITIONS, attendance.status, AttendanceStatus.MISSING_CLOCK_OUT);
      await manager.update(Attendance, attendance.id, { status: AttendanceStatus.MISSING_CLOCK_OUT });

      // WORK-02 — the manager notification is conditional on a real,
      // validated recipient; there is no fallback recipient. The status
      // transition and audit record above/below always happen regardless —
      // "no one to notify" is a safe, complete outcome, never a reason to
      // invent one or leave the event unclaimed.
      if (resolvedManager) {
        await notificationService.notify(manager, {
          organisationId: candidate.organisation_id,
          userId: resolvedManager.userId,
          type: NotificationType.ATTENDANCE_MISSING_CLOCK_OUT,
          title: 'Missing clock-out',
          message: `${user ? `${user.firstName} ${user.lastName}` : 'A staff member'} has not clocked out from a shift that ended at ${effectiveAssignmentTime(assignment, shift).endsAt.toISOString()}.`,
          relatedEntityType: 'attendance',
          relatedEntityId: attendance.id,
        });
      }
      await auditService.record(manager, { organisationId: candidate.organisation_id, userId: '' }, AuditAction.SHIFT_ASSIGNMENT_MISSING_CLOCK_OUT_FLAGGED, {
        targetUserId: user?.id,
        metadata: {
          attendanceId: attendance.id,
          notifiedManagerUserId: resolvedManager?.userId ?? null,
          managerResolutionSource: resolvedManager?.source ?? 'none',
        },
        actorUserId: null,
      });
      await completeWorkerEvent(manager, eventId);
      return true;
    });
    if (didFlag) flagged += 1;
  }

  return { flagged };
}
