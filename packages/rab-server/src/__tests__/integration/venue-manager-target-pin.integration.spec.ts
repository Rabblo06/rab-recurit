import 'reflect-metadata';
import { PermissionFlag, PermissionFlagType, UserStatus } from '@rab/shared';
import { INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { AuditAction } from '../../engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { ManagerService } from '../../modules/manager/services/manager.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';

/**
 * SF-2 review L-1 follow-up: `ManagerService.update`, `setActive` and `resetPassword` called with the Venue Manager route's
 * flag (`venue_manager.create`) pin the target, in the action's own transaction, to a `type: venue` profile of the caller's
 * own workspace. Anything else is 404 and nothing changes.
 *
 * The caller is a CEO that CAN see the Internal Manager target under RLS and holds `venue_manager.create` through a real
 * per-user grant override (plus `user.reset_password`), with a workspace: without the pin every refused call below would
 * succeed. Every call goes to the SERVICE directly (no PermissionGuard, no VenueManagerService gate), as a job, CLI
 * command or another service would. Step-up-gated methods use a real signed-in session, so only the pin can refuse.
 * Real PostgreSQL with RLS on (crewflow_app), no mocks.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('Venue Manager route flag pins the target: update / setActive / resetPassword (integration)', () => {
  jest.setTimeout(300_000);

  let app: INestApplication;
  let admin: DataSource;
  let factory: TestIdentityFactory;
  let managers: ManagerService;

  let orgA: string;
  let ceoA: TestIdentity; // CEO with a workspace; venue_manager.create granted per test
  let mgrA: TestIdentity; // Internal Manager with its own workspace (owner of otherVmA)
  let internalA: TestIdentity; // ACTIVE Internal Manager: the target the Venue Manager flag must never reach
  let ownVmA: TestIdentity; // ACTIVE Venue Manager in ceoA's own workspace (positive control)
  let otherVmA: TestIdentity; // ACTIVE Venue Manager in mgrA's workspace (another workspace)

  const ctxOf = (identity: TestIdentity): AuthContext => ({ organisationId: identity.organisationId, workspaceId: identity.workspaceId, userId: identity.userId, role: 'manager' });

  const bumpSecurityVersion = (identity: TestIdentity) =>
    admin.query(`UPDATE core."user" SET security_version = security_version + 1 WHERE id = $1`, [identity.userId]);

  /** Runs `fn` while `flag` is GRANTED to `identity` by a per-user override (removed afterwards, whatever happens). */
  async function withGranted<T>(identity: TestIdentity, flag: PermissionFlagType, fn: () => Promise<T>): Promise<T> {
    const inserted = (await admin.query(
      `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect)
       SELECT $1, id, $2, 'grant' FROM core.permission WHERE key = $3 RETURNING user_id`,
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

  /** Everything update / setActive / resetPassword could write in the organisation, read as the fixture superuser (not narrowed by RLS). */
  async function snapshot(): Promise<Record<string, unknown>> {
    const [row] = (await admin.query(
      `SELECT
         (SELECT count(*) FROM core.audit_log WHERE organisation_id = $1)::int AS audit,
         (SELECT count(*) FROM core.email_outbox WHERE organisation_id = $1)::int AS outbox,
         (SELECT count(*) FROM core.password_reset_token WHERE organisation_id = $1)::int AS reset_tokens,
         (SELECT count(*) FROM core.refresh_token WHERE organisation_id = $1 AND revoked_at IS NOT NULL)::int AS revoked_refresh_tokens,
         (SELECT json_agg(json_build_object('id', id, 'first', first_name, 'last', last_name, 'phone', phone, 'status', status,
                                            'mustReset', must_reset_password, 'securityVersion', security_version) ORDER BY id)
            FROM core."user" WHERE organisation_id = $1) AS users,
         (SELECT json_agg(json_build_object('id', id, 'jobTitle', job_title, 'archived', archived_at) ORDER BY id)
            FROM core.manager_profile WHERE organisation_id = $1) AS profiles`,
      [orgA],
    )) as Array<Record<string, unknown>>;
    return row!;
  }

  async function expectNotFoundAndInert(call: () => Promise<unknown>): Promise<void> {
    const before = await snapshot();
    await expect(call()).rejects.toBeInstanceOf(NotFoundException);
    expect(await snapshot()).toEqual(before);
  }

  async function auditActions(targetUserId: string, actions: string[]): Promise<string[]> {
    const rows = (await admin.query(
      `SELECT action FROM core.audit_log WHERE organisation_id = $1 AND target_user_id = $2 AND actor_user_id = $3 AND action = ANY($4) ORDER BY created_at, id`,
      [orgA, targetUserId, ceoA.userId, actions],
    )) as Array<{ action: string }>;
    return rows.map((r) => r.action);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    admin = createAdminDataSource();
    await admin.initialize();
    factory = new TestIdentityFactory({
      app, dataSource: moduleRef.get(DataSource), adminDataSource: admin, tenantContext: moduleRef.get(TenantContextService), passwordHashing: moduleRef.get(PasswordHashingService),
    });
    managers = moduleRef.get(ManagerService);

    const seeded = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'vmpin-a' });
    orgA = seeded.organisation.id;
    mgrA = seeded.managers[0]!;
    ceoA = await factory.createCeo(seeded.organisation);
    internalA = await factory.createInternalManager(seeded.organisation, { label: 'vmpin-a-internal' });
    ownVmA = await factory.createVenueManager(seeded.organisation, { owner: ceoA, label: 'vmpin-a-own-vm' });
    otherVmA = await factory.createVenueManager(seeded.organisation, { owner: mgrA, label: 'vmpin-a-other-vm' });
  });

  afterAll(async () => {
    await app?.close();
    await admin?.destroy();
  });

  it('precondition: the caller CAN see the Internal Manager under RLS (the /managers route reads it), so only the pin can refuse below', async () => {
    expect(ceoA.workspaceId).toBeTruthy();
    expect((await managers.get(ctxOf(ceoA), internalA.profileId!)).id).toBe(internalA.profileId);
  });

  it('update with venue_manager.create on an Internal Manager → 404, nothing changes', async () => {
    await withGranted(ceoA, PermissionFlag.VENUE_MANAGER_CREATE, async () => {
      await expectNotFoundAndInert(() =>
        managers.update(ctxOf(ceoA), internalA.profileId!, { firstName: 'Pinned', jobTitle: 'Not a Venue Manager' } as never, PermissionFlag.VENUE_MANAGER_CREATE),
      );
    });
  });

  it('setActive with venue_manager.create on an Internal Manager → 404 (suspend and reactivate), nothing changes', async () => {
    await withGranted(ceoA, PermissionFlag.VENUE_MANAGER_CREATE, async () => {
      const signedIn = await factory.signedInContext(ceoA);
      await expectNotFoundAndInert(() => managers.setActive(signedIn, internalA.profileId!, false, PermissionFlag.VENUE_MANAGER_CREATE));
      await expectNotFoundAndInert(() => managers.setActive(signedIn, internalA.profileId!, true, PermissionFlag.VENUE_MANAGER_CREATE));
    });
  });

  it('resetPassword with venue_manager.create on an Internal Manager → 404, no reset token, email, session revocation or audit row', async () => {
    await withGranted(ceoA, PermissionFlag.VENUE_MANAGER_CREATE, async () => {
      const signedIn = await factory.signedInContext(ceoA);
      await expectNotFoundAndInert(() => managers.resetPassword(signedIn, internalA.profileId!, PermissionFlag.VENUE_MANAGER_CREATE));
    });
  });

  it('the pin also refuses a CEO profile and another workspace\'s Venue Manager → 404, nothing changes', async () => {
    await withGranted(ceoA, PermissionFlag.VENUE_MANAGER_CREATE, async () => {
      const signedIn = await factory.signedInContext(ceoA);
      for (const id of [ceoA.profileId!, otherVmA.profileId!]) {
        await expectNotFoundAndInert(() => managers.update(signedIn, id, { firstName: 'Pinned' } as never, PermissionFlag.VENUE_MANAGER_CREATE));
        await expectNotFoundAndInert(() => managers.setActive(signedIn, id, false, PermissionFlag.VENUE_MANAGER_CREATE));
        await expectNotFoundAndInert(() => managers.resetPassword(signedIn, id, PermissionFlag.VENUE_MANAGER_CREATE));
      }
    });
  });

  it('positive control: the same caller with venue_manager.create updates, suspends, reactivates and resets a Venue Manager of its own workspace', async () => {
    await withGranted(ceoA, PermissionFlag.VENUE_MANAGER_CREATE, async () => {
      const signedIn = await factory.signedInContext(ceoA);
      const updated = await managers.update(signedIn, ownVmA.profileId!, { jobTitle: 'Floor lead' } as never, PermissionFlag.VENUE_MANAGER_CREATE);
      expect(updated.id).toBe(ownVmA.profileId);
      await managers.setActive(signedIn, ownVmA.profileId!, false, PermissionFlag.VENUE_MANAGER_CREATE);
      await managers.setActive(signedIn, ownVmA.profileId!, true, PermissionFlag.VENUE_MANAGER_CREATE);
      await managers.resetPassword(signedIn, ownVmA.profileId!, PermissionFlag.VENUE_MANAGER_CREATE);
    });
    const [profile] = (await admin.query(`SELECT job_title FROM core.manager_profile WHERE id = $1`, [ownVmA.profileId])) as Array<{ job_title: string | null }>;
    expect(profile!.job_title).toBe('Floor lead');
    const [user] = (await admin.query(`SELECT status, must_reset_password FROM core."user" WHERE id = $1`, [ownVmA.userId])) as Array<{ status: string; must_reset_password: boolean }>;
    expect(user).toEqual({ status: UserStatus.ACTIVE, must_reset_password: true });
    expect(await auditActions(ownVmA.userId, [AuditAction.ACCOUNT_SUSPENDED, AuditAction.ACCOUNT_REACTIVATED, AuditAction.ADMIN_PASSWORD_RESET])).toEqual([
      AuditAction.ACCOUNT_SUSPENDED,
      AuditAction.ACCOUNT_REACTIVATED,
      AuditAction.ADMIN_PASSWORD_RESET,
    ]);
  });

  it('the /managers flag is unchanged: the CEO (manager.manage) still updates the Internal Manager', async () => {
    const updated = await managers.update(ctxOf(ceoA), internalA.profileId!, { jobTitle: 'Ops lead' } as never);
    expect(updated.id).toBe(internalA.profileId);
  });
});
