import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { RefreshTokenService } from '../../engine/core-modules/auth/token/services/refresh-token.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { Organisation } from '../../modules/identity/entities';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * P1B (FULL-ARCHITECTURE-UPGRADE-PLAN.md — P1 program, checkpoint B): `core.user_session`, the
 * first-class session aggregate. Real Postgres, real RLS, real HTTP through the actual
 * AuthController/ProfileController — no mocks. Proves exactly the P1B exit-gate items.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(60_000);

describeIfDb('core.user_session correctness (P1B)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let refreshTokenService: RefreshTokenService;
  let factory: TestIdentityFactory;

  const http = () => request(app.getHttpServer());
  const authed = (token: string) => http().get('/rest/v1/auth/me').set('Authorization', `Bearer ${token}`);
  // x-client-platform: mobile is required so the server returns `refreshToken` in the JSON body
  // (a "web" caller instead gets it ONLY via an HttpOnly Set-Cookie, which a fresh `request(...)`
  // call per helper invocation — this file's own pattern, matching every other integration spec
  // in this directory — never carries forward) and so later /auth/refresh calls derive an
  // `undefined` requestedTarget instead of defaulting to 'manager_web'.
  const loginRaw = (email: string, password: string, applicationTarget?: string) =>
    http().post('/rest/v1/auth/login').set('x-client-platform', 'mobile').send({ email, password, applicationTarget });
  const refreshWith = (token: string) => http().post('/rest/v1/auth/refresh').set('x-client-platform', 'mobile').send({ refreshToken: token });
  const logoutWith = (accessToken: string, refreshToken: string) =>
    http().post('/rest/v1/auth/logout').set('Authorization', `Bearer ${accessToken}`).set('x-client-platform', 'mobile').send({ refreshToken });
  const listSessions = (accessToken: string) => http().get('/rest/v1/profile/sessions').set('Authorization', `Bearer ${accessToken}`);
  const revokeSession = (accessToken: string, sessionId: string) =>
    http().delete(`/rest/v1/profile/sessions/${sessionId}`).set('Authorization', `Bearer ${accessToken}`);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    refreshTokenService = moduleRef.get(RefreshTokenService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  let org: Organisation;
  let managerA: TestIdentity;
  let staffA: TestIdentity;
  let staffB: TestIdentity;

  beforeAll(async () => {
    org = await factory.createOrganisation('p1b-user-session');
    managerA = await factory.createInternalManager(org);
    staffA = await factory.createStaff(org, { owner: managerA });
    staffB = await factory.createStaff(org, { owner: managerA });
  });

  function decodeSid(accessToken: string): string {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return payload.sid as string;
  }

  /**
   * `core.user_session` is FORCE RLS — even the `rab_owner`-connected `adminDataSource` sees
   * zero rows with no bound context (FORCE binds the table owner too). Every read/test-setup
   * write below binds `rab.organisation_id`/`rab.user_id` to the ROW'S OWN expected owner first,
   * in the same transaction, exactly the technique `UserSessionBackfillService`'s own per-family
   * writes use — never a bypass, just correctly satisfying `user_session_self`'s USING/WITH CHECK.
   */
  async function withUserContext<T>(userId: string, fn: (manager: import('typeorm').EntityManager) => Promise<T>): Promise<T> {
    return adminDataSource.transaction(async (manager) => {
      await manager.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true)`, [org.id, userId]);
      return fn(manager);
    });
  }

  async function userSessionRow(userId: string, id: string): Promise<Record<string, unknown> | undefined> {
    return withUserContext(userId, async (manager) => {
      const [row] = await manager.query(`SELECT * FROM core.user_session WHERE id = $1`, [id]);
      return row;
    });
  }

  /**
   * P1B.1 (item 1 — column authority): the REAL runtime role (`rab_app`, `dataSource`, not the
   * owner-connected `adminDataSource`/`withUserContext` above), with GUCs correctly bound to the
   * row's own owner — isolating "does the GRANT/trigger layer block this" from "is this row even
   * visible," which `withUserContext`'s owner connection could never answer (the table owner is
   * exempt from column-level privilege checks entirely).
   */
  async function asRabApp<T>(userId: string, fn: (manager: import('typeorm').EntityManager) => Promise<T>): Promise<T> {
    return dataSource.transaction(async (manager) => {
      await manager.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true)`, [org.id, userId]);
      return fn(manager);
    });
  }

  async function refreshTokenRow(familyId: string): Promise<Record<string, unknown> | undefined> {
    const [row] = await adminDataSource.query(
      `SELECT * FROM core.refresh_token WHERE family_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [familyId],
    );
    return row;
  }

  // ================================================================================================ CREATION
  describe('session creation', () => {
    it('1: login creates exactly one core.user_session row whose id equals the JWT sid and the refresh family id', async () => {
      const res = await loginRaw(managerA.email, managerA.password, 'manager_web').expect(200);
      const sid = decodeSid(res.body.accessToken);
      const refreshFamily = (await refreshTokenRow(sid))!.family_id as string;
      expect(refreshFamily).toBe(sid);

      const session = await userSessionRow(managerA.userId, sid);
      expect(session).toBeDefined();
      expect(session!.id).toBe(sid);
      expect(session!.user_id).toBe(managerA.userId);
      expect(session!.application_target).toBe('manager_web');
      expect(session!.revoked_at).toBeNull();
    });

    it('2: a second login (different user) creates a DIFFERENT session UUID', async () => {
      const resA = await loginRaw(managerA.email, managerA.password, 'manager_web').expect(200);
      const resB = await loginRaw(staffB.email, staffB.password, 'staff_app').expect(200);
      expect(decodeSid(resA.body.accessToken)).not.toBe(decodeSid(resB.body.accessToken));
    });

    it('3: absolute_expires_at is copied from the refresh family\'s own family_expires_at, not independently computed', async () => {
      const res = await loginRaw(managerA.email, managerA.password, 'manager_web').expect(200);
      const sid = decodeSid(res.body.accessToken);
      const session = await userSessionRow(managerA.userId, sid);
      const token = await refreshTokenRow(sid);
      expect(new Date(session!.absolute_expires_at as string).getTime()).toBe(new Date(token!.family_expires_at as string).getTime());
    });

    it('4: manager_web session absolute deadline is <=24h; eligible staff_app session is <=90d', async () => {
      const mgr = await loginRaw(managerA.email, managerA.password, 'manager_web').expect(200);
      const stf = await loginRaw(staffA.email, staffA.password, 'staff_app').expect(200);
      const mgrSession = await userSessionRow(managerA.userId, decodeSid(mgr.body.accessToken));
      const stfSession = await userSessionRow(staffA.userId, decodeSid(stf.body.accessToken));
      const mgrHours = (new Date(mgrSession!.absolute_expires_at as string).getTime() - new Date(mgrSession!.created_at as string).getTime()) / (60 * 60 * 1000);
      const stfDays = (new Date(stfSession!.absolute_expires_at as string).getTime() - new Date(stfSession!.created_at as string).getTime()) / (24 * 60 * 60 * 1000);
      expect(mgrHours).toBeLessThanOrEqual(24.01);
      expect(stfDays).toBeLessThanOrEqual(90.01);
    });
  });

  // ================================================================================================ ROTATION
  describe('refresh rotation', () => {
    it('5: three successive refreshes keep the SAME user_session id — no new row is ever created', async () => {
      const login = await loginRaw(staffA.email, staffA.password, 'staff_app').expect(200);
      const sid = decodeSid(login.body.accessToken);
      let refreshToken = login.body.refreshToken as string;
      for (let i = 0; i < 3; i++) {
        const res = await refreshWith(refreshToken).expect(200);
        expect(decodeSid(res.body.accessToken)).toBe(sid);
        refreshToken = res.body.refreshToken;
      }
      // id is the PRIMARY KEY — a second row for the same session is structurally impossible;
      // this confirms the ORIGINAL row still exists (and so was never replaced) after 3 rotations.
      const session = await userSessionRow(staffA.userId, sid);
      expect(session).toBeDefined();
      expect(session!.id).toBe(sid);
    });

    it('6: refresh-token reuse revokes the stable user_session (not merely the one rotated token)', async () => {
      const login = await loginRaw(staffA.email, staffA.password, 'staff_app').expect(200);
      const sid = decodeSid(login.body.accessToken);
      const first = login.body.refreshToken as string;
      await refreshWith(first).expect(200); // legitimate rotation
      await refreshWith(first); // reuse — revokes the whole family/session

      const session = await userSessionRow(staffA.userId, sid);
      expect(session!.revoked_at).not.toBeNull();
      expect(session!.revoked_reason).toBe('reuse_detected');
    });
  });

  // ================================================================================================ LOGOUT
  describe('logout', () => {
    it('7: logout revokes the current user_session with reason=logout, and the refresh family together', async () => {
      const login = await loginRaw(staffA.email, staffA.password, 'staff_app').expect(200);
      const sid = decodeSid(login.body.accessToken);
      await logoutWith(login.body.accessToken, login.body.refreshToken).expect(204);

      const session = await userSessionRow(staffA.userId, sid);
      const token = await refreshTokenRow(sid);
      expect(session!.revoked_at).not.toBeNull();
      expect(session!.revoked_reason).toBe('logout');
      expect(token!.revoked_at).not.toBeNull();
    });

    it('8: A cannot logout B\'s session by presenting B\'s refresh token — B\'s user_session stays untouched', async () => {
      const loginA = await loginRaw(managerA.email, managerA.password, 'manager_web').expect(200);
      const loginB = await loginRaw(staffB.email, staffB.password, 'staff_app').expect(200);
      const sidB = decodeSid(loginB.body.accessToken);

      // A's own access token, B's refresh token.
      const res = await logoutWith(loginA.body.accessToken, loginB.body.refreshToken);
      expect(res.status).toBe(401);

      const sessionB = await userSessionRow(staffB.userId, sidB);
      expect(sessionB!.revoked_at).toBeNull();
    });
  });

  // ================================================================================================ DEVICE LIST / REVOCATION
  describe('device/session list and revocation', () => {
    it('9: self sees own sessions; current session is identified from the verified JWT sid, never a client value', async () => {
      const login = await loginRaw(staffA.email, staffA.password, 'staff_app').expect(200);
      const sid = decodeSid(login.body.accessToken);
      const res = await listSessions(login.body.accessToken).expect(200);
      const mine = res.body.find((s: { familyId: string }) => s.familyId === sid);
      expect(mine).toBeDefined();
      expect(mine.isCurrentDevice).toBe(true);
    });

    it('10: A never sees B\'s sessions in their own list', async () => {
      const loginA = await loginRaw(managerA.email, managerA.password, 'manager_web').expect(200);
      const loginB = await loginRaw(staffB.email, staffB.password, 'staff_app').expect(200);
      const sidB = decodeSid(loginB.body.accessToken);
      const res = await listSessions(loginA.body.accessToken).expect(200);
      expect(res.body.some((s: { familyId: string }) => s.familyId === sidB)).toBe(false);
    });

    it('11: revoke one other device revokes both tables; revoking the CURRENT session is forbidden and leaves it untouched', async () => {
      const first = await loginRaw(staffA.email, staffA.password, 'staff_app').expect(200);
      const second = await loginRaw(staffA.email, staffA.password, 'staff_app').expect(200);
      const firstSid = decodeSid(first.body.accessToken);
      const secondSid = decodeSid(second.body.accessToken);

      // From the SECOND session, revoke the FIRST (an "other device").
      await revokeSession(second.body.accessToken, firstSid).expect(204);
      const firstSession = await userSessionRow(staffA.userId, firstSid);
      expect(firstSession!.revoked_at).not.toBeNull();
      expect(firstSession!.revoked_reason).toBe('revoked_by_user');

      // Attempting to revoke the CURRENT (second) session via this endpoint is forbidden.
      const forbidden = await revokeSession(second.body.accessToken, secondSid);
      expect(forbidden.status).toBe(403);
      const secondSession = await userSessionRow(staffA.userId, secondSid);
      expect(secondSession!.revoked_at).toBeNull();
    });

    it('12: A cannot revoke B\'s session (cross-user IDOR denied, 404 not 403 — out of scope, never confirmed to exist)', async () => {
      const loginA = await loginRaw(managerA.email, managerA.password, 'manager_web').expect(200);
      const loginB = await loginRaw(staffB.email, staffB.password, 'staff_app').expect(200);
      const sidB = decodeSid(loginB.body.accessToken);
      const res = await revokeSession(loginA.body.accessToken, sidB);
      expect(res.status).toBe(404);
      const sessionB = await userSessionRow(staffB.userId, sidB);
      expect(sessionB!.revoked_at).toBeNull();
    });

    it('13: an invalid (non-existent) session id is rejected 404, never a 500', async () => {
      const login = await loginRaw(managerA.email, managerA.password, 'manager_web').expect(200);
      const res = await revokeSession(login.body.accessToken, '00000000-0000-0000-0000-000000000000');
      expect(res.status).toBe(404);
    });
  });

  // ================================================================================================ PASSWORD-DRIVEN REVOCATION
  describe('password reset/change revocation', () => {
    it('14: completing a forced password reset (setPassword) revokes the matching user_session with reason=password_changed', async () => {
      // setPassword() is the forced must-reset-password completion path — force the flag
      // directly (core.user is NOT FORCE RLS — the pre-auth allowlist — so the owner connection
      // can set it with no bound context) rather than assuming the factory's own fixture shape.
      const fresh = await factory.createStaff(org, { owner: managerA });
      await adminDataSource.query(`UPDATE core."user" SET must_reset_password = true WHERE id = $1`, [fresh.userId]);
      const login = await loginRaw(fresh.email, fresh.password, 'staff_app').expect(200);
      const sid = decodeSid(login.body.accessToken);
      expect(login.body.mustResetPassword).toBe(true);

      await http()
        .post('/rest/v1/auth/set-password')
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .send({ newPassword: 'Str0ng!NewPassword#2026' })
        .expect(204);

      const session = await userSessionRow(fresh.userId, sid);
      expect(session!.revoked_at).not.toBeNull();
      expect(session!.revoked_reason).toBe('password_changed');
    });
  });

  // ================================================================================================ LAST SEEN
  describe('last_seen_at throttling', () => {
    it('15: a stale last_seen_at (>5 minutes) is bumped by the next authenticated request', async () => {
      const login = await loginRaw(managerA.email, managerA.password, 'manager_web').expect(200);
      const sid = decodeSid(login.body.accessToken);
      await withUserContext(managerA.userId, (manager) =>
        manager.query(`UPDATE core.user_session SET last_seen_at = now() - interval '10 minutes' WHERE id = $1`, [sid]),
      );
      const before = (await userSessionRow(managerA.userId, sid))!.last_seen_at as string;

      await authed(login.body.accessToken).expect(200);
      const after = (await userSessionRow(managerA.userId, sid))!.last_seen_at as string;
      expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
    });

    it('16: a recent last_seen_at (<5 minutes) is NOT rewritten by the next authenticated request', async () => {
      const login = await loginRaw(managerA.email, managerA.password, 'manager_web').expect(200);
      const sid = decodeSid(login.body.accessToken);
      const recent = new Date(Date.now() - 60_000); // 1 minute ago — well inside the 5-minute threshold
      await withUserContext(managerA.userId, (manager) =>
        manager.query(`UPDATE core.user_session SET last_seen_at = $2 WHERE id = $1`, [sid, recent]),
      );

      await authed(login.body.accessToken).expect(200);
      const after = (await userSessionRow(managerA.userId, sid))!.last_seen_at as string;
      expect(new Date(after).getTime()).toBe(recent.getTime());
    });

    it('17: concurrent authenticated requests never regress last_seen_at (monotonic, no lost-update)', async () => {
      const login = await loginRaw(staffA.email, staffA.password, 'staff_app').expect(200);
      const sid = decodeSid(login.body.accessToken);
      await withUserContext(staffA.userId, (manager) =>
        manager.query(`UPDATE core.user_session SET last_seen_at = now() - interval '10 minutes' WHERE id = $1`, [sid]),
      );
      await Promise.all(Array.from({ length: 5 }, () => authed(login.body.accessToken)));
      const after = (await userSessionRow(staffA.userId, sid))!.last_seen_at as string;
      expect(new Date(after).getTime()).toBeGreaterThan(Date.now() - 60_000);
    });
  });

  // ================================================================================================ RLS
  describe('RLS', () => {
    it('18: a query with no tenant context bound returns zero rows from core.user_session', async () => {
      const login = await loginRaw(managerA.email, managerA.password, 'manager_web').expect(200);
      const sid = decodeSid(login.body.accessToken);
      // dataSource is rab_app with no bound context (no transaction/set_config in this call).
      const rows = await dataSource.query(`SELECT 1 FROM core.user_session WHERE id = $1`, [sid]);
      expect(rows).toHaveLength(0);
    });

    it('19: rab_app cannot write an arbitrary cross-user row (WITH CHECK fails outside the correct bound identity)', async () => {
      const login = await loginRaw(managerA.email, managerA.password, 'manager_web').expect(200);
      await expect(
        dataSource.query(
          `INSERT INTO core.user_session (id, organisation_id, user_id, application_target, absolute_expires_at)
           VALUES (gen_random_uuid(), $1, $2, 'manager_web', now() + interval '1 day')`,
          [org.id, managerA.userId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  // ================================================================================================ P1B.1 COLUMN AUTHORITY (item 1)
  describe('P1B.1 — column authority: rab_app cannot arbitrarily mutate sensitive columns', () => {
    it('20: rab_app cannot directly change absolute_expires_at, even on its own correctly-bound row', async () => {
      const login = await loginRaw(managerA.email, managerA.password, 'manager_web').expect(200);
      const sid = decodeSid(login.body.accessToken);
      await expect(
        asRabApp(managerA.userId, (manager) =>
          manager.query(`UPDATE core.user_session SET absolute_expires_at = now() + interval '100 days' WHERE id = $1`, [sid]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('21: rab_app cannot change a session\'s user_id or organisation_id', async () => {
      const login = await loginRaw(staffA.email, staffA.password, 'staff_app').expect(200);
      const sid = decodeSid(login.body.accessToken);
      await expect(
        asRabApp(staffA.userId, (manager) => manager.query(`UPDATE core.user_session SET user_id = $2 WHERE id = $1`, [sid, staffB.userId])),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        asRabApp(staffA.userId, (manager) => manager.query(`UPDATE core.user_session SET organisation_id = $2 WHERE id = $1`, [sid, org.id])),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('22: rab_app cannot set security_version to an arbitrary absolute value (column is granted, the trigger still rejects it)', async () => {
      const login = await loginRaw(managerA.email, managerA.password, 'manager_web').expect(200);
      const sid = decodeSid(login.body.accessToken);
      await expect(
        asRabApp(managerA.userId, (manager) => manager.query(`UPDATE core.user_session SET security_version = 999 WHERE id = $1`, [sid])),
      ).rejects.toThrow(/may only move by exactly \+1/);
    });

    it('23: rab_app cannot jump security_version by more than +1 in one statement', async () => {
      const login = await loginRaw(staffA.email, staffA.password, 'staff_app').expect(200);
      const sid = decodeSid(login.body.accessToken);
      await expect(
        asRabApp(staffA.userId, (manager) => manager.query(`UPDATE core.user_session SET security_version = security_version + 2 WHERE id = $1`, [sid])),
      ).rejects.toThrow(/may only move by exactly \+1/);
    });

    it('24: rab_app cannot bump security_version by +1 WITHOUT an accompanying revocation transition', async () => {
      const login = await loginRaw(managerA.email, managerA.password, 'manager_web').expect(200);
      const sid = decodeSid(login.body.accessToken);
      await expect(
        asRabApp(managerA.userId, (manager) => manager.query(`UPDATE core.user_session SET security_version = security_version + 1 WHERE id = $1`, [sid])),
      ).rejects.toThrow(/alongside a revocation transition/);
    });

    it('25: rab_app cannot re-revoke or change the reason of an already-revoked session (revocation is immutable once set)', async () => {
      const login = await loginRaw(staffA.email, staffA.password, 'staff_app').expect(200);
      const sid = decodeSid(login.body.accessToken);
      await logoutWith(login.body.accessToken, login.body.refreshToken).expect(204);
      await expect(
        asRabApp(staffA.userId, (manager) =>
          manager.query(`UPDATE core.user_session SET revoked_reason = 'tampered' WHERE id = $1`, [sid]),
        ),
      ).rejects.toThrow(/revoked_reason is immutable/);
    });

    it('26: the legitimate revoke path (exactly what revokeFamily/revokeAllForUser issue) is still accepted by the trigger', async () => {
      const login = await loginRaw(staffA.email, staffA.password, 'staff_app').expect(200);
      const sid = decodeSid(login.body.accessToken);
      await asRabApp(staffA.userId, (manager) =>
        manager.query(
          `UPDATE core.user_session SET revoked_at = now(), revoked_reason = $2, security_version = security_version + 1 WHERE id = $1 AND revoked_at IS NULL`,
          [sid, 'test_direct_legitimate'],
        ),
      );
      const session = await userSessionRow(staffA.userId, sid);
      expect(session!.revoked_at).not.toBeNull();
      // Raw SQL (manager.query), not the entity's own bigintAsNumber transformer — pg returns bigint as a string.
      expect(Number(session!.security_version)).toBe(2);
    });

    it('27: legitimate last_seen_at writes are unaffected by the column-privilege tightening', async () => {
      const login = await loginRaw(managerA.email, managerA.password, 'manager_web').expect(200);
      const sid = decodeSid(login.body.accessToken);
      await asRabApp(managerA.userId, (manager) => manager.query(`UPDATE core.user_session SET last_seen_at = now() WHERE id = $1`, [sid]));
      const session = await userSessionRow(managerA.userId, sid);
      expect(session!.last_seen_at).toBeDefined();
    });

    it("28: a real, confirmed bug this hardening pass also fixed — admin-triggered revokeAllForUser (account suspension/admin password reset/account deletion, always run under the ACTOR's own tenant context, never the TARGET's) now correctly revokes the TARGET's user_session, not just their refresh_token", async () => {
      const target = await factory.createStaff(org, { owner: managerA });
      const login = await loginRaw(target.email, target.password, 'staff_app').expect(200);
      const sid = decodeSid(login.body.accessToken);

      // managerA (the actor) revokes target's (a DIFFERENT user's) sessions — exactly the shape of
      // ManagerService.setActive / StaffService's suspend path / AccountLifecycleService
      // .adminResetPassword / UserDeletionService.deleteUser, all of which bind GUCs to the ACTOR,
      // not the target. Before this migration's RLS fix, user_session_self's `user_id =
      // current_uid()` silently matched zero rows here — the refresh_token side still worked
      // (organisation-scoped RLS), leaving a contradictory "UserSession active, RefreshToken
      // revoked" state forbidden by the P1B brief.
      await tenantContext.runInTenantContext({ organisationId: org.id, workspaceId: null, userId: managerA.userId, role: '' }, (manager) =>
        refreshTokenService.revokeAllForUser(manager, target.userId, 'account_suspended'),
      );

      const session = await userSessionRow(target.userId, sid);
      expect(session!.revoked_at).not.toBeNull();
      expect(session!.revoked_reason).toBe('account_suspended');
      const token = await refreshTokenRow(sid);
      expect(token!.revoked_at).not.toBeNull();
    });
  });
});
