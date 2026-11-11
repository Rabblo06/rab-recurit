import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PermissionFlag, PermissionFlagType } from '@rab/shared';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../../app.module';
import { AuthCacheRedisClientProvider } from '../../engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { AuthContextCacheService } from '../../engine/core-modules/auth/services/auth-context-cache.service';
import { AuthSecuritySnapshot, AuthSecuritySnapshotService } from '../../engine/core-modules/auth/services/auth-security-snapshot.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { RefreshTokenService } from '../../engine/core-modules/auth/token/services/refresh-token.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { PermissionsService } from '../../engine/core-modules/permissions/permissions.service';
import { hasTxPermissionMemo } from '../../engine/core-modules/permissions/tx-permission-memo';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { Organisation } from '../../modules/identity/entities';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * SC-08 (Phase X Stage 0, S0-C-caches.md §C6): before any cache is switched on, prove that caching cannot change an
 * authorisation answer. For ALL 46 permission flags and every identity shape the auth layer distinguishes:
 *
 *   role grant · no grant · override grant · override revoke · a custom role of ANOTHER workspace · suspended workspace
 *   membership · platform admin · Admin Inspect of a target
 *
 * these five answers must be identical, flag by flag:
 *   1. the request security snapshot with the auth-context cache OFF;
 *   2. the snapshot with the cache ON, cold (a miss that writes the entry);
 *   3. the snapshot with the cache ON, warm (a verified hit);
 *   4. the per-flag service lookup (`userHasPermissionTx`'s original two-query path);
 *   5. the transaction-local set (C5) and `effectivePermissionsTx` (SC-05).
 *
 * Real PostgreSQL (FORCE RLS, owner login) and real Redis. The cache switch is the service's own `isEnabled()` (spied per
 * mode), so one process compares all modes on the same rows.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const ALL_FLAGS = Object.values(PermissionFlag) as PermissionFlagType[];
type Answers = Record<string, boolean>;

