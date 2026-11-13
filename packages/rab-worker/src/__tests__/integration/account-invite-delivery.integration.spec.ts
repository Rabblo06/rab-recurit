import './helpers/email-reliability-env'; // FIRST: env is frozen when AppModule is imported
import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { EmailService } from '@rab/server/engine/core-modules/email/email.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { AuthContext } from '@rab/server/engine/core-modules/tenant/auth-context.interface';
import { ThrottlerRedisClientProvider } from '@rab/server/engine/core-modules/throttler/throttler-redis-client.provider';
import { WORKER_HEARTBEAT_KEY } from '@rab/server/engine/worker-shared/heartbeat.constants';
import { Organisation } from '@rab/server/modules/identity/entities/index';
import { StaffService } from '@rab/server/modules/staff/services/staff.service';
import { EmailOutboxStatus } from '@rab/shared';
import { createEmailSendProcessor } from '../../queues/rab-email/email-send.processor';
import { createAdminDataSource } from './helpers/admin-datasource';
import { cancelLeftoverClaimableEmails } from './helpers/email-leftovers';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { integrationTestDatabaseReady } from '@rab/server/database/typeorm/core/integration-test-database-gate';

/**
 * Phase D-Q owner decision (2026-11-02, "always queue"): a Staff/Manager account invite is queued even when the Worker
 * heartbeat is missing, and delivered when the Worker returns. These cases prove, against real PostgreSQL (RLS on) and
 * the real send processor (only the provider is a counting fake), that an invite queued while the Worker was down is
 * delivered exactly once if it is still current — and NEVER delivered if by the time the Worker runs it was revoked
 * (Cancel invitation), superseded by a resend, or has EXPIRED (the last one is new: before this change the consumer did
 * not check `expires_at`, so I4 fails on the old code).
 */
