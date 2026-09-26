import { PostShiftLifecycleService } from '../../modules/attendance/services/post-shift-lifecycle.service';
import { assertTransition, NotificationType, NotificationTypeType, SHIFT_ASSIGNMENT_TRANSITIONS, ShiftAssignmentStatus, ShiftStatus, UserStatus } from '@rab/shared';
import { DataSource } from 'typeorm';

import { AuditAction, AuditService } from '../../engine/core-modules/audit/audit.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { NotificationService } from '../../modules/notification/services/notification.service';
import { Notification } from '../../modules/notification/entities/notification.entity';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
import { ShiftAssignment } from '../../modules/scheduling/entities/shift-assignment.entity';
import { StaffProfile } from '../../modules/staff/entities/staff-profile.entity';
import { User } from '../../modules/identity/entities';
import { runScopedForOrg } from '../shared/scoped-job';
import { beginRlsDiscovery } from '../shared/discovery-lock';

/**
 * Shift-time monitoring — reminders (24h/2h/30m before a confirmed shift)
 * and no-show detection, combined into one periodic scan since both key off
 * the same `shift_assignment` × `shift` join. A **periodic scan**, not a
 * per-assignment BullMQ delayed job — deliberate: the alternative (schedule
 * 3 deterministic delayed jobs at `confirmOne()` time, reschedule on shift-
 * time-change, cancel on shift-cancel/assignment-withdrawal) would mean
 * threading producer calls through `OfferService`'s already-large, already-
 * tested confirm/withdraw/reject flow and `SchedulingService`'s cancel flow
 * — real regression risk for zero behavioural gain, since a shift reminder
 * being a few minutes late is immaterial. This scan naturally self-corrects
 * on shift reschedule/cancellation (a changed `starts_at` or a cancelled
 * shift simply stops matching the query next run — no explicit
 * reschedule/cancel code needed at all) and is idempotent by construction
 * (see below), so it delivers every real requirement without touching
 * offer/scheduling business logic.
 *
 * Two-phase, same shape as `account-invite-cleanup.job.ts`: an owner-
 * connection SCAN (cross-org, read-only, FORCE-RLS-bracketed since
 * `shift`/`shift_assignment` are both FORCE'd) finds candidate ids, then
 * EACH candidate is re-loaded and mutated inside its own `rab_app`-scoped
 * transaction (`runScopedForOrg`) — never mutated over the owner connection
 * itself, unlike the maintenance sweep this pattern is modelled on. This is
 * the explicit distinction CLAUDE.md's layer-2 rule and this task's own
 * brief draw between "genuinely cross-tenant maintenance" (owner connection
 * throughout) and "operational per-row work" (owner connection for
 * discovery only, `rab_app` + real tenant context for every mutation).
 */

const REMINDER_WINDOWS: Array<{ type: NotificationTypeType; ms: number; auditNote: string }> = [
  { type: NotificationType.SHIFT_REMINDER_24H, ms: 24 * 3600 * 1000, auditNote: '24h' },
  { type: NotificationType.SHIFT_REMINDER_2H, ms: 2 * 3600 * 1000, auditNote: '2h' },
  { type: NotificationType.SHIFT_REMINDER_30M, ms: 30 * 60 * 1000, auditNote: '30m' },
];

// A shift that started this long ago with no clock-in from a still-
// confirmed assignment is treated as a no-show — long enough that a staff
// member running a few minutes late (a real, common case) is never
// wrongly flagged.
const NO_SHOW_GRACE_MS = 30 * 60 * 1000;

const FORCED_SCAN_TABLES = ['shift', 'shift_assignment', 'attendance'];

interface ScanCandidate {
  assignment_id: string;
  organisation_id: string;
  workspace_id: string | null;
  starts_at: string;
}

export interface ShiftMonitorResult {
  remindersSent: number;
  noShowsFlagged: number;
  postShiftTransitions: number;
}

