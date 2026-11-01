import {
  classifyNotificationQueueUsage,
  createNotificationQueueMonitor,
  NOTIFICATION_QUEUE_ESCALATE_ABOVE,
  NOTIFICATION_QUEUE_QUERY_TIMEOUT_MAX_MS,
  NOTIFICATION_QUEUE_USAGE_SQL,
  NOTIFICATION_QUEUE_WARN_ABOVE,
  NotificationQueueMonitor,
  NotificationQueueSample,
} from './notification-queue-monitor';

/**
 * Phase D wave 2 — OD-2 (owner decision 2026-11-01): before event mode is enabled anywhere, the Worker samples
 * `pg_notification_queue_usage()` (no privilege needed; the cluster-wide NOTIFY queue fill, 0..1) at the backstop cadence
 * on its existing runtime connection, reports it in health/metrics, warns above 0.1 and escalates (error level) above 0.5.
 * Poll mode never runs it (poll mode issues no NOTIFY at all).
 */
function fakeDb(values: Array<number | Error>) {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    query: async (sql: string) => {
      calls.push(sql);
      const v = values[Math.min(i++, values.length - 1)];
      if (v instanceof Error) throw v;
      return [{ usage: v }];
    },
  };
}

const logger = () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() });

describe('classifyNotificationQueueUsage', () => {
  it('ok ≤ 0.1 < warn ≤ 0.5 < escalate (owner thresholds)', () => {
    expect(NOTIFICATION_QUEUE_WARN_ABOVE).toBe(0.1);
    expect(NOTIFICATION_QUEUE_ESCALATE_ABOVE).toBe(0.5);
    expect(classifyNotificationQueueUsage(0)).toBe('ok');
    expect(classifyNotificationQueueUsage(0.1)).toBe('ok');
    expect(classifyNotificationQueueUsage(0.1000001)).toBe('warn');
    expect(classifyNotificationQueueUsage(0.5)).toBe('warn');
    expect(classifyNotificationQueueUsage(0.51)).toBe('escalate');
    expect(classifyNotificationQueueUsage(null)).toBe('unknown');
    expect(classifyNotificationQueueUsage(Number.NaN)).toBe('unknown');
  });
});

describe('NotificationQueueMonitor', () => {
  it('samples exactly `SELECT pg_notification_queue_usage()` and reports usage + level (numbers only)', async () => {
    const db = fakeDb([0.02]);
    const samples: NotificationQueueSample[] = [];
    const monitor = new NotificationQueueMonitor(db, { logger: logger(), intervalMs: 30_000, onSample: (s) => samples.push(s), now: () => 42 });
    await monitor.sample();
    expect(db.calls).toEqual([NOTIFICATION_QUEUE_USAGE_SQL]);
    expect(NOTIFICATION_QUEUE_USAGE_SQL).toBe('SELECT pg_notification_queue_usage() AS usage');
    expect(samples).toEqual([{ usage: 0.02, level: 'ok', at: 42 }]);
    expect(monitor.last).toEqual({ usage: 0.02, level: 'ok', at: 42 });
  });

  it('> 0.1 warns, > 0.5 escalates at error level, recovery is logged once; a level that persists repeats at most every repeatLogMs', async () => {
    let now = 0;
    const db = fakeDb([0.05, 0.2, 0.25, 0.6, 0.7, 0.7, 0.01]);
    const log = logger();
    const monitor = new NotificationQueueMonitor(db, { logger: log, intervalMs: 30_000, now: () => now, repeatLogMs: 300_000 });
    await monitor.sample(); // 0.05 ok
    expect(log.warn).not.toHaveBeenCalled();
    now = 30_000;
    await monitor.sample(); // 0.2 warn
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![0]).toContain('pg_notification_queue_usage=0.200000');
    now = 60_000;
    await monitor.sample(); // 0.25 still warn, within repeat window → silent
    expect(log.warn).toHaveBeenCalledTimes(1);
    now = 90_000;
    await monitor.sample(); // 0.6 escalate → error now (level rose)
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]![0]).toContain('> 0.5');
    now = 120_000;
    await monitor.sample(); // 0.7 still escalate, within window → silent
    expect(log.error).toHaveBeenCalledTimes(1);
    now = 90_000 + 300_000;
    await monitor.sample(); // 0.7, window passed → repeated
    expect(log.error).toHaveBeenCalledTimes(2);
    now = 420_000;
    await monitor.sample(); // 0.01 ok → recovery logged
    expect(log.log).toHaveBeenCalledTimes(1);
    expect(log.log.mock.calls[0]![0]).toContain('recovered');
  });

  it('a failed sample never throws: usage null, level unknown, a throttled warning', async () => {
    const db = fakeDb([new Error('connection terminated')]);
    const log = logger();
    const samples: NotificationQueueSample[] = [];
    const monitor = new NotificationQueueMonitor(db, { logger: log, intervalMs: 30_000, now: () => 1, onSample: (s) => samples.push(s) });
    await expect(monitor.sample()).resolves.toEqual({ usage: null, level: 'unknown', at: 1 });
    await monitor.sample();
    expect(samples).toHaveLength(2);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('start() samples on the interval with an unref\'d timer; stop() ends it', async () => {
    const db = fakeDb([0]);
    const handle = { unref: jest.fn() };
    let tick: (() => void) | null = null;
    const setIntervalFn = jest.fn((fn: () => void, ms: number) => {
      tick = fn;
      expect(ms).toBe(30_000);
      return handle as unknown as ReturnType<typeof setInterval>;
    });
    const clearIntervalFn = jest.fn();
    const monitor = new NotificationQueueMonitor(db, {
      logger: logger(), intervalMs: 30_000, setInterval: setIntervalFn as never, clearInterval: clearIntervalFn as never,
    });
    monitor.start();
    expect(handle.unref).toHaveBeenCalled();
    tick!();
    await new Promise((r) => setImmediate(r));
    expect(db.calls).toHaveLength(1);
    monitor.stop();
    expect(clearIntervalFn).toHaveBeenCalledWith(handle);
  });
});

