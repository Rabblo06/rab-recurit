/**
 * The single "forgotten clock-out" rule (owner decision 2026-11-14: one grace for everything). A staff member may clock
 * out — with the Shift QR or on their own phone — until their OWN scheduled end (`effectiveAssignmentTime`) +
 * `QR_POST_SHIFT_GRACE_MINUTES` (inclusive; `AttendanceService.assertClockWindow`, `AttendanceQrService.validUntil`).
 * Only strictly AFTER that instant does the attendance monitor (`rab-worker` attendance-monitor.job.ts) flag a still-open
 * attendance MISSING_CLOCK_OUT, and only then may a manager administratively recover a clock-out for a record the monitor
 * has not flagged yet (`AttendanceService.correct`, recovery path). So the staff member's own clock-out and the manager's
 * recovery never overlap, and a shift that is still running cannot be force-closed. There is no separate minutes value:
 * every caller passes `QR_POST_SHIFT_GRACE_MINUTES` from the validated environment.
 */
export function isPastClockOutGrace(seatEndsAt: Date, graceMinutes: number, now: Date): boolean {
  if (!Number.isInteger(graceMinutes) || graceMinutes < 0) throw new Error('QR_POST_SHIFT_GRACE_MINUTES must be a non-negative integer.');
  const closesAt = seatEndsAt.getTime() + graceMinutes * 60_000;
  // Fail closed for the monitor/recovery: an unreadable end is never "past the grace".
  return Number.isFinite(closesAt) && now.getTime() > closesAt;
}
