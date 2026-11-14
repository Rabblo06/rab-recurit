import 'reflect-metadata';
import { ForbiddenException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { PlatformAdminService } from '../../engine/core-modules/platform-admin/platform-admin.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';

/**
 * M-T1 platform_admin recursion guard (HIGH, found on PR #72, fixed in place in PreAuthTablesForceOwnerOnly1786721400000;
 * owner-approved 2026-11-04). Under FORCE, core.platform_admin's TO PUBLIC policies called core.is_active_platform_admin(),
 * a rab_secure_owner definer reading core.platform_admin: policy -> function -> read -> policy -> ... "stack depth limit
 * exceeded" on every login as soon as a platform_admin row that is not the caller's own existed. The fix makes those
 * policies false for rab_secure_owner behind CASE; the owner keeps every row through platform_admin_secure_owner_definer.
 *
 * Owner conditions covered here (run as the connected runtime login; the owner login in Twenty mode):
 *   - zero admins: the first-admin bootstrap succeeds (committed on a database that never had a platform admin; otherwise
 *     replayed on an emptied table inside a transaction that is always rolled back);
 *   - two admin rows present: is_active_platform_admin answers, platform-admin login and normal login work;
 *   - promote / demote: allowed for an active admin; refused (403, no row change) for a normal user;
 *   - a normal user sees only their own platform_admin row;
 *   - every login / lookup test has a 5-second timeout, so a recursion or a hang fails fast.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
const FAST = 5_000;

describeIfDb('M-T1 platform_admin under FORCE: no policy recursion, admin flows intact (integration)', () => {
  jest.setTimeout(180_000);

  let app: INestApplication;
  let runtime: DataSource;
  let admin: DataSource;
  let tenant: TenantContextService;
  let platformAdmin: PlatformAdminService;
  let factory: TestIdentityFactory;
  let adminA: TestIdentity;
  let target: TestIdentity;
  let normal: TestIdentity;

  const rows = async () =>
    (await admin.query(`SELECT user_id::text AS u, revoked_at IS NULL AS active, security_version::text AS v FROM core.platform_admin ORDER BY user_id`)) as Array<{
      u: string;
      active: boolean;
      v: string;
    }>;
  const isActive = async (userId: string) =>
    ((await runtime.query(`SELECT core.is_active_platform_admin($1) AS a`, [userId])) as Array<{ a: boolean }>)[0]!.a;
  const visibleTo = (who: TestIdentity) =>
    tenant.runInTenantContext({ organisationId: who.organisationId, workspaceId: null, userId: who.userId, role: '' }, async (m) =>
      ((await m.query(`SELECT user_id::text AS u FROM core.platform_admin ORDER BY 1`)) as Array<{ u: string }>).map((r) => r.u),
    );
  const me = (token: string) => request(app.getHttpServer()).get('/rest/v1/auth/me').set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    admin = createAdminDataSource();
    await admin.initialize();
    runtime = moduleRef.get(DataSource);
    tenant = moduleRef.get(TenantContextService);
    platformAdmin = moduleRef.get(PlatformAdminService);
    factory = new TestIdentityFactory({ app, dataSource: runtime, adminDataSource: admin, tenantContext: tenant, passwordHashing: moduleRef.get(PasswordHashingService) });
  });

  afterAll(async () => {
    await admin?.destroy();
    await app?.close();
  });

  it('the migration left the three platform_admin policies guarded for rab_secure_owner, and FORCE on', async () => {
    const policies = (await admin.query(
      `SELECT p.polname::text AS name, p.polcmd::text AS cmd, coalesce(pg_get_expr(p.polqual, p.polrelid), '') AS qual,
              coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') AS chk
         FROM pg_policy p WHERE p.polrelid = 'core.platform_admin'::regclass ORDER BY 1`,
    )) as Array<{ name: string; cmd: string; qual: string; chk: string }>;
    expect(policies.map((p) => `${p.name}:${p.cmd}`)).toEqual([
      'platform_admin_secure_owner_definer:*',
      'platform_admin_select:r',
      'platform_admin_update:w',
      'platform_admin_write:a',
    ]);
    for (const p of policies.filter((x) => x.name !== 'platform_admin_secure_owner_definer')) {
      // pg_get_expr lays CASE out over several lines: compare with whitespace collapsed (as the migration's end check does).
      for (const e of [p.qual, p.chk].filter(Boolean)) {
        expect(e.replace(/\s+/g, ' ').trim()).toMatch(/^CASE WHEN \(CURRENT_USER = 'rab_secure_owner'::name\) THEN false ELSE /);
      }
    }
    const [forced] = (await admin.query(`SELECT relforcerowsecurity AS f FROM pg_class WHERE oid = 'core.platform_admin'::regclass`)) as Array<{ f: boolean }>;
    expect(forced!.f).toBe(true);
  });

  it(
    'zero admins: the first-admin bootstrap succeeds as the runtime login',
    async () => {
      const email = `pa-bootstrap-${randomUUID()}@example.test`;
      const slug = `pa-bootstrap-${randomUUID().slice(0, 8)}`;
      const call = `SELECT outcome, user_id::text AS user_id FROM core.bootstrap_first_platform_admin($1::public.citext, 'First', 'Admin', $2::public.citext, 'Bootstrap Org')`;
      const existing = await rows();
      if (existing.length === 0) {
        // A database that never had a platform admin: the real, committed first bootstrap.
        console.log('[platform-admin-force-rls] zero-admin bootstrap: committed path (fresh database)');
        const [r] = (await runtime.query(call, [email, slug])) as Array<{ outcome: string; user_id: string }>;
        expect(r!.outcome).toBe('CREATED_INVITED');
        expect(await isActive(r!.user_id)).toBe(true);
        expect((await rows()).map((x) => x.u)).toEqual([r!.user_id]);
      } else {
        // A shared database: empty the table inside one transaction as the superuser fixture, act as the runtime login,
        // always roll back (no foreign key references core.platform_admin).
        console.log(`[platform-admin-force-rls] zero-admin bootstrap: transactional replay (${existing.length} existing row(s), rolled back)`);
        const [{ who }] = (await runtime.query(`SELECT current_user::text AS who`)) as Array<{ who: string }>;
        const qr = admin.createQueryRunner();
        await qr.connect();
        await qr.startTransaction();
        try {
          await qr.query(`DELETE FROM core.platform_admin`);
          await qr.query(`SELECT set_config('role', $1, true)`, [who]);
          const [r] = (await qr.query(call, [email, slug])) as Array<{ outcome: string; user_id: string }>;
          expect(r!.outcome).toBe('CREATED_INVITED');
          const [a] = (await qr.query(`SELECT core.is_active_platform_admin($1) AS a`, [r!.user_id])) as Array<{ a: boolean }>;
          expect(a!.a).toBe(true);
        } finally {
          await qr.rollbackTransaction();
          await qr.release();
        }
        expect((await rows()).length).toBe(existing.length);
      }
    },
    15_000,
  );

  it('setup: an active admin (fixture grant), a promotion target and a normal user in one organisation', async () => {
    const { managers } = await factory.createOrganisationWithManagers(3, { permissions: 'production', firstIsPlatformAdmin: true, workspace: true, label: 'pafr' });
    [adminA, target, normal] = managers as [TestIdentity, TestIdentity, TestIdentity];
    expect(await isActive(adminA.userId)).toBe(true);
  });

  it(
    'promote: allowed for an active admin (now two admin rows that are not each other’s)',
    async () => {
      const { granted } = await platformAdmin.grant(await factory.signedInContext(adminA), target.userId, { reason: 'M-T1 recursion regression' });
      expect(granted).toBe(true);
      const active = (await rows()).filter((r) => r.active).map((r) => r.u);
      expect(active).toEqual(expect.arrayContaining([adminA.userId, target.userId]));
      expect(active.length).toBeGreaterThanOrEqual(2);
    },
    15_000,
  );

  it(
    'is_active_platform_admin answers with two admin rows present (no recursion), as the runtime login',
    async () => {
      expect(await isActive(adminA.userId)).toBe(true);
      expect(await isActive(target.userId)).toBe(true);
      expect(await isActive(normal.userId)).toBe(false);
      expect(await isActive(randomUUID())).toBe(false);
      // Inside a normal user's tenant context too (the login path's shape).
      const inCtx = await tenant.runInTenantContext({ organisationId: normal.organisationId, workspaceId: null, userId: normal.userId, role: '' }, async (m) =>
        ((await m.query(`SELECT core.is_active_platform_admin($1) AS a, core.is_active_platform_admin() AS self`, [adminA.userId])) as Array<{ a: boolean; self: boolean }>)[0]!,
      );
      expect(inCtx).toEqual({ a: true, self: false });
    },
    FAST,
  );

  it(
    'platform-admin login with two admins: signs in, /auth/me and the admin panel answer',
    async () => {
      const token = await factory.login(adminA);
      expect((await me(token)).status).toBe(200);
      expect((await request(app.getHttpServer()).get('/rest/v1/admin/general').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    },
    FAST,
  );

  it(
    'normal login with two admin rows present: signs in, /auth/me answers, the admin panel is 403',
    async () => {
      const token = await factory.login(normal);
      expect((await me(token)).status).toBe(200);
      expect((await request(app.getHttpServer()).get('/rest/v1/admin/general').set('Authorization', `Bearer ${token}`)).status).toBe(403);
    },
    FAST,
  );

  it(
    'promote / demote refused for a normal user: 403 over HTTP and in the service, no row change',
    async () => {
      const before = await rows();
      const token = await factory.login(normal);
      const promote = await request(app.getHttpServer())
        .post(`/rest/v1/admin/platform-admins/${normal.userId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'self promotion attempt' });
      expect(promote.status).toBe(403);
      const demote = await request(app.getHttpServer())
        .delete(`/rest/v1/admin/platform-admins/${adminA.userId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'demotion attempt' });
      expect(demote.status).toBe(403);
      const ctx = { organisationId: normal.organisationId, userId: normal.userId };
      await expect(platformAdmin.grant(ctx, normal.userId, { reason: 'service-level promotion attempt' })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(platformAdmin.revoke(ctx, adminA.userId, { reason: 'service-level demotion attempt' })).rejects.toBeInstanceOf(ForbiddenException);
      expect(await rows()).toEqual(before);
    },
    15_000,
  );

  it(
    'demote: allowed for an active admin',
    async () => {
      const { revoked } = await platformAdmin.revoke(await factory.signedInContext(adminA), target.userId, { reason: 'M-T1 recursion regression' });
      expect(revoked).toBe(true);
      expect(await isActive(target.userId)).toBe(false);
      expect((await rows()).find((r) => r.u === target.userId)?.active).toBe(false);
    },
    15_000,
  );

  it(
    'a normal user sees only their own platform_admin row; an active admin sees every row',
    async () => {
      expect(await visibleTo(target)).toEqual([target.userId]); // demoted: own (revoked) row only
      expect(await visibleTo(normal)).toEqual([]); // never an admin: no row of their own, nothing else
      const all = (await rows()).map((r) => r.u);
      expect(await visibleTo(adminA)).toEqual(all);
    },
    FAST,
  );
});
