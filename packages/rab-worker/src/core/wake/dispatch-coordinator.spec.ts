import { DispatchCoordinator, DispatchQueueBinding, RECONCILE_RETRY_AFTER_FAILURE_MS } from './dispatch-coordinator';
import { noteLegacyBatchLimitReached } from './legacy-batch-limit';

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
    expect(executeWake).toHaveBeenCalledWith('email', expect.any(Function), 'wake');
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

/**
 * #24 — bounded, fair follow-up reconciliation. A model of the POINTERLESS backlog the legacy sweep drains: one pass
 * takes at most `batch` rows per organisation (the per_scope cycle; the take is atomic, as SKIP LOCKED + the state
 * transition make it on the server) and notes a FULL batch through the real `noteLegacyBatchLimitReached`.
 */
class PointerlessBacklog {
  readonly remaining = new Map<string, number>();
  readonly passes: Array<Record<string, number>> = [];
  readonly passTimes: number[] = [];
  failNext = 0;
  inFlight = 0;
  maxInFlight = 0;

  constructor(private readonly batch: number, private readonly clock?: { now: number }) {}

  add(org: string, n: number): this {
    this.remaining.set(org, (this.remaining.get(org) ?? 0) + n);
    return this;
  }

  get total(): number {
    return [...this.remaining.values()].reduce((a, b) => a + b, 0);
  }

  sweep = async (): Promise<boolean> => {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await Promise.resolve();
      if (this.failNext > 0) {
        this.failNext -= 1;
        throw new Error('connection terminated'); // PostgreSQL restart / lost session mid-sweep
      }
      const taken: Record<string, number> = {};
      let any = false;
      for (const [org, n] of this.remaining) {
        const t = Math.min(this.batch, n);
        this.remaining.set(org, n - t);
        taken[org] = t;
        if (t > 0) any = true;
        if (t >= this.batch) noteLegacyBatchLimitReached();
      }
      this.passes.push(taken);
      if (this.clock) this.passTimes.push(this.clock.now);
      return any;
    } finally {
      this.inFlight -= 1;
    }
  };
}

const ORG_B = '00000000-0000-4000-8000-00000000000b';
const ORG_C = '00000000-0000-4000-8000-00000000000c';
const DELAY = 5_000;
const WINDOW = 900_000;

/** A coordinator over the backlog model with a controllable clock and timers (no pointers: the global claim finds nothing). */
function backlogCoordinator(
  backlog: PointerlessBacklog,
  clock: { now: number },
  timers = manualTimers(),
  extra: Partial<ConstructorParameters<typeof DispatchCoordinator>[1]> = {},
  legacy: DispatchQueueBinding['legacy'] = backlog.sweep,
) {
  const store = new FakePointerStore(30_000);
  const warn = jest.fn();
  const executeWake = jest.fn((_q: string, run: () => Promise<boolean>) => run());
  const coordinator = new DispatchCoordinator([{ queue: 'email', legacy, processScope: async () => 0 }], {
    claimer: store, batch: 100, reconcileMs: WINDOW, logger: { log: jest.fn(), warn }, now: () => clock.now, debounceMs: 0,
    followUpDelayMs: DELAY, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, executeWake, ...extra,
  });
  /** Advance the clock by `ms`, then fire the pending follow-up timer (it was set `DELAY` ms ahead). */
  const advance = async (ms = DELAY) => {
    clock.now += ms;
    await timers.flush();
    await coordinator.idle();
  };
  /** Drive follow-ups until none is pending (bounded). */
  const drain = async (max = 100) => {
    for (let i = 0; i < max && timers.size > 0; i += 1) await advance();
  };
  return { coordinator, timers, warn, executeWake, advance, drain, store };
}

