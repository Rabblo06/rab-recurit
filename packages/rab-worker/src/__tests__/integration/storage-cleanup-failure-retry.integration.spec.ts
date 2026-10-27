import './helpers/local-storage-env'; // FIRST: env is frozen when the Nest config module is imported
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';

import { STORAGE_RECONCILE_LOCK, StorageReconcileCommand } from '@rab/server/command/storage-reconcile.command';
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
 * Phase A (storage) review — recovery after a FAILED or INTERRUPTED storage-cleanup scan, on the REAL WorkerModule (real
 * DI, real Redis stats hash, real PostgreSQL as crewflow_app, LOCAL storage driver in a temp dir). Complements
 * storage-cleanup-boot.integration.spec.ts (which covers only successful / skipped cycles):
 *
 *  1. a scan that fails mid-way on a storage outage is recorded as a FAILURE (failures counter), is NOT stamped as a
 *     success, releases the cluster-wide reconcile lock, and therefore does NOT arm the 720-minute spacing: the very next
 *     attempt (next tick / restart) reconciles.
 *  2. the same for a database failure after the listing (lost runtime connection during catalogue enumeration), with no
 *     previous stamp at all.
 *  3. the reconcile LOCK session itself is killed mid-scan (pg_terminate_backend): the Worker does not crash (the lock
 *     client's 'error' is handled), the cycle still completes and is stamped, nothing is left locked — and, as designed,
 *     another replica CAN take the lock while the first run is still finishing (overlap is permitted; CAS/leases keep it
 *     correct). This documents that the lock is best-effort de-duplication, not a correctness guarantee.
 *  4. interval mode writes the WHOLE stats object: a replica holding an OLDER success in memory can roll the shared stamp
 *     back. The spacing check then fails toward running (an extra scan), never toward skipping.
 */
const RUN = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(180_000);

const DEF = SCAN_JOBS.find((d) => d.jobName === 'storage-cleanup')!;
const STAMP = DEF.statKeys.lastRunAt; // 'lastStorageCleanupAt'
const FAILURES = DEF.statKeys.failures; // 'storageCleanupFailures'
const HOUR = 3_600_000;

describeIfDb('storage-cleanup scan: recovery after a failed or interrupted reconciliation (integration)', () => {
  let moduleRef: TestingModule;
  let redis: Redis;
  let command: StorageReconcileCommand;
  let env: EnvironmentService;
  let dataSource: DataSource;
  let processor: MaintenanceScanProcessor;
  const runtimes: WorkerRuntime[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    await moduleRef.init();
    env = moduleRef.get(EnvironmentService);
    dataSource = moduleRef.get(DataSource);
    command = moduleRef.get(StorageReconcileCommand, { strict: false });
    moduleRef.get(WorkerDependencies).provide({
      logger: new Logger('storage-cleanup-failure-it'),
      environmentService: env,
      storageReconcileCommand: command,
    } as never);
    processor = moduleRef.get(MaintenanceScanProcessor);
    expect(env.get('STORAGE_CLEANUP_MIN_SPACING_MINUTES')).toBe(720); // the default under review
    redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 });
  });

  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) runtime.beginShutdown();
    jest.restoreAllMocks();
    await redis.hdel(WORKER_STATS_KEY, STAMP, FAILURES);
    process.exitCode = undefined; // the command sets the CLI exit code (1 = integrity, 3 = locked); never leak it into Jest
  });

  afterAll(async () => {
    await redis?.quit();
    await moduleRef?.close();
  });

  /** One interval-mode "tick" on a fresh runtime (== a Worker boot / the next scheduled attempt) with the real handler. */
  async function tick(): Promise<{ outcome: 'succeeded' | 'idle' | 'failed'; runtime: WorkerRuntime }> {
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
    await runtime.drain(10_000); // the runtime's own stats write has been issued once this settles
    await new Promise((r) => setTimeout(r, 150));
    return { outcome, runtime };
  }

  /** Backend pids holding the reconcile advisory lock right now (pg_locks is readable by the runtime role). */
  async function lockHolders(): Promise<number[]> {
    const rows: Array<{ pid: number }> = await dataSource.query(
      `SELECT l.pid FROM pg_locks l
        WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
          AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended($1, 0)`,
      [STORAGE_RECONCILE_LOCK],
    );
    return rows.map((r) => Number(r.pid));
  }

  const driver = () => moduleRef.get(StorageDriverFactory, { strict: false }).getDriver();

  it('1: a storage outage mid-scan is a counted FAILURE, not stamped, lock released — and the 720-min spacing does NOT delay the retry', async () => {
    const lastSuccess = String(Date.now() - 13 * HOUR); // stale: this tick is due
    await redis.hset(WORKER_STATS_KEY, STAMP, lastSuccess);
    jest.spyOn(driver(), 'list').mockImplementationOnce(async function* () {
      throw new Error('simulated S3 outage mid-scan');
    });
    const runSpy = jest.spyOn(command, 'run');

    const failed = await tick();
    expect(failed.outcome).toBe('failed');
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(command.lastReport).toBeUndefined(); // nothing was reported as a completed reconciliation
    expect(await redis.hget(WORKER_STATS_KEY, STAMP)).toBe(lastSuccess); // NOT refreshed by a failure
    expect(failed.runtime.stats[FAILURES]).toBe(1);
    expect(await redis.hget(WORKER_STATS_KEY, FAILURES)).toBe('1');
    expect(await lockHolders()).toEqual([]); // released by the command's finally, not left for a session timeout

    // Next attempt (next tick, or a Worker restart): the spacing reads the UNCHANGED stamp (13 h) and lets it run.
    const before = Date.now();
    const retry = await tick();
    expect(retry.outcome).toBe('succeeded');
    expect(runSpy).toHaveBeenCalledTimes(2);
    expect(command.lastReport).toBeDefined();
    expect(Number(await redis.hget(WORKER_STATS_KEY, STAMP))).toBeGreaterThanOrEqual(before);
    expect(await lockHolders()).toEqual([]);
  });

  it('2: a lost DB connection after the listing (no previous stamp at all) fails the cycle; the retry still runs', async () => {
    await redis.hdel(WORKER_STATS_KEY, STAMP);
    const listSpy = jest.spyOn(driver(), 'list');
    const original = dataSource.query.bind(dataSource);
    let injected = 0;
    jest.spyOn(dataSource, 'query').mockImplementation((async (sql: string, params?: unknown[]) => {
      if (injected === 0 && sql.includes('worker_list_organisations')) {
        injected += 1;
        throw new Error('Connection terminated unexpectedly');
      }
      return original(sql, params as never);
    }) as never);

    const failed = await tick();
    expect(failed.outcome).toBe('failed');
    expect(injected).toBe(1);
    expect(listSpy).toHaveBeenCalledTimes(1); // LIST-first: the listing had completed before the metadata pass failed
    expect(await redis.hget(WORKER_STATS_KEY, STAMP)).toBeNull();
    expect(await lockHolders()).toEqual([]);

    const retry = await tick();
    expect(retry.outcome).toBe('succeeded');
    expect(await redis.hget(WORKER_STATS_KEY, STAMP)).not.toBeNull();
  });

  it('3: the reconcile LOCK session is killed mid-scan — no crash, the cycle completes and is stamped, nothing stays locked; another replica may overlap meanwhile', async () => {
    await redis.hdel(WORKER_STATS_KEY, STAMP);
    const d = driver();
    const originalList = d.list.bind(d);
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    jest.spyOn(d, 'list').mockImplementationOnce(async function* (prefix: string) {
      entered();
      await gate;
      yield* originalList(prefix);
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const a = processor.storageCleanup();
    await inside; // replica A holds the lock and is mid-reconciliation
    const holders = await lockHolders();
    expect(holders).toHaveLength(1);
    const [{ terminated }] = await dataSource.query('SELECT pg_terminate_backend($1) AS terminated', [holders[0]]);
    expect(terminated).toBe(true);
    for (let i = 0; i < 50 && (await lockHolders()).length; i++) await new Promise((r) => setTimeout(r, 100));
    expect(await lockHolders()).toEqual([]); // the server released the lock with the session

    // Replica B now wins the lock although A is still running (documented: overlap is possible after a lock-session loss).
    const commandB = new StorageReconcileCommand(
      dataSource,
      moduleRef.get(StorageDriverFactory, { strict: false }),
      env,
      moduleRef.get(TenantContextService, { strict: false }),
    );
    await commandB.run([], { failStalePending: true, purgeDeletedImagesOlderThanDays: 30, lockWaitSeconds: 0 });
    expect(commandB.lastSkipped).toBeUndefined();
    expect(commandB.lastReport).toBeDefined();

    release();
    await expect(a).resolves.toBe(true); // A finishes normally; its explicit unlock fails quietly on the dead session
    expect(command.lastReport).toBeDefined();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('storage reconciliation lock connection error'))).toBe(true);
    expect(await lockHolders()).toEqual([]);

    // And the lock is immediately usable again.
    const next = new StorageReconcileCommand(dataSource, moduleRef.get(StorageDriverFactory, { strict: false }), env, moduleRef.get(TenantContextService, { strict: false }));
    await next.run([], { lockWaitSeconds: 0 });
    expect(next.lastSkipped).toBeUndefined();
  });

  it('4: interval mode whole-object stats writes can roll the shared stamp BACK; the spacing then fails toward running, never toward skipping', async () => {
    // Replica B succeeded 1 h ago (fresh stamp); replica A still holds its own older success (20 h ago) in memory.
    await redis.hset(WORKER_STATS_KEY, STAMP, String(Date.now() - HOUR));
    const replicaA = new WorkerRuntime(redis, { metricsLogMs: 0 });
    runtimes.push(replicaA);
    replicaA.stats[STAMP] = Date.now() - 20 * HOUR;
    replicaA.writeStats(); // what every settle of ANY loop on replica A does in interval mode
    await new Promise((r) => setTimeout(r, 150));
    expect(Number(await redis.hget(WORKER_STATS_KEY, STAMP))).toBeLessThan(Date.now() - 19 * HOUR); // rolled back

    const runSpy = jest.spyOn(command, 'run');
    const outcome = await tick();
    expect(outcome.outcome).toBe('succeeded'); // an extra (duplicate) scan — the safe direction
    expect(runSpy).toHaveBeenCalledTimes(1);
  });
});