describe('createNotificationQueueMonitor (mode gate)', () => {
  it('poll mode: no monitor, no query — ever', async () => {
    const db = fakeDb([0]);
    expect(createNotificationQueueMonitor({ dispatchMode: 'poll', backstopSeconds: 30 }, db, { logger: logger() })).toBeNull();
    expect(db.calls).toEqual([]);
  });

  it('event mode: a monitor at the backstop cadence (WORKER_DISPATCH_BACKSTOP_SECONDS)', () => {
    const db = fakeDb([0]);
    const monitor = createNotificationQueueMonitor({ dispatchMode: 'event', backstopSeconds: 45 }, db, { logger: logger() });
    expect(monitor).toBeInstanceOf(NotificationQueueMonitor);
    expect(monitor!.intervalMs).toBe(45_000);
  });
});

/**
 * Wave 3 (owner decision): the sample stays on the Worker's NORMAL pool, bounded — a per-query timeout of at most 5 s
 * (server-side `SET LOCAL statement_timeout` inside the sample's own short transaction, plus a client-side cap that also
 * covers waiting for a pool connection), and never overlapping: while a sample's query is still in flight, a tick is
 * skipped. No new connection is ever opened.
 */
describe('NotificationQueueMonitor — bounded sampling (wave 3)', () => {
  it('query timeout defaults to 5 s and is clamped to at most 5 s', () => {
    const db = fakeDb([0]);
    expect(new NotificationQueueMonitor(db, { logger: logger(), intervalMs: 30_000 }).queryTimeoutMs).toBe(5_000);
    expect(new NotificationQueueMonitor(db, { logger: logger(), intervalMs: 30_000, queryTimeoutMs: 60_000 }).queryTimeoutMs).toBe(5_000);
    expect(new NotificationQueueMonitor(db, { logger: logger(), intervalMs: 30_000, queryTimeoutMs: 250 }).queryTimeoutMs).toBe(250);
    expect(NOTIFICATION_QUEUE_QUERY_TIMEOUT_MAX_MS).toBe(5_000);
  });

  it('on a pool with transactions: one short transaction on the SAME pool — SET LOCAL statement_timeout, then the sample', async () => {
    const statements: string[] = [];
    let transactions = 0;
    const pool = {
      query: async () => {
        throw new Error('the sample must run inside its bounded transaction');
      },
      transaction: async <T>(fn: (m: { query(sql: string): Promise<unknown> }) => Promise<T>): Promise<T> => {
        transactions += 1;
        return fn({ query: async (sql: string) => (statements.push(sql), sql.startsWith('SELECT') ? [{ usage: 0.01 }] : []) });
      },
    };
    const monitor = new NotificationQueueMonitor(pool, { logger: logger(), intervalMs: 30_000, now: () => 9 });
    await expect(monitor.sample()).resolves.toEqual({ usage: 0.01, level: 'ok', at: 9 });
    expect(transactions).toBe(1);
    expect(statements).toEqual(['SET LOCAL statement_timeout = 5000', NOTIFICATION_QUEUE_USAGE_SQL]);
  });

  it('a query that does not answer within the timeout → sample "unknown" (never waits longer), and ticks are SKIPPED until it settles', async () => {
    let finish!: (rows: unknown) => void;
    let calls = 0;
    const db = {
      query: () => {
        calls += 1;
        if (calls > 1) return Promise.resolve([{ usage: 0.03 }]); // the database answers again
        return new Promise((resolve) => (finish = resolve));
      },
    };
    const log = logger();
    const monitor = new NotificationQueueMonitor(db, { logger: log, intervalMs: 30_000, queryTimeoutMs: 20, now: () => 1 });
    const started = Date.now();
    await expect(monitor.sample()).resolves.toEqual({ usage: null, level: 'unknown', at: 1 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(log.warn).toHaveBeenCalledTimes(1);
    // The timed-out query is still running on its pool connection: the next ticks are skipped, nothing new is issued.
    await expect(monitor.sample()).resolves.toBeNull();
    await expect(monitor.sample()).resolves.toBeNull();
    expect(calls).toBe(1);
    expect(monitor.skippedTicks).toBe(2);
    finish([{ usage: 0.03 }]);
    await new Promise((r) => setImmediate(r));
    await expect(monitor.sample()).resolves.toMatchObject({ level: 'ok' });
    expect(calls).toBe(2);
  });

  it('a tick that arrives while a sample is in progress is skipped (never two concurrent sample queries)', async () => {
    let finish!: (rows: unknown) => void;
    let calls = 0;
    const db = { query: () => ((calls += 1), new Promise((resolve) => (finish = resolve))) };
    const monitor = new NotificationQueueMonitor(db, { logger: logger(), intervalMs: 30_000, now: () => 1 });
    const first = monitor.sample();
    await expect(monitor.sample()).resolves.toBeNull();
    finish([{ usage: 0.2 }]);
    await expect(first).resolves.toMatchObject({ usage: 0.2, level: 'warn' });
    expect(calls).toBe(1);
  });
});
