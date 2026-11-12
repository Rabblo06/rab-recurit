import { OfferStatus } from '@rab/shared';
import { EntityManager } from 'typeorm';

import { JobOffer } from '../entities/job-offer.entity';
import { completeShiftIfSettled, lockShiftRow } from '../../scheduling/utils/complete-shift-if-settled';

/**
 * PHASE 6 — the ONE canonical `PENDING -> EXPIRED` transition, a real
 * atomic claim (`UPDATE ... WHERE status = 'pending' AND expires_at <=
 * now() RETURNING`), matching the same idiom every other offer-lifecycle
 * transition in this file already uses. Real PostgreSQL `now()` is the
 * authority for "has this offer expired" — never Node's `Date.now()`,
 * never a client-supplied timestamp.
 *
 * Shared, standalone (same pattern as `venue-team-scope.ts`'s
 * `assertVenueTeamSelection` — a plain exported function reused across
 * call sites, not a class method) because TWO independent trigger points
 * can each discover the SAME stale `PENDING` offer at nearly the same
 * moment: `OfferService.staffAccept()`'s own lazy check (the offer's own
 * staff member happens to touch it after the deadline) and
 * `offer-expiry.job.ts`'s periodic proactive scan (`rab-worker`, which
 * has no NestJS DI container and therefore can never call an injected
 * `OfferService` method — it needs a plain function it can import
 * directly via `@rab/server/...`, exactly like `resolveResponsibleManager`
 * in Phase 3). Previously each side independently ran a BLIND
 * `manager.update()` with no `WHERE status = ...` guard at all — the
 * exact "Worker reads PENDING / Staff accepts / Worker blindly writes
 * EXPIRED" race this phase's own brief names. Whichever caller's claim
 * actually affects a row is the ONLY one that may go on to fire the
 * `OFFER_EXPIRED` audit/notification; a caller that affects zero rows
 * must do nothing further — the other side either already expired it,
 * or the offer moved on to some other terminal state first (accepted,
 * declined, withdrawn), which is itself a legitimate "we lost this race,
 * stop" outcome, not an error.
 */
export async function claimExpiredOffer(manager: EntityManager, offerId: string): Promise<JobOffer | null> {
  // Shift completion (owner decision 2026-11-06, Q1): an expired offer closes its `offered` seat for the completion
  // roll-up, so the expiry re-runs it. Shift row lock FIRST (shift -> offer, the confirm / accept / withdrawal order), so
  // an expiry racing a clock-out on the same shift is serialised on it and one of the two completes the shift. The
  // organisation and shift come from the offer row itself under the caller's tenant context (RLS); nothing found =
  // nothing locked, and the CAS below then matches nothing either.
  const [target] = await manager.query<Array<{ shift_id: string; organisation_id: string }>>(
    `SELECT sa.shift_id, o.organisation_id FROM job_offer o JOIN shift_assignment sa ON sa.id = o.shift_assignment_id WHERE o.id = $1`,
    [offerId],
  );
  if (target) await lockShiftRow(manager, target.organisation_id, target.shift_id);
  const [claimedRows] = (await manager.query(
    `UPDATE job_offer
       SET status = $1, responded_at = now()
       WHERE id = $2 AND status = $3 AND expires_at <= now()
       RETURNING id`,
    [OfferStatus.EXPIRED, offerId, OfferStatus.PENDING],
  )) as [Array<{ id: string }>, number];
  if (claimedRows.length === 0) return null;
  if (target) await completeShiftIfSettled(manager, target.organisation_id, target.shift_id);
  return manager.findOneByOrFail(JobOffer, { id: offerId });
}
