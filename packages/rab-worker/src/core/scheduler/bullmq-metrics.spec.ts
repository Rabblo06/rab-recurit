import { Logger } from '@nestjs/common';
import { MetricsTime } from 'bullmq';
import type Redis from 'ioredis';

import { WORKER_METRICS_MAX_DATA_POINTS } from '@rab/server/engine/worker-shared/queue-registry';

/**
 * Admin panel follow-up (owner-approved): every consumer Worker records BullMQ metrics for one week. The Worker class is
 * replaced by a recorder so this unit test never opens a Redis connection or consumes a real queue.
 */
const constructed: Array<{ name: string; opts: Record<string, unknown> }> = [];
jest.mock('bullmq', () => {
  const actual = jest.requireActual('bullmq');
  class RecordingWorker {
    constructor(name: string, _processor: unknown, opts: Record<string, unknown>) {
      constructed.push({ name, opts });
    }
    on(): this {
      return this;
    }
  }
  return { ...actual, Worker: RecordingWorker };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createConsumerWorkers, WORKER_METRICS } = require('./bullmq-scheduler') as typeof import('./bullmq-scheduler');

describe('BullMQ Worker metrics (admin panel Health chart source)', () => {
  it('keeps one week of one-minute points, the number the API buckets against', () => {
    expect(WORKER_METRICS).toEqual({ maxDataPoints: MetricsTime.ONE_WEEK });
    expect(MetricsTime.ONE_WEEK).toBe(10_080);
    expect(WORKER_METRICS_MAX_DATA_POINTS).toBe(MetricsTime.ONE_WEEK);
  });

  it('every consumer Worker (rab-email, rab-push, rab-shift-statements, rab-ai, D-Q4b crewflow-timer-triggers, X1.1 crewflow-audit-events) is created with the metrics option; concurrency unchanged', () => {
    constructed.length = 0;
    const registry = { get: () => ({ handler: async () => undefined }) } as unknown as Parameters<typeof createConsumerWorkers>[0];
    createConsumerWorkers(registry, {} as Redis, new Logger('test'));
    expect(constructed.map((c) => c.name).sort()).toEqual(['crewflow-audit-events', 'crewflow-timer-triggers', 'rab-ai', 'rab-email', 'rab-push', 'rab-shift-statements']);
    for (const c of constructed) expect(c.opts.metrics).toEqual({ maxDataPoints: 10_080 });
    expect(Object.fromEntries(constructed.map((c) => [c.name, c.opts.concurrency]))).toEqual({ 'rab-email': 5, 'rab-push': 10, 'rab-shift-statements': 2, 'rab-ai': 4, 'crewflow-timer-triggers': 2, 'crewflow-audit-events': 2 });
    // AI Phase 1: only rab-ai overrides the lock duration; the original three keep BullMQ's default (30 s). D-Q1: that
    // default is now passed EXPLICITLY (same effective value — BULLMQ_WORKER_DEFAULTS is pinned to the installed bullmq's
    // own defaults in queue-registry.spec.ts), as are maxStalledCount (1) and stalledInterval (30 s).
    expect(Object.fromEntries(constructed.map((c) => [c.name, c.opts.lockDuration]))).toEqual({ 'rab-email': 30_000, 'rab-push': 30_000, 'rab-shift-statements': 30_000, 'rab-ai': 60_000, 'crewflow-timer-triggers': 30_000, 'crewflow-audit-events': 30_000 });
    // D-Q4b: with WORKER_TIMER_TRIGGERS=off main.ts passes an enable predicate that skips the trigger consumer, and X1.1 with
    // CREWFLOW_AUDIT_SINK=none one that skips the audit-event consumer — exactly the four pre-D-Q4b Workers.
    constructed.length = 0;
    createConsumerWorkers(registry, {} as Redis, new Logger('test'), (def) => def.key !== 'timerTriggers' && def.key !== 'auditEvents');
    expect(constructed.map((c) => c.name).sort()).toEqual(['rab-ai', 'rab-email', 'rab-push', 'rab-shift-statements']);
    for (const c of constructed) expect([c.opts.maxStalledCount, c.opts.stalledInterval]).toEqual([1, 30_000]);
  });
});
