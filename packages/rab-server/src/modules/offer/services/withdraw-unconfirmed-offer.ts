import {
  assertTransition,
  CONFIRMATION_DEADLINE_NOTIFICATION,
  NotificationType,
  NotificationTypeType,
  OFFER_CLOSED_REASON,
  OFFER_TRANSITIONS,
  OfferStatus,
  SHIFT_ASSIGNMENT_TRANSITIONS,
  ShiftAssignmentStatus,
} from '@rab/shared';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { RealtimeEventService, RealtimeEventType } from '../../../engine/core-modules/realtime/realtime-event.service';
import { offerAudience, venueManagerUserIds } from '../../../engine/core-modules/realtime/realtime-recipients';
import { NotificationService } from '../../notification/services/notification.service';
import { Shift } from '../../scheduling/entities/shift.entity';
import { ShiftAssignment } from '../../scheduling/entities/shift-assignment.entity';
import { assignmentTimeSql, confirmationDeadlineSql } from '../../scheduling/utils/assignment-time';
import { resolveResponsibleManager } from '../../scheduling/utils/resolve-responsible-manager';

export interface WithdrawUnconfirmedOfferDeps {
  auditService: AuditService;
  notificationService: NotificationService;
  /** Optional only so callers that predate realtime keep their shape; every production caller passes it. */
  realtimeEventService?: RealtimeEventService;
}

/** Which path performed the withdrawal — audit metadata only, never used for a decision. */
export type WithdrawalSource = 'worker_pointer' | 'worker_scan' | 'timer_trigger' | 'api_confirm';

export interface WithdrawnOffer {
  offerId: string;
  shiftAssignmentId: string;
  shiftId: string;
  deadlineAt: Date;
  /** Whether staff, the responsible manager and the venue's Venue Managers were notified (see NOTIFY_SQL). */
  notified: boolean;
}

/**
 * Notification window (owner decision Q4 + coordinator default, 2026-11-06, open to owner veto): notify only while the
 * assignment has not yet ended, OR within one hour of the deadline. The second clause exists because a REPLACEMENT /
 * STANDBY offer's deadline IS its window end (Q1b), so "not yet ended" alone would never notify for them; one hour
 * covers a normal Worker cadence and short outages. The go-live backlog (offers whose assignment ended long ago) and very
 * long Worker outages close silently — they are still withdrawn and audited.
 */
const NOTIFY_GRACE = `interval '1 hour'`;

/**
 * THE one race-safe withdrawal of an unconfirmed acceptance at its manager-confirmation deadline (owner rule
 * 2026-11-06). A plain function (no DI) like `applyOfferConfirmation` / `claimExpiredOffer`, so the Worker (pointer
 * cycle, backstop scan, timer trigger) and the API's lazy path (a confirm attempted after the deadline) run EXACTLY the
 * same compare-and-set and side effects. Runs inside the caller's tenant-scoped transaction (runScopedForOrg /
 * runInWorkspaceContext: SET LOCAL + FORCE RLS), never on its own connection.
 *
 * Terminal state (owner decision Q7, option A — no new status, no new transition): offer `staff_accepted →
 * manager_rejected` with `rejected_by = NULL` and `rejection_reason = 'confirmation_deadline_passed'`; assignment
 * `staff_accepted → rejected`. History is kept. `staff_accepted` never held a seat, so there is no capacity or shift
 * status to undo; `rejected` is outside every attendance, no-show, late, reminder and payroll query. `manager_rejected`
 * is terminal, so a later confirmation is impossible (`assertTransition` throws), and it is not a trigger of the
 * automatic replacement-request job (that fires only on declined/expired) — no automatic re-allocation (Q10).
 *
 * Mutual exclusion: the CAS claims the `job_offer` row FIRST with `status = 'staff_accepted'`, on the DATABASE clock
 * (`clock_timestamp() >= deadline`) — the same row every competitor claims first (manager confirm, whose CAS requires
 * `clock_timestamp() < deadline`; manager reject; pipeline cancel; the shift-cancellation follow-up; another Worker; the
 * API lazy path). Exactly one wins; the others match zero rows. A Worker that runs late still applies the ORIGINAL
 * deadline (it is recomputed from the assignment, never from the processing time). A cancelled shift is skipped: the
 * cancellation follow-up closes those with the truthful reason. Lock order offer → assignment, never `shift`, so it
 * cannot deadlock with confirm (shift → offer → assignment).
 *
 * Side effects run only for the CAS winner, in the same transaction (a rollback discards all of them): audit
 * `offer.rejected_by_worker` (actor NULL — a system action, never a fabricated manager), the notifications (staff,
 * responsible manager, the venue's Venue Managers — Q9), and the realtime `offer.rejected` envelope. Returns null (and
 * does nothing) when the CAS matched no row.
 */
