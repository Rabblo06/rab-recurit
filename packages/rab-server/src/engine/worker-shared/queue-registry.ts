import { EMAIL_QUEUE_JOB_NAME, EMAIL_QUEUE_NAME } from '../core-modules/email/email-queue.constants';
import { PUSH_QUEUE_JOB_NAME, PUSH_QUEUE_NAME } from '../core-modules/push/push-queue.constants';
import { SHIFT_STATEMENT_JOB_NAME, SHIFT_STATEMENT_QUEUE_NAME } from './shift-statement-queue.constants';
import { AI_TITLE_JOB_NAME } from './ai-jobs.contract';
import { AI_QUEUE_NAME, AI_TURN_JOB_NAME } from './ai-queue.constants';
import { TIMER_TRIGGER_JOB_NAMES, TIMER_TRIGGER_KINDS, TIMER_TRIGGER_PAYLOAD_KEYS, TIMER_TRIGGER_QUEUE_NAME } from './timer-trigger.contract';
import { AUDIT_EVENT_JOB_NAME, AUDIT_EVENT_PAYLOAD_KEYS, AUDIT_EVENT_QUEUE_NAME, AUDIT_PREAUTH_JOB_NAME, AUDIT_PREAUTH_PAYLOAD_KEYS } from './audit-event.contract';

/**
 * CANONICAL queue registry (Admin Panel plan §3; Phase D-Q1 "queue registry"). The worker (consumers, scan scheduler) and
 * the API (producers, Admin Panel queue view) read ONE list. Pure constants and pure functions: no Nest, no Redis, no
 * BullMQ runtime import, no `modules/` import (the shift-statement names come from `./shift-statement-queue.constants`).
 *
 * D-Q1: EVERY BullMQ queue Crewflow uses — the consumer queues (four at D-Q1; D-Q4b adds `crewflow-timer-triggers`) and the seven `crewflow-scan-*` scan queues — has ONE
 * entry in `QUEUE_SETTINGS` with EVERY option written out: worker concurrency, lockDuration, maxStalledCount,
 * stalledInterval, job attempts + backoff, removeOnComplete / removeOnFail retention, job timeout, the job names the queue
 * accepts, its tenant scope and its payload keys. Completeness is a COMPILE-TIME property (`satisfies` a mapped type over
 * `QueueName` whose fields are all required): a queue without settings, or settings with a missing option, does not
 * compile. The values are EXACTLY the effective values before D-Q1, including BullMQ's own defaults that were implicit
 * until now (`BULLMQ_WORKER_DEFAULTS`, read from the installed bullmq) — `queue-registry.spec.ts` pins every one. The one
 * deliberate change since: Phase X3.4 gives every queue Twenty's retention (`QUEUE_RETENTION` below).
 *
 * PREFIX COMPATIBILITY (owner decision D2): the consumer queues keep BullMQ's default `bull` prefix — the API process
 * publishes to `rab-email` / `rab-push` / `rab-ai` with no prefix, and moving the consumer alone would strand every API
 * publish. Only the scan queues (bullmq scheduler mode) live under `BULLMQ_PREFIX` (default `crewflow:<env>:bull`).
 * A future single-prefix cutover is a separate, controlled operation (see the migration report §Prefix).
 *
 * TENANT BINDING (unchanged by D-Q1, documented here): a consumer job's payload is identifiers only. Every consumer binds
 * the job's `organisationId` with `TenantContextService.runInTenantContext` (SET LOCAL) and re-reads its row by id under
 * FORCE RLS before doing anything (email-send.processor.ts, push-send.processor.ts, shift-statement.job.ts
 * processShiftStatementJob, AiTurnRunnerService / AiTitleService); a forged id combination matches no row. D-Q1 adds the
 * PRODUCER side: `registeredJob` (./queue-enqueue.ts) refuses any enqueue that does not declare a valid scope.
 */
export const LEGACY_BULL_PREFIX = 'bull';

/**
 * BullMQ's Worker defaults in the INSTALLED version (bullmq 5.81.3, `dist/cjs/classes/worker.js:34`:
 * `{ drainDelay: 5, concurrency: 1, lockDuration: 30000, maximumRateLimitDelay: 30000, maxStalledCount: 1,
 * stalledInterval: 30000, autorun: true, runRetryDelay: 15000 }`). Before D-Q1 no Crewflow Worker set maxStalledCount or
 * stalledInterval, and only `rab-ai` set lockDuration, so these were the effective values; they are now passed
 * explicitly. A BullMQ upgrade that changes a default therefore changes nothing here.
 */
