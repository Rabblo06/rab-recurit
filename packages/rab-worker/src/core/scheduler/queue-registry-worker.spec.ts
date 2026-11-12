import { UnrecoverableError } from 'bullmq';

import { QUEUE_SETTINGS } from '@rab/server/engine/worker-shared/queue-registry';
import { shiftStatementJob } from '../../queues/rab-reports/shift-statement-enqueue';
import { shiftStatementJobOptions } from '../../queues/rab-reports/shift-statement.job';
import { assertScanQueueSettings, createConsumerJobProcessor } from './bullmq-scheduler';
import { CONSUMER_QUEUES, SCAN_QUEUE_NAMES } from './queue-registry';
import { lockDurationMsFor, SCAN_JOBS, ScanJobDefinition, scanJobsOn } from './scan-jobs';

/**
 * Phase D-Q1, worker side of the queue registry:
 *  1. Unknown JOB NAME on an existing consumer queue. Finding (pre-D-Q1, bullmq-scheduler.ts createConsumerWorkers): the
 *     Worker's processor was `(job) => handler(job)` — EVERY job on rab-email / rab-push / rab-shift-statements reached
 *     the one handler whatever its name (a `foo` job carrying a real outbox id would have SENT the email), and rab-ai
 *     completed an unknown name as `skipped` without a warning. Now: failed closed (UnrecoverableError → BullMQ's failed
 *     set, no retry), a warning, and the handler is never called. These tests fail on the old code (no guard existed).
 *  2. The registry's explicit scan-queue settings equal what bullmq mode derived before (scanJobsOn / lockDurationMsFor),
 *     and drift refuses to start.
 *  3. The shift-statement builder (both claim modes) produces exactly the pre-D-Q1 add() arguments.
 */
const ORG = '00000000-0000-4000-8000-00000000000a';
const WS = '00000000-0000-4000-8000-0000000000a1';
const P1 = '00000000-0000-4000-8000-000000000001';

describe('consumer unknown job name (D-Q1)', () => {
  const ACCEPTED: Record<string, string[]> = {
    'rab-email': ['send-email'],
    'rab-push': ['send-push'],
    'rab-shift-statements': ['generate-shift-statement'],
    'rab-ai': ['ai-turn', 'ai-title'],
    // Phase D-Q4b: the four timer-trigger job names (one handler dispatches on job.name).
    'crewflow-timer-triggers': ['offer-expiry-trigger', 'manager-confirmation-trigger', 'no-show-trigger', 'late-clock-in-trigger'],
    // Phase X Part 2, X1.1: the one audit-event job name.
    'crewflow-audit-events': ['audit-event-ship', 'audit-preauth-login-failed'],
  };

  it.each(Object.values(CONSUMER_QUEUES).map((d) => [d.name, d] as const))('%s: an unregistered job name is failed closed, never handled', async (_name, def) => {
    const handler = jest.fn(async () => 'handled');
    const logger = { warn: jest.fn() };
    const process = createConsumerJobProcessor(def, handler, logger);
    for (const name of ['foo', 'send-email-v2', 'ai-agent' + '-run', 'generate-shift-statement '].filter((n) => !ACCEPTED[def.name]!.includes(n))) {
      const error = await process({ id: 'j1', name }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnrecoverableError); // BullMQ: straight to failed, whatever attempts remain
      expect((error as Error).message).toBe(`unknown job name for ${def.name}`); // names the queue only, never data
    }
    expect(handler).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
    expect(String(logger.warn.mock.calls[0]![0])).toContain('failed closed');
  });

  it.each(Object.values(CONSUMER_QUEUES).map((d) => [d.name, d] as const))('%s: every registered job name reaches the handler unchanged', async (_name, def) => {
    const handler = jest.fn(async (job: unknown) => job);
    const process = createConsumerJobProcessor(def, handler, { warn: jest.fn() });
    for (const name of ACCEPTED[def.name]!) {
      const job = { id: 'j', name, data: { organisationId: ORG } };
      await expect(process(job)).resolves.toBe(job);
    }
    expect(handler).toHaveBeenCalledTimes(ACCEPTED[def.name]!.length);
    expect([...QUEUE_SETTINGS[def.name].jobNames]).toEqual(ACCEPTED[def.name]);
  });
});

describe('scan queue settings (D-Q1)', () => {
  it('registry concurrency / lockDuration / job names equal what bullmq mode derived before (scanJobsOn, lockDurationMsFor)', () => {
    for (const q of SCAN_QUEUE_NAMES) {
      expect(QUEUE_SETTINGS[q].worker.concurrency).toBe(scanJobsOn(q).length);
      expect(QUEUE_SETTINGS[q].worker.lockDurationMs).toBe(lockDurationMsFor(q));
      expect([...QUEUE_SETTINGS[q].jobNames].sort()).toEqual(scanJobsOn(q).map((d) => d.jobName).sort());
    }
    expect(() => assertScanQueueSettings()).not.toThrow();
  });

  it('a scan added to SCAN_JOBS without its registry entry refuses to start (fail closed)', () => {
    const extra: ScanJobDefinition = { ...SCAN_JOBS[0]!, jobName: 'new-scan' };
    expect(() => assertScanQueueSettings([...SCAN_JOBS, extra])).toThrow(/drifted/);
    expect(() => assertScanQueueSettings(SCAN_JOBS.slice(1))).toThrow(/drifted/);
  });
});

describe('shift-statement job builder (D-Q1)', () => {
  it('builds exactly the pre-D-Q1 add() arguments (name, ids-only payload, jobId format, attempts 1, 7 d / 30 d)', () => {
    const data = { payrollRecordId: P1, organisationId: ORG, workspaceId: WS, generation: 4 };
    const job = shiftStatementJob(data);
    expect([job.name, job.data, job.opts]).toEqual([...shiftStatementJobOptions(data)]);
    expect(job.opts.jobId).toBe(`shift-statement.${P1}.gen.4`);
  });

  it('refuses a statement whose organisation is not a UUID (fail closed, nothing built)', () => {
    expect(() => shiftStatementJob({ payrollRecordId: P1, organisationId: 'o', workspaceId: WS, generation: 1 })).toThrow(/UUID/);
  });
});
