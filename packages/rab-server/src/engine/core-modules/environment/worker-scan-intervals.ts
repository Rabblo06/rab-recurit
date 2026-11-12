// Phase A pa-intervals — worker scan interval settings (new file; additive).
/**
 * The polling interval of each periodic scan of the jobs process (`packages/rab-worker/src/core/scheduler/scan-jobs.ts`),
 * as validated environment settings in whole SECONDS. ONE table, read by:
 *   - `EnvironmentVariables` (environment-variables.ts): each key's default and its @Min/@Max bounds — a value outside the
 *     bounds, a non-integer or a non-number refuses to boot, like every other env key;
 *   - the Worker's scan registry: which key drives which scan, plus a defence-in-depth re-check of the same bounds.
 *
 * DEFAULTS ARE EXACTLY THE PRE-EXISTING HARD-CODED CADENCES (the constants scan-jobs.ts used to hold, themselves copied
 * from the pre-BullMQ main.ts) — leaving every key unset changes nothing. scan-jobs.spec.ts proves it against an
 * independently hand-transcribed table.
 *
 * The three scans that ALREADY had a minutes setting keep it, unchanged in name, unit, default and bounds:
 * LOGIN_HANDOFF_CLEANUP_INTERVAL_MINUTES, OUTBOX_RETENTION_INTERVAL_MINUTES, AI_RETENTION_INTERVAL_MINUTES.
 *
 * BOUNDS ARE OWNER ASSUMPTIONS (Phase A hand-back), chosen so a typo cannot make a business-timing scan dangerously slow:
 *  - 2 s dispatchers (email / push / realtime): 1–60 s. Slower only delays delivery; 1 s floor bounds DB polling load.
 *  - offer expiry, manager confirmation timeout, cancellation follow-up (60 s): 10–300 s — at most 5 min of lag past an
 *    offer's / confirmation's deadline.
 *  - late clock-in, replacement staff (120 s): 30–600 s — with LATE_CLOCK_IN_GRACE_MINUTES=10 a late flag still lands
 *    before the 30-minute no-show escalation.
 *  - shift monitor (300 s): 30–600 s — the clock-in-window-open reminder window is CLOCK_IN_EARLY_MINUTES (15 by default)
 *    wide; a scan interval longer than that window could skip the reminder entirely.
 *  - attendance monitor (300 s): 30–900 s.
 *  - shift report scheduler, final timesheet (300 s): 60–900 s.
 *  - shift statement dispatch (5 s): 1–300 s.
 *  - payroll period attention (1800 s): 300–7200 s.
 *  - account-invite cleanup (900 s): 60–3600 s.
 *  - token cleanup, storage cleanup (86 400 s): 3600–86 400 s — housekeeping that touches retention may be made more
 *    frequent but never less frequent than today.
 */
export interface WorkerScanIntervalSetting {
  /** The scan's BullMQ job name (`ScanJobDefinition.jobName`). */
  jobName: string;
  defaultSeconds: number;
  minSeconds: number;
  maxSeconds: number;
}

const s = (jobName: string, defaultSeconds: number, minSeconds: number, maxSeconds: number): WorkerScanIntervalSetting =>
  Object.freeze({ jobName, defaultSeconds, minSeconds, maxSeconds });

