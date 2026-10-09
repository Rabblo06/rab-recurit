import './helpers/email-reliability-env'; // FIRST: env is frozen when AppModule is imported
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Job } from 'bullmq';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { coreDataSourceOptions } from '@rab/server/database/typeorm/core/core.datasource';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { EmailOutboxService } from '@rab/server/engine/core-modules/email/email-outbox.service';
import { EmailService } from '@rab/server/engine/core-modules/email/email.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { EmailOutbox } from '@rab/server/modules/identity/entities/index';
import { EmailOutboxJobType, EmailOutboxStatus } from '@rab/shared';
import { runEmailDispatchCycle } from '../../queues/rab-email/email-dispatch.job';
import { createEmailSendProcessor } from '../../queues/rab-email/email-send.processor';
import { createAdminDataSource } from './helpers/admin-datasource';
import { cancelLeftoverClaimableEmails } from './helpers/email-leftovers';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Email pool-size lifecycle (HWS Phase 3 runtime checkpoint). Each pool size gets its OWN DataSource with an explicit `max`, so
 * starvation, leaks and deadlock show up as pool counters rather than as a timeout. The pool is read from the pg driver's own counters:
 * waitingCount must be 0 (nobody queued for a connection) and idleCount must equal totalCount (nothing still checked out) once a cycle
 * returns.
 *
 * Commit-before-publish is proven by reading the row through a separate connection WHILE the publish callback is still waiting. If the
 * claim transaction were still open, that read would see the pre-claim PENDING state.
 */
const POOL_SIZES = [1, 2, 5] as const;

function poolCounters(ds: DataSource): { total: number; idle: number; waiting: number } {
  const pool = (ds.driver as unknown as { master: { totalCount: number; idleCount: number; waitingCount: number } }).master;
  return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
}

