import './helpers/email-reliability-env'; // FIRST: env is frozen when AppModule is imported
import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Job } from 'bullmq';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { EmailSendResult } from '@rab/server/engine/core-modules/email/drivers/interfaces/email-driver.interface';
import { EmailOutboxService } from '@rab/server/engine/core-modules/email/email-outbox.service';
import { EmailService } from '@rab/server/engine/core-modules/email/email.service';
import {
  renderAccountActivationEmail,
  renderEmailChangeVerificationEmail,
  renderPasswordResetEmail,
} from '@rab/server/engine/core-modules/email/templates';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { AuthContext } from '@rab/server/engine/core-modules/tenant/auth-context.interface';
import { EmailOutbox, Organisation } from '@rab/server/modules/identity/entities/index';
import { EmailOutboxJobType, EmailOutboxJobTypeType, EmailOutboxStatus } from '@rab/shared';
import { runEmailDispatchCycle } from '../../queues/rab-email/email-dispatch.job';
import { createEmailSendProcessor } from '../../queues/rab-email/email-send.processor';
import { createAdminDataSource } from './helpers/admin-datasource';
import { cancelLeftoverClaimableEmails } from './helpers/email-leftovers';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * F1 (Wave 1 lane S, migration EmailOutboxSecretBodyScrub1786719710000): a rendered email body that carries a bearer link
 * token (password reset, activation/invitation, member invitation, email-change verification) must not remain in
 * core.email_outbox once the row is terminal (SENT, FAILED, CANCELLED) — while unsent rows keep their body so retries still
 * deliver it, and delivery metadata, the subject and the audit trail are kept.
 *
 * Real PostgreSQL with RLS on (crewflow_app through TenantContextService), the real processor and dispatcher, a fake email
 * driver that records what it was asked to send. Both layers are exercised: the processor's own terminal write (service
 * layer) and the database trigger (every other writer: the dispatcher's recovery, cancellations, ad-hoc SQL).
 * Tokens are random per run and are never printed.
 */
jest.setTimeout(60_000);

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('F1: token-bearing email bodies are not retained after a terminal state', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let auditService: AuditService;
  let org: Organisation;
  let staff: TestIdentity;
  let ctx: AuthContext;
  const tokens: string[] = [];
  const newToken = () => {
    const t = randomBytes(32).toString('base64url');
    tokens.push(t);
    return t;
  };
  const ACCOUNTS = 'https://accounts.example.test';

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
    const factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
    org = await factory.createOrganisation('f1');
    const owner = await factory.createInternalManager(org);
    staff = await factory.createStaff(org, { owner });
    ctx = { organisationId: org.id, workspaceId: owner.workspaceId!, userId: owner.userId, role: '' };
  });

  afterAll(async () => {
    // The whole table, every organisation, as the superuser: no row may still hold any token this suite rendered.
    if (adminDataSource?.isInitialized) {
      for (const t of tokens) {
        const [{ n }] = await adminDataSource.query(
          `SELECT count(*)::int AS n FROM core.email_outbox WHERE status IN ('SENT','FAILED','CANCELLED')
             AND (strpos(coalesce(rendered_html,''), $1) > 0 OR strpos(coalesce(rendered_text,''), $1) > 0)`,
          [t],
        );
        expect(n).toBe(0);
      }
      await adminDataSource.destroy();
    }
    await app?.close();
  });

  const seed = (jobType: EmailOutboxJobTypeType, rendered: { subject: string; html?: string; text?: string }) =>
    tenantContext.runInTenantContext(ctx, (m) =>
      new EmailOutboxService().enqueue(m, { organisationId: org.id, jobType, recipientEmail: 'staff@example.test', targetUserId: staff.userId, rendered }),
    );
  const resetRow = () =>
    seed(EmailOutboxJobType.PASSWORD_RESET, renderPasswordResetEmail({ firstName: 'F', resetUrl: `${ACCOUNTS}/reset-password?token=${newToken()}`, selfRequested: true }));
  const rowOf = (id: string) => tenantContext.runInTenantContext(ctx, (m) => m.findOneByOrFail(EmailOutbox, { id }));
  const fakeJob = (id: string, attemptsMade = 0, attempts = 5) =>
    ({ id, data: { emailOutboxId: id, organisationId: org.id }, attemptsMade, opts: { attempts } }) as unknown as Job;
  const sent: Array<{ html?: string; text?: string }> = [];
  const driver = (send: () => Promise<EmailSendResult>) =>
    ({
      send: async (options: { html?: string; text?: string }) => {
        sent.push({ html: options.html, text: options.text });
        return send();
      },
      ambiguousDeliverySafeToRetry: true,
    }) as unknown as EmailService;
  const ok = driver(async () => ({ provider: 'RESEND', providerMessageId: 'msg_f1' }));
  const processorWith = (emailService: EmailService) => createEmailSendProcessor({ tenantContext, emailService, auditService });
  const asApp = (sql: string, params: unknown[]) => tenantContext.runInTenantContext(ctx, (m) => m.query(sql, params));
  const bodyOf = async (id: string) => {
    const r = await rowOf(id);
    return { html: r.renderedHtml ?? null, text: r.renderedText ?? null };
  };

  it('SENT password reset: delivered WITH the link, then the stored body is cleared; subject, provider metadata and audit kept', async () => {
    const row = await resetRow();
    const token = tokens[tokens.length - 1]!;
    expect((await bodyOf(row.id)).html).toContain(token); // PENDING: untouched
    sent.length = 0;
    await processorWith(ok)(fakeJob(row.id));
    expect(sent).toHaveLength(1);
    expect(`${sent[0]!.html}${sent[0]!.text}`).toContain(token); // the recipient got the working link
    const after = await rowOf(row.id);
    expect(after.status).toBe(EmailOutboxStatus.SENT);
    expect(after.renderedHtml ?? null).toBeNull();
    expect(after.renderedText ?? null).toBeNull();
    expect(after.renderedSubject).toBeTruthy();
    expect(after.provider).toBe('RESEND');
    expect(after.providerMessageId).toBe('msg_f1');
    expect(after.sentAt).toBeTruthy();
    const audit = await adminDataSource.query(`SELECT action FROM core.audit_log WHERE organisation_id = $1 AND metadata->>'emailOutboxId' = $2`, [org.id, row.id]);
    expect(audit.map((a: { action: string }) => a.action)).toContain('email.sent');
  });

  it('RETRY keeps the body (unsent mail is untouched) and the retry still delivers the link, then clears it', async () => {
    const row = await seed(
      EmailOutboxJobType.ACCOUNT_INVITATION,
      renderAccountActivationEmail({ recipientEmail: 'staff@example.test', activationUrl: `${ACCOUNTS}/activate-account?token=${newToken()}` }),
    );
    const token = tokens[tokens.length - 1]!;
    const transient = driver(async () => {
      throw Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
    });
    await expect(processorWith(transient)(fakeJob(row.id, 0))).rejects.toThrow();
    const retrying = await rowOf(row.id);
    expect(retrying.status).toBe(EmailOutboxStatus.RETRY);
    expect(retrying.renderedHtml).toContain(token);
    sent.length = 0;
    await processorWith(ok)(fakeJob(row.id, 1));
    expect(`${sent[0]!.html}${sent[0]!.text}`).toContain(token);
    const after = await rowOf(row.id);
    expect(after.status).toBe(EmailOutboxStatus.SENT);
    expect([after.renderedHtml ?? null, after.renderedText ?? null]).toEqual([null, null]);
  });

  it('terminal FAILED (non-retryable) clears the body and keeps the error metadata', async () => {
    const row = await resetRow();
    const permanent = driver(async () => {
      throw new Error('mailbox does not exist');
    });
    await expect(processorWith(permanent)(fakeJob(row.id))).rejects.toThrow(/permanently failed/);
    const after = await rowOf(row.id);
    expect(after.status).toBe(EmailOutboxStatus.FAILED);
    expect([after.renderedHtml ?? null, after.renderedText ?? null]).toEqual([null, null]);
    expect(after.lastErrorMessageSanitized).toBeTruthy();
    expect(after.failedAt).toBeTruthy();
  });

  it('email-change verification (a NOTIFICATION carrying a token) is cleared; an ordinary notification keeps its body', async () => {
    const verification = await seed(
      EmailOutboxJobType.NOTIFICATION,
      renderEmailChangeVerificationEmail({ confirmUrl: `${ACCOUNTS}/confirm-email-change?token=${newToken()}`, expiresInHours: 24 }),
    );
    const notice = await seed(EmailOutboxJobType.NOTIFICATION, { subject: 'Rota', html: '<p>Your rota changed.</p>', text: 'Your rota changed.' });
    await processorWith(ok)(fakeJob(verification.id));
    await processorWith(ok)(fakeJob(notice.id));
    expect(await bodyOf(verification.id)).toEqual({ html: null, text: null });
    expect(await bodyOf(notice.id)).toEqual({ html: '<p>Your rota changed.</p>', text: 'Your rota changed.' });
  });

  it('database backstop: any writer that makes a secret row terminal clears it (crewflow_app SQL), and a body cannot be put back', async () => {
    const row = await resetRow();
    const pending = await resetRow();
    await asApp(`UPDATE core.email_outbox SET status = 'CANCELLED', cancelled_at = now() WHERE id = $1`, [row.id]);
    expect(await bodyOf(row.id)).toEqual({ html: null, text: null });
    await asApp(`UPDATE core.email_outbox SET rendered_html = '<a href="x?token=abc">x</a>', rendered_text = 'again' WHERE id = $1`, [row.id]);
    expect(await bodyOf(row.id)).toEqual({ html: null, text: null });
    // A non-terminal update (claim to PROCESSING) leaves a pending row's body alone.
    expect((await bodyOf(pending.id)).html).toContain(tokens[tokens.length - 1]!);
    await asApp(`UPDATE core.email_outbox SET status = 'PROCESSING', processing_at = now() WHERE id = $1`, [pending.id]);
    expect((await bodyOf(pending.id)).html).toContain(tokens[tokens.length - 1]!);
    await asApp(`UPDATE core.email_outbox SET status = 'CANCELLED', cancelled_at = now() WHERE id = $1`, [pending.id]);
  });

  it('the dispatcher\'s stuck-lease recovery to FAILED (a different writer) also leaves no body', async () => {
    const row = await resetRow();
    await asApp(
      `UPDATE core.email_outbox SET status = 'PROCESSING', processing_at = now() - interval '60 minutes', infrastructure_attempt_count = max_infrastructure_attempts WHERE id = $1`,
      [row.id],
    );
    await runEmailDispatchCycle(adminDataSource, tenantContext, async () => undefined, async () => undefined, true);
    const after = await rowOf(row.id);
    expect(after.status).toBe(EmailOutboxStatus.FAILED);
    expect(after.lastErrorCode).toBe('STUCK_LEASE_ATTEMPTS_EXHAUSTED');
    expect([after.renderedHtml ?? null, after.renderedText ?? null]).toEqual([null, null]);
  });

  it('fail closed: a row with no body is never sent (FAILED, provider not called)', async () => {
    const row = await seed(EmailOutboxJobType.NOTIFICATION, { subject: 'empty' });
    sent.length = 0;
    await expect(processorWith(ok)(fakeJob(row.id))).rejects.toThrow(/permanently failed/);
    expect(sent).toHaveLength(0);
    expect((await rowOf(row.id)).status).toBe(EmailOutboxStatus.FAILED);
  });
});
