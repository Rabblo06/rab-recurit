/**
 * The worker's expected job set, written out BY NAME (never derived from SCAN_JOBS / CONSUMER_QUEUES), so an integration
 * suite fails loudly — naming the job — when a scan or consumer is added, renamed or dropped without the suite being
 * updated on purpose. A count alone cannot tell "ai-retention added" from "ai-retention added, token-cleanup lost".
 *
 * 20 periodic scans: the 19 pre-migration jobs-process loops + `ai-retention` (AI Phase 1, 304937a4).
 * 4 consumers: email, push, shift statements + `rab-ai` (AI Phase 1, 304937a4).
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
]);

/** `<queue>/<jobName>` of every consumer handler (legacy `bull` prefix queues). */
export const EXPECTED_CONSUMER_HANDLERS: readonly string[] = Object.freeze([
  'rab-email/send-email',
  'rab-push/send-push',
  'rab-shift-statements/generate-shift-statement',
  'rab-ai/ai-turn',
]);

/** `<queue>/<jobName>` of every handler the real WorkerModule must discover: 20 scans + 4 consumers = 24. */
export const EXPECTED_HANDLERS: readonly string[] = Object.freeze([
  ...EXPECTED_SCAN_SCHEDULER_IDS.map((id) => {
    const [, queue, jobName] = id.split(':');
    return `${queue}/${jobName}`;
  }),
  ...EXPECTED_CONSUMER_HANDLERS,
]);
