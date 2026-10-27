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
 * Lane D (M10-4, verification only — no behaviour change): the session-policy properties the read-only survey found
 * ENFORCED in code but NOT proven end to end by any existing route-level test.
 *
 *  1. `POST /auth/reset-password` (forgot-password link) revokes every session: the in-flight access token AND the
 *     refresh token stop working immediately (existing test 17 called `revokeAllForUser` directly, not the route).
 *  2. A manager's `POST /staff/:id/reset-password` (admin recovery) kills the TARGET's in-flight access token and refresh
 *     token (existing tests only checked refresh; one comment claimed the access token survives).
 *  3. `/auth/refresh` never extends `idle_expires_at` or the absolute deadline (only real activity slides idle).
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const ORIGIN = 'http://localhost:5173';
const STRONG = 'Lane-D-Reset-Pass-42!';

describeIfDb('lane D — session policy evidence (integration)', () => {
  jest.setTimeout(240_000);

  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let org: { id: string };
  let manager: TestIdentity;
  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const me = (token: string) => http().get('/rest/v1/auth/me').set(bearer(token)).set('x-client-platform', 'mobile');
  const refresh = (token: string) => http().post('/rest/v1/auth/refresh').set('x-client-platform', 'mobile').send({ refreshToken: token });
  const sidOf = (token: string) => (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { sid: string }).sid;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    factory = new TestIdentityFactory({ app, dataSource: moduleRef.get(DataSource), adminDataSource: owner, tenantContext: moduleRef.get(TenantContextService), passwordHashing: moduleRef.get(PasswordHashingService) });
    const seeded = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'ldsp' });
    org = seeded.organisation;
    manager = seeded.managers[0]!;
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
  });

  it('1: a forgot-password RESET through the real route ends every session — the in-flight access token and the refresh token stop working at once', async () => {
    const staff = await factory.createStaff(org, { owner: manager, label: 'ldspf' });
    const phone = await factory.loginTokens(staff);
    const other = await factory.loginTokens(staff); // a second device
    expect((await me(phone.accessToken)).status).toBe(200);

    expect((await http().post('/rest/v1/auth/forgot-password').set('x-client-platform', 'mobile').send({ email: staff.email })).status).toBe(204);
    const [mail] = await owner.query(
      `SELECT rendered_html FROM core.email_outbox WHERE recipient_email = $1 AND job_type = 'PASSWORD_RESET' ORDER BY created_at DESC LIMIT 1`,
      [staff.email],
    );
    const token = decodeURIComponent(/reset-password\?token=([A-Za-z0-9_\-%.]+)/.exec(mail.rendered_html as string)![1]!);
    expect((await http().post('/rest/v1/auth/reset-password').send({ token, newPassword: STRONG })).status).toBe(200);

    for (const device of [phone, other]) {
      expect((await me(device.accessToken)).status).toBe(401);
      expect((await refresh(device.refreshToken)).status).toBe(401);
    }
    const live = await owner.query(`SELECT count(*)::int AS n FROM core.user_session WHERE user_id = $1 AND revoked_at IS NULL`, [staff.userId]);
    expect(live[0].n).toBe(0);
    // The new password works; the reset link is single use.
    expect((await http().post('/rest/v1/auth/login').set('x-client-platform', 'mobile').send({ email: staff.email, password: STRONG })).status).toBe(200);
    expect((await http().post('/rest/v1/auth/reset-password').send({ token, newPassword: `${STRONG}x` })).status).toBe(400);
  });

  it('2: an admin password reset (POST /staff/:id/reset-password) kills the TARGET\'s in-flight access token and refresh token immediately', async () => {
    const staff = await factory.createStaff(org, { owner: manager, label: 'ldspa' });
    const device = await factory.loginTokens(staff);
    expect((await me(device.accessToken)).status).toBe(200);
    const managerToken = await factory.login(manager, { applicationTarget: 'manager_web' }); // fresh sign-in = step-up for this session
    const reset = await http().post(`/rest/v1/staff/${staff.profileId}/reset-password`).set(bearer(managerToken)).set('Origin', ORIGIN).send();
    expect([200, 201, 204]).toContain(reset.status);
    expect((await me(device.accessToken)).status).toBe(401);
    expect((await refresh(device.refreshToken)).status).toBe(401);
    const [row] = await owner.query(`SELECT revoked_at FROM core.user_session WHERE id = $1`, [sidOf(device.accessToken)]);
    expect(row.revoked_at).not.toBeNull();
  });

  it('3: /auth/refresh rotates the token but never extends idle_expires_at or the absolute deadline', async () => {
    const staff = await factory.createStaff(org, { owner: manager, label: 'ldspi' });
    const device = await factory.loginTokens(staff);
    const sid = sidOf(device.accessToken);
    const read = async () =>
      (await owner.query(`SELECT idle_expires_at, absolute_expires_at FROM core.user_session WHERE id = $1`, [sid]))[0] as { idle_expires_at: Date | null; absolute_expires_at: Date };
    const before = await read();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const rotated = await refresh(device.refreshToken);
    expect(rotated.status).toBe(200);
    expect(rotated.body.refreshToken).not.toBe(device.refreshToken);
    const after = await read();
    expect(new Date(after.absolute_expires_at).getTime()).toBe(new Date(before.absolute_expires_at).getTime());
    expect(after.idle_expires_at === null ? null : new Date(after.idle_expires_at).getTime()).toBe(before.idle_expires_at === null ? null : new Date(before.idle_expires_at).getTime());
    // The old refresh token is single use (reuse is detected and the family revoked).
    expect((await refresh(device.refreshToken)).status).toBe(401);
    expect((await refresh(rotated.body.refreshToken)).status).toBe(401);
  });
});
