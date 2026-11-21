/**
 * The single implementation of worked-minutes calculation, shared by the
 * attendance console, the payroll engine and the server's live total for the
 * phones. If any of those computed this independently, staff would eventually
 * see a number on their phone that does not match their payslip. A phone never
 * computes worked time from its own clock: it shows the server's figure
 * (`computeWorkedDuration` with clockOutAt = serverNow) and adds only the
 * server-anchored elapsed time while clocked in.
 *
 * Rules encoded here (see rab-workforce-architecture.md §1, A4):
 * - Breaks are unpaid by default and deducted from worked time.
 * - A venue/role can override a break to paid.
 * - Staff-recorded break records beat the scheduled default when present.
 *
 * M4 (owner decisions D7 / D9, 2026-11-21):
 * - D7 precedence: a manager-confirmed break (`confirmedBreakMinutes`) beats everything; then staff-recorded breaks (A4);
 *   then the scheduled break. If ANY recorded break was started or ended offline (`source: 'offline'`), the deduction is
 *   max(recorded unpaid, scheduled break): an offline break can never lower the deduction below the schedule. The floor is
 *   applied here, from the break records themselves, never left to the caller.
 * - D9: recorded breaks are clamped to [clockInAt, clockOutAt], overlapping breaks are refused (RangeError: two breaks
 *   cannot both be taken at the same instant, so overlap means bad data, never a double deduction), their MILLISECONDS
 *   are added up and the worked time is rounded ONCE. Rounding each break separately drifted by up to ±1 minute per break.
 * - In whole minutes, grossMinutes − unpaidBreakMinutes = workedMinutes exactly (the break figure is derived from the two
 *   rounded totals, so a payslip line always adds up).
 * With no recorded break and no confirmed break, results are identical to before (the scheduled break is whole minutes).
 */

export interface BreakRecordInput {
  startedAt: Date;
  /** null while the break is still open; treated as ending at clockOutAt. */
  endedAt: Date | null;
  isPaid: boolean;
  /** 'offline' when the break's start or end was recorded offline (D7 floor). Default 'online'. */
  source?: 'online' | 'offline';
}

export interface WorkedMinutesInput {
  clockInAt: Date;
  clockOutAt: Date;
  /** Staff-recorded breaks for this attendance, if any. */
  breaks?: BreakRecordInput[];
  /** Scheduled break length (whole minutes): the default when nothing else is known, and the D7 floor for offline breaks. */
  scheduledBreakMinutes?: number;
  /** Venue/role override: breaks are paid by default at this venue/role. */
  breaksPaidByDefault?: boolean;
  /** D7: a manager-confirmed unpaid break (attendance.break_minutes, whole minutes). Beats recorded and scheduled breaks. */
  confirmedBreakMinutes?: number | null;
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
  const { clockInAt, clockOutAt, breaks, scheduledBreakMinutes = 0, breaksPaidByDefault = false, confirmedBreakMinutes } = input;
  const clockInMs = clockInAt.getTime();
  const clockOutMs = clockOutAt.getTime();
  if (Number.isNaN(clockInMs) || Number.isNaN(clockOutMs)) throw new RangeError('clockInAt and clockOutAt must be valid dates');
  if (clockOutMs < clockInMs) {
    throw new RangeError('clockOutAt must not be before clockInAt');
  }
  // A negative or fractional break would inflate worked time: refused, never clamped.
  assertWholeMinutes('scheduledBreakMinutes', scheduledBreakMinutes);
  if (confirmedBreakMinutes != null) assertWholeMinutes('confirmedBreakMinutes', confirmedBreakMinutes);

  const grossMs = clockOutMs - clockInMs;
  const scheduledMs = breaksPaidByDefault ? 0 : scheduledBreakMinutes * MINUTE_MS;

  let unpaidBreakMs: number;
  if (confirmedBreakMinutes != null) {
    // D7: the manager-confirmed break always wins.
    unpaidBreakMs = confirmedBreakMinutes * MINUTE_MS;
  } else if (breaks && breaks.length > 0) {
    // Staff-recorded breaks beat the scheduled default (A4); any offline break floors the deduction at the schedule (D7).
    unpaidBreakMs = recordedUnpaidBreakMs(breaks, clockInMs, clockOutMs);
    if (breaks.some((brk) => brk.source === 'offline')) unpaidBreakMs = Math.max(unpaidBreakMs, scheduledMs);
  } else {
    unpaidBreakMs = scheduledMs;
  }

  return { grossMs, unpaidBreakMs, workedMs: Math.max(0, grossMs - unpaidBreakMs) };
}

export function computeWorkedMinutes(input: WorkedMinutesInput): WorkedMinutesResult {
  const { grossMs, workedMs } = computeWorkedDuration(input);
  // Worked time is rounded once from milliseconds (D9); the break figure is the difference of the two rounded totals.
  const grossMinutes = toMinutes(grossMs);
  const workedMinutes = Math.min(toMinutes(workedMs), grossMinutes);
  return { grossMinutes, unpaidBreakMinutes: grossMinutes - workedMinutes, workedMinutes };
}
