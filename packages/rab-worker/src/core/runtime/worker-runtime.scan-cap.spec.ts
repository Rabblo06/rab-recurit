import Redis from 'ioredis';

import { CycleSlots, WORKER_SCAN_CONCURRENCY, WorkerRuntime } from './worker-runtime';

/** Phase B (P6): the scan-concurrency cap of the Worker jobs process. */
function fakeRedis(): Redis {
  const multi = () => {
    const chain = { hset: () => chain, hincrby: () => chain, expire: () => chain, exec: () => Promise.resolve([]) };
    return chain;
  };
  return { hset: () => Promise.resolve(0), multi } as unknown as Redis;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const loop = (name: string, run: () => Promise<boolean | void>) => ({
  name,
  intervalMs: 60_000,
  statKeys: { lastRunAt: `last-${name}`, failures: `${name}Failures`, skipped: `${name}Skipped` },
  run,
});

const flush = () => new Promise((r) => setImmediate(r));

describe('WorkerRuntime scan-concurrency cap (P6)', () => {
  it('defaults to 4 (owner-approved)', () => {
    expect(WORKER_SCAN_CONCURRENCY).toBe(4);
    const runtime = new WorkerRuntime(fakeRedis(), { metricsLogMs: 0 });
    expect(runtime.cycleSlots).toEqual({ limit: 4, running: 0, waiting: 0 });
    runtime.beginShutdown();
  });

  it('runs at most 4 cycles at once; the 5th and 6th wait FIFO and run as slots free, none dropped', async () => {
    const runtime = new WorkerRuntime(fakeRedis(), { metricsLogMs: 0 });
    const gates = Array.from({ length: 6 }, () => deferred());
    const started: number[] = [];
    let concurrent = 0;
    let peak = 0;
    const cycles = gates.map((gate, i) =>
      runtime.runOnce(
        loop(`scan-${i}`, async () => {
          started.push(i);
          concurrent += 1;
          peak = Math.max(peak, concurrent);
          await gate.promise;
          concurrent -= 1;
        }),
      ),
    );
    await flush();
    expect(started).toEqual([0, 1, 2, 3]);
    expect(runtime.cycleSlots).toEqual({ limit: 4, running: 4, waiting: 2 });
    gates[2].resolve();
    await flush();
    expect(started).toEqual([0, 1, 2, 3, 4]);
    gates.forEach((g) => g.resolve());
    const outcomes = await Promise.all(cycles);
    expect(outcomes).toEqual(Array(6).fill('succeeded'));
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(4);
    expect(runtime.cycleSlots).toEqual({ limit: 4, running: 0, waiting: 0 });
    runtime.beginShutdown();
  });

  it('a free slot still starts the cycle synchronously (no behaviour change below the cap)', () => {
    const runtime = new WorkerRuntime(fakeRedis(), { metricsLogMs: 0 });
    const run = jest.fn(async () => undefined);
    void runtime.runOnce(loop('sync', run));
    expect(run).toHaveBeenCalledTimes(1);
    runtime.beginShutdown();
  });

  it('a cycle still waiting for a slot when shutdown begins never runs (skipped-shutdown); drain completes', async () => {
    const runtime = new WorkerRuntime(fakeRedis(), { metricsLogMs: 0, maxConcurrentCycles: 1 });
    const gate = deferred();
    const second = jest.fn(async () => undefined);
    const first = runtime.runOnce(loop('first', () => gate.promise));
    const queued = runtime.runOnce(loop('second', second));
    await flush();
    runtime.beginShutdown();
    gate.resolve();
    await expect(first).resolves.toBe('succeeded');
    await expect(queued).resolves.toBe('skipped-shutdown');
    expect(second).not.toHaveBeenCalled();
    await expect(runtime.drain(1_000)).resolves.toEqual({ drained: true, pending: 0 });
  });

  it('a failing cycle releases its slot', async () => {
    const runtime = new WorkerRuntime(fakeRedis(), { metricsLogMs: 0, maxConcurrentCycles: 1 });
    (runtime as unknown as { logger: { error: () => void } }).logger.error = () => undefined;
    await expect(runtime.runOnce(loop('boom', async () => { throw new Error('x'); }))).resolves.toBe('failed');
    await expect(runtime.runOnce(loop('after', async () => undefined))).resolves.toBe('succeeded');
    runtime.beginShutdown();
  });

  it('CycleSlots rejects a non-positive limit', () => {
    expect(() => new CycleSlots(0)).toThrow();
  });
});
