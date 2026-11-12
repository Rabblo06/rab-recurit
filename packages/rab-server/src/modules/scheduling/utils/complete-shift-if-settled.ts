import { assertTransition, SHIFT_TRANSITIONS, ShiftAssignmentStatus, ShiftStatus } from '@rab/shared';
import { EntityManager } from 'typeorm';

/**
 * The seat states that still hold a shift open: a seat that is offered, accepted (awaiting a manager) or confirmed (booked,
 * not yet clocked out) keeps the shift `in_progress`; every other state (completed, no_show, declined, rejected,
 * withdrawn, cancelled) does not. One exception, owner decision 2026-11-06 (Q1): an `offered` seat whose offer has
 * EXPIRED is closed — expiry moves only the offer (`claimExpiredOffer`), there is no assignment edge for it, and the
 * seat can never be accepted again. This changes only how completion READS the seat (`openSeatSql`); no state or
 * transition is added and the seat row itself is never written.
 */
export const OPEN_SEAT_STATUSES: readonly string[] = [
  ShiftAssignmentStatus.OFFERED,
  ShiftAssignmentStatus.STAFF_ACCEPTED,
  ShiftAssignmentStatus.CONFIRMED,
];

/**
 * Takes the shift row lock (`FOR UPDATE`) inside the caller's tenant transaction and returns the shift's status as it is
 * under that lock (null: no such shift in this organisation — RLS and the explicit organisation filter both apply).
 * Offer-closing paths call this BEFORE they claim the offer, so their lock order is shift → offer → assignment, the same
 * order as the manager confirm (`applyOfferConfirmation`) and the staff accept: no lock-order inversion against them.
 * Re-entrant: a transaction that already holds the lock gets it again at no cost.
 */
export async function lockShiftRow(manager: EntityManager, organisationId: string, shiftId: string): Promise<string | null> {
  const rows = await manager.query<Array<{ status: string }>>(`SELECT status FROM shift WHERE id = $1 AND organisation_id = $2 FOR UPDATE`, [
    shiftId,
    organisationId,
  ]);
  return rows[0]?.status ?? null;
}

/**
 * The open-seat predicate on `shift_assignment sa` (the one definition; `countOpenSeats` and the one-off repair command
 * `shift:complete-settled` use it). `statusesParam` is the 1-based index of the bound `OPEN_SEAT_STATUSES` parameter (a
 * code integer, never input). An `offered` seat counts as closed only when it has an offer and EVERY offer on it is
 * `expired` (a seat never carries a live offer and an expired one at once today; the "every" keeps a future re-offer on
 * the same seat open).
 */
export function openSeatSql(statusesParam: number): string {
  if (!Number.isInteger(statusesParam) || statusesParam < 1) throw new Error('openSeatSql: invalid parameter index');
  // sql-injection-reviewed: the only interpolation is a validated positive integer parameter index; no input reaches the text.
  return `(sa.status = ANY($${statusesParam}::text[])
    AND NOT (sa.status = 'offered'
      AND EXISTS (SELECT 1 FROM job_offer eo WHERE eo.shift_assignment_id = sa.id AND eo.status = 'expired')
      AND NOT EXISTS (SELECT 1 FROM job_offer lo WHERE lo.shift_assignment_id = sa.id AND lo.status <> 'expired')))`;
}

/** Open seats of one shift ($1 shift id, $2 organisation id), by the shared predicate. Run it under the shift lock. */
export async function countOpenSeats(manager: EntityManager, organisationId: string, shiftId: string): Promise<number> {
  const [{ open }] = await manager.query<Array<{ open: number }>>(
    // sql-injection-reviewed: openSeatSql(3) is a code-constant fragment; every value is a bound $n parameter.
    `SELECT count(*)::int AS open FROM shift_assignment sa WHERE sa.shift_id = $1 AND sa.organisation_id = $2 AND ${openSeatSql(3)}`,
    [shiftId, organisationId, OPEN_SEAT_STATUSES],
  );
  return open;
}

/**
 * THE shift completion roll-up (one copy; it used to live inline in `AttendanceService` clock-out and record-attendance):
 * an `in_progress` shift moves to `completed` once no seat on it is still open (`openSeatSql`: `OPEN_SEAT_STATUSES`, an expired offer's seat closed). Nothing else —
 * no new rule: a shift that never started (not `in_progress`) is never completed here, and a provisional or confirmed
 * no-show counts exactly as it did before (not open).
 *
 * Called after EVERY transition that can close the last open seat of a running shift: a clock-out, a manager-recorded
 * attendance, the offer closes (deadline withdrawal, manager reject, staff decline, sender withdraw) and the offer expiry
 * (`claimExpiredOffer`: the Worker scan, the timer trigger and the staff accept's lazy expiry). Before this,
 * only the first two re-checked, so a shift whose last open seat was an unconfirmed acceptance (a standby or
 * replacement) stayed `in_progress` for ever once that acceptance was withdrawn after the confirmed staff clocked out.
 *
 * Race safety: the count runs under the shift row lock, so two transactions that each close a different last seat (a
 * clock-out and a withdrawal, or two clock-outs) are serialised on it; under READ COMMITTED the second one's count runs
 * after the first committed and sees its seat closed. Without the lock each saw the other's seat still open and neither
 * completed the shift. The status change is a compare-and-set on `in_progress` checked by `assertTransition`, so the
 * shift completes exactly once; a repeat call returns false and changes nothing.
 *
 * Returns true only for the call that completed the shift.
 */
export async function completeShiftIfSettled(manager: EntityManager, organisationId: string, shiftId: string): Promise<boolean> {
  const status = await lockShiftRow(manager, organisationId, shiftId);
  if (status !== ShiftStatus.IN_PROGRESS) return false;
  if ((await countOpenSeats(manager, organisationId, shiftId)) > 0) return false;
  assertTransition(SHIFT_TRANSITIONS, status, ShiftStatus.COMPLETED);
  const [, completed] = (await manager.query(
    `UPDATE shift SET status = $3, updated_at = now() WHERE id = $1 AND organisation_id = $2 AND status = $4`,
    [shiftId, organisationId, ShiftStatus.COMPLETED, ShiftStatus.IN_PROGRESS],
  )) as [unknown, number];
  return completed === 1;
}
