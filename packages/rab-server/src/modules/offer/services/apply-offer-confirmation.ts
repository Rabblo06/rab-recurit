import {
  assertSafePence,
  assertTransition,
  CONFIRMATION_DEADLINE_MESSAGES,
  CONFIRMATION_DEADLINE_PASSED,
  OFFER_CLOSED_REASON,
  OFFER_TRANSITIONS,
  OfferStatus,
  SHIFT_ASSIGNMENT_TRANSITIONS,
  ShiftAssignmentStatus,
  SHIFT_TRANSITIONS,
  ShiftStatus,
} from '@rab/shared';
import { ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { RealtimeEventService, RealtimeEventType } from '../../../engine/core-modules/realtime/realtime-event.service';
import { NotificationService } from '../../notification/services/notification.service';
import { Shift } from '../../scheduling/entities/shift.entity';
import { ShiftAssignment } from '../../scheduling/entities/shift-assignment.entity';
import { StaffProfile } from '../../staff/entities/staff-profile.entity';
import { JobOffer } from '../entities/job-offer.entity';
import { assertShiftActionWindowOpen } from '../../scheduling/utils/shift-action-window';
import { confirmationDeadlineSql } from '../../scheduling/utils/assignment-time';
import { NO_VACANCY_MESSAGE, OfferKind } from '../constants/offer-kind';
import { occupiedSeatSql } from './shift-vacancy';

/** Shift states whose fill status is tracked by confirmations. Past these (started/confirmed) a confirm never moves it. */
const FILL_TRACKED_STATUSES: readonly string[] = [ShiftStatus.OPEN, ShiftStatus.OFFERED, ShiftStatus.PARTIALLY_FILLED, ShiftStatus.FULLY_FILLED];

function isExclusionViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23P01';
}

/**
 * A confirm attempted at or after the offer's manager-confirmation deadline (owner rule 2026-11-06). 409 with the
 * stable `body.code` of the frozen contract. `OfferService` catches it to run the lazy withdrawal (in a second,
 * committing transaction) before rethrowing, so the state and notifications land even when the Worker is down.
 */
export class ConfirmationDeadlinePassedException extends ConflictException {
  constructor(
    readonly offerId: string,
    message: string = CONFIRMATION_DEADLINE_MESSAGES.CONFIRM,
  ) {
    super({ statusCode: 409, code: CONFIRMATION_DEADLINE_PASSED, message });
  }
}

/**
 * The ONE manager-confirmation writer: the only code that sets `job_offer.status = 'manager_confirmed'` and
 * `shift_assignment.status = 'confirmed'`. Owner rule 2026-11-06: the system NEVER confirms; there is exactly one
 * caller, `OfferService.confirmOne()` (an Internal Manager's explicit confirm, single or confirm-all). The previous
 * automatic callers (the staff-accept auto-confirm on Venue-Manager-requested shifts and the Worker's
 * manager-confirmation timeout) were removed, `confirmedBy` is a required human user id, and the audit actor is always
 * the request's own actor (`ctx.inspectedBy ?? ctx.userId`). A static spec pins that nothing else imports this file
 * (`apply-offer-confirmation-callers.spec.ts`).
 *
 * The deadline (standard: assignment start - 30 min; replacement/standby: window end, `confirmationDeadlineSql`) is
 * enforced IN the offer CAS that claims the row, on the database clock: `clock_timestamp() < deadline`. The withdrawal
 * (`withdraw-unconfirmed-offer.ts`) claims the same row with `clock_timestamp() >= deadline`, so the two are mutually
 * exclusive. Clock choice: `clock_timestamp()` (statement time), not `now()` (transaction start): with `now()` a confirm
 * transaction that began before the deadline but claimed the row after it would pass. See THREAT-MODEL's SECURITY
 * TRADE-OFF (Q11): the deadline is judged at the claiming statement, not at COMMIT.
 *
 * This is also where the last-seat race (rab-workforce-architecture.md §8.4) resolves: the atomic `UPDATE ... WHERE
 * filled_count < required_count` is the lock. Whoever's UPDATE returns a row wins the seat; everyone else gets zero rows
 * back and a clean `SHIFT_FULL`, never a duplicate booking. The offer's own status is claimed atomically FIRST (`WHERE
 * status = 'staff_accepted'`), before the filled_count claim, so two concurrent confirms of the SAME offer (double-click,
 * network retry) can never both reach the capacity claim and double-increment filled_count.
 *
 * THROWS `ConflictException` on any safety failure (shift cancelled, deadline passed, offer/assignment no longer in the
 * expected prior state, shift full, or a double-booking exclusion-constraint violation): never caught internally,
 * never downgraded to a fake success.
 */
