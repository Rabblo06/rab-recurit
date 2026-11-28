import { ShiftStatus } from '@rab/shared';

import { addDays, zonedMidnight } from '../../ai/tools/ai-date-range';

/**
 * Pure planning for the two batch draft builders: "copy previous week" and the recurring shift pattern. Both turn a
 * set of candidate shifts into rows marked `create` or `skip` with a reason, and both write only new DRAFT shifts
 * through `SchedulingService.insertNewShiftTx` (never an assignment, offer, status change or pay value from the
 * client). No I/O here: the service supplies the existing-shift keys, the target checks and `now`.
 */

/** The most rows one preview or one confirm may plan (§5.5 caps bulk scheduling at 200 shifts per call; a bigger rota is split by venue). */
export const DRAFT_BATCH_MAX_ROWS = 200;

/** Statuses of an existing shift that make an identical new one a duplicate (a cancelled/declined shift does not). */
export const DUPLICATE_BLOCKING_STATUSES: readonly string[] = [
  ShiftStatus.DRAFT,
  ShiftStatus.PENDING_MANAGER_APPROVAL,
  ShiftStatus.OPEN,
  ShiftStatus.OFFERED,
  ShiftStatus.PARTIALLY_FILLED,
  ShiftStatus.FULLY_FILLED,
  ShiftStatus.CONFIRMED,
  ShiftStatus.IN_PROGRESS,
  ShiftStatus.COMPLETED,
];

/** Source shifts a week copy reads: everything still meant to happen (never cancelled, declined or a pending request). */
export const COPYABLE_SOURCE_STATUSES: readonly string[] = [
  ShiftStatus.DRAFT,
  ShiftStatus.OPEN,
  ShiftStatus.OFFERED,
  ShiftStatus.PARTIALLY_FILLED,
  ShiftStatus.FULLY_FILLED,
  ShiftStatus.CONFIRMED,
  ShiftStatus.IN_PROGRESS,
  ShiftStatus.COMPLETED,
];

export type DraftBatchSkipReason =
  | 'already_exists'
  | 'duplicate_in_batch'
  | 'starts_in_past'
  | 'invalid_local_time'
  | 'break_too_long'
  | 'venue_unavailable'
  | 'venue_archived'
  | 'job_role_unavailable'
  | 'job_role_archived'
  | 'not_selected';

/** What a target (venue + job role) check returned: usable, or the reason no shift may be created there. */
export type TargetCheck = null | Extract<DraftBatchSkipReason, 'venue_unavailable' | 'venue_archived' | 'job_role_unavailable' | 'job_role_archived'>;

export interface DraftCandidate {
  /** Week copy: the source shift id. Pattern: a stable `<date>` occurrence key. */
  key: string;
  venueId: string;
  jobRoleId: string;
  startsAt: Date;
  endsAt: Date;
  breakMinutes: number;
  requiredCount: number;
  chargeRatePence: number;
  notes: string | null;
  address: string | null;
}

export interface PlannedDraft extends DraftCandidate {
  outcome: 'create' | 'skip';
  reason?: DraftBatchSkipReason;
}

export const targetKey = (venueId: string, jobRoleId: string) => `${venueId}|${jobRoleId}`;
export const slotKey = (venueId: string, jobRoleId: string, startsAt: Date, endsAt: Date) =>
  `${venueId}|${jobRoleId}|${startsAt.toISOString()}|${endsAt.toISOString()}`;

/** `YYYY-MM-DD` of `instant` in `timeZone`. */
export function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

/**
 * The same shift `days` later on the organisation's wall clock: the start moves by the real length of those local days
 * (23 h or 25 h across a clock change), so 09:00 stays 09:00; the duration (and so the worked time) is kept exactly.
 */
export function moveByLocalDays(startsAt: Date, endsAt: Date, days: number, timeZone: string): { startsAt: Date; endsAt: Date } {
  const day = localDate(startsAt, timeZone);
  const delta = zonedMidnight(addDays(day, days), timeZone).getTime() - zonedMidnight(day, timeZone).getTime();
  const start = new Date(startsAt.getTime() + delta);
  return { startsAt: start, endsAt: new Date(start.getTime() + (endsAt.getTime() - startsAt.getTime())) };
}

/** [local midnight of `weekStart` − 7 days, local midnight of `weekStart`) and the target [weekStart, +7 days). */
export function weekCopyWindows(weekStart: string, timeZone: string): { source: { from: Date; to: Date }; target: { from: Date; to: Date } } {
  const targetFrom = zonedMidnight(weekStart, timeZone);
  return {
    source: { from: zonedMidnight(addDays(weekStart, -7), timeZone), to: targetFrom },
    target: { from: targetFrom, to: zonedMidnight(addDays(weekStart, 7), timeZone) },
  };
}

/**
 * Marks each candidate `create` or `skip`, in this order of reasons: not selected (confirm named a subset) → venue /
 * job role unusable → no real length (a clock-change gap) → break not shorter than the real length → starts in the past → an identical live shift already exists → an identical row earlier in this
 * same batch. Order of the input is kept.
 */
export function planDrafts(
  candidates: DraftCandidate[],
  input: { existingSlots: ReadonlySet<string>; targetChecks: ReadonlyMap<string, TargetCheck>; now: Date; selectedKeys?: ReadonlySet<string> },
): PlannedDraft[] {
  const seen = new Set<string>();
  return candidates.map((candidate) => {
    const skip = (reason: DraftBatchSkipReason): PlannedDraft => ({ ...candidate, outcome: 'skip', reason });
    if (input.selectedKeys && !input.selectedKeys.has(candidate.key)) return skip('not_selected');
    const target = input.targetChecks.get(targetKey(candidate.venueId, candidate.jobRoleId));
    if (target === undefined) return skip('venue_unavailable'); // fail closed: an unchecked target is never created
    if (target) return skip(target);
    // Judged on the REAL instants, not the wall clock: across the spring clock change a 01:00-02:00 local shift has no
    // length at all (both ends resolve to the same instant), and any shift that night is an hour shorter than it looks.
    const realMinutes = (candidate.endsAt.getTime() - candidate.startsAt.getTime()) / 60_000;
    if (!(realMinutes > 0)) return skip('invalid_local_time');
    if (candidate.breakMinutes >= realMinutes) return skip('break_too_long');
    if (candidate.startsAt.getTime() <= input.now.getTime()) return skip('starts_in_past');
    const slot = slotKey(candidate.venueId, candidate.jobRoleId, candidate.startsAt, candidate.endsAt);
    if (input.existingSlots.has(slot)) return skip('already_exists');
    if (seen.has(slot)) return skip('duplicate_in_batch');
    seen.add(slot);
    return { ...candidate, outcome: 'create' };
  });
}
