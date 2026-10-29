import './helpers/local-storage-env'; // FIRST: env is frozen when the Nest config module is imported
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';

import { StorageReconcileCommand } from '@rab/server/command/storage-reconcile.command';
import { EnvironmentService } from '@rab/server/engine/core-modules/environment/environment.service';
import { StorageDriverFactory } from '@rab/server/engine/core-modules/storage/storage-driver.factory';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { WORKER_STATS_KEY } from '@rab/server/engine/worker-shared/heartbeat.constants';
import { WorkerRuntime } from '../../core/runtime/worker-runtime';
import { loopOptionsOf } from '../../core/scheduler/bullmq-scheduler';
import { ProcessorExplorer } from '../../core/scheduler/processor-explorer';
import { resolveIntervalMs, SCAN_JOBS } from '../../core/scheduler/scan-jobs';
import { WorkerDependencies } from '../../core/scheduler/worker-dependencies';
import { MaintenanceScanProcessor } from '../../queues/rab-maintenance/maintenance.processors';
import { WorkerModule } from '../../worker.module';

/**
 * Phase A (storage) — the Worker's storage-cleanup scan on the REAL WorkerModule (real DI: ModuleRef + the bounded Redis
 * client), REAL Redis (the stats hash the runtime writes) and REAL PostgreSQL as crewflow_app (FORCE RLS):
 *  - a Worker BOOT (interval mode's immediate first tick, `WorkerRuntime.every()`) does NOT re-run the 24 h reconciliation
 *    when one succeeded recently, and is not stamped as a run;
 *  - a stale / absent stamp still runs it (the 24 h cadence is kept), and the success is stamped;
 *  - two replicas at once: exactly one reconciles, the other skips on the lock and is not stamped.
 */
const RUN = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(180_000);

const DEF = SCAN_JOBS.find((d) => d.jobName === 'storage-cleanup')!;
const STAMP = DEF.statKeys.lastRunAt; // 'lastStorageCleanupAt'
const HOUR = 3_600_000;

