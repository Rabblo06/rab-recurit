import { assertSafePence } from '@rab/shared';
import { EntityManager } from 'typeorm';

import { organisationLocalDate } from '../../scheduling/utils/pay-rate-rules';

/**
 * Where a seat's pay rate came from: the shift's explicitly typed rate, the staff member's own rate for the shift's job
 * role, or the shift's resolved rate (`SchedulingService.resolvePayRate` at shift creation: venue role rate → job role
 * default; never £0 since owner decision 39).
 */
export type SeatPayRateSource =
  'explicit_shift_rate' | 'staff_role_rate' | 'shift';

export interface SeatPayRate {
  payRatePence: number;
  source: SeatPayRateSource;
}

/**
 * THE seat rate lookup (architecture §1 A6: assignment/explicit → staff role rate → venue role rate → job role default).
 * Used in exactly two places, so they can never disagree:
 *   - `applyOfferConfirmation` — AUTHORITATIVE: the value written to `shift_assignment.pay_rate_snapshot_pence` at
 *     confirmation (never recalculated afterwards; payroll_record's insert policy requires its rate to equal that snapshot);
 *   - `OfferService.sendOne` — the send-time seat snapshot and the offer's `estimated_pay_pence`, so the staff member sees
 *     the same figure they will be confirmed at (an estimate: confirmation re-reads it).
 *
 * Rules (owner decisions, decided 2026-11-22):
 *   1. decision 41 — a rate TYPED on the shift wins: when core.shift_explicit_rate holds a marker for the shift, the
 *      shift's own rate (`fallbackPence`) is used and no staff rate is read;
 *   2. otherwise the core.staff_role_rate row of (staff profile, shift job role) in force on the seat's start, latest
 *      `effective_from` first (the exclusion constraint already forbids overlaps; the ORDER BY is defence in depth);
 *   3. otherwise the shift's resolved rate (`fallbackPence`), exactly as before per-staff rates existed.
 * Decision 40 — "in force on the start" is judged on the start's ORGANISATION-LOCAL calendar date
 * (core.organisation.timezone, `organisationLocalDate`, the same helper as the venue rate), both ends inclusive.
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
    `SELECT EXISTS (SELECT 1 FROM core.shift_explicit_rate e
      WHERE e.shift_id = $1 AND e.workspace_id = core.current_workspace() AND e.organisation_id = core.current_org()) AS explicit`,
    [params.shiftId],
  )) as Array<{ explicit: boolean }>;
  if (marker?.explicit === true)
    return { payRatePence: fallbackPence, source: 'explicit_shift_rate' };

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
      payRatePence: assertSafePence(
        Number(rows[0]!.pay_rate_pence),
        'staff_role_rate.pay_rate_pence',
      ),
      source: 'staff_role_rate',
    };
  }
  return { payRatePence: fallbackPence, source: 'shift' };
}

/**
 * Decision 41, the write side: records that `shiftId`'s rate was typed explicitly, in the shift-creating transaction
 * (SchedulingService.insertNewShiftTx). Organisation and author come from the bound session; RLS WITH CHECK requires the
 * workspace to be the session's and the caller to be a non-venue manager of it, so a refused marker rolls the whole create
 * back (fail closed).
 */
export async function recordExplicitShiftRate(
  manager: EntityManager,
  shift: { id: string; workspaceId?: string | null },
): Promise<void> {
  await manager.query(
    `INSERT INTO core.shift_explicit_rate (shift_id, organisation_id, workspace_id, created_by) VALUES ($1, core.current_org(), $2, core.current_uid())`,
    [shift.id, shift.workspaceId ?? null],
  );
}
