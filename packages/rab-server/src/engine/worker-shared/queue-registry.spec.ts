import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  acceptsJobName,
  assertQueueRegistryValid,
  BULLMQ_WORKER_DEFAULTS,
  bullmqJobOptionsOf,
  bullmqWorkerOptionsOf,
  CONSUMER_QUEUES,
  LEGACY_BULL_PREFIX,
  prefixOf,
  QUEUE_NAMES,
  QUEUE_SETTINGS,
  QueueName,
  QueueSettings,
  QueueWorkerSettings,
  queueSettingsOf,
  resolveScanPrefix,
  SCAN_JOB_DATA,
  SCAN_JOB_OPTIONS,
  SCAN_QUEUE_NAMES,
  UnknownQueueError,
} from './queue-registry';
import { registeredJob, registeredSystemScopedJob, QueueEnqueueRefusedError } from './queue-enqueue';
import { TIMER_TRIGGER_QUEUE_NAME } from './timer-trigger.contract';
import { AUDIT_EVENT_QUEUE_NAME } from './audit-event.contract';

/**
 * Phase D-Q1 "queue registry": every queue's options are explicit, complete at compile time, and EXACTLY the values in
 * effect before D-Q1. The expected tables below are written out by hand from the pre-D-Q1 code (origin/main 1efaea43) —
 * never derived from the registry — so a changed value fails here:
 *   - consumer Worker options: bullmq-scheduler.ts createConsumerWorkers (concurrency from the old CONSUMER_QUEUES,
 *     lockDuration only for rab-ai, everything else BullMQ's default);
 *   - scan Worker options: bullmq-scheduler.ts startBullmqScheduler (`scanJobsOn(queue).length`, `lockDurationMsFor`);
 *   - job options: email-queue.service.ts / push-queue.service.ts EMAIL|PUSH_QUEUE_JOB_OPTIONS, report.processors.ts
 *     (statements), ai-turn-queue.service.ts AI_TURN_JOB_OPTIONS, queue-registry.ts SCAN_JOB_OPTIONS.
 */
const DAY = 86_400;
/** The queues that existed before D-Q4b (the pre-D-Q1 tables below cover exactly these; D-Q4b's queue is pinned on its own). */
type PreDq4bQueueName = Exclude<QueueName, typeof TIMER_TRIGGER_QUEUE_NAME | typeof AUDIT_EVENT_QUEUE_NAME>;
const PRE_DQ1_WORKER_OPTIONS: Record<PreDq4bQueueName, { concurrency: number; lockDuration: number; maxStalledCount: number; stalledInterval: number }> = {
  'rab-email': { concurrency: 5, lockDuration: 30_000, maxStalledCount: 1, stalledInterval: 30_000 },
  'rab-push': { concurrency: 10, lockDuration: 30_000, maxStalledCount: 1, stalledInterval: 30_000 },
  'rab-shift-statements': { concurrency: 2, lockDuration: 30_000, maxStalledCount: 1, stalledInterval: 30_000 },
  'rab-ai': { concurrency: 4, lockDuration: 60_000, maxStalledCount: 1, stalledInterval: 30_000 },
  'crewflow-scan-email': { concurrency: 1, lockDuration: 30_000, maxStalledCount: 1, stalledInterval: 30_000 },
  'crewflow-scan-push': { concurrency: 1, lockDuration: 30_000, maxStalledCount: 1, stalledInterval: 30_000 },
  // Phase D-Q4a: + shift-scan-combined (one slot per distinct scan on the queue: 4 → 5; one slot idle in either mode).
  'crewflow-scan-shifts': { concurrency: 5, lockDuration: 30_000, maxStalledCount: 1, stalledInterval: 30_000 },
  'crewflow-scan-offers': { concurrency: 3, lockDuration: 30_000, maxStalledCount: 1, stalledInterval: 30_000 },
  'crewflow-scan-reports': { concurrency: 4, lockDuration: 30_000, maxStalledCount: 1, stalledInterval: 30_000 },
  'crewflow-scan-maintenance': { concurrency: 7, lockDuration: 30_000, maxStalledCount: 1, stalledInterval: 30_000 },
  'crewflow-scan-realtime': { concurrency: 1, lockDuration: 30_000, maxStalledCount: 1, stalledInterval: 30_000 },
};
/**
 * Phase D-Q2: the ONLY intended delta from the pre-D-Q1 table. `ai-stale-turn-sweep` is one more scan on
 * crewflow-scan-maintenance, so its Worker gets one more slot (7 → 8, the `scanJobsOn(queue).length` rule). Every other
 * value is the pre-D-Q1 one, unchanged.
 */
