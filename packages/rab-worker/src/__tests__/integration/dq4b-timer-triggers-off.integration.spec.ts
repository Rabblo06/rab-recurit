/**
 * Phase D-Q4b — WORKER_TIMER_TRIGGERS unset (= off, the default): today exactly. Sending and accepting offers adds NO
 * trigger job and opens no trigger queue in Redis; the Worker's consumer predicate (main.ts) creates no trigger consumer.
 * Real PostgreSQL + Redis (this suite's own DB index).
 */
import './helpers/timer-triggers-off-env'; // first: the env is frozen when AppModule is imported
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ShiftStatus } from '@rab/shared';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '@rab/server/engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { TimerTriggerQueueService } from '@rab/server/engine/core-modules/timer-trigger/timer-trigger-queue.service';
import { TIMER_TRIGGER_QUEUE_NAME } from '@rab/server/engine/worker-shared/timer-trigger.contract';
import { OfferService } from '@rab/server/modules/offer/services/offer.service';
import { JobRole } from '@rab/server/modules/scheduling/entities/job-role.entity';
import { Shift } from '@rab/server/modules/scheduling/entities/shift.entity';
import { Venue } from '@rab/server/modules/venue/entities/venue.entity';
import { createConsumerWorkers } from '../../core/scheduler/bullmq-scheduler';
import { buildHandlerRegistry } from '../../core/scheduler/processor-explorer';
import { CONSUMER_QUEUES } from '../../core/scheduler/queue-registry';
import { createAdminDataSource } from './helpers/admin-datasource';
import { createTestIdentityFactory, TestIdentity } from './helpers/test-identities';
import { integrationTestDatabaseReady } from '@rab/server/database/typeorm/core/integration-test-database-gate';

const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(120_000);

describeIfDb('D-Q4b WORKER_TIMER_TRIGGERS=off (default): no trigger job, no consumer (integration)', () => {
  let app: import('@nestjs/common').INestApplication;
  let admin: DataSource;
  let redis: Redis;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    admin = createAdminDataSource();
    await admin.initialize();
    redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    await redis.flushdb();
  }, 90_000);

  afterAll(async () => {
    await redis?.quit();
    await app?.close();
    await admin?.destroy();
  });

  it('send + accept an offer: the producer is off, opens no connection, and Redis holds no trigger key', async () => {
    const producer = app.get(TimerTriggerQueueService);
    expect(producer.settings.mode).toBe('off');
    expect((producer as unknown as { connection: unknown }).connection).toBeNull();

    const dataSource = app.get(DataSource);
    const tenantContext = app.get(TenantContextService);
    const offers = app.get(OfferService);
    const factory = createTestIdentityFactory({ app, dataSource, adminDataSource: admin, tenantContext, passwordHashing: app.get(PasswordHashingService) });
    const org = await factory.createOrganisation('dq4bOff');
    const manager = await factory.createInternalManager(org, { permissions: 'production', label: 'dq4bOff' });
    const staff = await factory.createStaff({ id: org.id }, { owner: manager, label: 'dq4bOff' });
    const ctx = (i: TestIdentity, role: string): AuthContext => ({ organisationId: i.organisationId, workspaceId: i.workspaceId, userId: i.userId, role });
    const shiftId = await tenantContext.runInTenantContext({ ...ctx(manager, ''), role: '' }, async (m) => {
      const venue = await m.save(Venue, { organisationId: org.id, name: 'Off Venue', createdBy: manager.userId, workspaceId: manager.workspaceId! });
      const role = await m.save(JobRole, { organisationId: org.id, name: `Role ${randomUUID().slice(0, 6)}`, defaultRatePence: 1500, createdBy: manager.userId, workspaceId: manager.workspaceId! });
      const startsAt = new Date(Date.now() + 3 * 3600_000);
      const shift = await m.save(Shift, {
        organisationId: org.id, venueId: venue.id, jobRoleId: role.id, startsAt, endsAt: new Date(startsAt.getTime() + 8 * 3600_000),
        breakMinutes: 0, requiredCount: 1, payRatePence: 1500, status: ShiftStatus.OPEN, createdBy: manager.userId, workspaceId: manager.workspaceId!,
      });
      return shift.id;
    });
    const offer = await offers.send(ctx(manager, 'manager'), shiftId, { staffProfileId: staff.profileId! });
    await offers.staffAccept(ctx(staff, 'staff'), offer.id);
    await new Promise((r) => setTimeout(r, 500));
    expect(await redis.keys(`bull:${TIMER_TRIGGER_QUEUE_NAME}:*`)).toEqual([]);
  });

  it("main.ts's consumer predicate with mode off creates no trigger consumer (the other consumers are unaffected)", async () => {
    const mode: string = 'off';
    // X1.1: main.ts also skips the audit-event consumer when this process has no sink (CREWFLOW_AUDIT_SINK=none, as here).
    const auditSinkMode: string = 'none';
    const registry = buildHandlerRegistry(
      Object.values(CONSUMER_QUEUES).map((q) => ({ queue: q.name, jobName: q.jobName, source: `test.${q.key}`, handler: async () => undefined })),
    );
    const workers = createConsumerWorkers(registry, redis, { log: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger, (def) => (def.key !== 'timerTriggers' || mode !== 'off') && (def.key !== 'auditEvents' || auditSinkMode !== 'none'));
    try {
      expect([...workers.keys()]).toEqual(['email', 'push', 'shiftStatements', 'ai']);
    } finally {
      for (const w of workers.values()) await w.close();
    }
  });
});
