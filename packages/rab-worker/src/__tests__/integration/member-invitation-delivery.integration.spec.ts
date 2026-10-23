import './helpers/email-reliability-env'; // FIRST: env is frozen when AppModule is imported
import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Job } from 'bullmq';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { EmailService } from '@rab/server/engine/core-modules/email/email.service';
import { EmailOutboxService } from '@rab/server/engine/core-modules/email/email-outbox.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { AuthContext } from '@rab/server/engine/core-modules/tenant/auth-context.interface';
import { EmailOutbox, Organisation } from '@rab/server/modules/identity/entities/index';
import { MemberInvitationService } from '@rab/server/modules/membership/services/member-invitation.service';
import { RoleService } from '@rab/server/modules/identity/services/role.service';
import { RoleDefinitionDto } from '@rab/server/modules/identity/dto/role-definition.dto';
import { EmailOutboxJobType, EmailOutboxStatus } from '@rab/shared';
import { createEmailSendProcessor } from '../../queues/rab-email/email-send.processor';
import { createAdminDataSource } from './helpers/admin-datasource';
import { cancelLeftoverClaimableEmails } from './helpers/email-leftovers';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Worker-side guarantees for email-first member invitations, against real PostgreSQL (RLS on) and the real send
 * processor — only the email provider is a counting fake:
 *  - only a CURRENT invitation is ever delivered (not revoked, superseded, accepted or expired; latest email only;
 *    organisation not suspended; same workspace the row was enqueued for);
 *  - the "missing target user ⇒ cancel" safeguard is NOT broadened for any other job type;
 *  - retries never deliver twice.
 */