const EXPECTED_WORKER_OPTIONS: Record<QueueName, { concurrency: number; lockDuration: number; maxStalledCount: number; stalledInterval: number }> = {
  ...PRE_DQ1_WORKER_OPTIONS,
  'crewflow-scan-maintenance': { ...PRE_DQ1_WORKER_OPTIONS['crewflow-scan-maintenance'], concurrency: 8 },
  // Phase D-Q4b (plan §4): a NEW consumer starts at concurrency 2; stall settings are BullMQ's defaults, written out.
  'crewflow-timer-triggers': { concurrency: 2, lockDuration: 30_000, maxStalledCount: 1, stalledInterval: 30_000 },
  // Phase X Part 2, X1.1: a NEW consumer, concurrency 2 like D-Q4b's; stall settings are BullMQ's defaults, written out.
  'crewflow-audit-events': { concurrency: 2, lockDuration: 30_000, maxStalledCount: 1, stalledInterval: 30_000 },
};
const OUTBOX = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000, jitter: 0.5 },
  removeOnComplete: { age: 7 * DAY },
  removeOnFail: { age: 30 * DAY },
};
const SCAN = { attempts: 1, removeOnComplete: { age: 3600, count: 1000 }, removeOnFail: { age: 604_800 } };
const PRE_DQ1_JOB_OPTIONS: Record<PreDq4bQueueName, object> = {
  'rab-email': OUTBOX,
  'rab-push': OUTBOX,
  'rab-shift-statements': { attempts: 1, removeOnComplete: { age: 7 * 24 * 60 * 60 }, removeOnFail: { age: 30 * 24 * 60 * 60 } },
  'rab-ai': { attempts: 1, removeOnComplete: { age: 3600, count: 1000 }, removeOnFail: { age: 7 * 24 * 3600, count: 5000 } },
  'crewflow-scan-email': SCAN,
  'crewflow-scan-push': SCAN,
  'crewflow-scan-shifts': SCAN,
  'crewflow-scan-offers': SCAN,
  'crewflow-scan-reports': SCAN,
  'crewflow-scan-maintenance': SCAN,
  'crewflow-scan-realtime': SCAN,
};

