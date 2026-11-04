import './helpers/email-reliability-env'; // FIRST: env is frozen when AppModule is imported (Redis DB 9, EMAIL_DRIVER=LOGGER)
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Job, Queue, QueueEvents, UnrecoverableError, Worker } from 'bullmq';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { EmailSendResult } from '@rab/server/engine/core-modules/email/drivers/interfaces/email-driver.interface';
import { EmailOutboxService } from '@rab/server/engine/core-modules/email/email-outbox.service';
import { EmailService } from '@rab/server/engine/core-modules/email/email.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { AuthContext } from '@rab/server/engine/core-modules/tenant/auth-context.interface';
import { EmailOutbox, Organisation } from '@rab/server/modules/identity/entities/index';
import { EmailOutboxJobType, EmailOutboxStatus } from '@rab/shared';
import { dispatchEmailScope } from '../../queues/rab-email/email-dispatch.job';
import { createEmailSendProcessor, deliveryKeyFor } from '../../queues/rab-email/email-send.processor';
import { createAdminDataSource } from './helpers/admin-datasource';
import { cancelLeftoverClaimableEmails } from './helpers/email-leftovers';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * D-Q5b (docs/PHASE_DQ4_DQ5_PLAN_2026-11-03.md §5.1, §5.6.4; owner approval 2026-11-04: OC-1 confirmed, OD-5 Option B).
 * Real PostgreSQL (RLS-bound crewflow_app runtime), real Redis + BullMQ for the "BullMQ never re-runs a confirmed send"
 * case; the provider is a recording fake (no real email).
 *
 *  1. OC-1: the attempt cap of 5 is cumulative across republish generations (3 attempts in generation 0 + 2 in
 *     generation 1 → FAILED at 5), a successful republished send records the cumulative count, and a row at the cap is
 *     never claimed again.
 *  2. OD-5: provider confirmed + SENT write failed → no RETRY write, the BullMQ job is not retried (one provider call),
 *     the row stays PROCESSING with its provider-call marker; lease recovery then marks it correctly without a second
 *     email: SMTP → FAILED DELIVERY_UNCERTAIN; Resend → re-presented under the SAME idempotency key (Resend returns the
 *     original message instead of sending again) → SENT; at the cap → DELIVERY_UNCERTAIN, never re-presented.
 *  3. Tenant isolation: another organisation's job or dispatcher never sees, claims or counts the row; no context → 0 rows.
 *  4. Multi-replica: two consumers (old and new generation job) race one row → one claim, one send, one count; five
 *     dispatcher replicas race one exhausted ambiguous row → one DELIVERY_UNCERTAIN transition and audit row.
 */