export const BULLMQ_WORKER_DEFAULTS = Object.freeze({ lockDurationMs: 30_000, maxStalledCount: 1, stalledIntervalMs: 30_000 });

/** The job option D-Q1 records as "none": bullmq 5.x has no per-job timeout (a handler bounds its own run time). */
export const NO_JOB_TIMEOUT = null;

export type ConsumerQueueKey = 'email' | 'push' | 'shiftStatements' | 'ai' | 'timerTriggers' | 'auditEvents';

/** The scan queues (bullmq scheduler mode only), grouped by the existing `queues/rab-<domain>` folders. */
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
export type ConsumerQueueName =
  | typeof EMAIL_QUEUE_NAME
  | typeof PUSH_QUEUE_NAME
  | typeof SHIFT_STATEMENT_QUEUE_NAME
  | typeof AI_QUEUE_NAME
  | typeof TIMER_TRIGGER_QUEUE_NAME
  | typeof AUDIT_EVENT_QUEUE_NAME;
export type QueueName = ConsumerQueueName | ScanQueueName;

/** Whose job a queue carries: `organisation` = one tenant's row (the payload carries its organisationId); `system` = none. */
export type QueueTenantScopeKind = 'organisation' | 'system';

export interface QueueRetention {
  /** Seconds a finished job is kept. */
  readonly age: number;
  /** Maximum number of finished jobs kept; `null` = no count limit (the option is omitted). */
  readonly count: number | null;
}

/** BullMQ Worker options of the queue's consumer. All required: nothing is left to a library default. */
export interface QueueWorkerSettings {
  readonly concurrency: number;
  readonly lockDurationMs: number;
  readonly maxStalledCount: number;
  readonly stalledIntervalMs: number;
}

/** BullMQ job options every producer of the queue uses. All required. */
export interface QueueJobSettings {
  readonly attempts: number;
  /** `null` = no backoff option (single attempt). */
  readonly backoff: { readonly type: 'exponential'; readonly delayMs: number; readonly jitter: number } | null;
  readonly removeOnComplete: QueueRetention;
  readonly removeOnFail: QueueRetention;
  /** Always `null` (NO_JOB_TIMEOUT): bullmq 5.x has no job timeout option. Recorded so the absence is a decision. */
  readonly timeoutMs: null;
}

export interface QueueSettings {
  readonly kind: 'consumer' | 'scan';
  /** `legacy-bull` = BullMQ's default `bull` prefix; `scan` = the resolved BULLMQ_PREFIX. */
  readonly prefix: 'legacy-bull' | 'scan';
  /** Every job name the queue's consumer accepts. Any other name fails closed (moved to failed, no side effect). */
  readonly jobNames: readonly string[];
  readonly tenantScope: QueueTenantScopeKind;
  /** The ONLY top-level payload keys a job may carry (identifiers and small scalars — never content). */
  readonly payloadKeys: readonly string[];
  /**
   * X1.1 (owner decision 2026-11-12): job names of an organisation-scoped consumer queue that carry NO tenant (a
   * `{ kind: 'system' }` scope) and their own payload keys — today only the audit queue's pre-auth failed-login event.
   * Such a payload must not name an organisation; every other job name of the queue keeps the queue's scope and keys.
   */
  readonly systemScopedJobs?: Readonly<Record<string, readonly string[]>>;
  readonly worker: QueueWorkerSettings;
  readonly job: QueueJobSettings;
}

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

