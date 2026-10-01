import { assertTransition, OFFER_TRANSITIONS, OfferStatus, SHIFT_ASSIGNMENT_TRANSITIONS, ShiftAssignmentStatus, SHIFT_TRANSITIONS, ShiftStatus } from '@rab/shared';
import { ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { NotificationService } from '../../notification/services/notification.service';
import { Shift } from '../../scheduling/entities/shift.entity';
import { ShiftAssignment } from '../../scheduling/entities/shift-assignment.entity';
import { StaffProfile } from '../../staff/entities/staff-profile.entity';
import { JobOffer } from '../entities/job-offer.entity';

function isExclusionViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23P01';
}

/**
 * PHASE 4/5/6 — the shared seat-claiming core, unchanged in substance since
 * its introduction, only EXTRACTED (Phase 7.1) out of `OfferService` into a
 * standalone function so a caller with no NestJS DI container — the
 * manager-confirmation-timeout worker (`offer-expiry.job.ts`), which has no
 * way to invoke an injected class method — can reuse the EXACT SAME
 * invariants a real Manager's confirm click already enforces, rather than a
 * second, drifting implementation. This is the direct answer to Phase 7.1's
 * own instruction: "the timeout must use the SAME seat-claiming and safety
 * logic as a real Manager confirmation."
 *
 * Called from three places, all passing the SAME function, never a
 * reimplementation: `OfferService.confirmOne()` (an Internal Manager's
 * explicit confirm click, `confirmedBy` = their own userId),
 * `OfferService.staffAccept()`'s auto-confirm branch (immediately,
 * automatically, only for a Venue-Manager-request-originated shift,
 * `confirmedBy: null` since no manager actually clicked confirm — see
 * `Shift.requestedBy`'s own doc comment), and (Phase 7.1, new)
 * `offer-expiry.job.ts`'s manager-confirmation-timeout worker
 * (`confirmedBy: null`, `auditMetadataSource: 'manager_confirmation_
 * timeout'` — a SYSTEM confirmation, never a fabricated Manager identity).
 *
 * This is where the last-seat race (rab-workforce-architecture.md §8.4)
 * actually resolves: the atomic `UPDATE ... WHERE filled_count <
 * required_count` is the lock. Whoever's UPDATE returns a row wins the
 * seat; everyone else gets zero rows back and a clean `SHIFT_FULL`, never a
 * duplicate booking.
 *
 * The offer's own status is claimed atomically FIRST (`WHERE status =
 * :priorStatus`), before the filled_count claim below — without this, two
 * concurrent confirms of the SAME offer (double-click, network retry, or —
 * Phase 7.1 — a real Manager confirm racing the timeout worker) both pass
 * the in-memory `assertTransition` check (neither has committed yet), then
 * both reach the filled_count UPDATE: the first's row lock blocks the
 * second until it commits, and under READ COMMITTED the second's UPDATE
 * then re-evaluates against the now-committed row and can ALSO succeed if
 * capacity allows — incrementing filled_count twice for one real
 * confirmation. Claiming the offer's status first closes that window: only
 * one caller can ever win the `WHERE status = STAFF_ACCEPTED` guard, so
 * only one caller ever reaches the capacity claim for this offer. The
 * `$5`/prior-status parameter is evaluated by Postgres against the LIVE
 * row regardless of how stale the caller's own in-memory `offer` read was
 * — a caller racing the timeout worker (or vice versa) simply finds zero
 * rows if the other side already won, exactly like every other offer-CAS
 * in this codebase.
 *
 * THROWS `ConflictException` on any safety failure (shift cancelled, offer/
 * assignment no longer in the expected prior state, shift full, or a
 * double-booking exclusion-constraint violation) — deliberately never
 * caught internally, never silently downgraded to a fake success or an
 * invented auto-reject. A caller with no legitimate business reason to
 * treat that failure as terminal (Phase 7.1's timeout worker, specifically)
 * must let it propagate out of its own transaction so nothing partial
 * commits, leaving the offer retryable on a later tick — see that call
 * site's own comment.
 */
