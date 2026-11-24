import { assertSafePence } from '@rab/shared';
import { EntityManager } from 'typeorm';

import {
  assertPayRateSet,
  organisationLocalDate,
} from '../../scheduling/utils/pay-rate-rules';

/**
 * Where a seat's pay rate came from: the staff member's own rate for the shift's job role, or the shift's own rate (a typed
 * rate, a shift created before staff rates existed, or no staff rate in force; never £0 since owner decision 39).
 */
export type SeatPayRateSource = 'staff_role_rate' | 'shift';

export interface SeatPayRate {
  payRatePence: number;
  source: SeatPayRateSource;
}

/**
 * THE seat rate lookup (architecture §1 A6: assignment/explicit → staff role rate → venue role rate → job role default).
 * Used in exactly two places, so they can never disagree:
 *   - `applyOfferConfirmation` — AUTHORITATIVE: the value written to `shift_assignment.pay_rate_snapshot_pence` at
 *     confirmation (never recalculated afterwards; payroll_record's insert policy requires its rate to equal that snapshot);
 *   - `OfferService.sendOne` — the send-time seat snapshot and the offer's `estimated_pay_pence` (an estimate: confirmation
 *     re-reads it, so a staff rate edited between acceptance and confirmation changes the confirmed figure — THREAT-MODEL).
 *
 * Rules (owner decisions):
 *   - 41 and 97: a staff role rate may apply ONLY to a shift whose rate was RESOLVED in its own creating transaction
 *     (core.shift_resolved_rate marker, written by core.mark_shift_rate_resolved). A typed shift rate (41) and every shift
 *     created before ShiftResolvedRate1786722220000 (97) have no marker and keep the shift's own rate (`fallbackPence`);
 *   - otherwise the core.staff_role_rate row of (staff profile, shift job role) in force on the seat's start, latest
 *     `effective_from` first (the exclusion constraint already forbids overlaps; the ORDER BY is defence in depth), else the
 *     shift's resolved rate;
 *   - 40: "in force on the start" is judged on the start's ORGANISATION-LOCAL calendar date (`organisationLocalDate`, the
 *     same helper as the venue rate; fails closed without a visible organisation), both ends inclusive;
 *   - 39: the result must be a positive whole number of pence (PayRateRequiredException otherwise) — never a £0 seat.
 *
 * Visibility: both tables are readable only by a non-venue manager of the bound workspace (RLS). Both callers run as such a
 * manager: an offer is confirmed only by its sender (`assertOfferOwned`), and sending needs offer.send, which Venue Managers
 * and custom workspace members never hold. `workspace_id = core.current_workspace()` is repeated so the lookup is bound to
 * the session's workspace even without RLS (the ids come from the locked seat, never the client).
 */
export async function resolveSeatPayRate(
  manager: EntityManager,
  params: {
    shiftId: string;
    staffProfileId: string;
    jobRoleId: string;
    startsAt: Date | string;
    fallbackPence: number;
  },
): Promise<SeatPayRate> {
  const fallbackPence = assertSafePence(
    params.fallbackPence,
    'shift.pay_rate_pence',
  );
  const [marker] = (await manager.query(
    `SELECT EXISTS (SELECT 1 FROM core.shift_resolved_rate m
      WHERE m.shift_id = $1 AND m.workspace_id = core.current_workspace() AND m.organisation_id = core.current_org()) AS resolved`,
    [params.shiftId],
  )) as Array<{ resolved: boolean }>;
  if (marker?.resolved !== true)
    return { payRatePence: assertPayRateSet(fallbackPence), source: 'shift' };

  const day = await organisationLocalDate(manager, params.startsAt);
  const rows = (await manager.query(
    `SELECT r.pay_rate_pence FROM core.staff_role_rate r
      WHERE r.workspace_id = core.current_workspace() AND r.organisation_id = core.current_org()
        AND r.staff_profile_id = $1 AND r.job_role_id = $2
        AND r.effective_from <= $3::date AND (r.effective_to IS NULL OR r.effective_to >= $3::date)
      ORDER BY r.effective_from DESC
      LIMIT 1`,
    [params.staffProfileId, params.jobRoleId, day],
  )) as Array<{ pay_rate_pence: string | number }>;
  if (rows.length > 0) {
    return {
      payRatePence: assertPayRateSet(
        assertSafePence(
          Number(rows[0]!.pay_rate_pence),
          'staff_role_rate.pay_rate_pence',
        ),
      ),
      source: 'staff_role_rate',
    };
  }
  return { payRatePence: assertPayRateSet(fallbackPence), source: 'shift' };
}

/**
 * Decisions 41 / 97, the write side: marks `shiftId`'s rate as RESOLVED (no `payRatePence` was given), in the shift-creating
 * transaction (SchedulingService.insertNewShiftTx), through the only writer, core.mark_shift_rate_resolved. The definer
 * refuses (42501) unless the shift was created in this transaction, in this workspace, by this caller; the refusal rolls the
 * whole create back (fail closed).
 */
export async function markShiftRateResolved(
  manager: EntityManager,
  shiftId: string,
): Promise<void> {
  await manager.query(`SELECT core.mark_shift_rate_resolved($1)`, [shiftId]);
}
