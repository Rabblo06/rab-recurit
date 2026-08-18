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
}

export interface WorkedMinutesResult {
  grossMinutes: number;
  unpaidBreakMinutes: number;
  workedMinutes: number;
}

function diffMinutes(later: Date, earlier: Date): number {
  return Math.max(0, Math.round((later.getTime() - earlier.getTime()) / 60_000));
}

export function computeWorkedMinutes(input: WorkedMinutesInput): WorkedMinutesResult {
  const { clockInAt, clockOutAt, breaks, scheduledBreakMinutes = 0, breaksPaidByDefault = false } =
    input;

  if (clockOutAt.getTime() < clockInAt.getTime()) {
    throw new RangeError('clockOutAt must not be before clockInAt');
  }

  const grossMinutes = diffMinutes(clockOutAt, clockInAt);

  let unpaidBreakMinutes: number;
  if (breaks && breaks.length > 0) {
    // Staff-recorded breaks beat the scheduled default (A4).
    unpaidBreakMinutes = breaks
      .filter((brk) => !brk.isPaid)
      .reduce((sum, brk) => sum + diffMinutes(brk.endedAt ?? clockOutAt, brk.startedAt), 0);
  } else {
    unpaidBreakMinutes = breaksPaidByDefault ? 0 : scheduledBreakMinutes;
  }

  const workedMinutes = Math.max(0, grossMinutes - unpaidBreakMinutes);

  return { grossMinutes, unpaidBreakMinutes, workedMinutes };
}
