/**
 * Server-driven lifecycle for the replacement-staff automation (rab-worker
 * migration) — the worker creates rows and finds candidates; only an
 * authenticated manager's `POST /replacement-requests/:id/approve` can move
 * one to `offer_sent` (which calls the existing `OfferService.send()`
 * unchanged). There is no raw-status-from-client surface here the way
 * `assertTransition` guards `OfferStatus`/`ShiftAssignmentStatus` — kept as
 * a plain const object anyway so neither the worker job nor the controller
 * scatters bare string literals.
 */
export const ReplacementRequestStatus = {
  AWAITING_APPROVAL: 'awaiting_approval',
  /** The worker found zero eligible candidates — still a real, visible event for the manager, just nothing to approve yet. */
  NO_CANDIDATES: 'no_candidates',
  /**
   * PHASE 4 — a transient, atomically-claimed state (`UPDATE ... WHERE
   * status IN ('awaiting_approval','no_candidates') RETURNING`) held only
   * for the duration of the single transaction that revalidates the
   * candidate and calls `OfferService.sendOneWithManager`. Never visible to
   * the client across two separate requests: the transaction either
   * advances it to `offer_sent`/`cancelled` and commits, or an exception
   * rolls the whole thing back to whatever it was before the claim — never
   * left stuck here. This replaces a dead, never-referenced `APPROVED`
   * value the pre-Phase-4 flow never actually used (`approve()` used to
   * write `offer_sent` directly, with no intermediate claim at all — see
   * `WorkerEventSchema`-adjacent history in `replacement-request.service.ts`
   * for the double-approval race this closes).
   */
  APPROVING: 'approving',
  REJECTED: 'rejected',
  OFFER_SENT: 'offer_sent',
  /** The underlying shift was cancelled, or no longer needs a replacement, before/during a manager's approval attempt. */
  CANCELLED: 'cancelled',
} as const;
export type ReplacementRequestStatusType = (typeof ReplacementRequestStatus)[keyof typeof ReplacementRequestStatus];

export interface ReplacementCandidateSnapshot {
  staffProfileId: string;
  firstName: string;
  lastName: string;
  score: number;
  reasons: string[];
}
