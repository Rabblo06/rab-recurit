import type Redis from 'ioredis';

/**
 * O3 C2 (owner decision 2026-11-05, "exactly like Twenty"): the API registers every scan's BullMQ job scheduler at start-up
 * (register-schedulers.ts, one reconcile), idempotently under FIXED ids; the production Worker
 * (DISABLE_CRON_JOBS_REGISTRATION=true) only consumes and NEVER registers. BullMQ's Queue and Worker are replaced by an
 * in-memory store shared across instances (one "Redis"), so this unit test never opens a connection.
 */
type Scheduler = { key: string; every: number; next: number; name: string };
const store = new Map<string, Map<string, Scheduler>>(); // `${prefix}/${queue}` → id → scheduler
const calls = { upsert: 0, remove: 0, list: 0 };
let clock = 1_000_000;

jest.mock('bullmq', () => {
  const actual = jest.requireActual('bullmq');
  class FakeQueue {
    private readonly key: string;
    constructor(name: string, opts: { prefix?: string }) {
      this.key = `${opts.prefix ?? 'bull'}/${name}`;
      if (!store.has(this.key)) store.set(this.key, new Map());
    }
    private get schedulers(): Map<string, Scheduler> {
      return store.get(this.key)!;
    }
    on(): this {
      return this;
    }
    async getJobSchedulers(): Promise<Scheduler[]> {
      calls.list += 1;
      return [...this.schedulers.values()].map((s) => ({ ...s }));
    }
    async getJobScheduler(id: string): Promise<Scheduler | undefined> {
      return this.schedulers.get(id);
    }
    async upsertJobScheduler(id: string, repeat: { every: number; startDate?: number }, template: { name: string }): Promise<void> {
      calls.upsert += 1;
      const existing = this.schedulers.get(id);
      // BullMQ semantics relied on by the manager: same `every` keeps the scheduler's own next run; a new one runs now.
      const next = existing && existing.every === repeat.every ? existing.next : (repeat.startDate ?? clock);
      this.schedulers.set(id, { key: id, every: repeat.every, next, name: template.name });
    }
    async removeJobScheduler(id: string): Promise<boolean> {
      calls.remove += 1;
      return this.schedulers.delete(id);
    }
    async getJobs(): Promise<unknown[]> {
      return [];
    }
    async close(): Promise<void> {
      return undefined;
    }
  }
  class FakeWorker {
    constructor(
      readonly name: string,
      readonly processor: unknown,
    ) {}
    on(): this {
      return this;
    }
    isRunning(): boolean {
      return true;
    }
    closing = false;
    async close(): Promise<void> {
      return undefined;
    }
  }
  return { ...actual, Queue: FakeQueue, Worker: FakeWorker };
});

jest.mock('../locking/scan-lock', () => ({
  ScanLock: { open: async () => ({ run: async (_id: string, work: () => Promise<unknown>) => ({ acquired: true, value: await work() }) }) },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CrewflowSchedulerManager } = require('./scheduler-manager') as typeof import('./scheduler-manager');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { startBullmqScheduler } = require('./bullmq-scheduler') as typeof import('./bullmq-scheduler');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildSchedulerPlan, enabledSchedulerIds } = require('./scheduler-plan') as typeof import('./scheduler-plan');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runSchedulerRegistration, REGISTER_SCHEDULERS_EXIT } = require('../../register-schedulers') as typeof import('../../register-schedulers');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { validate } = require('@rab/server/engine/core-modules/environment/env.validation') as typeof import('@rab/server/engine/core-modules/environment/env.validation');

const base = { REDIS_URL: 'redis://localhost:6379', APP_SECRET: 'a'.repeat(32), PG_DATABASE_URL: 'postgres://crewflow_owner:pg-secret@localhost:5432/rab' };
const PREFIX = 'crewflow:development:bull';
const plan = () => {
  const validated = validate({ ...base, WORKER_SCHEDULER: 'bullmq' }) as unknown as Record<string, unknown>;
  return buildSchedulerPlan({ get: (k: string) => validated[k] });
};
const quiet = () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() });
const allSchedulers = () => [...store.entries()].filter(([k]) => k.startsWith(`${PREFIX}/`)).flatMap(([, m]) => [...m.values()]);
const fakeRedis = () =>
  ({
    on: () => undefined,
    quit: async () => 'OK',
    disconnect: () => undefined,
    ping: async () => 'PONG',
    info: async (section: string) => (section === 'memory' ? 'maxmemory_policy:noeviction\r\n' : 'redis_version:7.4.0\r\n'),
    config: async () => ['maxmemory-policy', 'noeviction'],
    multi: () => {
      const chain = { hset: () => chain, expire: () => chain, hincrby: () => chain, exec: async () => [] };
      return chain;
    },
  }) as unknown as Redis;

