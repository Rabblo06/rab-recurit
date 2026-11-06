import { assertTransition, SHIFT_TRANSITIONS, ShiftAssignmentStatus, ShiftStatus } from '@rab/shared';
import { EntityManager } from 'typeorm';

/**
 * The seat states that still hold a shift open. Unchanged from the clock-out roll-up this file replaces: a seat that is
 * offered, accepted (awaiting a manager) or confirmed (booked, not yet clocked out) keeps the shift `in_progress`; every
 * other state (completed, no_show, declined, rejected, withdrawn, cancelled) does not.
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
 * THE shift completion roll-up (one copy; it used to live inline in `AttendanceService` clock-out and record-attendance):
 * an `in_progress` shift moves to `completed` once no seat on it is still open (`OPEN_SEAT_STATUSES`). Nothing else —
 * no new rule: a shift that never started (not `in_progress`) is never completed here, and a provisional or confirmed
 * no-show counts exactly as it did before (not open).
 *
 * Called after EVERY transition that can close the last open seat of a running shift: a clock-out, a manager-recorded
 * attendance, and the offer closes (deadline withdrawal, manager reject, staff decline, sender withdraw). Before this,
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
  const [{ open }] = await manager.query<Array<{ open: number }>>(
    `SELECT count(*)::int AS open FROM shift_assignment WHERE shift_id = $1 AND organisation_id = $2 AND status = ANY($3::text[])`,
    [shiftId, organisationId, OPEN_SEAT_STATUSES],
  );
  if (open > 0) return false;
  assertTransition(SHIFT_TRANSITIONS, status, ShiftStatus.COMPLETED);
  const [, completed] = (await manager.query(
    `UPDATE shift SET status = $3, updated_at = now() WHERE id = $1 AND organisation_id = $2 AND status = $4`,
    [shiftId, organisationId, ShiftStatus.COMPLETED, ShiftStatus.IN_PROGRESS],
  )) as [unknown, number];
  return completed === 1;
}
