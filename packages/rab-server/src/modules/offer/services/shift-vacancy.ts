import { EntityManager } from 'typeorm';

/**
 * The ONE definition of "this assignment occupies a seat on its shift", shared by the replacement form's vacancy read,
 * the pipeline summary and the approval-time capacity claim in `applyOfferConfirmation` — never re-implemented.
 *
 * Occupies a seat:
 *  - `confirmed` / `completed` — a booked or worked seat.
 *  - `no_show` with `attendance_reviewed_at IS NULL` — a PROVISIONAL no-show (the shift monitor's mark). Owner rule
 *    2026-10-21: missing attendance is NOT a confirmed no-show, so the original staff member still holds the seat and a
 *    replacement for it can only be a standby.
 * Does NOT occupy a seat:
 *  - `no_show` with `attendance_reviewed_at IS NOT NULL` — a manager-CONFIRMED no-show. The row, its history, the acting
 *    manager and the timestamp stay untouched (never deleted, never re-statused); it simply stops counting as filled.
 *  - every pre-confirmation or terminal-without-work state (offered, staff_accepted, declined, rejected, withdrawn,
 *    cancelled).
 *
 * `alias` is a trusted SQL alias from source code only.
 */
export function occupiedSeatSql(alias = 'sa'): string {
  if (!/^[a-z][a-z0-9_]*$/.test(alias)) throw new Error('Invalid SQL alias');
  return `(${alias}.status IN ('confirmed', 'completed') OR (${alias}.status = 'no_show' AND ${alias}.attendance_reviewed_at IS NULL))`;
}

export interface ShiftVacancy {
  requiredCount: number;
  /** Seats occupied right now (see `occupiedSeatSql`). */
  occupied: number;
  /** Manager-confirmed no-shows on this shift — history only, they no longer occupy a seat. */
  confirmedNoShows: number;
  /** Worker-flagged, unconfirmed no-shows — they still occupy their seat. */
  provisionalNoShows: number;
  /** Offers sent and not yet answered / accepted and awaiting a manager — informational, never reserve a seat. */
  pendingOffers: number;
  acceptedAwaitingConfirmation: number;
  /**
   * max(0, requiredCount − effectiveFilled), where effectiveFilled = max(occupied, filled_count − confirmedNoShows) —
   * the same conservative formula the approval-time claim uses, so a legacy/denormalised `filled_count` can never make
   * the form promise a seat the approval would refuse.
   */
  vacancy: number;
}

/**
 * Live vacancy for one shift, from the authoritative rows. Callers that WRITE on the result must hold the shift row lock
 * first (`SELECT ... FOR UPDATE`), so concurrent approvals serialise and each sees the previous one's committed seat.
 */
export async function loadShiftVacancy(manager: EntityManager, shiftId: string): Promise<ShiftVacancy> {
  const [row] = await manager.query(
    `SELECT s.required_count, s.filled_count,
            count(sa.id) FILTER (WHERE ${occupiedSeatSql('sa')})::int AS occupied,
            count(sa.id) FILTER (WHERE sa.status = 'no_show' AND sa.attendance_reviewed_at IS NOT NULL)::int AS confirmed_no_shows,
            count(sa.id) FILTER (WHERE sa.status = 'no_show' AND sa.attendance_reviewed_at IS NULL)::int AS provisional_no_shows,
            count(sa.id) FILTER (WHERE sa.status = 'offered')::int AS pending_offers,
            count(sa.id) FILTER (WHERE sa.status = 'staff_accepted')::int AS accepted_awaiting
       FROM shift s
       LEFT JOIN shift_assignment sa ON sa.shift_id = s.id
      WHERE s.id = $1
      GROUP BY s.id, s.required_count, s.filled_count`,
    [shiftId],
  );
  if (!row) return { requiredCount: 0, occupied: 0, confirmedNoShows: 0, provisionalNoShows: 0, pendingOffers: 0, acceptedAwaitingConfirmation: 0, vacancy: 0 };
  const requiredCount = Number(row.required_count);
  const occupied = Number(row.occupied);
  const confirmedNoShows = Number(row.confirmed_no_shows);
  return {
    requiredCount,
    occupied,
    confirmedNoShows,
    provisionalNoShows: Number(row.provisional_no_shows),
    pendingOffers: Number(row.pending_offers),
    acceptedAwaitingConfirmation: Number(row.accepted_awaiting),
    vacancy: vacancyFromCounts({ requiredCount, filledCount: Number(row.filled_count), occupied, confirmedNoShows }).vacancy,
  };
}

/**
 * The ONE vacancy formula (above, and the set-based AI staffing read in SchedulingService): effectiveFilled =
 * max(occupied, filled_count − confirmedNoShows), vacancy = max(0, required − effectiveFilled). Pure.
 */
export function vacancyFromCounts(input: { requiredCount: number; filledCount: number; occupied: number; confirmedNoShows: number }): { effectiveFilled: number; vacancy: number } {
  const effectiveFilled = Math.max(input.occupied, input.filledCount - input.confirmedNoShows);
  return { effectiveFilled, vacancy: Math.max(0, input.requiredCount - effectiveFilled) };
}

/**
 * Set-based companion of `loadShiftVacancy`'s SELECT list, for an aggregate over many shifts joined as
 * `LEFT JOIN shift_assignment <sa> ON <sa>.shift_id = <shift>.id` and grouped by shift. Trusted source aliases only.
 */
export function shiftSeatCountsSql(sa = 'sa'): string {
  if (!/^[a-z][a-z0-9_]*$/.test(sa)) throw new Error('Invalid SQL alias');
  return `count(${sa}.id) FILTER (WHERE ${occupiedSeatSql(sa)})::int AS occupied,
            count(${sa}.id) FILTER (WHERE ${sa}.status = 'no_show' AND ${sa}.attendance_reviewed_at IS NOT NULL)::int AS confirmed_no_shows,
            count(${sa}.id) FILTER (WHERE ${sa}.status = 'offered')::int AS pending_offers,
            count(${sa}.id) FILTER (WHERE ${sa}.status = 'staff_accepted')::int AS accepted_awaiting`;
}