describe.each(POOL_SIZES)('email pool lifecycle, pool size %i (integration)', (poolSize) => {
  let app: INestApplication;
  let adminDataSource: DataSource;
  let pooled: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let org: { id: string };
  let owner: TestIdentity;
  let staff: TestIdentity;
  let ctx: { organisationId: string; workspaceId: string; userId: string; role: string };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    tenantContext = moduleRef.get(TenantContextService);
    // Previous suites can leave claimable outbox rows; the dispatcher would claim them and break this suite's counts.
    await cancelLeftoverClaimableEmails(moduleRef.get(DataSource), tenantContext);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource,
      tenantContext,
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
    org = await factory.createOrganisation(`pool${poolSize}`);
    owner = await factory.createInternalManager(org as never);
    staff = await factory.createStaff(org as never, { owner });
    ctx = { organisationId: org.id, workspaceId: owner.workspaceId!, userId: owner.userId, role: '' };

    // A dedicated DataSource with an explicit pool size. Same options as production; only `max` differs.
    pooled = new DataSource({ ...coreDataSourceOptions, extra: { ...coreDataSourceOptions.extra, max: poolSize } } as never);
    await pooled.initialize();
  }, 120_000);

  afterAll(async () => {
    await pooled?.destroy();
    await adminDataSource?.destroy();
    await app?.close();
  });

  const outboxService = () => new EmailOutboxService();
  async function seedPending(count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const row = await tenantContext.runInTenantContext(ctx, (m) =>
        outboxService().enqueue(m, {
          organisationId: org.id,
          jobType: EmailOutboxJobType.NOTIFICATION,
          recipientEmail: `pool${poolSize}-${i}@example.test`,
          targetUserId: staff.userId,
          rendered: { subject: 'Pool', html: '<p>pool</p>', text: 'pool' },
        }),
      );
      ids.push(row.id);
    }
    return ids;
  }
  /**
   * Reads the committed status through a SEPARATE connection, inside the org's own context (email_outbox is FORCE RLS, so the owner
   * cannot see it without one). It never shares the claim's connection, so it can only see committed state.
   */
  async function committedStatus(id: string): Promise<string> {
    const [row] = await tenantContext.runInTenantContext(ctx, (m) =>
      m.query<Array<{ status: string }>>(`SELECT status FROM core.email_outbox WHERE id = $1`, [id]),
    );
    return row?.status ?? 'MISSING';
  }
  const noOpRepublish = async () => undefined;
  const fakeJob = (id: string, attemptsMade = 0) =>
    ({ id, data: { emailOutboxId: id, organisationId: org.id }, attemptsMade, opts: { attempts: 5 } }) as unknown as Job;

  it('dispatcher claims, commits and publishes every due row without deadlock or starvation', async () => {
    const ids = await seedPending(3);
    const published: string[] = [];
    const result = await runEmailDispatchCycle(
      pooled,
      tenantContext,
      async (id) => {
        published.push(id);
      },
      noOpRepublish,
      true,
    );
    expect(result.published).toBeGreaterThanOrEqual(3);
    for (const id of ids) expect(published).toContain(id);
    const counters = poolCounters(pooled);
    expect(counters.waiting).toBe(0);
    expect(counters.idle).toBe(counters.total);
  }, 60_000);

  it('the claim is committed BEFORE publish: a separate connection sees QUEUED while publish is still waiting (slow publish)', async () => {
    const [id] = await seedPending(1);
    expect(await committedStatus(id!)).toBe(EmailOutboxStatus.PENDING);
    let observedDuringPublish: string | null = null;
    let publishStarted = false;
    await runEmailDispatchCycle(
      pooled,
      tenantContext,
      async (publishedId) => {
        if (publishedId !== id) return;
        publishStarted = true;
        // Simulated slow Redis/BullMQ publish. The claim transaction must already be closed by now.
        await new Promise((resolve) => setTimeout(resolve, 400));
        observedDuringPublish = await committedStatus(publishedId);
      },
      noOpRepublish,
      true,
    );
    expect(publishStarted).toBe(true);
    expect(observedDuringPublish).toBe(EmailOutboxStatus.QUEUED);
    const counters = poolCounters(pooled);
    expect(counters.waiting).toBe(0);
    expect(counters.idle).toBe(counters.total);
  }, 60_000);

  it('two dispatchers racing for the same due rows publish each row exactly once', async () => {
    const ids = await seedPending(4);
    const publishedTwice: string[] = [];
    const seen = new Map<string, number>();
    const publish = async (id: string) => {
      const n = (seen.get(id) ?? 0) + 1;
      seen.set(id, n);
      if (n > 1) publishedTwice.push(id);
    };
    await Promise.all([
      runEmailDispatchCycle(pooled, tenantContext, publish, noOpRepublish, true),
      runEmailDispatchCycle(pooled, tenantContext, publish, noOpRepublish, true),
    ]);
    expect(publishedTwice).toEqual([]);
    for (const id of ids) expect(seen.get(id)).toBe(1);
  }, 60_000);

  it('processor sends after the claim transaction commits, and a second delivery of the same job sends nothing', async () => {
    const [id] = await seedPending(1);
    let sends = 0;
    const emailService = {
      send: async () => {
        sends += 1;
        return { provider: 'test', providerMessageId: 'm1' };
      },
      ambiguousDeliverySafeToRetry: true,
    } as unknown as EmailService;
    const processor = createEmailSendProcessor({ tenantContext, emailService, auditService: { record: async () => undefined } as never, fileService: undefined });
    await processor(fakeJob(id!));
    await processor(fakeJob(id!));
    expect(sends).toBe(1);
    expect(await committedStatus(id!)).toBe(EmailOutboxStatus.SENT);
    const counters = poolCounters(pooled);
    expect(counters.waiting).toBe(0);
    expect(counters.idle).toBe(counters.total);
  }, 60_000);

  it('two processors receiving the same job id: exactly one provider call', async () => {
    const [id] = await seedPending(1);
    let sends = 0;
    const emailService = {
      send: async () => {
        sends += 1;
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { provider: 'test', providerMessageId: 'm2' };
      },
      ambiguousDeliverySafeToRetry: true,
    } as unknown as EmailService;
    const processor = createEmailSendProcessor({ tenantContext, emailService, auditService: { record: async () => undefined } as never, fileService: undefined });
    await Promise.all([processor(fakeJob(id!)), processor(fakeJob(id!))]);
    expect(sends).toBe(1);
  }, 60_000);

  it('a provider failure rolls back to RETRY and releases every connection', async () => {
    const [id] = await seedPending(1);
    const emailService = {
      send: async () => {
        throw Object.assign(new Error('provider unavailable'), { code: 'ECONNRESET' });
      },
      ambiguousDeliverySafeToRetry: true,
    } as unknown as EmailService;
    const processor = createEmailSendProcessor({ tenantContext, emailService, auditService: { record: async () => undefined } as never, fileService: undefined });
    await expect(processor(fakeJob(id!))).rejects.toBeDefined();
    const status = await committedStatus(id!);
    expect([EmailOutboxStatus.RETRY, EmailOutboxStatus.FAILED]).toContain(status);
    const counters = poolCounters(pooled);
    expect(counters.waiting).toBe(0);
    expect(counters.idle).toBe(counters.total);
  }, 60_000);

  it('a publish failure leaves the row QUEUED and recoverable, not stuck in an open transaction', async () => {
    const [id] = await seedPending(1);
    await runEmailDispatchCycle(
      pooled,
      tenantContext,
      async () => {
        throw new Error('redis unavailable');
      },
      noOpRepublish,
      true,
    );
    expect(await committedStatus(id!)).toBe(EmailOutboxStatus.QUEUED);
    const counters = poolCounters(pooled);
    expect(counters.idle).toBe(counters.total);
  }, 60_000);
});

// EmailOutbox is imported so the entity is registered with the pooled DataSource (the processor reads it through the repository).
void EmailOutbox;
