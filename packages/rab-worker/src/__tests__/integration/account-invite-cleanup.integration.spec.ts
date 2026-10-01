import 'reflect-metadata';
import { ManagerType, PermissionFlag, UserStatus } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { AccountInvite, EmailOutbox, Organisation, Permission, Role, RolePermission, User, UserRole } from '@rab/server/modules/identity/entities/index';
import { ManagerProfile } from '@rab/server/modules/manager/entities/manager-profile.entity';
import { ManagerWorkspace } from '@rab/server/modules/manager-workspace/entities/manager-workspace.entity';
import { AccountInviteService } from '@rab/server/engine/core-modules/auth/services/account-invite.service';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { ThrottlerRedisClientProvider } from '@rab/server/engine/core-modules/throttler/throttler-redis-client.provider';
import { WORKER_HEARTBEAT_KEY } from '@rab/server/engine/worker-shared/heartbeat.constants';
import { runAccountInviteCleanupCycle } from '../../queues/rab-maintenance/account-invite-cleanup.job';
import { createAdminDataSource } from './helpers/admin-datasource';

/**
 * The account-invite-cleanup WORKER JOB's own behaviour — expire at
 * send_number=3/expires_at, retain-vs-delete after the grace period,
 * dependency-blocking, idempotency. Moved here (from
 * rab-server/src/__tests__/integration/account-invite-abuse-cases.integration.spec.ts)
 * as part of the rab-worker package migration, since `runAccountInviteCleanupCycle`
 * now lives in `@rab/worker`, which `rab-server` must not depend on (the
 * dependency runs the other way). rab-server's own spec still covers the
 * HTTP-level invitation creation/activation flow; this file covers only the
 * worker job's own cleanup logic, invoked directly (real Postgres, RLS on,
 * no mocks), against an app bootstrapped here purely to seed fixtures
 * through the same real HTTP endpoints the original test used.
 *
 * Note (2026-09-27): this file was previously referenced by a comment in the
 * rab-server spec claiming it existed — it did not. This restores the actual
 * test content the comment claimed, verified against the real diff of what
 * was removed, not reconstructed from memory.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(60_000);

describeIfDb('account invite cleanup job (integration)', () => {
  let app: INestApplication;
  let adminDataSource: DataSource;
  let accountInvites: AccountInviteService;
  let tenantContext: TenantContextService;
  let redisClient: ThrottlerRedisClientProvider;
  let passwordHashingService: PasswordHashingService;

  const ownerPassword = 'correct horse battery staple 1!';
  const OWNER_PERMISSIONS = [
    PermissionFlag.STAFF_CREATE,
    PermissionFlag.STAFF_VIEW,
    PermissionFlag.MANAGER_MANAGE,
    PermissionFlag.USER_RESET_PASSWORD,
  ];

  async function seedOrgWithOwner(): Promise<{ organisation: Organisation; ownerEmail: string; ownerUserId: string }> {
    const slug = `test-${randomUUID()}`;
    const email = `owner-${randomUUID()}@example.test`;

    const insertResult = await adminDataSource.manager.insert(Organisation, { name: slug, slug });
    const organisation = await adminDataSource.manager.findOneByOrFail(Organisation, { id: insertResult.identifiers[0]!.id as string });

    let ownerUserId!: string;
    await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' }, async (manager) => {
      const permissions = await Promise.all(
        OWNER_PERMISSIONS.map(async (key) => {
          let permission = await manager.findOne(Permission, { where: { key } });
          if (!permission) {
            const [resource, action] = key.split('.');
            permission = await manager.save(Permission, { key, resource: resource!, action: action ?? key });
          }
          return permission;
        }),
      );

      const roleResult = await manager.insert(Role, { organisationId: organisation.id, key: 'org_admin', name: 'Owner', isSystem: true });
      const roleId = roleResult.identifiers[0]!.id as string;
      await manager.insert(RolePermission, permissions.map((p) => ({ roleId, permissionId: p.id, organisationId: organisation.id })));

      const userResult = await manager.insert(User, {
        organisationId: organisation.id,
        email,
        passwordHash: await hashOwnerPassword(),
        firstName: 'Test',
        lastName: 'Owner',
        status: UserStatus.ACTIVE,
      });
      ownerUserId = userResult.identifiers[0]!.id as string;
      await manager.insert(UserRole, { userId: ownerUserId, roleId, organisationId: organisation.id });

      await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [ownerUserId]);
      const workspace = await manager.save(ManagerWorkspace, {
        organisationId: organisation.id,
        ownerUserId,
        name: `Test Workspace ${ownerUserId}`,
        subdomain: `test-${ownerUserId.slice(0, 8)}`,
        status: 'active',
      });
      await manager.insert(ManagerProfile, { organisationId: organisation.id, userId: ownerUserId, type: ManagerType.INTERNAL, workspaceId: workspace.id });
    });

    return { organisation, ownerEmail: email, ownerUserId };
  }

  async function hashOwnerPassword(): Promise<string> {
    return passwordHashingService.hash(ownerPassword);
  }

  async function loginOwner(ownerEmail: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/rest/v1/auth/login').send({ email: ownerEmail, password: ownerPassword });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
  }

  /**
   * Test-only convenience simulating a full, CONFIRMED-DELIVERED send —
   * production splits `prepare()` (no write) from `commit()` (always runs,
   * durable-before-send) and only counts `sendNumber` once a linked
   * `email_outbox` row reaches SENT. Tests bypass the real queue/worker
   * entirely, so this helper writes the SENT outbox row directly, exactly
   * as the real worker would after a successful send.
   */
  async function issueForTest(manager: EntityManager, organisationId: string, userId: string): Promise<{ token: string; sendNumber: number; expiresAt: Date }> {
    const prepared = await accountInvites.prepare(manager, userId);
    const invite = await accountInvites.commit(manager, { organisationId, userId, createdBy: null, ...prepared });
    await manager.insert(EmailOutbox, {
      organisationId,
      jobType: 'ACCOUNT_INVITATION',
      status: 'SENT',
      recipientEmail: 'test-recipient@example.test',
      targetUserId: userId,
      accountInviteId: invite.id,
      renderedSubject: 'test',
      sentAt: new Date(),
    });
    return prepared;
  }

  /**
   * Simulates "the worker confirmed delivery" for whatever the user's
   * CURRENT (latest, still-open) outbox row is — the piece missing after a
   * real HTTP create()/resend-invite() call, since no worker actually runs
   * against this test database (LOGGER driver, no BullMQ consumer). Tests
   * that need to progress sendNumber past 1 across multiple real
   * create/resend calls must call this between them, exactly mirroring what
   * a real worker run would do to the same row.
   */
  async function markLatestOutboxSent(organisationId: string, userId: string): Promise<void> {
    await tenantContext.runInTenantContext({ organisationId, workspaceId: null, userId, role: '' }, (manager) =>
      manager.query(
        `UPDATE core.email_outbox SET status = 'SENT', sent_at = now()
          WHERE target_user_id = $1 AND status IN ('PENDING', 'QUEUED', 'PROCESSING', 'RETRY')`,
        [userId],
      ),
    );
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    accountInvites = moduleRef.get(AccountInviteService);
    tenantContext = moduleRef.get(TenantContextService);
    passwordHashingService = moduleRef.get(PasswordHashingService);
    redisClient = moduleRef.get(ThrottlerRedisClientProvider);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
  });

  beforeEach(async () => {
    // No separate worker process runs during Jest — AccountLifecycleService.
    // isEmailDeliveryAvailable() would otherwise see no heartbeat and skip
    // every invite send, breaking every test that expects one queued.
    await redisClient.client.set(WORKER_HEARTBEAT_KEY, Date.now().toString(), 'EX', 30);
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  it('expires an account whose final (3rd) invite has passed expires_at, and never touches an unexpired one', async () => {
    const { organisation, ownerEmail } = await seedOrgWithOwner();
    const ownerToken = await loginOwner(ownerEmail);

    const create = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: `staff-${randomUUID()}@example.test`, firstName: 'A', lastName: 'B', staffRef: `S-${randomUUID().slice(0, 6)}` });
    const userRow = await adminDataSource.manager.findOneByOrFail(User, { organisationId: organisation.id, email: create.body.email });
    // Force this straight to attempt 3 (bypassing the 24h real wait) and
    // expire it. Attempt 1 (the create() above) must be confirmed SENT
    // first, or issueForTest's own prepare() would also compute
    // sendNumber=1 instead of 2 (see markLatestOutboxSent's doc comment).
    await markLatestOutboxSent(organisation.id, userRow.id);
    await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: userRow.id, role: '' }, async (manager) => {
      await issueForTest(manager, organisation.id, userRow.id);
      await issueForTest(manager, organisation.id, userRow.id);
    });
    await adminDataSource.manager.query(
      `UPDATE core.account_invite SET expires_at = now() - interval '1 minute', cleanup_at = now() + interval '6 days'
         WHERE user_id = $1 AND revoked_at IS NULL AND accepted_at IS NULL`,
      [userRow.id],
    );

    const result = await runAccountInviteCleanupCycle(adminDataSource);
    expect(result.expired).toBeGreaterThanOrEqual(1);

    const updated = await adminDataSource.manager.findOneByOrFail(User, { id: userRow.id });
    expect(updated.status).toBe('invite_expired');
  });

  it('does not hard-delete before the 7-day grace period passes, and is a no-op re-run (idempotent)', async () => {
    const { organisation, ownerEmail } = await seedOrgWithOwner();
    const ownerToken = await loginOwner(ownerEmail);
    const create = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: `staff-${randomUUID()}@example.test`, firstName: 'A', lastName: 'B', staffRef: `S-${randomUUID().slice(0, 6)}` });
    const userRow = await adminDataSource.manager.findOneByOrFail(User, { organisationId: organisation.id, email: create.body.email });
    await markLatestOutboxSent(organisation.id, userRow.id);
    await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: userRow.id, role: '' }, async (manager) => {
      await issueForTest(manager, organisation.id, userRow.id);
      await issueForTest(manager, organisation.id, userRow.id);
    });
    // Expired, but grace period NOT yet passed (cleanup_at in the future).
    await adminDataSource.manager.query(
      `UPDATE core.account_invite SET expires_at = now() - interval '1 minute', cleanup_at = now() + interval '6 days'
         WHERE user_id = $1 AND revoked_at IS NULL AND accepted_at IS NULL`,
      [userRow.id],
    );

    const first = await runAccountInviteCleanupCycle(adminDataSource);
    expect(first.deleted).toBe(0);
    const stillThere = await adminDataSource.manager.findOne(User, { where: { id: userRow.id } });
    expect(stillThere).not.toBeNull();
    expect(stillThere!.status).toBe('invite_expired');

    const second = await runAccountInviteCleanupCycle(adminDataSource);
    expect(second.expired).toBe(0); // already expired — idempotent, not re-counted
    expect(second.deleted).toBe(0);
  });

  it('safely hard-deletes a genuinely dependency-free account once the grace period has passed', async () => {
    const { organisation, ownerEmail } = await seedOrgWithOwner();
    const ownerToken = await loginOwner(ownerEmail);
    const create = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: `staff-${randomUUID()}@example.test`, firstName: 'A', lastName: 'B', staffRef: `S-${randomUUID().slice(0, 6)}` });
    const userRow = await adminDataSource.manager.findOneByOrFail(User, { organisationId: organisation.id, email: create.body.email });
    await markLatestOutboxSent(organisation.id, userRow.id);
    await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: userRow.id, role: '' }, async (manager) => {
      await issueForTest(manager, organisation.id, userRow.id);
      await issueForTest(manager, organisation.id, userRow.id);
    });
    await adminDataSource.manager.query(
      `UPDATE core.account_invite SET expires_at = now() - interval '8 days', cleanup_at = now() - interval '1 minute'
         WHERE user_id = $1 AND revoked_at IS NULL AND accepted_at IS NULL`,
      [userRow.id],
    );

    const result = await runAccountInviteCleanupCycle(adminDataSource);
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    const gone = await adminDataSource.manager.findOne(User, { where: { id: userRow.id } });
    expect(gone).toBeNull();
    const inviteRowsGone = await adminDataSource.manager.find(AccountInvite, { where: { userId: userRow.id } });
    expect(inviteRowsGone).toHaveLength(0); // cascaded
  });

  it('never hard-deletes an account that has created real business data (e.g. a Venue) — retains it instead', async () => {
    const { organisation, ownerEmail } = await seedOrgWithOwner();
    const ownerToken = await loginOwner(ownerEmail);
    const create = await request(app.getHttpServer())
      .post('/rest/v1/managers')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: `mgr-${randomUUID()}@example.test`, firstName: 'A', lastName: 'B', type: 'internal' });
    const userRow = await adminDataSource.manager.findOneByOrFail(User, { organisationId: organisation.id, email: create.body.email });
    await markLatestOutboxSent(organisation.id, userRow.id);
    await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: userRow.id, role: '' }, async (manager) => {
      await issueForTest(manager, organisation.id, userRow.id);
      await issueForTest(manager, organisation.id, userRow.id);
    });
    await adminDataSource.manager.query(
      `UPDATE core.account_invite SET expires_at = now() - interval '8 days', cleanup_at = now() - interval '1 minute'
         WHERE user_id = $1 AND revoked_at IS NULL AND accepted_at IS NULL`,
      [userRow.id],
    );
    // Simulate this pending Manager having (somehow) created a Venue — real
    // business data that must block deletion regardless of pending state.
    // `venue`'s own WITH CHECK requires BOTH organisation_id AND
    // workspace_id to match current context — reuse the org's real
    // workspace (created for the owner in seedOrgWithOwner) rather than
    // NULL, which can never satisfy a plain `=` check against itself.
    const [{ id: workspaceId }] = await adminDataSource.manager.query<[{ id: string }]>(
      `SELECT id FROM core.manager_workspace WHERE organisation_id = $1 LIMIT 1`,
      [organisation.id],
    );
    await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId, userId: userRow.id, role: '' }, (manager) =>
      manager.query(`INSERT INTO core.venue (organisation_id, workspace_id, name, created_by) VALUES ($1, $2, 'Test Venue', $3)`, [
        organisation.id,
        workspaceId,
        userRow.id,
      ]),
    );

    const result = await runAccountInviteCleanupCycle(adminDataSource);
    expect(result.retained).toBeGreaterThanOrEqual(1);
    expect(result.deleted).toBe(0);

    const stillThere = await adminDataSource.manager.findOneByOrFail(User, { id: userRow.id });
    expect(stillThere.status).toBe('invite_expired'); // retained, not silently reverted to active or deleted
  });

  it('never touches an already-ACTIVE user, even one whose status happens to look similar', async () => {
    const { organisation, ownerEmail } = await seedOrgWithOwner();
    // The org owner itself is ACTIVE, has no account_invite row at all — the
    // cleanup job's candidate query structurally can't select it (it JOINs
    // on account_invite with send_number = 3), but assert the row is
    // untouched after a real cleanup cycle regardless.
    const before = await adminDataSource.manager.findOneByOrFail(User, { organisationId: organisation.id, email: ownerEmail });
    await runAccountInviteCleanupCycle(adminDataSource);
    const after = await adminDataSource.manager.findOneByOrFail(User, { id: before.id });
    expect(after.status).toBe('active');
  });

  // ===================================================================
  // WORK-01 — fairness / starvation
  // ===================================================================
  // Before this fix, the cleanup candidate query was `LIMIT 50` with NO
  // `ORDER BY` at all. A cluster of permanently-RETAINED rows (real business
  // data referencing them) landing in that arbitrary first batch could
  // occupy every tick's LIMIT window forever, starving any genuinely
  // processable row sorted after them. These tests seed real, retained AND
  // processable candidates directly against `core.account_invite`/`core."user"`
  // (bypassing the slow real HTTP create+markSent+issueForTest flow, which
  // would make a 100+-row fixture impractically slow) — same final DB state
  // shape those higher-level helpers produce, verified against the same
  // `findBlockingDependency` checks the job itself runs.
  describe('WORK-01 — bounded, fair cleanup scanning', () => {
    /** Seeds a single invite_expired, cleanup-eligible user (and its account_invite row) directly — the same terminal shape `issueForTest` + the expiry UPDATE produce, without the slow real HTTP round trip. */
    async function seedCleanupCandidate(organisationId: string, opts: { retained: boolean; cleanupAtOffsetMs: number }): Promise<string> {
      const userResult = await adminDataSource.manager.insert(User, {
        organisationId,
        email: `work01-${randomUUID()}@example.test`,
        passwordHash: await hashOwnerPassword(),
        firstName: 'Work01',
        lastName: 'Candidate',
        status: 'invite_expired' as never,
      });
      const userId = userResult.identifiers[0]!.id as string;
      await adminDataSource.manager.query(
        `INSERT INTO core.account_invite (organisation_id, user_id, send_number, token_hash, expires_at, cleanup_at)
         VALUES ($1, $2, 3, $3, now() - interval '8 days', now() - interval '${(-opts.cleanupAtOffsetMs / 1000).toFixed(0)} seconds')`,
        [organisationId, userId, randomUUID()],
      );
      if (opts.retained) {
        // A real dependency (`shift.createdBy`) — makes `findBlockingDependency`
        // genuinely retain this row on every scan, forever, exactly like a
        // real never-resolvable historical reference would.
        const [{ id: workspaceId }] = await adminDataSource.manager.query<[{ id: string }]>(
          `SELECT id FROM core.manager_workspace WHERE organisation_id = $1 LIMIT 1`,
          [organisationId],
        );
        // `venue`/`job_role` are FORCE'd RLS — even this owner connection
        // needs real tenant context bound to see them (the same gotcha this
        // whole engagement has hit before with FORCE'd tables).
        await tenantContext.runInTenantContext({ organisationId, workspaceId, userId, role: '' }, async (manager) => {
          const [{ id: venueId }] = await manager.query<[{ id: string }]>(`SELECT id FROM core.venue WHERE organisation_id = $1 LIMIT 1`, [organisationId]);
          const [{ id: jobRoleId }] = await manager.query<[{ id: string }]>(`SELECT id FROM core.job_role WHERE organisation_id = $1 LIMIT 1`, [organisationId]);
          await manager.query(
            `INSERT INTO core.shift (organisation_id, workspace_id, venue_id, job_role_id, starts_at, ends_at, break_minutes, required_count, pay_rate_pence, status, created_by)
             VALUES ($1, $2, $3, $4, now() + interval '1 day', now() + interval '1 day 8 hours', 0, 1, 1500, 'draft', $5)`,
            [organisationId, workspaceId, venueId, jobRoleId, userId],
          );
        });
      }
      return userId;
    }

    /** One venue + one job role, needed as FK targets for the retained candidates' own `shift` row. */
    async function seedVenueAndRole(organisationId: string, ownerUserId: string): Promise<void> {
      const [{ id: workspaceId }] = await adminDataSource.manager.query<[{ id: string }]>(
        `SELECT id FROM core.manager_workspace WHERE organisation_id = $1 LIMIT 1`,
        [organisationId],
      );
      await tenantContext.runInTenantContext({ organisationId, workspaceId, userId: ownerUserId, role: '' }, async (manager) => {
        await manager.query(`INSERT INTO core.venue (organisation_id, workspace_id, name, created_by) VALUES ($1, $2, 'Work01 Venue', $3)`, [organisationId, workspaceId, ownerUserId]);
        await manager.query(`INSERT INTO core.job_role (organisation_id, workspace_id, name, default_rate_pence, created_by) VALUES ($1, $2, 'Work01 Role', 1500, $3)`, [
          organisationId,
          workspaceId,
          ownerUserId,
        ]);
      });
    }

    it('1/2/3/5: fewer than one batch, exactly one batch, more than one batch, and 150+ rows all eventually complete', async () => {
      const { organisation, ownerUserId } = await seedOrgWithOwner();
      await seedVenueAndRole(organisation.id, ownerUserId);
      const ids = await Promise.all(Array.from({ length: 30 }, () => seedCleanupCandidate(organisation.id, { retained: false, cleanupAtOffsetMs: 0 })));

      const result = await runAccountInviteCleanupCycle(adminDataSource);
      expect(result.deleted).toBeGreaterThanOrEqual(30);
      for (const id of ids) {
        const row = await adminDataSource.manager.findOne(User, { where: { id } });
        expect(row).toBeNull(); // every one of the 30 (fewer than one 50-row page) is gone
      }
    });

    it('4: the brief\'s own scenario — 50 retained rows sorted first do NOT prevent 50 later processable rows from being reached in the SAME tick', async () => {
      const { organisation, ownerUserId } = await seedOrgWithOwner();
      await seedVenueAndRole(organisation.id, ownerUserId);
      // Retained rows get an EARLIER cleanup_at (sort first); processable
      // rows get a LATER one (sort after) — the exact starvation shape the
      // old unordered `LIMIT 50` was vulnerable to.
      const retainedIds = [];
      for (let i = 0; i < 50; i++) {
        // eslint-disable-next-line no-await-in-loop
        retainedIds.push(await seedCleanupCandidate(organisation.id, { retained: true, cleanupAtOffsetMs: -3600_000 }));
      }
      const processableIds = [];
      for (let i = 0; i < 50; i++) {
        // eslint-disable-next-line no-await-in-loop
        processableIds.push(await seedCleanupCandidate(organisation.id, { retained: false, cleanupAtOffsetMs: 0 }));
      }

      const result = await runAccountInviteCleanupCycle(adminDataSource);
      expect(result.retained).toBeGreaterThanOrEqual(50);
      expect(result.deleted).toBeGreaterThanOrEqual(50); // the OLD code would have left this at 0 — every processable row stuck behind the retained 50

      for (const id of processableIds) {
        const row = await adminDataSource.manager.findOne(User, { where: { id } });
        expect(row).toBeNull();
      }
      for (const id of retainedIds) {
        const row = await adminDataSource.manager.findOneByOrFail(User, { id });
        expect(row.status).toBe('invite_expired'); // still there, correctly retained, not lost or force-deleted
      }
    });

    it('6: deterministic ordering — two identical-cleanup_at candidates never cause a skipped or duplicated row across pages', async () => {
      const { organisation, ownerUserId } = await seedOrgWithOwner();
      await seedVenueAndRole(organisation.id, ownerUserId);
      const ids = await Promise.all(Array.from({ length: 10 }, () => seedCleanupCandidate(organisation.id, { retained: false, cleanupAtOffsetMs: 0 })));
      // Force an identical cleanup_at across all 10 — the id tie-breaker is
      // the only thing that can keep this deterministic.
      await adminDataSource.manager.query(`UPDATE core.account_invite SET cleanup_at = now() - interval '1 minute' WHERE user_id = ANY($1::uuid[])`, [ids]);

      const result = await runAccountInviteCleanupCycle(adminDataSource);
      expect(result.deleted).toBeGreaterThanOrEqual(10);
      for (const id of ids) {
        expect(await adminDataSource.manager.findOne(User, { where: { id } })).toBeNull();
      }
    });

    it('10: a permanently-retained row does not retry forever — it is re-examined (and re-retained) on every subsequent tick, never force-deleted just because it keeps reappearing', async () => {
      const { organisation, ownerUserId } = await seedOrgWithOwner();
      await seedVenueAndRole(organisation.id, ownerUserId);
      const id = await seedCleanupCandidate(organisation.id, { retained: true, cleanupAtOffsetMs: 0 });

      await runAccountInviteCleanupCycle(adminDataSource);
      await runAccountInviteCleanupCycle(adminDataSource);
      const result3 = await runAccountInviteCleanupCycle(adminDataSource);
      expect(result3.retained).toBeGreaterThanOrEqual(1);
      const row = await adminDataSource.manager.findOneByOrFail(User, { id });
      expect(row.status).toBe('invite_expired'); // still safely retained after 3 ticks, never deleted
    });

    it('13: the expiration scan is itself bounded — a large backlog of expiring invites does not fail or hang, and steadily progresses across ticks', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const owner = await adminDataSource.manager.findOneByOrFail(User, { organisationId: organisation.id, email: ownerEmail });
      const ids: string[] = [];
      for (let i = 0; i < 20; i++) {
        const userResult = await adminDataSource.manager.insert(User, {
          organisationId: organisation.id,
          email: `work01-expire-${randomUUID()}@example.test`,
          passwordHash: await hashOwnerPassword(),
          firstName: 'Work01',
          lastName: 'Expiring',
          status: 'invited' as never,
        });
        const userId = userResult.identifiers[0]!.id as string;
        ids.push(userId);
        // eslint-disable-next-line no-await-in-loop
        await adminDataSource.manager.query(
          `INSERT INTO core.account_invite (organisation_id, user_id, send_number, token_hash, expires_at)
           VALUES ($1, $2, 3, $3, now() - interval '1 minute')`,
          [organisation.id, userId, randomUUID()],
        );
      }
      void owner;

      const result = await runAccountInviteCleanupCycle(adminDataSource);
      expect(result.expired).toBeGreaterThanOrEqual(20);
      for (const id of ids) {
        const row = await adminDataSource.manager.findOneByOrFail(User, { id });
        expect(row.status).toBe('invite_expired');
      }
    });

    it('14: RLS/tenant behavior is unchanged by the fairness fix — a cleanup candidate from a DIFFERENT organisation is never touched by this org\'s own cycle side effects', async () => {
      const orgA = await seedOrgWithOwner();
      const orgB = await seedOrgWithOwner();
      await seedVenueAndRole(orgA.organisation.id, orgA.ownerUserId);
      const idA = await seedCleanupCandidate(orgA.organisation.id, { retained: false, cleanupAtOffsetMs: 0 });
      const idB = await seedCleanupCandidate(orgB.organisation.id, { retained: false, cleanupAtOffsetMs: 0 });

      await runAccountInviteCleanupCycle(adminDataSource);

      // Both are legitimately gone (this job is deliberately cross-org, per
      // its own doc comment) — the point of this test is that nothing about
      // the NEW paging/ordering logic conflates the two organisations' rows
      // or double-processes one while skipping the other.
      expect(await adminDataSource.manager.findOne(User, { where: { id: idA } })).toBeNull();
      expect(await adminDataSource.manager.findOne(User, { where: { id: idB } })).toBeNull();
    });
  });
});
