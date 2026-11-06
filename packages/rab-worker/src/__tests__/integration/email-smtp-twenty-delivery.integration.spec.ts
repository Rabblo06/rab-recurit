import './helpers/email-reliability-env'; // FIRST: env is frozen when AppModule is imported (Redis DB 9, LOGGER driver)
import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Job, Queue, Worker } from 'bullmq';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { SmtpDriver } from '@rab/server/engine/core-modules/email/drivers/smtp.driver';
import { EmailDriverFactory } from '@rab/server/engine/core-modules/email/email-driver.factory';
import { EmailOutboxService } from '@rab/server/engine/core-modules/email/email-outbox.service';
import { EMAIL_QUEUE_JOB_NAME, EMAIL_QUEUE_NAME, EmailQueueJobData } from '@rab/server/engine/core-modules/email/email-queue.constants';
import { EMAIL_QUEUE_JOB_OPTIONS } from '@rab/server/engine/core-modules/email/email-queue.service';
import { EmailService } from '@rab/server/engine/core-modules/email/email.service';
import { EnvironmentService } from '@rab/server/engine/core-modules/environment/environment.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { AuthContext } from '@rab/server/engine/core-modules/tenant/auth-context.interface';
import { bullmqWorkerOptionsOf } from '@rab/server/engine/worker-shared/queue-registry';
import { EmailOutbox, Organisation } from '@rab/server/modules/identity/entities/index';
import { EmailOutboxJobType, EmailOutboxStatus } from '@rab/shared';

import { runEmailDispatchCycle } from '../../queues/rab-email/email-dispatch.job';
import { createEmailSendProcessor } from '../../queues/rab-email/email-send.processor';
import { createAdminDataSource } from './helpers/admin-datasource';
import { cancelLeftoverClaimableEmails } from './helpers/email-leftovers';
import { SmtpSink } from './helpers/smtp-sink';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * email-twenty (owner decision 2026-11-06: Twenty CRM-style SMTP delivery — at-least-once, NOT exactly-once). End to end on
 * real infrastructure: real PostgreSQL (the durable outbox under FORCE RLS), real Redis + BullMQ (the production email job
 * options — 5 attempts, exponential 5 s backoff, jitter 0.5 — and Worker options), the REAL SmtpDriver (nodemailer) and a
 * local SMTP sink that fails per recipient on command (`helpers/smtp-sink.ts`). Nothing is mocked between the queue and the
 * SMTP socket. Each case asserts the outbox row, the BullMQ job and how many complete messages the sink received
 * ("transmissions": two for one recipient is a duplicate email).
 *
 *   success · temporary rejection (451, twice, then accepted) · permanent rejection (550) · connection lost after DATA ·
 *   retry exhaustion (451 on every attempt) · duplicate job delivery · Worker crash (a real OS process SIGKILLed while the
 *   sink holds the message) — and no recipient address in any log line, BullMQ failure reason or stored error.
 */
jest.setTimeout(180_000);

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

const TERMINAL_JOB_STATES = new Set(['completed', 'failed']);