export const WORKER_SCAN_INTERVAL_SETTINGS = Object.freeze({
  WORKER_ACCOUNT_INVITE_CLEANUP_INTERVAL_SECONDS: s('account-invite-cleanup', 900, 60, 3_600),
  WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS: s('email-dispatch', 2, 1, 60),
  WORKER_PUSH_DISPATCH_INTERVAL_SECONDS: s('push-dispatch', 2, 1, 60),
  WORKER_SHIFT_MONITOR_INTERVAL_SECONDS: s('shift-monitor', 300, 30, 600),
  WORKER_ATTENDANCE_MONITOR_INTERVAL_SECONDS: s('attendance-monitor', 300, 30, 900),
  WORKER_LATE_CLOCK_IN_INTERVAL_SECONDS: s('late-clock-in', 120, 30, 600),
  WORKER_SHIFT_CANCELLATION_FOLLOWUP_INTERVAL_SECONDS: s('shift-cancellation-followup', 60, 10, 300),
  WORKER_OFFER_EXPIRY_INTERVAL_SECONDS: s('offer-expiry', 60, 10, 300),
  WORKER_MANAGER_CONFIRMATION_TIMEOUT_INTERVAL_SECONDS: s('manager-confirmation-timeout', 60, 10, 300),
  WORKER_REPLACEMENT_STAFF_INTERVAL_SECONDS: s('replacement-staff', 120, 30, 600),
  WORKER_TOKEN_CLEANUP_INTERVAL_SECONDS: s('token-cleanup', 86_400, 3_600, 86_400),
  WORKER_STORAGE_CLEANUP_INTERVAL_SECONDS: s('storage-cleanup', 86_400, 3_600, 86_400),
  WORKER_SHIFT_REPORT_SCHEDULER_INTERVAL_SECONDS: s('shift-report-scheduler', 300, 60, 900),
  WORKER_FINAL_TIMESHEET_INTERVAL_SECONDS: s('final-timesheet', 300, 60, 900),
  WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS: s('shift-statement-dispatch', 5, 1, 300),
  WORKER_PAYROLL_PERIOD_ATTENTION_INTERVAL_SECONDS: s('payroll-period-attention', 1_800, 300, 7_200),
  WORKER_REALTIME_OUTBOX_PUBLISH_INTERVAL_SECONDS: s('realtime-outbox-publish', 2, 1, 60),
} as const satisfies Record<string, WorkerScanIntervalSetting>);

export type WorkerScanIntervalKey = keyof typeof WORKER_SCAN_INTERVAL_SETTINGS;

/**
 * Phase D-Q4a (owner decision OD-1, 2026-11-04): the interval keys of the four 300-s scans that
 * WORKER_SHIFT_SCAN_MODE=combined folds into one workspace walk, in registration order. Late clock-in (120 s) is NOT a
 * member (extending the set needs a new owner decision; OD-2 then fixes late clock-in before no-show).
 */
export const COMBINED_SHIFT_SCAN_MEMBER_KEYS = Object.freeze([
  'WORKER_SHIFT_MONITOR_INTERVAL_SECONDS',
  'WORKER_ATTENDANCE_MONITOR_INTERVAL_SECONDS',
  'WORKER_SHIFT_REPORT_SCHEDULER_INTERVAL_SECONDS',
  'WORKER_FINAL_TIMESHEET_INTERVAL_SECONDS',
] as const satisfies readonly WorkerScanIntervalKey[]);

/** The combined scan's tick may not be shorter than this (fail closed on degenerate settings such as 301 s and 300 s). */
export const COMBINED_SHIFT_SCAN_MIN_TICK_SECONDS = 30;

/**
 * The combined scan's tick in seconds: the greatest common divisor of the members' intervals, so every member interval is
 * a whole number of ticks and no member ever runs less often than in separate mode. Throws on an empty list or a
 * non-positive / non-integer interval (fail closed); the 30-s floor is checked by the callers that know the mode.
 */
export function combinedShiftScanTickSeconds(memberSeconds: readonly number[]): number {
  if (!memberSeconds.length) throw new Error('combined shift scan: no member intervals');
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  return memberSeconds.reduce((acc, seconds) => {
    if (!Number.isInteger(seconds) || seconds <= 0) throw new Error('combined shift scan: member intervals must be positive whole seconds');
    return gcd(acc, seconds);
  }, 0);
}

export const WORKER_SCAN_INTERVAL_KEYS = Object.freeze(Object.keys(WORKER_SCAN_INTERVAL_SETTINGS) as WorkerScanIntervalKey[]);
