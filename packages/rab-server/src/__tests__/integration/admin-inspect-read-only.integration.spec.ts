import 'reflect-metadata';
import { PermissionFlag } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
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

/**
 * CF-02 (October 15 audit): Admin Inspect is read-only on EVERY route, honoured only while the caller is a platform admin
 * right now, and for at most 30 minutes (owner decision). Before this, 25 routes protected by JwtAuthGuard alone (profile,
 * avatar, preferences, push devices, set-password, files, notifications, manager workspace) executed AS the inspected
 * user, and a demoted admin kept inspecting. Real PostgreSQL with RLS, real HTTP, no mocks.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('CF-02 Admin Inspect read-only, current authority and expiry (integration)', () => {
  jest.setTimeout(180_000);

  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let tenantContext: TenantContextService;
  let platformAdmin: PlatformAdminService;
  let admin: TestIdentity;
  let target: TestIdentity;
  let adminToken: string;

  const http = () => request(app.getHttpServer());
  const startInspect = async (token: string, userId: string): Promise<string> => {
    const res = await http().post(`/rest/v1/admin/inspect/${userId}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(201);
    return res.body.sessionId as string;
  };
  const profileAs = (token: string, sessionId?: string) => {
    const req = http().get('/rest/v1/profile').set('Authorization', `Bearer ${token}`);
    return sessionId ? req.set('X-Inspect-Session-Id', sessionId) : req;
  };
  const targetRow = async () =>
    (await owner.query(`SELECT first_name, password_hash, must_reset_password FROM core."user" WHERE id = $1`, [target.userId]))[0];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    tenantContext = moduleRef.get(TenantContextService);
    platformAdmin = moduleRef.get(PlatformAdminService);
    factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource: owner,
      tenantContext,
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
    const seeded = await factory.createOrganisationWithManagers(2, {
      permissions: [PermissionFlag.STAFF_CREATE, PermissionFlag.STAFF_VIEW],
      firstIsPlatformAdmin: true,
      workspace: true,
      label: 'cf02',
    });
    [admin, target] = seeded.managers as [TestIdentity, TestIdentity];
    adminToken = await factory.login(admin);
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
  });

  it('GET while inspecting sees the target (the positive path still works)', async () => {
    const sessionId = await startInspect(adminToken, target.userId);
    const res = await profileAs(adminToken, sessionId);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(target.userId);
  });

  // Every mutation route that is protected by JwtAuthGuard alone (no PermissionGuard), plus one PermissionGuard route.
  const MUTATIONS: Array<[string, string, object | null]> = [
    ['patch', '/rest/v1/profile', { firstName: 'Hijacked' }],
    ['post', '/rest/v1/profile/avatar', null],
    ['delete', '/rest/v1/profile/avatar', null],
    ['patch', '/rest/v1/profile/preferences', {}],
    ['patch', '/rest/v1/profile/notification-preferences', {}],
    ['delete', `/rest/v1/profile/sessions/${randomUUID()}`, null],
    ['delete', '/rest/v1/profile/sessions', null],
    ['post', '/rest/v1/profile/sessions/logout-all', null],
    ['post', '/rest/v1/auth/set-password', { newPassword: 'Correct-Horse-42-battery' }], // gitleaks:allow (test-only fixture password)
    ['post', '/rest/v1/auth/logout', {}],
    ['post', '/rest/v1/push/devices', { token: 'admin-device-token', platform: 'android', deviceId: 'admin-phone' }],
    ['post', `/rest/v1/push/devices/${randomUUID()}/deactivate`, null],
    ['post', '/rest/v1/push/devices/deactivate-all', null],
    ['post', '/rest/v1/files/previews', {}],
    ['post', '/rest/v1/files/upload-intent', {}],
    ['post', `/rest/v1/files/${randomUUID()}/complete`, null],
    ['post', '/rest/v1/manager-workspaces', {}],
    ['patch', '/rest/v1/manager-workspaces/me', { name: 'Hijacked' }],
    ['patch', '/rest/v1/manager-workspaces/me/subdomain', { subdomain: 'hijacked' }],
    ['post', '/rest/v1/manager-workspaces/subdomain/check', { subdomain: 'x' }],
    ['post', '/rest/v1/manager-workspaces/me/logo', null],
    ['delete', '/rest/v1/manager-workspaces/me/logo', null],
    ['post', '/rest/v1/manager-workspaces/me/complete-onboarding', null],
    ['post', `/rest/v1/notifications/${randomUUID()}/read`, null],
    ['post', '/rest/v1/notifications/read-all', null],
    ['post', '/rest/v1/staff', { email: `x-${randomUUID()}@example.test`, firstName: 'X', lastName: 'Y' }],
  ];

  // Every row has exactly three values: with fewer, Jest would treat the callback's last parameter as a `done` callback.
  it.each(MUTATIONS)('%s %s while inspecting → 403 INSPECT_READ_ONLY, nothing changes for the target', async (method, path, body) => {
    const sessionId = await startInspect(adminToken, target.userId);
    const before = await targetRow();
    const devicesBefore = (await owner.query(`SELECT count(*)::int AS n FROM core.push_device WHERE user_id = $1`, [target.userId]))[0].n;
    const req = (http() as unknown as Record<string, (p: string) => request.Test>)[method]!(path)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Inspect-Session-Id', sessionId)
      .timeout({ response: 15_000 });
    const res = await (body ? req.send(body) : req);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('INSPECT_READ_ONLY');
    expect(await targetRow()).toEqual(before);
    expect((await owner.query(`SELECT count(*)::int AS n FROM core.push_device WHERE user_id = $1`, [target.userId]))[0].n).toBe(devicesBefore);
  });

  it('a mutation carrying a forged or unknown inspect id is refused the same way (one uniform answer, no oracle)', async () => {
    const res = await http()
      .patch('/rest/v1/profile')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Inspect-Session-Id', randomUUID())
      .send({ firstName: 'Forged' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('INSPECT_READ_ONLY');
  });

  it('refused attempts are audited as the admin, with method and path', async () => {
    const sessionId = await startInspect(adminToken, target.userId);
    await http().patch('/rest/v1/profile').set('Authorization', `Bearer ${adminToken}`).set('X-Inspect-Session-Id', sessionId).send({ firstName: 'A' });
    const rows = await owner.query(
      `SELECT actor_user_id, metadata FROM core.audit_log WHERE action = 'admin.inspect_mutation_refused' AND actor_user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [admin.userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ method: 'PATCH', path: '/rest/v1/profile' });
  });

  it('without the header, the admin’s own ordinary mutations still work (normal administration is not weakened)', async () => {
    const res = await http()
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: `own-${randomUUID()}@example.test`, firstName: 'Own', lastName: 'Staff' });
    expect(res.status).toBe(201);
  });

  it('a non-admin sending an inspect header on a GET gets only their own identity', async () => {
    const sessionId = await startInspect(adminToken, target.userId);
    const targetToken = await factory.login(target);
    const res = await profileAs(targetToken, sessionId);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(target.userId);
    // and the admin's identity cannot be borrowed by anyone else through the header
    expect(res.body.id).not.toBe(admin.userId);
  });

  it('an inspect row older than 30 minutes is ignored; one within 30 minutes still works', async () => {
    const sessionId = await startInspect(adminToken, target.userId);
    await owner.query(`UPDATE core.admin_inspect_session SET started_at = now() - interval '29 minutes' WHERE id = $1`, [sessionId]);
    expect((await profileAs(adminToken, sessionId)).body.id).toBe(target.userId);
    await owner.query(`UPDATE core.admin_inspect_session SET started_at = now() - interval '31 minutes' WHERE id = $1`, [sessionId]);
    expect((await profileAs(adminToken, sessionId)).body.id).toBe(admin.userId);
  });

  it('a demoted platform admin cannot inspect any more, and revocation ends the open inspect rows in the same transaction', async () => {
    const org = { id: admin.organisationId } as never;
    const second = await factory.createInternalManager(org, { platformAdmin: true, label: 'cf02b', permissions: [PermissionFlag.STAFF_CREATE, PermissionFlag.STAFF_VIEW] });
    const secondToken = await factory.login(second);
    const sessionId = await startInspect(secondToken, target.userId);
    expect((await profileAs(secondToken, sessionId)).body.id).toBe(target.userId);

    await platformAdmin.revoke({ userId: admin.userId, organisationId: admin.organisationId }, second.userId, admin.password);

    const after = await profileAs(secondToken, sessionId);
    expect(after.status).toBe(200);
    expect(after.body.id).toBe(second.userId);
    const open = await owner.query(`SELECT count(*)::int AS n FROM core.admin_inspect_session WHERE admin_user_id = $1 AND ended_at IS NULL`, [second.userId]);
    expect(open[0].n).toBe(0);
  });

  it('database layer: a tenant transaction run as an inspected user is READ ONLY (25006), however it is reached', async () => {
    const ctx = { organisationId: target.organisationId, workspaceId: target.workspaceId, userId: target.userId, role: '', inspectedBy: admin.userId };
    await expect(
      tenantContext.runInTenantContext(ctx, (m) => m.query(`UPDATE core."user" SET first_name = 'Bypass' WHERE id = $1`, [target.userId])),
    ).rejects.toMatchObject({ driverError: expect.objectContaining({ code: '25006' }) });
    // Reads still work.
    const rows = await tenantContext.runInTenantContext(ctx, (m) => m.query(`SELECT id FROM core."user" WHERE id = $1`, [target.userId]));
    expect(rows).toHaveLength(1);
  });
});
