/**
 * Phase D-Q3 — after-commit fast publish of notify()-generated email_outbox / push_delivery rows (WORKER_FAST_PUBLISH_NOTIFY).
 * Real PostgreSQL (RLS on), real Redis/BullMQ (this suite's own Redis DB index), the real NotificationService, the real
 * dispatchers. Only the flag is switched per case (EnvironmentService.get spied: the env is frozen at AppModule import).
 */
process.env.PUSH_ENABLED = 'true';

import './helpers/email-reliability-env'; // env is frozen when AppModule is imported (own Redis DB index)
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Job, Queue } from 'bullmq';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { EmailService } from '@rab/server/engine/core-modules/email/email.service';
import { EmailQueueService } from '@rab/server/engine/core-modules/email/email-queue.service';
import { EMAIL_QUEUE_NAME } from '@rab/server/engine/core-modules/email/email-queue.constants';
import { EnvironmentService } from '@rab/server/engine/core-modules/environment/environment.service';
import { PushDeviceService } from '@rab/server/engine/core-modules/push/push-device.service';
import { PushQueueService } from '@rab/server/engine/core-modules/push/push-queue.service';
import { PUSH_QUEUE_NAME } from '@rab/server/engine/core-modules/push/push-queue.constants';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { AuthContext } from '@rab/server/engine/core-modules/tenant/auth-context.interface';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { NotifyFastPublishService } from '@rab/server/modules/notification/services/notify-fast-publish.service';
import { NotificationType } from '@rab/shared';
import { createEmailSendProcessor } from '../../queues/rab-email/email-send.processor';
import { runEmailDispatchCycle } from '../../queues/rab-email/email-dispatch.job';
import { runPushDispatchCycle } from '../../queues/rab-push/push-dispatch.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { cancelLeftoverClaimableEmails } from './helpers/email-leftovers';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { integrationTestDatabaseReady } from '@rab/server/database/typeorm/core/integration-test-database-gate';