export async function withdrawUnconfirmedOffer(
  manager: EntityManager,
  deps: WithdrawUnconfirmedOfferDeps,
  organisationId: string,
  offerId: string,
  source: WithdrawalSource,
): Promise<WithdrawnOffer | null> {
  const deadline = confirmationDeadlineSql('o', 'sa', 's');
  const end = assignmentTimeSql('sa', 's').end;
  const [rows] = (await manager.query(
    // sql-injection-reviewed: code-constant SQL fragments from helpers called with literal aliases; values are bound $n parameters.
    `UPDATE job_offer o
        SET status = 'manager_rejected', manager_rejected_at = clock_timestamp(), rejected_by = NULL, rejection_reason = $3
       FROM shift_assignment sa JOIN shift s ON s.id = sa.shift_id
      WHERE o.id = $1 AND o.organisation_id = $2 AND o.status = 'staff_accepted'
        AND sa.id = o.shift_assignment_id AND sa.status = 'staff_accepted'
        AND s.status <> 'cancelled'
        AND clock_timestamp() >= ${deadline}
    RETURNING o.id, o.shift_assignment_id, o.offer_kind, o.offer_batch_id, sa.shift_id, ${deadline} AS deadline_at,
              (clock_timestamp() < ${end} OR clock_timestamp() < ${deadline} + ${NOTIFY_GRACE}) AS notify,
              (extract(epoch FROM clock_timestamp() - ${deadline}) * 1000)::bigint AS lag_ms`,
    [offerId, organisationId, OFFER_CLOSED_REASON.CONFIRMATION_DEADLINE_PASSED],
  )) as [Array<{ id: string; shift_assignment_id: string; offer_kind: string | null; offer_batch_id: string | null; shift_id: string; deadline_at: Date; notify: boolean; lag_ms: string }>, number];
  const row = rows[0];
  if (!row) return null;

  // The in-memory state-machine check every other path makes (both edges are constants here; it can never fail, but a
  // future edit to the transition tables must break this loudly rather than silently).
  assertTransition(OFFER_TRANSITIONS, OfferStatus.STAFF_ACCEPTED, OfferStatus.MANAGER_REJECTED);
  assertTransition(SHIFT_ASSIGNMENT_TRANSITIONS, ShiftAssignmentStatus.STAFF_ACCEPTED, ShiftAssignmentStatus.REJECTED);
  await manager.query(`UPDATE shift_assignment SET status = 'rejected' WHERE id = $1 AND status = 'staff_accepted'`, [row.shift_assignment_id]);

  const deadlineAt = new Date(row.deadline_at);
  await deps.auditService.record(manager, { organisationId, userId: '' }, AuditAction.OFFER_REJECTED_BY_WORKER, {
    entityType: 'offer',
    entityId: row.id,
    metadata: {
      reason: OFFER_CLOSED_REASON.CONFIRMATION_DEADLINE_PASSED,
      source,
      deadlineAt: deadlineAt.toISOString(),
      shiftId: row.shift_id,
      offerKind: row.offer_kind ?? 'standard',
      offerBatchId: row.offer_batch_id,
      processedLagMs: Number(row.lag_ms),
      notified: row.notify,
    },
    actorUserId: null,
  });

  if (row.notify) {
    const assignment = await manager.findOne(ShiftAssignment, { where: { id: row.shift_assignment_id } });
    const shift = await manager.findOne(Shift, { where: { id: row.shift_id } });
    const [staff] = await manager.query<Array<{ user_id: string }>>(
      `SELECT sp.user_id FROM job_offer o JOIN staff_profile sp ON sp.id = o.staff_profile_id WHERE o.id = $1`,
      [row.id],
    );
    const notified = new Set<string>();
    const send = async (userId: string, copy: { type: NotificationTypeType; title: string; message: string }) => {
      if (notified.has(userId)) return; // one notice per person per withdrawal, even if they hold two roles
      notified.add(userId);
      await deps.notificationService.notify(manager, {
        organisationId,
        userId,
        type: copy.type,
        title: copy.title,
        message: copy.message,
        relatedEntityType: 'offer',
        relatedEntityId: row.id,
      });
    };
    if (staff?.user_id) await send(staff.user_id, { ...CONFIRMATION_DEADLINE_NOTIFICATION.STAFF, type: NotificationType.OFFER_REJECTED });
    if (assignment && shift) {
      const responsible = await resolveResponsibleManager(manager, organisationId, assignment, shift);
      if (responsible) await send(responsible.userId, { ...CONFIRMATION_DEADLINE_NOTIFICATION.MANAGER, type: NotificationType.MANAGER_CONFIRMATION_TIMEOUT });
      // Q9: the Venue Managers of THIS shift's venue only (the same venue rule as their read scope and the realtime
      // audience: a venue_manager role holder with a manager_venue row for this venue, active account). A Venue Manager
      // of another venue never hears about it.
      for (const vmUserId of await venueManagerUserIds(manager, shift.venueId)) {
        await send(vmUserId, { ...CONFIRMATION_DEADLINE_NOTIFICATION.VENUE_MANAGER, type: NotificationType.MANAGER_CONFIRMATION_TIMEOUT });
      }
    }
  }

  // Ids only. The outbox key is unique, and only one terminal transition of this offer can ever win, so this is emitted once.
  await deps.realtimeEventService?.recordForRecipients(
    manager,
    { organisationId, eventKey: `offer.rejected:${row.id}`, eventType: RealtimeEventType.OFFER_REJECTED, entityType: 'offer', entityId: row.id, payload: { shiftId: row.shift_id } },
    (m) => offerAudience(m, row.id),
  );

  return { offerId: row.id, shiftAssignmentId: row.shift_assignment_id, shiftId: row.shift_id, deadlineAt, notified: row.notify };
}
