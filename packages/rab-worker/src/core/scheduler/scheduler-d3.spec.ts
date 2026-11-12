import { validate } from '@rab/server/engine/core-modules/environment/env.validation';
import { WorkerLoopOptions, WorkerRuntime } from '../runtime/worker-runtime';
import { createScanJobProcessor, firstRunDelayFromStamp, registerIntervalScans, SCAN_OUTCOMES_KEY } from './bullmq-scheduler';
import { isScanJobEnabled, resolveIntervalMs, SCAN_JOBS, ScanJobDefinition } from './scan-jobs';

/**
 * Phase D (D3, owner decision): scheduler fixes, `WORKER_SCHEDULER=interval` stays the default.
 *  1. bullmq: skipped / idle / disabled outcomes are recorded separately from "completed" (a per-scan outcome counter),
 *     without throwing (a throw would make BullMQ count them as FAILED instead — equally wrong).
 *  2. A disabled scan is not scheduled: the three in-cycle switches (login handoff cleanup, outbox retention, AI
 *     retention) become registration predicates too (the cycles keep their own check as defence in depth).
 *  3. The daily scans use firstRunAfterInterval, so an interval-mode start does not run them; interval mode times the
 *     first run from the persisted cluster stamp (lastRunAt), so frequent deploys can never starve a daily scan.
 */
const base = { DATABASE_URL: 'postgres://rab:rab@localhost:5432/rab', REDIS_URL: 'redis://localhost:6379', APP_SECRET: 'a'.repeat(32) };
const envOf = (overrides: Record<string, string> = {}) => {
  const validated = validate({ ...base, ...overrides }) as unknown as Record<string, unknown>;
  return { get: (k: string) => validated[k] as never };
};
const byJob = (jobName: string) => SCAN_JOBS.find((d) => d.jobName === jobName)!;

describe('D3.2 disabled scans are not scheduled', () => {
  it('the switch-gated scans: push, realtime, login handoff cleanup, outbox retention, AI retention', () => {
    expect(SCAN_JOBS.filter((d) => d.enabledBy).map((d) => [d.jobName, d.enabledBy])).toEqual([
      ['push-dispatch', 'PUSH_ENABLED'],
      ['login-handoff-cleanup', 'LOGIN_HANDOFF_CLEANUP_ENABLED'],
      ['realtime-outbox-publish', 'REALTIME_ENABLED'],
      ['outbox-retention', 'OUTBOX_RETENTION_ENABLED'],
      ['ai-retention', 'AI_RETENTION_MODE'],
      ['ai-stale-turn-sweep', 'AI_STALE_TURN_SWEEP'],
    ]);
  });

  it('defaults: push, realtime, outbox retention (OFF by default) and AI retention (off) are not scheduled; login handoff cleanup (ON by default) is', () => {
    const env = envOf();
    expect(SCAN_JOBS.filter((d) => !isScanJobEnabled(d, env)).map((d) => d.jobName)).toEqual(['push-dispatch', 'realtime-outbox-publish', 'outbox-retention', 'ai-retention', 'ai-stale-turn-sweep', 'shift-scan-combined']);
    const off = envOf({ LOGIN_HANDOFF_CLEANUP_ENABLED: 'false' });
    expect(isScanJobEnabled(byJob('login-handoff-cleanup'), off)).toBe(false);
  });

  it('enabled switches schedule them; AI retention runs in report or purge mode only; anything unexpected stays disabled (fail closed)', () => {
    const on = envOf({ OUTBOX_RETENTION_ENABLED: 'true', AI_RETENTION_MODE: 'report' });
    expect(isScanJobEnabled(byJob('outbox-retention'), on)).toBe(true);
    expect(isScanJobEnabled(byJob('ai-retention'), on)).toBe(true);
    expect(isScanJobEnabled(byJob('ai-retention'), { get: () => 'purge' as never })).toBe(true);
    for (const bad of ['off', 'OFF', '', undefined, true, 'report ']) {
      expect(isScanJobEnabled(byJob('ai-retention'), { get: () => bad as never })).toBe(false);
    }
    expect(isScanJobEnabled(byJob('outbox-retention'), { get: () => 'true' as never })).toBe(false);
  });
});

