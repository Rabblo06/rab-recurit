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
 * Shift-time monitoring — reminders (24h/2h/30m before a confirmed shift,
 * plus a 4th window when the clock-in window itself opens) and no-show
 * detection, combined into one periodic scan since both key off the same
 * `shift_assignment` × `shift` join. A **periodic scan**, not a
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
 * EACH candidate is re-loaded and mutated inside its own `crewflow`-scoped
 * transaction (`runScopedForOrg`) — never mutated over the owner connection
 * itself, unlike the maintenance sweep this pattern is modelled on. This is
 * the explicit distinction CLAUDE.md's layer-2 rule and this task's own
 * brief draw between "genuinely cross-tenant maintenance" (owner connection
 * throughout) and "operational per-row work" (owner connection for
 * discovery only, `crewflow` + real tenant context for every mutation).
 *
 * Staleness bound for every window, including the new one: all four only
 * ever fire inside the `if (msUntilStart > 0)` block below — once a shift
 * has actually started, none of them can fire any more regardless of how
 * late the worker is catching up, so "clock-in is now available" can never
 * surface hours after it stopped being the relevant message. The only
 * latency any window has is "up to one `SHIFT_MONITOR_INTERVAL_MS` poll
 * tick" (5 minutes today) — the same tolerance the pre-existing 24h/2h/30m
 * windows have always had; nothing about adding a 4th window changes it.
 */

interface ReminderWindowDefinition {
  type: NotificationTypeType;
  /** Threshold against `msUntilStart` — fires the first scan where `msUntilStart <= ms`. */
  ms: number;
  /** Short label for audit metadata/event-type derivation — never user-facing. */
  auditNote: string;
  eventKeySlug: string;
  title: string;
  buildMessage: (snapshot: ReminderCandidateSnapshot) => string;
  /**
   * Only the clock-in-window-open window sets this. The 24h/2h/30m windows
   * deliberately keep their pre-existing behaviour (no attendance check) —
   * nothing in this change alters what they already do.
   */
  requiresNoAttendance: boolean;
}

const FIXED_REMINDER_WINDOWS: ReminderWindowDefinition[] = [
  {
    type: NotificationType.SHIFT_REMINDER_24H,
    ms: 24 * 3600 * 1000,
    auditNote: '24h',
    eventKeySlug: 'shift-reminder-24h',
    title: 'Upcoming shift reminder',
    buildMessage: ({ assignment, shift }) => `Your shift starts at ${effectiveAssignmentTime(assignment, shift).startsAt.toISOString()} (in about 24h).`,
    requiresNoAttendance: false,
  },
  {
    type: NotificationType.SHIFT_REMINDER_2H,
    ms: 2 * 3600 * 1000,
    auditNote: '2h',
    eventKeySlug: 'shift-reminder-2h',
    title: 'Upcoming shift reminder',
    buildMessage: ({ assignment, shift }) => `Your shift starts at ${effectiveAssignmentTime(assignment, shift).startsAt.toISOString()} (in about 2h).`,
    requiresNoAttendance: false,
  },
  {
    type: NotificationType.SHIFT_REMINDER_30M,
    ms: 30 * 60 * 1000,
    auditNote: '30m',
    eventKeySlug: 'shift-reminder-30m',
    title: 'Upcoming shift reminder',
    buildMessage: ({ assignment, shift }) => `Your shift starts at ${effectiveAssignmentTime(assignment, shift).startsAt.toISOString()} (in about 30m).`,
    requiresNoAttendance: false,
  },
];

const CLOCK_IN_WINDOW_OPEN_EVENT_SLUG = 'clock-in-window-open';

/**
 * `ms` is derived from `CLOCK_IN_EARLY_MINUTES` — the SAME env var and the
 * SAME `effectiveAssignmentTime(assignment, shift).startsAt` basis
 * `AttendanceService.assertClockWindow` uses for its own authoritative
 * `earliestClockIn = shift.startsAt − CLOCK_IN_EARLY_MINUTES` check
 * (attendance.service.ts, `assertClockWindow`/`clockIn` — called as
 * `assertClockWindow(effectiveAssignmentTime(assignment, shift))`). This is
 * the identical formula, not a second invented one: `msUntilStart <=
 * CLOCK_IN_EARLY_MINUTES * 60_000` is algebraically the same condition as
 * `now >= shift.startsAt − CLOCK_IN_EARLY_MINUTES`. Nothing here calls
 * `AttendanceService` directly (that method is private and throws rather
 * than returning a boolean) — this computes the same threshold the way
 * every other window in this file already computes its own.
 *
 * Deliberately NEVER added if its `ms` exactly matches one of the three
 * fixed windows' `ms` (e.g. `CLOCK_IN_EARLY_MINUTES=30` colliding with the
 * 30-minute reminder) — see `buildReminderWindows` below for why.
 */
function buildClockInWindowOpenDefinition(clockInEarlyMinutes: number): ReminderWindowDefinition {
  return {
    type: NotificationType.CLOCK_IN_WINDOW_OPEN,
    ms: clockInEarlyMinutes * 60_000,
    auditNote: CLOCK_IN_WINDOW_OPEN_EVENT_SLUG,
    eventKeySlug: CLOCK_IN_WINDOW_OPEN_EVENT_SLUG,
    title: 'Clock-In Is Available',
    buildMessage: () => "Your shift clock-in window is now open. Open Crewflow to clock in when you're at the venue.",
    requiresNoAttendance: true,
  };
}

