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
const PRE_DQ1_WORKER_OPTIONS: Record<QueueName, { concurrency: number; lockDuration: number; maxStalledCount: number; stalledInterval: number }> = {
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
};
const OUTBOX = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000, jitter: 0.5 },
  removeOnComplete: { age: 7 * DAY },
  removeOnFail: { age: 30 * DAY },
};
const SCAN = { attempts: 1, removeOnComplete: { age: 3600, count: 1000 }, removeOnFail: { age: 604_800 } };
const PRE_DQ1_JOB_OPTIONS: Record<QueueName, object> = {
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
  it('lists exactly the eleven BullMQ queues Crewflow uses (names unchanged)', () => {
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
      ].sort(),
    );
    expect(Object.values(CONSUMER_QUEUES).map((q) => [q.name, q.jobName, q.prefix])).toEqual([
      ['rab-email', 'send-email', 'bull'],
      ['rab-push', 'send-push', 'bull'],
      ['rab-shift-statements', 'generate-shift-statement', 'bull'],
      ['rab-ai', 'ai-turn', 'bull'],
    ]);
  });

  it.each(Object.keys(EXPECTED_WORKER_OPTIONS) as QueueName[])('%s: Worker options are explicit and equal the pre-D-Q1 effective values (plus the D-Q2 maintenance slot)', (name) => {
    expect(bullmqWorkerOptionsOf(name)).toEqual(EXPECTED_WORKER_OPTIONS[name]);
  });

  it('Phase D-Q2: the only Worker-option change is one more crewflow-scan-maintenance slot for ai-stale-turn-sweep', () => {
    const changed = QUEUE_NAMES.filter((n) => JSON.stringify(bullmqWorkerOptionsOf(n)) !== JSON.stringify(PRE_DQ1_WORKER_OPTIONS[n]));
    expect(changed).toEqual(['crewflow-scan-maintenance']);
    expect(bullmqWorkerOptionsOf('crewflow-scan-maintenance').concurrency - PRE_DQ1_WORKER_OPTIONS['crewflow-scan-maintenance'].concurrency).toBe(1);
    expect(acceptsJobName('crewflow-scan-maintenance', 'ai-stale-turn-sweep')).toBe(true);
    // A system scan, not a consumer: the sweep never enqueues or accepts an organisation-scoped job.
    expect(QUEUE_SETTINGS['crewflow-scan-maintenance'].tenantScope).toBe('system');
    expect(acceptsJobName('rab-ai', 'ai-stale-turn-sweep')).toBe(false);
  });

  it.each(Object.keys(PRE_DQ1_JOB_OPTIONS) as QueueName[])('%s: job options (attempts, backoff, retention) equal the pre-D-Q1 producer options', (name) => {
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
      ...Object.fromEntries(SCAN_QUEUE_NAMES.map((n) => [n, ['system', ['v']]])),
    });
  });

  it('rolling deploy: the consumers accept every job name any producer (old or new) publishes, and nothing else', () => {
    expect(QUEUE_NAMES.filter((n) => QUEUE_SETTINGS[n].kind === 'consumer').map((n) => [n, [...QUEUE_SETTINGS[n].jobNames]])).toEqual([
      ['rab-email', ['send-email']],
      ['rab-push', ['send-push']],
      ['rab-shift-statements', ['generate-shift-statement']],
      ['rab-ai', ['ai-turn', 'ai-title']],
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