/**
 * Phase X3.4 (owner decision 2026-11-12, "the Twenty way"): ONE BullMQ retention for EVERY queue — consumers and scan queues,
 * completed and failed alike — with Twenty's values (twenty-server `message-queue/constants/queue-retention.constants.ts`,
 * which its `bullmq.driver.ts` puts on every job and every cron template): a completed job is kept 4 h and at most 1,000 per
 * queue, a failed job 7 days and at most 1,000 per queue; whichever limit is reached first removes the oldest. Before X3.4:
 * email / push / statements 7 d completed and 30 d failed with no count cap; rab-ai and timer triggers 1 h / 1000 completed and
 * 7 d / 5000 failed; scan queues 1 h / 1000 completed and 7 d failed with no count cap.
 *
 * A retained BullMQ job is a short operational window (the admin panel's job list, a manual retry of a failed job), never the
 * record. The durable PostgreSQL rows stay the long-term record: `email_outbox`, `push_delivery`, `payroll_record.statement_*`,
 * `ai_message`, `worker_event` and `audit_log`, each with its own retention (outbox-retention).
 *
 * Correctness never depends on how long a finished job is retained (checked queue by queue for X3.4):
 *  - a SHORTER window can only let a re-add of the same jobId create a new job instead of being dropped as a duplicate. Every
 *    consumer re-reads its row under RLS and claims it with a compare-and-set before any side effect: email (PENDING / QUEUED /
 *    RETRY → PROCESSING, below the attempt cap; SENT / CANCELLED skip), push (PENDING / RETRY → PROCESSING, below the cap;
 *    ACCEPTED / CANCELLED skip), statements (same `statement_dispatch_generation`, still queued/processing, no file yet — and
 *    every dispatcher claim bumps the generation, so each publish has a new jobId anyway), AI turns (`queued` → `running`),
 *    timer triggers (the scan's own per-candidate compare-and-set, same worker_event key). A delivered row is never sent again.
 *  - a LONGER window (rab-ai, timer triggers and scan queues: completed 1 h → 4 h) can only drop more re-adds of the same jobId.
 *    No producer relies on re-adding a finished id: AI turn / resume ids are per new turn row, a deferral's id grows with the
 *    seconds waited (never repeats), a promotion and the title are at most once by design; a timer trigger's id carries its due
 *    time and the unchanged backstop scan handles any dropped trigger; scan jobs get a fresh BullMQ id per scheduler tick (and
 *    a wake adds no fixed id).
 *  - email / push recovery never re-adds an id an earlier attempt used: a stale row is republished under a bumped
 *    `dispatch_generation` (`…attempt.<generation>`), whatever BullMQ still retains.
 */
export const QUEUE_RETENTION = Object.freeze({
  completedMaxAgeSeconds: 4 * HOUR,
  completedMaxCount: 1000,
  failedMaxAgeSeconds: 7 * DAY,
  failedMaxCount: 1000,
});

/** The retention every queue's job settings carry (`queue-registry.spec.ts` asserts no queue differs). */
const RETENTION = Object.freeze({
  removeOnComplete: Object.freeze({ age: QUEUE_RETENTION.completedMaxAgeSeconds, count: QUEUE_RETENTION.completedMaxCount }),
  removeOnFail: Object.freeze({ age: QUEUE_RETENTION.failedMaxAgeSeconds, count: QUEUE_RETENTION.failedMaxCount }),
});
/** D5: 5 attempts, exponential from 5 s, jitter 0.5 (each retry waits a random 50–100 % of its exponential step). */
const OUTBOX_RETRY = Object.freeze({ attempts: 5, backoff: Object.freeze({ type: 'exponential' as const, delayMs: 5_000, jitter: 0.5 }) });

const DEFAULT_STALL = Object.freeze({
  lockDurationMs: BULLMQ_WORKER_DEFAULTS.lockDurationMs,
  maxStalledCount: BULLMQ_WORKER_DEFAULTS.maxStalledCount,
  stalledIntervalMs: BULLMQ_WORKER_DEFAULTS.stalledIntervalMs,
});

/** Scan jobs: one attempt (the next tick is the retry), the shared X3.4 retention. */
const SCAN_JOB = Object.freeze({
  attempts: 1,
  backoff: null,
  ...RETENTION,
  timeoutMs: NO_JOB_TIMEOUT,
});

/**
 * Scan Worker concurrency = the number of distinct scans on the queue (one slot each, so different scans never wait for
 * each other, as in interval mode; the same scan never overlaps — runtime guard + scan lock). Scan lockDuration = the
 * rule in rab-worker `scan-jobs.ts` `lockDurationMsFor` (measured p99 × 3, floored at BullMQ's 30 s default), which is the
 * floor for every queue today. rab-worker's specs and a boot check in bullmq mode assert both still match SCAN_JOBS.
 */
const scanQueue = (concurrency: number, jobNames: readonly string[]) =>
  Object.freeze({
    kind: 'scan' as const,
    prefix: 'scan' as const,
    jobNames: Object.freeze([...jobNames]),
    tenantScope: 'system' as const,
    payloadKeys: Object.freeze(['v']),
    worker: Object.freeze({ concurrency, ...DEFAULT_STALL }),
    job: SCAN_JOB,
  });