beforeEach(() => {
  store.clear();
  calls.upsert = 0;
  calls.remove = 0;
  calls.list = 0;
  clock = 1_000_000;
});

describe('idempotent registration under fixed ids', () => {
  it('two reconciles leave exactly one scheduler per enabled scan, same ids, same next run', async () => {
    const p = plan();
    const manager = new CrewflowSchedulerManager({ connection: {} as Redis, prefix: p.prefix, jobs: p.jobs, intervalOf: p.intervalOf, isEnabled: p.isEnabled, logger: quiet() });
    const first = await manager.reconcile();
    const before = allSchedulers().map((s) => [s.key, s.every, s.next]);
    clock += 60_000;
    const second = await manager.reconcile();
    expect(first.upserted.sort()).toEqual(enabledSchedulerIds(p).sort());
    expect(second.upserted.sort()).toEqual(first.upserted.sort());
    expect(allSchedulers()).toHaveLength(first.upserted.length);
    expect(allSchedulers().map((s) => [s.key, s.every, s.next])).toEqual(before);
    await manager.close();
  });

  it('removes a stale Crewflow id and a disabled scan; never touches a foreign scheduler', async () => {
    const p = plan();
    const q = `${PREFIX}/crewflow-scan-maintenance`;
    store.set(q, new Map([
      ['crewflow:crewflow-scan-maintenance:retired-scan', { key: 'crewflow:crewflow-scan-maintenance:retired-scan', every: 1, next: 1, name: 'x' }],
      ['someone-else:job', { key: 'someone-else:job', every: 1, next: 1, name: 'y' }],
    ]));
    const pushId = 'crewflow:crewflow-scan-push:push-dispatch'; // disabled by default (PUSH_ENABLED=false)
    store.set(`${PREFIX}/crewflow-scan-push`, new Map([[pushId, { key: pushId, every: 1, next: 1, name: 'push-dispatch' }]]));
    const manager = new CrewflowSchedulerManager({ connection: {} as Redis, prefix: p.prefix, jobs: p.jobs, intervalOf: p.intervalOf, isEnabled: p.isEnabled, logger: quiet() });
    const report = await manager.reconcile();
    expect(report.removedStale).toEqual(['crewflow:crewflow-scan-maintenance:retired-scan']);
    expect(report.removedDisabled).toEqual([pushId]);
    expect(store.get(q)!.has('someone-else:job')).toBe(true);
    await manager.close();
  });
});

describe('register-schedulers (the API start-up command)', () => {
  const run = (env: Record<string, string>, extra: Partial<Parameters<typeof runSchedulerRegistration>[0]> = {}) =>
    runSchedulerRegistration({ env: { ...base, ...env }, connect: () => fakeRedis(), logger: quiet(), preflight: async () => undefined, ...extra });

  it('registers every enabled scan; a second run (a restart, or another API replica) adds no duplicate', async () => {
    const first = await run({ WORKER_SCHEDULER: 'bullmq' });
    expect(first.exitCode).toBe(REGISTER_SCHEDULERS_EXIT.ok);
    expect(first.report!.upserted.sort()).toEqual(enabledSchedulerIds(plan()).sort());
    const count = allSchedulers().length;
    const nexts = allSchedulers().map((s) => s.next);
    const second = await run({ WORKER_SCHEDULER: 'bullmq' });
    expect(second.exitCode).toBe(0);
    expect(allSchedulers()).toHaveLength(count);
    expect(allSchedulers().map((s) => s.next)).toEqual(nexts);
  });

  it('after a Redis restart (schedulers lost) the next API start re-registers them, with no duplicates', async () => {
    await run({ WORKER_SCHEDULER: 'bullmq' });
    const ids = allSchedulers().map((s) => s.key).sort();
    store.clear(); // Redis restarted without its data
    await run({ WORKER_SCHEDULER: 'bullmq' });
    expect(allSchedulers().map((s) => s.key).sort()).toEqual(ids);
  });

  it('DISABLE_CRON_JOBS_REGISTRATION=true registers nothing', async () => {
    const connect = jest.fn(() => fakeRedis());
    const r = await run({ WORKER_SCHEDULER: 'bullmq', DISABLE_CRON_JOBS_REGISTRATION: 'true' }, { connect });
    expect(r.exitCode).toBe(0);
    expect(connect).not.toHaveBeenCalled();
    expect(calls.upsert).toBe(0);
  });

  it('WORKER_SCHEDULER=interval (development) registers nothing', async () => {
    const r = await run({});
    expect(r.exitCode).toBe(0);
    expect(calls.upsert).toBe(0);
  });

  it('WORKER_SCHEDULER=interval in production is a configuration refusal (64) naming it; nothing registered', async () => {
    const logger = quiet();
    const refused = await run({ NODE_ENV: 'production', WORKER_SCHEDULER: 'interval' }, { logger });
    expect(refused.exitCode).toBe(REGISTER_SCHEDULERS_EXIT.config);
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/WORKER_SCHEDULER=interval runs every scan on each replica/));
    expect(calls.upsert).toBe(0);
  });

  it('an invalid configuration is refused (64) before Redis is touched; a Redis failure is 1', async () => {
    const connect = jest.fn(() => fakeRedis());
    expect((await run({ WORKER_SCHEDULER: 'bullmq', DISABLE_CRON_JOBS_REGISTRATION: 'yes' }, { connect })).exitCode).toBe(64);
    expect(connect).not.toHaveBeenCalled();
    const failed = await run({ WORKER_SCHEDULER: 'bullmq' }, { preflight: async () => Promise.reject(new Error('maxmemory-policy is allkeys-lru')) });
    expect(failed.exitCode).toBe(REGISTER_SCHEDULERS_EXIT.failed);
    expect(calls.upsert).toBe(0);
  });

  it('never prints the Redis URL', async () => {
    const logger = quiet();
    await runSchedulerRegistration({
      env: { ...base, REDIS_URL: 'redis://:S3cret-pw@localhost:6379', WORKER_SCHEDULER: 'bullmq' },
      connect: () => fakeRedis(),
      logger,
      preflight: async () => Promise.reject(new Error('down')),
    });
    const printed = [...logger.log.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls].flat().join('\n');
    expect(printed).not.toContain('S3cret-pw');
  });
});

