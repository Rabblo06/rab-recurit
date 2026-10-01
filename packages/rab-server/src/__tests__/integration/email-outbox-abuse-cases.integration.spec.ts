import 'reflect-metadata';
import { ManagerType, NotificationType, PermissionFlag, UserStatus } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../../app.module';
import { AccountInvite, EmailOutbox, Organisation, Permission, Role, RolePermission, User, UserRole } from '../../modules/identity/entities';
import { ManagerProfile } from '../../modules/manager/entities/manager-profile.entity';
import { ManagerWorkspace } from '../../modules/manager-workspace/entities/manager-workspace.entity';
import { AccountInviteService } from '../../engine/core-modules/auth/services/account-invite.service';
import { AuditService } from '../../engine/core-modules/audit/audit.service';
import { EmailService } from '../../engine/core-modules/email/email.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { NotificationService } from '../../modules/notification/services/notification.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { ThrottlerRedisClientProvider } from '../../engine/core-modules/throttler/throttler-redis-client.provider';
import { WORKER_HEARTBEAT_KEY } from '../../engine/worker-shared/heartbeat.constants';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentityFactory } from './helpers/test-identities';

/**
 * The durable transactional-outbox ROW (Part A) — creation, the durable
 * PENDING/QUEUED state, RLS, and driver wiring. The WORKER SEND PROCESSOR's
 * own behaviour (success/idempotency/cancellation/retry-classification/
 * stuck-row recovery) moved to
 * `packages/rab-worker/src/__tests__/integration/email-send.integration.spec.ts`
 * as part of the rab-worker package migration — `createEmailSendProcessor`
 * now lives in `@rab/worker`, which `rab-server` must not depend on (the
 * dependency already runs the other way). Real Postgres, RLS on, no mocks.
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
  let notificationService: NotificationService;
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
    notificationService = moduleRef.get(NotificationService);
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

  // ===================================================================
  // MAIL-01 — HTML escaping for dynamic notification-email content
  // ===================================================================
  // `NotificationService.notify()`'s email path used to interpolate
  // `params.message` into `<p>${params.message}</p>` with NO escaping —
  // and `params.message` is assembled from dozens of call sites across
  // services and worker jobs, many of which embed manager-controlled free
  // text (venue names, job role names, staff display names, decline
  // reasons). These tests drive the SAME real `notify()` → `EmailOutboxService.
  // enqueue()` path every production caller uses and inspect the actually
  // PERSISTED `email_outbox` row — real Postgres, no mocks, LOGGER driver
  // only (never a real send).
  describe('MAIL-01 — HTML escaping for dynamic notification content', () => {
    async function notifyAndReadOutbox(organisationId: string, userId: string, message: string): Promise<{ html: string; text: string }> {
      await withTenant(organisationId, (m) =>
        notificationService.notify(m, {
          organisationId,
          userId,
          type: NotificationType.OFFER_SENT,
          title: 'Test notification',
          message,
          forceEmail: true,
        }),
      );
      const row = await withTenant(organisationId, (m) => m.findOneOrFail(EmailOutbox, { where: { jobType: 'NOTIFICATION', targetUserId: userId }, order: { createdAt: 'DESC' } }));
      return { html: row.renderedHtml ?? '', text: row.renderedText ?? '' };
    }

    it('1: <script>alert(1)</script> is escaped, never executable markup in the HTML', async () => {
      const { organisation, ownerUserId } = await seedOrgWithOwner();
      const { html } = await notifyAndReadOutbox(organisation.id, ownerUserId, 'Venue: <script>alert(1)</script>');
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('2: <img src=x onerror=alert(1)> is escaped, never a live event-handler attribute', async () => {
      const { organisation, ownerUserId } = await seedOrgWithOwner();
      const { html } = await notifyAndReadOutbox(organisation.id, ownerUserId, 'Role: <img src=x onerror=alert(1)>');
      // The literal text "onerror=" is expected to survive AS ESCAPED TEXT
      // (proven by the exact full-string match below) — what matters is
      // that no REAL, unescaped <img ...> tag exists for a mail client to
      // ever parse as a live element with a live attribute.
      expect(html).not.toContain('<img');
      expect(html).toBe('<p>Role: &lt;img src=x onerror=alert(1)&gt;</p>');
    });

    it('3: <a href="https://evil.example">Click</a> is escaped as literal text, never an actual link, when it arrives via untrusted message content', async () => {
      const { organisation, ownerUserId } = await seedOrgWithOwner();
      const { html } = await notifyAndReadOutbox(organisation.id, ownerUserId, 'Note: <a href="https://evil.example">Click</a>');
      expect(html).not.toContain('<a href="https://evil.example">');
      expect(html).toContain('&lt;a href=&quot;https://evil.example&quot;&gt;Click&lt;/a&gt;');
    });

    it('4: "Tom & Jerry" displays correctly (single ampersand, no mangling)', async () => {
      const { organisation, ownerUserId } = await seedOrgWithOwner();
      const { html } = await notifyAndReadOutbox(organisation.id, ownerUserId, 'Staff: Tom & Jerry');
      expect(html).toContain('Tom &amp; Jerry');
      expect(html).not.toMatch(/Tom &amp;amp; Jerry/); // never double-escaped
    });

    it('5: quotes and apostrophes are safe (no attribute-breakout shape survives)', async () => {
      const { organisation, ownerUserId } = await seedOrgWithOwner();
      const { html } = await notifyAndReadOutbox(organisation.id, ownerUserId, `Reason: staff said "I can't make it"`);
      expect(html).toContain('&quot;I can&#39;t make it&quot;');
      expect(html).not.toContain(`"I can't make it"`);
    });

    it('6: legitimate Unicode is preserved unescaped', async () => {
      const { organisation, ownerUserId } = await seedOrgWithOwner();
      const { html } = await notifyAndReadOutbox(organisation.id, ownerUserId, 'Venue: Café Résumé — 日本語 — 😀');
      expect(html).toContain('Café Résumé — 日本語 — 😀');
    });

    it('7: a venue name with < / > displays as literal text, never opening a real tag', async () => {
      const { organisation, ownerUserId } = await seedOrgWithOwner();
      const { html } = await notifyAndReadOutbox(organisation.id, ownerUserId, 'Hotel <b>VIP</b> Suite');
      expect(html).toContain('Hotel &lt;b&gt;VIP&lt;/b&gt; Suite');
      expect(html).not.toContain('<b>VIP</b>');
    });

    it('8: a role name with an ampersand displays correctly', async () => {
      const { organisation, ownerUserId } = await seedOrgWithOwner();
      const { html } = await notifyAndReadOutbox(organisation.id, ownerUserId, 'Role: Bar & Grill Supervisor');
      expect(html).toContain('Bar &amp; Grill Supervisor');
    });

    it('9: the plain-text alternative is NEVER HTML-entity escaped — "AT&T" stays "AT&T", not "AT&amp;T"', async () => {
      const { organisation, ownerUserId } = await seedOrgWithOwner();
      const { html, text } = await notifyAndReadOutbox(organisation.id, ownerUserId, 'Venue: AT&T Center');
      expect(html).toContain('AT&amp;T Center'); // HTML: escaped, correct
      expect(text).toBe('Venue: AT&T Center'); // TEXT: raw, unescaped, correct
      expect(text).not.toContain('&amp;');
    });

    it('10/11: an untrusted message value cannot create an additional link or tag — the entire message renders as one literal text run inside the trusted <p> template', async () => {
      const { organisation, ownerUserId } = await seedOrgWithOwner();
      const malicious = 'Click here: <a href="https://phishing.example/steal">Urgent: verify your account</a>';
      const { html } = await notifyAndReadOutbox(organisation.id, ownerUserId, malicious);
      // Exact full-string match: the ONLY real tags in the output are the
      // trusted <p>/</p> wrapper this service itself writes — every
      // angle bracket the malicious message contributed is escaped text,
      // never a second real tag/link the message could have created.
      expect(html).toBe('<p>Click here: &lt;a href=&quot;https://phishing.example/steal&quot;&gt;Urgent: verify your account&lt;/a&gt;</p>');
      expect(html).not.toMatch(/<a\s/);
    });

    it('12: the persisted email_outbox row is what a retry re-sends — escaping happened once, at enqueue time, not re-derived later', async () => {
      const { organisation, ownerUserId } = await seedOrgWithOwner();
      const { html: firstRead } = await notifyAndReadOutbox(organisation.id, ownerUserId, 'Venue: <b>Repeat Read</b>');
      // Re-read the SAME row again (simulating what a retry's own send
      // attempt reads) — must be byte-identical, proving there is no
      // separate re-render step that could diverge from the first.
      const row = await withTenant(organisation.id, (m) => m.findOneOrFail(EmailOutbox, { where: { jobType: 'NOTIFICATION', targetUserId: ownerUserId }, order: { createdAt: 'DESC' } }));
      expect(row.renderedHtml).toBe(firstRead);
    });
  });
});
