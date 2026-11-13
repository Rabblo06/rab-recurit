import './helpers/email-reliability-env'; // FIRST: env is frozen when AppModule is imported (own Redis DB index)
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Job, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { AuditAction, AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { AuthService } from '@rab/server/engine/core-modules/auth/services/auth.service';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { EmailService } from '@rab/server/engine/core-modules/email/email.service';
import { EMAIL_QUEUE_NAME } from '@rab/server/engine/core-modules/email/email-queue.constants';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { AuthContext } from '@rab/server/engine/core-modules/tenant/auth-context.interface';
import { Organisation } from '@rab/server/modules/identity/entities/index';
import { StaffService } from '@rab/server/modules/staff/services/staff.service';
import { EmailOutboxStatus } from '@rab/shared';
import { createEmailSendProcessor } from '../../queues/rab-email/email-send.processor';
import { createAdminDataSource } from './helpers/admin-datasource';
import { cancelLeftoverClaimableEmails } from './helpers/email-leftovers';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { integrationTestDatabaseReady } from '@rab/server/database/typeorm/core/integration-test-database-gate';

/**
 * Soak review defect (a): account and auth emails fast-published their outbox row from INSIDE the transaction that wrote
 * it, so the Worker could run `email-outbox.<id>.attempt.0` before COMMIT, find no row, and spend a BullMQ retry on
 * "not visible yet". Real PostgreSQL (RLS on), real Redis + BullMQ (this suite's own Redis DB index) and a real BullMQ
 * Worker running the real send processor (only the provider is a counting fake). Each producing transaction is HELD open
 * for HOLD_MS after it registered its publish (an audit write inside the same transaction is slowed), which on the old code
 * made the Worker's first attempt fail every time. Now:
 *
 *  P1 invite (StaffService.create → AccountLifecycleService.sendAccountInvite): no job while the transaction is open; after
 *     COMMIT the FIRST attempt finds the row and sends it (one processor run, attemptsMade 0, no error, cap count 1).
 *  P2 forgot password (AuthService.forgotPassword): the same.
 *  P3 rollback: the producing transaction fails after registering the publish → no row, no job, nothing processed.
 *  P4 abuse (account discovery): forgot password for a nonexistent email → same (empty) response, no row, no job.
 */
jest.setTimeout(90_000);
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
const HOLD_MS = 1_500;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeIfDb('account/auth email fast publish happens only after COMMIT (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let admin: DataSource;
  let tenantContext: TenantContextService;
  let auditService: AuditService;
  let auth: AuthService;
  let staff: StaffService;
  let factory: TestIdentityFactory;
  let org: Organisation;
  let owner: TestIdentity;
  let ctx: AuthContext;
  let producer: Redis;
  let consumer: Redis;
  let jobs: Queue;
  let worker: Worker;
  /** Every processor run of the real BullMQ Worker: which job, how many attempts BullMQ had already made, and any error. */
  const runs: Array<{ jobId: string; emailOutboxId: string; attemptsMade: number; error?: string }> = [];
  const sent: string[] = [];
  /** Audit actions to slow down (inside the producing transaction) or to fail (so that transaction rolls back). */
  const hold = new Map<string, 'hold' | 'fail'>();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    await cancelLeftoverClaimableEmails(dataSource, tenantContext);
    auditService = moduleRef.get(AuditService);
    auth = moduleRef.get(AuthService);
    staff = moduleRef.get(StaffService);
    admin = createAdminDataSource();
    await admin.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource: admin, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
    org = await factory.createOrganisation('pac');
    owner = await factory.createInternalManager(org, { permissions: 'production' });
    ctx = { ...(await factory.signedInContext(owner)), workspaceId: owner.workspaceId!, role: '' };

    const realRecord = auditService.record.bind(auditService) as (...args: unknown[]) => Promise<unknown>;
    jest.spyOn(auditService, 'record').mockImplementation((async (...args: unknown[]) => {
      const mode = hold.get(args[2] as string);
      if (mode === 'hold') await sleep(HOLD_MS);
      if (mode === 'fail') throw new Error('simulated failure inside the producing transaction');
      return realRecord(...args);
    }) as never);

    producer = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    consumer = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    jobs = new Queue(EMAIL_QUEUE_NAME, { connection: producer });
    await jobs.obliterate({ force: true });
    const emailService = {
      send: async (o: { to: string }) => {
        sent.push(o.to);
        return { provider: 'RESEND', providerMessageId: `msg_${sent.length}` };
      },
      ambiguousDeliverySafeToRetry: true,
    } as unknown as EmailService;
    const processor = createEmailSendProcessor({ tenantContext, emailService, auditService });
    worker = new Worker(
      EMAIL_QUEUE_NAME,
      async (job: Job) => {
        const run: (typeof runs)[number] = { jobId: String(job.id), emailOutboxId: job.data.emailOutboxId, attemptsMade: job.attemptsMade };
        runs.push(run);
        try {
          await processor(job);
        } catch (error) {
          run.error = (error as Error).message;
          throw error;
        }
      },
      { connection: consumer, concurrency: 5 },
    );
    await worker.waitUntilReady();
  });

  afterEach(() => hold.clear());

  afterAll(async () => {
    jest.restoreAllMocks();
    await worker.close();
    await jobs.obliterate({ force: true });
    await jobs.close();
    await producer.quit();
    await consumer.quit();
    await app.close();
    await admin.destroy();
  });

  // Fail closed around every case: RLS intact, and a query with no tenant context bound sees no outbox row.
  async function assertNoContextZeroRows(): Promise<void> {
    const [flags] = await dataSource.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'core.email_outbox'::regclass");
    expect(flags).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect(await dataSource.query('SELECT id FROM core.email_outbox')).toEqual([]);
  }
  beforeEach(assertNoContextZeroRows);
  afterEach(assertNoContextZeroRows);

  /** Owner-side reads (bypass RLS on purpose: the assertion must see the row whatever context the code bound). */
  const rowsTo = (email: string, jobType: string) =>
    admin.query<Array<{ id: string; status: string; count: number; generation: number }>>(
      `SELECT id, status, infrastructure_attempt_count AS count, dispatch_generation AS generation FROM core.email_outbox
        WHERE recipient_email = $1 AND job_type = $2 ORDER BY created_at`,
      [email, jobType],
    );
  const jobFor = (rowId: string) => jobs.getJob(`email-outbox.${rowId}.attempt.0`);
  /** Every job id the queue holds, in any state. */
  const jobIds = async () => new Set((await jobs.getJobs(['waiting', 'active', 'delayed', 'failed', 'completed', 'prioritized', 'waiting-children', 'paused'])).map((j) => String(j.id)));
  async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
    const until = Date.now() + ms;
    let v = await read();
    while (!ok(v) && Date.now() < until) {
      await sleep(50);
      v = await read();
    }
    return v;
  }

  /**
   * Runs `produce` with `action` held open inside its transaction. While it is held, polls for the outbox row (visible to the
   * owner connection only after COMMIT) and the BullMQ job, and records whether the job existed or the Worker ran before the
   * commit. Returns the committed row.
   */
  async function produceHeld(action: string, email: string, jobType: string, produce: () => Promise<unknown>) {
    hold.set(action, 'hold');
    const runsBefore = runs.length;
    const started = Date.now();
    const done = produce();
    await sleep(HOLD_MS / 2);
    // Mid-hold: the transaction is still open, so its row is not committed, the Worker has run nothing, and the job ids the
    // queue holds now must not include this row's job (checked once the row id is known, after COMMIT).
    expect(await rowsTo(email, jobType)).toEqual([]);
    expect(runs.slice(runsBefore)).toEqual([]);
    const midHoldJobIds = await jobIds();
    await done;
    expect(Date.now() - started).toBeGreaterThanOrEqual(HOLD_MS - 5);
    const [row] = await eventually(
      () => rowsTo(email, jobType),
      (r) => r[0]?.status === EmailOutboxStatus.SENT,
    );
    expect(midHoldJobIds.has(`email-outbox.${row!.id}.attempt.0`)).toBe(false);
    // No run of ANY job in this window hit the "not visible yet" safety net.
    expect(runs.slice(runsBefore).filter((r) => r.error)).toEqual([]);
    return { row: row!, runs: runs.slice(runsBefore).filter((r) => r.emailOutboxId === row!.id) };
  }

  it('P1 invite: no job while the creating transaction is open; the first attempt after COMMIT finds the row and sends it', async () => {
    const email = `pac-inv-${randomUUID().slice(0, 8)}@example.test`;
    const { row, runs: mine } = await produceHeld(AuditAction.INVITE_EMAIL_QUEUED, email, 'ACCOUNT_INVITATION', () =>
      staff.create(ctx, { email, firstName: 'After', lastName: 'Commit' } as never),
    );
    expect(row).toMatchObject({ status: EmailOutboxStatus.SENT, count: 1, generation: 0 });
    expect(mine).toEqual([{ jobId: `email-outbox.${row.id}.attempt.0`, emailOutboxId: row.id, attemptsMade: 0 }]);
    const job = await jobFor(row.id);
    expect(job?.failedReason).toBeFalsy();
    expect(sent.filter((to) => to === email)).toEqual([email]);
  });

  it('P2 forgot password: no job while the request transaction is open; the first attempt after COMMIT finds the row', async () => {
    const person = await factory.createStaff(org, { owner, label: 'pac-fp' });
    const { row, runs: mine } = await produceHeld(AuditAction.PASSWORD_RESET_REQUESTED, person.email, 'PASSWORD_RESET', () =>
      auth.forgotPassword({ email: person.email }),
    );
    expect(row).toMatchObject({ status: EmailOutboxStatus.SENT, count: 1, generation: 0 });
    expect(mine).toEqual([{ jobId: `email-outbox.${row.id}.attempt.0`, emailOutboxId: row.id, attemptsMade: 0 }]);
    expect((await jobFor(row.id))?.failedReason).toBeFalsy();
  });

  it('P3 rollback: the producing transaction fails after registering the publish → no row, no job, nothing processed', async () => {
    const email = `pac-rb-${randomUUID().slice(0, 8)}@example.test`;
    hold.set(AuditAction.INVITE_EMAIL_QUEUED, 'fail');
    const runsBefore = runs.length;
    const idsBefore = await jobIds();
    await expect(staff.create(ctx, { email, firstName: 'Rolled', lastName: 'Back' } as never)).rejects.toThrow();
    await sleep(1_000);
    expect(await rowsTo(email, 'ACCOUNT_INVITATION')).toEqual([]);
    expect(await jobIds()).toEqual(idsBefore);
    expect(runs.slice(runsBefore)).toEqual([]);
  });

  it('P4 abuse: forgot password for a nonexistent email → the same empty response, no row, no job, no processor run', async () => {
    const email = `pac-none-${randomUUID().slice(0, 8)}@example.test`;
    const runsBefore = runs.length;
    const idsBefore = await jobIds();
    await expect(auth.forgotPassword({ email })).resolves.toBeUndefined();
    await sleep(500);
    expect(await admin.query(`SELECT id FROM core.email_outbox WHERE recipient_email = $1`, [email])).toEqual([]);
    expect(await jobIds()).toEqual(idsBefore);
    expect(runs.slice(runsBefore)).toEqual([]);
  });
});