jest.setTimeout(60_000);
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb(
  'account invite delivery when queued while the Worker was down (worker revalidation)',
  () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let admin: DataSource;
    let tenantContext: TenantContextService;
    let auditService: AuditService;
    let staff: StaffService;
    let redis: ThrottlerRedisClientProvider;
    let factory: TestIdentityFactory;
    let org: Organisation;
    let otherOrg: Organisation;
    let owner: TestIdentity;
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
      await cancelLeftoverClaimableEmails(dataSource, tenantContext);
      auditService = moduleRef.get(AuditService);
      staff = moduleRef.get(StaffService);
      redis = moduleRef.get(ThrottlerRedisClientProvider);
      admin = createAdminDataSource();
      await admin.initialize();
      factory = new TestIdentityFactory({
        app,
        dataSource,
        adminDataSource: admin,
        tenantContext,
        passwordHashing: moduleRef.get(PasswordHashingService),
      });
      org = await factory.createOrganisation('inv-down');
      otherOrg = await factory.createOrganisation('inv-down-other');
      owner = await factory.createInternalManager(org, {
        permissions: 'production',
      });
      ctx = {
        ...(await factory.signedInContext(owner)),
        workspaceId: owner.workspaceId!,
        role: '',
      };
    });

    beforeEach(async () => {
      // The Worker is "down": no heartbeat key at all (a stopped Worker or a wiped Redis).
      await redis.client.del(WORKER_HEARTBEAT_KEY);
    });

    afterAll(async () => {
      await app.close();
      await admin.destroy();
    });

    const fakeJob = (outboxId: string, organisationId = org.id) =>
      ({
        id: outboxId,
        data: { emailOutboxId: outboxId, organisationId },
        attemptsMade: 0,
        opts: { attempts: 5 },
      }) as unknown as Job;
    function countingProvider() {
      const calls: string[] = [];
      const service = {
        send: async (o: { to: string }) => {
          calls.push(o.to);
          return {
            provider: 'RESEND',
            providerMessageId: `msg_${calls.length}`,
          };
        },
        ambiguousDeliverySafeToRetry: true,
      } as unknown as EmailService;
      return { calls, service };
    }
    const processorWith = (emailService: EmailService) =>
      createEmailSendProcessor({ tenantContext, emailService, auditService });

    async function createInvitedStaff(): Promise<{
      profileId: string;
      userId: string;
      email: string;
      emailQueued: boolean;
    }> {
      const email = `down-${randomUUID().slice(0, 8)}@example.test`;
      const created = await staff.create(ctx, {
        email,
        firstName: 'Queued',
        lastName: 'Invite',
      } as never);
      const [user] = await admin.query<Array<{ id: string }>>(
        `SELECT id FROM core."user" WHERE organisation_id = $1 AND email = $2`,
        [org.id, email],
      );
      return {
        profileId: created.id,
        userId: user!.id,
        email,
        emailQueued: created.emailQueued,
      };
    }
    const inviteRows = (userId: string) =>
      admin.query<
        Array<{ id: string; status: string; account_invite_id: string }>
      >(
        `SELECT id, status, account_invite_id FROM core.email_outbox WHERE target_user_id = $1 AND job_type = 'ACCOUNT_INVITATION' ORDER BY created_at, id`,
        [userId],
      );
    const statusOf = async (id: string) =>
      (
        await admin.query(
          `SELECT status, last_error_message_sanitized FROM core.email_outbox WHERE id = $1`,
          [id],
        )
      )[0];
    // Simulates the Worker picking the row up later (after whatever the API did meanwhile cancelled it).
    const requeue = (id: string) =>
      admin.query(
        `UPDATE core.email_outbox SET status = 'QUEUED', cancelled_at = NULL WHERE id = $1`,
        [id],
      );

    it('I1: with NO heartbeat the invite is queued (outbox row, not delivered yet); when the Worker returns it is delivered exactly once', async () => {
      const s = await createInvitedStaff();
      expect(s.emailQueued).toBe(true);
      const [row] = await inviteRows(s.userId);
      expect(row).toBeDefined();
      expect(['PENDING', 'QUEUED']).toContain(row!.status);
      const provider = countingProvider();
      await processorWith(provider.service)(fakeJob(row!.id));
      await processorWith(provider.service)(fakeJob(row!.id)); // a duplicate delivery of the same job
      expect(provider.calls).toEqual([s.email]);
      expect((await statusOf(row!.id)).status).toBe(EmailOutboxStatus.SENT);
    });

    it('I2 (abuse): an invite CANCELLED while the Worker was down is never delivered', async () => {
      const s = await createInvitedStaff();
      const [row] = await inviteRows(s.userId);
      await staff.cancelInvite(ctx, s.profileId);
      await requeue(row!.id);
      const provider = countingProvider();
      await processorWith(provider.service)(fakeJob(row!.id));
      expect(provider.calls).toHaveLength(0);
      expect(await statusOf(row!.id)).toMatchObject({
        status: EmailOutboxStatus.CANCELLED,
        last_error_message_sanitized:
          'Invitation was cancelled or superseded before delivery.',
      });
    });

    it('I3 (abuse): after a resend, the older queued invite (dead link) is never delivered; the newest one is, once', async () => {
      const s = await createInvitedStaff();
      await staff.resendInvite(ctx, s.profileId);
      const [older, newer] = await inviteRows(s.userId);
      expect(older!.account_invite_id).not.toBe(newer!.account_invite_id);
      await requeue(older!.id);
      const provider = countingProvider();
      await processorWith(provider.service)(fakeJob(older!.id));
      expect(provider.calls).toHaveLength(0);
      expect((await statusOf(older!.id)).status).toBe(
        EmailOutboxStatus.CANCELLED,
      );
      expect([
        'Invitation was cancelled or superseded before delivery.',
        'A newer invitation now supersedes this one.',
      ]).toContain((await statusOf(older!.id)).last_error_message_sanitized);
      await processorWith(provider.service)(fakeJob(newer!.id));
      expect(provider.calls).toEqual([s.email]);
    });

    it('I4 (abuse, new check): an invite that EXPIRED while the Worker was down is never delivered (cancelled, not sent)', async () => {
      const s = await createInvitedStaff();
      const [row] = await inviteRows(s.userId);
      await admin.query(
        `UPDATE core.account_invite SET expires_at = now() - interval '1 second' WHERE id = $1`,
        [row!.account_invite_id],
      );
      const provider = countingProvider();
      await processorWith(provider.service)(fakeJob(row!.id));
      expect(provider.calls).toHaveLength(0);
      expect(await statusOf(row!.id)).toMatchObject({
        status: EmailOutboxStatus.CANCELLED,
        last_error_message_sanitized: 'Invitation expired before delivery.',
      });
    });

    it('I5 (tenant isolation): a job naming ANOTHER organisation for this row sees nothing under RLS and sends nothing', async () => {
      const s = await createInvitedStaff();
      const [row] = await inviteRows(s.userId);
      const provider = countingProvider();
      // Not visible under the other organisation's context ⇒ the processor throws (BullMQ retries), never sends.
      await expect(
        processorWith(provider.service)(fakeJob(row!.id, otherOrg.id)),
      ).rejects.toBeDefined();
      expect(provider.calls).toHaveLength(0);
      expect(['PENDING', 'QUEUED']).toContain((await statusOf(row!.id)).status);
    });
  },
);