export async function runShiftMonitorCycle(
  ownerDataSource: DataSource,
  tenantContext: TenantContextService,
  notificationService: NotificationService,
  auditService: AuditService,
): Promise<ShiftMonitorResult> {
  const discovery = await ownerDataSource.transaction(async (manager) => {
    await manager.query(`SELECT pg_advisory_xact_lock(hashtext('rab_shift_monitor'))`);
    await beginRlsDiscovery(manager); // bounded wait for the table locks below — see discovery-lock.ts
    for (const table of FORCED_SCAN_TABLES) {
      await manager.query(`ALTER TABLE core.${table} DISABLE ROW LEVEL SECURITY;`);
    }
    try {
      // Two INDEPENDENT scans, each with its own LIMIT — a single `ORDER BY starts_at ASC LIMIT 500` with no lower
      // bound let long-dead CONFIRMED assignments (a clocked-in-never-clocked-out shift, a deactivated user, ...)
      // fill every slot and starve imminent shifts of their reminders forever. The scoped re-check below still
      // decides precisely, using fresh data.
      //   reminders: shifts that have NOT started, starting within a day — soonest first.
      const reminderCandidates = await manager.query<ScanCandidate[]>(`
        SELECT sa.id AS assignment_id, sa.organisation_id, sa.workspace_id, s.starts_at
        FROM core.shift_assignment sa
        JOIN core.shift s ON s.id = sa.shift_id
        WHERE sa.status = 'confirmed'
          AND s.status NOT IN ('cancelled', 'completed')
          AND s.starts_at > now()
          AND s.starts_at <= now() + interval '24 hours 10 minutes'
        ORDER BY s.starts_at ASC
        LIMIT 500
      `);
      //   no-shows: shifts already past the grace period — most recent first, so stale rows sink to the back.
      const noShowCandidates = await manager.query<ScanCandidate[]>(
        `
        SELECT sa.id AS assignment_id, sa.organisation_id, sa.workspace_id, s.starts_at
        FROM core.shift_assignment sa
        JOIN core.shift s ON s.id = sa.shift_id
        WHERE sa.status = 'confirmed'
          AND s.status NOT IN ('cancelled', 'completed')
          AND s.starts_at <= now() - make_interval(secs => $1)
        ORDER BY s.starts_at DESC
        LIMIT 500
      `,
        [NO_SHOW_GRACE_MS / 1000],
      );
      const lifecycleCandidates = await PostShiftLifecycleService.discover(manager);
      return { assignments: [...reminderCandidates, ...noShowCandidates], lifecycleCandidates };
    } finally {
      for (const table of FORCED_SCAN_TABLES) {
        await manager.query(`ALTER TABLE core.${table} ENABLE ROW LEVEL SECURITY;`);
      }
    }
  });

  let remindersSent = 0;
  let noShowsFlagged = 0;

  for (const candidate of discovery.assignments) {
    const result = await runScopedForOrg(tenantContext, candidate.organisation_id, candidate.workspace_id, async (manager) => {
      const assignment = await manager.findOne(ShiftAssignment, { where: { id: candidate.assignment_id } });
      if (!assignment || assignment.status !== ShiftAssignmentStatus.CONFIRMED) return { reminders: 0, noShow: false };
      const shift = await manager.findOne(Shift, { where: { id: assignment.shiftId } });
      if (!shift || shift.status === ShiftStatus.CANCELLED || shift.status === ShiftStatus.COMPLETED) return { reminders: 0, noShow: false };
      const staffProfile = await manager.findOne(StaffProfile, { where: { id: assignment.staffProfileId } });
      if (!staffProfile) return { reminders: 0, noShow: false };
      const user = await manager.findOne(User, { where: { id: staffProfile.userId } });
      if (!user || user.status !== UserStatus.ACTIVE) return { reminders: 0, noShow: false };

      const msUntilStart = shift.startsAt.getTime() - Date.now();
      let reminders = 0;

      if (msUntilStart > 0) {
        for (const window of REMINDER_WINDOWS) {
          if (msUntilStart > window.ms) continue;
          const alreadySent = await manager.findOne(Notification, {
            where: { relatedEntityType: 'shift_assignment', relatedEntityId: assignment.id, type: window.type },
          });
          if (alreadySent) continue;

          await notificationService.notify(manager, {
            organisationId: candidate.organisation_id,
            userId: user.id,
            type: window.type,
            title: 'Upcoming shift reminder',
            message: `Your shift starts at ${shift.startsAt.toISOString()} (in about ${window.auditNote}).`,
            relatedEntityType: 'shift_assignment',
            relatedEntityId: assignment.id,
          });
          await auditService.record(manager, { organisationId: candidate.organisation_id, userId: '' }, AuditAction.SHIFT_REMINDER_SENT, {
            targetUserId: user.id,
            metadata: { assignmentId: assignment.id, window: window.auditNote },
            actorUserId: null,
          });
          reminders += 1;
        }
        return { reminders, noShow: false };
      }

      // Shift has already started — no-show check, gated by grace period.
      if (-msUntilStart < NO_SHOW_GRACE_MS) return { reminders, noShow: false };
      const hasAttendance = await manager.query(`SELECT 1 FROM core.attendance WHERE shift_assignment_id = $1 LIMIT 1`, [assignment.id]);
      if (hasAttendance.length > 0) return { reminders, noShow: false };

      assertTransition(SHIFT_ASSIGNMENT_TRANSITIONS, assignment.status, ShiftAssignmentStatus.NO_SHOW);
      await manager.update(ShiftAssignment, assignment.id, { status: ShiftAssignmentStatus.NO_SHOW });
      await notificationService.notify(manager, {
        organisationId: candidate.organisation_id,
        userId: staffProfile.createdBy ?? user.id, // notify the manager who created this staff member; falls back to the staff member themselves if unowned
        type: NotificationType.SHIFT_ASSIGNMENT_NO_SHOW,
        title: 'Staff member did not clock in',
        message: `${user.firstName} ${user.lastName} has not clocked in for a shift that started at ${shift.startsAt.toISOString()}.`,
        relatedEntityType: 'shift_assignment',
        relatedEntityId: assignment.id,
      });
      await auditService.record(manager, { organisationId: candidate.organisation_id, userId: '' }, AuditAction.SHIFT_ASSIGNMENT_NO_SHOW, {
        targetUserId: user.id,
        metadata: { assignmentId: assignment.id },
        actorUserId: null,
      });
      return { reminders, noShow: true };
    });

    remindersSent += result.reminders;
    if (result.noShow) noShowsFlagged += 1;
  }

  const lifecycle = new PostShiftLifecycleService(auditService);
  let postShiftTransitions = 0;
  for (const candidate of discovery.lifecycleCandidates) {
    postShiftTransitions += await runScopedForOrg(tenantContext, candidate.organisation_id, candidate.workspace_id,
      manager => lifecycle.advance(manager, candidate.id));
  }
  return { remindersSent, noShowsFlagged, postShiftTransitions };
}