describeIfDb('SC-08 cached ≡ uncached for all 46 permissions, every identity shape (integration)', () => {
  jest.setTimeout(240_000);

  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let tenantContext: TenantContextService;
  let permissions: PermissionsService;
  let snapshots: AuthSecuritySnapshotService;
  let cache: AuthContextCacheService;
  let redis: AuthCacheRedisClientProvider;
  let refreshTokens: RefreshTokenService;
  let env: EnvironmentService;

  const answers = (has: (flag: PermissionFlagType) => boolean): Answers => Object.fromEntries(ALL_FLAGS.map((f) => [f, has(f)]));
  const fromSnapshot = (s: AuthSecuritySnapshot | null): Answers | null => (s ? answers((f) => s.effectivePermissions.has(f)) : null);

  async function seedSession(identity: TestIdentity): Promise<string> {
    const sid = randomUUID();
    await tenantContext.runInTenantContext({ organisationId: identity.organisationId, workspaceId: identity.workspaceId, userId: identity.userId, role: '' }, (m) =>
      refreshTokens.issue(m, { userId: identity.userId, organisationId: identity.organisationId, applicationTarget: 'manager_web', familyId: sid, roles: [identity.roleKey], authProvider: 'password' }),
    );
    return sid;
  }

  async function snapshotIn(mode: 'off' | 'cold' | 'warm', identity: TestIdentity, sid: string): Promise<AuthSecuritySnapshot | null> {
    const enabled = jest.spyOn(cache, 'isEnabled').mockReturnValue(mode !== 'off');
    const get = jest.spyOn(cache, 'get');
    const prefix = `crewflow:${env.get('NODE_ENV')}:authctx:${identity.organisationId}:${createHash('sha256').update(sid).digest('hex')}:`;
    try {
      const before = await redis.client.keys(`${prefix}*`);
      if (mode === 'cold') expect(before).toHaveLength(0);
      if (mode === 'warm') expect(before.length).toBeGreaterThan(0);
      const snapshot = await snapshots.build({ sid, sub: identity.userId, org: identity.organisationId });
      if (mode === 'off') expect(get).not.toHaveBeenCalled();
      if (mode === 'cold') {
        expect(await get.mock.results[0]!.value).toBeNull(); // a real miss...
        expect(await redis.client.keys(`${prefix}*`)).toHaveLength(1); // ...that wrote the entry
      }
      if (mode === 'warm') expect(await get.mock.results[0]!.value).not.toBeNull(); // a real hit
      return snapshot;
    } finally {
      enabled.mockRestore();
      get.mockRestore();
    }
  }

  /** 4 and 5: per-flag lookup, the transaction-local set and effectivePermissionsTx, in one tenant transaction for `ctx`. */
  async function serviceAnswers(ctx: AuthContext): Promise<{ perFlag: Answers; txLocal: Answers; effective: Answers }> {
    return tenantContext.runInTenantContext(ctx, async (m: EntityManager) => {
      const uncached = (permissions as unknown as { userHasPermissionUncachedTx: (m: EntityManager, c: AuthContext, f: PermissionFlagType) => Promise<boolean> }).userHasPermissionUncachedTx.bind(permissions);
      const perFlag: Answers = {};
      for (const flag of ALL_FLAGS) perFlag[flag] = await uncached(m, ctx, flag);
      const txLocal: Answers = {};
      for (const flag of ALL_FLAGS) txLocal[flag] = await permissions.userHasPermissionTx(m, ctx, flag);
      expect(hasTxPermissionMemo(m.queryRunner)).toBe(true);
      const set = await permissions.effectivePermissionsTx(m, ctx);
      return { perFlag, txLocal, effective: answers((f) => set.has(f)) };
    });
  }

  const overrides = (userId: string, organisationId: string, effect: 'grant' | 'revoke', keys: readonly string[]) =>
    owner.query(
      `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect) SELECT $1, id, $2, $3 FROM core.permission WHERE key = ANY($4)`,
      [userId, organisationId, effect, keys],
    );

  const shapes: Array<{ name: string; identity: TestIdentity; sid?: string; check?: (a: Answers) => void }> = [];
  let admin: TestIdentity;
  let inspectedTarget: TestIdentity;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    tenantContext = moduleRef.get(TenantContextService);
    permissions = moduleRef.get(PermissionsService);
    snapshots = moduleRef.get(AuthSecuritySnapshotService);
    cache = moduleRef.get(AuthContextCacheService);
    redis = moduleRef.get(AuthCacheRedisClientProvider);
    refreshTokens = moduleRef.get(RefreshTokenService);
    env = moduleRef.get(EnvironmentService);
    factory = new TestIdentityFactory({ app, dataSource: moduleRef.get(DataSource), adminDataSource: owner, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });

    const { organisation: org, managers } = await factory.createOrganisationWithManagers(5, { permissions: 'production', workspace: true, label: 'sc08' });
    const [roleGrant, overrideRevoke, foreignWsOwner, suspended, platformAdmin] = managers as [TestIdentity, TestIdentity, TestIdentity, TestIdentity, TestIdentity];
    const emptyOrg: Organisation = await factory.createOrganisation('sc08-empty');
    const noGrant = await factory.createOrgAdmin(emptyOrg, { permissions: [] });
    const overrideGrant = await factory.createStaff(org, { owner: roleGrant, label: 'sc08-grant' });
    const foreignRoleHolder = await factory.createStaff(org, { owner: roleGrant, label: 'sc08-foreign' });

    await overrides(overrideGrant.userId, org.id, 'grant', [PermissionFlag.PAYROLL_APPROVE, PermissionFlag.MANAGER_MANAGE]);
    await overrides(overrideRevoke.userId, org.id, 'revoke', [PermissionFlag.STAFF_VIEW, PermissionFlag.OFFER_SEND]);
    // A custom role in ANOTHER workspace (foreignWsOwner's), held by a staff member of roleGrant's workspace: role RLS hides
    // it in the holder's own workspace, so it must grant nothing there, in every mode.
    const foreignFlags = [PermissionFlag.STAFF_VIEW, PermissionFlag.VENUE_VIEW]; // member roles may carry only staff.view, venue.view, schedule.view
    const [customRole] = await owner.query(
      `INSERT INTO core.role (organisation_id, workspace_id, key, name, is_system) VALUES ($1, $2, $3, 'SC-08 foreign custom', false) RETURNING id`,
      [org.id, foreignWsOwner.workspaceId, `custom_sc08_${randomUUID().slice(0, 8)}`],
    );
    await owner.query(`INSERT INTO core.role_permission (organisation_id, role_id, permission_id) SELECT $1, $2, id FROM core.permission WHERE key = ANY($3)`, [org.id, customRole.id, foreignFlags]);
    await owner.query(`INSERT INTO core.user_role (organisation_id, user_id, role_id) VALUES ($1, $2, $3)`, [org.id, foreignRoleHolder.userId, customRole.id]);
    await factory.grantPlatformAdmin(platformAdmin.userId);

    admin = platformAdmin;
    inspectedTarget = overrideGrant;
    shapes.push(
      { name: 'role grant', identity: roleGrant, check: (a) => expect(Object.values(a).some(Boolean)).toBe(true) },
      { name: 'no grant', identity: noGrant, check: (a) => expect(Object.values(a).some(Boolean)).toBe(false) },
      { name: 'override grant', identity: overrideGrant, check: (a) => expect([a[PermissionFlag.PAYROLL_APPROVE], a[PermissionFlag.MANAGER_MANAGE]]).toEqual([true, true]) },
      { name: 'override revoke', identity: overrideRevoke, check: (a) => expect([a[PermissionFlag.STAFF_VIEW], a[PermissionFlag.OFFER_SEND]]).toEqual([false, false]) },
      { name: 'custom role of another workspace', identity: foreignRoleHolder, check: (a) => expect(foreignFlags.map((f) => a[f])).toEqual([false, false]) },
      { name: 'suspended workspace membership', identity: suspended },
      { name: 'platform admin', identity: platformAdmin },
    );
    // Every session is issued while all memberships are active; the suspension comes after, as in real life.
    for (const shape of shapes) shape.sid = await seedSession(shape.identity);
    await owner.query(`UPDATE core.workspace_membership SET status = 'suspended' WHERE user_id = $1`, [suspended.userId]);
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
  });

  it('there are 46 flags and every identity shape is covered', () => {
    expect(ALL_FLAGS).toHaveLength(46);
    expect(shapes.map((s) => s.name)).toHaveLength(7);
  });

  it.each([0, 1, 2, 3, 4, 5, 6])('identity shape #%i: cache off ≡ cache on cold ≡ cache on warm ≡ per-flag ≡ transaction-local', async (i) => {
    const { name, identity, check, sid } = shapes[i]! as { name: string; identity: TestIdentity; sid: string; check?: (a: Answers) => void };
    const off = await snapshotIn('off', identity, sid);
    expect([name, off]).not.toEqual([name, null]);
    const cold = await snapshotIn('cold', identity, sid);
    const warm = await snapshotIn('warm', identity, sid);
    const expected = fromSnapshot(off)!;
    expect([name, fromSnapshot(cold)]).toEqual([name, expected]);
    expect([name, fromSnapshot(warm)]).toEqual([name, expected]);
    expect([name, cold!.workspaceId, warm!.workspaceId]).toEqual([name, off!.workspaceId, off!.workspaceId]);

    const ctx: AuthContext = { organisationId: off!.organisationId, workspaceId: off!.workspaceId, userId: off!.userId, role: '' };
    const service = await serviceAnswers(ctx);
    expect([name, service.perFlag]).toEqual([name, expected]);
    expect([name, service.txLocal]).toEqual([name, expected]);
    expect([name, service.effective]).toEqual([name, expected]);
    check?.(expected);
  });

  it('Admin Inspect: the inspected target is answered from ITS set in every path, never the admin set', async () => {
    const sid = await seedSession(inspectedTarget);
    const targetOwn = fromSnapshot(await snapshotIn('off', inspectedTarget, sid))!;
    const adminSid = await seedSession(admin);
    const adminOwn = fromSnapshot(await snapshotIn('off', admin, adminSid))!;
    expect(targetOwn).not.toEqual(adminOwn);
    const inspected: AuthContext = { organisationId: inspectedTarget.organisationId, workspaceId: inspectedTarget.workspaceId, userId: inspectedTarget.userId, role: '', inspectedBy: admin.userId };
    const service = await serviceAnswers(inspected);
    expect(service.perFlag).toEqual(targetOwn);
    expect(service.txLocal).toEqual(targetOwn);
    expect(service.effective).toEqual(targetOwn);
    const hints = await permissions.displayHints({ ...inspected, security: (await snapshotIn('off', admin, adminSid))! }, ALL_FLAGS);
    expect(hints).toEqual(targetOwn);
  });
});