export async function applyOfferConfirmation(
  manager: EntityManager,
  auditService: AuditService,
  notificationService: NotificationService,
  ctx: Pick<AuthContext, 'organisationId' | 'userId' | 'inspectedBy'>,
  offer: JobOffer,
  assignment: ShiftAssignment,
  confirmedBy: string | null,
  auditMetadataSource?: string,
  // Omit to preserve each EXISTING caller's own default actor attribution
  // (`AuditService.record`'s own `ctx.inspectedBy ?? ctx.userId` — the real
  // Manager for `confirmOne`, the staff member who triggered the
  // auto-confirm-on-accept path) — never derived from `confirmedBy` here,
  // since those are two different concepts (who is stored in the offer's
  // own `confirmed_by` column vs. who the audit trail's actor is). Only the
  // NEW system-timeout caller passes `null` explicitly, matching the same
  // established `actorUserId: null` convention every other worker-driven
  // audit entry in this codebase already uses (`OFFER_EXPIRED_BY_WORKER`,
  // `OFFER_REJECTED_BY_WORKER`, ...).
  actorUserId?: string | null,
): Promise<JobOffer> {
  // PHASE 5 (§5) — lock + reload the shift BEFORE confirming, explicitly,
  // rather than relying on the filled_count claim below to catch a
  // cancelled shift only as a side effect of its own WHERE clause plus
  // `assertTransition`'s incidental rejection of `cancelled -> partially_
  // filled`/`fully_filled` (which it does, but only after the offer's own
  // status has already been claimed — this fails earlier and with an
  // explicit, purpose-built message). Re-acquiring the row lock here is a
  // safe no-op when `staffAccept`'s auto-confirm path already took it
  // moments earlier in this same transaction.
  const shift = await manager.findOne(Shift, { where: { id: assignment.shiftId }, lock: { mode: 'pessimistic_write' } });
  if (!shift || shift.status === ShiftStatus.CANCELLED) {
    throw new ConflictException('This shift has been cancelled and can no longer be confirmed.');
  }
  assertTransition(OFFER_TRANSITIONS, offer.status, OfferStatus.MANAGER_CONFIRMED);
  assertTransition(SHIFT_ASSIGNMENT_TRANSITIONS, assignment.status, ShiftAssignmentStatus.CONFIRMED);

  const now = new Date();
  const [, confirmedCount] = (await manager.query(
    `UPDATE core.job_offer SET status = $1, manager_confirmed_at = $2, confirmed_by = $3
       WHERE id = $4 AND status = $5`,
    [OfferStatus.MANAGER_CONFIRMED, now, confirmedBy, offer.id, offer.status],
  )) as [unknown, number];
  if (confirmedCount === 0) {
    throw new ConflictException('This offer was already confirmed or is no longer awaiting confirmation.');
  }

  // TypeORM's manager.query() returns [rows, rowCount] for UPDATE/DELETE
  // statements (unlike SELECT, which returns rows directly) — not the rows
  // array itself.
  const [claimedRows] = (await manager.query(
    `UPDATE core.shift SET filled_count = filled_count + 1, updated_at = now()
       WHERE id = $1 AND organisation_id = $2 AND filled_count < required_count
       RETURNING filled_count, required_count, pay_rate_pence, status`,
    [assignment.shiftId, ctx.organisationId],
  )) as [Array<Record<string, unknown>>, number];
  if (claimedRows.length === 0) {
    throw new ConflictException('SHIFT_FULL: This shift is now full. Another offer may already be confirmed.');
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
  if (row.status !== nextShiftStatus) {
    assertTransition(SHIFT_TRANSITIONS, row.status as typeof ShiftStatus.OPEN, nextShiftStatus);
  }

  try {
    await manager.update(ShiftAssignment, assignment.id, {
      status: ShiftAssignmentStatus.CONFIRMED,
      confirmedAt: new Date(),
      // Snapshotted at confirmation, not at send or staff-accept (§1 A6) —
      // re-read from the shift row just locked by the UPDATE above, in
      // case the rate changed since the offer was sent.
      payRateSnapshotPence: Number(row.pay_rate_pence),
    });
  } catch (error) {
    if (isExclusionViolation(error)) {
      throw new ConflictException('This staff member already has a confirmed shift that overlaps this one — this offer cannot be confirmed.');
    }
    throw error;
  }

  await manager.update(Shift, assignment.shiftId, { status: nextShiftStatus });

  const confirmed = await manager.findOneByOrFail(JobOffer, { id: offer.id });

  await auditService.record(manager, ctx, AuditAction.OFFER_CONFIRMED, {
    entityType: 'offer',
    entityId: offer.id,
    metadata: auditMetadataSource ? { offerBatchId: offer.offerBatchId, source: auditMetadataSource } : { offerBatchId: offer.offerBatchId },
    ...(actorUserId !== undefined ? { actorUserId } : {}),
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
  }

  return confirmed;
}
