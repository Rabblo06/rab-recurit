import { DispatchCoordinator, DispatchQueueBinding } from './dispatch-coordinator';

/**
 * Phase D (D1/D2) — the per-process dispatch coordinator: scan ticks (poll / backstop), the slow legacy reconciliation
 * sweep, debounced wake-ups, claim-until-short bounded per run, and never two claim loops for one queue at once.
 *
 * The claimer below is an in-memory model of the contract's claim function (due pointers only; a claimed pointer is
 * leased — not due again until the lease passes; SKIP LOCKED semantics: two concurrent callers never get the same
 * pointer). The real function is Agent A's SQL and is not executed here (SQL gate).
 */
const ORG = '00000000-0000-4000-8000-00000000000a';
const WS = '00000000-0000-4000-8000-0000000000a1';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

class FakePointerStore {
  now = 1_000_000;
  claimCalls = 0;
  inFlightClaims = 0;
  maxInFlightClaims = 0;
  private readonly pointers = new Map<string, { org: string; ws: string | null; dueAt: number; token: string | null; count: number }>();
  private seq = 0;

  /** `perOrg`: the server's per-organisation cap per claim call (10 for email/push/statement, 25 realtime). */
  constructor(private readonly leaseMs: number, private readonly perOrg = Number.POSITIVE_INFINITY) {}

  add(n: number, ws: string | null = WS): void {
    this.pointers.set(id(n), { org: ORG, ws, dueAt: this.now, token: null, count: 0 });
  }

  /** The trigger deleting the pointer once the subject is terminal (the Worker never deletes). */
  remove(subject: string): void {
    this.pointers.delete(subject);
  }

  query = async (sql: string, params: unknown[] = []): Promise<unknown[]> => {
    if (sql.includes('worker_release_dispatch_claim')) {
      const p = this.pointers.get(params[1] as string);
      if (!p || p.token !== params[2]) return [{ released: false }];
      p.token = null;
      p.dueAt = this.now + Number(params[3]) * 1000;
      return [{ released: true }];
    }
    this.claimCalls += 1;
    this.inFlightClaims += 1;
    this.maxInFlightClaims = Math.max(this.maxInFlightClaims, this.inFlightClaims);
    await Promise.resolve(); // a real round trip yields
    try {
      const limit = Number(params[0]);
      const perOrgCount = new Map<string, number>();
      const due = [...this.pointers.entries()]
        .filter(([, p]) => p.dueAt <= this.now)
        .filter(([, p]) => {
          const n = perOrgCount.get(p.org) ?? 0;
          if (n >= this.perOrg) return false;
          perOrgCount.set(p.org, n + 1);
          return true;
        })
        .slice(0, limit);
      const token = `10000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`;
      return due.map(([subject, p]) => {
        p.dueAt = this.now + this.leaseMs;
        p.token = token;
        p.count += 1;
        return { subject_id: subject, organisation_id: p.org, workspace_id: p.ws, claim_token: token, claim_count: p.count };
      });
    } finally {
      this.inFlightClaims -= 1;
    }
  };
}

const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

function binding(queue: DispatchQueueBinding['queue'], store: FakePointerStore, processed: string[], legacy = jest.fn(async () => false)): DispatchQueueBinding {
  return {
    queue,
    legacy,
    processScope: async (scope) => {
      // The existing per-scope SQL restricted to the ids: a processed subject reaches a state its trigger handles — here the
      // terminal case (pointer deleted).
      for (const subject of scope.subjectIds) {
        processed.push(subject);
        store.remove(subject);
      }
      return scope.subjectIds.length;
    },
  };
}

function manualTimers() {
  let seq = 0;
  const pending = new Map<number, () => void>();
  return {
    setTimeout: ((fn: () => void) => {
      const handle = ++seq;
      pending.set(handle, fn);
      return handle as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout,
    clearTimeout: ((handle: number) => pending.delete(handle)) as unknown as typeof clearTimeout,
    flush: async () => {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, fn] of due) fn();
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    },
    get size() {
      return pending.size;
    },
  };
}

const settle = async () => {
  await new Promise((r) => setTimeout(r, 10)); // let the (real, 0 ms) debounce timers fire
  for (let i = 0; i < 50; i += 1) await new Promise((r) => setImmediate(r));
};

