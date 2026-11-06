/**
 * Why an offer was sent. Persisted on `job_offer.offer_kind` (OfferKind1786719400000) and decided by the SERVER at send
 * time, never accepted from a client:
 *  - `standard`    — every ordinary send (New shift, Send offers, VM-request approval, replacement-request approval).
 *  - `replacement` — sent from the replacement form (`POST /shifts/:id/offers/bulk` with `mode: 'replacement'`) while the
 *                    ORIGINAL shift has at least one vacant seat (e.g. a manager-confirmed no-show freed one).
 *  - `standby`     — sent from the replacement form while the shift has NO vacant seat (e.g. the original staff member
 *                    is only provisionally absent). A standby offer can be accepted, but it is approved into an
 *                    assignment only if a real vacancy exists at approval time (409 otherwise).
 *
 * No kind is ever confirmed by the system (owner rule 2026-11-06). Replacement and standby offers keep their own window:
 * their manager-confirmation deadline is the END of the booked window (owner decision Q1b), a standard offer's is its
 * start − 30 min (`confirmationDeadlineSql`); an unconfirmed acceptance is withdrawn at that deadline.
 *
 * Kept in the server (not `@rab/shared`) on purpose: no client branches on it for authorisation; clients only render it.
 */
export const OfferKind = {
  STANDARD: 'standard',
  REPLACEMENT: 'replacement',
  STANDBY: 'standby',
} as const;

export type OfferKindType = (typeof OfferKind)[keyof typeof OfferKind];

export const OFFER_KINDS: readonly OfferKindType[] = [OfferKind.STANDARD, OfferKind.REPLACEMENT, OfferKind.STANDBY];

/** Message for a standby approval (or any replacement-form approval) when no seat is vacant at approval time. */
export const NO_VACANCY_MESSAGE = 'NO_VACANCY: No vacancy — the original staff member is still assigned.';