describeIfDb('email-twenty: SMTP delivery on the durable outbox + BullMQ (real SMTP sink, integration)', () => {
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

  const sink = new SmtpSink();
  let driver: SmtpDriver;
  let emailService: EmailService;
  let processor: ReturnType<typeof createEmailSendProcessor>;

  const QUEUE = `etw-email-${randomUUID().slice(0, 8)}`;
  let connection: Redis;
  let queue: Queue<EmailQueueJobData>;
  let worker: Worker<EmailQueueJobData>;
  /** What the production consumer's `failed` listener logs (bullmq-scheduler.ts createConsumerWorkers), captured. */
  const failedLogLines: string[] = [];
  const consoleLines: string[] = [];
  const consoleSpies: jest.SpyInstance[] = [];

  const run = randomUUID().slice(0, 8);
  const addr = (label: string) => `etw.${label}.${run}@example.test`;
  const ADDR = {
    ok: addr('ok'),
    temp: addr('temp'),
    perm: addr('perm'),
    drop: addr('drop'),
    exhaust: addr('exhaust'),
    dup: addr('dup'),
    crash: addr('crash'),
  };
  const rows: Record<keyof typeof ADDR, EmailOutbox | undefined> = { ok: undefined, temp: undefined, perm: undefined, drop: undefined, exhaust: undefined, dup: undefined, crash: undefined };
  const jobIdOf = (id: string, generation = 0) => `email-outbox.${id}.attempt.${generation}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    await cancelLeftoverClaimableEmails(dataSource, tenantContext);
    auditService = moduleRef.get(AuditService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
    org = await factory.createOrganisation('etw');
    owner = await factory.createInternalManager(org);
    staff = await factory.createStaff(org, { owner });
    ctx = { organisationId: org.id, workspaceId: owner.workspaceId!, userId: owner.userId, role: '' };

    await sink.start();
    // The production driver with test-sized waits (its own test seam): a hung DATA phase ends in 2 s, not 20-25 s.
    driver = new SmtpDriver(
      { host: '127.0.0.1', port: sink.port, secure: false, ignoreTLS: true },
      { connectionTimeoutMs: 3_000, greetingTimeoutMs: 3_000, socketTimeoutMs: 2_000, sendDeadlineMs: 4_000 },
    );
    const env = { get: (key: string) => (key === 'EMAIL_FROM_ADDRESS' ? 'noreply@example.test' : undefined) } as unknown as EnvironmentService;
    emailService = new EmailService(env, { getDriver: () => driver } as unknown as EmailDriverFactory);
    processor = createEmailSendProcessor({ tenantContext, emailService, auditService });

    // Nest's Logger (SmtpDriver, the production Worker logger) writes to the streams directly, not through console.
    for (const stream of [process.stdout, process.stderr]) {
      const original = stream.write.bind(stream);
      consoleSpies.push(
        jest.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
          consoleLines.push(String(chunk));
          return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
        }) as typeof stream.write),
      );
    }
    for (const method of ['log', 'warn', 'error'] as const) {
      consoleSpies.push(
        jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          consoleLines.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(' '));
        }),
      );
    }

    connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    queue = new Queue<EmailQueueJobData>(QUEUE, { connection });
    worker = new Worker<EmailQueueJobData>(QUEUE, (job) => processor(job), { connection, ...bullmqWorkerOptionsOf(EMAIL_QUEUE_NAME) });
    worker.on('failed', (job, err) => failedLogLines.push(`rab-email job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`));
    await worker.waitUntilReady();

    sink.setFault(ADDR.temp, 'tempfail', 2);
    sink.setFault(ADDR.perm, 'permfail');
    sink.setFault(ADDR.drop, 'drop_after_data', 1);
    sink.setFault(ADDR.exhaust, 'tempfail');
    // Every BullMQ-driven case starts at once, as the production queue would run them (concurrency 5).
    for (const key of ['ok', 'temp', 'perm', 'drop', 'exhaust'] as const) {
      rows[key] = await seedRow(ADDR[key]);
      await queue.add(EMAIL_QUEUE_JOB_NAME, { emailOutboxId: rows[key]!.id, organisationId: org.id }, { ...EMAIL_QUEUE_JOB_OPTIONS, jobId: jobIdOf(rows[key]!.id) });
    }
  });

  afterAll(async () => {
    await worker?.close();
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await queue?.close();
    await connection?.quit();
    await sink.stop();
    for (const spy of consoleSpies) spy.mockRestore();
    await app.close();
    await adminDataSource.destroy();
  });

  // ------------------------------------------------------------------------------------------------ helpers
  async function seedRow(recipientEmail: string): Promise<EmailOutbox> {
    return tenantContext.runInTenantContext(ctx, (m) =>
      new EmailOutboxService().enqueue(m, {
        organisationId: org.id,
        jobType: EmailOutboxJobType.NOTIFICATION,
        recipientEmail,
        targetUserId: staff.userId,
        rendered: { subject: 'Shift confirmed', html: '<p>Your shift is confirmed.</p>', text: 'Your shift is confirmed.' },
      }),
    );
  }
  const rowOf = (id: string) => tenantContext.runInTenantContext(ctx, (m) => m.findOneByOrFail(EmailOutbox, { id }));
  async function settledJob(id: string, generation = 0): Promise<Job<EmailQueueJobData>> {
    const deadline = Date.now() + 150_000;
    for (;;) {
      const job = await queue.getJob(jobIdOf(id, generation));
      if (job && TERMINAL_JOB_STATES.has(await job.getState())) return job;
      if (Date.now() > deadline) throw new Error(`job ${jobIdOf(id, generation)} did not settle`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const auditActionsOf = (id: string) =>
    tenantContext.runInTenantContext(ctx, (m) =>
      m.query<Array<{ action: string; metadata: Record<string, unknown> }>>(`SELECT action, metadata FROM core.audit_log WHERE metadata->>'emailOutboxId' = $1 ORDER BY created_at`, [id]),
    );
  const dispatchSpies = () => ({ publish: jest.fn(async () => undefined), republish: jest.fn(async () => undefined) });

  // ================================================================================================ cases
  it('SMTP success: SENT on attempt 1, one message received, the job completed', async () => {
    const id = rows.ok!.id;
    const job = await settledJob(id);
    expect(await job.getState()).toBe('completed');
    expect(job.attemptsMade).toBe(1);
    const row = await rowOf(id);
    expect(row).toMatchObject({ status: EmailOutboxStatus.SENT, infrastructureAttemptCount: 1, provider: 'SMTP' });
    expect(row.providerMessageId).toBe(`<email-outbox-email-outbox:${id}@example.test>`);
    expect(sink.transmissionsTo(ADDR.ok)).toEqual([{ to: [ADDR.ok], outcome: 'accepted' }]);
  });

  it('temporary rejection: 451 twice → BullMQ retries with backoff → SENT on attempt 3, one message received', async () => {
    const id = rows.temp!.id;
    const job = await settledJob(id);
    expect(await job.getState()).toBe('completed');
    expect(job.attemptsMade).toBe(3);
    expect(await rowOf(id)).toMatchObject({ status: EmailOutboxStatus.SENT, infrastructureAttemptCount: 3 });
    expect(sink.rejections.filter((r) => r.to === ADDR.temp).map((r) => r.code)).toEqual([451, 451]);
    expect(sink.transmissionsTo(ADDR.temp)).toHaveLength(1);
    // The two failed attempts are kept on the job (stacktrace) — sanitized: the 451 reply with the mailbox redacted.
    expect(job.stacktrace).toHaveLength(2);
    expect(job.stacktrace.join('\n')).toContain('451 4.7.1 <[address]>');
  });

  it('permanent rejection: 550 → FAILED after ONE attempt (UnrecoverableError), never retried, error and audit recorded', async () => {
    const id = rows.perm!.id;
    const job = await settledJob(id);
    expect(await job.getState()).toBe('failed');
    expect(job.attemptsMade).toBe(1);
    expect(job.failedReason).toBe(`Email delivery permanently failed for outbox row ${id}: EENVELOPE`);
    const row = await rowOf(id);
    expect(row).toMatchObject({ status: EmailOutboxStatus.FAILED, infrastructureAttemptCount: 1, lastErrorCode: 'EENVELOPE' });
    expect(row.failedAt).toBeInstanceOf(Date);
    expect(row.lastErrorMessageSanitized).toContain('550 5.1.1 <[address]>: Recipient address rejected');
    expect(sink.rejections.filter((r) => r.to === ADDR.perm)).toHaveLength(1);
    expect(sink.transmissionsTo(ADDR.perm)).toHaveLength(0);
    expect((await auditActionsOf(id)).map((a) => a.action)).toEqual(['email.delivery_failed']);
  });

  it('connection lost after DATA: retried (at-least-once) → SENT on attempt 2 — the sink received the message TWICE (accepted duplicate risk)', async () => {
    const id = rows.drop!.id;
    const job = await settledJob(id);
    expect(await job.getState()).toBe('completed');
    expect(job.attemptsMade).toBe(2);
    expect(await rowOf(id)).toMatchObject({ status: EmailOutboxStatus.SENT, infrastructureAttemptCount: 2 });
    expect(sink.transmissionsTo(ADDR.drop).map((t) => t.outcome)).toEqual(['dropped', 'accepted']);
    expect(job.stacktrace.join('\n')).toMatch(/\(ECONNECTION\), will retry/);
  });

  it('retry exhaustion: 451 on every attempt → FAILED at the cap of 5, the BullMQ job failed — and nothing ever retries it again', async () => {
    const id = rows.exhaust!.id;
    const job = await settledJob(id);
    expect(await job.getState()).toBe('failed');
    expect(job.attemptsMade).toBe(5);
    expect(job.failedReason).toBe(`Email delivery permanently failed for outbox row ${id}: EENVELOPE`);
    const row = await rowOf(id);
    expect(row).toMatchObject({ status: EmailOutboxStatus.FAILED, infrastructureAttemptCount: 5, lastErrorCode: 'EENVELOPE' });
    expect(row.failedAt).toBeInstanceOf(Date);
    expect(row.lastErrorMessageSanitized).toContain('451 4.7.1');
    const audits = await auditActionsOf(id);
    expect(audits.map((a) => a.action)).toEqual(['email.delivery_failed']);
    expect(audits[0]!.metadata).toMatchObject({ errorCode: 'EENVELOPE', attempts: 5, retryable: true });
    expect(sink.rejections.filter((r) => r.to === ADDR.exhaust)).toHaveLength(5);

    // Not re-presented by recovery: the dispatcher never claims a FAILED row, however stale it looks.
    await tenantContext.runInTenantContext(ctx, (m) => m.query(`UPDATE core.email_outbox SET updated_at = now() - interval '1 hour' WHERE id = $1`, [id]));
    const { publish, republish } = dispatchSpies();
    await runEmailDispatchCycle(adminDataSource, tenantContext, publish, republish, emailService.ambiguousDeliverySafeToRetry);
    expect([...publish.mock.calls, ...republish.mock.calls].some((c) => (c as unknown[])[0] === id)).toBe(false);
    // A duplicate delivery of the job cannot claim it either (the cap and the status both refuse).
    await expect(processor({ id: jobIdOf(id, 1), data: { emailOutboxId: id, organisationId: org.id }, attemptsMade: 0, opts: { attempts: 5 } } as unknown as Job)).resolves.toBeUndefined();
    expect(sink.rejections.filter((r) => r.to === ADDR.exhaust)).toHaveLength(5);
    expect(await rowOf(id)).toMatchObject({ status: EmailOutboxStatus.FAILED, infrastructureAttemptCount: 5 });
  });

  it('duplicate job delivery: two concurrent deliveries and a second-generation job for one row → one claim, one message', async () => {
    const row = await seedRow(ADDR.dup);
    rows.dup = row;
    const fake = (generation: number) => ({ id: jobIdOf(row.id, generation), data: { emailOutboxId: row.id, organisationId: org.id }, attemptsMade: 0, opts: { attempts: 5 } }) as unknown as Job;
    await Promise.all([processor(fake(0)), processor(fake(0))]);
    await queue.add(EMAIL_QUEUE_JOB_NAME, { emailOutboxId: row.id, organisationId: org.id }, { ...EMAIL_QUEUE_JOB_OPTIONS, jobId: jobIdOf(row.id, 1) });
    const job = await settledJob(row.id, 1);
    expect(await job.getState()).toBe('completed'); // a no-op completion: the row is SENT
    expect(await rowOf(row.id)).toMatchObject({ status: EmailOutboxStatus.SENT, infrastructureAttemptCount: 1 });
    expect(sink.transmissionsTo(ADDR.dup)).toHaveLength(1);
  });

  it('Worker crash while the SMTP server holds the message: no automatic resend (D-Q5b, kept); lease recovery ends it DELIVERY_UNCERTAIN', async () => {
    const row = await seedRow(ADDR.crash);
    rows.crash = row;
    sink.setFault(ADDR.crash, 'hang_after_data');
    const child = fork(join(__dirname, 'helpers/email-smtp-crash-child.cjs'), [], {
      silent: true,
      execArgv: ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register'],
      env: { ...process.env, TS_NODE_PROJECT: join(__dirname, '../../../tsconfig.app.json'), ETW_SMTP_SINK_PORT: String(sink.port) },
    });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    // Read (never leave unread: a full pipe would block the child) and keep its output for the log assertion below.
    child.stdout?.on('data', (d: Buffer) => consoleLines.push(d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => consoleLines.push(d.toString('utf8')));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('crash child did not start')), 60_000);
        child.on('message', (m: { ready?: boolean; error?: string }) => {
          if (m.error) reject(new Error(`crash child: ${m.error}`));
          if (m.ready) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      child.send({ id: row.id, organisationId: org.id });
      const deadline = Date.now() + 60_000;
      while (sink.transmissionsTo(ADDR.crash).length === 0) {
        if (Date.now() > deadline) throw new Error('the sink never received the message from the crash child');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      child.kill('SIGKILL'); // the Worker dies mid-SMTP-transaction: the server has the message, no outcome is recorded
      await exited;
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }

    const crashed = await rowOf(row.id);
    expect(crashed).toMatchObject({ status: EmailOutboxStatus.PROCESSING, infrastructureAttemptCount: 1 });
    expect(crashed.providerCallStartedAt).toBeInstanceOf(Date);

    // BullMQ's stalled check would re-run the job on another Worker: it must not claim the PROCESSING row nor resend.
    sink.clearFault(ADDR.crash); // accept again, so a resend WOULD be observable
    await expect(processor({ id: jobIdOf(row.id), data: { emailOutboxId: row.id, organisationId: org.id }, attemptsMade: 0, opts: { attempts: 5 } } as unknown as Job)).resolves.toBeUndefined();
    expect(sink.transmissionsTo(ADDR.crash)).toHaveLength(1);

    // After the 10-minute lease: the SMTP driver cannot dedupe an ambiguous delivery → FAILED DELIVERY_UNCERTAIN, not resent.
    expect(emailService.ambiguousDeliverySafeToRetry).toBe(false);
    await tenantContext.runInTenantContext(ctx, (m) => m.query(`UPDATE core.email_outbox SET processing_at = now() - interval '11 minutes' WHERE id = $1`, [row.id]));
    const { publish, republish } = dispatchSpies();
    const result = await runEmailDispatchCycle(adminDataSource, tenantContext, publish, republish, emailService.ambiguousDeliverySafeToRetry);
    expect(result.deliveryUncertain).toBeGreaterThanOrEqual(1);
    expect([...publish.mock.calls, ...republish.mock.calls].some((c) => (c as unknown[])[0] === row.id)).toBe(false);
    const after = await rowOf(row.id);
    expect(after).toMatchObject({ status: EmailOutboxStatus.FAILED, lastErrorCode: 'DELIVERY_UNCERTAIN' });
    expect((await auditActionsOf(row.id)).map((a) => a.action)).toEqual(['email.delivery_uncertain']);
    expect(sink.transmissionsTo(ADDR.crash)).toHaveLength(1);
  });

  it('no recipient address in any Worker log line, BullMQ failure reason / stacktrace, or stored error message', async () => {
    const addresses = Object.values(ADDR);
    const jobs = await queue.getJobs(['completed', 'failed']);
    const bullText = jobs.map((j) => `${j.failedReason ?? ''}\n${(j.stacktrace ?? []).join('\n')}`).join('\n');
    const stored = await tenantContext.runInTenantContext(ctx, (m) =>
      m.query<Array<{ last_error_message_sanitized: string | null }>>(`SELECT last_error_message_sanitized FROM core.email_outbox WHERE id = ANY($1::uuid[])`, [
        Object.values(rows).filter(Boolean).map((r) => r!.id),
      ]),
    );
    const storedText = stored.map((r) => r.last_error_message_sanitized ?? '').join('\n');
    expect(failedLogLines.length).toBeGreaterThan(0); // the listener did log the failed attempts
    expect(bullText).toContain('[address]'); // and the replies really carried a mailbox that was redacted
    for (const address of addresses) {
      expect(failedLogLines.join('\n')).not.toContain(address);
      expect(consoleLines.join('\n')).not.toContain(address);
      expect(bullText).not.toContain(address);
      expect(storedText).not.toContain(address);
    }
  });
});
