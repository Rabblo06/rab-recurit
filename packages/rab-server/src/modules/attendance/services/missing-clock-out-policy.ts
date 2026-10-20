/**
 * The single "forgotten clock-out" threshold. The attendance monitor (`rab-worker` attendance-monitor.job.ts) flags a
 * still-open attendance as MISSING_CLOCK_OUT this long after the staff member's own scheduled end, and a manager may
 * administratively recover a clock-out (`AttendanceService.correct`, recovery path) only for a MISSING_CLOCK_OUT record
 * or an open record already past this same threshold (in case the monitor is late). Never earlier: a shift that is
 * still running cannot be force-closed.
 */
export const MISSING_CLOCK_OUT_GRACE_MINUTES = 30;
