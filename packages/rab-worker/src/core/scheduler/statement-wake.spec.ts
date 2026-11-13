import Redis from 'ioredis';

import { STATEMENT_WAKE_JOB_NAME, STATEMENT_WAKE_QUEUE } from '@rab/server/engine/core-modules/statement-wake/shift-statement-wake.service';
import { acceptsJobName, SCAN_JOB_DATA } from '@rab/server/engine/worker-shared/queue-registry';
import { WorkerRuntime } from '../runtime/worker-runtime';
import { createScanJobProcessor } from './bullmq-scheduler';
import { SCAN_JOBS, schedulerIdOf } from './scan-jobs';

/**
 * Phase X J1b, the consumer side of the statement dispatcher wake. The API adds a plain `shift-statement-dispatch` job (no
 * fixed id, payload `{ v: 1 }`) to `crewflow-scan-reports` after a payroll approval commits. Nothing new runs for it in the
 * Worker: the scan-queue processor maps the job NAME to the existing scan definition and runs the unchanged dispatcher
 * through the same runtime (no overlap with itself) and the same cross-replica scan lock as the scheduled tick. These
 * specs pin that, so the wake can never become a second, unguarded dispatch path.
 */
function fakeRedis(): Redis {
  const multi = () => {
    const chain = { hset: () => chain, hincrby: () => chain, expire: () => chain, exec: () => Promise.resolve([]) };
    return chain;
  };
  return { hset: () => Promise.resolve(0), multi } as unknown as Redis;
}
const def = SCAN_JOBS.find((d) => d.jobName === STATEMENT_WAKE_JOB_NAME)!;
const flush = () => new Promise((r) => setImmediate(r));

describe('J1b statement dispatcher wake: the Worker runs the existing scan, nothing else', () => {
  it('the wake names an existing scan job on the queue that scan lives on (the producer and the scan registry cannot drift)', () => {
    expect(def).toBeDefined();
    expect(def.queue).toBe(STATEMENT_WAKE_QUEUE);
    expect(acceptsJobName(STATEMENT_WAKE_QUEUE, STATEMENT_WAKE_JOB_NAME)).toBe(true);
    // Same metadata-only payload as the scheduler's template.
    expect(SCAN_JOB_DATA).toEqual({ v: 1 });
  });

  it('a wake job (BullMQ-minted id, no scheduler key) runs the SAME handler under the SAME scan lock id as the scheduled tick', async () => {
    const handler = jest.fn(async () => true);
    const lockIds: string[] = [];
    const runtime = new WorkerRuntime(fakeRedis(), { metricsLogMs: 0 });
    const processor = createScanJobProcessor({
      defs: new Map([[def.jobName, def]]),
      isEnabled: () => true,
      registry: { scan: (d) => (d === def ? handler : async () => undefined) },
      intervalOf: () => 30_000,
      runtime,
      lock: (id, work) => (lockIds.push(id), work().then((value) => ({ acquired: true as const, value }))),
      recordOutcome: () => undefined,
    });
    const scheduled = { id: 'repeat:crewflow:crewflow-scan-reports:shift-statement-dispatch:1', name: def.jobName, repeatJobKey: schedulerIdOf(def), data: { v: 1 } };
    const wake = { id: '42', name: STATEMENT_WAKE_JOB_NAME, data: { v: 1 } };
    await expect(processor(scheduled as never)).resolves.toEqual({ outcome: 'succeeded' });
    await expect(processor(wake as never)).resolves.toEqual({ outcome: 'succeeded' });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(lockIds).toEqual([schedulerIdOf(def), schedulerIdOf(def)]);
    runtime.beginShutdown();
  });

  it('a wake that arrives while the dispatcher is already running is skipped (never a second, overlapping sweep)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const handler = jest.fn(async () => {
      await gate;
      return true;
    });
    const runtime = new WorkerRuntime(fakeRedis(), { metricsLogMs: 0 });
    const outcomes: string[] = [];
    const processor = createScanJobProcessor({
      defs: new Map([[def.jobName, def]]),
      isEnabled: () => true,
      registry: { scan: () => handler },
      intervalOf: () => 30_000,
      runtime,
      lock: (_id, work) => work().then((value) => ({ acquired: true as const, value })),
      recordOutcome: (_d, o) => void outcomes.push(o),
    });
    const first = processor({ id: 'repeat:x:1', name: def.jobName } as never);
    await flush();
    await expect(processor({ id: '43', name: STATEMENT_WAKE_JOB_NAME } as never)).resolves.toEqual({ outcome: 'skipped-running' });
    release();
    await expect(first).resolves.toEqual({ outcome: 'succeeded' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual(['skipped-running', 'succeeded']);
    runtime.beginShutdown();
  });

  it('a wake whose scan lock is held by another replica is skipped-locked (the lock is the same one)', async () => {
    const handler = jest.fn(async () => true);
    const runtime = new WorkerRuntime(fakeRedis(), { metricsLogMs: 0 });
    const processor = createScanJobProcessor({
      defs: new Map([[def.jobName, def]]),
      isEnabled: () => true,
      registry: { scan: () => handler },
      intervalOf: () => 30_000,
      runtime,
      lock: async () => ({ acquired: false as const }),
      recordOutcome: () => undefined,
    });
    await expect(processor({ id: '44', name: STATEMENT_WAKE_JOB_NAME } as never)).resolves.toEqual({ outcome: 'skipped-locked' });
    expect(handler).not.toHaveBeenCalled();
    runtime.beginShutdown();
  });
});