export const QUEUE_SETTINGS = Object.freeze({
  // ── consumer queues (legacy `bull` prefix; organisation-scoped) ──────────────────────────────────────────────────
  /** Transactional email (outbox `core.email_outbox`). Producers: EmailQueueService (API fast path, admin replay, Worker dispatcher). */
  [EMAIL_QUEUE_NAME]: Object.freeze({
    kind: 'consumer' as const,
    prefix: 'legacy-bull' as const,
    jobNames: Object.freeze([EMAIL_QUEUE_JOB_NAME] as const),
    tenantScope: 'organisation' as const,
    payloadKeys: Object.freeze(['emailOutboxId', 'organisationId']),
    worker: Object.freeze({ concurrency: 5, ...DEFAULT_STALL }),
    job: Object.freeze({ ...OUTBOX_RETRY, ...RETENTION, timeoutMs: NO_JOB_TIMEOUT }),
  }),
  /** Push delivery (outbox `core.push_delivery`). Producer: PushQueueService (Worker push dispatcher). */
  [PUSH_QUEUE_NAME]: Object.freeze({
    kind: 'consumer' as const,
    prefix: 'legacy-bull' as const,
    jobNames: Object.freeze([PUSH_QUEUE_JOB_NAME] as const),
    tenantScope: 'organisation' as const,
    payloadKeys: Object.freeze(['pushDeliveryId', 'organisationId']),
    worker: Object.freeze({ concurrency: 10, ...DEFAULT_STALL }),
    job: Object.freeze({ ...OUTBOX_RETRY, ...RETENTION, timeoutMs: NO_JOB_TIMEOUT }),
  }),
  /**
   * Approved shift statements (outbox `payroll_record.statement_status`). Producer: the Worker's shift-statement
   * dispatcher. attempts 1: retries are the dispatcher's, counted on the row, never BullMQ's.
   */
  [SHIFT_STATEMENT_QUEUE_NAME]: Object.freeze({
    kind: 'consumer' as const,
    prefix: 'legacy-bull' as const,
    jobNames: Object.freeze([SHIFT_STATEMENT_JOB_NAME] as const),
    tenantScope: 'organisation' as const,
    payloadKeys: Object.freeze(['payrollRecordId', 'organisationId', 'workspaceId', 'generation']),
    worker: Object.freeze({ concurrency: 2, ...DEFAULT_STALL }),
    job: Object.freeze({ attempts: 1, backoff: null, ...RETENTION, timeoutMs: NO_JOB_TIMEOUT }),
  }),
  /**
   * AI Phase 1/2: one assistant turn (`ai-turn`, kinds turn / resume) or a conversation title (`ai-title`) per job, IDs
   * only (ai-jobs.contract.ts). Concurrency 4 per Worker process (each turn mostly waits on the model); the
   * per-ORGANISATION cap (AI_ORG_MAX_ACTIVE_TURNS) is a Redis semaphore the API takes before enqueueing. lockDuration
   * 60 s (the only override of BullMQ's default). attempts 1: a failed turn is final (the user asks again). The Phase 6b
   * job name (EX-3, not approved) is deliberately NOT accepted: such a job fails closed before any handler runs.
   */
  [AI_QUEUE_NAME]: Object.freeze({
    kind: 'consumer' as const,
    prefix: 'legacy-bull' as const,
    jobNames: Object.freeze([AI_TURN_JOB_NAME, AI_TITLE_JOB_NAME] as const),
    tenantScope: 'organisation' as const,
    payloadKeys: Object.freeze(['v', 'kind', 'turnId', 'conversationId', 'organisationId', 'workspaceId', 'userId', 'pausedTurnId', 'cause', 'refId']),
    worker: Object.freeze({ ...DEFAULT_STALL, concurrency: 4, lockDurationMs: 60_000 }),
    job: Object.freeze({
      attempts: 1,
      backoff: null,
      ...RETENTION,
      timeoutMs: NO_JOB_TIMEOUT,
    }),
  }),
  /**
   * Phase D-Q4b (OD-3 / OD-4, 2026-11-04): delayed TIMER TRIGGERS (engine/worker-shared/timer-trigger.contract.ts). Legacy
   * `bull` prefix like email/push/ai (OD-4: the API produces offer triggers with no prefix configuration). A NEW queue
   * name, so a Worker built before D-Q4b never receives a trigger (rolling deploy). Ids-only payload
   * {organisationId, workspaceId, subjectId, dueAtEpochMs}; jobId `<kind>.<subjectId>.<dueAtEpochMs>`. The consumer is
   * created only when WORKER_TIMER_TRIGGERS is shadow or on. Concurrency 2 (plan §4: the consumers already total 21 against
   * a runtime pool of 12 — a new consumer starts low and is measured before anything is raised). attempts 3, exponential
   * from 5 s (a database blip; every attempt is the same idempotent compare-and-set); the shared X3.4 retention (a trigger is
   * a short-lived hint, not a record).
   */
  [TIMER_TRIGGER_QUEUE_NAME]: Object.freeze({
    kind: 'consumer' as const,
    prefix: 'legacy-bull' as const,
    jobNames: Object.freeze(TIMER_TRIGGER_KINDS.map((k) => TIMER_TRIGGER_JOB_NAMES[k])),
    tenantScope: 'organisation' as const,
    payloadKeys: Object.freeze([...TIMER_TRIGGER_PAYLOAD_KEYS]),
    worker: Object.freeze({ concurrency: 2, ...DEFAULT_STALL }),
    job: Object.freeze({
      attempts: 3,
      backoff: Object.freeze({ type: 'exponential' as const, delayMs: 5_000, jitter: 0.5 }),
      ...RETENTION,
      timeoutMs: NO_JOB_TIMEOUT,
    }),
  }),
  /**
   * Phase X Part 2, X1.1 (owner decision 2026-11-12): the off-host copy of security audit events
   * (engine/worker-shared/audit-event.contract.ts). Ids-only payload {organisationId, auditLogId}; jobId
   * `audit-event.<auditLogId>`; the consumer re-reads the committed row under FORCE RLS and writes it to the configured
   * sink. Produced only when CREWFLOW_AUDIT_SINK is not `none`. Concurrency 2 (a new consumer starts low, as D-Q4b's did).
   * attempts 10, exponential from 5 s with jitter: a sink outage of up to ~40 minutes is retried before a job is failed
   * (best effort: the row in core.audit_log stays the record). Retention: Twenty's queue-retention values
   * (completed 4 h / 1,000, failed 7 days / 1,000; X3.4).
   */
  [AUDIT_EVENT_QUEUE_NAME]: Object.freeze({
    kind: 'consumer' as const,
    prefix: 'legacy-bull' as const,
    jobNames: Object.freeze([AUDIT_EVENT_JOB_NAME, AUDIT_PREAUTH_JOB_NAME] as const),
    tenantScope: 'organisation' as const,
    payloadKeys: Object.freeze([...AUDIT_EVENT_PAYLOAD_KEYS]),
    // Owner decision 2026-11-12 (b): the pre-auth failed login has no organisation — a system-scoped job of this queue.
    systemScopedJobs: Object.freeze({ [AUDIT_PREAUTH_JOB_NAME]: Object.freeze([...AUDIT_PREAUTH_PAYLOAD_KEYS]) }),
    worker: Object.freeze({ concurrency: 2, ...DEFAULT_STALL }),
    job: Object.freeze({
      attempts: 10,
      backoff: Object.freeze({ type: 'exponential' as const, delayMs: 5_000, jitter: 0.5 }),
      removeOnComplete: Object.freeze({ age: 4 * 3600, count: 1000 }),
      removeOnFail: Object.freeze({ age: 7 * DAY, count: 1000 }),
      timeoutMs: NO_JOB_TIMEOUT,
    }),
  }),
  // ── scan queues (BULLMQ_PREFIX; system-scoped; bullmq scheduler mode only — one job scheduler per scan) ─────────────
  [SCAN_QUEUES.email]: scanQueue(1, ['email-dispatch']),
  [SCAN_QUEUES.push]: scanQueue(1, ['push-dispatch']),
  // Phase D-Q4a adds `shift-scan-combined` (one more slot: 4 → 5). Registered only when WORKER_SHIFT_SCAN_MODE=combined
  // (its two shifts-queue members, shift-monitor and attendance-monitor, are then not), so one slot is idle in either mode.
  [SCAN_QUEUES.shifts]: scanQueue(5, ['shift-monitor', 'attendance-monitor', 'late-clock-in', 'shift-cancellation-followup', 'shift-scan-combined']),
  [SCAN_QUEUES.offers]: scanQueue(3, ['offer-expiry', 'manager-confirmation-timeout', 'replacement-staff']),
  [SCAN_QUEUES.reports]: scanQueue(4, ['shift-report-scheduler', 'final-timesheet', 'shift-statement-dispatch', 'payroll-period-attention']),
  // Phase D-Q2 adds `ai-stale-turn-sweep` (one more slot: 7 → 8). Registered only when AI_STALE_TURN_SWEEP=true; the
  // slot exists either way so the registry equals SCAN_JOBS (assertScanQueueSettings counts every defined scan).
  [SCAN_QUEUES.maintenance]: scanQueue(8, [
    'account-invite-cleanup',
    'token-cleanup',
    'login-handoff-cleanup',
    'storage-cleanup',
    'outbox-retention',
    'ai-retention',
    'workspace-provisioning-health',
    'ai-stale-turn-sweep',
  ]),
  [SCAN_QUEUES.realtime]: scanQueue(1, ['realtime-outbox-publish']),
} satisfies { readonly [N in QueueName]: QueueSettings });