jest.setTimeout(120_000);

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('D-Q5b email: cumulative attempt cap, no resend after a confirmed send (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let auditService: AuditService;
  let factory: TestIdentityFactory;
  let org: Organisation;
  let otherOrg: Organisation;
  let staff: TestIdentity;
  let ctx: AuthContext;
  let otherCtx: AuthContext;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    await cancelLeftoverClaimableEmails(dataSource, tenantContext);
    auditService = moduleRef.get(AuditService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
    org = await factory.createOrganisation('dq5b');
    const owner = await factory.createInternalManager(org);
    staff = await factory.createStaff(org, { owner });
    ctx = { organisationId: org.id, workspaceId: owner.workspaceId!, userId: owner.userId, role: '' };
    otherOrg = await factory.createOrganisation('dq5bx');
    const otherOwner = await factory.createInternalManager(otherOrg);
    otherCtx = { organisationId: otherOrg.id, workspaceId: otherOwner.workspaceId!, userId: otherOwner.userId, role: '' };
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  // Fail closed check around every case: the RLS flags are intact and a query with no tenant context bound sees nothing.
  async function assertNoContextZeroRows(): Promise<void> {
    const [flags] = await dataSource.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'core.email_outbox'::regclass");
    expect(flags).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect(await dataSource.query('SELECT id FROM core.email_outbox')).toEqual([]);
  }
  beforeEach(assertNoContextZeroRows);
  afterEach(assertNoContextZeroRows);

  // ------------------------------------------------------------------------------------------------ helpers
  const seedRow = () =>
    tenantContext.runInTenantContext(ctx, (m) =>
      new EmailOutboxService().enqueue(m, {
        organisationId: org.id,
        jobType: EmailOutboxJobType.NOTIFICATION,
        recipientEmail: 'staff@example.test',
        targetUserId: staff.userId,
        rendered: { subject: 'D-Q5b', html: '<p>hi</p>', text: 'hi' },
      }),
    );
  /** Owner-side read (bypasses RLS on purpose: the assertion must see the row whatever context the code under test bound). */
  const rowOf = async (id: string) => {
    const [row] = await adminDataSource.query(
      `SELECT status, infrastructure_attempt_count AS count, dispatch_generation AS generation, processing_token, provider_call_started_at,
              last_error_code, provider_message_id FROM core.email_outbox WHERE id = $1`,
      [id],
    );
    return row as { status: string; count: number; generation: number; processing_token: string | null; provider_call_started_at: Date | null; last_error_code: string | null; provider_message_id: string | null };
  };
  const setRow = (id: string, sql: string) => adminDataSource.query(`UPDATE core.email_outbox SET ${sql} WHERE id = $1`, [id]);
  const auditActions = async (id: string) =>
    (await adminDataSource.query(`SELECT action FROM core.audit_log WHERE metadata->>'emailOutboxId' = $1 ORDER BY created_at`, [id])).map((r: { action: string }) => r.action);
  const fakeJob = (id: string, attemptsMade: number, generation: number, organisationId = org.id) =>
    ({ id: `email-outbox.${id}.attempt.${generation}`, data: { emailOutboxId: id, organisationId }, attemptsMade, opts: { attempts: 5 } }) as unknown as Job;

  interface Provider {
    service: EmailService;
    calls: Array<{ idempotencyKey: string }>;
  }
  /** A recording provider. `fail` = a transient (retryable) failure; otherwise accepted with a fixed message id. */
  function provider(mode: 'ok' | 'fail', ambiguousDeliverySafeToRetry = true): Provider {
    const calls: Array<{ idempotencyKey: string }> = [];
    const send = async (options: { idempotencyKey: string }): Promise<EmailSendResult> => {
      calls.push({ idempotencyKey: options.idempotencyKey });
      if (mode === 'fail') throw Object.assign(new Error('greeting never received'), { code: 'ETIMEDOUT' });
      return { provider: 'RESEND', providerMessageId: 'msg_dq5b_original' };
    };
    return { service: { send, ambiguousDeliverySafeToRetry } as unknown as EmailService, calls };
  }

  /**
   * The real TenantContextService, except every attempt to write SENT fails (a simulated connection loss while
   * persisting the outcome, after the provider already accepted the email). Every other statement — the claim, the
   * provider-call marker, audit rows — runs for real under the real bound context.
   */
  function sentWriteFails(real: TenantContextService): TenantContextService {
    const wrapManager = (manager: EntityManager): EntityManager =>
      new Proxy(manager, {
        get(target, prop) {
          if (prop === 'createQueryBuilder') {
            return (...args: unknown[]) => {
              const qb = (target.createQueryBuilder as (...a: unknown[]) => any)(...args);
              const update = qb.update.bind(qb);
              qb.update = (...u: unknown[]) => {
                const uqb = update(...u);
                const set = uqb.set.bind(uqb);
                uqb.set = (values: Record<string, unknown>) => {
                  const next = set(values);
                  if (values.status === EmailOutboxStatus.SENT) {
                    next.execute = async () => {
                      throw new Error('simulated: connection terminated while persisting SENT');
                    };
                  }
                  return next;
                };
                return uqb;
              };
              return qb;
            };
          }
          const value = (target as unknown as Record<string | symbol, unknown>)[prop];
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
    return new Proxy(real, {
      get(target, prop) {
        if (prop === 'runInTenantContext') {
          return (c: AuthContext, fn: (m: EntityManager) => Promise<unknown>) => target.runInTenantContext(c, (m) => fn(wrapManager(m)));
        }
        const value = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  }

  const dispatch = async (safeToRetry: boolean, organisationId = org.id) => {
    const publish = jest.fn(async () => undefined);
    const republish = jest.fn(async () => undefined);
    const result = await dispatchEmailScope(tenantContext, organisationId, undefined, publish, republish, safeToRetry);
    return { publish, republish, result };
  };
  const quietErrors = () => jest.spyOn(console, 'error').mockImplementation(() => undefined);

  // ================================================================================================ 1. OC-1 cumulative cap
  describe('1. OC-1: the cap of 5 is cumulative across republish generations', () => {
    it('3 attempts in generation 0, dispatcher republish (generation 1), 2 more → FAILED at 5, five provider calls in total', async () => {
      const row = await seedRow();
      const p = provider('fail');
      const processor = createEmailSendProcessor({ tenantContext, emailService: p.service, auditService });
      for (const attemptsMade of [0, 1, 2]) await expect(processor(fakeJob(row.id, attemptsMade, 0))).rejects.toThrow(/greeting never received/);
      expect(await rowOf(row.id)).toMatchObject({ status: 'RETRY', count: 3, generation: 0 });

      // The generation-0 BullMQ job is lost (Redis loss / removed job): the stale-RETRY recovery republishes generation 1.
      await setRow(row.id, `updated_at = now() - interval '10 minutes'`);
      const { republish } = await dispatch(true);
      expect(republish).toHaveBeenCalledWith(row.id, org.id, 1);
      expect(await rowOf(row.id)).toMatchObject({ status: 'QUEUED', count: 3, generation: 1 });

      // The new job starts at attemptsMade 0 — the row's count does not.
      await expect(processor(fakeJob(row.id, 0, 1))).rejects.toThrow(/greeting never received/);
      expect(await rowOf(row.id)).toMatchObject({ status: 'RETRY', count: 4 });
      await expect(processor(fakeJob(row.id, 1, 1))).rejects.toBeInstanceOf(UnrecoverableError);
      expect(await rowOf(row.id)).toMatchObject({ status: 'FAILED', count: 5 });
      expect(p.calls).toHaveLength(5);
      expect(await auditActions(row.id)).toContain('email.delivery_failed');
    });

    it('a successful send on a republished row records the cumulative count (prior 4 → SENT with 5)', async () => {
      const row = await seedRow();
      await setRow(row.id, `status = 'QUEUED', queued_at = now(), infrastructure_attempt_count = 4, dispatch_generation = 2`);
      const p = provider('ok');
      await createEmailSendProcessor({ tenantContext, emailService: p.service, auditService })(fakeJob(row.id, 0, 2));
      expect(await rowOf(row.id)).toMatchObject({ status: 'SENT', count: 5 });
    });

    it('a row that already carries 5 attempts is never claimed again (no provider call); the dispatcher fails it as exhausted', async () => {
      const row = await seedRow();
      await setRow(row.id, `status = 'RETRY', infrastructure_attempt_count = 5, updated_at = now() - interval '10 minutes'`);
      const p = provider('ok');
      await expect(createEmailSendProcessor({ tenantContext, emailService: p.service, auditService })(fakeJob(row.id, 0, 3))).resolves.toBeUndefined();
      expect(p.calls).toHaveLength(0);
      expect(await rowOf(row.id)).toMatchObject({ status: 'RETRY', count: 5 });
      const { publish, republish } = await dispatch(true);
      expect(publish).not.toHaveBeenCalledWith(row.id, expect.anything());
      expect(republish).not.toHaveBeenCalledWith(row.id, expect.anything(), expect.anything());
      expect(await rowOf(row.id)).toMatchObject({ status: 'FAILED', last_error_code: 'STUCK_LEASE_ATTEMPTS_EXHAUSTED', count: 5 });
    });
  });

  // ================================================================================================ 2. OD-5 no resend
  describe('2. OD-5 Option B: a failed SENT write after a confirmed send is never re-sent', () => {
    const QUEUE_NAME = `dq5b-email-${randomUUID().slice(0, 8)}`;
    let connection: Redis;
    let queue: Queue;
    let events: QueueEvents;

    beforeAll(async () => {
      connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
      queue = new Queue(QUEUE_NAME, { connection });
      events = new QueueEvents(QUEUE_NAME, { connection });
      await events.waitUntilReady();
    });
    afterAll(async () => {
      await events.close();
      await queue.obliterate({ force: true });
      await queue.close();
      await connection.quit();
    });

    /** Runs ONE real BullMQ job (5 attempts, 50 ms backoff) through the processor whose SENT write always fails. */
    async function sendThroughBullmqWithFailingSentWrite(rowId: string, generation: number, p: Provider) {
      const processor = createEmailSendProcessor({ tenantContext: sentWriteFails(tenantContext), emailService: p.service, auditService });
      const worker = new Worker(QUEUE_NAME, (job: Job) => processor(job), { connection, concurrency: 1 });
      await worker.waitUntilReady();
      const errors = quietErrors();
      try {
        const job = await queue.add('send-email', { emailOutboxId: rowId, organisationId: org.id }, {
          jobId: `email-outbox.${rowId}.attempt.${generation}`,
          attempts: 5,
          backoff: { type: 'fixed', delay: 50 },
        });
        await expect(job.waitUntilFinished(events, 30_000)).rejects.toThrow();
        // Give BullMQ time to (wrongly) schedule a retry, then read the job's final state.
        await new Promise((resolve) => setTimeout(resolve, 500));
        const final = await queue.getJob(job.id!);
        return { state: await final!.getState(), attemptsMade: final!.attemptsMade, logged: errors.mock.calls.map((c) => String(c[0])).join('\n') };
      } finally {
        errors.mockRestore();
        await worker.close();
      }
    }

    it('SMTP: one provider call, the job ends failed after ONE attempt, the row stays PROCESSING; lease recovery → DELIVERY_UNCERTAIN, no second email', async () => {
      const row = await seedRow();
      const p = provider('ok', false);
      const run = await sendThroughBullmqWithFailingSentWrite(row.id, 0, p);
      expect(run).toMatchObject({ state: 'failed', attemptsMade: 1 });
      expect(p.calls).toHaveLength(1);
      expect(run.logged).toMatch(/PROVIDER SUCCEEDED[\s\S]*left PROCESSING/);
      expect(run.logged).not.toContain('staff@example.test');
      const stuck = await rowOf(row.id);
      expect(stuck).toMatchObject({ status: 'PROCESSING', count: 1 });
      expect(stuck.provider_call_started_at).toBeTruthy();
      expect(stuck.processing_token).toBeTruthy();

      // Inside the 10-minute lease the dispatcher leaves it alone.
      const early = await dispatch(false);
      expect(early.republish).not.toHaveBeenCalledWith(row.id, expect.anything(), expect.anything());
      expect((await rowOf(row.id)).status).toBe('PROCESSING');

      await setRow(row.id, `processing_at = now() - interval '20 minutes'`);
      const { publish, republish } = await dispatch(false);
      expect(publish).not.toHaveBeenCalledWith(row.id, expect.anything());
      expect(republish).not.toHaveBeenCalledWith(row.id, expect.anything(), expect.anything());
      expect(await rowOf(row.id)).toMatchObject({ status: 'FAILED', last_error_code: 'DELIVERY_UNCERTAIN' });
      expect(await auditActions(row.id)).toContain('email.delivery_uncertain');
      expect(p.calls).toHaveLength(1); // never a second provider call
    });

    it('Resend: lease recovery re-presents the SAME idempotency key once (the provider returns the original message) → SENT', async () => {
      const row = await seedRow();
      const p = provider('ok', true);
      const run = await sendThroughBullmqWithFailingSentWrite(row.id, 0, p);
      expect(run).toMatchObject({ state: 'failed', attemptsMade: 1 });
      expect(await rowOf(row.id)).toMatchObject({ status: 'PROCESSING', count: 1 });

      await setRow(row.id, `processing_at = now() - interval '20 minutes'`);
      const { republish } = await dispatch(true);
      expect(republish).toHaveBeenCalledWith(row.id, org.id, 1);
      // The database is healthy again: the republished generation-1 job runs with the real tenant context.
      await createEmailSendProcessor({ tenantContext, emailService: p.service, auditService })(fakeJob(row.id, 0, 1));
      expect(await rowOf(row.id)).toMatchObject({ status: 'SENT', count: 2, provider_message_id: 'msg_dq5b_original' });
      expect(p.calls).toEqual([{ idempotencyKey: deliveryKeyFor(row.id) }, { idempotencyKey: deliveryKeyFor(row.id) }]);
    });

    it('at the cap (the 5th cumulative attempt confirmed, SENT write failed): DELIVERY_UNCERTAIN even on Resend — never re-presented, never "exhausted"', async () => {
      const row = await seedRow();
      await setRow(row.id, `status = 'QUEUED', queued_at = now(), infrastructure_attempt_count = 4, dispatch_generation = 1`);
      const p = provider('ok', true);
      const run = await sendThroughBullmqWithFailingSentWrite(row.id, 1, p);
      expect(run).toMatchObject({ state: 'failed', attemptsMade: 1 });
      expect(await rowOf(row.id)).toMatchObject({ status: 'PROCESSING', count: 5 });

      await setRow(row.id, `processing_at = now() - interval '20 minutes'`);
      const { publish, republish } = await dispatch(true);
      expect(publish).not.toHaveBeenCalledWith(row.id, expect.anything());
      expect(republish).not.toHaveBeenCalledWith(row.id, expect.anything(), expect.anything());
      expect(await rowOf(row.id)).toMatchObject({ status: 'FAILED', last_error_code: 'DELIVERY_UNCERTAIN', count: 5 });
      expect(p.calls).toHaveLength(1);
    });

    it('control: a PROCESSING row at the cap that never reached the provider (no marker) is still STUCK_LEASE_ATTEMPTS_EXHAUSTED', async () => {
      const row = await seedRow();
      await setRow(row.id, `status = 'PROCESSING', processing_at = now() - interval '20 minutes', processing_token = gen_random_uuid(), infrastructure_attempt_count = 5`);
      await dispatch(true);
      expect(await rowOf(row.id)).toMatchObject({ status: 'FAILED', last_error_code: 'STUCK_LEASE_ATTEMPTS_EXHAUSTED' });
    });
  });

  // ================================================================================================ 3. Tenant isolation
  describe('3. tenant isolation', () => {
    it("ABUSE: a job naming another organisation cannot see, claim or count this organisation's row (no send)", async () => {
      const row = await seedRow();
      await setRow(row.id, `status = 'RETRY', infrastructure_attempt_count = 2`);
      const p = provider('ok');
      await expect(createEmailSendProcessor({ tenantContext, emailService: p.service, auditService })(fakeJob(row.id, 0, 1, otherOrg.id))).rejects.toThrow(/not visible yet/);
      expect(p.calls).toHaveLength(0);
      expect(await rowOf(row.id)).toMatchObject({ status: 'RETRY', count: 2 });
    });

    it("another organisation's dispatcher never reclassifies this organisation's exhausted ambiguous row", async () => {
      const row = await seedRow();
      await setRow(row.id, `status = 'PROCESSING', processing_at = now() - interval '20 minutes', processing_token = gen_random_uuid(), provider_call_started_at = now() - interval '20 minutes', infrastructure_attempt_count = 5`);
      const other = await dispatch(true, otherOrg.id);
      expect(other.result.deliveryUncertain).toBe(0);
      expect(await rowOf(row.id)).toMatchObject({ status: 'PROCESSING', count: 5 });
      // Its own organisation's dispatcher does.
      await dispatch(true);
      expect(await rowOf(row.id)).toMatchObject({ status: 'FAILED', last_error_code: 'DELIVERY_UNCERTAIN' });
      // Cleanup is not needed: FAILED is terminal. The other organisation saw none of this organisation's rows.
      expect(await tenantContext.runInTenantContext(otherCtx, (m) => m.query('SELECT id FROM core.email_outbox WHERE id = $1', [row.id]))).toEqual([]);
    });
  });

  // ================================================================================================ 4. Multi-replica
  describe('4. multi-replica', () => {
    it('two consumers (the old generation job and the republished one) race one row: one claim, one provider call, count +1 once', async () => {
      const row = await seedRow();
      await setRow(row.id, `status = 'RETRY', infrastructure_attempt_count = 3, dispatch_generation = 1`);
      let calls = 0;
      const slow = { send: async () => { calls += 1; await new Promise((r) => setTimeout(r, 50)); return { provider: 'RESEND', providerMessageId: 'msg_race' }; }, ambiguousDeliverySafeToRetry: true } as unknown as EmailService;
      const replicaA = createEmailSendProcessor({ tenantContext, emailService: slow, auditService });
      const replicaB = createEmailSendProcessor({ tenantContext, emailService: slow, auditService });
      await Promise.all([replicaA(fakeJob(row.id, 2, 0)), replicaB(fakeJob(row.id, 0, 1))]);
      expect(calls).toBe(1);
      expect(await rowOf(row.id)).toMatchObject({ status: 'SENT', count: 4 });
    });

    it('five dispatcher replicas race one exhausted ambiguous row: exactly one DELIVERY_UNCERTAIN transition and audit row, no republish', async () => {
      const row = await seedRow();
      await setRow(row.id, `status = 'PROCESSING', processing_at = now() - interval '20 minutes', processing_token = gen_random_uuid(), provider_call_started_at = now() - interval '20 minutes', infrastructure_attempt_count = 5`);
      const runs = await Promise.all(Array.from({ length: 5 }, () => dispatch(true)));
      expect(runs.reduce((n, r) => n + r.result.deliveryUncertain, 0)).toBe(1);
      expect(runs.some((r) => r.republish.mock.calls.some((c) => (c as unknown[])[0] === row.id))).toBe(false);
      expect((await auditActions(row.id)).filter((a: string) => a === 'email.delivery_uncertain')).toHaveLength(1);
    });
  });
});
