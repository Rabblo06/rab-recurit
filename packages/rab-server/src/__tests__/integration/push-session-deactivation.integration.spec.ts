import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { RefreshTokenService } from '../../engine/core-modules/auth/token/services/refresh-token.service';
import { AccessTokenService } from '../../engine/core-modules/auth/token/services/access-token.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Phase C1b (D5, owner conditions) — push registrations end with the session that made them, server-side, inside the
 * revoking transaction. Real Postgres, RLS on (`core.push_device` is FORCE RLS, organisation-scoped).
 *
 *  (a) logout deactivates ONLY the device being logged out (`pushDeviceId` on `/auth/logout`), only for the caller;
 *  (b) revoking ONE other session while the account stays signed in elsewhere touches no device (there is no
 *      session → device link — see docs/plans/C1-PUSH-SESSION-LINK-MIGRATION.md); revoking the LAST live session
 *      deactivates every device;
 *  (c) every session revoked (suspension / sign-out-everywhere / password reset) and organisation suspension
 *      deactivate every affected registration;
 *  (d) the same phone re-registering under a new installation id supersedes the old row (no double delivery).
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('C1b push device deactivation on logout / revocation / suspension (integration)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let owner: DataSource;
  let tenantContext: TenantContextService;
  let refreshTokens: RefreshTokenService;
  let accessTokens: AccessTokenService;
  let factory: TestIdentityFactory;
  let manager: TestIdentity;
  let org: { id: string };

  const http = () => request(app.getHttpServer());
  const register = (token: string, deviceId: string, pushToken = `fcm-${randomUUID()}`) =>
    http().post('/rest/v1/push/devices').set('Authorization', `Bearer ${token}`).send({ deviceId, platform: 'android', pushToken });
  const active = async (userId: string, deviceId: string) =>
    (await owner.query(`SELECT active FROM core.push_device WHERE user_id = $1 AND device_id = $2`, [userId, deviceId]))[0]?.active as boolean | undefined;
  const reason = async (userId: string, deviceId: string) =>
    (await owner.query(`SELECT deactivated_reason FROM core.push_device WHERE user_id = $1 AND device_id = $2`, [userId, deviceId]))[0]?.deactivated_reason as string | null;
  const ctxOf = (who: TestIdentity) => ({ organisationId: who.organisationId, workspaceId: who.workspaceId, userId: who.userId, role: '' });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    tenantContext = moduleRef.get(TenantContextService);
    refreshTokens = moduleRef.get(RefreshTokenService);
    accessTokens = moduleRef.get(AccessTokenService);
    factory = new TestIdentityFactory({ app, dataSource: moduleRef.get(DataSource), adminDataSource: owner, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
    const seeded = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'c1push' });
    org = seeded.organisation;
    manager = seeded.managers[0]!;
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
  });

  it('(a) logout with pushDeviceId deactivates that device only — the same user’s other phone stays active', async () => {
    const staff = await factory.createStaff(org, { owner: manager, label: 'c1push-a' });
    const phoneA = await factory.loginTokens(staff);
    const phoneB = await factory.loginTokens(staff);
    const deviceA = randomUUID();
    const deviceB = randomUUID();
    expect((await register(phoneA.accessToken, deviceA)).status).toBeLessThan(300);
    expect((await register(phoneB.accessToken, deviceB)).status).toBeLessThan(300);

    const res = await http().post('/rest/v1/auth/logout').set('Authorization', `Bearer ${phoneA.accessToken}`).send({ refreshToken: phoneA.refreshToken, pushDeviceId: deviceA });
    expect(res.status).toBe(204);
    expect(await active(staff.userId, deviceA)).toBe(false);
    expect(await reason(staff.userId, deviceA)).toBe('user_logout');
    expect(await active(staff.userId, deviceB)).toBe(true); // phone B still signed in, still registered
  });

  it('(a) logout without pushDeviceId keeps today’s behaviour while another session is live (no device touched)', async () => {
    const staff = await factory.createStaff(org, { owner: manager, label: 'c1push-a2' });
    const phoneA = await factory.loginTokens(staff);
    const phoneB = await factory.loginTokens(staff);
    const deviceA = randomUUID();
    await register(phoneA.accessToken, deviceA);
    const res = await http().post('/rest/v1/auth/logout').set('Authorization', `Bearer ${phoneA.accessToken}`).send({ refreshToken: phoneA.refreshToken });
    expect(res.status).toBe(204);
    expect(await active(staff.userId, deviceA)).toBe(true);
    void phoneB;
  });

  it('(a) abuse: naming ANOTHER user’s device id on logout deactivates nothing of theirs', async () => {
    const victim = await factory.createStaff(org, { owner: manager, label: 'c1push-victim' });
    const attacker = await factory.createStaff(org, { owner: manager, label: 'c1push-attacker' });
    const victimTokens = await factory.loginTokens(victim);
    const victimDevice = randomUUID();
    await register(victimTokens.accessToken, victimDevice);
    const attackerTokens = await factory.loginTokens(attacker);
    await factory.loginTokens(attacker); // a second live session, so the attacker's own logout is not their last

    const res = await http().post('/rest/v1/auth/logout').set('Authorization', `Bearer ${attackerTokens.accessToken}`).send({ refreshToken: attackerTokens.refreshToken, pushDeviceId: victimDevice });
    expect(res.status).toBe(204);
    expect(await active(victim.userId, victimDevice)).toBe(true);
  });

  it('(a) a malformed pushDeviceId is a 400 and revokes nothing', async () => {
    const staff = await factory.createStaff(org, { owner: manager, label: 'c1push-bad' });
    const tokens = await factory.loginTokens(staff);
    const res = await http().post('/rest/v1/auth/logout').set('Authorization', `Bearer ${tokens.accessToken}`).send({ refreshToken: tokens.refreshToken, pushDeviceId: 'not-a-uuid' });
    expect(res.status).toBe(400);
    const me = await http().get('/rest/v1/auth/me').set('Authorization', `Bearer ${tokens.accessToken}`);
    expect(me.status).toBe(200); // the session survived the rejected request
  });

  it('(b) revoking one OTHER session while the account stays signed in touches no device; revoking the last one deactivates all', async () => {
    const staff = await factory.createStaff(org, { owner: manager, label: 'c1push-b' });
    const phoneA = await factory.loginTokens(staff);
    const phoneB = await factory.loginTokens(staff);
    const deviceA = randomUUID();
    const deviceB = randomUUID();
    await register(phoneA.accessToken, deviceA);
    await register(phoneB.accessToken, deviceB);
    const sidA = accessTokens.verify(phoneA.accessToken).sid;
    const sidB = accessTokens.verify(phoneB.accessToken).sid;

    await tenantContext.runInTenantContext(ctxOf(staff), (m) => refreshTokens.revokeFamily(m, sidA, 'revoked_by_user'));
    expect(await active(staff.userId, deviceA)).toBe(true); // cannot be told apart from B's device without a session link
    expect(await active(staff.userId, deviceB)).toBe(true);

    await tenantContext.runInTenantContext(ctxOf(staff), (m) => refreshTokens.revokeFamily(m, sidB, 'revoked_by_user'));
    expect(await active(staff.userId, deviceA)).toBe(false);
    expect(await active(staff.userId, deviceB)).toBe(false);
    expect(await reason(staff.userId, deviceB)).toBe('session_revoked:revoked_by_user');
  });

  it('(b) a rolled-back revocation deactivates nothing (same transaction)', async () => {
    const staff = await factory.createStaff(org, { owner: manager, label: 'c1push-rb' });
    const tokens = await factory.loginTokens(staff);
    const device = randomUUID();
    await register(tokens.accessToken, device);
    await expect(
      tenantContext.runInTenantContext(ctxOf(staff), async (m) => {
        await refreshTokens.revokeAllForUser(m, staff.userId, 'test');
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    expect(await active(staff.userId, device)).toBe(true);
  });

  it('(c) every session revoked (account suspension / sign-out-everywhere path) deactivates every device of that user only', async () => {
    const staff = await factory.createStaff(org, { owner: manager, label: 'c1push-c' });
    const other = await factory.createStaff(org, { owner: manager, label: 'c1push-c-other' });
    const t1 = await factory.loginTokens(staff);
    const t2 = await factory.loginTokens(staff);
    const tOther = await factory.loginTokens(other);
    const d1 = randomUUID();
    const d2 = randomUUID();
    const dOther = randomUUID();
    await register(t1.accessToken, d1);
    await register(t2.accessToken, d2);
    await register(tOther.accessToken, dOther);

    await tenantContext.runInTenantContext(ctxOf(staff), (m) => refreshTokens.revokeAllForUser(m, staff.userId, 'account_suspended'));
    expect(await active(staff.userId, d1)).toBe(false);
    expect(await active(staff.userId, d2)).toBe(false);
    expect(await reason(staff.userId, d1)).toBe('sessions_revoked:account_suspended');
    expect(await active(other.userId, dOther)).toBe(true);
  });

  it('(b, review F1) an idle-expired session is not "live": revoking the only other session deactivates every device', async () => {
    const staff = await factory.createStaff(org, { owner: manager, label: 'c1push-f1' });
    const phoneA = await factory.loginTokens(staff);
    const phoneB = await factory.loginTokens(staff);
    const deviceA = randomUUID();
    const deviceB = randomUUID();
    await register(phoneA.accessToken, deviceA);
    await register(phoneB.accessToken, deviceB);
    // Session A is not revoked, but it has gone idle: it can no longer authenticate anything.
    await owner.query(`UPDATE core.user_session SET idle_expires_at = now() - interval '1 minute' WHERE id = $1`, [accessTokens.verify(phoneA.accessToken).sid]);

    await tenantContext.runInTenantContext(ctxOf(staff), (m) => refreshTokens.revokeFamily(m, accessTokens.verify(phoneB.accessToken).sid, 'revoked_by_user'));
    expect(await active(staff.userId, deviceA)).toBe(false);
    expect(await active(staff.userId, deviceB)).toBe(false);
  });

  it('(c) "log out of all other devices" (revokeAllForUserExcept) leaves every device alone — never a guess', async () => {
    const staff = await factory.createStaff(org, { owner: manager, label: 'c1push-except' });
    const keep = await factory.loginTokens(staff);
    const gone = await factory.loginTokens(staff);
    const dKeep = randomUUID();
    const dGone = randomUUID();
    await register(keep.accessToken, dKeep);
    await register(gone.accessToken, dGone);
    await tenantContext.runInTenantContext(ctxOf(staff), (m) => refreshTokens.revokeAllForUserExcept(m, staff.userId, accessTokens.verify(keep.accessToken).sid, 'revoked_by_user'));
    expect(await active(staff.userId, dKeep)).toBe(true);
    expect(await active(staff.userId, dGone)).toBe(true);
  });

  it('(c) organisation suspension deactivates every registration of that organisation and none of another', async () => {
    const seededA = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'c1push-orgA' });
    const seededB = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'c1push-orgB' });
    const staffA = await factory.createStaff(seededA.organisation, { owner: seededA.managers[0]!, label: 'c1push-oa' });
    const staffB = await factory.createStaff(seededB.organisation, { owner: seededB.managers[0]!, label: 'c1push-ob' });
    const dA = randomUUID();
    const dB = randomUUID();
    await register((await factory.loginTokens(staffA)).accessToken, dA);
    await register((await factory.loginTokens(staffB)).accessToken, dB);

    await tenantContext.runInTenantContext({ organisationId: seededA.organisation.id, workspaceId: null, userId: seededA.managers[0]!.userId, role: '' }, (m) =>
      refreshTokens.revokeAllForOrganisation(m, seededA.organisation.id, 'organisation_suspended'),
    );
    expect(await active(staffA.userId, dA)).toBe(false);
    expect(await active(staffB.userId, dB)).toBe(true);
  });

  it('(d) the same phone re-registering under a new installation id (same provider token) supersedes the old row', async () => {
    const staff = await factory.createStaff(org, { owner: manager, label: 'c1push-d' });
    const tokens = await factory.loginTokens(staff);
    const pushToken = `fcm-${randomUUID()}`;
    const legacyHexId = randomUUID().replace(/-/g, ''); // the pre-migration 32-hex Flutter id
    const newId = randomUUID();
    const otherPhone = randomUUID();
    await register(tokens.accessToken, legacyHexId, pushToken);
    await register(tokens.accessToken, otherPhone);
    await register(tokens.accessToken, newId, pushToken);

    expect(await active(staff.userId, newId)).toBe(true);
    expect(await active(staff.userId, legacyHexId)).toBe(false);
    expect(await reason(staff.userId, legacyHexId)).toBe('superseded_by_new_device_id');
    expect(await active(staff.userId, otherPhone)).toBe(true); // a different token = a different phone
  });
});