export type QueueSettingsOf<N extends QueueName> = (typeof QUEUE_SETTINGS)[N];
export type JobNameOf<N extends QueueName> = QueueSettingsOf<N>['jobNames'][number];

export const QUEUE_NAMES: readonly QueueName[] = Object.freeze(Object.keys(QUEUE_SETTINGS) as QueueName[]);

/** An unknown queue name. Fail closed: thrown wherever a queue name is resolved (boot, producers, consumers). */
export class UnknownQueueError extends Error {
  constructor(name: string) {
    super(`queue "${name}" is not in the queue registry (engine/worker-shared/queue-registry.ts)`);
    this.name = 'UnknownQueueError';
  }
}

export const isRegisteredQueue = (name: string): name is QueueName => Object.prototype.hasOwnProperty.call(QUEUE_SETTINGS, name);

/** The settings of a queue by name. Throws UnknownQueueError for any name the registry does not list. */
export function queueSettingsOf(name: string): QueueSettings {
  if (!isRegisteredQueue(name)) throw new UnknownQueueError(name);
  return QUEUE_SETTINGS[name];
}

/** BullMQ `Worker` options of the queue's consumer (every option explicit; same values as before D-Q1). */
export function bullmqWorkerOptionsOf(name: QueueName): { concurrency: number; lockDuration: number; maxStalledCount: number; stalledInterval: number } {
  const { worker } = queueSettingsOf(name);
  return { concurrency: worker.concurrency, lockDuration: worker.lockDurationMs, maxStalledCount: worker.maxStalledCount, stalledInterval: worker.stalledIntervalMs };
}