describe('D3.3 daily scans: firstRunAfterInterval', () => {
  it('exactly the three daily housekeeping scans opt in (token cleanup, storage cleanup, provisioning health)', () => {
    expect(SCAN_JOBS.filter((d) => d.firstRunAfterInterval).map((d) => d.jobName)).toEqual(['token-cleanup', 'storage-cleanup', 'workspace-provisioning-health']);
  });

  it('first-run delay from the persisted stamp: due time left, clamped to [0, interval]; no/invalid stamp → one interval', () => {
    const day = 86_400_000;
    const now = 10 * day;
    expect(firstRunDelayFromStamp(String(now - 3_600_000), day, now)).toBe(day - 3_600_000);
    expect(firstRunDelayFromStamp(String(now - 2 * day), day, now)).toBe(0); // overdue → runs at start
    expect(firstRunDelayFromStamp(String(now + 60_000), day, now)).toBe(day); // a stamp in the future is not trusted
    expect(firstRunDelayFromStamp(undefined, day, now)).toBe(day);
    expect(firstRunDelayFromStamp('garbage', day, now)).toBe(day);
  });

  it('interval-mode registration hands every opted-in scan its first-run delay; the others start immediately as before', () => {
    const env = envOf();
    const calls: WorkerLoopOptions[] = [];
    const runtime = { every: (o: WorkerLoopOptions) => void calls.push(o) };
    const registry = { scan: (def: ScanJobDefinition) => async () => def.jobName !== '' };
    registerIntervalScans(runtime, registry, SCAN_JOBS, (d) => resolveIntervalMs(d, env), (d) => isScanJobEnabled(d, env), (d) =>
      d.jobName === 'token-cleanup' ? 5_000 : undefined,
    );
    const token = calls.find((c) => c.metricKey === 'token-cleanup')!;
    expect(token).toMatchObject({ firstRunAfterInterval: true, firstRunDelayMs: 5_000 });
    expect(calls.find((c) => c.metricKey === 'storage-cleanup')).toMatchObject({ firstRunAfterInterval: true });
    expect(calls.find((c) => c.metricKey === 'storage-cleanup')!.firstRunDelayMs).toBeUndefined();
    expect(calls.find((c) => c.metricKey === 'email-dispatch')!.firstRunAfterInterval).toBeUndefined();
  });

  describe('WorkerRuntime.every firstRunDelayMs', () => {
    const chain: Record<string, unknown> = {};
    for (const op of ['hset', 'hincrby', 'expire']) chain[op] = () => chain;
    chain.exec = async () => [];
    const redis = { hset: async () => 1, multi: () => chain } as never;
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('first run after the given delay, then every interval; shutdown cancels a pending first run', async () => {
      const runtime = new WorkerRuntime(redis, { metricsLogMs: 0 });
      const run = jest.fn().mockResolvedValue(true);
      runtime.every({ name: 'daily', intervalMs: 10_000, statKeys: { lastRunAt: 'x', failures: 'xFailures' }, run, firstRunAfterInterval: true, firstRunDelayMs: 3_000 });
      await jest.advanceTimersByTimeAsync(2_999);
      expect(run).toHaveBeenCalledTimes(0);
      await jest.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(10_000);
      expect(run).toHaveBeenCalledTimes(2);
      runtime.beginShutdown();

      const second = new WorkerRuntime(redis, { metricsLogMs: 0 });
      const never = jest.fn().mockResolvedValue(true);
      second.every({ name: 'daily2', intervalMs: 10_000, statKeys: { lastRunAt: 'y', failures: 'yFailures' }, run: never, firstRunAfterInterval: true, firstRunDelayMs: 3_000 });
      second.beginShutdown();
      await jest.advanceTimersByTimeAsync(20_000);
      expect(never).not.toHaveBeenCalled();
    });

    it('a zero delay runs at once (an overdue daily scan is not postponed by a restart)', async () => {
      const runtime = new WorkerRuntime(redis, { metricsLogMs: 0 });
      const run = jest.fn().mockResolvedValue(true);
      runtime.every({ name: 'overdue', intervalMs: 10_000, statKeys: { lastRunAt: 'z', failures: 'zFailures' }, run, firstRunAfterInterval: true, firstRunDelayMs: 0 });
      await jest.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledTimes(1);
      runtime.beginShutdown();
    });
  });
});

describe('D3.1 bullmq: outcomes recorded separately from "completed", never thrown', () => {
  function setup(outcome: string, enabled = true) {
    const def = byJob('login-handoff-cleanup');
    const recorded: Array<[string, string]> = [];
    const runtime = { runOnce: jest.fn(async () => outcome) };
    const processor = createScanJobProcessor({
      defs: new Map([[def.jobName, def]]),
      isEnabled: () => enabled,
      registry: { scan: () => async () => undefined },
      intervalOf: () => 60_000,
      runtime: runtime as never,
      lock: (_id, work) => work().then((value) => ({ acquired: true as const, value })),
      recordOutcome: (d, o) => void recorded.push([d.jobName, o]),
    });
    return { processor, recorded, runtime, def };
  }

  it.each(['succeeded', 'idle', 'skipped-locked', 'skipped-running', 'skipped-shutdown'])('outcome %s: returned AND recorded per scan, not thrown', async (outcome) => {
    const { processor, recorded } = setup(outcome);
    await expect(processor({ name: 'login-handoff-cleanup' } as never)).resolves.toEqual({ outcome });
    expect(recorded).toEqual([['login-handoff-cleanup', outcome]]);
  });

  it('disabled: acknowledged without running the cycle, recorded as disabled', async () => {
    const { processor, recorded, runtime } = setup('succeeded', false);
    await expect(processor({ name: 'login-handoff-cleanup' } as never)).resolves.toEqual({ outcome: 'disabled' });
    expect(runtime.runOnce).not.toHaveBeenCalled();
    expect(recorded).toEqual([['login-handoff-cleanup', 'disabled']]);
  });

  it('failed: recorded AND thrown (BullMQ failed metric, unchanged); unknown job: refused', async () => {
    const { processor, recorded } = setup('failed');
    await expect(processor({ name: 'login-handoff-cleanup' } as never)).rejects.toThrow(/cycle failed/);
    expect(recorded).toEqual([['login-handoff-cleanup', 'failed']]);
    await expect(processor({ name: 'nope' } as never)).rejects.toThrow(/unknown scan job/);
  });

  it('the outcome counter key is a Worker-owned Redis hash (field <jobName>:<outcome>)', () => {
    expect(SCAN_OUTCOMES_KEY).toBe('rab:worker:scan-outcomes');
  });
});