describeIfDb('storage-cleanup scan: no reconcile on boot when recent, one replica at a time (integration)', () => {
  let moduleRef: TestingModule;
  let redis: Redis;
  let processor: MaintenanceScanProcessor;
  let command: StorageReconcileCommand;
  let env: EnvironmentService;
  const runtimes: WorkerRuntime[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    await moduleRef.init();
    env = moduleRef.get(EnvironmentService);
    command = moduleRef.get(StorageReconcileCommand, { strict: false });
    moduleRef.get(WorkerDependencies).provide({
      logger: new Logger('storage-cleanup-boot-it'),
      environmentService: env,
      storageReconcileCommand: command,
    } as never);
    processor = moduleRef.get(MaintenanceScanProcessor);
    // Real DI: Nest injected ModuleRef, and the bounded Redis client the stamp is read through resolves from the Worker graph.
    expect((processor as unknown as { moduleRef?: unknown }).moduleRef).toBeDefined();
    expect(env.get('STORAGE_CLEANUP_MIN_SPACING_MINUTES')).toBe(720); // the default
    redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 });
  });

  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) runtime.beginShutdown();
    jest.restoreAllMocks();
    await redis.hdel(WORKER_STATS_KEY, STAMP);
    process.exitCode = undefined; // the command sets the CLI exit code (1 = integrity problems); never leak it into Jest
  });

  afterAll(async () => {
    await redis?.quit();
    await moduleRef?.close();
  });

  /** One "Worker boot" in interval mode: a fresh runtime registering the real storage-cleanup handler (first tick runs now). */
  async function boot(): Promise<'succeeded' | 'idle' | 'failed'> {
    const runtime = new WorkerRuntime(redis, { metricsLogMs: 0 });
    runtimes.push(runtime);
    const handler = moduleRef.get(ProcessorExplorer).explore().scan(DEF);
    let settled!: (outcome: 'succeeded' | 'idle' | 'failed') => void;
    const done = new Promise<'succeeded' | 'idle' | 'failed'>((resolve) => (settled = resolve));
    const options = loopOptionsOf(DEF, handler, resolveIntervalMs(DEF, env));
    const run = options.run;
    runtime.every({
      ...options,
      run: async (ctx) => {
        try {
          const value = await run(ctx);
          settled(value === false ? 'idle' : 'succeeded');
          return value;
        } catch (error) {
          settled('failed');
          throw error;
        }
      },
    });
    const outcome = await done;
    await runtime.drain(10_000); // the runtime's own stamp write has happened once this settles
    await new Promise((r) => setTimeout(r, 100));
    return outcome;
  }

  it('boot with a successful run 1 h ago: no reconciliation (no command run, no storage/metadata work) and no new stamp', async () => {
    const stamp = String(Date.now() - HOUR);
    await redis.hset(WORKER_STATS_KEY, STAMP, stamp);
    const runSpy = jest.spyOn(command, 'run');
    const listSpy = jest.spyOn(moduleRef.get(StorageDriverFactory, { strict: false }).getDriver(), 'list');
    expect(await boot()).toBe('idle');
    expect(runSpy).not.toHaveBeenCalled();
    expect(listSpy).not.toHaveBeenCalled();
    expect(await redis.hget(WORKER_STATS_KEY, STAMP)).toBe(stamp); // a skip is never recorded as a run
  });

  it('boot with the last run 13 h ago (or none at all): it reconciles once, non-blocking lock, and the success is stamped', async () => {
    for (const stamp of [String(Date.now() - 13 * HOUR), null]) {
      if (stamp) await redis.hset(WORKER_STATS_KEY, STAMP, stamp);
      else await redis.hdel(WORKER_STATS_KEY, STAMP);
      const runSpy = jest.spyOn(command, 'run');
      const before = Date.now();
      expect(await boot()).toBe('succeeded');
      expect(runSpy).toHaveBeenCalledTimes(1);
      expect(runSpy.mock.calls[0]![1]).toMatchObject({ failStalePending: true, purgeDeletedImagesOlderThanDays: 30, lockWaitSeconds: 0 });
      expect(command.lastReport).toBeDefined();
      expect(Number(await redis.hget(WORKER_STATS_KEY, STAMP))).toBeGreaterThanOrEqual(before);
      runSpy.mockRestore();
      for (const runtime of runtimes.splice(0)) runtime.beginShutdown();
    }
  });

  it('a future stamp (clock skew) or an unreadable one never suppresses the run', async () => {
    for (const stamp of [String(Date.now() + 48 * HOUR), 'garbage']) {
      await redis.hset(WORKER_STATS_KEY, STAMP, stamp);
      const runSpy = jest.spyOn(command, 'run');
      expect(await boot()).toBe('succeeded');
      expect(runSpy).toHaveBeenCalledTimes(1);
      runSpy.mockRestore();
      for (const runtime of runtimes.splice(0)) runtime.beginShutdown();
    }
  });

  it('two replicas at the same time: exactly one reconciles; the other skips on the lock and is NOT stamped', async () => {
    await redis.hdel(WORKER_STATS_KEY, STAMP);
    // Replica B: its own command instance and processor (separate process in production), same database and Redis.
    const commandB = new StorageReconcileCommand(
      moduleRef.get(DataSource),
      moduleRef.get(StorageDriverFactory, { strict: false }),
      env,
      moduleRef.get(TenantContextService, { strict: false }),
    );
    const depsB = { get: () => ({ logger: new Logger('replica-b'), environmentService: env, storageReconcileCommand: commandB }) } as never;
    const processorB = new MaintenanceScanProcessor(depsB, (processor as unknown as { moduleRef: never }).moduleRef);

    // Hold replica A inside its reconciliation (after it took the lock) until B has tried.
    const driver = moduleRef.get(StorageDriverFactory, { strict: false }).getDriver();
    const originalList = driver.list.bind(driver);
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    jest.spyOn(driver, 'list').mockImplementationOnce(async function* (prefix: string) {
      entered();
      await gate;
      yield* originalList(prefix);
    });
    const runA = jest.spyOn(command, 'run');
    const runB = jest.spyOn(commandB, 'run');

    const a = processor.storageCleanup();
    await inside;
    await expect(processorB.storageCleanup()).resolves.toBe(false); // lock held by A → skip, not a success
    expect(commandB.lastSkipped).toBe('locked');
    expect(commandB.lastReport).toBeUndefined();
    release();
    await expect(a).resolves.toBe(true);
    expect(command.lastReport).toBeDefined();
    expect(runA).toHaveBeenCalledTimes(1);
    expect(runB).toHaveBeenCalledTimes(1);
    process.exitCode = undefined; // the command's CLI exit code (3 = locked) must not leak into Jest
  });
});
