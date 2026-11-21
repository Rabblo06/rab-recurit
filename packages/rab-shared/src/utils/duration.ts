/**
 * The single implementation of worked-minutes calculation, shared by the
 * mobile timer, the attendance console and the payroll engine. If any of
 * those three computed this independently, staff would eventually see a
 * number on their phone that does not match their payslip.
 *
 * Rules encoded here (see rab-workforce-architecture.md §1, A4):
 * - Breaks are unpaid by default and deducted from worked time.
 * - A venue/role can override a break to paid.
 * - Staff-recorded break records beat the scheduled default when present.
 *
 * M4 (owner decisions D7 / D9, 2026-11-21):
 * - D9: recorded breaks are clamped to [clockInAt, clockOutAt], overlapping breaks are refused (RangeError: two breaks
 *   cannot both be taken at the same instant, so overlap means bad data, never a double deduction), their MILLISECONDS
 *   are added up and the result is rounded ONCE. Rounding each break separately drifted by up to ±1 minute per break.
 * - D7: `minimumUnpaidBreakMinutes` (given when any break was started or ended offline) makes the deduction
 *   max(recorded unpaid, minimum), so an offline break can never lower the deduction below the scheduled break.
 * - `computeWorkedDuration` returns milliseconds and `computeWorkedMinutes` is built on it, so a live running total on a
 *   phone (computed by the server with clockOutAt = serverNow) and the payslip come from the same code.
 * With no recorded break, results are identical to before (the scheduled break is a whole number of minutes).
 */

export interface BreakRecordInput {
  startedAt: Date;
  /** null while the break is still open; treated as ending at clockOutAt. */
  endedAt: Date | null;
  isPaid: boolean;
}

export interface WorkedMinutesInput {
  clockInAt: Date;
  clockOutAt: Date;
  /** Staff-recorded breaks for this attendance, if any. */
  breaks?: BreakRecordInput[];
  /** Scheduled break length, used only when no break was actually recorded. */
  scheduledBreakMinutes?: number;
  /** Venue/role override: breaks are paid by default at this venue/role. */
  breaksPaidByDefault?: boolean;
  /**
   * D7: a floor on the unpaid deduction when breaks ARE recorded (the scheduled break, passed when any break has an offline
   * start or end). The deduction becomes max(recorded unpaid, this). Ignored when no break is recorded (the scheduled break
   * applies then anyway). Must be a non-negative whole number of minutes.
   */
  minimumUnpaidBreakMinutes?: number;
}

export interface WorkedDurationResult {
  grossMs: number;
  unpaidBreakMs: number;
  workedMs: number;
}

export interface WorkedMinutesResult {
  grossMinutes: number;
  unpaidBreakMinutes: number;
  workedMinutes: number;
}

const MINUTE_MS = 60_000;

function toMinutes(ms: number): number {
  return Math.round(ms / MINUTE_MS);
}

function assertWholeMinutes(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative whole number of minutes`);
}

/** Recorded unpaid break time in milliseconds: each break clamped to the attendance, overlaps refused, summed. */
function recordedUnpaidBreakMs(breaks: readonly BreakRecordInput[], clockInMs: number, clockOutMs: number): number {
  const clamped = breaks.map((brk) => {
    const start = brk.startedAt.getTime();
    const end = brk.endedAt === null ? clockOutMs : brk.endedAt.getTime();
    if (Number.isNaN(start) || Number.isNaN(end)) throw new RangeError('break times must be valid dates');
    if (end < start) throw new RangeError('a break must not end before it starts');
    const clamp = (ms: number) => Math.min(Math.max(ms, clockInMs), clockOutMs);
    return { start: clamp(start), end: clamp(end), isPaid: brk.isPaid };
  });
  const ordered = [...clamped].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < ordered.length; i += 1) {
    // Touching breaks (one ends exactly when the next starts) are fine; any real overlap is bad data.
    if (ordered[i]!.start < ordered[i - 1]!.end) throw new RangeError('breaks must not overlap');
  }
  return clamped.filter((brk) => !brk.isPaid).reduce((sum, brk) => sum + (brk.end - brk.start), 0);
}

export function computeWorkedDuration(input: WorkedMinutesInput): WorkedDurationResult {
  const { clockInAt, clockOutAt, breaks, scheduledBreakMinutes = 0, breaksPaidByDefault = false, minimumUnpaidBreakMinutes } = input;
  const clockInMs = clockInAt.getTime();
  const clockOutMs = clockOutAt.getTime();
  if (Number.isNaN(clockInMs) || Number.isNaN(clockOutMs)) throw new RangeError('clockInAt and clockOutAt must be valid dates');
  if (clockOutMs < clockInMs) {
    throw new RangeError('clockOutAt must not be before clockInAt');
  }
  if (minimumUnpaidBreakMinutes !== undefined) assertWholeMinutes('minimumUnpaidBreakMinutes', minimumUnpaidBreakMinutes);

  const grossMs = clockOutMs - clockInMs;

  let unpaidBreakMs: number;
  if (breaks && breaks.length > 0) {
    // Staff-recorded breaks beat the scheduled default (A4), with the D7 floor when one is given.
    unpaidBreakMs = recordedUnpaidBreakMs(breaks, clockInMs, clockOutMs);
    if (minimumUnpaidBreakMinutes !== undefined) unpaidBreakMs = Math.max(unpaidBreakMs, minimumUnpaidBreakMinutes * MINUTE_MS);
  } else {
    unpaidBreakMs = breaksPaidByDefault ? 0 : scheduledBreakMinutes * MINUTE_MS;
  }

  return { grossMs, unpaidBreakMs, workedMs: Math.max(0, grossMs - unpaidBreakMs) };
}

export function computeWorkedMinutes(input: WorkedMinutesInput): WorkedMinutesResult {
  const { grossMs, unpaidBreakMs, workedMs } = computeWorkedDuration(input);
  // Each figure is rounded exactly once from milliseconds (D9).
  return { grossMinutes: toMinutes(grossMs), unpaidBreakMinutes: toMinutes(unpaidBreakMs), workedMinutes: toMinutes(workedMs) };
}
