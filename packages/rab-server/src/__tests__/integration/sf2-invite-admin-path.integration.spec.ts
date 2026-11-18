import 'reflect-metadata';
import { ManagerType, PermissionFlag, PermissionFlagType, UserStatus } from '@rab/shared';
import { ForbiddenException, INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { ManagerService } from '../../modules/manager/services/manager.service';
import { OrganisationOnboardingService } from '../../modules/manager/services/organisation-onboarding.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';

/**
 * SF-2 follow-up (owner decision on PR #207, "audited path for platform-admin resend/revoke"):
 *
 *  - `ManagerService.resendInvite` / `cancelInvite` now re-check the caller's route flag in the service (layer 2):
 *    `manager.manage` + `user.reset_password` by default (the `/managers` routes).
 *  - The platform administrator's CEO-invite resend / revoke goes through a SEPARATE path,
 *    `resendInviteAsPlatformAdmin` / `cancelInviteAsPlatformAdmin`: active platform admin re-checked in the transaction,
 *    the target organisation's pending CEO invitation only, and its own `platform_admin.invite_resent` /
 *    `platform_admin.invite_cancelled` audit row naming the organisation and the invite.
 *
 * Every call goes to the SERVICE directly (no PermissionGuard in the path), as a job, CLI command or another service
 * would. A refused flag is revoked through a real per-user override, so only the new check can refuse. Each refusal must
 * leave the organisation exactly as it was: no email (outbox), no audit row, no invite change, no account change.
 * Real PostgreSQL with RLS on (crewflow_app), no mocks.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('SF-2 invite resend / cancel: route-flag re-check and the platform-admin path (integration)', () => {
  jest.setTimeout(300_000);

  let app: INestApplication;
  let admin: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let managers: ManagerService;
  let onboarding: OrganisationOnboardingService;

  // Organisation A: an ordinary organisation managed by its CEO.
  let orgA: string;
  let ceoA: TestIdentity; // CEO: manager.manage + user.reset_password
  let mgrA: TestIdentity; // Internal Manager, production permissions (no manager.manage)
  let pendingA: TestIdentity; // never-activated Internal Manager

  // Organisation B: another organisation (scope checks).
  let pendingB: TestIdentity;

  // Organisation T: the platform admin's target, with a pending CEO invitation.
  let orgT: string;
  let pendingCeoT: { profileId: string; userId: string };
  let pendingMgrT: TestIdentity; // a pending non-CEO Manager in T (outside the platform-admin reach)
  let mgrAllT: TestIdentity; // a Manager of T holding every flag, but not a platform admin

  let platformAdmin: TestIdentity; // platform admin of ANOTHER organisation (no role in A or T)

  const ctxOf = (identity: TestIdentity): AuthContext => ({ organisationId: identity.organisationId, workspaceId: identity.workspaceId, userId: identity.userId, role: 'manager' });
  /** The context the Admin Panel builds for a platform administrator acting on another organisation (no role there). */
  const adminCtxIn = (organisationId: string): AuthContext => ({ organisationId, workspaceId: null, userId: platformAdmin.userId, role: '' });

  const bumpSecurityVersion = (identity: TestIdentity) =>
    admin.query(`UPDATE core."user" SET security_version = security_version + 1 WHERE id = $1`, [identity.userId]);

  async function withRevoked<T>(identity: TestIdentity, flag: PermissionFlagType, fn: () => Promise<T>): Promise<T> {
    const inserted = (await admin.query(
      `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect)
       SELECT $1, id, $2, 'revoke' FROM core.permission WHERE key = $3 RETURNING user_id`,
      [identity.userId, identity.organisationId, flag],
    )) as unknown[];
    if (inserted.length !== 1) throw new Error(`test setup: permission ${flag} is not in the catalogue`);
    await bumpSecurityVersion(identity);
    try {
      return await fn();
    } finally {
      await admin.query(
        `DELETE FROM core.user_permission_override WHERE user_id = $1 AND permission_id = (SELECT id FROM core.permission WHERE key = $2)`,
        [identity.userId, flag],
      );
      await bumpSecurityVersion(identity);
    }
  }

  /** Everything a resend / cancel could write in an organisation, read as the fixture superuser (not narrowed by RLS). */
  async function snapshot(organisationId: string): Promise<Record<string, unknown>> {
    const [row] = (await admin.query(
      `SELECT
         (SELECT count(*) FROM core.audit_log WHERE organisation_id = $1)::int AS audit,
         (SELECT count(*) FROM core.email_outbox WHERE organisation_id = $1)::int AS outbox,
         (SELECT count(*) FROM core.email_outbox WHERE organisation_id = $1 AND status = 'CANCELLED')::int AS cancelled_outbox,
         (SELECT count(*) FROM core.account_invite WHERE organisation_id = $1)::int AS invites,
         (SELECT count(*) FROM core.account_invite WHERE organisation_id = $1 AND revoked_at IS NULL)::int AS live_invites,
         (SELECT json_agg(json_build_object('id', id, 'email', email, 'status', status, 'noPassword', password_hash IS NULL) ORDER BY id)
            FROM core."user" WHERE organisation_id = $1) AS users`,
      [organisationId],
    )) as Array<Record<string, unknown>>;
    return row!;
  }

  async function expectRejectedAndInert(organisationId: string, call: () => Promise<unknown>, error: new (...args: never[]) => Error): Promise<void> {
    const before = await snapshot(organisationId);
    await expect(call()).rejects.toBeInstanceOf(error);
    expect(await snapshot(organisationId)).toEqual(before);
  }
  const expectRefusedAndInert = (organisationId: string, call: () => Promise<unknown>) => expectRejectedAndInert(organisationId, call, ForbiddenException);
  const expectNotFoundAndInert = (organisationId: string, call: () => Promise<unknown>) => expectRejectedAndInert(organisationId, call, NotFoundException);

  /** Rows written in one transaction share created_at (now()), so they are returned in the order of `actions`, not by time. */
  async function auditRows(organisationId: string, userId: string, actions: string[]): Promise<Array<Record<string, unknown>>> {
    return (await admin.query(
      `SELECT action, actor_user_id, target_user_id, entity_type, entity_id, metadata FROM core.audit_log
        WHERE organisation_id = $1 AND target_user_id = $2 AND action = ANY($3) ORDER BY array_position($3, action), created_at, id`,
      [organisationId, userId, actions],
    )) as Array<Record<string, unknown>>;
  }

  /** The worker is not running against the test database: confirm the prior attempt's email as SENT, as the worker would. */
  const markOutboxSent = (userId: string) =>
    admin.query(`UPDATE core.email_outbox SET status = 'SENT', sent_at = now() WHERE target_user_id = $1 AND status IN ('PENDING', 'QUEUED', 'PROCESSING', 'RETRY')`, [userId]);

  async function setInvited(identity: TestIdentity): Promise<void> {
    await admin.query(`UPDATE core."user" SET status = $2 WHERE id = $1`, [identity.userId, UserStatus.INVITED]);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    admin = createAdminDataSource();
    await admin.initialize();
    tenantContext = moduleRef.get(TenantContextService);
    factory = new TestIdentityFactory({
      app, dataSource: moduleRef.get(DataSource), adminDataSource: admin, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService),
    });
    managers = moduleRef.get(ManagerService);
    onboarding = moduleRef.get(OrganisationOnboardingService);

    const seededA = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'sf2inv-a' });
    orgA = seededA.organisation.id;
    mgrA = seededA.managers[0]!;
    ceoA = await factory.createCeo(seededA.organisation);
    pendingA = await factory.createInternalManager(seededA.organisation, { label: 'sf2inv-a-pending' });
    await setInvited(pendingA);

    const orgB = await factory.createOrganisation('sf2inv-b');
    pendingB = await factory.createInternalManager(orgB, { label: 'sf2inv-b-pending' });
    await setInvited(pendingB);

    const padminOrg = await factory.createOrganisationWithManagers(1, { firstIsPlatformAdmin: true, label: 'sf2inv-padmin' });
    platformAdmin = padminOrg.managers[0]!;

    // Organisation T with a pending CEO, created the way the Admin Panel's legacy flow does (`createWithin`, behind its own
    // CEO platform-admin check): a CEO user in `invited`, invite #1 and its outbox row.
    const orgTRow = await factory.createOrganisation('sf2inv-t');
    orgT = orgTRow.id;
    const ceoEmail = `sf2inv-ceo-${randomUUID()}@example.test`;
    const created = await tenantContext.runInTenantContext(adminCtxIn(orgT), (m) =>
      managers.createWithin(m, adminCtxIn(orgT), { email: ceoEmail, firstName: 'Cara', lastName: 'Executive', type: ManagerType.CEO }),
    );
    const [ceoUser] = (await admin.query(`SELECT id FROM core."user" WHERE organisation_id = $1 AND email = $2`, [orgT, ceoEmail])) as Array<{ id: string }>;
    pendingCeoT = { profileId: created.id, userId: ceoUser!.id };
    // Both share T's canonical `manager` role, so both carry its (here: full) permission set; the pending one's flags never matter.
    mgrAllT = await factory.createInternalManager(orgTRow, { permissions: 'all', label: 'sf2inv-t-all' });
    pendingMgrT = await factory.createInternalManager(orgTRow, { permissions: 'all', label: 'sf2inv-t-pending', workspace: false });
    await setInvited(pendingMgrT);
  });

  afterAll(async () => {
    await app?.close();
    await admin?.destroy();
  });

  // ─────────────────────────────────────────────── the ordinary path: route flag re-checked in the service

  describe('ManagerService.resendInvite / cancelInvite (ordinary callers)', () => {
    it('without manager.manage → 403 for a real AND an unknown id: no email, no audit row, no invite or account change', async () => {
      const ctx = ctxOf(ceoA);
      await withRevoked(ceoA, PermissionFlag.MANAGER_MANAGE, async () => {
        for (const id of [pendingA.profileId!, randomUUID()]) {
          await expectRefusedAndInert(orgA, () => managers.resendInvite(ctx, id));
          await expectRefusedAndInert(orgA, () => managers.cancelInvite(ctx, id));
        }
      });
    });

    it('without the route\'s user.reset_password → 403, nothing changes (manager.manage alone is not enough)', async () => {
      const ctx = ctxOf(ceoA);
      await withRevoked(ceoA, PermissionFlag.USER_RESET_PASSWORD, async () => {
        await expectRefusedAndInert(orgA, () => managers.resendInvite(ctx, pendingA.profileId!));
        await expectRefusedAndInert(orgA, () => managers.cancelInvite(ctx, pendingA.profileId!));
      });
    });

    it('an Internal Manager with the production permission set (no manager.manage) is refused on the /managers default', async () => {
      await expectRefusedAndInert(orgA, () => managers.resendInvite(ctxOf(mgrA), pendingA.profileId!));
      await expectRefusedAndInert(orgA, () => managers.cancelInvite(ctxOf(mgrA), pendingA.profileId!));
    });

    it('fails closed on any flag other than the two route flags (e.g. through an `as never` cast)', async () => {
      await expectRefusedAndInert(orgA, () => managers.resendInvite(ctxOf(ceoA), pendingA.profileId!, PermissionFlag.STAFF_VIEW as never));
      await expectRefusedAndInert(orgA, () => managers.cancelInvite(ctxOf(ceoA), pendingA.profileId!, PermissionFlag.STAFF_VIEW as never));
    });

    it('a platform administrator cannot use the ordinary path on another organisation (it holds no role there) → 403, nothing changes', async () => {
      await expectRefusedAndInert(orgT, () => managers.resendInvite(adminCtxIn(orgT), pendingCeoT.profileId));
      await expectRefusedAndInert(orgT, () => managers.cancelInvite(adminCtxIn(orgT), pendingCeoT.profileId));
    });

    it('a record outside the caller\'s scope → 404 with the flags held: another organisation\'s pending Manager, or an unknown id', async () => {
      for (const id of [pendingB.profileId!, randomUUID()]) {
        await expectNotFoundAndInert(orgA, () => managers.resendInvite(ctxOf(ceoA), id));
        await expectNotFoundAndInert(orgA, () => managers.cancelInvite(ctxOf(ceoA), id));
      }
      expect(await snapshot(pendingB.organisationId)).toMatchObject({ invites: 0, outbox: 0 });
    });

    it('with both flags the CEO still resends and cancels (behaviour unchanged): tenant audit rows only, no platform_admin row', async () => {
      const resent = await managers.resendInvite(ctxOf(ceoA), pendingA.profileId!);
      expect(resent.sendNumber).toBe(1);
      await managers.cancelInvite(ctxOf(ceoA), pendingA.profileId!);
      const rows = await auditRows(orgA, pendingA.userId, ['user.invite_resent', 'user.invite_cancelled', 'platform_admin.invite_resent', 'platform_admin.invite_cancelled']);
      expect(rows.map((r) => r.action)).toEqual(['user.invite_resent', 'user.invite_cancelled']);
      expect(rows[0]!.actor_user_id).toBe(ceoA.userId);
      expect(rows[0]!.metadata).not.toHaveProperty('via');
    });
  });

  // ─────────────────────────────────────────────── the platform-admin path

  describe('ManagerService.resendInviteAsPlatformAdmin / cancelInviteAsPlatformAdmin', () => {
    it('a non-admin cannot reach the admin path: a Manager of the target organisation holding every flag → 403, nothing changes', async () => {
      const ctx = ctxOf(mgrAllT);
      await expectRefusedAndInert(orgT, () => managers.resendInviteAsPlatformAdmin(ctx, pendingCeoT.profileId, { reason: 'not an admin' }));
      await expectRefusedAndInert(orgT, () => managers.cancelInviteAsPlatformAdmin(ctx, pendingCeoT.profileId));
      // The same 403 for an unknown id: the platform-admin check comes before any row is read.
      await expectRefusedAndInert(orgT, () => managers.resendInviteAsPlatformAdmin(ctx, randomUUID(), { reason: 'not an admin' }));
    });

    it('a non-admin is refused through OrganisationOnboardingService too (resendCeoInvite / revokeCeoInvite)', async () => {
      await expectRefusedAndInert(orgT, () => onboarding.resendCeoInvite({ userId: mgrAllT.userId }, orgT, 'not an admin'));
      await expectRefusedAndInert(orgT, () => onboarding.revokeCeoInvite({ userId: mgrAllT.userId }, orgT));
    });

    it('a platform administrator inside an Admin Inspect session is refused on the admin path → 403', async () => {
      const inspecting: AuthContext = { ...adminCtxIn(orgT), userId: pendingCeoT.userId, inspectedBy: platformAdmin.userId };
      await expectRefusedAndInert(orgT, () => managers.resendInviteAsPlatformAdmin(inspecting, pendingCeoT.profileId, { reason: 'inspecting' }));
      await expectRefusedAndInert(orgT, () => managers.cancelInviteAsPlatformAdmin(inspecting, pendingCeoT.profileId));
    });

    it('a revoked platform administrator is refused → 403, nothing changes', async () => {
      const formerAdmin = (await factory.createOrganisationWithManagers(1, { firstIsPlatformAdmin: true, label: 'sf2inv-former' })).managers[0]!;
      await admin.query(`UPDATE core.platform_admin SET revoked_at = now() WHERE user_id = $1`, [formerAdmin.userId]);
      const ctx: AuthContext = { organisationId: orgT, workspaceId: null, userId: formerAdmin.userId, role: '' };
      await expectRefusedAndInert(orgT, () => managers.resendInviteAsPlatformAdmin(ctx, pendingCeoT.profileId, { reason: 'revoked admin' }));
      await expectRefusedAndInert(orgT, () => managers.cancelInviteAsPlatformAdmin(ctx, pendingCeoT.profileId));
    });

    it('the admin path reaches the pending CEO invitation only: a non-CEO pending Manager, another organisation\'s Manager, or an unknown id → 404', async () => {
      for (const id of [pendingMgrT.profileId!, pendingB.profileId!, randomUUID()]) {
        await expectNotFoundAndInert(orgT, () => managers.resendInviteAsPlatformAdmin(adminCtxIn(orgT), id, { reason: 'out of reach' }));
        await expectNotFoundAndInert(orgT, () => managers.cancelInviteAsPlatformAdmin(adminCtxIn(orgT), id));
      }
    });

    it('a direct caller without a valid reason → 400 on the admin resend, nothing changes', async () => {
      const before = await snapshot(orgT);
      await expect(managers.resendInviteAsPlatformAdmin(adminCtxIn(orgT), pendingCeoT.profileId, { reason: ' x ' })).rejects.toMatchObject({ status: 400 });
      expect(await snapshot(orgT)).toEqual(before);
    });

    it('a platform administrator resends through the admin path: a new attempt, the tenant row, and its own platform_admin.invite_resent row', async () => {
      await markOutboxSent(pendingCeoT.userId);
      const before = await snapshot(orgT);
      const resent = await onboarding.resendCeoInvite({ userId: platformAdmin.userId }, orgT, 'CEO asked for a new link');
      expect(resent.sendNumber).toBe(2);

      const after = await snapshot(orgT);
      expect(after.invites).toBe((before.invites as number) + 1);
      expect(after.outbox).toBe((before.outbox as number) + 1);
      const [latest] = (await admin.query(
        `SELECT id FROM core.account_invite WHERE user_id = $1 ORDER BY send_number DESC, created_at DESC LIMIT 1`,
        [pendingCeoT.userId],
      )) as Array<{ id: string }>;

      const rows = await auditRows(orgT, pendingCeoT.userId, ['user.invite_resent', 'platform_admin.invite_resent']);
      expect(rows.map((r) => r.action)).toEqual(['user.invite_resent', 'platform_admin.invite_resent']);
      expect(rows[0]).toMatchObject({ actor_user_id: platformAdmin.userId, metadata: { sendNumber: 2, via: 'platform_admin', reason: 'CEO asked for a new link' } });
      expect(rows[1]).toMatchObject({
        actor_user_id: platformAdmin.userId,
        target_user_id: pendingCeoT.userId,
        entity_type: 'account_invite',
        entity_id: latest!.id,
        metadata: { organisationId: orgT, managerProfileId: pendingCeoT.profileId, inviteId: latest!.id, sendNumber: 2, reason: 'CEO asked for a new link' },
      });
      expect(JSON.stringify(rows[1]!.metadata)).not.toMatch(/token/i);
    });

    it('a platform administrator revokes through the admin path: invite revoked, password cleared, and its own platform_admin.invite_cancelled row', async () => {
      const [latest] = (await admin.query(
        `SELECT id FROM core.account_invite WHERE user_id = $1 ORDER BY send_number DESC, created_at DESC LIMIT 1`,
        [pendingCeoT.userId],
      )) as Array<{ id: string }>;
      await onboarding.revokeCeoInvite({ userId: platformAdmin.userId }, orgT);

      const [invite] = (await admin.query(`SELECT revoked_at FROM core.account_invite WHERE id = $1`, [latest!.id])) as Array<{ revoked_at: Date | null }>;
      expect(invite!.revoked_at).not.toBeNull();
      const [user] = (await admin.query(`SELECT status, password_hash IS NULL AS no_password FROM core."user" WHERE id = $1`, [pendingCeoT.userId])) as Array<{ status: string; no_password: boolean }>;
      expect(user).toEqual({ status: UserStatus.INVITED, no_password: true });

      const rows = await auditRows(orgT, pendingCeoT.userId, ['user.invite_cancelled', 'platform_admin.invite_cancelled']);
      expect(rows.map((r) => r.action)).toEqual(['user.invite_cancelled', 'platform_admin.invite_cancelled']);
      expect(rows[1]).toMatchObject({
        actor_user_id: platformAdmin.userId,
        entity_type: 'account_invite',
        entity_id: latest!.id,
        metadata: { organisationId: orgT, managerProfileId: pendingCeoT.profileId, inviteId: latest!.id },
      });
    });
  });
});
