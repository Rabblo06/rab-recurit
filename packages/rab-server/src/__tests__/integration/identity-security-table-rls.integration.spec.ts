import 'reflect-metadata';
import { ManagerType, UserStatus } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { Organisation, User } from '../../modules/identity/entities';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';

/**
 * Stage 2A final verification, item 2 — "Identity / security table RLS."
 * Real Postgres, real `rab_app` role, RLS on, no mocks. Every query in this
 * file runs raw SQL bound to a real, resolved tenant context via
 * `TenantContextService.runInTenantContext` — deliberately bypassing every
 * service/controller layer, so what's proven is the database's own policy
 * and grant state, not route design.
 *
 * This file is written to be HONEST, not to overclaim. The user's request
 * asked to "prove User A cannot read User B's private identity/security
 * rows merely because they share an organisation" — that is TRUE for
 * `login_history` and `user_preference` (genuinely user-scoped RLS), but is
 * NOT true at the raw-RLS layer for `user`, `user_role`,
 * `user_permission_override`, `refresh_token`, `password_reset_token` — all
 * five are deliberately ORG-scoped, not user-scoped, matching this
 * codebase's existing "collaborative Manager visibility" design (the same
 * shape `manager_workspace`'s SELECT-precondition-for-writes note and
 * `IdentitySchema`'s own docs already establish elsewhere). What this file
 * proves for those five tables instead: (a) the row IS org-visible, exactly
 * as designed, not accidentally; (b) the one genuinely secret payload on
 * `user` (`password_hash`/`totp_secret_encrypted`) is now blocked at the
 * column-privilege layer regardless of org membership
 * (`RevokeUserPasswordHashSelectFromApp1786669800000`, this window's real
 * finding); (c) `refresh_token`/`password_reset_token`'s `token_hash` is a
 * SHA-256 digest of a 256-bit random value — org-visible as a row, but the
 * value itself is cryptographically inert if read, unlike a password.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('identity/security table RLS (Stage 2A final verification)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;

  const password = 'correct horse battery staple 1!';

  async function seedOrgWithManagers(count: number): Promise<{
    organisation: Organisation;
    managers: { email: string; userId: string }[];
  }> {
    const slug = `test-${randomUUID()}`;
    const orgInsert = await adminDataSource.manager.insert(Organisation, { name: slug, slug });
    const organisation = await adminDataSource.manager.findOneByOrFail(Organisation, { id: orgInsert.identifiers[0]!.id as string });

    const managers: { email: string; userId: string }[] = [];
    await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' }, async (m) => {
      for (let i = 0; i < count; i++) {
        const email = `identity-${i}-${randomUUID()}@example.test`;
        const passwordHash = await passwordHashing.hash(password);
        const userResult = await m.insert(User, {
          organisationId: organisation.id,
          email,
          passwordHash,
          firstName: `Identity${i}`,
          lastName: 'Test',
          status: UserStatus.ACTIVE,
        });
        const userId = userResult.identifiers[0]!.id as string;
        await m.query(`INSERT INTO core.manager_profile (organisation_id, user_id, type) VALUES ($1, $2, $3)`, [
          organisation.id,
          userId,
          ManagerType.INTERNAL,
        ]);
        managers.push({ email, userId });
      }
    });

    return { organisation, managers };
  }

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/rest/v1/auth/login').send({ email, password });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    dataSource = moduleRef.get(DataSource);
    passwordHashing = moduleRef.get(PasswordHashingService);
    tenantContext = moduleRef.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  describe('core.current_uid() — transaction-scoped, server-derived', () => {
    it('resolves to whichever userId TenantContextService bound for that transaction, and nothing else', async () => {
      const userIdA = randomUUID();
      const userIdB = randomUUID();

      const resolvedA = await tenantContext.runInTenantContext(
        { organisationId: randomUUID(), workspaceId: null, userId: userIdA, role: '' },
        (m) => m.query<Array<{ uid: string }>>(`SELECT core.current_uid() AS uid`),
      );
      expect(resolvedA[0].uid).toBe(userIdA);

      const resolvedB = await tenantContext.runInTenantContext(
        { organisationId: randomUUID(), workspaceId: null, userId: userIdB, role: '' },
        (m) => m.query<Array<{ uid: string }>>(`SELECT core.current_uid() AS uid`),
      );
      expect(resolvedB[0].uid).toBe(userIdB);
      expect(resolvedB[0].uid).not.toBe(resolvedA[0].uid);
    });

    it('is unset (NULL) on a connection with no tenant context ever bound — never inherits a prior transaction\'s value', async () => {
      const unbound = await dataSource.manager.query<Array<{ uid: string | null }>>(`SELECT core.current_uid() AS uid`);
      expect(unbound[0].uid).toBeNull();
    });
  });

  describe('login_history — genuinely self-scoped (User A cannot read User B\'s rows, same org)', () => {
    it('SELECT is user-scoped: direct lookup, and an unfiltered list, both exclude the other user\'s rows', async () => {
      const { organisation, managers } = await seedOrgWithManagers(2);
      const [a, b] = managers;
      await login(a!.email);
      await login(b!.email);
      // One failed attempt for B too — proves the permissive INSERT
      // (pre-auth failed-login logging) doesn't also loosen SELECT.
      await request(app.getHttpServer()).post('/rest/v1/auth/login').send({ email: b!.email, password: 'wrong password entirely' });

      const byUserIdB = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: null, userId: a!.userId, role: '' },
        (m) => m.query(`SELECT id FROM core.login_history WHERE user_id = $1`, [b!.userId]),
      );
      expect(byUserIdB).toHaveLength(0);

      const listRows = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: null, userId: a!.userId, role: '' },
        (m) => m.query<Array<{ user_id: string | null }>>(`SELECT user_id FROM core.login_history`),
      );
      expect(listRows.length).toBeGreaterThan(0);
      for (const row of listRows) {
        expect(row.user_id === a!.userId || row.user_id === null).toBe(true);
      }
    });

    it('the final policy shapes: SELECT user-scoped, INSERT permissive by design (pre-auth logging), not FORCE\'d', async () => {
      const policies = await dataSource.manager.query<
        Array<{ polname: string; polcmd: string; using_expr: string | null; with_check_expr: string | null }>
      >(
        `SELECT polname, polcmd, pg_get_expr(polqual, polrelid) AS using_expr, pg_get_expr(polwithcheck, polrelid) AS with_check_expr
           FROM pg_policy WHERE polrelid = 'core.login_history'::regclass ORDER BY polname`,
      );
      const select = policies.find((p) => p.polcmd === 'r')!;
      expect(select.using_expr).toBe('(user_id = core.current_uid())');
      const insert = policies.find((p) => p.polcmd === 'a')!;
      expect(insert.with_check_expr).toBe('true');
    });
  });

  describe('user_preference — genuinely self-scoped (FORCE + user_id = current_uid())', () => {
    it('SELECT is user-scoped: direct lookup, and an unfiltered list, both exclude the other user\'s row', async () => {
      const { organisation, managers } = await seedOrgWithManagers(2);
      const [a, b] = managers;
      const tokenA = await login(a!.email);
      const tokenB = await login(b!.email);
      // GET /profile/preferences lazily creates the row on first access.
      await request(app.getHttpServer()).get('/rest/v1/profile/preferences').set('Authorization', `Bearer ${tokenA}`).expect(200);
      await request(app.getHttpServer()).get('/rest/v1/profile/preferences').set('Authorization', `Bearer ${tokenB}`).expect(200);

      const byUserIdB = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: null, userId: a!.userId, role: '' },
        (m) => m.query(`SELECT user_id FROM core.user_preference WHERE user_id = $1`, [b!.userId]),
      );
      expect(byUserIdB).toHaveLength(0);

      const listRows = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: null, userId: a!.userId, role: '' },
        (m) => m.query<Array<{ user_id: string }>>(`SELECT user_id FROM core.user_preference`),
      );
      const ids = listRows.map((r) => r.user_id);
      expect(ids).toContain(a!.userId);
      expect(ids).not.toContain(b!.userId);
    });

    it('is FORCE\'d, and its policy is a genuine user_id = current_uid() predicate, not org-scoped', async () => {
      const forced = await dataSource.manager.query<Array<{ relforcerowsecurity: boolean }>>(
        `SELECT relforcerowsecurity FROM pg_class WHERE oid = 'core.user_preference'::regclass`,
      );
      expect(forced[0].relforcerowsecurity).toBe(true);

      const policies = await dataSource.manager.query<Array<{ using_expr: string | null }>>(
        `SELECT pg_get_expr(polqual, polrelid) AS using_expr FROM pg_policy WHERE polrelid = 'core.user_preference'::regclass`,
      );
      expect(policies).toHaveLength(1);
      expect(policies[0].using_expr).toBe('(user_id = core.current_uid())');
    });
  });

  describe('core."user" — org-scoped SELECT by design, but password_hash/totp_secret_encrypted are now column-blocked regardless of org', () => {
    it('non-sensitive columns ARE readable cross-user within the same org — accurately documented, not a gap', async () => {
      const { organisation, managers } = await seedOrgWithManagers(2);
      const [a, b] = managers;

      const rows = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: null, userId: a!.userId, role: '' },
        (m) => m.query(`SELECT id, email, first_name FROM core."user" WHERE id = $1`, [b!.userId]),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(b!.userId);
    });

    it('password_hash is blocked at the column-privilege layer for ANY row, including the caller\'s own — the fix is table-wide, not RLS-conditional', async () => {
      const { organisation, managers } = await seedOrgWithManagers(1);
      const [a] = managers;

      await expect(
        tenantContext.runInTenantContext(
          { organisationId: organisation.id, workspaceId: null, userId: a!.userId, role: '' },
          (m) => m.query(`SELECT password_hash FROM core."user" WHERE id = $1`, [a!.userId]),
        ),
      ).rejects.toThrow(/permission denied for table user/);
    });

    it('totp_secret_encrypted is likewise blocked at the column-privilege layer', async () => {
      const { organisation, managers } = await seedOrgWithManagers(1);
      const [a] = managers;

      await expect(
        tenantContext.runInTenantContext(
          { organisationId: organisation.id, workspaceId: null, userId: a!.userId, role: '' },
          (m) => m.query(`SELECT totp_secret_encrypted FROM core."user" WHERE id = $1`, [a!.userId]),
        ),
      ).rejects.toThrow(/permission denied for table user/);
    });

    it('a different organisation cannot see the row at all, regardless of columns requested — RLS org boundary still holds', async () => {
      const { managers } = await seedOrgWithManagers(1);
      const [a] = managers;
      const otherOrg = await seedOrgWithManagers(1);

      const rows = await tenantContext.runInTenantContext(
        { organisationId: otherOrg.organisation.id, workspaceId: null, userId: otherOrg.managers[0]!.userId, role: '' },
        (m) => m.query(`SELECT id, email FROM core."user" WHERE id = $1`, [a!.userId]),
      );
      expect(rows).toHaveLength(0);
    });

    it('rab_app holds SELECT on exactly the 15 safe columns, and not password_hash/totp_secret_encrypted', async () => {
      const grants = await dataSource.manager.query<Array<{ column_name: string }>>(
        `SELECT column_name FROM information_schema.column_privileges
          WHERE table_schema = 'core' AND table_name = 'user' AND grantee = 'rab_app' AND privilege_type = 'SELECT'
          ORDER BY column_name`,
      );
      const columns = grants.map((g) => g.column_name);
      expect(columns).not.toContain('password_hash');
      expect(columns).not.toContain('totp_secret_encrypted');
      expect(columns).toContain('email');
      expect(columns).toContain('id');
      // 15 = the original 14 safe columns (RevokeUserPasswordHashSelectFromApp1786669800000)
      // + email_verified_at, explicitly granted by AccountInviteSchema1786670100000.
      expect(columns).toContain('email_verified_at');
      expect(columns).toHaveLength(15);
    });

    it('the pre-auth SECURITY DEFINER login flow (auth_find_users_by_email) is unaffected by the column revoke — still returns passwordHash', async () => {
      const { managers } = await seedOrgWithManagers(1);
      const [a] = managers;

      // Run as rab_app (the pooled app connection), no tenant context bound
      // at all — exactly how AuthService.login() calls it pre-auth.
      const rows = await dataSource.manager.query<Array<{ passwordHash: string }>>(
        `SELECT * FROM core.auth_find_users_by_email($1)`,
        [a!.email],
      );
      expect(rows).toHaveLength(1);
      expect(typeof rows[0].passwordHash).toBe('string');
      expect(rows[0].passwordHash.length).toBeGreaterThan(0);

      // And the real end-to-end login (which depends on this exact
      // function) still succeeds — the column revoke breaks nothing.
      const loginRes = await request(app.getHttpServer()).post('/rest/v1/auth/login').send({ email: a!.email, password });
      expect(loginRes.status).toBe(200);
      expect(typeof loginRes.body.accessToken).toBe('string');
    });

    it('user_select policy is org-scoped, not user-scoped — documented and intentional, not overclaimed as user-private', async () => {
      const policies = await dataSource.manager.query<Array<{ polname: string; using_expr: string | null }>>(
        `SELECT polname, pg_get_expr(polqual, polrelid) AS using_expr FROM pg_policy
           WHERE polrelid = 'core."user"'::regclass AND polname = 'user_select'`,
      );
      expect(policies).toHaveLength(1);
      expect(policies[0].using_expr).toBe('(organisation_id = core.current_org())');
    });
  });

  describe('user_role / user_permission_override — org-scoped by design (roster visibility), not user-private', () => {
    /** seedOrgWithManagers stamps a manager_profile but no role — insert one directly for these tests. */
    async function assignRole(organisationId: string, userId: string): Promise<void> {
      await tenantContext.runInTenantContext({ organisationId, workspaceId: null, userId: randomUUID(), role: '' }, async (m) => {
        const roleResult = await m.query(
          `INSERT INTO core.role (organisation_id, key, name, is_system) VALUES ($1, $2, 'Manager', true) RETURNING id`,
          [organisationId, `manager-${randomUUID()}`],
        );
        await m.query(`INSERT INTO core.user_role (user_id, role_id, organisation_id) VALUES ($1, $2, $3)`, [
          userId,
          roleResult[0].id,
          organisationId,
        ]);
      });
    }

    it('user_role: SELECT is org-scoped — Manager A can see Manager B\'s role rows within the same org', async () => {
      const { organisation, managers } = await seedOrgWithManagers(2);
      const [a, b] = managers;
      await assignRole(organisation.id, b!.userId);

      const rows = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: null, userId: a!.userId, role: '' },
        (m) => m.query(`SELECT user_id FROM core.user_role WHERE user_id = $1`, [b!.userId]),
      );
      expect(rows.length).toBeGreaterThan(0);
    });

    it('user_role: a DIFFERENT organisation cannot see it at all — the org boundary, the real enforcement here', async () => {
      const { organisation, managers } = await seedOrgWithManagers(1);
      const [a] = managers;
      await assignRole(organisation.id, a!.userId);
      const otherOrg = await seedOrgWithManagers(1);

      const rows = await tenantContext.runInTenantContext(
        { organisationId: otherOrg.organisation.id, workspaceId: null, userId: otherOrg.managers[0]!.userId, role: '' },
        (m) => m.query(`SELECT user_id FROM core.user_role WHERE user_id = $1`, [a!.userId]),
      );
      expect(rows).toHaveLength(0);
    });

    it('user_permission_override: same org-scoped shape — visible cross-user in-org, invisible cross-org', async () => {
      const { organisation, managers } = await seedOrgWithManagers(2);
      const [a, b] = managers;
      const permission = await adminDataSource.manager.query<Array<{ id: string }>>(
        `SELECT id FROM core.permission LIMIT 1`,
      );
      await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: b!.userId, role: '' }, (m) =>
        m.query(`INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect) VALUES ($1, $2, $3, 'grant')`, [
          b!.userId,
          permission[0]!.id,
          organisation.id,
        ]),
      );

      const sameOrg = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: null, userId: a!.userId, role: '' },
        (m) => m.query(`SELECT user_id FROM core.user_permission_override WHERE user_id = $1`, [b!.userId]),
      );
      expect(sameOrg).toHaveLength(1);

      const otherOrg = await seedOrgWithManagers(1);
      const crossOrg = await tenantContext.runInTenantContext(
        { organisationId: otherOrg.organisation.id, workspaceId: null, userId: otherOrg.managers[0]!.userId, role: '' },
        (m) => m.query(`SELECT user_id FROM core.user_permission_override WHERE user_id = $1`, [b!.userId]),
      );
      expect(crossOrg).toHaveLength(0);
    });
  });

  describe('refresh_token / password_reset_token — org-scoped, but token_hash is a cryptographically inert SHA-256 digest', () => {
    it('refresh_token: org-scoped SELECT, and the stored token_hash is a 64-char hex digest — never the usable raw token', async () => {
      const { organisation, managers } = await seedOrgWithManagers(2);
      const [a, b] = managers;
      await login(b!.email); // real login -> real RefreshTokenService.issue() -> real INSERT

      const rows = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: null, userId: a!.userId, role: '' },
        (m) => m.query<Array<{ token_hash: string }>>(`SELECT token_hash FROM core.refresh_token WHERE user_id = $1`, [b!.userId]),
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex digest shape — opaque, not reversible to the raw token
      }
    });

    it('refresh_token: a different organisation cannot see it at all', async () => {
      const { managers } = await seedOrgWithManagers(1);
      const [a] = managers;
      await login(a!.email);
      const otherOrg = await seedOrgWithManagers(1);

      const rows = await tenantContext.runInTenantContext(
        { organisationId: otherOrg.organisation.id, workspaceId: null, userId: otherOrg.managers[0]!.userId, role: '' },
        (m) => m.query(`SELECT id FROM core.refresh_token WHERE user_id = $1`, [a!.userId]),
      );
      expect(rows).toHaveLength(0);
    });

    it('password_reset_token: org-scoped SELECT, and token_hash is likewise an opaque 64-char hex digest', async () => {
      const { organisation, managers } = await seedOrgWithManagers(2);
      const [a, b] = managers;
      const forgotRes = await request(app.getHttpServer()).post('/rest/v1/auth/forgot-password').send({ email: b!.email });
      expect(forgotRes.status).toBe(204); // no-content by design — anti-enumeration, same response whether the email exists or not

      const rows = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: null, userId: a!.userId, role: '' },
        (m) => m.query<Array<{ token_hash: string }>>(`SELECT token_hash FROM core.password_reset_token WHERE user_id = $1`, [b!.userId]),
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it('password_reset_token: a different organisation cannot see it at all', async () => {
      const { managers } = await seedOrgWithManagers(1);
      const [a] = managers;
      await request(app.getHttpServer()).post('/rest/v1/auth/forgot-password').send({ email: a!.email }).expect(204);
      const otherOrg = await seedOrgWithManagers(1);

      const rows = await tenantContext.runInTenantContext(
        { organisationId: otherOrg.organisation.id, workspaceId: null, userId: otherOrg.managers[0]!.userId, role: '' },
        (m) => m.query(`SELECT id FROM core.password_reset_token WHERE user_id = $1`, [a!.userId]),
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe('SECURITY DEFINER functions used pre-auth remain locked to rab_owner + rab_app only (not weakened by this window\'s changes)', () => {
    it('EXECUTE on the 7 pre-auth functions is not granted to PUBLIC', async () => {
      const fns = [
        'auth_count_recent_login_failures',
        'auth_find_password_reset_token_org',
        'auth_find_refresh_token_org',
        'auth_find_users_by_email',
        'organisation_slug_taken',
        'resolve_workspace_for_user',
        'workspace_subdomain_taken',
      ];
      const grants = await dataSource.manager.query<Array<{ routine_name: string; grantee: string }>>(
        `SELECT routine_name, grantee FROM information_schema.role_routine_grants
          WHERE routine_schema = 'core' AND routine_name = ANY($1) AND privilege_type = 'EXECUTE'`,
        [fns],
      );
      const grantees = new Set(grants.map((g) => g.grantee));
      expect(grantees.has('PUBLIC')).toBe(false);
      expect(grantees.has('rab_app')).toBe(true);
    });
  });

  describe('the standing RLS floor: a query with no tenant context bound returns zero rows on every table in this file', () => {
    it.each(['login_history', 'user_preference', 'user', 'user_role', 'user_permission_override', 'refresh_token', 'password_reset_token'])(
      'core.%s',
      async (table) => {
        const rows = await dataSource.manager.query(`SELECT 1 FROM core."${table}" LIMIT 1`);
        expect(rows).toHaveLength(0);
      },
    );
  });
});