export interface BullmqRetention {
  age: number;
  count?: number;
}
export interface BullmqJobOptions {
  attempts: number;
  backoff?: { type: 'exponential'; delay: number; jitter: number };
  removeOnComplete: BullmqRetention;
  removeOnFail: BullmqRetention;
}

/** The job options of a queue that retries (email / push): `backoff` is always present. */
export type OutboxJobOptions = BullmqJobOptions & Required<Pick<BullmqJobOptions, 'backoff'>>;

const retentionOf =(r: QueueRetention): BullmqRetention => (r.count === null ? { age: r.age } : { age: r.age, count: r.count });

/**
 * BullMQ job options of the queue, in the exact shape producers passed before D-Q1 (a `null` backoff / count is omitted,
 * never sent as `undefined`). `timeoutMs` is never emitted: bullmq 5.x has no such option.
 */
export function bullmqJobOptionsOf(name: QueueName): BullmqJobOptions {
  const { job } = queueSettingsOf(name);
  return {
    attempts: job.attempts,
    ...(job.backoff ? { backoff: { type: job.backoff.type, delay: job.backoff.delayMs, jitter: job.backoff.jitter } } : {}),
    removeOnComplete: retentionOf(job.removeOnComplete),
    removeOnFail: retentionOf(job.removeOnFail),
  };
}

/** The BullMQ prefix a queue lives under (`bull` for the consumers, the resolved BULLMQ_PREFIX for the scan queues). */
export function prefixOf(name: QueueName, scanPrefix: string): string {
  return queueSettingsOf(name).prefix === 'legacy-bull' ? LEGACY_BULL_PREFIX : scanPrefix;
}

/** True when `jobName` is one the queue's consumer accepts. */
export function acceptsJobName(name: QueueName, jobName: string): boolean {
  return queueSettingsOf(name).jobNames.includes(jobName);
}

/**
 * Boot check (fail closed): the registry is internally consistent and every value is one BullMQ accepts — names
 * well-formed, kinds / prefixes / scopes coherent, positive integer concurrency / lockDuration / stalledInterval,
 * maxStalledCount ≥ 0, attempts ≥ 1, a backoff only with retries, retention ≥ 0, job names and payload keys non-empty
 * and unique, a consumer queue organisation-scoped with `organisationId` among its payload keys, a scan queue
 * system-scoped, every scan queue present. The Worker runs it before any consumer, scheduler or loop exists; `registry`
 * is a parameter only so a spec can feed it a broken one.
 */