describe('DispatchCoordinator — #24 bounded, fair follow-up reconciliation', () => {
  it('0 pointerless rows: one sweep, no follow-up, and regular poll ticks add no sweep until the window ends (idle-neutral)', async () => {
    const clock = { now: 0 };
    const backlog = new PointerlessBacklog(50);
    const { coordinator, timers } = backlogCoordinator(backlog, clock);
    await coordinator.tick('email');
    expect(backlog.passes).toHaveLength(1);
    expect(timers.size).toBe(0);
    for (clock.now = 2_000; clock.now < WINDOW; clock.now += 2_000) await coordinator.tick('email'); // poll every 2 s
    expect(backlog.passes).toHaveLength(1);
    clock.now = WINDOW;
    await coordinator.tick('email');
    expect(backlog.passes).toHaveLength(2);
  });

  it.each([
    [49, 1],
    [50, 2], // a full batch is followed by one confirming pass that finds the rest empty
    [51, 2],
    [500, 11], // 10 full passes + the confirming pass
  ])('%i pointerless rows in one organisation drain in %i sweep(s), each at most one batch, DELAY apart, inside the window', async (rows, sweeps) => {
    const clock = { now: 0 };
    const backlog = new PointerlessBacklog(50, clock).add(ORG, rows);
    const { coordinator, timers, drain } = backlogCoordinator(backlog, clock);
    await coordinator.tick('email');
    await drain();
    expect(backlog.total).toBe(0);
    expect(backlog.passes).toHaveLength(sweeps);
    expect(backlog.passes.every((p) => (p[ORG] ?? 0) <= 50)).toBe(true);
    expect(backlog.passTimes).toEqual(Array.from({ length: sweeps }, (_, i) => i * DELAY));
    expect(backlog.passTimes[sweeps - 1]!).toBeLessThan(WINDOW);
    expect(timers.size).toBe(0); // the chain ends: back to the regular cadence
  });

  it('fair across organisations: every sweep takes one batch from EACH organisation with work, so a large backlog never starves a small one', async () => {
    const clock = { now: 0 };
    const backlog = new PointerlessBacklog(50, clock).add(ORG, 500).add(ORG_B, 30).add(ORG_C, 120);
    const { coordinator, drain } = backlogCoordinator(backlog, clock);
    await coordinator.tick('email');
    await drain();
    expect(backlog.total).toBe(0);
    expect(backlog.passes[0]).toEqual({ [ORG]: 50, [ORG_B]: 30, [ORG_C]: 50 }); // the small ones are served in the FIRST sweep
    expect(backlog.passes[2]).toEqual({ [ORG]: 50, [ORG_B]: 0, [ORG_C]: 20 }); // C done at sweep 3
    expect(backlog.passes).toHaveLength(11); // A (500) bounds the episode
  });

  it('bounded: at most maxFollowUpsPerInterval follow-ups per window, a warning, then the rest waits for the next window (no loop)', async () => {
    const clock = { now: 0 };
    const backlog = new PointerlessBacklog(50, clock).add(ORG, 500);
    const { coordinator, timers, warn, drain } = backlogCoordinator(backlog, clock, manualTimers(), { maxFollowUpsPerInterval: 3 });
    await coordinator.tick('email');
    await drain();
    expect(backlog.passes).toHaveLength(4); // 1 regular + 3 follow-ups
    expect(timers.size).toBe(0);
    expect(warn.mock.calls.map((c) => c[0] as string).filter((m) => m.includes('follow-up budget exhausted'))).toHaveLength(1);
    for (clock.now += 2_000; clock.now < WINDOW; clock.now += 30_000) await coordinator.tick('email');
    expect(backlog.passes).toHaveLength(4); // no sweep before the window ends, however many ticks
    clock.now = WINDOW;
    await coordinator.tick('email'); // a new window: a fresh budget
    await drain();
    expect(backlog.passes).toHaveLength(8);
    expect(backlog.total).toBe(500 - 8 * 50);
  });

  it('maxFollowUpsPerInterval = 0 keeps the pre-#24 behaviour: one sweep per window', async () => {
    const clock = { now: 0 };
    const backlog = new PointerlessBacklog(50, clock).add(ORG, 500);
    const { coordinator, timers } = backlogCoordinator(backlog, clock, manualTimers(), { maxFollowUpsPerInterval: 0 });
    await coordinator.tick('email');
    expect(timers.size).toBe(0);
    expect(backlog.passes).toHaveLength(1);
  });

  it('poll ticks between follow-ups never add sweeps: a tick before the follow-up is due sweeps nothing; one after it runs the follow-up once', async () => {
    const clock = { now: 0 };
    const backlog = new PointerlessBacklog(50, clock).add(ORG, 120);
    const { coordinator, timers, advance } = backlogCoordinator(backlog, clock);
    await coordinator.tick('email');
    clock.now = 2_000;
    await coordinator.tick('email'); // not due yet
    expect(backlog.passes).toHaveLength(1);
    clock.now = DELAY;
    await coordinator.tick('email'); // due: the tick runs the follow-up and schedules the next one (old timer replaced)
    expect(backlog.passes).toHaveLength(2);
    expect(timers.size).toBe(1);
    await advance(DELAY);
    expect(backlog.passes).toHaveLength(3);
    expect(backlog.total).toBe(0);
    expect(backlog.maxInFlight).toBe(1);
  });

  it('follow-ups run through the injected executor as trigger "reconcile" (main.ts: scan slot, metrics, shutdown drain)', async () => {
    const clock = { now: 0 };
    const backlog = new PointerlessBacklog(50, clock).add(ORG, 60);
    const { coordinator, executeWake, drain } = backlogCoordinator(backlog, clock);
    await coordinator.tick('email');
    await drain();
    expect(executeWake).toHaveBeenCalledWith('email', expect.any(Function), 'reconcile');
  });

  it('a sweep that fails mid-drain (PostgreSQL restart) schedules no follow-up, retries on the 60 s cadence and loses nothing', async () => {
    const clock = { now: 0 };
    const backlog = new PointerlessBacklog(50, clock).add(ORG, 300);
    const { coordinator, timers, advance, drain } = backlogCoordinator(backlog, clock);
    await coordinator.tick('email');
    backlog.failNext = 1;
    await advance(); // the follow-up sweep throws
    expect(backlog.passes).toHaveLength(1);
    expect(timers.size).toBe(0);
    clock.now += 30_000;
    await coordinator.tick('email');
    expect(backlog.passes).toHaveLength(1); // not before the retry delay
    clock.now = DELAY + RECONCILE_RETRY_AFTER_FAILURE_MS;
    await coordinator.tick('email');
    await drain();
    expect(backlog.total).toBe(0);
    expect(backlog.passes).toHaveLength(7); // 300 = 6 full sweeps + the confirming one
  });

  it('Worker interruption: stop() cancels the pending follow-up; a restarted Worker sweeps on its first tick and finishes the drain', async () => {
    const clock = { now: 0 };
    const backlog = new PointerlessBacklog(50, clock).add(ORG, 500);
    const first = backlogCoordinator(backlog, clock);
    await first.coordinator.tick('email');
    await first.advance();
    await first.advance();
    expect(backlog.passes).toHaveLength(3);
    first.coordinator.stop();
    expect(first.timers.size).toBe(0);
    await first.advance();
    expect(backlog.passes).toHaveLength(3); // nothing ran after stop()
    const second = backlogCoordinator(backlog, clock); // the restarted process
    await second.coordinator.tick('email');
    await second.drain();
    expect(backlog.total).toBe(0);
    expect(backlog.passes).toHaveLength(11);
  });

  it('two Worker replicas drain one backlog together: each runs one sweep loop at a time, each within its own budget', async () => {
    const clock = { now: 0 };
    const backlog = new PointerlessBacklog(50).add(ORG, 500).add(ORG_B, 75);
    const shared = manualTimers();
    const a = backlogCoordinator(backlog, clock, shared);
    const b = backlogCoordinator(backlog, clock, shared);
    await Promise.all([a.coordinator.tick('email'), b.coordinator.tick('email')]);
    for (let i = 0; i < 40 && shared.size > 0; i += 1) {
      clock.now += DELAY;
      await shared.flush();
      await Promise.all([a.coordinator.idle(), b.coordinator.idle()]);
    }
    expect(backlog.total).toBe(0);
    expect(backlog.passes.length).toBeLessThanOrEqual(2 * 31);
    expect(backlog.passes.reduce((sum, p) => sum + (p[ORG] ?? 0) + (p[ORG_B] ?? 0), 0)).toBe(575); // every row taken exactly once
  });

  it('stop() during a sweep that reaches its limit schedules no follow-up', async () => {
    const clock = { now: 0 };
    const backlog = new PointerlessBacklog(50, clock).add(ORG, 500);
    const timers = manualTimers();
    let stopNow: () => void = () => undefined;
    const { coordinator } = backlogCoordinator(backlog, clock, timers, {}, async () => {
      const result = await backlog.sweep();
      stopNow();
      return result;
    });
    stopNow = () => coordinator.stop();
    await coordinator.tick('email');
    expect(backlog.passes).toHaveLength(1);
    expect(timers.size).toBe(0);
  });
});