jest.setTimeout(90_000);
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('D-Q3 notify() after-commit fast publish (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let admin: DataSource;
  let tenantContext: TenantContextService;
  let notifications: NotificationService;
  let fast: NotifyFastPublishService;
  let env: EnvironmentService;
  let emailQueue: EmailQueueService;
  let pushQueue: PushQueueService;
  let pushDevices: PushDeviceService;
  let auditService: AuditService;
  let factory: TestIdentityFactory;
  let redis: Redis;
  let emailJobs: Queue;
  let pushJobs: Queue;
  let flag: unknown = false;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    await cancelLeftoverClaimableEmails(dataSource, tenantContext);
    notifications = moduleRef.get(NotificationService);
    fast = moduleRef.get(NotifyFastPublishService);
    env = moduleRef.get(EnvironmentService);
    emailQueue = moduleRef.get(EmailQueueService);
    pushQueue = moduleRef.get(PushQueueService);
    pushDevices = moduleRef.get(PushDeviceService);
    auditService = moduleRef.get(AuditService);
    admin = createAdminDataSource();
    await admin.initialize();
    factory = new TestIdentityFactory({
      app,
      dataSource,
      adminDataSource: admin,
      tenantContext,
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
    redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    emailJobs = new Queue(EMAIL_QUEUE_NAME, { connection: redis });
    pushJobs = new Queue(PUSH_QUEUE_NAME, { connection: redis });
    const realGet = env.get.bind(env) as (key: string) => unknown;
    jest
      .spyOn(env, 'get')
      .mockImplementation(((key: string) =>
        key === 'WORKER_FAST_PUBLISH_NOTIFY'
          ? flag
          : realGet(key)) as unknown as typeof env.get);
  });

  afterEach(() => {
    flag = false;
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await emailJobs.close();
    await pushJobs.close();
    await redis.quit();
    await app.close();
    await admin.destroy();
  });

  const ctxOf = (i: TestIdentity): AuthContext => ({
    organisationId: i.organisationId,
    workspaceId: i.workspaceId,
    userId: i.userId,
    role: '',
  });

  /** A recipient with the email preference ON (default off — set explicitly, never forced) and one active device. */
  async function recipient(
    label: string,
  ): Promise<{ org: { id: string }; user: TestIdentity }> {
    const org = await factory.createOrganisation(label);
    const user = await factory.createInternalManager(org, { label });
    await admin.query(
      `INSERT INTO core.notification_preference (organisation_id, user_id, notification_type, in_app_enabled, email_enabled) VALUES ($1, $2, $3, true, true)`,
      [org.id, user.userId, NotificationType.OFFER_SENT],
    );
    await pushDevices.register(ctxOf(user), {
      deviceId: `d-${randomUUID()}`,
      platform: 'ios',
      pushToken: `tok-${randomUUID()}`,
    });
    return { org, user };
  }

  const notifyIn = (
    m: EntityManager,
    org: { id: string },
    user: TestIdentity,
  ) =>
    notifications.notify(m, {
      organisationId: org.id,
      userId: user.userId,
      type: NotificationType.OFFER_SENT,
      title: 'Offer',
      message: `m-${randomUUID()}`,
    });

  async function rowsFor(
    userId: string,
  ): Promise<{
    email: Array<{ id: string; status: string; organisation_id: string }>;
    push: Array<{
      id: string;
      status: string;
      queued_at: Date | null;
      organisation_id: string;
    }>;
  }> {
    const email = await admin.query(
      `SELECT id, status, organisation_id FROM core.email_outbox WHERE target_user_id = $1 AND job_type = 'NOTIFICATION' ORDER BY created_at`,
      [userId],
    );
    const push = await admin.query(
      `SELECT pd.id, pd.status, pd.queued_at, pd.organisation_id FROM core.push_delivery pd JOIN core.notification n ON n.id = pd.notification_id WHERE n.user_id = $1 ORDER BY pd.created_at`,
      [userId],
    );
    return { email, push };
  }
  const emailJob = (id: string, gen = 0) =>
    emailJobs.getJob(`email-outbox.${id}.attempt.${gen}`);
  const pushJob = (id: string, gen = 0) =>
    pushJobs.getJob(`push-delivery.${id}.attempt.${gen}`);
  /** Detached publishes settle within a few ms locally; poll briefly instead of a fixed sleep. */
  async function eventually<T>(
    read: () => Promise<T>,
    ok: (v: T) => boolean,
    ms = 3_000,
  ): Promise<T> {
    const until = Date.now() + ms;
    let v = await read();
    while (!ok(v) && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 50));
      v = await read();
    }
    return v;
  }
  const settle = () => new Promise((r) => setTimeout(r, 400));

  it('F1 flag OFF (default): identical to today — rows written, nothing published by the request', async () => {
    const { org, user } = await recipient('fp-off');
    await tenantContext.runInTenantContext(ctxOf(user), (m) =>
      notifyIn(m, org, user),
    );
    await settle();
    const rows = await rowsFor(user.userId);
    expect(rows.email).toHaveLength(1);
    expect(rows.push).toHaveLength(1);
    expect(await emailJob(rows.email[0]!.id)).toBeUndefined();
    expect(await pushJob(rows.push[0]!.id)).toBeUndefined();
    expect(rows.email[0]!.status).toBe('PENDING');
    expect(rows.push[0]!).toMatchObject({ status: 'PENDING', queued_at: null });
  });

  it("F2 flag ON: published only AFTER commit (nothing while the transaction is open), with the dispatcher's first-publish jobId; no status written", async () => {
    flag = true;
    const { org, user } = await recipient('fp-on');
    let duringTx: { email: number; push: number } | null = null;
    await tenantContext.runInTenantContext(ctxOf(user), async (m) => {
      await notifyIn(m, org, user);
      expect(fast.heldFor(m.queryRunner)).toBe(2); // one email + one push, held for the commit
      await settle();
      const email = await emailJobs.getJobs([
        'waiting',
        'delayed',
        'active',
        'completed',
        'failed',
      ]);
      const push = await pushJobs.getJobs([
        'waiting',
        'delayed',
        'active',
        'completed',
        'failed',
      ]);
      const mine = (jobs: Job[], key: string) =>
        jobs.filter(
          (j) =>
            (j.data as Record<string, string>).organisationId === org.id &&
            key in (j.data as object),
        ).length;
      duringTx = {
        email: mine(email, 'emailOutboxId'),
        push: mine(push, 'pushDeliveryId'),
      };
    });
    expect(duringTx).toEqual({ email: 0, push: 0 });
    const rows = await rowsFor(user.userId);
    const ej = await eventually(
      () => emailJob(rows.email[0]!.id),
      (j) => Boolean(j),
    );
    const pj = await eventually(
      () => pushJob(rows.push[0]!.id),
      (j) => Boolean(j),
    );
    // Ids only, from the committed row (tenant scope = the row's own organisation).
    expect(ej!.data).toEqual({
      emailOutboxId: rows.email[0]!.id,
      organisationId: org.id,
    });
    expect(pj!.data).toEqual({
      pushDeliveryId: rows.push[0]!.id,
      organisationId: org.id,
    });
    expect(ej!.opts.attempts).toBe(5);
    expect(pj!.opts.attempts).toBe(5);
    // Never marked queued/delivered by the fast path: the database is untouched.
    const after = await rowsFor(user.userId);
    expect(after.email[0]!.status).toBe('PENDING');
    expect(after.push[0]!).toMatchObject({
      status: 'PENDING',
      queued_at: null,
    });
  });

  it('F3 flag ON + ROLLBACK: nothing is published (and no row exists)', async () => {
    flag = true;
    const { org, user } = await recipient('fp-rb');
    let held = 0;
    await expect(
      tenantContext.runInTenantContext(ctxOf(user), async (m) => {
        await notifyIn(m, org, user);
        held = fast.heldFor(m.queryRunner);
        throw new Error('business rule refused after notify()');
      }),
    ).rejects.toThrow('business rule refused');
    expect(held).toBe(2);
    await settle();
    const rows = await rowsFor(user.userId);
    expect(rows.email).toHaveLength(0);
    expect(rows.push).toHaveLength(0);
    const all = [
      ...(await emailJobs.getJobs([
        'waiting',
        'delayed',
        'active',
        'completed',
        'failed',
      ])),
      ...(await pushJobs.getJobs([
        'waiting',
        'delayed',
        'active',
        'completed',
        'failed',
      ])),
    ];
    expect(
      all.filter(
        (j) => (j.data as Record<string, string>).organisationId === org.id,
      ),
    ).toHaveLength(0);
  });

  it('F4 flag ON + a rolled-back SAVEPOINT inside the transaction: everything held is discarded; the dispatcher publishes what committed', async () => {
    flag = true;
    const { org, user } = await recipient('fp-sp');
    await tenantContext.runInTenantContext(ctxOf(user), async (m) => {
      await notifyIn(m, org, user); // outer: commits
      await m
        .transaction(async (inner) => {
          await notifyIn(inner, org, user);
          throw new Error('inner refused');
        })
        .catch(() => undefined);
      expect(fast.heldFor(m.queryRunner)).toBe(0);
    });
    await settle();
    const rows = await rowsFor(user.userId);
    expect(rows.email).toHaveLength(1);
    expect(await emailJob(rows.email[0]!.id)).toBeUndefined();
    await runEmailDispatchCycle(
      dataSource,
      tenantContext,
      (id, o) => emailQueue.publish(id, o),
      (id, o, g) => emailQueue.republish(id, o, g),
      true,
    );
    expect(await emailJob(rows.email[0]!.id)).toBeDefined();
  });

  it('F5 flag ON + Redis down/slow: the request succeeds at once; the row is published later by the dispatcher', async () => {
    flag = true;
    const { org, user } = await recipient('fp-down');
    const hang = new Promise<void>(() => undefined); // a publish that never returns (Redis stalled)
    const emailSpy = jest
      .spyOn(emailQueue, 'publish')
      .mockImplementationOnce(() => hang);
    const pushSpy = jest
      .spyOn(pushQueue, 'publish')
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error('Connection is closed.'), {
          name: 'Error',
        });
      });
    const started = Date.now();
    await tenantContext.runInTenantContext(ctxOf(user), (m) =>
      notifyIn(m, org, user),
    );
    expect(Date.now() - started).toBeLessThan(2_000); // never waits for the publish
    await settle();
    expect(emailSpy).toHaveBeenCalledTimes(1);
    const rows = await rowsFor(user.userId);
    expect(await emailJob(rows.email[0]!.id)).toBeUndefined();
    expect(await pushJob(rows.push[0]!.id)).toBeUndefined();
    expect(rows.email[0]!.status).toBe('PENDING');
    // Concurrent flush: the hanging email publish did not hold back the push publish (which failed).
    expect(pushSpy).toHaveBeenCalledTimes(1);
    emailSpy.mockRestore();
    pushSpy.mockRestore();
    // Redis back: the dispatchers publish exactly as today.
    await runEmailDispatchCycle(
      dataSource,
      tenantContext,
      (id, o) => emailQueue.publish(id, o),
      (id, o, g) => emailQueue.republish(id, o, g),
      true,
    );
    await runPushDispatchCycle(
      dataSource,
      tenantContext,
      (id, o) => pushQueue.publish(id, o),
      (id, o, g) => pushQueue.republish(id, o, g),
      false,
    );
    expect(await emailJob(rows.email[0]!.id)).toBeDefined();
    expect(await pushJob(rows.push[0]!.id)).toBeDefined();
    const after = await rowsFor(user.userId);
    expect(after.email[0]!.status).toBe('QUEUED');
    expect(after.push[0]!.queued_at).not.toBeNull();
  });

  it('F6 duplicate publish (fast path + dispatcher): ONE job per row, ONE delivery', async () => {
    flag = true;
    const { org, user } = await recipient('fp-dup');
    await tenantContext.runInTenantContext(ctxOf(user), (m) =>
      notifyIn(m, org, user),
    );
    const rows = await rowsFor(user.userId);
    await eventually(
      () => emailJob(rows.email[0]!.id),
      (j) => Boolean(j),
    );
    await eventually(
      () => pushJob(rows.push[0]!.id),
      (j) => Boolean(j),
    );
    // The dispatchers then see the rows (email PENDING → QUEUED; push queued_at stamped) and add the SAME jobIds.
    await runEmailDispatchCycle(
      dataSource,
      tenantContext,
      (id, o) => emailQueue.publish(id, o),
      (id, o, g) => emailQueue.republish(id, o, g),
      true,
    );
    await runPushDispatchCycle(
      dataSource,
      tenantContext,
      (id, o) => pushQueue.publish(id, o),
      (id, o, g) => pushQueue.republish(id, o, g),
      false,
    );
    const count = async (q: Queue, key: string, id: string) =>
      (
        await q.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'])
      ).filter((j) => (j.data as Record<string, string>)[key] === id).length;
    expect(await count(emailJobs, 'emailOutboxId', rows.email[0]!.id)).toBe(1);
    expect(await count(pushJobs, 'pushDeliveryId', rows.push[0]!.id)).toBe(1);
    // Two deliveries of the same email job (fast + dispatcher racing the consumer) send once (DB compare-and-set).
    const calls: string[] = [];
    const provider = {
      send: async (o: { to: string }) => {
        calls.push(o.to);
        return { provider: 'RESEND', providerMessageId: `m${calls.length}` };
      },
      ambiguousDeliverySafeToRetry: true,
    } as unknown as EmailService;
    const send = createEmailSendProcessor({
      tenantContext,
      emailService: provider,
      auditService,
    });
    const job = {
      id: 'x',
      data: { emailOutboxId: rows.email[0]!.id, organisationId: org.id },
      attemptsMade: 0,
      opts: { attempts: 5 },
    } as unknown as Job;
    await send(job);
    await send(job);
    expect(calls).toHaveLength(1);
  });

  it('F7 suspended organisation: notify() writes nothing, so nothing is published', async () => {
    flag = true;
    const { org, user } = await recipient('fp-susp');
    await admin.query(
      `UPDATE core.organisation SET suspended_at = now(), suspended_by = $2, suspended_reason = 'd-q3 test' WHERE id = $1`,
      [org.id, user.userId],
    );
    try {
      await tenantContext.runInTenantContext(ctxOf(user), async (m) => {
        await notifyIn(m, org, user);
        expect(fast.heldFor(m.queryRunner)).toBe(0);
      });
      await settle();
      const rows = await rowsFor(user.userId);
      expect(rows.email).toHaveLength(0);
      expect(rows.push).toHaveLength(0);
    } finally {
      await admin.query(
        `UPDATE core.organisation SET suspended_at = NULL, suspended_by = NULL, suspended_reason = NULL WHERE id = $1`,
        [org.id],
      );
    }
  });

  it("F8 tenant isolation: the fast-published job carries only ids of the committed row; another organisation's context cannot see that row (RLS), no context sees nothing", async () => {
    flag = true;
    const a = await recipient('fp-iso-a');
    const b = await recipient('fp-iso-b');
    await tenantContext.runInTenantContext(ctxOf(a.user), (m) =>
      notifyIn(m, a.org, a.user),
    );
    const rows = await rowsFor(a.user.userId);
    const ej = await eventually(
      () => emailJob(rows.email[0]!.id),
      (j) => Boolean(j),
    );
    expect(Object.keys(ej!.data).sort()).toEqual([
      'emailOutboxId',
      'organisationId',
    ]);
    expect(ej!.data.organisationId).toBe(a.org.id);
    const seenByB = await tenantContext.runInTenantContext(ctxOf(b.user), (m) =>
      m.query(`SELECT id FROM core.email_outbox WHERE id = $1`, [
        rows.email[0]!.id,
      ]),
    );
    expect(seenByB).toHaveLength(0);
    const unbound = await dataSource.transaction((m) =>
      m.query(`SELECT id FROM core.push_delivery WHERE id = $1`, [
        rows.push[0]!.id,
      ]),
    );
    expect(unbound).toHaveLength(0);
    // A job naming organisation B for A's row is refused by the consumer (not visible ⇒ throw/retry), never sent.
    const calls: string[] = [];
    const provider = {
      send: async (o: { to: string }) => {
        calls.push(o.to);
        return { provider: 'RESEND', providerMessageId: 'x' };
      },
      ambiguousDeliverySafeToRetry: true,
    } as unknown as EmailService;
    const send = createEmailSendProcessor({
      tenantContext,
      emailService: provider,
      auditService,
    });
    await expect(
      send({
        id: 'y',
        data: { emailOutboxId: rows.email[0]!.id, organisationId: b.org.id },
        attemptsMade: 0,
        opts: { attempts: 5 },
      } as unknown as Job),
    ).rejects.toBeDefined();
    expect(calls).toHaveLength(0);
  });

  it('F9 outside a transaction nothing is registered (the dispatcher publishes)', async () => {
    flag = true;
    const { org, user } = await recipient('fp-notx');
    const registered = fast.afterCommitEmail(dataSource.manager, {
      id: randomUUID(),
      organisationId: org.id,
    });
    expect(registered).toBe(false);
    expect(user.userId).toBeTruthy();
  });
});