export async function applyOfferConfirmation(
  manager: EntityManager,
  auditService: AuditService,
  notificationService: NotificationService,
  realtimeEventService: RealtimeEventService,
  ctx: Pick<AuthContext, 'organisationId' | 'userId' | 'inspectedBy'>,
  offer: JobOffer,
  assignment: ShiftAssignment,
  confirmedBy: string,
): Promise<JobOffer> {
  // Fail closed: a confirmation always names the human who made it.
  if (!confirmedBy || !ctx.userId || !ctx.organisationId) throw new ConflictException('A confirmation needs an authenticated manager.');
  const kind = offer.offerKind ?? OfferKind.STANDARD;
  const deadlineMessage = kind === OfferKind.STANDARD ? CONFIRMATION_DEADLINE_MESSAGES.CONFIRM : CONFIRMATION_DEADLINE_MESSAGES.CONFIRM_REPLACEMENT;
  // Already withdrawn at its deadline (by the Worker or an earlier lazy withdrawal): answer with the same coded 409 a
  // late confirm gets, not a generic invalid-transition error.
  if (
    offer.status === OfferStatus.MANAGER_REJECTED &&
    offer.rejectedBy == null &&
    offer.rejectionReason === OFFER_CLOSED_REASON.CONFIRMATION_DEADLINE_PASSED
  ) {
    throw new ConfirmationDeadlinePassedException(offer.id, deadlineMessage);
  }
  // PHASE 5 (§5) — lock + reload the shift BEFORE confirming, so a cancelled shift fails early with an explicit message.
  const shift = await manager.findOne(Shift, { where: { id: assignment.shiftId }, lock: { mode: 'pessimistic_write' } });
  if (!shift || shift.status === ShiftStatus.CANCELLED) {
    throw new ConflictException('This shift has been cancelled and can no longer be confirmed.');
  }
  if (shift.status === ShiftStatus.COMPLETED) {
    throw new ConflictException('This shift is complete and can no longer take a confirmation.');
  }
  assertTransition(OFFER_TRANSITIONS, offer.status, OfferStatus.MANAGER_CONFIRMED);
  assertTransition(SHIFT_ASSIGNMENT_TRANSITIONS, assignment.status, ShiftAssignmentStatus.CONFIRMED);

  // The deadline authority: claim the offer row only while still staff_accepted, in this organisation, and strictly
  // before its deadline by the database clock. (A replacement/standby's deadline is its window end, so this also
  // replaces the earlier separate "window has ended" read.)
  const deadline = confirmationDeadlineSql('o', 'sa', 's');
  const [confirmedRows] = (await manager.query(
    // sql-injection-reviewed: code-constant SQL fragment from a helper called with literal aliases; values are bound $n parameters.
    `UPDATE job_offer o SET status = 'manager_confirmed', manager_confirmed_at = clock_timestamp(), confirmed_by = $1
       FROM shift_assignment sa JOIN shift s ON s.id = sa.shift_id
      WHERE o.id = $2 AND o.organisation_id = $3 AND o.status = 'staff_accepted'
        AND sa.id = o.shift_assignment_id
        AND clock_timestamp() < ${deadline}
      RETURNING o.id`,
    [confirmedBy, offer.id, ctx.organisationId],
  )) as [Array<{ id: string }>, number];
  if (confirmedRows.length === 0) {
    const [state] = await manager.query<Array<{ status: string; past: boolean }>>(
      // sql-injection-reviewed: code-constant SQL fragment from a helper called with literal aliases; values are bound $n parameters.
      `SELECT o.status, clock_timestamp() >= ${deadline} AS past
         FROM job_offer o JOIN shift_assignment sa ON sa.id = o.shift_assignment_id JOIN shift s ON s.id = sa.shift_id
        WHERE o.id = $1`,
      [offer.id],
    );
    if (state && state.status === OfferStatus.STAFF_ACCEPTED && state.past) throw new ConfirmationDeadlinePassedException(offer.id, deadlineMessage);
    throw new ConflictException('This offer was already confirmed or is no longer awaiting confirmation.');
  }
  // The generic post-end action window (end + SHIFT_ACTION_WINDOW_HOURS) is always looser than the deadline now; kept as
  // defence in depth (a failure here rolls the claim above back with the rest of this transaction).
  await assertShiftActionWindowOpen(manager, shift.id, 'confirm');

  // TypeORM's manager.query() returns [rows, rowCount] for UPDATE/DELETE
  // statements (unlike SELECT, which returns rows directly) — not the rows
  // array itself.
  //
  // Replacement & standby (2026-10-21) — the seat claim counts LIVE occupied seats (`occupiedSeatSql`: confirmed,
  // completed and PROVISIONAL no-shows; a manager-CONFIRMED no-show no longer occupies its seat), under the shift row
  // lock taken above, so concurrent approvals serialise and each one's count sees the previous one's committed seat.
  // effectiveFilled = GREATEST(occupied, filled_count − confirmed no-shows) is deliberately conservative: on a shift
  // with no confirmed no-show it equals the old `filled_count` check exactly (consistent data has filled_count ==
  // occupied), and a legacy/denormalised filled_count can only ever make it stricter, never looser. filled_count is
  // re-written as effectiveFilled + 1 (≤ required_count by the WHERE, so `shift_capacity_bound` holds).
  const [claimedRows] = (await manager.query(
    // sql-injection-reviewed: code-constant SQL fragment from a helper called with literal aliases; values are bound $n parameters.
    `UPDATE shift s SET filled_count = GREATEST(seats.occupied, s.filled_count - seats.confirmed_no_shows) + 1, updated_at = now()
       FROM (SELECT count(*) FILTER (WHERE ${occupiedSeatSql('sa')})::int AS occupied,
                    count(*) FILTER (WHERE sa.status = 'no_show' AND sa.attendance_reviewed_at IS NOT NULL)::int AS confirmed_no_shows
               FROM shift_assignment sa WHERE sa.shift_id = $1) seats
      WHERE s.id = $1 AND s.organisation_id = $2
        AND GREATEST(seats.occupied, s.filled_count - seats.confirmed_no_shows) < s.required_count
      RETURNING s.filled_count, s.required_count, s.pay_rate_pence, s.status`,
    [assignment.shiftId, ctx.organisationId],
  )) as [Array<Record<string, unknown>>, number];
  if (claimedRows.length === 0) {
    throw new ConflictException(
      kind === OfferKind.STANDBY ? NO_VACANCY_MESSAGE : 'SHIFT_FULL: This shift is now full. Another offer may already be confirmed.',
    );
  }

  const row = claimedRows[0] as {
    filled_count: number;
    required_count: number;
    pay_rate_pence: string;
    status: string;
  };
  const nextShiftStatus = row.filled_count >= row.required_count ? ShiftStatus.FULLY_FILLED : ShiftStatus.PARTIALLY_FILLED;
  // Only assert a transition when the status is actually changing —
  // SHIFT_TRANSITIONS has no PARTIALLY_FILLED→PARTIALLY_FILLED self-edge
  // (state machines don't define self-loops as "valid transitions"), but
  // confirming the 2nd of 3 required seats on an already-partially-filled
  // shift is a legitimate filled_count increment with no status change at
  // all, not an invalid transition.
  // A replacement confirmed on a shift that is already running (IN_PROGRESS) or CONFIRMED keeps that status — the
  // fill states describe recruitment before the shift, not a seat refilled during it (no new transition is invented).
  // Standard offers keep the exact previous behaviour (an invalid transition, e.g. from IN_PROGRESS, still throws).
  const tracksFill = kind === OfferKind.STANDARD || FILL_TRACKED_STATUSES.includes(row.status);
  if (tracksFill && row.status !== nextShiftStatus) {
    assertTransition(SHIFT_TRANSITIONS, row.status as typeof ShiftStatus.OPEN, nextShiftStatus);
  }
  if (kind !== OfferKind.STANDARD) {
    // Attendance for a replacement starts at THEIR real clock-in; the booked window starts no earlier than this approval,
    // so the no-show / late-clock-in monitors never count time before the person was even booked (FLAGGED rule).
    await manager.query(
      `UPDATE shift_assignment SET period = tstzrange(now(), upper(period), '[)') WHERE id = $1 AND lower(period) < now() AND upper(period) > now()`,
      [assignment.id],
    );
  }

  try {
    await manager.update(ShiftAssignment, assignment.id, {
      status: ShiftAssignmentStatus.CONFIRMED,
      confirmedAt: new Date(),
      // Snapshotted at confirmation, not at send or staff-accept (§1 A6) —
      // re-read from the shift row just locked by the UPDATE above, in
      // case the rate changed since the offer was sent.
      payRateSnapshotPence: assertSafePence(Number(row.pay_rate_pence), 'shift.pay_rate_pence'),
    });
  } catch (error) {
    if (isExclusionViolation(error)) {
      throw new ConflictException('This staff member already has a confirmed shift that overlaps this one — this offer cannot be confirmed.');
    }
    throw error;
  }

  if (tracksFill) await manager.update(Shift, assignment.shiftId, { status: nextShiftStatus });

  const confirmed = await manager.findOneByOrFail(JobOffer, { id: offer.id });

  await auditService.record(manager, ctx, AuditAction.OFFER_CONFIRMED, {
    entityType: 'offer',
    entityId: offer.id,
    metadata: {
      offerBatchId: offer.offerBatchId,
      ...(kind !== OfferKind.STANDARD ? { offerKind: kind, shiftId: assignment.shiftId } : {}),
    },
  });
  const staffProfile = await manager.findOne(StaffProfile, { where: { id: offer.staffProfileId } });
  if (staffProfile) {
    await notificationService.notify(manager, {
      organisationId: ctx.organisationId!,
      userId: staffProfile.userId,
      type: 'offer_confirmed',
      title: 'Shift confirmed',
      message: 'Your shift offer has been confirmed.',
      relatedEntityType: 'offer',
      relatedEntityId: offer.id,
    });
    // Stage 5 — same transaction, same atomic-outbox pattern as `offer.sent`/
    // `offer.accepted` (never a second outbox). Staff-facing: lets the mobile
    // Confirmed/Upcoming screens (both backed by the same `OffersProvider`,
    // see `offers_provider.dart`) refresh the moment a Manager confirms,
    // instead of waiting for the next 30s reconcile poll.
    await realtimeEventService.record(manager, {
      organisationId: ctx.organisationId!,
      workspaceId: assignment.workspaceId,
      targetUserId: staffProfile.userId,
      eventKey: `offer.confirmed:${offer.id}`,
      eventType: RealtimeEventType.OFFER_CONFIRMED,
      entityType: 'offer',
      entityId: offer.id,
    });
  }

  return confirmed;
}