/** Keys a system-scoped job payload may never declare: a tenant or user identity has no place in a job without a tenant. */
const SYSTEM_JOB_FORBIDDEN_KEYS: readonly string[] = Object.freeze(['organisationId', 'organisation_id', 'orgId', 'tenantId', 'userId']);

export function assertQueueRegistryValid(registry: Readonly<Record<string, QueueSettings>> = QUEUE_SETTINGS): void {
  const problems: string[] = [];
  const posInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0;
  const nonNegInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  const scanNames = new Set<string>(Object.values(SCAN_QUEUES));
  const scanJobOwner = new Map<string, string>();
  for (const [name, s] of Object.entries(registry)) {
    const p = (msg: string) => problems.push(`${name}: ${msg}`);
    if (!/^[a-z0-9-]{1,64}$/.test(name)) p('invalid queue name');
    const coherent =
      s.kind === 'scan'
        ? scanNames.has(name) && s.prefix === 'scan' && s.tenantScope === 'system'
        : s.kind === 'consumer' && !scanNames.has(name) && s.prefix === 'legacy-bull' && s.tenantScope === 'organisation' && s.payloadKeys.includes('organisationId');
    if (!coherent) p('kind / prefix / tenant scope / payload keys are inconsistent');
    if (!s.jobNames.length || new Set(s.jobNames).size !== s.jobNames.length) p('job names must be non-empty and unique');
    for (const jobName of s.jobNames) {
      if (!/^[a-z0-9-]{1,64}$/.test(jobName)) p(`invalid job name ${jobName}`);
      if (s.kind === 'scan') {
        const other = scanJobOwner.get(jobName);
        if (other) p(`scan job ${jobName} is also declared on ${other}`);
        scanJobOwner.set(jobName, name);
      }
    }
    if (!s.payloadKeys.length || new Set(s.payloadKeys).size !== s.payloadKeys.length) p('payload keys must be non-empty and unique');
    for (const [jobName, keys] of Object.entries(s.systemScopedJobs ?? {})) {
      if (s.kind !== 'consumer' || !s.jobNames.includes(jobName)) p(`system-scoped job ${jobName} is not a job of this consumer queue`);
      const tenantKey = keys.find((k) => SYSTEM_JOB_FORBIDDEN_KEYS.includes(k));
      if (!keys.length || new Set(keys).size !== keys.length || tenantKey) p(`system-scoped job ${jobName}: payload keys must be non-empty, unique and never a tenant or user id (${tenantKey ?? 'duplicate or empty'})`);
    }
    if (!posInt(s.worker.concurrency)) p('worker.concurrency must be a positive integer');
    if (!posInt(s.worker.lockDurationMs)) p('worker.lockDurationMs must be a positive integer');
    if (!nonNegInt(s.worker.maxStalledCount)) p('worker.maxStalledCount must be an integer >= 0');
    if (!posInt(s.worker.stalledIntervalMs)) p('worker.stalledIntervalMs must be a positive integer');
    if (!posInt(s.job.attempts)) p('job.attempts must be a positive integer');
    if (s.job.backoff && (s.job.attempts < 2 || !posInt(s.job.backoff.delayMs) || !(s.job.backoff.jitter >= 0 && s.job.backoff.jitter <= 1))) p('job.backoff is invalid');
    for (const r of [s.job.removeOnComplete, s.job.removeOnFail]) {
      if (!nonNegInt(r.age) || (r.count !== null && !nonNegInt(r.count))) p('job retention is invalid');
    }
    if (s.job.timeoutMs !== null) p('job.timeoutMs must be null (bullmq 5.x has no job timeout)');
  }
  for (const scan of scanNames) if (!Object.prototype.hasOwnProperty.call(registry, scan)) problems.push(`${scan}: scan queue has no settings`);
  if (problems.length) throw new Error(`queue registry is invalid:\n  ${problems.join('\n  ')}`);
}

// ── Compatibility views (pre-D-Q1 names; every value now derived from QUEUE_SETTINGS) ────────────────────────────────

