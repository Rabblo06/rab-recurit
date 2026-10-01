import './helpers/email-reliability-env'; // FIRST: env is frozen when AppModule is imported
import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Job, Queue, QueueEvents, Worker } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { join, resolve } from 'node:path';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { EmailSendResult } from '@rab/server/engine/core-modules/email/drivers/interfaces/email-driver.interface';
import { EmailOutboxService } from '@rab/server/engine/core-modules/email/email-outbox.service';
import { EmailService } from '@rab/server/engine/core-modules/email/email.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { AuthContext } from '@rab/server/engine/core-modules/tenant/auth-context.interface';
import {
  EmailOutbox,
  Organisation,
} from '@rab/server/modules/identity/entities/index';
import { EmailOutboxJobType, EmailOutboxStatus } from '@rab/shared';
import { runEmailDispatchCycle } from '../../queues/rab-email/email-dispatch.job';
import {
  createEmailSendProcessor,
  deliveryKeyFor,
} from '../../queues/rab-email/email-send.processor';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * PHASE 9 — email delivery reliability. Reproduces the confirmed defect
 * (provider succeeds, persisting SENT fails, the row gets stuck PROCESSING
 * because the old BullMQ job's terminal state blocks a naive republish) and
 * proves the fix at three layers:
 *
 *   A. EmailQueueService's jobId/generation mechanics — REAL BullMQ, REAL
 *      local Redis (a dedicated DB index — see helpers/email-reliability-env.ts
 *      — so this never touches the actual `rab-email` queue any other
 *      locally-running server/worker container might be processing).
 *   B. email-send.processor.ts's delivery fencing — real Postgres, a FAKE
 *      EmailService (no real send needed to prove DB-side correctness), a
 *      plain object standing in for a BullMQ `Job`.
 *   C. email-dispatch.job.ts's ambiguous-delivery classification — real
 *      Postgres, spy publish/republish callbacks (no real BullMQ needed to
 *      prove which rows get republished vs marked DELIVERY_UNCERTAIN).
 *
 * No 7-day sleep anywhere: BullMQ retention is proven by directly driving a
 * job to 'completed' with a real (trivial) Worker, then observing `.add()`
 * with the same id — the exact mechanism, not a simulation of it.
 */
jest.setTimeout(60_000);

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('email delivery reliability (Phase 9)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let auditService: AuditService;
  let factory: TestIdentityFactory;
  let org: Organisation;
  let owner: TestIdentity;
  let staff: TestIdentity;
  let ctx: AuthContext;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    auditService = moduleRef.get(AuditService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({
      app,
      dataSource,
      adminDataSource,
      tenantContext,
      passwordHashing: moduleRef.get(PasswordHashingService),
    });

    org = await factory.createOrganisation('e9');
    owner = await factory.createInternalManager(org);
    staff = await factory.createStaff(org, { owner });
    ctx = {
      organisationId: org.id,
      workspaceId: owner.workspaceId!,
      userId: owner.userId,
      role: '',
    };
  });

  let sqlObservation: jest.SpyInstance;
  async function assertRls(): Promise<void> {
    const [flags] = await dataSource.query(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'core.email_outbox'::regclass",
    );
    expect(flags).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect(await dataSource.query('SELECT id FROM core.email_outbox')).toEqual(
      [],
    );
  }
  beforeEach(async () => {
    await assertRls();
    sqlObservation = jest.spyOn(dataSource.logger, 'logQuery');
  });
  afterEach(async () => {
    const queries = sqlObservation.mock.calls.map((c) => String(c[0]));
    sqlObservation.mockRestore();
    expect(
      queries.filter((q) =>
        /ALTER\s+TABLE[\s\S]*ROW\s+LEVEL\s+SECURITY/i.test(q),
      ),
    ).toEqual([]);
    await assertRls();
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  // ------------------------------------------------------------------------------------------------ helpers
  const outboxService = () => new EmailOutboxService();
  async function seedRow(
    overrides: Partial<{ recipientEmail: string }> = {},
  ): Promise<EmailOutbox> {
    return tenantContext.runInTenantContext(ctx, (m) =>
      outboxService().enqueue(m, {
        organisationId: org.id,
        jobType: EmailOutboxJobType.NOTIFICATION,
        recipientEmail: overrides.recipientEmail ?? 'staff@example.test',
        targetUserId: staff.userId,
        rendered: { subject: 'Test', html: '<p>hi</p>', text: 'hi' },
      }),
    );
  }
  const rowOf = (id: string) =>
    tenantContext.runInTenantContext(ctx, (m) =>
      m.findOneByOrFail(EmailOutbox, { id }),
    );
  const fakeJob = (outboxId: string, attemptsMade = 0, attempts = 5) =>
    ({
      id: outboxId,
      data: { emailOutboxId: outboxId, organisationId: org.id },
      attemptsMade,
      opts: { attempts },
    }) as unknown as Job;
  const fakeEmailService = (
    send: (options: { idempotencyKey: string }) => Promise<EmailSendResult>,
  ) =>
    ({ send, ambiguousDeliverySafeToRetry: true }) as unknown as EmailService;
  /** Directly steals ownership of a row's fencing token — simulates "another claim already reclaimed this row while we were mid-flight," without needing real concurrent workers. */
  const stealToken = (id: string) =>
    tenantContext.runInTenantContext(ctx, (m) =>
      m.query(
        `UPDATE core.email_outbox SET processing_token = gen_random_uuid() WHERE id = $1`,
        [id],
      ),
    );
  const markStale = (
    id: string,
    column: 'processing_at' | 'updated_at',
    minutesAgo: number,
  ) =>
    tenantContext.runInTenantContext(ctx, (m) =>
      m.query(
        `UPDATE core.email_outbox SET ${column} = now() - interval '${minutesAgo} minutes' WHERE id = $1`,
        [id],
      ),
    );

  // ================================================================================================ A. BullMQ jobId / generation mechanics
  describe('A. EmailQueueService jobId/generation mechanics (real BullMQ, isolated Redis DB 9)', () => {
    const QUEUE_NAME = `phase9-test-${randomUUID().slice(0, 8)}`;
    let connection: Redis;
    let queue: Queue;
    let worker: Worker;
    let events: QueueEvents;

    beforeAll(async () => {
      connection = new Redis(process.env.REDIS_URL!, {
        maxRetriesPerRequest: null,
      });
      queue = new Queue(QUEUE_NAME, { connection });
      events = new QueueEvents(QUEUE_NAME, { connection });
      await events.waitUntilReady();
      worker = new Worker(QUEUE_NAME, async () => 'ok', {
        connection,
        concurrency: 5,
      });
      await worker.waitUntilReady();
    });
    afterAll(async () => {
      await worker.close();
      await events.close();
      await queue.close();
      await connection.quit();
    });

    it('A1: publish() (attempt:0) called twice for the same row dedupes — BullMQ returns the existing job, never a second one', async () => {
      const id = randomUUID();
      const jobId = `email-outbox.${id}.attempt.0`;
      const first = await queue.add(
        'send-email',
        { emailOutboxId: id },
        { jobId, removeOnComplete: { age: 3600 } },
      );
      const second = await queue.add(
        'send-email',
        { emailOutboxId: id },
        { jobId, removeOnComplete: { age: 3600 } },
      );
      expect(second.id).toBe(first.id);
      await first.waitUntilFinished(events, 10_000);
    });

    it('A2: THE CONFIRMED BUG, reproduced directly — once attempt:0 has COMPLETED, publishing the SAME jobId again is a silent no-op (nothing new runs)', async () => {
      const id = randomUUID();
      const jobId = `email-outbox.${id}.attempt.0`;
      const completed = await queue.add(
        'send-email',
        { emailOutboxId: id },
        { jobId, removeOnComplete: { age: 3600 } },
      );
      await completed.waitUntilFinished(events, 10_000);
      expect(await completed.getState()).toBe('completed');

      // This is exactly what the OLD dispatcher recovery did: republish using the SAME stable jobId.
      const republishAttempt = await queue.add(
        'send-email',
        { emailOutboxId: id },
        { jobId, removeOnComplete: { age: 3600 } },
      );
      expect(republishAttempt.id).toBe(completed.id); // same (already-completed) job handed back — no new run was scheduled
      expect(await republishAttempt.getState()).toBe('completed'); // still just sitting there completed, not re-queued
    });

    it('A3: THE FIX — a generation-bumped jobId escapes the old completed job entirely and runs for real', async () => {
      const id = randomUUID();
      const completed = await queue.add(
        'send-email',
        { emailOutboxId: id },
        {
          jobId: `email-outbox.${id}.attempt.0`,
          removeOnComplete: { age: 3600 },
        },
      );
      await completed.waitUntilFinished(events, 10_000);

      const recovered = await queue.add(
        'send-email',
        { emailOutboxId: id },
        {
          jobId: `email-outbox.${id}.attempt.1`,
          removeOnComplete: { age: 3600 },
        },
      );
      expect(recovered.id).not.toBe(completed.id); // a genuinely new, distinct job
      await recovered.waitUntilFinished(events, 10_000);
      expect(await recovered.getState()).toBe('completed'); // and it actually ran
    });
  });

  // ================================================================================================ B. Processor-level fencing
  describe('B. email-send.processor.ts delivery fencing', () => {
    it('B1: a normal successful send persists SENT with provider + providerMessageId captured', async () => {
      const row = await seedRow();
      const processor = createEmailSendProcessor({
        tenantContext,
        emailService: fakeEmailService(async () => ({
          provider: 'RESEND',
          providerMessageId: 'msg_123',
        })),
        auditService,
      });
      await processor(fakeJob(row.id));
      const after = await rowOf(row.id);
      expect(after.status).toBe(EmailOutboxStatus.SENT);
      expect(after.provider).toBe('RESEND');
      expect(after.providerMessageId).toBe('msg_123');
      expect(after.providerCallStartedAt).toBeTruthy();
    });

    it('B2: provider_call_started_at is set BEFORE the provider is called, and stays NULL for a row that never reaches the provider (revalidation fails first)', async () => {
      // Target user deleted before delivery — revalidation must reject before any provider_call_started_at write.
      const deadTargetRow = await tenantContext.runInTenantContext(
        ctx,
        async (m) => {
          const deadStaff = await factory.createStaff(org, { owner });
          const r = await outboxService().enqueue(m, {
            organisationId: org.id,
            jobType: EmailOutboxJobType.NOTIFICATION,
            recipientEmail: 'ghost@example.test',
            targetUserId: deadStaff.userId,
            rendered: { subject: 'x', text: 'x' },
          });
          await m.query(`DELETE FROM core."user" WHERE id = $1`, [
            deadStaff.userId,
          ]);
          return r;
        },
      );
      const neverCalled = fakeEmailService(async () => {
        throw new Error(
          'must never be called — revalidation should have cancelled this row first',
        );
      });
      const processor = createEmailSendProcessor({
        tenantContext,
        emailService: neverCalled,
        auditService,
      });
      await processor(fakeJob(deadTargetRow.id));
      const after = await rowOf(deadTargetRow.id);
      expect(after.status).toBe(EmailOutboxStatus.CANCELLED);
      expect(after.providerCallStartedAt).toBeFalsy();
    });

    it('B3: a stale worker whose fencing token was superseded mid-send does NOT overwrite the newer claim with SENT', async () => {
      const row = await seedRow();
      const fake = fakeEmailService(async (options) => {
        expect(options.idempotencyKey).toBe(deliveryKeyFor(row.id)); // stable delivery key reached the driver
        await stealToken(row.id); // simulate: another claim already reclaimed this row while we were mid-flight
        return { provider: 'RESEND', providerMessageId: 'msg_stale' };
      });
      const processor = createEmailSendProcessor({
        tenantContext,
        emailService: fake,
        auditService,
      });
      await processor(fakeJob(row.id));
      const after = await rowOf(row.id);
      expect(after.status).not.toBe(EmailOutboxStatus.SENT); // never overwritten by the loser
      expect(after.providerMessageId).not.toBe('msg_stale');
    });

    it('B4: a stale worker whose fencing token was superseded mid-send does NOT overwrite the newer claim with RETRY/FAILED either', async () => {
      const row = await seedRow();
      const fake = fakeEmailService(async () => {
        await stealToken(row.id);
        throw new Error('simulated transient send failure');
      });
      const processor = createEmailSendProcessor({
        tenantContext,
        emailService: fake,
        auditService,
      });
      await processor(fakeJob(row.id)); // handleSendFailure must see it lost the token and write nothing
      const after = await rowOf(row.id);
      expect(after.status).not.toBe(EmailOutboxStatus.RETRY);
      expect(after.status).not.toBe(EmailOutboxStatus.FAILED);
    });

    it('B5: two concurrent attempts for the SAME row — exactly one wins the claim and reaches SENT, the other is a clean no-op', async () => {
      const row = await seedRow();
      let sendCalls = 0;
      const fake = fakeEmailService(async () => {
        sendCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { provider: 'LOGGER' };
      });
      const processor = createEmailSendProcessor({
        tenantContext,
        emailService: fake,
        auditService,
      });
      await Promise.all([
        processor(fakeJob(row.id)),
        processor(fakeJob(row.id)),
      ]);
      expect(sendCalls).toBe(1); // only the CAS claim's winner ever reaches the provider call
      expect((await rowOf(row.id)).status).toBe(EmailOutboxStatus.SENT);
    });

    it('a non-retryable send failure exhausts immediately (UnrecoverableError) and FAILED is fenced correctly', async () => {
      const row = await seedRow();
      const fake = fakeEmailService(async () => {
        const err = new Error('permanent rejection') as Error & {
          responseCode: number;
        };
        err.responseCode = 400;
        throw err;
      });
      const processor = createEmailSendProcessor({
        tenantContext,
        emailService: fake,
        auditService,
      });
      await expect(processor(fakeJob(row.id))).rejects.toThrow(
        /permanently failed/,
      );
      expect((await rowOf(row.id)).status).toBe(EmailOutboxStatus.FAILED);
    });
  });

  // ================================================================================================ C. Dispatcher ambiguous-delivery classification
  describe('C. email-dispatch.job.ts ambiguous-delivery classification', () => {
    async function dispatch(ambiguousDeliverySafeToRetry: boolean) {
      const publishSpy = jest.fn(async () => undefined);
      const republishSpy = jest.fn(async () => undefined);
      const result = await runEmailDispatchCycle(
        adminDataSource,
        tenantContext,
        publishSpy,
        republishSpy,
        ambiguousDeliverySafeToRetry,
      );
      return { result, publishSpy, republishSpy };
    }

    it('C1: a stale PROCESSING row that never reached the provider is ALWAYS safe to recover, regardless of driver', async () => {
      const row = await seedRow();
      await tenantContext.runInTenantContext(ctx, (m) =>
        m.update(EmailOutbox, row.id, {
          status: EmailOutboxStatus.PROCESSING,
          processingAt: new Date(),
        }),
      );
      await markStale(row.id, 'processing_at', 20);
      const { republishSpy, publishSpy } = await dispatch(false); // even on a non-idempotent driver
      expect(republishSpy).toHaveBeenCalledWith(row.id, org.id, 1); // dispatch_generation bumped 0 -> 1
      expect(publishSpy).not.toHaveBeenCalledWith(row.id, org.id);
      expect((await rowOf(row.id)).dispatchGeneration).toBe(1);
    });

    it('C2: a stale PROCESSING row whose provider call started IS safe to recover when the configured driver can dedupe ambiguous retries (Resend-like)', async () => {
      const row = await seedRow();
      await tenantContext.runInTenantContext(ctx, (m) =>
        m.update(EmailOutbox, row.id, {
          status: EmailOutboxStatus.PROCESSING,
          processingAt: new Date(),
          providerCallStartedAt: new Date(),
        }),
      );
      await markStale(row.id, 'processing_at', 20);
      const { republishSpy } = await dispatch(true);
      expect(republishSpy).toHaveBeenCalledWith(row.id, org.id, 1);
    });

    it('C3: a stale PROCESSING row whose provider call started is NEVER blindly resent when the configured driver cannot dedupe (SMTP-like) — marked DELIVERY_UNCERTAIN instead', async () => {
      const row = await seedRow();
      await tenantContext.runInTenantContext(ctx, (m) =>
        m.update(EmailOutbox, row.id, {
          status: EmailOutboxStatus.PROCESSING,
          processingAt: new Date(),
          providerCallStartedAt: new Date(),
        }),
      );
      await markStale(row.id, 'processing_at', 20);
      const { publishSpy, republishSpy } = await dispatch(false);
      expect(publishSpy).not.toHaveBeenCalled();
      expect(republishSpy).not.toHaveBeenCalled();
      const after = await rowOf(row.id);
      expect(after.status).toBe(EmailOutboxStatus.FAILED);
      expect(after.lastErrorCode).toBe('DELIVERY_UNCERTAIN');
      const audited = await tenantContext.runInTenantContext(ctx, (m) =>
        m.query(
          `SELECT 1 FROM core.audit_log WHERE organisation_id = $1 AND action = 'email.delivery_uncertain' AND metadata->>'emailOutboxId' = $2`,
          [org.id, row.id],
        ),
      );
      expect(audited.length).toBeGreaterThan(0);
    });

    it('C4: a genuinely first-ever attempt (still PENDING) is published without bumping dispatch_generation, unaffected by driver ambiguity', async () => {
      const row = await seedRow();
      const { publishSpy, republishSpy } = await dispatch(false);
      expect(publishSpy).toHaveBeenCalledWith(row.id, org.id);
      expect(republishSpy).not.toHaveBeenCalledWith(
        row.id,
        org.id,
        expect.anything(),
      );
      expect((await rowOf(row.id)).dispatchGeneration).toBe(0);
    });

    it('C5: a stuck row that already exhausted its attempt budget is moved straight to FAILED, never republished, regardless of ambiguity', async () => {
      const row = await seedRow();
      await tenantContext.runInTenantContext(ctx, (m) =>
        m.update(EmailOutbox, row.id, {
          status: EmailOutboxStatus.PROCESSING,
          processingAt: new Date(),
          providerCallStartedAt: new Date(),
          infrastructureAttemptCount: 5,
          maxInfrastructureAttempts: 5,
        }),
      );
      await markStale(row.id, 'processing_at', 20);
      const { publishSpy, republishSpy } = await dispatch(true); // even on an idempotent driver
      expect(publishSpy).not.toHaveBeenCalled();
      expect(republishSpy).not.toHaveBeenCalled();
      const after = await rowOf(row.id);
      expect(after.status).toBe(EmailOutboxStatus.FAILED);
      expect(after.lastErrorCode).toBe('STUCK_LEASE_ATTEMPTS_EXHAUSTED');
    });

    it('C6: 5 concurrent dispatch cycles racing the SAME stale ambiguous-safe row produce exactly one recovery (one generation bump, one republish)', async () => {
      const row = await seedRow();
      await tenantContext.runInTenantContext(ctx, (m) =>
        m.update(EmailOutbox, row.id, {
          status: EmailOutboxStatus.PROCESSING,
          processingAt: new Date(),
          providerCallStartedAt: new Date(),
        }),
      );
      await markStale(row.id, 'processing_at', 20);
      const dispatches = await Promise.all(
        Array.from({ length: 5 }, () => dispatch(true)),
      );
      const totalRepublishesForThisRow = dispatches.reduce(
        (sum, d) =>
          sum + d.republishSpy.mock.calls.filter((c) => c[0] === row.id).length,
        0,
      );
      expect(totalRepublishesForThisRow).toBe(1); // FOR UPDATE SKIP LOCKED ensures only one dispatcher instance ever claims this row per cycle
      expect((await rowOf(row.id)).dispatchGeneration).toBe(1);
    });
  });
  describe('PRE-02 scoped coordination', () => {
    it('claims both organisations through rab_app, never mutates as owner, and denies cross-org access', async () => {
      const otherOrg = await factory.createOrganisation('pre02');
      const otherOwner = await factory.createInternalManager(otherOrg);
      const otherCtx = {
        organisationId: otherOrg.id,
        workspaceId: otherOwner.workspaceId!,
        userId: otherOwner.userId,
        role: '',
      };
      const first = await seedRow();
      const second = await tenantContext.runInTenantContext(otherCtx, (m) =>
        outboxService().enqueue(m, {
          organisationId: otherOrg.id,
          jobType: EmailOutboxJobType.NOTIFICATION,
          recipientEmail: 'other@example.test',
          rendered: {
            subject: 'Test',
            html: '&lt;script&gt;safe&lt;/script&gt;',
            text: 'safe',
          },
        }),
      );
      for (const [scope, own, foreign] of [
        [ctx, first.id, second.id],
        [otherCtx, second.id, first.id],
      ] as const) {
        await tenantContext.runInTenantContext(scope, async (m) => {
          expect(await m.findOneBy(EmailOutbox, { id: own })).not.toBeNull();
          expect(await m.findOneBy(EmailOutbox, { id: foreign })).toBeNull();
          expect(
            (
              await m.update(EmailOutbox, foreign, {
                status: EmailOutboxStatus.CANCELLED,
              })
            ).affected,
          ).toBe(0);
        });
      }
      sqlObservation.mockClear();
      const publish = jest.fn(async (id: string, organisationId: string) => {
        // A separate connection must see the committed claim before publication.
        await tenantContext.runInTenantContext(
          { organisationId, workspaceId: null, userId: '', role: '' },
          async (m) => {
            expect((await m.findOneByOrFail(EmailOutbox, { id })).status).toBe(
              EmailOutboxStatus.QUEUED,
            );
          },
        );
      });
      await runEmailDispatchCycle(
        adminDataSource,
        tenantContext,
        publish,
        async () => undefined,
        false,
      );
      expect(publish).toHaveBeenCalledWith(first.id, org.id);
      expect(publish).toHaveBeenCalledWith(second.id, otherOrg.id);
      const ownerSql = sqlObservation.mock.calls
        .filter((c) => c[2]?.connection === adminDataSource)
        .map((c) => String(c[0]));
      expect(ownerSql.length).toBeGreaterThan(0);
      expect(
        ownerSql.filter((q) =>
          /^(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i.test(q.trim()),
        ),
      ).toEqual([]);
      expect(ownerSql.filter((q) => /core.email_outbox/i.test(q))).toEqual([]);
    });

    it('a late generation cannot overwrite recovery; persisted escaped HTML survives retry', async () => {
      const row = await seedRow();
      const html = '<p>&lt;script&gt;untrusted&lt;/script&gt;</p>';
      await tenantContext.runInTenantContext(ctx, (m) =>
        m.update(EmailOutbox, row.id, { renderedHtml: html }),
      );
      const observedHtml: string[] = [];
      const fake = {
        ambiguousDeliverySafeToRetry: true,
        send: async (options: { html: string; idempotencyKey: string }) => {
          observedHtml.push(options.html);
          expect(options.idempotencyKey).toBe(deliveryKeyFor(row.id));
          if (observedHtml.length === 1) {
            await markStale(row.id, 'processing_at', 20);
            await runEmailDispatchCycle(
              adminDataSource,
              tenantContext,
              async () => undefined,
              async () => undefined,
              true,
            );
            // The newer claim finishes while the original provider call is stalled.
            await processor(fakeJob(row.id));
            throw new Error('timeout from stale provider call');
          }
          return { provider: 'LOGGER' };
        },
      } as unknown as EmailService;
      const processor = createEmailSendProcessor({
        tenantContext,
        emailService: fake,
        auditService,
      });
      await processor(fakeJob(row.id));
      const after = await rowOf(row.id);
      expect(after.status).toBe(EmailOutboxStatus.SENT);
      expect(after.dispatchGeneration).toBe(1);
      expect(after.renderedHtml).toBe(html);
      expect(observedHtml).toEqual([html, html]);
    });

    it('two OS processes claim once and duplicate queue delivery calls the provider once', async () => {
      const row = await seedRow();
      const children = Array.from({ length: 2 }, () =>
        fork(join(__dirname, 'helpers/email-process-child.cjs'), [], {
          silent: true,
          execArgv: [
            '-r',
            'ts-node/register/transpile-only',
            '-r',
            'tsconfig-paths/register',
          ],
          env: {
            ...process.env,
            TS_NODE_PROJECT: resolve('packages/rab-worker/tsconfig.app.json'),
          },
        }),
      );
      const waitMessage = (child: (typeof children)[number]) =>
        new Promise<Record<string, number | boolean | string>>(
          (resolveMessage, reject) => {
            const timer = setTimeout(
              () => reject(new Error('child process timed out')),
              25000,
            );
            child.once('message', (message) => {
              clearTimeout(timer);
              resolveMessage(
                message as Record<string, number | boolean | string>,
              );
            });
            child.once('error', (error) => {
              clearTimeout(timer);
              reject(error);
            });
          },
        );
      try {
        const ready = await Promise.all(children.map(waitMessage));
        expect(ready).toEqual([{ ready: true }, { ready: true }]);
        const pending = children.map(waitMessage);
        for (const child of children)
          child.send({ id: row.id, organisationId: org.id });
        const results = await Promise.all(pending);
        expect(results.every((r) => !r.error)).toBe(true);
        expect(results.reduce((n, r) => n + Number(r.claims), 0)).toBe(1);
        expect(results.reduce((n, r) => n + Number(r.sends), 0)).toBe(1);
        expect((await rowOf(row.id)).status).toBe(EmailOutboxStatus.SENT);
      } finally {
        for (const child of children) child.kill();
      }
    });

    it('does not reclaim SENT, CANCELLED or a fresh RETRY; failed publication remains recoverable', async () => {
      const rows = await Promise.all([
        seedRow(),
        seedRow(),
        seedRow(),
        seedRow(),
      ]);
      await tenantContext.runInTenantContext(ctx, async (m) => {
        await m.update(EmailOutbox, rows[0].id, {
          status: EmailOutboxStatus.SENT,
        });
        await m.update(EmailOutbox, rows[1].id, {
          status: EmailOutboxStatus.CANCELLED,
        });
        await m.update(EmailOutbox, rows[2].id, {
          status: EmailOutboxStatus.RETRY,
        });
      });
      const publish = jest.fn(async () => {
        throw new Error('local queue unavailable');
      });
      const republish = jest.fn(async () => undefined);
      await runEmailDispatchCycle(
        adminDataSource,
        tenantContext,
        publish,
        republish,
        false,
      );
      for (const row of rows.slice(0, 3)) {
        expect(publish).not.toHaveBeenCalledWith(row.id, org.id);
        expect(republish).not.toHaveBeenCalledWith(
          row.id,
          org.id,
          expect.anything(),
        );
      }
      expect((await rowOf(rows[3].id)).status).toBe(EmailOutboxStatus.QUEUED);
      await tenantContext.runInTenantContext(ctx, (m) =>
        m.query(
          "UPDATE core.email_outbox SET queued_at = now() - interval '3 minutes' WHERE id = $1",
          [rows[3].id],
        ),
      );
      await runEmailDispatchCycle(
        adminDataSource,
        tenantContext,
        async () => undefined,
        republish,
        false,
      );
      expect(republish).toHaveBeenCalledWith(rows[3].id, org.id, 1);
    });
  });
});