describe('queue registry (Phase D-Q1)', () => {
  it('lists exactly the thirteen BullMQ queues Crewflow uses (the eleven pre-D-Q4b names unchanged + crewflow-timer-triggers + X1.1 crewflow-audit-events)', () => {
    expect([...QUEUE_NAMES].sort()).toEqual(
      [
        'rab-email',
        'rab-push',
        'rab-shift-statements',
        'rab-ai',
        'crewflow-scan-email',
        'crewflow-scan-push',
        'crewflow-scan-shifts',
        'crewflow-scan-offers',
        'crewflow-scan-reports',
        'crewflow-scan-maintenance',
        'crewflow-scan-realtime',
        'crewflow-timer-triggers',
        'crewflow-audit-events',
      ].sort(),
    );
    expect(Object.values(CONSUMER_QUEUES).map((q) => [q.name, q.jobName, q.prefix])).toEqual([
      ['rab-email', 'send-email', 'bull'],
      ['rab-push', 'send-push', 'bull'],
      ['rab-shift-statements', 'generate-shift-statement', 'bull'],
      ['rab-ai', 'ai-turn', 'bull'],
      ['crewflow-timer-triggers', 'offer-expiry-trigger', 'bull'],
      ['crewflow-audit-events', 'audit-event-ship', 'bull'],
    ]);
  });

  it.each(Object.keys(EXPECTED_WORKER_OPTIONS) as QueueName[])('%s: Worker options are explicit and equal the pre-D-Q1 effective values (plus the D-Q2 maintenance slot)', (name) => {
    expect(bullmqWorkerOptionsOf(name)).toEqual(EXPECTED_WORKER_OPTIONS[name]);
  });

  it('Phase D-Q2: the only Worker-option change is one more crewflow-scan-maintenance slot for ai-stale-turn-sweep', () => {
    const changed = (Object.keys(PRE_DQ1_WORKER_OPTIONS) as PreDq4bQueueName[]).filter((n) => JSON.stringify(bullmqWorkerOptionsOf(n)) !== JSON.stringify(PRE_DQ1_WORKER_OPTIONS[n]));
    expect(QUEUE_NAMES.filter((n) => !(n in PRE_DQ1_WORKER_OPTIONS))).toEqual(['crewflow-timer-triggers', 'crewflow-audit-events']);
    expect(changed).toEqual(['crewflow-scan-maintenance']);
    expect(bullmqWorkerOptionsOf('crewflow-scan-maintenance').concurrency - PRE_DQ1_WORKER_OPTIONS['crewflow-scan-maintenance'].concurrency).toBe(1);
    expect(acceptsJobName('crewflow-scan-maintenance', 'ai-stale-turn-sweep')).toBe(true);
    // A system scan, not a consumer: the sweep never enqueues or accepts an organisation-scoped job.
    expect(QUEUE_SETTINGS['crewflow-scan-maintenance'].tenantScope).toBe('system');
    expect(acceptsJobName('rab-ai', 'ai-stale-turn-sweep')).toBe(false);
  });

  it.each(Object.keys(PRE_DQ1_JOB_OPTIONS) as PreDq4bQueueName[])('%s: job options (attempts, backoff, retention) equal the pre-D-Q1 producer options', (name) => {
    expect(bullmqJobOptionsOf(name)).toEqual(PRE_DQ1_JOB_OPTIONS[name]);
    // No job timeout exists in bullmq 5.x; the registry records the absence and never emits one.
    expect(QUEUE_SETTINGS[name].job.timeoutMs).toBeNull();
    expect(bullmqJobOptionsOf(name)).not.toHaveProperty('timeout');
  });

  it('the compatibility views keep their pre-D-Q1 values (SCAN_JOB_OPTIONS, SCAN_JOB_DATA, consumer concurrency/lock)', () => {
    expect(SCAN_JOB_OPTIONS).toEqual(SCAN);
    expect(SCAN_JOB_DATA).toEqual({ v: 1 });
    expect(Object.values(CONSUMER_QUEUES).map((q) => [q.key, q.concurrency, q.lockDurationMs, q.logName])).toEqual([
      ['email', 5, 30_000, 'email'],
      ['push', 10, 30_000, 'push'],
      ['shiftStatements', 2, 30_000, 'shift statement'],
      ['ai', 4, 60_000, 'ai turn'],
      ['timerTriggers', 2, 30_000, 'timer trigger'],
      ['auditEvents', 2, 30_000, 'audit event'],
    ]);
  });

  it('BULLMQ_WORKER_DEFAULTS are the defaults of the INSTALLED bullmq Worker (read from its source, not assumed)', () => {
    const workerJs = path.join(path.dirname(require.resolve('bullmq/package.json')), 'dist/cjs/classes/worker.js');
    const source = fs.readFileSync(workerJs, 'utf8');
    const defaults = /Object\.assign\(\{ drainDelay: \d+, concurrency: 1, lockDuration: (\d+), maximumRateLimitDelay: \d+, maxStalledCount: (\d+), stalledInterval: (\d+),/.exec(source);
    expect(defaults).not.toBeNull();
    expect({ lockDurationMs: Number(defaults![1]), maxStalledCount: Number(defaults![2]), stalledIntervalMs: Number(defaults![3]) }).toEqual({ ...BULLMQ_WORKER_DEFAULTS });
    // And bullmq 5.x still has no job-level timeout option (so `timeoutMs: null` is the truthful value).
    const jobOptions = fs.readFileSync(path.join(path.dirname(workerJs), '../../esm/interfaces/base-job-options.d.ts'), 'utf8');
    expect(jobOptions).not.toMatch(/\btimeout\??:/);
  });

  it('prefixes are unchanged: legacy `bull` for the consumers, the resolved BULLMQ_PREFIX for the scan queues', () => {
    const scanPrefix = resolveScanPrefix('production', undefined);
    expect(scanPrefix).toBe('crewflow:production:bull');
    for (const q of Object.values(CONSUMER_QUEUES)) expect(prefixOf(q.name, scanPrefix)).toBe(LEGACY_BULL_PREFIX);
    for (const q of SCAN_QUEUE_NAMES) expect(prefixOf(q, scanPrefix)).toBe('crewflow:production:bull');
  });

  it('tenant scope and payload keys: consumer queues are organisation-scoped ids-only payloads, scan queues are system-scoped `{ v }`', () => {
    expect(Object.fromEntries(QUEUE_NAMES.map((n) => [n, [QUEUE_SETTINGS[n].tenantScope, [...QUEUE_SETTINGS[n].payloadKeys]]]))).toEqual({
      'rab-email': ['organisation', ['emailOutboxId', 'organisationId']],
      'rab-push': ['organisation', ['pushDeliveryId', 'organisationId']],
      'rab-shift-statements': ['organisation', ['payrollRecordId', 'organisationId', 'workspaceId', 'generation']],
      'rab-ai': ['organisation', ['v', 'kind', 'turnId', 'conversationId', 'organisationId', 'workspaceId', 'userId', 'pausedTurnId', 'cause', 'refId']],
      'crewflow-timer-triggers': ['organisation', ['organisationId', 'workspaceId', 'subjectId', 'dueAtEpochMs']],
      'crewflow-audit-events': ['organisation', ['organisationId', 'auditLogId']],
      ...Object.fromEntries(SCAN_QUEUE_NAMES.map((n) => [n, ['system', ['v']]])),
    });
  });

  it('rolling deploy: the consumers accept every job name any producer (old or new) publishes, and nothing else', () => {
    expect(QUEUE_NAMES.filter((n) => QUEUE_SETTINGS[n].kind === 'consumer').map((n) => [n, [...QUEUE_SETTINGS[n].jobNames]])).toEqual([
      ['rab-email', ['send-email']],
      ['rab-push', ['send-push']],
      ['rab-shift-statements', ['generate-shift-statement']],
      ['rab-ai', ['ai-turn', 'ai-title']],
      ['crewflow-timer-triggers', ['offer-expiry-trigger', 'manager-confirmation-trigger', 'no-show-trigger', 'late-clock-in-trigger']],
      ['crewflow-audit-events', ['audit-event-ship', 'audit-preauth-login-failed']],
    ]);
    expect(acceptsJobName('rab-email', 'send-push')).toBe(false);
    expect(acceptsJobName('rab-ai', 'ai-agent' + '-run')).toBe(false); // EX-3 not approved: never accepted
  });

  it('every scan job name is declared once, on one scan queue (23 scans: 21 pre-D-Q2 + ai-stale-turn-sweep + D-Q4a shift-scan-combined)', () => {
    const names = SCAN_QUEUE_NAMES.flatMap((q) => [...QUEUE_SETTINGS[q].jobNames]);
    expect(names).toHaveLength(23);
    expect(new Set(names).size).toBe(23);
  });

  it('an unknown queue name fails closed (UnknownQueueError), never a default', () => {
    expect(() => queueSettingsOf('rab-emails')).toThrow(UnknownQueueError);
    expect(() => queueSettingsOf('')).toThrow(UnknownQueueError);
    expect(() => queueSettingsOf('__proto__')).toThrow(UnknownQueueError);
    expect(() => queueSettingsOf('toString')).toThrow(UnknownQueueError);
    expect(() => bullmqWorkerOptionsOf('crewflow-scan-nope' as QueueName)).toThrow(UnknownQueueError);
    expect(() => bullmqJobOptionsOf('nope' as QueueName)).toThrow(UnknownQueueError);
  });

  describe('Phase D-Q4b: crewflow-timer-triggers', () => {
    const ORG = '11111111-1111-4111-8111-111111111111';
    const OTHER = '22222222-2222-4222-8222-222222222222';
    const WS = '33333333-3333-4333-8333-333333333333';
    const SUBJECT = '44444444-4444-4444-8444-444444444444';
    const data = { organisationId: ORG, workspaceId: WS, subjectId: SUBJECT, dueAtEpochMs: 1_800_000_000_000 };
    const job = (d: object, scope: object | undefined = { kind: 'organisation', organisationId: ORG }, name = 'offer-expiry-trigger') =>
      registeredJob(TIMER_TRIGGER_QUEUE_NAME, name as 'offer-expiry-trigger', scope as never, d, { jobId: `offer-expiry.${SUBJECT}.1800000000000`, delayMs: 60_000 });

    it('OD-4: legacy `bull` prefix (the API produces with no prefix configuration); a consumer queue, organisation-scoped', () => {
      expect(prefixOf(TIMER_TRIGGER_QUEUE_NAME, resolveScanPrefix('production', undefined))).toBe(LEGACY_BULL_PREFIX);
      expect(QUEUE_SETTINGS[TIMER_TRIGGER_QUEUE_NAME]).toMatchObject({ kind: 'consumer', prefix: 'legacy-bull', tenantScope: 'organisation' });
    });

    it('job options: attempts 3, exponential from 5 s (jitter 0.5), 1 h / 1000 completed, 7 d / 5000 failed', () => {
      expect(bullmqJobOptionsOf(TIMER_TRIGGER_QUEUE_NAME)).toEqual({
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000, jitter: 0.5 },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 7 * DAY, count: 5000 },
      });
    });

    it('a valid trigger: ids-only payload, the caller jobId, the delay and the registry options', () => {
      expect(job(data)).toEqual({
        queue: TIMER_TRIGGER_QUEUE_NAME,
        name: 'offer-expiry-trigger',
        data,
        opts: { jobId: `offer-expiry.${SUBJECT}.1800000000000`, delay: 60_000, ...bullmqJobOptionsOf(TIMER_TRIGGER_QUEUE_NAME) },
      });
    });

    it.each<[string, () => unknown]>([
      ['no scope', () => job(data, null as never)],
      ['a system scope', () => job(data, { kind: 'system' })],
      ['a non-UUID organisation', () => job({ ...data, organisationId: 'org-1' }, { kind: 'organisation', organisationId: 'org-1' })],
      ['a scope organisation different from the payload organisation (cross-tenant)', () => job(data, { kind: 'organisation', organisationId: OTHER })],
      ['an extra payload key', () => job({ ...data, staffEmail: 'x@example.com' })],
      ['a nested object', () => job({ ...data, subjectId: { id: SUBJECT } })],
      ['an unknown job name', () => job(data, undefined, 'offer-expiry')],
    ])('ABUSE: %s is refused before Redis (QueueEnqueueRefusedError)', (_label, build) => {
      expect(build).toThrow(QueueEnqueueRefusedError);
    });

    it('an unknown job name is not accepted by the consumer (fail closed)', () => {
      expect(acceptsJobName(TIMER_TRIGGER_QUEUE_NAME, 'shift-monitor')).toBe(false);
      expect(acceptsJobName(TIMER_TRIGGER_QUEUE_NAME, 'offer-expiry-trigger')).toBe(true);
    });
  });

  describe('Phase X Part 2, X1.1: crewflow-audit-events', () => {
    const ORG = '11111111-1111-4111-8111-111111111111';
    const OTHER = '22222222-2222-4222-8222-222222222222';
    const ROW = '44444444-4444-4444-8444-444444444444';
    const data = { organisationId: ORG, auditLogId: ROW };
    const job = (d: object, scope: object | undefined = { kind: 'organisation', organisationId: ORG }, name = 'audit-event-ship') =>
      registeredJob(AUDIT_EVENT_QUEUE_NAME, name as 'audit-event-ship', scope as never, d, { jobId: `audit-event.${ROW}` });

    it('legacy `bull` prefix, a consumer queue, organisation-scoped, ids-only {organisationId, auditLogId}', () => {
      expect(prefixOf(AUDIT_EVENT_QUEUE_NAME, resolveScanPrefix('production', undefined))).toBe(LEGACY_BULL_PREFIX);
      expect(QUEUE_SETTINGS[AUDIT_EVENT_QUEUE_NAME]).toMatchObject({ kind: 'consumer', prefix: 'legacy-bull', tenantScope: 'organisation', payloadKeys: ['organisationId', 'auditLogId'] });
    });

    it("job options: attempts 10, exponential from 5 s (jitter 0.5); Twenty's retention (4 h / 1000 completed, 7 d / 1000 failed)", () => {
      expect(bullmqJobOptionsOf(AUDIT_EVENT_QUEUE_NAME)).toEqual({
        attempts: 10,
        backoff: { type: 'exponential', delay: 5_000, jitter: 0.5 },
        removeOnComplete: { age: 4 * 3600, count: 1000 },
        removeOnFail: { age: 7 * DAY, count: 1000 },
      });
    });

    it('a valid job: ids-only payload, the deterministic jobId and the registry options', () => {
      expect(job(data)).toEqual({ queue: AUDIT_EVENT_QUEUE_NAME, name: 'audit-event-ship', data, opts: { jobId: `audit-event.${ROW}`, ...bullmqJobOptionsOf(AUDIT_EVENT_QUEUE_NAME) } });
    });

    it.each<[string, () => unknown]>([
      ['no scope', () => job(data, null as never)],
      ['a system scope', () => job(data, { kind: 'system' })],
      ['a scope organisation different from the payload organisation (cross-tenant)', () => job(data, { kind: 'organisation', organisationId: OTHER })],
      ['the action or metadata in the payload', () => job({ ...data, action: 'user.deleted' })],
      ['an e-mail in the payload', () => job({ ...data, email: 'x@example.com' })],
      ['a nested object', () => job({ ...data, auditLogId: { id: ROW } })],
      ['an unknown job name', () => job(data, undefined, 'audit-event')],
    ])('ABUSE: %s is refused before Redis (QueueEnqueueRefusedError)', (_label, build) => {
      expect(build).toThrow(QueueEnqueueRefusedError);
    });

    describe('owner decision 2026-11-12 (b): the system-scoped pre-auth failed-login job', () => {
      const pre = { v: 1, reason: 'invalid_credentials', provider: 'password', email: 'a***@example.com', at: 1_800_000_000_000 };
      const build = (d: object) => registeredSystemScopedJob(AUDIT_EVENT_QUEUE_NAME, 'audit-preauth-login-failed', d, { jobId: `audit-preauth.${ROW}` });

      it('is declared as a system-scoped job of the (organisation-scoped) audit queue, with its own scalar keys', () => {
        expect(QUEUE_SETTINGS[AUDIT_EVENT_QUEUE_NAME].jobNames).toEqual(['audit-event-ship', 'audit-preauth-login-failed']);
        expect(QUEUE_SETTINGS[AUDIT_EVENT_QUEUE_NAME].systemScopedJobs).toEqual({ 'audit-preauth-login-failed': ['v', 'reason', 'provider', 'providerReason', 'email', 'at'] });
        expect(QUEUE_SETTINGS[AUDIT_EVENT_QUEUE_NAME].tenantScope).toBe('organisation');
      });

      it('a valid job: system scope, the registry options', () => {
        expect(build(pre)).toEqual({ queue: AUDIT_EVENT_QUEUE_NAME, name: 'audit-preauth-login-failed', data: pre, opts: { jobId: `audit-preauth.${ROW}`, ...bullmqJobOptionsOf(AUDIT_EVENT_QUEUE_NAME) } });
      });

      it.each<[string, () => unknown]>([
        ['an organisationId in its payload', () => build({ ...pre, organisationId: ORG })],
        ['an unknown key (a raw password field)', () => build({ ...pre, password: 'x' })],
        ['a nested object', () => build({ ...pre, email: { raw: 'x@y.z' } })],
        ['a long string', () => build({ ...pre, email: 'x'.repeat(200) })],
        ['an organisation scope through registeredJob', () => registeredJob(AUDIT_EVENT_QUEUE_NAME, 'audit-preauth-login-failed' as never, { kind: 'organisation', organisationId: ORG }, pre, { jobId: 'x' })],
        ['the org-scoped job name through registeredSystemScopedJob', () => registeredSystemScopedJob(AUDIT_EVENT_QUEUE_NAME, 'audit-event-ship', { organisationId: ORG, auditLogId: ROW }, { jobId: 'x' })],
      ])('ABUSE: %s is refused before Redis (QueueEnqueueRefusedError)', (_label, run) => {
        expect(run).toThrow(QueueEnqueueRefusedError);
      });

      it('the boot check refuses a system-scoped job that names organisationId or is not a job of the queue', () => {
        const clone = (): Record<string, QueueSettings> => JSON.parse(JSON.stringify(QUEUE_SETTINGS));
        const withOrg = clone();
        (withOrg[AUDIT_EVENT_QUEUE_NAME] as unknown as { systemScopedJobs: Record<string, string[]> }).systemScopedJobs = { 'audit-preauth-login-failed': ['v', 'organisationId'] };
        expect(() => assertQueueRegistryValid(withOrg)).toThrow(/never a tenant or user id \(organisationId\)/);
        for (const key of ['organisation_id', 'orgId', 'tenantId', 'userId']) {
          const bad = clone();
          (bad[AUDIT_EVENT_QUEUE_NAME] as unknown as { systemScopedJobs: Record<string, string[]> }).systemScopedJobs = { 'audit-preauth-login-failed': ['v', key] };
          expect(() => assertQueueRegistryValid(bad)).toThrow(`never a tenant or user id (${key})`);
        }
        const stray = clone();
        (stray[AUDIT_EVENT_QUEUE_NAME] as unknown as { systemScopedJobs: Record<string, string[]> }).systemScopedJobs = { 'not-a-job': ['v'] };
        expect(() => assertQueueRegistryValid(stray)).toThrow(/not a job of this consumer queue/);
      });
    });
  });

  describe('assertQueueRegistryValid (boot check)', () => {
    const clone = (): Record<string, QueueSettings> => JSON.parse(JSON.stringify(QUEUE_SETTINGS));

    it('accepts the real registry', () => {
      expect(() => assertQueueRegistryValid()).not.toThrow();
    });

    it.each<[string, (r: Record<string, QueueSettings>) => void]>([
      ['a zero concurrency', (r) => ((r['rab-email']!.worker as { concurrency: number }).concurrency = 0)],
      ['a negative maxStalledCount', (r) => ((r['rab-push']!.worker as { maxStalledCount: number }).maxStalledCount = -1)],
      ['a zero stalledInterval', (r) => ((r['rab-ai']!.worker as { stalledIntervalMs: number }).stalledIntervalMs = 0)],
      ['a fractional lockDuration', (r) => ((r['crewflow-scan-email']!.worker as { lockDurationMs: number }).lockDurationMs = 1.5)],
      ['a backoff with a single attempt', (r) => ((r['rab-shift-statements']!.job as { backoff: unknown }).backoff = { type: 'exponential', delayMs: 1000, jitter: 0 })],
      ['a job timeout', (r) => ((r['rab-email']!.job as { timeoutMs: unknown }).timeoutMs = 1000)],
      ['a missing scan queue', (r) => delete r['crewflow-scan-realtime']],
      ['a consumer queue without a tenant', (r) => ((r['rab-email'] as { tenantScope: string }).tenantScope = 'system')],
      ['a consumer payload without organisationId', (r) => ((r['rab-push'] as unknown as { payloadKeys: string[] }).payloadKeys = ['pushDeliveryId'])],
      ['a scan queue that is organisation-scoped', (r) => ((r['crewflow-scan-shifts'] as { tenantScope: string }).tenantScope = 'organisation')],
      ['a scan job declared on two queues', (r) => ((r['crewflow-scan-push'] as unknown as { jobNames: string[] }).jobNames = ['push-dispatch', 'email-dispatch'])],
      ['an unknown scan queue', (r) => (r['crewflow-scan-other'] = { ...r['crewflow-scan-email']! })],
      ['no job names', (r) => ((r['rab-ai'] as unknown as { jobNames: string[] }).jobNames = [])],
    ])('refuses %s', (_what, corrupt) => {
      const registry = clone();
      corrupt(registry);
      expect(() => assertQueueRegistryValid(registry)).toThrow(/queue registry is invalid/);
    });
  });

  it('completeness is a compile-time property (these lines must NOT type-check)', () => {
    // @ts-expect-error — a registry missing a queue does not satisfy the mapped type.
    const missingQueue: { readonly [N in QueueName]: QueueSettings } = { 'rab-email': QUEUE_SETTINGS['rab-email'] };
    // @ts-expect-error — Worker settings without stalledIntervalMs are incomplete.
    const missingOption: QueueWorkerSettings = { concurrency: 1, lockDurationMs: 30_000, maxStalledCount: 1 };
    // @ts-expect-error — job settings must record the (absent) timeout explicitly.
    const missingTimeout: QueueSettings['job'] = { attempts: 1, backoff: null, removeOnComplete: { age: 1, count: null }, removeOnFail: { age: 1, count: null } };
    expect([missingQueue, missingOption, missingTimeout]).toHaveLength(3);
  });
});
