import { assertSafePence } from '@rab/shared';
import { EntityManager } from 'typeorm';

/**
 * Where a seat's pay rate came from: the staff member's own rate for the shift's job role, or the shift's rate (which
 * `SchedulingService.resolvePayRate` resolved at shift creation: explicit → venue role rate → job role default → 0).
 */
export type SeatPayRateSource = 'staff_role_rate' | 'shift';

export interface SeatPayRate {
  payRatePence: number;
  source: SeatPayRateSource;
}

/**
 * THE staff-aware rate lookup (architecture §1 A6: assignment/explicit → staff role rate → venue role rate → job role
 * default). Used in exactly two places, so they can never disagree:
 *   - `applyOfferConfirmation` — AUTHORITATIVE: the value written to `shift_assignment.pay_rate_snapshot_pence` at
 *     confirmation (never recalculated afterwards; payroll_record's insert policy requires its rate to equal that snapshot);
 *   - `OfferService.sendOne` — the send-time seat snapshot and the offer's `estimated_pay_pence`, so the staff member sees
 *     the same figure they will be confirmed at (an estimate: confirmation re-reads it).
 *
 * Rule: the core.staff_role_rate row of (staff profile, shift job role) in force on the seat's start, if one exists; the
 * latest `effective_from` wins (the exclusion constraint already forbids overlaps; the ORDER BY is defence in depth);
 * otherwise `fallbackPence` — the shift's own rate, exactly as before this table existed.
 *
 * "In force on the start" uses the SAME comparison as the venue role rate in `SchedulingService.resolvePayRate`:
 * `effective_from <= start AND (effective_to IS NULL OR effective_to >= start)` with the start bound as an untyped
 * parameter that PostgreSQL reads as a `date` — i.e. the calendar date of the start instant as written in its ISO string
 * (UTC here: `toISOString()`). Owner decision 40 (end date / time zone of rate periods) is PENDING and deliberately not
 * changed here.
 *
 * FLAGGED (owner decision 41, pending): the shift row does not record whether its rate was typed by a manager or resolved
 * from the venue / job role, so a staff role rate in force ALWAYS wins at confirmation, including over a manually typed
 * shift rate.
 *
 * Visibility: core.staff_role_rate is readable only by a non-venue manager of the bound workspace (RLS). Both callers run
 * as such a manager: an offer is confirmed only by its sender (`assertOfferOwned`), and sending needs offer.send, which
 * Venue Managers and custom workspace members never hold. `workspace_id = core.current_workspace()` is repeated here so the
 * lookup is bound to the session's workspace even without RLS (the ids are uuids from the locked seat, never the client).
 */
export async function resolveSeatPayRate(
  manager: EntityManager,
  params: {
    staffProfileId: string;
    jobRoleId: string;
    startsAt: Date | string;
    fallbackPence: number;
  },
): Promise<SeatPayRate> {
  const start = new Date(params.startsAt);
  if (!Number.isFinite(start.getTime()))
    throw new Error('resolveSeatPayRate: invalid start');
  const startIso = start.toISOString();
  const rows = (await manager.query(
    `SELECT r.pay_rate_pence FROM core.staff_role_rate r
      WHERE r.workspace_id = core.current_workspace() AND r.organisation_id = core.current_org()
        AND r.staff_profile_id = $1 AND r.job_role_id = $2
        AND r.effective_from <= $3 AND (r.effective_to IS NULL OR r.effective_to >= $3)
      ORDER BY r.effective_from DESC
      LIMIT 1`,
    [params.staffProfileId, params.jobRoleId, startIso],
  )) as Array<{ pay_rate_pence: string | number }>;
  if (rows.length > 0) {
    return {
      payRatePence: assertSafePence(
        Number(rows[0]!.pay_rate_pence),
        'staff_role_rate.pay_rate_pence',
      ),
      source: 'staff_role_rate',
    };
  }
  return {
    payRatePence: assertSafePence(params.fallbackPence, 'shift.pay_rate_pence'),
    source: 'shift',
  };
}