export interface ConsumerQueueDefinition {
  key: ConsumerQueueKey;
  /** BullMQ queue name (also used by the API producers). */
  name: ConsumerQueueName;
  /** The job name the consumer's ONE `@Process` handler is registered under (every accepted job name reaches it). */
  jobName: string;
  /** Always the legacy `bull` prefix (see above). */
  prefix: typeof LEGACY_BULL_PREFIX;
  /** Worker concurrency (5 / 10 / 2 / 4). */
  concurrency: number;
  /** Human name used in the existing log lines. */
  logName: string;
  /**
   * BullMQ Worker `lockDuration` (ms). D-Q1: explicit for every consumer — 30 s (BullMQ's default, which the three
   * original consumers always had) and 60 s for `rab-ai`. The lock is renewed every half period while a job runs, so this
   * bounds STALL DETECTION, not run time.
   */
  lockDurationMs: number;
}

const consumer = (key: ConsumerQueueKey, name: ConsumerQueueName, jobName: string, logName: string): ConsumerQueueDefinition => ({
  key,
  name,
  jobName,
  prefix: LEGACY_BULL_PREFIX,
  concurrency: QUEUE_SETTINGS[name].worker.concurrency,
  logName,
  lockDurationMs: QUEUE_SETTINGS[name].worker.lockDurationMs,
});

export const CONSUMER_QUEUES: Readonly<Record<ConsumerQueueKey, ConsumerQueueDefinition>> = Object.freeze({
  email: consumer('email', EMAIL_QUEUE_NAME, EMAIL_QUEUE_JOB_NAME, 'email'),
  push: consumer('push', PUSH_QUEUE_NAME, PUSH_QUEUE_JOB_NAME, 'push'),
  shiftStatements: consumer('shiftStatements', SHIFT_STATEMENT_QUEUE_NAME, SHIFT_STATEMENT_JOB_NAME, 'shift statement'),
  ai: consumer('ai', AI_QUEUE_NAME, AI_TURN_JOB_NAME, 'ai turn'),
  // D-Q4b: one handler receives all four trigger job names (it dispatches on job.name); created only when the flag is not off.
  timerTriggers: consumer('timerTriggers', TIMER_TRIGGER_QUEUE_NAME, TIMER_TRIGGER_JOB_NAMES['offer-expiry'], 'timer trigger'),
  // X1.1: the security audit event shipper (created in every Worker; with no sink configured nothing is ever produced).
  auditEvents: consumer('auditEvents', AUDIT_EVENT_QUEUE_NAME, AUDIT_EVENT_JOB_NAME, 'audit event'),
});

export const SCAN_QUEUE_NAMES: readonly ScanQueueName[] = Object.freeze(Object.values(SCAN_QUEUES));

export const isScanQueue = (name: string): name is ScanQueueName => (SCAN_QUEUE_NAMES as readonly string[]).includes(name);
export const consumerQueueByName = (name: string): ConsumerQueueDefinition | undefined => Object.values(CONSUMER_QUEUES).find((q) => q.name === name);

/** `crewflow:<NODE_ENV>:bull` unless BULLMQ_PREFIX is set (validated by the shared EnvironmentVariables class). */
export function resolveScanPrefix(nodeEnv: string, configured: string | undefined): string {
  const prefix = configured?.trim() || `crewflow:${nodeEnv}:bull`;
  if (prefix === LEGACY_BULL_PREFIX || prefix.startsWith(`${LEGACY_BULL_PREFIX}:`)) {
    // Defence in depth — the validator already refuses this.
    throw new Error('BULLMQ_PREFIX must not be the legacy "bull" prefix (the scan queues must stay isolated from rab-email/rab-push/rab-shift-statements)');
  }
  return prefix;
}

/**
 * Admin panel follow-up (owner-approved 2026-10-25): every consumer AND scan Worker records BullMQ metrics with
 * `metrics: { maxDataPoints: MetricsTime.ONE_WEEK }` — one data point per minute, a week of history (10 080 points) per
 * queue and type (completed / failed). The API's Health chart reads them with `Queue.getMetrics`. This number is BullMQ's
 * `MetricsTime.ONE_WEEK` (kept as a literal so this registry stays free of runtime imports; the worker's
 * `bullmq-scheduler.spec.ts` asserts the two are equal). Applies in BOTH scheduler modes: the consumers run in interval
 * mode too, so this adds a few Redis writes per finished job there as well (approved).
 */
export const WORKER_METRICS_MAX_DATA_POINTS = 10_080;

/** BullMQ scan job options (scan queues only — never applied to email/push/PDF consumer jobs). Derived from the registry. */
export const SCAN_JOB_OPTIONS = Object.freeze(bullmqJobOptionsOf(SCAN_QUEUES.email));

/** Template payload of every scheduled scan job: metadata only (no ids, tokens, bodies or tenant data). */
export const SCAN_JOB_DATA = Object.freeze({ v: 1 });