/**
 * Builds the full window list for one scan. The clock-in-window-open window
 * is OMITTED entirely when its threshold exactly coincides with one of the
 * three fixed windows' thresholds — a deliberate consolidation rule, not an
 * oversight: when e.g. `CLOCK_IN_EARLY_MINUTES=30`, the 30-minute shift
 * reminder and "clock-in is now available" would both become eligible on
 * the exact same scan for the exact same assignment, producing two
 * near-simultaneous pushes for what is, to the member receiving them, one
 * moment ("your shift is basically now"). The pre-existing 30-minute
 * reminder already carries that signal; a second, separately-worded push
 * seconds apart adds noise, not information. No fixed window's own
 * behaviour changes either way — this only ever suppresses the NEW window,
 * never an existing one.
 */
function buildReminderWindows(clockInEarlyMinutes: number): ReminderWindowDefinition[] {
  const clockInWindow = buildClockInWindowOpenDefinition(clockInEarlyMinutes);
  const collides = FIXED_REMINDER_WINDOWS.some((w) => w.ms === clockInWindow.ms);
  return collides ? FIXED_REMINDER_WINDOWS : [...FIXED_REMINDER_WINDOWS, clockInWindow];
}

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
async function hasAttendanceRow(manager: EntityManager, assignmentId: string): Promise<boolean> {
  const rows = await manager.query(`SELECT 1 FROM attendance WHERE shift_assignment_id = $1 LIMIT 1`, [assignmentId]);
  return rows.length > 0;
}

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
  clockInEarlyMinutes: number,
): Promise<ShiftMonitorResult> {
  const reminderWindows = buildReminderWindows(clockInEarlyMinutes);
  const discoveries = await discoverInWorkspaces(ownerDataSource, tenantContext, async (manager) => {
      // P2.2 — ONE round trip, not two: the reminder and no-show branches are combined via
      // UNION ALL of two independently-LIMITed subqueries, rather than two separate
      // `manager.query()` calls. Each branch keeps its OWN `ORDER BY ... LIMIT 500` — this is
      // not a cosmetic merge: a single combined `ORDER BY starts_at LIMIT 1000` would NOT be
      // equivalent and would reintroduce exactly the starvation bug the original two-query split
      // existed to avoid (long-dead CONFIRMED assignments filling every slot and starving
      // imminent shifts of their reminders). Halving the round-trips matters here specifically
      // because this callback runs once per workspace via `discoverInWorkspaces`, and this
      // dev database alone has 9,673 workspaces (see that function's own doc comment) — one
      // fewer query per workspace is a real, measurable, risk-free reduction in total worker
      // round-trips, not a micro-optimisation.
      //   reminders: shifts that have NOT started, starting within a day — soonest first.
      //   no-shows: shifts already past the grace period — most recent first, so stale rows sink to the back.
      const combinedCandidates = await manager.query<ScanCandidate[]>(
        `
        (SELECT sa.id AS assignment_id, sa.organisation_id, sa.workspace_id, ${assignmentTimeSql().start} AS starts_at
           FROM shift_assignment sa
           JOIN shift s ON s.id = sa.shift_id
          WHERE sa.status = 'confirmed'
            AND s.status NOT IN ('cancelled', 'completed')
            AND ${assignmentTimeSql().start} > now()
            AND ${assignmentTimeSql().start} <= now() + interval '24 hours 10 minutes'
          ORDER BY ${assignmentTimeSql().start} ASC
          LIMIT 500)
        UNION ALL
        (SELECT sa.id AS assignment_id, sa.organisation_id, sa.workspace_id, ${assignmentTimeSql().start} AS starts_at
           FROM shift_assignment sa
           JOIN shift s ON s.id = sa.shift_id
          WHERE sa.status = 'confirmed'
            AND s.status NOT IN ('cancelled', 'completed')
            AND ${assignmentTimeSql().start} <= now() - make_interval(secs => $1)
          ORDER BY ${assignmentTimeSql().start} DESC
          LIMIT 500)
      `,
        [NO_SHOW_GRACE_MS / 1000],
      );
      const lifecycleCandidates = await PostShiftLifecycleService.discover(manager);
      return [{ assignments: combinedCandidates, lifecycleCandidates }];
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
        for (const window of reminderWindows) {
          if (msUntilStart > window.ms) continue;
          // --- Pass A: still eligible right before claiming this window? ---
          const beforeClaim = await loadCurrent();
          if (!beforeClaim) continue;
          if (window.requiresNoAttendance && (await hasAttendanceRow(manager, beforeClaim.assignment.id))) continue;

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
          // Catches a clock-in landing in the exact window between the claim above and now —
          // e.g. the member clocked in seconds before this worker reached the irreversible
          // notify() call. The reminder is suppressed, never sent for a window that is already moot.
          if (window.requiresNoAttendance && (await hasAttendanceRow(manager, beforeSend.assignment.id))) {
            await cancelWorkerEvent(manager, eventId, 'staff_clocked_in_before_completion');
            continue;
          }
          const { assignment: currentAssignment, user: currentUser } = beforeSend;

          await notificationService.notify(manager, {
            organisationId: candidate.organisation_id,
            userId: currentUser.id,
            type: window.type,
            title: window.title,
            message: window.buildMessage(beforeSend),
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
      const hasAttendance = await manager.query(`SELECT 1 FROM attendance WHERE shift_assignment_id = $1 LIMIT 1`, [first.assignment.id]);
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
      const hasAttendanceNow = await manager.query(`SELECT 1 FROM attendance WHERE shift_assignment_id = $1 LIMIT 1`, [beforeNoShow.assignment.id]);
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