/** #24 review follow-ups: several queues at once, the runtime's same-name skip, an early timer, a throwing global claim. */
describe('DispatchCoordinator — #24 follow-ups under the real runtime contract', () => {
  it('four queues in one coordinator: independent budgets and captures (a full batch on one queue never triggers another)', async () => {
    const clock = { now: 0 };
    const timers = manualTimers();
    const email = new PointerlessBacklog(50, clock).add(ORG, 120);
    const push = new PointerlessBacklog(50, clock); // nothing to do
    const realtime = new PointerlessBacklog(25, clock).add(ORG, 60);
    const statement = new PointerlessBacklog(200, clock).add(ORG, 10);
    const store = new FakePointerStore(30_000);
    const coordinator = new DispatchCoordinator(
      [
        { queue: 'email', legacy: email.sweep, processScope: async () => 0 },
        { queue: 'push', legacy: push.sweep, processScope: async () => 0 },
        { queue: 'realtime', legacy: realtime.sweep, processScope: async () => 0 },
        { queue: 'statement', legacy: statement.sweep, processScope: async () => 0 },
      ],
      { claimer: store, batch: 100, reconcileMs: WINDOW, logger, now: () => clock.now, debounceMs: 0, followUpDelayMs: DELAY, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
    );
    await Promise.all((['email', 'push', 'realtime', 'statement'] as const).map((q) => coordinator.tick(q))); // concurrent sweeps
    for (let i = 0; i < 20 && timers.size > 0; i += 1) {
      clock.now += DELAY;
      await timers.flush();
      await coordinator.idle();
    }
    expect([email.total, realtime.total, statement.total]).toEqual([0, 0, 0]);
    expect(email.passes).toHaveLength(3); // 50 + 50 + 20
    expect(realtime.passes).toHaveLength(3); // 25 + 25 (both full) + 10
    expect(push.passes).toHaveLength(1); // never followed up: its sweeps never reached a limit
    expect(statement.passes).toHaveLength(1);
  });

  it('a follow-up is never lost to the runtime\'s "previous cycle still running" skip, even when the global claim outlasts the delay', async () => {
    const clock = { now: 0 };
    const timers = manualTimers();
    const backlog = new PointerlessBacklog(50, clock).add(ORG, 150);
    const store = new FakePointerStore(30_000);
    store.add(1); // live pointer work: the run's global claim is slow
    let release!: () => void;
    let slow = true;
    const running = new Set<string>();
    const skipped: string[] = [];
    // WorkerRuntime.runOnce: one run per name at a time; a second call with the same name is skipped, not queued.
    const executeWake = async (queue: string, run: () => Promise<boolean>, trigger: string) => {
      const name = `${queue} (${trigger})`;
      if (running.has(name)) {
        skipped.push(name);
        return 'skipped-running';
      }
      running.add(name);
      try {
        return await run();
      } finally {
        running.delete(name);
      }
    };
    const coordinator = new DispatchCoordinator(
      [{
        queue: 'email',
        legacy: backlog.sweep,
        processScope: async (scope) => {
          if (slow) await new Promise<void>((r) => (release = r)); // the global claim takes longer than DELAY
          for (const s of scope.subjectIds) store.remove(s);
          return scope.subjectIds.length;
        },
      }],
      { claimer: store, batch: 100, reconcileMs: WINDOW, logger, now: () => clock.now, debounceMs: 0, followUpDelayMs: DELAY, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, executeWake },
    );
    const first = coordinator.tick('email');
    await settle();
    expect(backlog.passes).toHaveLength(1);
    expect(timers.size).toBe(0); // not armed while the run's global claim is still in flight
    clock.now += 2 * DELAY;
    slow = false;
    release();
    await first;
    expect(timers.size).toBe(1); // armed at the end of the run
    for (let i = 0; i < 10 && timers.size > 0; i += 1) {
      clock.now += DELAY;
      await timers.flush();
      await coordinator.idle();
    }
    expect(backlog.total).toBe(0);
    expect(skipped).toEqual([]);
  });

  it('a follow-up timer that fires a little EARLY (before reconcileDueAt by the clock) still runs the owed sweep', async () => {
    const clock = { now: 0 };
    const backlog = new PointerlessBacklog(50, clock).add(ORG, 120);
    const { coordinator, timers } = backlogCoordinator(backlog, clock);
    await coordinator.tick('email');
    clock.now += DELAY - 1; // Node timers can fire ~1 ms before the Date.now() deadline
    await timers.flush();
    await coordinator.idle();
    expect(backlog.passes).toHaveLength(2);
  });

  it('a global claim that throws after a full sweep still arms the follow-up (the chain never stalls)', async () => {
    const clock = { now: 0 };
    const backlog = new PointerlessBacklog(50, clock).add(ORG, 120);
    const timers = manualTimers();
    let failClaims = 1;
    const claimer = {
      query: async (sql: string, params: unknown[] = []) => {
        if (failClaims > 0 && !sql.includes('worker_release_dispatch_claim')) {
          failClaims -= 1;
          throw new Error('claim connection lost');
        }
        return new FakePointerStore(30_000).query(sql, params);
      },
    };
    const coordinator = new DispatchCoordinator([{ queue: 'email', legacy: backlog.sweep, processScope: async () => 0 }], {
      claimer, batch: 100, reconcileMs: WINDOW, logger, now: () => clock.now, debounceMs: 0, followUpDelayMs: DELAY, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    });
    await coordinator.tick('email').catch(() => undefined);
    expect(timers.size).toBe(1);
    for (let i = 0; i < 10 && timers.size > 0; i += 1) {
      clock.now += DELAY;
      await timers.flush();
      await coordinator.idle();
    }
    expect(backlog.total).toBe(0);
  });

  it('a tick that runs the owed follow-up first cancels its pending timer (no stray run later)', async () => {
    const clock = { now: 0 };
    const backlog = new PointerlessBacklog(50, clock).add(ORG, 60);
    const { coordinator, timers, store } = backlogCoordinator(backlog, clock);
    await coordinator.tick('email');
    expect(timers.size).toBe(1);
    clock.now = DELAY;
    await coordinator.tick('email'); // runs the follow-up (10 rows, not full): the chain ends
    expect(backlog.passes).toHaveLength(2);
    expect(timers.size).toBe(0);
    const claims = store.claimCalls;
    await timers.flush();
    expect(store.claimCalls).toBe(claims);
  });
});
