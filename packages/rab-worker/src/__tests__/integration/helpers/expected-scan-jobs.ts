/**
 * The worker's expected job set, written out BY NAME (never derived from SCAN_JOBS / CONSUMER_QUEUES), so an integration
 * suite fails loudly — naming the job — when a scan or consumer is added, renamed or dropped without the suite being
 * updated on purpose. A count alone cannot tell "ai-retention added" from "ai-retention added, token-cleanup lost".
 *
 * 21 periodic scans: the 19 pre-migration jobs-process loops + `ai-retention` (AI Phase 1, 304937a4) + Phase B P8's
 * `workspace-provisioning-health` (owner decision C; the runtime drift scan is deferred, not registered).
 * 6 consumers: email, push, shift statements + `rab-ai` (AI Phase 1, 304937a4) + `crewflow-timer-triggers` (D-Q4b) +
 * `crewflow-audit-events` (Phase X Part 2, X1.1).
 */
export const EXPECTED_SCAN_SCHEDULER_IDS: readonly string[] = Object.freeze([
  'crewflow:crewflow-scan-maintenance:account-invite-cleanup',
  'crewflow:crewflow-scan-email:email-dispatch',
  'crewflow:crewflow-scan-push:push-dispatch',
  'crewflow:crewflow-scan-shifts:shift-monitor',
  'crewflow:crewflow-scan-shifts:attendance-monitor',
  'crewflow:crewflow-scan-shifts:late-clock-in',
  'crewflow:crewflow-scan-shifts:shift-cancellation-followup',
  'crewflow:crewflow-scan-offers:offer-expiry',
  'crewflow:crewflow-scan-offers:manager-confirmation-timeout',
  'crewflow:crewflow-scan-offers:replacement-staff',
  'crewflow:crewflow-scan-maintenance:token-cleanup',
  'crewflow:crewflow-scan-maintenance:login-handoff-cleanup',
  'crewflow:crewflow-scan-maintenance:storage-cleanup',
  'crewflow:crewflow-scan-reports:shift-report-scheduler',
  'crewflow:crewflow-scan-reports:final-timesheet',
  'crewflow:crewflow-scan-reports:shift-statement-dispatch',
  'crewflow:crewflow-scan-reports:payroll-period-attention',
  'crewflow:crewflow-scan-realtime:realtime-outbox-publish',
  'crewflow:crewflow-scan-maintenance:outbox-retention',
  'crewflow:crewflow-scan-maintenance:ai-retention',
  'crewflow:crewflow-scan-maintenance:workspace-provisioning-health',
  // Phase D-Q2: the AI stale-queued-turn sweep (off by default; registered only when AI_STALE_TURN_SWEEP=true).
  'crewflow:crewflow-scan-maintenance:ai-stale-turn-sweep',
  // Phase D-Q4a: the combined shift scan (registered only with WORKER_SHIFT_SCAN_MODE=combined, instead of its four members).
  'crewflow:crewflow-scan-shifts:shift-scan-combined',
]);

/** Phase D-Q4a: the scan registered only in WORKER_SHIFT_SCAN_MODE=combined (the default, separate, never schedules it). */
export const COMBINED_SHIFT_SCAN_ID = 'crewflow:crewflow-scan-shifts:shift-scan-combined';
/** Every scan id a default (separate-mode) Worker may schedule. */
export const SEPARATE_MODE_SCAN_IDS: readonly string[] = Object.freeze(EXPECTED_SCAN_SCHEDULER_IDS.filter((id) => id !== COMBINED_SHIFT_SCAN_ID));

/** `<queue>/<jobName>` of every consumer handler (legacy `bull` prefix queues). */
export const EXPECTED_CONSUMER_HANDLERS: readonly string[] = Object.freeze([
  'rab-email/send-email',
  'rab-push/send-push',
  'rab-shift-statements/generate-shift-statement',
  'rab-ai/ai-turn',
  // Phase D-Q4b: the timer-trigger consumer handler (always registered; its BullMQ Worker exists only when the flag is not off).
  'crewflow-timer-triggers/offer-expiry-trigger',
  // Phase X Part 2, X1.1: the audit-event consumer handler (always registered; its BullMQ Worker exists only with a sink).
  'crewflow-audit-events/audit-event-ship',
]);

/** `<queue>/<jobName>` of every handler the real WorkerModule must discover: 23 scans + 6 consumers = 29. */
export const EXPECTED_HANDLERS: readonly string[] = Object.freeze([
  ...EXPECTED_SCAN_SCHEDULER_IDS.map((id) => {
    const [, queue, jobName] = id.split(':');
    return `${queue}/${jobName}`;
  }),
  ...EXPECTED_CONSUMER_HANDLERS,
]);
