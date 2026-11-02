import { DispatchQueueRunner } from './dispatch-runner';

/** Phase D (D2): per-queue non-overlap + coalescing — never two claim loops for one queue in one process. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('DispatchQueueRunner', () => {
  it('runs immediately when idle and passes the reason', async () => {
    const work = jest.fn(async (reasons: ReadonlySet<string>) => [...reasons].join(','));
    const runner = new DispatchQueueRunner(work);
    await expect(runner.run('tick')).resolves.toBe('tick');
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('never overlaps: calls during a run coalesce into ONE follow-up run carrying every reason', async () => {
    let active = 0;
    let maxActive = 0;
    const gates = [deferred(), deferred()];
    const seen: string[][] = [];
    const runner = new DispatchQueueRunner(async (reasons) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      seen.push([...reasons].sort());
      await gates[seen.length - 1]!.promise;
      active -= 1;
      return seen.length;
    });
    const first = runner.run('tick');
    const second = runner.run('wake');
    const third = runner.run('wake');
    const fourth = runner.run('catch-up');
    expect(second).toBe(third); // the same queued follow-up
    expect(third).toBe(fourth);
    gates[0]!.resolve();
    await expect(first).resolves.toBe(1);
    gates[1]!.resolve();
    await expect(second).resolves.toBe(2);
    expect(seen).toEqual([['tick'], ['catch-up', 'wake']]);
    expect(maxActive).toBe(1);
  });

  it('a call made in the gap after a run settles, before its queued follow-up starts, joins that follow-up (no second loop)', async () => {
    let active = 0;
    let maxActive = 0;
    const gates = [deferred(), deferred(), deferred()];
    const seen: string[][] = [];
    const runner = new DispatchQueueRunner(async (reasons) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      seen.push([...reasons].sort());
      await gates[seen.length - 1]!.promise;
      active -= 1;
    });
    const first = runner.run('a');
    // Registered on the running promise BEFORE the follow-up is queued, so it runs in the gap: `active` already cleared,
    // the queued follow-up not started yet (a tick() caller re-entering from the continuation of an earlier tick()).
    const reentered = first.then(() => runner.run('c'));
    const followUp = runner.run('b');
    gates[0]!.resolve();
    await first;
    await new Promise((r) => setImmediate(r));
    expect(maxActive).toBe(1);
    expect(seen).toEqual([['a'], ['b', 'c']]);
    gates[1]!.resolve();
    await Promise.all([followUp, reentered]);
    expect(seen).toHaveLength(2);
    expect(maxActive).toBe(1);
  });

  it('a failed run does not block the next one, and the failure reaches only its own callers', async () => {
    let calls = 0;
    const runner = new DispatchQueueRunner(async () => {
      calls += 1;
      if (calls === 1) throw new Error('db down');
      return 'ok';
    });
    const first = runner.run('tick');
    const second = runner.run('wake');
    await expect(first).rejects.toThrow('db down');
    await expect(second).resolves.toBe('ok');
  });

  it('after stop() no new run starts; idle() waits for the one in flight', async () => {
    const gate = deferred();
    const work = jest.fn(async () => gate.promise.then(() => 'done'));
    const runner = new DispatchQueueRunner(work);
    const first = runner.run('tick');
    runner.stop();
    await expect(runner.run('wake')).resolves.toBeUndefined();
    let idle = false;
    const waiting = runner.idle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    gate.resolve();
    await first;
    await waiting;
    expect(idle).toBe(true);
    expect(work).toHaveBeenCalledTimes(1);
  });
});
