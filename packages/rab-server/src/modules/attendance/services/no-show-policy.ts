/**
 * Missing attendance is NOT a confirmed no-show (owner rule 2026-10-21).
 *
 * - The shift monitor (`rab-worker` shift-monitor.job.ts) marks a still-confirmed seat with no attendance row as a
 *   PROVISIONAL no-show (`shift_assignment.status = 'no_show'`, `attendance_reviewed_at IS NULL`) this long after the
 *   staff member's scheduled start. It never confirms or finalises anything.
 * - A manager CONFIRMS the no-show with the explicit attendance-review action on that seat (`attendance_reviewed_at`
 *   set). The same threshold is the earliest a manager may confirm one, so a staff member running a few minutes late
 *   can never be confirmed absent before the system itself would have flagged them.
 * - Until confirmed (and before the report is finalised) a manager may record verified attendance instead, which
 *   supersedes the provisional mark (`no_show → completed`, `AttendanceService.recordAttendance`).
 */
export const NO_SHOW_GRACE_MINUTES = 30;
