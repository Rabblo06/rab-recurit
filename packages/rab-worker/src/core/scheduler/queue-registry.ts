import { EMAIL_QUEUE_JOB_NAME, EMAIL_QUEUE_NAME } from '@rab/server/engine/core-modules/email/email-queue.constants';
import { PUSH_QUEUE_JOB_NAME, PUSH_QUEUE_NAME } from '@rab/server/engine/core-modules/push/push-queue.constants';
import { SHIFT_STATEMENT_JOB_NAME, SHIFT_STATEMENT_QUEUE_NAME } from '@rab/server/modules/payroll/constants/shift-statement';

/**
 * Typed queue-name registry for the jobs process (BullMQ migration, Lane A M2). Every BullMQ queue the jobs process
 * consumes is named here exactly once; processors (`@Processor(queue)`) must name one of these, or startup fails.
 *
 * PREFIX COMPATIBILITY (owner decision D2): the three existing consumer queues keep BullMQ's default `bull` prefix — the
 * API process publishes to `rab-email`/`rab-push` with no prefix, and moving the consumer alone would strand every API
 * fast-path publish. Only the NEW scan queues (bullmq mode) live under `BULLMQ_PREFIX` (default `crewflow:<env>:bull`).
 * A future single-prefix cutover is a separate, controlled operation (see the migration report §Prefix).
 */
export const LEGACY_BULL_PREFIX = 'bull';

export type ConsumerQueueKey = 'email' | 'push' | 'shiftStatements';

export interface ConsumerQueueDefinition {
  key: ConsumerQueueKey;
  /** BullMQ queue name (also used by the API producer for email/push). */
  name: string;
  /** The ONE job name its producers publish. */
  jobName: string;
  /** Always the legacy `bull` prefix (see above). */
  prefix: typeof LEGACY_BULL_PREFIX;
  /** Worker concurrency — unchanged from the pre-migration main.ts constants (5 / 10 / 2). */
  concurrency: number;
  /** Human name used in the existing log lines. */
  logName: string;
}

/**
 * Producer-side job options (attempts, backoff, jobIds, removeOn*) are NOT defined here: they belong to the producers
 * (`EmailQueueService`/`PushQueueService` in the API, the shift-statement dispatcher) and are unchanged by the migration.
 */
export const CONSUMER_QUEUES: Readonly<Record<ConsumerQueueKey, ConsumerQueueDefinition>> = Object.freeze({
  email: { key: 'email', name: EMAIL_QUEUE_NAME, jobName: EMAIL_QUEUE_JOB_NAME, prefix: LEGACY_BULL_PREFIX, concurrency: 5, logName: 'email' },
  push: { key: 'push', name: PUSH_QUEUE_NAME, jobName: PUSH_QUEUE_JOB_NAME, prefix: LEGACY_BULL_PREFIX, concurrency: 10, logName: 'push' },
  shiftStatements: {
    key: 'shiftStatements',
    name: SHIFT_STATEMENT_QUEUE_NAME,
    jobName: SHIFT_STATEMENT_JOB_NAME,
    prefix: LEGACY_BULL_PREFIX,
    concurrency: 2,
    logName: 'shift statement',
  },
});

/** The scan queues (bullmq mode only), grouped by the existing `queues/rab-<domain>` folders. */
export const SCAN_QUEUES = Object.freeze({
  email: 'crewflow-scan-email',
  push: 'crewflow-scan-push',
  shifts: 'crewflow-scan-shifts',
  offers: 'crewflow-scan-offers',
  reports: 'crewflow-scan-reports',
  maintenance: 'crewflow-scan-maintenance',
  realtime: 'crewflow-scan-realtime',
} as const);

export type ScanQueueName = (typeof SCAN_QUEUES)[keyof typeof SCAN_QUEUES];

export const SCAN_QUEUE_NAMES: readonly ScanQueueName[] = Object.freeze(Object.values(SCAN_QUEUES));

export const isScanQueue = (name: string): name is ScanQueueName => (SCAN_QUEUE_NAMES as readonly string[]).includes(name);
export const consumerQueueByName = (name: string): ConsumerQueueDefinition | undefined =>
  Object.values(CONSUMER_QUEUES).find((q) => q.name === name);

/** `crewflow:<NODE_ENV>:bull` unless BULLMQ_PREFIX is set (validated by the shared EnvironmentVariables class). */
export function resolveScanPrefix(nodeEnv: string, configured: string | undefined): string {
  const prefix = configured?.trim() || `crewflow:${nodeEnv}:bull`;
  if (prefix === LEGACY_BULL_PREFIX || prefix.startsWith(`${LEGACY_BULL_PREFIX}:`)) {
    // Defence in depth — the validator already refuses this.
    throw new Error('BULLMQ_PREFIX must not be the legacy "bull" prefix (the scan queues must stay isolated from rab-email/rab-push/rab-shift-statements)');
  }
  return prefix;
}

/** BullMQ scan job options (scan queues only — never applied to email/push/PDF consumer jobs). */
export const SCAN_JOB_OPTIONS = Object.freeze({
  attempts: 1,
  removeOnComplete: Object.freeze({ age: 3600, count: 1000 }),
  removeOnFail: Object.freeze({ age: 604800 }),
});

/** Template payload of every scheduled scan job: metadata only (no ids, tokens, bodies or tenant data). */
export const SCAN_JOB_DATA = Object.freeze({ v: 1 });