describe('the consume-only Worker never registers (DISABLE_CRON_JOBS_REGISTRATION=true)', () => {
  const runtime = () => ({ enableSchedulerProgress: jest.fn(), markReconcileOk: jest.fn(), runOnce: jest.fn() });
  const registry = { scan: () => async () => undefined, get: () => undefined, handlers: [] } as never;
  const start = (rt: ReturnType<typeof runtime>, logger: ReturnType<typeof quiet>) => {
    const p = plan();
    return startBullmqScheduler({
      redis: fakeRedis(),
      redisUrl: 'redis://localhost:6379',
      lockConnection: {},
      prefix: p.prefix,
      reconcileMs: 60_000,
      runtime: rt as never,
      registry,
      jobs: p.jobs,
      intervalOf: p.intervalOf,
      isEnabled: p.isEnabled,
      logger: logger as never,
      registerSchedulers: false,
    });
  };

  it('with every scheduler present (the API registered them): no upsert, no removal, health refreshed', async () => {
    await run2();
    const before = { ...calls };
    const rt = runtime();
    const logger = quiet();
    const scheduler = await start(rt, logger);
    expect(calls.upsert).toBe(before.upsert);
    expect(calls.remove).toBe(before.remove);
    expect(calls.list).toBeGreaterThan(before.list); // it only READ them
    expect(rt.markReconcileOk).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    expect(scheduler.scanWorkers.length).toBeGreaterThan(0); // it still consumes
    scheduler.manager.stop();
  });

  it('with schedulers missing (Redis lost them): an ERROR naming them, health NOT refreshed, still nothing registered', async () => {
    const rt = runtime();
    const logger = quiet();
    const scheduler = await start(rt, logger);
    expect(calls.upsert).toBe(0);
    expect(calls.remove).toBe(0);
    expect(rt.markReconcileOk).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/MISSING .*crewflow:crewflow-scan-email:email-dispatch/));
    expect(allSchedulers()).toHaveLength(0);
    scheduler.manager.stop();
  });

  it('verify() is read-only', async () => {
    const p = plan();
    const manager = new CrewflowSchedulerManager({ connection: {} as Redis, prefix: p.prefix, jobs: p.jobs, intervalOf: p.intervalOf, isEnabled: p.isEnabled, logger: quiet() });
    const report = await manager.verify();
    expect(report.missing.sort()).toEqual(enabledSchedulerIds(p).sort());
    expect(report.present).toEqual([]);
    expect(calls.upsert + calls.remove).toBe(0);
    await manager.close();
  });

  async function run2(): Promise<void> {
    const r = await runSchedulerRegistration({ env: { ...base, WORKER_SCHEDULER: 'bullmq' }, connect: () => fakeRedis(), logger: quiet(), preflight: async () => undefined });
    expect(r.exitCode).toBe(0);
  }
});
