import { effectiveAssignmentTime, assignmentTimeSql } from '@rab/server/modules/scheduling/utils/assignment-time';
import { PostShiftLifecycleService } from '@rab/server/modules/attendance/services/post-shift-lifecycle.service';
import { assertTransition, NotificationType, NotificationTypeType, SHIFT_ASSIGNMENT_TRANSITIONS, ShiftAssignmentStatus, ShiftStatus, UserStatus } from '@rab/shared';
import { DataSource, EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { Shift } from '@rab/server/modules/scheduling/entities/shift.entity';
import { ShiftAssignment } from '@rab/server/modules/scheduling/entities/shift-assignment.entity';
import { StaffProfile } from '@rab/server/modules/staff/entities/staff-profile.entity';
import { User } from '@rab/server/modules/identity/entities/index';
import { runScopedForOrg } from '../../core/database/scoped-job';
import { cancelWorkerEvent, claimWorkerEvent, completeWorkerEvent } from '../../core/database/worker-event';
import { resolveResponsibleManager } from '../../core/domain/resolve-responsible-manager';
import { discoverInWorkspaces } from '../../core/database/workspace-discovery';

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

const REMINDER_WINDOWS: Array<{ type: NotificationTypeType; ms: number; auditNote: string; eventKeySlug: string }> = [
  { type: NotificationType.SHIFT_REMINDER_24H, ms: 24 * 3600 * 1000, auditNote: '24h', eventKeySlug: 'shift-reminder-24h' },
  { type: NotificationType.SHIFT_REMINDER_2H, ms: 2 * 3600 * 1000, auditNote: '2h', eventKeySlug: 'shift-reminder-2h' },
  { type: NotificationType.SHIFT_REMINDER_30M, ms: 30 * 60 * 1000, auditNote: '30m', eventKeySlug: 'shift-reminder-30m' },
];

// A shift that started this long ago with no clock-in from a still-
// confirmed assignment is treated as a no-show — long enough that a staff
// member running a few minutes late (a real, common case) is never
// wrongly flagged.
const NO_SHOW_GRACE_MS = 30 * 60 * 1000;


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

interface ReminderCandidateSnapshot {
  assignment: ShiftAssignment;
  shift: Shift;
  staffProfile: StaffProfile;
  user: User;
}

/**
 * PHASE 5 (§6/§8) — the single, shared "is this still a real, active,
 * staffed occurrence right now" read, used for Pass A (before claiming a
 * reminder window or the no-show event) AND Pass B (immediately before the
 * irreversible notify/audit side effects). Previously this file only ever
 * checked once, before the reminder-window loop / no-show claim — a
 * cancellation (or assignment change, or staff deactivation) landing in the
 * window between that single check and the actual claim+notify could still
 * produce a visible reminder or no-show for an occurrence that had already
 * stopped being valid. Mirrors `late-clock-in.job.ts`'s own Pass A/claim/
 * Pass B shape (Phase 3) rather than inventing a second pattern.
 */
async function loadReminderCandidate(manager: EntityManager, assignmentId: string): Promise<ReminderCandidateSnapshot | null> {
  const assignment = await manager.findOne(ShiftAssignment, { where: { id: assignmentId } });
  if (!assignment || assignment.status !== ShiftAssignmentStatus.CONFIRMED) return null;
  const shift = await manager.findOne(Shift, { where: { id: assignment.shiftId } });
  if (!shift || shift.status === ShiftStatus.CANCELLED || shift.status === ShiftStatus.COMPLETED) return null;
  const staffProfile = await manager.findOne(StaffProfile, { where: { id: assignment.staffProfileId } });
  if (!staffProfile) return null;
  const user = await manager.findOne(User, { where: { id: staffProfile.userId } });
  if (!user || user.status !== UserStatus.ACTIVE) return null;
  return { assignment, shift, staffProfile, user };
}

export async function runShiftMonitorCycle(
  ownerDataSource: DataSource,
  tenantContext: TenantContextService,
  notificationService: NotificationService,
  auditService: AuditService,
): Promise<ShiftMonitorResult> {
  const discoveries = await discoverInWorkspaces(ownerDataSource, tenantContext, async (manager) => {
      // Two INDEPENDENT scans, each with its own LIMIT — a single `ORDER BY starts_at ASC LIMIT 500` with no lower
      // bound let long-dead CONFIRMED assignments (a clocked-in-never-clocked-out shift, a deactivated user, ...)
      // fill every slot and starve imminent shifts of their reminders forever. The scoped re-check below still
      // decides precisely, using fresh data.
      //   reminders: shifts that have NOT started, starting within a day — soonest first.
      const reminderCandidates = await manager.query<ScanCandidate[]>(`
        SELECT sa.id AS assignment_id, sa.organisation_id, sa.workspace_id, ${assignmentTimeSql().start} AS starts_at
        FROM core.shift_assignment sa
        JOIN core.shift s ON s.id = sa.shift_id
        WHERE sa.status = 'confirmed'
          AND s.status NOT IN ('cancelled', 'completed')
          AND ${assignmentTimeSql().start} > now()
          AND ${assignmentTimeSql().start} <= now() + interval '24 hours 10 minutes'
        ORDER BY ${assignmentTimeSql().start} ASC
        LIMIT 500
      `);
      //   no-shows: shifts already past the grace period — most recent first, so stale rows sink to the back.
      const noShowCandidates = await manager.query<ScanCandidate[]>(
        `
        SELECT sa.id AS assignment_id, sa.organisation_id, sa.workspace_id, ${assignmentTimeSql().start} AS starts_at
        FROM core.shift_assignment sa
        JOIN core.shift s ON s.id = sa.shift_id
        WHERE sa.status = 'confirmed'
          AND s.status NOT IN ('cancelled', 'completed')
          AND ${assignmentTimeSql().start} <= now() - make_interval(secs => $1)
        ORDER BY ${assignmentTimeSql().start} DESC
        LIMIT 500
      `,
        [NO_SHOW_GRACE_MS / 1000],
      );
      const lifecycleCandidates = await PostShiftLifecycleService.discover(manager);
      return [{ assignments: [...reminderCandidates, ...noShowCandidates], lifecycleCandidates }];
  });

  const discovery = { assignments: discoveries.flatMap(d => d.assignments), lifecycleCandidates: discoveries.flatMap(d => d.lifecycleCandidates) };
  let remindersSent = 0;
  let noShowsFlagged = 0;

  for (const candidate of discovery.assignments) {
    const result = await runScopedForOrg(tenantContext, candidate.organisation_id, candidate.workspace_id, async (manager) => {
      // Shared by Pass A (below) and every window/no-show's own Pass B —
      // one definition of "still a real, active, staffed occurrence."
      const loadCurrent = () => loadReminderCandidate(manager, candidate.assignment_id);

      const first = await loadCurrent();
      if (!first) return { reminders: 0, noShow: false };
      const { shift } = first;

      const msUntilStart = effectiveAssignmentTime(first.assignment, shift).startsAt.getTime() - Date.now();
      let reminders = 0;

      if (msUntilStart > 0) {
        for (const window of REMINDER_WINDOWS) {
          if (msUntilStart > window.ms) continue;
          // --- Pass A: still eligible right before claiming this window? ---
          const beforeClaim = await loadCurrent();
          if (!beforeClaim) continue;

          const eventId = await claimWorkerEvent(manager, {
            organisationId: candidate.organisation_id,
            workspaceId: candidate.workspace_id,
            eventKey: `${window.eventKeySlug}:${beforeClaim.assignment.id}`,
            eventType: window.eventKeySlug.replace(/-/g, '_'),
            entityType: 'shift_assignment',
            entityId: beforeClaim.assignment.id,
          });
          if (!eventId) continue; // another replica/tick already claimed this reminder window

          // --- Pass B: final revalidation, immediately before the irreversible side effects. ---
          const beforeSend = await loadCurrent();
          if (!beforeSend) {
            await cancelWorkerEvent(manager, eventId, 'condition_no_longer_true');
            continue;
          }
          const { assignment: currentAssignment, shift: currentShift, user: currentUser } = beforeSend;

          await notificationService.notify(manager, {
            organisationId: candidate.organisation_id,
            userId: currentUser.id,
            type: window.type,
            title: 'Upcoming shift reminder',
            message: `Your shift starts at ${effectiveAssignmentTime(currentAssignment, currentShift).startsAt.toISOString()} (in about ${window.auditNote}).`,
            relatedEntityType: 'shift_assignment',
            relatedEntityId: currentAssignment.id,
          });
          await auditService.record(manager, { organisationId: candidate.organisation_id, userId: '' }, AuditAction.SHIFT_REMINDER_SENT, {
            targetUserId: currentUser.id,
            metadata: { assignmentId: currentAssignment.id, window: window.auditNote },
            actorUserId: null,
          });
          await completeWorkerEvent(manager, eventId);
          reminders += 1;
        }
        return { reminders, noShow: false };
      }

      // Shift has already started — no-show check, gated by grace period.
      if (-msUntilStart < NO_SHOW_GRACE_MS) return { reminders, noShow: false };
      const hasAttendance = await manager.query(`SELECT 1 FROM core.attendance WHERE shift_assignment_id = $1 LIMIT 1`, [first.assignment.id]);
      if (hasAttendance.length > 0) return { reminders, noShow: false };

      // A blind status read-then-write is racy across replicas by itself
      // (two replicas can both observe CONFIRMED and both flip to NO_SHOW,
      // both firing notify()+audit() redundantly even though the final
      // status ends up correct either way) — the worker_event UNIQUE claim
      // is the real cross-replica guard here, not the status transition
      // alone.
      const noShowEventId = await claimWorkerEvent(manager, {
        organisationId: candidate.organisation_id,
        workspaceId: candidate.workspace_id,
        eventKey: `no-show:${first.assignment.id}`,
        eventType: 'no_show',
        entityType: 'shift_assignment',
        entityId: first.assignment.id,
      });
      if (!noShowEventId) return { reminders, noShow: false }; // another replica/tick already claimed this

      // --- Pass B: final revalidation, immediately before the irreversible side effects. ---
      const beforeNoShow = await loadCurrent();
      if (!beforeNoShow) {
        await cancelWorkerEvent(manager, noShowEventId, 'condition_no_longer_true');
        return { reminders, noShow: false };
      }
      const hasAttendanceNow = await manager.query(`SELECT 1 FROM core.attendance WHERE shift_assignment_id = $1 LIMIT 1`, [beforeNoShow.assignment.id]);
      if (hasAttendanceNow.length > 0) {
        await cancelWorkerEvent(manager, noShowEventId, 'staff_clocked_in_before_completion');
        return { reminders, noShow: false };
      }
      const { assignment: noShowAssignment, shift: noShowShift, user: noShowUser } = beforeNoShow;

      assertTransition(SHIFT_ASSIGNMENT_TRANSITIONS, noShowAssignment.status, ShiftAssignmentStatus.NO_SHOW);
      await manager.update(ShiftAssignment, noShowAssignment.id, { status: ShiftAssignmentStatus.NO_SHOW });
      // WORK-02 — was `staffProfile.createdBy ?? user.id`: the manager who
      // onboarded this staff member (an HR relationship), falling back to
      // notifying the STAFF MEMBER THEMSELVES as an "operational manager"
      // recipient if unowned. Replaced with the same canonical resolver
      // `late-clock-in.job.ts` already uses — see its own doc comment. No
      // staff-user fallback: if no valid responsible manager resolves, the
      // notification is simply skipped (never invented), while the status
      // transition, audit record and event completion all still happen.
      const resolvedManager = await resolveResponsibleManager(manager, candidate.organisation_id, noShowAssignment, noShowShift);
      if (resolvedManager) {
        await notificationService.notify(manager, {
          organisationId: candidate.organisation_id,
          userId: resolvedManager.userId,
          type: NotificationType.SHIFT_ASSIGNMENT_NO_SHOW,
          title: 'Staff member did not clock in',
          message: `${noShowUser.firstName} ${noShowUser.lastName} has not clocked in for a shift that started at ${effectiveAssignmentTime(noShowAssignment, noShowShift).startsAt.toISOString()}.`,
          relatedEntityType: 'shift_assignment',
          relatedEntityId: noShowAssignment.id,
        });
      }
      await auditService.record(manager, { organisationId: candidate.organisation_id, userId: '' }, AuditAction.SHIFT_ASSIGNMENT_NO_SHOW, {
        targetUserId: noShowUser.id,
        metadata: {
          assignmentId: noShowAssignment.id,
          notifiedManagerUserId: resolvedManager?.userId ?? null,
          managerResolutionSource: resolvedManager?.source ?? 'none',
        },
        actorUserId: null,
      });
      await completeWorkerEvent(manager, noShowEventId);
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