jest.setTimeout(60_000);
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('member invitation delivery (worker revalidation)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let admin: DataSource;
  let tenantContext: TenantContextService;
  let auditService: AuditService;
  let invitations: MemberInvitationService;
  let factory: TestIdentityFactory;
  let org: Organisation;
  let owner: TestIdentity;
  let ctx: AuthContext;
  let roles: RoleService;
  let roleId: string;
  // The current RoleDefinitionDto shape (custom roles are object rules, not raw permission keys): a member role that can
  // "See" Staff only — the same effective grant (staff.view) the old `permissionKeys: ['staff.view']` fixture asked for.
  const staffViewerRole = (name: string): RoleDefinitionDto => ({
    name,
    assignableToMembers: true,
    readAllObjects: false,
    objects: [{ object: 'staff', read: 'grant' }],
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    await cancelLeftoverClaimableEmails(dataSource, tenantContext);
    auditService = moduleRef.get(AuditService);
    invitations = moduleRef.get(MemberInvitationService);
    roles = moduleRef.get(RoleService);
    admin = createAdminDataSource();
    await admin.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource: admin, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
    const redis = new Redis(process.env.REDIS_URL!);
    const keys = await redis.keys('crewflow:*:invite-rate:*');
    if (keys.length) await redis.del(...keys);
    await redis.quit();
    org = await factory.createOrganisation('inv-deliv');
    owner = await factory.createInternalManager(org, { permissions: 'production' });
    ctx = { organisationId: org.id, workspaceId: owner.workspaceId!, userId: owner.userId, role: '' };
    roleId = (await roles.create(ctx, staffViewerRole('Delivery member'))).id;
  });

  afterAll(async () => {
    await app.close();
    await admin.destroy();
  });

  const fakeJob = (outboxId: string, organisationId = org.id) =>
    ({ id: outboxId, data: { emailOutboxId: outboxId, organisationId }, attemptsMade: 0, opts: { attempts: 5 } }) as unknown as Job;
  function countingProvider() {
    const calls: string[] = [];
    const service = { send: async (o: { to: string }) => { calls.push(o.to); return { provider: 'RESEND', providerMessageId: `msg_${calls.length}` }; }, ambiguousDeliverySafeToRetry: true } as unknown as EmailService;
    return { calls, service };
  }
  const processorWith = (emailService: EmailService) => createEmailSendProcessor({ tenantContext, emailService, auditService });

  async function invite(address = `w-${randomUUID().slice(0, 8)}@example.test`): Promise<{ id: string; address: string }> {
    const { results } = await invitations.send(ctx, [address], roleId);
    expect(results[0]!.outcome).toBe('invited');
    return { id: results[0]!.invitation!.id, address };
  }
  async function outboxRows(invitationId: string): Promise<Array<{ id: string; status: string }>> {
    return admin.query(`SELECT id, status FROM core.email_outbox WHERE member_invitation_id = $1 ORDER BY created_at, id`, [invitationId]);
  }
  const statusOf = async (id: string) => (await admin.query(`SELECT status, last_error_message_sanitized FROM core.email_outbox WHERE id = $1`, [id]))[0];

  it('W1: a current invitation is delivered once, with no target user, and later shows as Sent', async () => {
    const { id, address } = await invite();
    const [row] = await outboxRows(id);
    const provider = countingProvider();
    await processorWith(provider.service)(fakeJob(row!.id));
    expect(provider.calls).toEqual([address]);
    expect((await statusOf(row!.id)).status).toBe(EmailOutboxStatus.SENT);
    const listed = await invitations.list(ctx, 1, 100);
    expect(listed.data.find((i) => i.id === id)?.status).toBe('sent');
  });

  it('W2: a retried job after delivery never sends a second email (idempotent)', async () => {
    const { id } = await invite();
    const [row] = await outboxRows(id);
    const provider = countingProvider();
    await processorWith(provider.service)(fakeJob(row!.id));
    await processorWith(provider.service)(fakeJob(row!.id));
    expect(provider.calls).toHaveLength(1);
  });

  it('W3: a revoked invitation is never delivered', async () => {
    const { id } = await invite();
    const [row] = await outboxRows(id);
    // Simulate the worker picking up a row whose cancellation it raced: put it back to QUEUED, then revoke.
    await invitations.revoke(ctx, id);
    await admin.query(`UPDATE core.email_outbox SET status = 'QUEUED', cancelled_at = NULL WHERE id = $1`, [row!.id]);
    const provider = countingProvider();
    await processorWith(provider.service)(fakeJob(row!.id));
    expect(provider.calls).toHaveLength(0);
    expect(await statusOf(row!.id)).toMatchObject({ status: EmailOutboxStatus.CANCELLED, last_error_message_sanitized: 'Invitation was revoked before delivery.' });
  });

  it('W4: after a resend, the older email (dead link) is never delivered; the newest one is', async () => {
    const { id } = await invite();
    await invitations.resend(ctx, id);
    const [older, newer] = await outboxRows(id);
    await admin.query(`UPDATE core.email_outbox SET status = 'QUEUED', cancelled_at = NULL WHERE id = $1`, [older!.id]);
    const provider = countingProvider();
    await processorWith(provider.service)(fakeJob(older!.id));
    expect(provider.calls).toHaveLength(0);
    expect((await statusOf(older!.id)).last_error_message_sanitized).toBe('A newer invitation email supersedes this one.');
    await processorWith(provider.service)(fakeJob(newer!.id));
    expect(provider.calls).toHaveLength(1);
  });

  it('W5: an expired invitation is not delivered', async () => {
    const { id } = await invite();
    const [row] = await outboxRows(id);
    await admin.query(`UPDATE core.member_invitation SET expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
    const provider = countingProvider();
    await processorWith(provider.service)(fakeJob(row!.id));
    expect(provider.calls).toHaveLength(0);
    expect((await statusOf(row!.id)).last_error_message_sanitized).toBe('Invitation expired before delivery.');
  });

  it('W6: a row re-pointed at another workspace is cancelled (scope is checked, not assumed)', async () => {
    const other = await factory.createInternalManager(org, { permissions: 'production' });
    const { id } = await invite();
    const [row] = await outboxRows(id);
    await admin.query(`UPDATE core.email_outbox SET workspace_id = $2 WHERE id = $1`, [row!.id, other.workspaceId]);
    const provider = countingProvider();
    await processorWith(provider.service)(fakeJob(row!.id));
    expect(provider.calls).toHaveLength(0);
    expect((await statusOf(row!.id)).status).toBe(EmailOutboxStatus.CANCELLED);
  });

  it('W7: a suspended organisation receives no invitation email', async () => {
    const suspendedOrg = await factory.createOrganisation('inv-susp');
    const m = await factory.createInternalManager(suspendedOrg, { permissions: 'production' });
    const sctx: AuthContext = { organisationId: suspendedOrg.id, workspaceId: m.workspaceId!, userId: m.userId, role: '' };
    const suspendedRole = await roles.create(sctx, staffViewerRole('Suspended member'));
    const { results } = await invitations.send(sctx, [`s-${randomUUID().slice(0, 8)}@example.test`], suspendedRole.id);
    const [row] = await outboxRows(results[0]!.invitation!.id);
    await admin.query(`UPDATE core.organisation SET suspended_at = now(), suspended_by = $2 WHERE id = $1`, [suspendedOrg.id, m.userId]);
    const provider = countingProvider();
    await processorWith(provider.service)(fakeJob(row!.id, suspendedOrg.id));
    expect(provider.calls).toHaveLength(0);
    expect((await statusOf(row!.id)).last_error_message_sanitized).toBe('The organisation is suspended.');
  });

  it('W8: the missing-target-user safeguard is unchanged for every other job type', async () => {
    const row = await tenantContext.runInTenantContext(ctx, (m) =>
      new EmailOutboxService().enqueue(m, { organisationId: org.id, jobType: EmailOutboxJobType.NOTIFICATION, recipientEmail: 'nobody@example.test', rendered: { subject: 'x', text: 'x' } }),
    );
    const provider = countingProvider();
    await processorWith(provider.service)(fakeJob(row.id));
    expect(provider.calls).toHaveLength(0);
    expect((await statusOf(row.id)).last_error_message_sanitized).toMatch(/Target user reference is missing/);
  });

  it('W9: an invitation email without an invitation link is unrepresentable (schema CHECK)', async () => {
    await expect(
      tenantContext.runInTenantContext(ctx, (m) =>
        m.save(m.create(EmailOutbox, { organisationId: org.id, jobType: EmailOutboxJobType.MEMBER_INVITATION, status: EmailOutboxStatus.PENDING, recipientEmail: 'x@example.test', renderedSubject: 'x' })),
      ),
    ).rejects.toThrow(/email_outbox_member_invitation_link/);
  });
});