describe('DispatchCoordinator', () => {
  it('a tick runs the legacy per-scope sweep first (reconciliation), then the global claim; the sweep repeats only every reconcileMs', async () => {
    const store = new FakePointerStore(30_000);
    const processed: string[] = [];
    const legacy = jest.fn(async () => true);
    let now = 0;
    const coordinator = new DispatchCoordinator([binding('email', store, processed, legacy)], {
      claimer: store, batch: 100, reconcileMs: 900_000, logger, now: () => now,
    });
    store.add(1);
    await expect(coordinator.tick('email')).resolves.toBe(true);
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(processed).toEqual([id(1)]);

    now = 899_000;
    await coordinator.tick('email');
    expect(legacy).toHaveBeenCalledTimes(1); // not due yet
    now = 900_000;
    await coordinator.tick('email');
    expect(legacy).toHaveBeenCalledTimes(2);
  });

  it('a tick with nothing claimed and an idle sweep returns false (not stamped as a run)', async () => {
    const store = new FakePointerStore(30_000);
    const coordinator = new DispatchCoordinator([binding('email', store, [])], { claimer: store, batch: 100, reconcileMs: 900_000, logger, now: () => 0 });
    await expect(coordinator.tick('email')).resolves.toBe(false);
  });

  it('a run is bounded by maxBatchesPerRun; hitting the bound with rows still coming schedules a prompt follow-up run (no tick needed)', async () => {
    const store = new FakePointerStore(30_000);
    const processed: string[] = [];
    for (let n = 1; n <= 25; n += 1) store.add(n);
    const coordinator = new DispatchCoordinator([binding('realtime', store, processed)], {
      claimer: store, batch: 5, maxBatchesPerRun: 3, reconcileMs: 900_000, logger, now: () => 0, debounceMs: 0,
    });
    await coordinator.tick('realtime');
    expect(processed).toHaveLength(15); // 3 batches, then the per-run bound
    await settle(); // the follow-up run(s) — no second tick
    expect(processed).toHaveLength(25);
    expect(store.maxInFlightClaims).toBe(1); // never two claim loops for one queue
  });

  it('duplicate wake-ups (and a concurrent tick) never create duplicate per-scope claims and never overlap claim loops', async () => {
    const store = new FakePointerStore(15_000);
    const processed: string[] = [];
    for (let n = 1; n <= 7; n += 1) store.add(n);
    const timers = manualTimers();
    const coordinator = new DispatchCoordinator([binding('realtime', store, processed)], {
      claimer: store, batch: 3, reconcileMs: 900_000, logger, now: () => 0, debounceMs: 200,
      setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    });
    for (let i = 0; i < 10; i += 1) coordinator.wake('realtime');
    expect(timers.size).toBe(1); // debounced into one pending wake
    const tick = coordinator.tick('realtime');
    await timers.flush();
    for (let i = 0; i < 10; i += 1) coordinator.wake('realtime');
    await timers.flush();
    await tick;
    await coordinator.idle();
    expect(store.maxInFlightClaims).toBe(1);
    expect([...processed].sort()).toEqual([1, 2, 3, 4, 5, 6, 7].map(id));
    expect(new Set(processed).size).toBe(processed.length); // each subject handed to its scope exactly once
  });

  it('two Worker processes woken by the same NOTIFY share the due pointers without a duplicate (server SKIP LOCKED + lease)', async () => {
    const store = new FakePointerStore(30_000);
    const processed: string[] = [];
    for (let n = 1; n <= 10; n += 1) store.add(n);
    const a = new DispatchCoordinator([binding('email', store, processed)], { claimer: store, batch: 4, reconcileMs: 900_000, logger, now: () => 0, debounceMs: 0 });
    const b = new DispatchCoordinator([binding('email', store, processed)], { claimer: store, batch: 4, reconcileMs: 900_000, logger, now: () => 0, debounceMs: 0 });
    a.wake('email');
    b.wake('email');
    await settle();
    await Promise.all([a.idle(), b.idle()]);
    expect([...processed].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(id));
    expect(new Set(processed).size).toBe(10);
  });

  it('a wake for a queue that is not enabled in this process (e.g. push with PUSH_ENABLED=false) is ignored', async () => {
    const store = new FakePointerStore(30_000);
    store.add(1);
    const coordinator = new DispatchCoordinator([binding('email', store, [])], { claimer: store, batch: 10, reconcileMs: 900_000, logger, now: () => 0, debounceMs: 0 });
    coordinator.wake('push');
    await settle();
    expect(store.claimCalls).toBe(0);
    expect(coordinator.queues).toEqual(['email']);
  });

  it('wakeAll (listener connected / reconnected) runs one catch-up run per enabled queue', async () => {
    const store = new FakePointerStore(30_000);
    const processed: string[] = [];
    store.add(1);
    const coordinator = new DispatchCoordinator([binding('email', store, processed), binding('statement', store, processed)], {
      claimer: store, batch: 10, reconcileMs: 900_000, logger, now: () => 0, debounceMs: 0,
    });
    coordinator.wakeAll();
    await settle();
    await coordinator.idle();
    // One run per queue. Wave 5 (F-W4-1): a run that claimed rows ends with one more (empty) claim — 2 + 1 = 3 calls.
    expect(store.claimCalls).toBe(3);
    expect(processed).toEqual([id(1)]);
  });

  it('wake-driven runs go through the injected executor (main.ts: the runtime scan slot, stats and shutdown drain)', async () => {
    const store = new FakePointerStore(30_000);
    store.add(1);
    const executeWake = jest.fn(async (_queue: string, run: () => Promise<boolean>) => run());
    const coordinator = new DispatchCoordinator([binding('email', store, [])], { claimer: store, batch: 10, reconcileMs: 900_000, logger, now: () => 0, debounceMs: 0, executeWake });
    coordinator.wake('email');
    await settle();
    expect(executeWake).toHaveBeenCalledWith('email', expect.any(Function));
  });

  it('a failed legacy sweep does not stop the global claim; the tick still fails (counted) and the sweep retries after a minute, not every tick', async () => {
    const store = new FakePointerStore(30_000);
    const processed: string[] = [];
    store.add(1);
    let now = 0;
    const legacy = jest.fn(async () => {
      throw new Error('sweep failed');
    });
    const coordinator = new DispatchCoordinator([binding('email', store, processed, legacy)], { claimer: store, batch: 10, reconcileMs: 900_000, logger, now: () => now });
    await expect(coordinator.tick('email')).rejects.toThrow('sweep failed');
    expect(processed).toEqual([id(1)]);
    now = 30_000;
    await expect(coordinator.tick('email')).resolves.toBe(false);
    expect(legacy).toHaveBeenCalledTimes(1);
    now = 60_000;
    await expect(coordinator.tick('email')).rejects.toThrow('sweep failed');
    expect(legacy).toHaveBeenCalledTimes(2);
  });

  it('after stop() pending wake-ups are dropped and no new run starts', async () => {
    const store = new FakePointerStore(30_000);
    store.add(1);
    const timers = manualTimers();
    const coordinator = new DispatchCoordinator([binding('email', store, [])], {
      claimer: store, batch: 10, reconcileMs: 900_000, logger, now: () => 0, debounceMs: 200, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    });
    coordinator.wake('email');
    coordinator.stop();
    await timers.flush();
    await expect(coordinator.tick('email')).resolves.toBe(false);
    expect(store.claimCalls).toBe(0);
  });

  it('OD-1: a claim with claim_count > 20 produces the throttled alert, and every run reports repeated / > 20 claim counts', async () => {
    const store = new FakePointerStore(0); // lease 0: an unprocessed pointer is due again at once (never completed)
    store.add(1);
    const warn = jest.fn();
    const stats: Array<[string, { claimed: number; repeatedClaims: number; highClaimCount: number }]> = [];
    const timers = manualTimers(); // follow-up runs (bound reached) never fire here: exactly one run per tick
    const coordinator = new DispatchCoordinator(
      [{ queue: 'email', legacy: async () => false, processScope: async () => 0 }], // never completes → claimed again and again
      { claimer: store, batch: 10, maxBatchesPerRun: 1, reconcileMs: 900_000, logger: { log: jest.fn(), warn }, now: () => 0,
        onRunStats: (queue, s) => stats.push([queue, s]), setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
    );
    for (let i = 0; i < 22; i += 1) await coordinator.tick('email');
    const alerts = warn.mock.calls.map((c) => c[0] as string).filter((m) => m.startsWith('dispatch claim-count alert'));
    expect(alerts).toEqual([`dispatch claim-count alert: queue=email subject=${id(1)} organisation=${ORG} claimCount=21 (> 20)`]);
    expect(stats).toHaveLength(22);
    expect(stats[0]).toEqual(['email', { claimed: 1, repeatedClaims: 0, highClaimCount: 0 }]);
    expect(stats[1]).toEqual(['email', { claimed: 1, repeatedClaims: 1, highClaimCount: 0 }]);
    expect(stats[21]).toEqual(['email', { claimed: 1, repeatedClaims: 1, highClaimCount: 1 }]);
  });

  /**
   * Phase D wave 2 — first-cutover evaluation (§9): the pointer table starts EMPTY, so work written before the triggers
   * existed has no pointer until its next state change; only the legacy per-scope sweep finds it. These pin WHEN that sweep
   * first runs after the Worker starts (characterisation of the existing behaviour — see B-report d2 §4).
   */
  it('first cutover: the FIRST tick after start runs the legacy sweep (no 900 s wait), even when a wake-up ran before it', async () => {
    const store = new FakePointerStore(30_000);
    const legacy = jest.fn(async () => true);
    const coordinator = new DispatchCoordinator([binding('statement', store, [], legacy)], {
      claimer: store, batch: 10, reconcileMs: 900_000, logger, now: () => 5, debounceMs: 0,
    });
    coordinator.wakeAll(); // event mode: the listener connected first → catch-up claim only
    await settle();
    expect(legacy).not.toHaveBeenCalled(); // a wake-up never sweeps
    await coordinator.tick('statement');
    expect(legacy).toHaveBeenCalledTimes(1); // the first tick sweeps at once
  });

  it('first cutover: a tick that arrives while a wake-up run is in flight still sweeps (its reason survives coalescing)', async () => {
    const store = new FakePointerStore(30_000);
    store.add(1);
    const legacy = jest.fn(async () => false);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const processed: string[] = [];
    const coordinator = new DispatchCoordinator(
      [{ queue: 'email', legacy, processScope: async (scope) => { await gate; processed.push(...scope.subjectIds); store.remove(id(1)); return scope.subjectIds.length; } }],
      { claimer: store, batch: 10, reconcileMs: 900_000, logger, now: () => 5, debounceMs: 0 },
    );
    coordinator.wake('email');
    await settle(); // the wake run is now blocked inside processScope
    const tick = coordinator.tick('email');
    release();
    await tick;
    expect(legacy).toHaveBeenCalledTimes(1);
  });
});

/** Wave 5 — F-W4-1 at the coordinator: a single-organisation backlog under the server's per-organisation cap. */
describe('DispatchCoordinator — F-W4-1 (single-organisation backlog)', () => {
  it('a single-organisation backlog of 35 with the 10-per-org cap drains in ONE tick: 4 claims with rows + the empty one', async () => {
    const store = new FakePointerStore(30_000, 10);
    const processed: string[] = [];
    for (let n = 1; n <= 35; n += 1) store.add(n);
    const coordinator = new DispatchCoordinator([binding('email', store, processed)], { claimer: store, batch: 100, reconcileMs: 900_000, logger, now: () => 0, debounceMs: 0 });
    await coordinator.tick('email');
    expect(processed).toHaveLength(35);
    expect(store.claimCalls).toBe(5);
    await settle();
    expect(store.claimCalls).toBe(5); // ended on the empty claim: no follow-up
  });

  it('a 150-row single-organisation backlog with maxBatchesPerRun 3 drains through prompt coalesced follow-ups, never two loops at once', async () => {
    const store = new FakePointerStore(30_000, 10);
    const processed: string[] = [];
    for (let n = 1; n <= 150; n += 1) store.add(n);
    const executeWake = jest.fn((_q: string, run: () => Promise<boolean>) => run());
    const coordinator = new DispatchCoordinator([binding('email', store, processed)], {
      claimer: store, batch: 100, maxBatchesPerRun: 3, reconcileMs: 900_000, logger, now: () => 0, debounceMs: 0, executeWake,
    });
    await coordinator.tick('email');
    expect(processed).toHaveLength(30);
    for (let i = 0; i < 10 && processed.length < 150; i += 1) await settle();
    expect(processed).toHaveLength(150);
    expect(new Set(processed).size).toBe(150);
    expect(store.maxInFlightClaims).toBe(1);
    expect(executeWake).toHaveBeenCalled(); // follow-ups run through the runtime wrapper (scan slot, metrics, drain)
  });

  it('not-due subjects (processScope does nothing; pointers stay leased) terminate the run and start no follow-up', async () => {
    const store = new FakePointerStore(30_000, 10);
    for (let n = 1; n <= 5; n += 1) store.add(n);
    const coordinator = new DispatchCoordinator([{ queue: 'email', legacy: async () => false, processScope: async () => 0 }], {
      claimer: store, batch: 100, reconcileMs: 900_000, logger, now: () => 0, debounceMs: 0,
    });
    await coordinator.tick('email');
    expect(store.claimCalls).toBe(2);
    await settle();
    expect(store.claimCalls).toBe(2);
  });
});
