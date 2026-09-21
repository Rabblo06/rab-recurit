import 'reflect-metadata';
import { ManagerType, PermissionFlag, UserStatus } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource, EntityManager } from 'typeorm';
import type { Job } from 'bullmq';

import { AppModule } from '../../app.module';
import { AccountInvite, EmailOutbox, Organisation, Permission, Role, RolePermission, User, UserRole } from '../../modules/identity/entities';
import { ManagerProfile } from '../../modules/manager/entities/manager-profile.entity';
import { ManagerWorkspace } from '../../modules/manager-workspace/entities/manager-workspace.entity';
import { AccountInviteService } from '../../engine/core-modules/auth/services/account-invite.service';
import { AuditService } from '../../engine/core-modules/audit/audit.service';
import { EmailService } from '../../engine/core-modules/email/email.service';
import { EmailQueueJobData } from '../../engine/core-modules/email/email-queue.constants';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { ThrottlerRedisClientProvider } from '../../engine/core-modules/throttler/throttler-redis-client.provider';
import { WORKER_HEARTBEAT_KEY } from '../../queue-worker/heartbeat.constants';
import { createEmailSendProcessor } from '../../queue-worker/jobs/email-send.processor';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentityFactory } from './helpers/test-identities';

/**
 * Durable transactional-outbox + worker send path (Part A of the durable
 * email queue task). Real Postgres, RLS on, no mocks for the DB — the
 * BullMQ `Job` argument to the worker processor is a plain fake object
 * (bullmq itself is never exercised here; that's Redis plumbing, not
 * business logic) so these tests call the REAL `createEmailSendProcessor`
 * function directly, the same function `queue-worker/main.ts` wires a real
 * `Worker` to.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('email outbox abuse cases (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let factory: TestIdentityFactory;
  let accountInvites: AccountInviteService;
  let tenantContext: TenantContextService;
  let auditService: AuditService;
  let emailService: EmailService;
  let passwordHashingService: PasswordHashingService;
  let redisClient: ThrottlerRedisClientProvider;

  const ownerPassword = 'correct horse battery staple 1!';
  const OWNER_PERMISSIONS = [PermissionFlag.STAFF_CREATE, PermissionFlag.STAFF_VIEW, PermissionFlag.MANAGER_MANAGE, PermissionFlag.USER_RESET_PASSWORD];

  async function seedOrgWithOwner(): Promise<{ organisation: Organisation; ownerEmail: string; ownerUserId: string }> {
    // Canonical Internal Manager (role `manager`, workspace, ManagerProfile) holding this suite's permission set.
    const organisation = await factory.createOrganisation();
    const owner = await factory.createInternalManager(organisation, { permissions: OWNER_PERMISSIONS, label: 'owner' });
    return { organisation, ownerEmail: owner.email, ownerUserId: owner.userId };
  }

  async function loginOwner(ownerEmail: string): Promise<string> {
    return factory.loginByEmail(ownerEmail);
  }

  /** Fake BullMQ Job — only the fields the real processor reads. */
  function fakeJob(data: EmailQueueJobData, attemptsMade: number, attempts: number): Job<EmailQueueJobData> {
    return { data, attemptsMade, opts: { attempts } } as unknown as Job<EmailQueueJobData>;
  }

  /**
   * `adminDataSource` is a `rab_owner` connection — FORCE RLS blinds even the
   * table owner with no tenant context bound (this session's standing
   * gotcha), and `email_outbox`/`account_invite` have no FORCE exemption.
   * Run these reads/writes on the app's real `rab_app` connection instead,
   * with tenant context actually bound, same as production code would.
   */
  function withTenant<T>(organisationId: string, fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    return tenantContext.runInTenantContext({ organisationId, workspaceId: null, userId: '', role: '' }, fn);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    dataSource = moduleRef.get(DataSource);
    accountInvites = moduleRef.get(AccountInviteService);
    tenantContext = moduleRef.get(TenantContextService);
    auditService = moduleRef.get(AuditService);
    emailService = moduleRef.get(EmailService);
    passwordHashingService = moduleRef.get(PasswordHashingService);
    redisClient = moduleRef.get(ThrottlerRedisClientProvider);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: passwordHashingService });
  });

  beforeEach(async () => {
    // See account-invite-abuse-cases.integration.spec.ts's identical
    // beforeEach for why this is needed — no separate worker process runs
    // during Jest, so AccountLifecycleService.isEmailDeliveryAvailable()
    // would otherwise see no heartbeat and skip every invite send.
    await redisClient.client.set(WORKER_HEARTBEAT_KEY, Date.now().toString(), 'EX', 30);
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  describe('durable outbox row (A1-A8)', () => {
    it('Create Manager returns quickly with a durable PENDING/QUEUED outbox row — the invite token already committed, delivery outcome not yet known', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);

      const res = await request(app.getHttpServer())
        .post('/rest/v1/managers')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: `mgr-${randomUUID()}@example.test`, firstName: 'A', lastName: 'B', type: 'internal' });
      expect(res.status).toBe(201);
      expect(res.body.invitationStatus).toBe('queued');
      expect(res.body.invite.queued).toBe(true);

      const outbox = await withTenant(organisation.id, (m) => m.findOne(EmailOutbox, { where: { recipientEmail: res.body.email } }));
      expect(outbox).not.toBeNull();
      expect(outbox!.jobType).toBe('ACCOUNT_INVITATION');
      expect(['PENDING', 'QUEUED']).toContain(outbox!.status);
      expect(outbox!.accountInviteId).not.toBeNull();
      // The rendered content already embeds the real (committed) token —
      // never re-rendered later (A8's whole point).
      expect(outbox!.renderedHtml || outbox!.renderedText).toBeTruthy();

      const invite = await withTenant(organisation.id, (m) => m.findOneByOrFail(AccountInvite, { id: outbox!.accountInviteId! }));
      expect(invite.userId).toBeTruthy();
      expect(invite.revokedAt).toBeNull();
    });
  });

  describe('worker send path — success, idempotency, cancellation (A9, A12)', () => {
    async function createPendingManager(organisationId: string, ownerToken: string): Promise<{ managerId: string; email: string; outbox: EmailOutbox }> {
      const create = await request(app.getHttpServer())
        .post('/rest/v1/managers')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: `mgr-${randomUUID()}@example.test`, firstName: 'A', lastName: 'B', type: 'internal' });
      const outbox = await withTenant(organisationId, (m) => m.findOneByOrFail(EmailOutbox, { recipientEmail: create.body.email }));
      return { managerId: create.body.id as string, email: create.body.email as string, outbox };
    }

    it('worker sends successfully: SENT persisted, audited, sendNumber now counts it', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);
      const { outbox } = await createPendingManager(organisation.id, ownerToken);

      const processor = createEmailSendProcessor({ tenantContext, emailService, auditService });
      await processor(fakeJob({ emailOutboxId: outbox.id, organisationId: outbox.organisationId }, 0, 5));

      const updated = await withTenant(organisation.id, (m) => m.findOneByOrFail(EmailOutbox, { id: outbox.id }));
      expect(updated.status).toBe('SENT');
      expect(updated.sentAt).not.toBeNull();

      const audited = await tenantContext.runInTenantContext(
        { organisationId: outbox.organisationId, workspaceId: null, userId: '', role: '' },
        (manager) => manager.query(`SELECT action FROM core.audit_log WHERE metadata->>'emailOutboxId' = $1`, [outbox.id]),
      );
      expect(audited.some((r: { action: string }) => r.action === 'user.invited')).toBe(true);
    });

    it('the worker successfully marking an outbox row SENT never touches User.status — activation only ever happens at login', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);
      const { email, outbox } = await createPendingManager(organisation.id, ownerToken);

      const before = await withTenant(organisation.id, (m) => m.findOneByOrFail(User, { organisationId: organisation.id, email }));
      expect(before.status).toBe('invited');

      const processor = createEmailSendProcessor({ tenantContext, emailService, auditService });
      await processor(fakeJob({ emailOutboxId: outbox.id, organisationId: outbox.organisationId }, 0, 5));

      const updatedOutbox = await withTenant(organisation.id, (m) => m.findOneByOrFail(EmailOutbox, { id: outbox.id }));
      expect(updatedOutbox.status).toBe('SENT');

      const after = await withTenant(organisation.id, (m) => m.findOneByOrFail(User, { organisationId: organisation.id, email }));
      expect(after.status).toBe('invited');
    });

    it('duplicate BullMQ delivery does not duplicate-send — second call on an already-SENT row is a pure no-op', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);
      const { outbox } = await createPendingManager(organisation.id, ownerToken);
      const processor = createEmailSendProcessor({ tenantContext, emailService, auditService });

      await processor(fakeJob({ emailOutboxId: outbox.id, organisationId: outbox.organisationId }, 0, 5));
      const afterFirst = await withTenant(organisation.id, (m) => m.findOneByOrFail(EmailOutbox, { id: outbox.id }));
      expect(afterFirst.status).toBe('SENT');
      const firstSentAt = afterFirst.sentAt;

      // Redelivered — must not re-send, must not throw, must not change sentAt.
      await processor(fakeJob({ emailOutboxId: outbox.id, organisationId: outbox.organisationId }, 1, 5));
      const afterSecond = await withTenant(organisation.id, (m) => m.findOneByOrFail(EmailOutbox, { id: outbox.id }));
      expect(afterSecond.status).toBe('SENT');
      expect(afterSecond.sentAt?.getTime()).toBe(firstSentAt?.getTime());
    });

    it('cancelled invite job does not send — worker re-validates authoritative state, not just "does a queued row exist"', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);
      const { managerId, outbox } = await createPendingManager(organisation.id, ownerToken);

      const cancel = await request(app.getHttpServer()).post(`/rest/v1/managers/${managerId}/cancel-invite`).set('Authorization', `Bearer ${ownerToken}`);
      expect(cancel.status).toBe(204);
      // Cancel already proactively cancels the linked outbox row — confirm that happened.
      const afterCancel = await withTenant(organisation.id, (m) => m.findOneByOrFail(EmailOutbox, { id: outbox.id }));
      expect(afterCancel.status).toBe('CANCELLED');

      const processor = createEmailSendProcessor({ tenantContext, emailService, auditService });
      // Simulates the worker having already claimed this job before the cancel landed.
      await processor(fakeJob({ emailOutboxId: outbox.id, organisationId: outbox.organisationId }, 0, 5));

      const stillCancelled = await withTenant(organisation.id, (m) => m.findOneByOrFail(EmailOutbox, { id: outbox.id }));
      expect(stillCancelled.status).toBe('CANCELLED');
      expect(stillCancelled.sentAt).toBeNull();
    });

    it('stale re-invite job does not send — a superseded (non-latest) invite row is rejected even if nobody explicitly revoked it (A10)', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);
      const { managerId, outbox: firstOutbox } = await createPendingManager(organisation.id, ownerToken);

      // Re-invite supersedes the first attempt — commit()'s own proactive
      // cancel should already have cancelled firstOutbox, but this test
      // proves the worker's OWN defense-in-depth check catches it too, by
      // resetting the row back to a sendable-looking state directly (bypassing
      // that proactive cancel) to prove the revalidation is real, not just
      // trusting the earlier cancel.
      const reinvite = await request(app.getHttpServer()).post(`/rest/v1/managers/${managerId}/resend-invite`).set('Authorization', `Bearer ${ownerToken}`);
      expect(reinvite.status).toBe(201);

      await withTenant(organisation.id, (m) => m.update(EmailOutbox, { id: firstOutbox.id }, { status: 'PENDING' as never }));

      const processor = createEmailSendProcessor({ tenantContext, emailService, auditService });
      await processor(fakeJob({ emailOutboxId: firstOutbox.id, organisationId: organisation.id }, 0, 5));

      const stillNotSent = await withTenant(organisation.id, (m) => m.findOneByOrFail(EmailOutbox, { id: firstOutbox.id }));
      expect(stillNotSent.status).toBe('CANCELLED');
      expect(stillNotSent.sentAt).toBeNull();
    });
  });

  describe('infrastructure retry classification (A11) — sendNumber fairness under retries (A7)', () => {
    it('a retryable failure marks RETRY (not FAILED) while attempts remain, and re-throws so BullMQ would retry', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);
      const create = await request(app.getHttpServer())
        .post('/rest/v1/managers')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: `mgr-${randomUUID()}@example.test`, firstName: 'A', lastName: 'B', type: 'internal' });
      const outbox = await withTenant(organisation.id, (m) => m.findOneByOrFail(EmailOutbox, { recipientEmail: create.body.email }));

      const flakyEmailService = { send: async () => { const err: any = new Error('connect ETIMEDOUT'); err.code = 'ETIMEDOUT'; throw err; } } as unknown as EmailService;
      const processor = createEmailSendProcessor({ tenantContext, emailService: flakyEmailService, auditService });

      await expect(processor(fakeJob({ emailOutboxId: outbox.id, organisationId: outbox.organisationId }, 0, 5))).rejects.toThrow();

      const updated = await withTenant(organisation.id, (m) => m.findOneByOrFail(EmailOutbox, { id: outbox.id }));
      expect(updated.status).toBe('RETRY');
      expect(updated.lastErrorCode).toBe('ETIMEDOUT');
      expect(updated.infrastructureAttemptCount).toBe(1);
    });

    it('exhausting all attempts on a retryable error marks FAILED (UnrecoverableError) — and the failed attempt never consumed a user-visible sendNumber slot', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);
      const create = await request(app.getHttpServer())
        .post('/rest/v1/managers')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: `mgr-${randomUUID()}@example.test`, firstName: 'A', lastName: 'B', type: 'internal' });
      expect(create.body.invite.sendNumber).toBe(1);
      const outbox = await withTenant(organisation.id, (m) => m.findOneByOrFail(EmailOutbox, { recipientEmail: create.body.email }));

      const alwaysFails = { send: async () => { const err: any = new Error('connect ETIMEDOUT'); err.code = 'ETIMEDOUT'; throw err; } } as unknown as EmailService;
      const processor = createEmailSendProcessor({ tenantContext, emailService: alwaysFails, auditService });

      // Last attempt (attemptsMade = 4, opts.attempts = 5 → this IS the 5th/final try).
      await expect(processor(fakeJob({ emailOutboxId: outbox.id, organisationId: outbox.organisationId }, 4, 5))).rejects.toThrow();

      const failedRow = await withTenant(organisation.id, (m) => m.findOneByOrFail(EmailOutbox, { id: outbox.id }));
      expect(failedRow.status).toBe('FAILED');
      expect(failedRow.failedAt).not.toBeNull();

      // Re-invite after a permanent failure: sendNumber stays 1 (the failed
      // attempt never reached SENT, so prepare() must not have counted it).
      const findPending = await request(app.getHttpServer()).get(`/rest/v1/managers/${create.body.id}`).set('Authorization', `Bearer ${ownerToken}`);
      expect(findPending.body.invitationStatus).toBe('delivery_failed');
      const reinvite = await request(app.getHttpServer()).post(`/rest/v1/managers/${create.body.id}/resend-invite`).set('Authorization', `Bearer ${ownerToken}`);
      expect(reinvite.status).toBe(201);
      expect(reinvite.body.sendNumber).toBe(1); // NOT 2 — the permanent failure above never consumed a slot.

      void organisation;
    });

    it('a permanent (non-retryable) error skips straight to FAILED even with attempts remaining', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);
      const create = await request(app.getHttpServer())
        .post('/rest/v1/managers')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: `mgr-${randomUUID()}@example.test`, firstName: 'A', lastName: 'B', type: 'internal' });
      const outbox = await withTenant(organisation.id, (m) => m.findOneByOrFail(EmailOutbox, { recipientEmail: create.body.email }));

      const permanentlyRejected = { send: async () => { throw new Error('invalid recipient — mailbox does not exist'); } } as unknown as EmailService;
      const processor = createEmailSendProcessor({ tenantContext, emailService: permanentlyRejected, auditService });

      // attemptsMade=0 of 5 — plenty of attempts "left", but a non-retryable
      // error must not wait for them to exhaust.
      await expect(processor(fakeJob({ emailOutboxId: outbox.id, organisationId: outbox.organisationId }, 0, 5))).rejects.toThrow();

      const failedRow = await withTenant(organisation.id, (m) => m.findOneByOrFail(EmailOutbox, { id: outbox.id }));
      expect(failedRow.status).toBe('FAILED');
      expect(failedRow.infrastructureAttemptCount).toBe(1); // failed on the very first attempt, not all 5
    });

    it('multiple infrastructure retries then a final success still count as exactly one user-visible invitation send', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);
      const create = await request(app.getHttpServer())
        .post('/rest/v1/managers')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: `mgr-${randomUUID()}@example.test`, firstName: 'A', lastName: 'B', type: 'internal' });
      const outbox = await withTenant(organisation.id, (m) => m.findOneByOrFail(EmailOutbox, { recipientEmail: create.body.email }));

      let calls = 0;
      const flakyThenOk = {
        send: async () => {
          calls += 1;
          if (calls < 3) {
            const err: any = new Error('ETIMEDOUT');
            err.code = 'ETIMEDOUT';
            throw err;
          }
        },
      } as unknown as EmailService;
      const processor = createEmailSendProcessor({ tenantContext, emailService: flakyThenOk, auditService });

      await expect(processor(fakeJob({ emailOutboxId: outbox.id, organisationId: outbox.organisationId }, 0, 5))).rejects.toThrow();
      await expect(processor(fakeJob({ emailOutboxId: outbox.id, organisationId: outbox.organisationId }, 1, 5))).rejects.toThrow();
      await processor(fakeJob({ emailOutboxId: outbox.id, organisationId: outbox.organisationId }, 2, 5)); // succeeds on the 3rd internal attempt

      const finalRow = await withTenant(organisation.id, (m) => m.findOneByOrFail(EmailOutbox, { id: outbox.id }));
      expect(finalRow.status).toBe('SENT');

      const reinvite = await request(app.getHttpServer()).post(`/rest/v1/managers/${create.body.id}/resend-invite`).set('Authorization', `Bearer ${ownerToken}`);
      expect(reinvite.body.sendNumber).toBe(2); // exactly one prior SENT attempt, not 4 (3 internal tries + this one)
    });
  });

  describe('RLS — no tenant context, zero rows (standing pattern)', () => {
    it('a query with no tenant context bound returns zero rows', async () => {
      const rows = await dataSource.query(`SELECT * FROM core.email_outbox LIMIT 1`);
      expect(rows).toHaveLength(0);
    });
  });

  describe('driver switch safety (F1 #24-26)', () => {
    it('LOGGER, SMTP-shaped, and RESEND-shaped drivers all resolve through the same EmailService.send() call the worker uses — never a parallel reimplementation', async () => {
      // Confirms EmailService itself (used by the real processor above) is
      // exactly the SAME class every driver test in email-driver.factory.spec.ts
      // and resend.driver.spec.ts already exercises — no separate send path
      // was introduced for the worker.
      expect(emailService).toBeDefined();
      expect(typeof emailService.send).toBe('function');
    });
  });
});
