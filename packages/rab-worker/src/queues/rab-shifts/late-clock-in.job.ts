import { effectiveAssignmentTime, assignmentTimeSql } from '@rab/server/modules/scheduling/utils/assignment-time';
import { isLateClockIn } from '@rab/server/modules/scheduling/services/late-clock-in';
import { formatLondonDateTime, NotificationType, ShiftAssignmentStatus, ShiftStatus, UserStatus } from '@rab/shared';
import { DataSource } from 'typeorm';

import { AuditAction, AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { Shift } from '@rab/server/modules/scheduling/entities/shift.entity';
import { ShiftAssignment } from '@rab/server/modules/scheduling/entities/shift-assignment.entity';
import { StaffProfile } from '@rab/server/modules/staff/entities/staff-profile.entity';
import { User } from '@rab/server/modules/identity/entities/index';
import { runScopedForOrg } from '../../core/database/scoped-job';
import { claimWorkerEvent, cancelWorkerEvent, completeWorkerEvent } from '../../core/database/worker-event';
import { resolveResponsibleManager } from '../../core/domain/resolve-responsible-manager';
import { discoverInWorkspaces } from '../../core/database/workspace-discovery';

/**
 * Late clock-in detection — a distinct, EARLIER warning than
 * `shift-monitor.job.ts`'s existing no-show detection, not a duplicate of
 * it: this fires once a confirmed shift is `LATE_CLOCK_IN_GRACE_MINUTES`
 * past its start with no clock-in; no-show only fires 30 minutes past start
 * (`NO_SHOW_GRACE_MS` in shift-monitor.job.ts). Both key off the exact same
 * underlying fact (no `core.attendance` row exists yet for this assignment)
 * but at different thresholds, so a staff member running a few minutes
 * late gets a soft heads-up well before they'd ever be flagged a no-show.
 *
 * No `AttendanceStatus` write happens here (unlike `attendance-monitor.
 * job.ts`'s `MISSING_CLOCK_OUT` label) — there is no Attendance row to
 * label yet; clock-in is 100% synchronous and only ever creates one.
 *
 * Idempotency is a `core.worker_event` claim (`event_key =
 * "late-clock-in:{assignmentId}"`, a real UNIQUE constraint) — NOT the
 * existence of a `Notification` row (Phase 2). See
 * `core/database/worker-event.ts`'s own doc comment for the full
 * claim/complete/cancel shape.
 *
 * Same two-phase owner-scan + `rab_app`-scoped-mutation shape as every other
 * operational job — see `shift-monitor.job.ts`'s doc comment for the full
 * cross-replica-safety rationale (this file's own advisory lock name,
 * `rab_late_clock_in`, is what keeps two replicas' DISCOVERY phases from
 * racing; per-candidate safety then comes from the `worker_event` UNIQUE
 * claim, which is the actual cross-replica authority, not the discovery
 * lock alone).
 *
 * PHASE 3 — per-candidate processing is now split into two passes so a race
 * that lands between discovery and the claim (or between the claim and the
 * irreversible side effects) is caught rather than trusted:
 *   Pass A (before claiming): reload the assignment/shift fresh and check
 *     the SAME eligibility conditions discovery used. A candidate that's
 *     already ineligible here never gets a `worker_event` row at all — it
 *     was never really "late" by the time this replica looked at it, so
 *     there is nothing to record.
 *   Claim (`claimWorkerEvent`).
 *   Pass B (final revalidation, immediately before notify/audit — the
 *     irreversible side effects): re-checks the SAME conditions again.
 *     Postgres's READ COMMITTED isolation gives each of these a fresh
 *     snapshot, so Pass B genuinely sees anything another transaction
 *     committed in between (a clock-in, a cancellation, an assignment
 *     change) — if anything is no longer true, the claimed event is
 *     `cancelWorkerEvent`'d with a specific reason instead of completed,
 *     and no notification/audit is ever produced for a condition that
 *     stopped holding.
 */
export interface LateClockInResult {
  flagged: number;
}

interface ScanCandidate {
  assignment_id: string;
  organisation_id: string;
  workspace_id: string | null;
}

/** The SAME core eligibility check used at both discovery time and, again, as Pass A/B inside the scoped transaction — one definition, not three near-duplicates. */
function isStillLate(assignment: ShiftAssignment | null, shift: Shift | null, lateClockInGraceMinutes: number): boolean {
  if (!assignment || !shift) return false;
  return isLateClockIn({ assignmentStatus: assignment.status, shiftStatus: shift.status, startsAt: effectiveAssignmentTime(assignment, shift).startsAt, serverNow: new Date(), graceMinutes: lateClockInGraceMinutes, hasAttendance: false });
}

export async function runLateClockInCycle(
  ownerDataSource: DataSource,
  tenantContext: TenantContextService,
  notificationService: NotificationService,
  auditService: AuditService,
  lateClockInGraceMinutes: number,
): Promise<LateClockInResult> {
  const candidates = await discoverInWorkspaces(ownerDataSource, tenantContext, async (manager) => {
      return await manager.query<ScanCandidate[]>(
        `
        SELECT sa.id AS assignment_id, sa.organisation_id, sa.workspace_id
        FROM core.shift_assignment sa
        JOIN core.shift s ON s.id = sa.shift_id
        WHERE sa.status = 'confirmed'
          AND s.status NOT IN ('cancelled', 'completed')
          AND ${assignmentTimeSql().start} <= now() - make_interval(mins => $1)
          AND NOT EXISTS (SELECT 1 FROM core.attendance a WHERE a.shift_assignment_id = sa.id)
          -- Scan fairness: once THIS assignment's late event has already been
          -- claimed (completed OR cancelled), it stays "confirmed, no
          -- attendance" for the rest of the shift and would otherwise be
          -- re-selected on every single tick forever, consuming a LIMIT slot
          -- a genuinely-new candidate could have used instead. Nothing about
          -- flagging late-ness changes the assignment's own eligibility
          -- columns, so the ledger itself is the only thing that can exclude
          -- an already-processed row from future scans.
          AND NOT EXISTS (
            SELECT 1 FROM core.worker_event we
            WHERE we.event_key = 'late-clock-in:' || sa.id::text
              AND we.status IN ('completed', 'cancelled')
          )
        ORDER BY ${assignmentTimeSql().start} ASC
        LIMIT 500
      `,
        [lateClockInGraceMinutes],
      );
  });

  let flagged = 0;
  for (const candidate of candidates) {
    const didFlag = await runScopedForOrg(tenantContext, candidate.organisation_id, candidate.workspace_id, async (manager) => {
      // --- Pass A: is this candidate still genuinely late? ---
      let assignment = await manager.findOne(ShiftAssignment, { where: { id: candidate.assignment_id } });
      let shift = assignment ? await manager.findOne(Shift, { where: { id: assignment.shiftId } }) : null;
      if (!isStillLate(assignment, shift, lateClockInGraceMinutes)) return false;

      const hasAttendance = await manager.query(`SELECT 1 FROM core.attendance WHERE shift_assignment_id = $1 LIMIT 1`, [assignment!.id]);
      if (hasAttendance.length > 0) return false; // clocked in since the scan — never even worth claiming

      const eventId = await claimWorkerEvent(manager, {
        organisationId: candidate.organisation_id,
        workspaceId: candidate.workspace_id,
        eventKey: `late-clock-in:${assignment!.id}`,
        eventType: 'late_clock_in',
        entityType: 'shift_assignment',
        entityId: assignment!.id,
      });
      if (!eventId) return false; // another replica/tick already claimed this occurrence

      // --- Pass B: final revalidation, immediately before the irreversible side effects. ---
      // Fresh reads under READ COMMITTED — each sees anything another
      // transaction committed since Pass A, closing the race window rather
      // than trusting data that could already be stale.
      assignment = await manager.findOne(ShiftAssignment, { where: { id: candidate.assignment_id } });
      shift = assignment ? await manager.findOne(Shift, { where: { id: assignment.shiftId } }) : null;
      if (!isStillLate(assignment, shift, lateClockInGraceMinutes)) {
        await cancelWorkerEvent(manager, eventId, 'condition_no_longer_true');
        return false;
      }
      const hasAttendanceNow = await manager.query(`SELECT 1 FROM core.attendance WHERE shift_assignment_id = $1 LIMIT 1`, [assignment!.id]);
      if (hasAttendanceNow.length > 0) {
        await cancelWorkerEvent(manager, eventId, 'staff_clocked_in_before_completion');
        return false;
      }

      const staffProfile = await manager.findOne(StaffProfile, { where: { id: assignment!.staffProfileId } });
      const user = staffProfile ? await manager.findOne(User, { where: { id: staffProfile.userId } }) : null;
      if (!staffProfile || !user || user.status !== UserStatus.ACTIVE) {
        await cancelWorkerEvent(manager, eventId, 'staff_profile_or_user_unavailable');
        return false;
      }

      const [venueRow] = await manager.query<Array<{ name: string }>>(`SELECT name FROM core.venue WHERE id = $1`, [shift!.venueId]);
      const [roleRow] = await manager.query<Array<{ name: string }>>(`SELECT name FROM core.job_role WHERE id = $1`, [shift!.jobRoleId]);
      const venueName = venueRow?.name ?? 'the venue';
      const roleName = roleRow?.name ?? null;
      const localStart = formatLondonDateTime(effectiveAssignmentTime(assignment!, shift!).startsAt);

      // Staff: their own shift, their own heads-up.
      await notificationService.notify(manager, {
        organisationId: candidate.organisation_id,
        userId: user.id,
        type: NotificationType.LATE_CLOCK_IN,
        title: 'You have not clocked in',
        message: `Your shift at ${venueName} started at ${localStart}. Please clock in if you are on site.`,
        relatedEntityType: 'shift_assignment',
        relatedEntityId: assignment!.id,
      });

      // Manager: the canonical responsible manager for THIS assignment — see
      // resolve-responsible-manager.ts for why this replaces
      // staffProfile.createdBy. `null` (no valid manager found) is a
      // legitimate, safely-handled outcome, not an error: the event still
      // completes (the staff-facing notification and audit already happened
      // above; there is simply no one else to tell), and nothing retries
      // forever chasing a relationship that is permanently absent.
      const resolvedManager = await resolveResponsibleManager(manager, candidate.organisation_id, assignment!, shift!);
      if (resolvedManager) {
        await notificationService.notify(manager, {
          organisationId: candidate.organisation_id,
          userId: resolvedManager.userId,
          type: NotificationType.LATE_CLOCK_IN,
          title: 'Staff running late',
          message: `${user.firstName} ${user.lastName} has not clocked in for the ${roleName ?? 'shift'} at ${venueName}. Scheduled start: ${localStart}.`,
          relatedEntityType: 'shift_assignment',
          relatedEntityId: assignment!.id,
        });
      }

      await auditService.record(manager, { organisationId: candidate.organisation_id, userId: '' }, AuditAction.LATE_CLOCK_IN_FLAGGED, {
        targetUserId: user.id,
        metadata: {
          assignmentId: assignment!.id,
          shiftId: shift!.id,
          venueId: shift!.venueId,
          staffProfileId: staffProfile.id,
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
