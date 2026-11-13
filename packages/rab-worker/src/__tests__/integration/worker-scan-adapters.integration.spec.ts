import './helpers/email-reliability-env'; // FIRST: env is frozen when a module reading it is imported
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';

import { AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { EmailOutboxService } from '@rab/server/engine/core-modules/email/email-outbox.service';
import { EmailQueueService } from '@rab/server/engine/core-modules/email/email-queue.service';
import { EmailService } from '@rab/server/engine/core-modules/email/email.service';
import { EnvironmentService } from '@rab/server/engine/core-modules/environment/environment.service';
import { PushDeviceService } from '@rab/server/engine/core-modules/push/push-device.service';
import { PushQueueService } from '@rab/server/engine/core-modules/push/push-queue.service';
import { PushService } from '@rab/server/engine/core-modules/push/push.service';
import { RealtimeEventService } from '@rab/server/engine/core-modules/realtime/realtime-event.service';
import { SecretEncryptionService } from '@rab/server/engine/core-modules/secret-encryption/secret-encryption.service';
import { FileService } from '@rab/server/engine/core-modules/storage/file.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { AttendanceQrService } from '@rab/server/modules/attendance/services/attendance-qr.service';
import { QrImageService } from '@rab/server/modules/attendance/services/qr-image.service';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { StorageReconcileCommand } from '@rab/server/command/storage-reconcile.command';
import { SHIFT_STATEMENT_QUEUE_NAME } from '@rab/server/modules/payroll/constants/shift-statement';
import { ScanLock } from '../../core/locking/scan-lock';
import { WorkerRuntime } from '../../core/runtime/worker-runtime';
import { loopOptionsOf } from '../../core/scheduler/bullmq-scheduler';
import { ProcessorExplorer, validateHandlerRegistry } from '../../core/scheduler/processor-explorer';
import { resolveIntervalMs, SCAN_JOBS, schedulerIdOf } from '../../core/scheduler/scan-jobs';
import { WorkerDependencies } from '../../core/scheduler/worker-dependencies';
import { WorkerModule } from '../../worker.module';
import { EXPECTED_HANDLERS, EXPECTED_SCAN_SCHEDULER_IDS, SEPARATE_MODE_SCAN_IDS } from './helpers/expected-scan-jobs';
import { integrationTestDatabaseReady } from '@rab/server/database/typeorm/core/integration-test-database-gate';

/**
 * Lane A M3/M7: the REAL WorkerModule graph discovers all scan handlers + 5 consumer handlers (D-Q4b: + crewflow-timer-triggers) (no duplicates, no
 * gaps; AI Phase 1 added the `ai-retention` scan and the `rab-ai` consumer), and every real adapter runs its real cycle
 * once through the bullmq-mode path (runtime.runOnce + the per-scan advisory lock) as the restricted crewflow_app role, against the disposable test database. Interval mode uses the same
 * adapters, so this also proves the interval path's handlers resolve.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(180_000);

describeIfDb('real WorkerModule: discovery + every scan adapter as crewflow_app (integration)', () => {
  let moduleRef: TestingModule | undefined;
  let direct: DataSource | undefined;
  let redis: Redis | undefined;
  let publisher: Redis | undefined;
  let statementQueue: Queue | undefined;
  let lock: ScanLock | undefined;

  afterAll(async () => {
    await statementQueue?.close();
    await lock?.close();
    await direct?.destroy();
    await publisher?.quit();
    await redis?.quit();
    await moduleRef?.close();
  });

  it('discovers exactly the registered handlers and runs all 21 cycles without a failure', async () => {
    moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    await moduleRef.init();
    const runtimeDataSource = moduleRef.get(DataSource);
    const [{ current_user: role }] = await runtimeDataSource.query('SELECT current_user');
    // BC-02 (owner-login architecture): the one runtime login is crewflow_owner; crewflow_app / crewflow_worker are schema roles.
    expect(role).toBe('crewflow_owner');
    direct = new DataSource({ type: 'postgres', url: process.env.DATABASE_URL, schema: 'core', entities: [], synchronize: false });
    await direct.initialize();
    redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    publisher = redis.duplicate();
    statementQueue = new Queue(SHIFT_STATEMENT_QUEUE_NAME, { connection: redis });
    const env = moduleRef.get(EnvironmentService);
    const g = <T>(t: new (...a: never[]) => T) => moduleRef!.get(t, { strict: false });
    moduleRef.get(WorkerDependencies).provide({
      logger: new Logger('RabWorkerTest'),
      runtimeDataSource,
      directDataSource: direct,
      tenantContext: g(TenantContextService),
      auditService: g(AuditService),
      notificationService: g(NotificationService),
      environmentService: env,
      realtimeEventService: g(RealtimeEventService),
      emailService: g(EmailService),
      emailQueue: g(EmailQueueService),
      emailOutboxService: g(EmailOutboxService),
      pushService: g(PushService),
      pushQueue: g(PushQueueService),
      pushDeviceService: g(PushDeviceService),
      secretEncryptionService: g(SecretEncryptionService),
      fileService: g(FileService),
      attendanceQrService: g(AttendanceQrService),
      qrImageService: g(QrImageService),
      storageReconcileCommand: g(StorageReconcileCommand),
      realtimePublish: (channel, message) => publisher!.publish(channel, message),
      shiftStatementQueue: statementQueue as never,
    });

    const registry = moduleRef.get(ProcessorExplorer).explore();
    expect(() => validateHandlerRegistry(registry)).not.toThrow();
    // By name, not just a count: exactly these 29 handlers (23 scans incl. ai-retention, workspace-provisioning-health, D-Q2's ai-stale-turn-sweep and D-Q4a's shift-scan-combined + 6 consumers incl. rab-ai, D-Q4b's timer triggers and X1.1's audit events).
    const discovered = [...registry.handlers.values()].map((h) => `${h.queue}/${h.jobName}`);
    expect(discovered.sort()).toEqual([...EXPECTED_HANDLERS].sort());
    expect(registry.handlers.size).toBe(29);
    expect(registry.get('crewflow-scan-maintenance', 'ai-retention')).toBeDefined();
    expect(registry.get('rab-ai', 'ai-turn')).toBeDefined();
    // ...and every scan that will be scheduled is exactly the expected set.
    expect(SCAN_JOBS.map(schedulerIdOf)).toEqual([...EXPECTED_SCAN_SCHEDULER_IDS]);

    lock = await ScanLock.open({ connectionString: process.env.DATABASE_URL! }, { log: () => undefined, warn: () => undefined });
    const runtime = new WorkerRuntime(redis, { statsKey: 'lane-a-it:stats', statsWrite: 'fields', metricsLogMs: 0 });
    const errors: unknown[] = [];
    jest.spyOn((runtime as unknown as { logger: Logger }).logger, 'error').mockImplementation((_m, e) => void errors.push(e));
    const outcomes: Record<string, string> = {};
    // D-Q4a: the combined scan's handler is replaced by main.ts only in combined mode; unwired it fails closed
    // (shift-scan-combined.spec.ts). Every other scan runs here, as before.
    for (const def of SCAN_JOBS.filter((d) => d.shiftScanMode !== 'combined')) {
      outcomes[def.jobName] = await runtime.runOnce(loopOptionsOf(def, registry.scan(def), resolveIntervalMs(def, env)), (work) => lock!.run(schedulerIdOf(def), work));
    }
    expect(errors).toEqual([]);
    for (const [job, outcome] of Object.entries(outcomes)) expect([job, ['succeeded', 'idle']]).toEqual([job, expect.arrayContaining([outcome])]);
    // The disabled-by-default retention job never shows as a successful run.
    expect(outcomes['outbox-retention']).toBe('idle');
    // Same contract for AI retention (AI_RETENTION_MODE=off by default ⇒ the cycle returns false, never stamped).
    expect(Object.keys(outcomes).sort()).toEqual(SEPARATE_MODE_SCAN_IDS.map((id) => id.split(':')[2]!).sort());
    expect(outcomes['ai-retention']).toBe('idle');
    // D-Q2: the AI stale-turn sweep is off by default (AI_STALE_TURN_SWEEP=false ⇒ the cycle returns false, never stamped).
    expect(outcomes['ai-stale-turn-sweep']).toBe('idle');
    const stats = await redis.hgetall('lane-a-it:stats');
    expect(stats.lastOutboxRetentionAt).toBeUndefined();
    expect(stats.lastAiRetentionAt).toBeUndefined();
    expect(stats.lastAiStaleTurnSweepAt).toBeUndefined();
    expect(Number(stats.lastShiftMonitorAt)).toBeGreaterThan(0);
    await redis.del('lane-a-it:stats');
  });
});
