import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Settings → Profile → Devices (2026-10-15). Real PostgreSQL with RLS; runs unchanged with both auth caches enabled.
 *  - The list shows exactly the sessions authentication would still accept (not revoked, not absolutely or idle-expired, live
 *    refresh family) — idle-expired sessions used to stay listed, so one browser looked like several devices.
 *  - A password login supersedes ONLY the session the same browser presented (owner decision; same rule as OAuth F11).
 *  - Revocation is self-scoped, never the current session by id, never during Admin Inspect (CF-02).
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const ORIGIN = 'http://localhost:5173';

describeIfDb('profile devices and active sessions (integration)', () => {
  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;

  const http = () => request(app.getHttpServer());
  type WebLogin = { session: string; refresh: string; sid: string };

  function cookieOf(res: request.Response, name: string): string | undefined {
    return ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`))?.split(';')[0]!.split('=')[1];
  }

  /** A real web (cookie) sign-in; `presented` simulates the same browser still holding a previous session cookie. */
  async function webLogin(identity: TestIdentity, presented?: string): Promise<WebLogin> {
    const req = http().post('/rest/v1/auth/login').set('Origin', ORIGIN);
    if (presented) req.set('Cookie', `crewflow_session=${presented}`);
    const res = await req.send({ email: identity.email, password: identity.password, applicationTarget: 'manager_web' });
    expect(res.status).toBe(200);
    const session = cookieOf(res, 'crewflow_session')!;
    const refresh = cookieOf(res, 'rab_rt')!;
    const me = await http().get('/rest/v1/auth/me').set({ Cookie: `crewflow_session=${session}`, Origin: ORIGIN });
    return { session, refresh, sid: me.body.sessionId };
  }

  const asCookie = (session: string) => ({ Cookie: `crewflow_session=${session}`, Origin: ORIGIN });
  const list = async (session: string) => (await http().get('/rest/v1/profile/sessions').set(asCookie(session))).body as Array<{ familyId: string; isCurrentDevice: boolean; ip: string | null; ipScope: string | null }>;
  const sessionRows = async (userId: string) => (await owner.query(`SELECT id, revoked_at, revoked_reason FROM core.user_session WHERE user_id = $1 ORDER BY created_at`, [userId])) as Array<{ id: string; revoked_at: Date | null; revoked_reason: string | null }>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource: owner,
      tenantContext: moduleRef.get(TenantContextService),
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
  });

  afterAll(async () => {
    await app?.close();
    await owner?.destroy();
  });

  it('1/10. one login creates exactly one session, listed as "this device" with an honest (private) client address', async () => {
    const user = await factory.createInternalManager(await factory.createOrganisation('dev1'), { permissions: 'production' });
    const login = await webLogin(user);
    expect((await sessionRows(user.userId)).length).toBe(1);
    const rows = await list(login.session);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ familyId: login.sid, isCurrentDevice: true });
    // The test client connects over loopback — shown as IPv4, flagged private, never as a public address.
    expect(rows[0]!.ip).toBe('127.0.0.1');
    expect(rows[0]!.ipScope).toBe('private');
  });

  it('3. refresh rotation never creates another session', async () => {
    const user = await factory.createInternalManager(await factory.createOrganisation('dev3'), { permissions: 'production' });
    const login = await webLogin(user);
    const refreshed = await http().post('/rest/v1/auth/refresh').set({ Cookie: `rab_rt=${login.refresh}`, Origin: ORIGIN }).send({});
    expect(refreshed.status).toBe(200);
    expect((await sessionRows(user.userId)).length).toBe(1);
    expect((await list(login.session)).map((r) => r.familyId)).toEqual([login.sid]);
  });

  it('2. re-login from the SAME browser supersedes only that browser\'s session; a login from another device keeps both', async () => {
    const user = await factory.createInternalManager(await factory.createOrganisation('dev2'), { permissions: 'production' });
    const first = await webLogin(user);
    const second = await webLogin(user, first.session); // same browser, still holding the first cookie
    const rowsAfterRelogin = await sessionRows(user.userId);
    expect(rowsAfterRelogin.find((r) => r.id === first.sid)).toMatchObject({ revoked_reason: 'superseded' });
    expect((await http().get('/rest/v1/auth/me').set(asCookie(first.session))).status).toBe(401);
    expect((await list(second.session)).map((r) => r.familyId)).toEqual([second.sid]);

    const otherDevice = await webLogin(user); // no cookie presented: a genuinely different browser
    const ids = (await list(otherDevice.session)).map((r) => r.familyId).sort();
    expect(ids).toEqual([second.sid, otherDevice.sid].sort());
  });

  it('4–8. the list hides revoked, absolutely expired, idle-expired and dead-family sessions, and keeps genuine others', async () => {
    const user = await factory.createInternalManager(await factory.createOrganisation('dev4'), { permissions: 'production' });
    const current = await webLogin(user);
    const [live, revoked, absolute, idle, deadFamily] = [await webLogin(user), await webLogin(user), await webLogin(user), await webLogin(user), await webLogin(user)];
    await owner.query(`UPDATE core.user_session SET revoked_at = now(), revoked_reason = 'test' WHERE id = $1`, [revoked.sid]);
    // absolute_expires_at is immutable after creation (guard trigger) — back-dated for this fixture only, triggers off for one statement.
    await owner.transaction(async (m) => {
      await m.query(`SET LOCAL session_replication_role = replica`);
      await m.query(`UPDATE core.user_session SET created_at = now() - interval '2 days', last_seen_at = now() - interval '2 days', idle_expires_at = NULL, absolute_expires_at = now() - interval '1 minute' WHERE id = $1`, [absolute.sid]);
      // Real absolute expiry ends the refresh family at the same instant (they are created together and are immutable).
      await m.query(`UPDATE core.refresh_token SET created_at = now() - interval '2 days', expires_at = now() - interval '1 minute', family_expires_at = now() - interval '1 minute' WHERE family_id = $1`, [absolute.sid]);
    });
    await owner.query(`UPDATE core.user_session SET idle_expires_at = now() - interval '1 minute' WHERE id = $1`, [idle.sid]);
    await owner.query(`UPDATE core.refresh_token SET revoked_at = now() WHERE family_id = $1`, [deadFamily.sid]);

    const rows = await list(current.session);
    expect(rows.map((r) => r.familyId).sort()).toEqual([current.sid, live.sid].sort());
    expect(rows.filter((r) => r.isCurrentDevice).map((r) => r.familyId)).toEqual([current.sid]);
    // The hidden ones really are unusable — the list now agrees with authentication.
    for (const dead of [revoked, absolute, idle, deadFamily]) {
      expect((await http().get('/rest/v1/auth/me').set(asCookie(dead.session))).status).toBe(401);
    }
  });

  it('5/9. revoking: another person\'s or another organisation\'s session id is 404; the current session by id is 403; an own other session goes', async () => {
    const orgA = await factory.createOrganisation('dev5a');
    const alice = await factory.createInternalManager(orgA, { permissions: 'production' });
    const bob = await factory.createInternalManager(orgA, { permissions: 'production' });
    const carol = await factory.createInternalManager(await factory.createOrganisation('dev5b'), { permissions: 'production' });
    const aliceMain = await webLogin(alice);
    const aliceOther = await webLogin(alice);
    const bobSession = await webLogin(bob);
    const carolSession = await webLogin(carol);

    for (const foreign of [bobSession.sid, carolSession.sid]) {
      expect((await http().delete(`/rest/v1/profile/sessions/${foreign}`).set(asCookie(aliceMain.session))).status).toBe(404);
    }
    expect((await http().get('/rest/v1/auth/me').set(asCookie(bobSession.session))).status).toBe(200);
    expect((await http().get('/rest/v1/auth/me').set(asCookie(carolSession.session))).status).toBe(200);
    expect((await http().delete(`/rest/v1/profile/sessions/${aliceMain.sid}`).set(asCookie(aliceMain.session))).status).toBe(403);
    expect((await http().delete(`/rest/v1/profile/sessions/${aliceOther.sid}`).set(asCookie(aliceMain.session))).status).toBe(204);
    expect((await http().get('/rest/v1/auth/me').set(asCookie(aliceOther.session))).status).toBe(401);
    // Listing is self-scoped: nobody else's sessions appear.
    expect((await list(aliceMain.session)).map((r) => r.familyId)).toEqual([aliceMain.sid]);
  });

  it('11/12. "log out other devices" keeps this one (count = visible others); "sign out everywhere" ends this one too', async () => {
    const user = await factory.createInternalManager(await factory.createOrganisation('dev11'), { permissions: 'production' });
    const current = await webLogin(user);
    const others = [await webLogin(user), await webLogin(user)];
    const stale = await webLogin(user);
    await owner.query(`UPDATE core.user_session SET idle_expires_at = now() - interval '1 minute' WHERE id = $1`, [stale.sid]);

    const res = await http().delete('/rest/v1/profile/sessions').set(asCookie(current.session));
    expect(res.status).toBe(200);
    expect(res.body.revokedCount).toBe(2);
    expect((await http().get('/rest/v1/auth/me').set(asCookie(current.session))).status).toBe(200);
    for (const o of others) expect((await http().get('/rest/v1/auth/me').set(asCookie(o.session))).status).toBe(401);

    const all = await http().post('/rest/v1/profile/sessions/logout-all').set(asCookie(current.session)).send({});
    expect(all.status).toBeLessThan(300);
    expect((await http().get('/rest/v1/auth/me').set(asCookie(current.session))).status).toBe(401);
    const rotated = await http().post('/rest/v1/auth/refresh').set({ Cookie: `rab_rt=${current.refresh}`, Origin: ORIGIN }).send({});
    expect(rotated.status).toBe(401);
  });

  it('CF-02. an administrator inspecting an account cannot revoke that person\'s sessions', async () => {
    const org = await factory.createOrganisation('dev-inspect');
    const admin = await factory.createInternalManager(org, { permissions: 'production', platformAdmin: true });
    const target = await factory.createInternalManager(org, { permissions: 'production' });
    const targetMain = await webLogin(target);
    const targetOther = await webLogin(target);
    const adminToken = await factory.login(admin);
    const started = await http().post(`/rest/v1/admin/inspect/${target.userId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(started.status).toBe(201);
    const inspect = { Authorization: `Bearer ${adminToken}`, 'x-inspect-session-id': started.body.sessionId as string };

    expect((await http().delete(`/rest/v1/profile/sessions/${targetOther.sid}`).set(inspect)).status).toBe(403);
    expect((await http().delete('/rest/v1/profile/sessions').set(inspect)).status).toBe(403);
    expect((await http().post('/rest/v1/profile/sessions/logout-all').set(inspect).send({})).status).toBe(403);
    for (const s of [targetMain, targetOther]) expect((await http().get('/rest/v1/auth/me').set(asCookie(s.session))).status).toBe(200);
    await http().post('/rest/v1/admin/inspect/end').set('Authorization', `Bearer ${adminToken}`);
  });
});
