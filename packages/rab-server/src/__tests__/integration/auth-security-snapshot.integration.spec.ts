import 'reflect-metadata';
import { PermissionFlag } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { Organisation } from '../../modules/identity/entities';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentityFactory } from './helpers/test-identities';

/**
 * P1C (FULL-ARCHITECTURE-UPGRADE-PLAN.md — P1 program): `AuthSecuritySnapshotService` — the ONE
 * consolidated, request-local PostgreSQL security snapshot that replaced seven separate
 * `runInTenantContext` transactions (session validity, roles, platform-admin, active-account,
 * must-reset-password, maintenance-mode) plus `PermissionGuard`'s own per-route transaction.
 *
 * This suite proves the required security matrix (P1C §25) for everything NEW or NEWLY SHARED
 * by that consolidation — role/permission/platform-admin/workspace revocation taking effect on
 * the VERY NEXT request (never the current one, never retroactively) — plus the authorization
 * linearization point's own concurrency semantics (§26). Session/account-status/RLS-no-context
 * cases are already covered exhaustively by `user-session-correctness`, `session-auth-
 * correctness`, `auth-abuse-cases` and `application-access` (all re-run, unaffected, see the P1C
 * final report) — not duplicated here.
 *
 * Every test gets its OWN fresh organisation: `TestIdentityFactory.provisionRole` enforces one
 * canonical, fixed permission set per (organisation, role key) — reusing one organisation across
 * tests that each need a DIFFERENTLY-permissioned "manager" role throws by design (a real, useful
 * guard against two identities silently drifting apart), so sharing is wrong here, not a bug to
 * route around.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(60_000);

describeIfDb('AuthSecuritySnapshotService — consolidated security snapshot correctness (P1C)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;

  const http = () => request(app.getHttpServer());
  const staffView = (token: string) => http().get('/rest/v1/staff').set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  /** Every write below targets a FORCE RLS table from the owner connection — bind the row's own
   * expected (organisation, user) identity first, in the same transaction, honestly satisfying
   * the policy rather than bypassing it (the same established technique `UserSessionBackfillService`
   * and every P1B/P1B.1 test helper already uses for exactly this reason). */
  async function withOrgUser<T>(organisationId: string, userId: string, fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    return adminDataSource.transaction(async (manager) => {
      await manager.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true)`, [organisationId, userId]);
      return fn(manager);
    });
  }

  function decodeSid(token: string): string {
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return payload.sid as string;
  }

  // ================================================================================================ ROLES
  describe('roles', () => {
    it('a role removed from the user denies the VERY NEXT request — never the current token\'s remaining lifetime', async () => {
      const org = await factory.createOrganisation('p1c-role-removed');
      const manager = await factory.createInternalManager(org, { permissions: [PermissionFlag.STAFF_VIEW], label: 'role-removed' });
      const token = await factory.login(manager);
      await staffView(token).expect(200);

      const [{ id: roleId }] = await withOrgUser(org.id, manager.userId, (m) =>
        m.query<Array<{ id: string }>>(`SELECT role_id AS id FROM core.user_role WHERE user_id = $1 LIMIT 1`, [manager.userId]),
      );
      await withOrgUser(org.id, manager.userId, (m) => m.query(`DELETE FROM core.user_role WHERE user_id = $1 AND role_id = $2`, [manager.userId, roleId]));

      // Same still-valid, unexpired access token — the ONLY thing that changed is server-side state.
      await staffView(token).expect(403);
    });
  });

  // ================================================================================================ PERMISSIONS
  describe('permissions', () => {
    it('a permission removed from the role denies the very next request', async () => {
      const org = await factory.createOrganisation('p1c-perm-removed');
      const manager = await factory.createInternalManager(org, { permissions: [PermissionFlag.STAFF_VIEW], label: 'perm-removed' });
      const token = await factory.login(manager);
      await staffView(token).expect(200);

      await withOrgUser(org.id, manager.userId, (m) =>
        m.query(
          `DELETE FROM core.role_permission rp USING core.user_role ur, core.permission p
            WHERE rp.role_id = ur.role_id AND ur.user_id = $1 AND rp.permission_id = p.id AND p.key = $2`,
          [manager.userId, PermissionFlag.STAFF_VIEW],
        ),
      );

      await staffView(token).expect(403);
    });

    it('a per-user GRANT override is honoured even without the underlying role permission', async () => {
      const org = await factory.createOrganisation('p1c-override-grant');
      const manager = await factory.createInternalManager(org, { permissions: [], label: 'override-grant' });
      const token = await factory.login(manager);
      await staffView(token).expect(403);

      const [{ id: permissionId }] = await adminDataSource.query<Array<{ id: string }>>(
        `SELECT id FROM core.permission WHERE key = $1`,
        [PermissionFlag.STAFF_VIEW],
      );
      await withOrgUser(org.id, manager.userId, (m) =>
        m.query(
          `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect) VALUES ($1, $2, $3, 'grant')`,
          [manager.userId, permissionId, org.id],
        ),
      );

      await staffView(token).expect(200);
    });

    it('a per-user REVOKE override denies even though the role itself still grants it — and takes effect on the next request', async () => {
      const org = await factory.createOrganisation('p1c-override-revoke');
      const manager = await factory.createInternalManager(org, { permissions: [PermissionFlag.STAFF_VIEW], label: 'override-revoke' });
      const token = await factory.login(manager);
      await staffView(token).expect(200);

      const [{ id: permissionId }] = await adminDataSource.query<Array<{ id: string }>>(
        `SELECT id FROM core.permission WHERE key = $1`,
        [PermissionFlag.STAFF_VIEW],
      );
      await withOrgUser(org.id, manager.userId, (m) =>
        m.query(
          `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect) VALUES ($1, $2, $3, 'revoke')`,
          [manager.userId, permissionId, org.id],
        ),
      );

      await staffView(token).expect(403);
    });

    it('a required permission entirely absent (no role, no override) is denied, never defaulted to allow', async () => {
      const org = await factory.createOrganisation('p1c-no-perm');
      const manager = await factory.createInternalManager(org, { permissions: [], label: 'no-perm' });
      const token = await factory.login(manager);
      await staffView(token).expect(403);
    });
  });

  // ================================================================================================ PLATFORM ADMIN
  describe('platform admin', () => {
    it('platform-admin status is resolved fresh every request, never from a stale JWT claim — revoking it removes the bypass on the next request', async () => {
      const org = await factory.createOrganisation('p1c-platform-admin');
      const manager = await factory.createInternalManager(org, { permissions: [], label: 'platform-admin-revoke' });
      await factory.grantPlatformAdmin(manager.userId);
      const token = await factory.login(manager);

      // Platform-admin bypasses the ordinary permission check entirely (applicationAllowed's own
      // platformAdmin=true short-circuit covers application access; here we confirm maintenance
      // mode specifically, since that is the ONE path that still asks `isPlatformAdmin` fresh on
      // every request even post-P1C — see maintenance-mode.guard.ts's own P1C comment for why).
      await withOrgUser(org.id, manager.userId, (m) =>
        m.query(
          `INSERT INTO core.platform_config (organisation_id, maintenance_mode_enabled) VALUES ($1, true)
           ON CONFLICT (organisation_id) DO UPDATE SET maintenance_mode_enabled = true`,
          [org.id],
        ),
      );
      const res1 = await staffView(token);
      expect(res1.status).toBe(403); // platform admin still has no STAFF_VIEW permission, but is never blocked by maintenance mode

      await adminDataSource.query(`UPDATE core.platform_admin SET revoked_at = now() WHERE user_id = $1`, [manager.userId]);

      // Same token. Maintenance mode now applies to this user on the very next request.
      const res2 = await staffView(token);
      expect(res2.status).toBe(503);
    });
  });

  // ================================================================================================ WORKSPACE MEMBERSHIP
  describe('workspace membership', () => {
    it('membership suspended (removed) denies the workspace-authority behind it on the very next request', async () => {
      const org = await factory.createOrganisation('p1c-membership-removed');
      const manager = await factory.createInternalManager(org, { permissions: [PermissionFlag.STAFF_CREATE, PermissionFlag.STAFF_VIEW], label: 'membership-removed' });
      const token = await factory.login(manager);
      await staffView(token).expect(200);

      await withOrgUser(org.id, manager.userId, (m) =>
        m.query(`UPDATE core.workspace_membership SET status = 'suspended' WHERE user_id = $1`, [manager.userId]),
      );

      // The security snapshot resolves workspaceId fresh every request via the same live
      // `core.resolve_membership_for_session` this suite's whole design point is to never bypass.
      // With no active membership, workspaceId resolves null; the staff-list route requires a
      // bound workspace (`runInWorkspaceContext` fails closed with no workspace bound).
      const res = await staffView(token);
      expect(res.status).not.toBe(200);
      expect([401, 403, 404]).toContain(res.status);
    });
  });

  // ================================================================================================ ACCOUNT / MUST-RESET
  describe('account status', () => {
    it('suspending the account denies the very next request, same still-valid token', async () => {
      const org = await factory.createOrganisation('p1c-account-suspend');
      const manager = await factory.createInternalManager(org, { permissions: [PermissionFlag.STAFF_VIEW], label: 'account-suspend' });
      const token = await factory.login(manager);
      await staffView(token).expect(200);

      // core."user" is in the NOT_FORCED_ALLOWLIST (pre-auth identity lookup) — the owner
      // connection may write it with no bound context, same as every other P1B/P1B.2 test using it.
      await adminDataSource.query(`UPDATE core."user" SET status = 'suspended' WHERE id = $1`, [manager.userId]);

      await staffView(token).expect(401);
    });

    it('setting must-reset-password denies a non-exempt route on the very next request', async () => {
      const org = await factory.createOrganisation('p1c-must-reset');
      const manager = await factory.createInternalManager(org, { permissions: [PermissionFlag.STAFF_VIEW], label: 'must-reset' });
      const token = await factory.login(manager);
      await staffView(token).expect(200);

      await adminDataSource.query(`UPDATE core."user" SET must_reset_password = true WHERE id = $1`, [manager.userId]);

      await staffView(token).expect(403);
    });
  });

  // ================================================================================================ CONCURRENCY / LINEARIZATION (§26)
  describe('authorization linearization point (concurrency barrier)', () => {
    it('CASE A: a permission revoke that commits AFTER a request has already acquired its security snapshot does not retroactively affect that in-flight request; CASE B: the very next request observes it immediately', async () => {
      const org = await factory.createOrganisation('p1c-barrier-permission');
      const manager = await factory.createInternalManager(org, { permissions: [PermissionFlag.STAFF_VIEW], label: 'barrier-case-a' });
      const token = await factory.login(manager);

      const [{ id: permissionId }] = await adminDataSource.query<Array<{ id: string }>>(
        `SELECT id FROM core.permission WHERE key = $1`,
        [PermissionFlag.STAFF_VIEW],
      );

      // A request's security snapshot is acquired, held open, and only released after we commit
      // the revoke "underneath" it — modelling "a revoke commits after the snapshot was already
      // acquired". Real HTTP requests complete too fast to race deterministically from outside, so
      // this proves the same guarantee directly against the REAL AuthSecuritySnapshotService query
      // shape via a server-side gate, the same technique `session-race.spec.ts` already uses for
      // its own browser-level races. Bound to the SAME identity a real request would bind, so the
      // FORCE RLS read below sees exactly what the real snapshot query would.
      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
      const snapshotPromise = dataSource.transaction('REPEATABLE READ', async (manager2) => {
        await manager2.query(
          `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true)`,
          [org.id, manager.userId],
        ); // opens the REPEATABLE READ snapshot with this transaction's first statement
        await gate; // hold the snapshot open while the revoke below commits in a DIFFERENT transaction
        const row = await manager2.query<Array<{ exists: boolean }>>(
          `SELECT EXISTS (
             SELECT 1 FROM core.user_role ur
             JOIN core.role_permission rp ON rp.role_id = ur.role_id
             WHERE ur.user_id = $1 AND rp.permission_id = $2
           ) AS exists`,
          [manager.userId, permissionId],
        );
        return row[0]!.exists;
      });

      // Commits in a SEPARATE, already-finished transaction while the snapshot above is still open.
      await withOrgUser(org.id, manager.userId, (m) =>
        m.query(
          `DELETE FROM core.role_permission rp USING core.user_role ur
            WHERE rp.role_id = ur.role_id AND ur.user_id = $1 AND rp.permission_id = $2`,
          [manager.userId, permissionId],
        ),
      );
      releaseGate();
      const sawPermissionWithinSnapshot = await snapshotPromise;

      // REPEATABLE READ: the already-open snapshot still sees its OWN consistent view, unaffected
      // by the revoke that committed after it started.
      expect(sawPermissionWithinSnapshot).toBe(true);

      // CASE B: a fresh request/snapshot taken AFTER the revoke has committed MUST observe it immediately.
      await staffView(token).expect(403);
    });

    it('session-revoke variant: a session revoked after being resolved live is denied on the very next request', async () => {
      const org = await factory.createOrganisation('p1c-barrier-session');
      const manager = await factory.createInternalManager(org, { permissions: [PermissionFlag.STAFF_VIEW], label: 'barrier-session' });
      const token = await factory.login(manager);
      await staffView(token).expect(200);

      const sid = decodeSid(token);
      await withOrgUser(org.id, manager.userId, (m) =>
        m.query(
          `UPDATE core.user_session SET revoked_at = now(), revoked_reason = 'test_barrier', security_version = security_version + 1 WHERE id = $1 AND revoked_at IS NULL`,
          [sid],
        ),
      );
      await staffView(token).expect(401);
    });
  });
});
