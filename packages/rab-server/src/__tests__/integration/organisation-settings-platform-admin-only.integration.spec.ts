import 'reflect-metadata';
import { ForbiddenException, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ManagerType } from '@rab/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { OrganisationAuthProvidersService } from '../../engine/core-modules/auth/services/organisation-auth-providers.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { OrganisationSettingsAdminService } from '../../modules/identity/services/organisation-settings-admin.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * W6-E2E-04 + owner decision 2026-10-23: "Changing organisation settings (incl. turning off password sign-in) =
 * PLATFORM ADMIN ONLY." Abuse cases (rab-workforce-architecture.md §1.2), real Postgres + RLS, real HTTP:
 *
 *  - inventory: every former `settings.edit` tenant mutation (name/timezone, slug, logo upload/delete, sign-in methods)
 *    is GONE for every tenant role (404 — no handler), even for a user holding every PermissionFlag incl. settings.edit;
 *  - the tenant keeps a READ-ONLY view (`settings.view`: CEO and Manager by default; a Venue Manager is 403);
 *  - the platform-admin routes refuse CEO / Initial Manager / Manager with 403 (they exist; the caller categorically
 *    lacks the claim), on their own organisation and on another one, and nothing changes;
 *  - layer 2: both services refuse a non-administrator called directly (no controller, no guard);
 *  - a platform administrator changes ANOTHER organisation's settings, it is audited in that organisation, attributed to
 *    the administrator, and the wave-1 "log them out" revocation still happens; an unknown or malformed organisation is 404.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('W6-E2E-04 organisation settings are platform-admin only (integration, abuse cases)', () => {
  jest.setTimeout(180_000);

  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let adminService: OrganisationSettingsAdminService;
  let providers: OrganisationAuthProvidersService;
  let orgA: string;
  let orgB: string;
  /** The every-flag adversary needs its own organisation (a canonical role's permission set is shared per organisation). */
  let orgAll: string;
  let ceoA: TestIdentity;
  let imA: TestIdentity;
  let managerA: TestIdentity;
  let venueManagerA: TestIdentity;
  let allFlagsA: TestIdentity;
  let managerB: TestIdentity;
  let platformAdmin: TestIdentity;
  const tokens: Record<string, string> = {};

  const http = () => request(app.getHttpServer());
  const orgRow = async (id: string) =>
    (await owner.query(`SELECT name, slug, timezone, password_auth_enabled, google_auth_enabled, logo_file_id FROM core.organisation WHERE id = $1`, [id]))[0];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    const dataSource = moduleRef.get(DataSource);
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource: owner, tenantContext: moduleRef.get(TenantContextService), passwordHashing: moduleRef.get(PasswordHashingService) });
    adminService = moduleRef.get(OrganisationSettingsAdminService);
    providers = moduleRef.get(OrganisationAuthProvidersService);

    const a = await factory.createOrganisation('w6e04a');
    const b = await factory.createOrganisation('w6e04b');
    orgA = a.id;
    orgB = b.id;
    ceoA = await factory.createInternalManager(a, { type: ManagerType.CEO, permissions: 'production', label: 'w6e04ceo' });
    imA = await factory.createInternalManager(a, { permissions: 'production', workspace: true, label: 'w6e04im' });
    await owner.query(`UPDATE core.manager_profile SET is_initial_manager = true WHERE id = $1`, [imA.profileId]);
    managerA = await factory.createInternalManager(a, { permissions: 'production', workspace: true, label: 'w6e04mgr' });
    venueManagerA = await factory.createVenueManager(a, { owner: imA });
    orgAll = (await factory.createOrganisation('w6e04all')).id;
    allFlagsA = await factory.createInternalManager({ id: orgAll }, { permissions: 'all', workspace: true, label: 'w6e04all' });
    managerB = await factory.createInternalManager(b, { permissions: 'production', workspace: true, label: 'w6e04mb' });
    platformAdmin = await factory.createInternalManager(await factory.createOrganisation('w6e04p'), { permissions: 'production', platformAdmin: true, label: 'w6e04pa' });
    await owner.query(`UPDATE core.organisation SET google_auth_enabled = true WHERE id = ANY($1)`, [[orgA, orgB, orgAll]]);
    for (const [k, id] of Object.entries({ ceoA, imA, managerA, venueManagerA, allFlagsA, managerB, platformAdmin })) tokens[k] = await factory.login(id);
  });

  afterAll(async () => {
    if (owner?.isInitialized) await owner.query(`UPDATE core.organisation SET password_auth_enabled = true WHERE id = ANY($1)`, [[orgA, orgB, orgAll]]);
    await owner?.destroy();
    await app?.close();
  });

  const TENANT_MUTATIONS: Array<[string, 'patch' | 'post' | 'delete', Record<string, unknown> | undefined]> = [
    ['/rest/v1/workspace', 'patch', { name: 'Hijacked' }],
    ['/rest/v1/workspace/domain', 'patch', { slug: 'hijacked-slug' }],
    ['/rest/v1/workspace/logo', 'post', undefined],
    ['/rest/v1/workspace/logo', 'delete', undefined],
    ['/rest/v1/workspace/security', 'patch', { passwordAuthEnabled: false }],
  ];

  const ownOrg = (who: string) => (who === 'allFlagsA' ? orgAll : orgA);

  it.each(['ceoA', 'imA', 'managerA', 'allFlagsA'])('%s: every former tenant mutation of organisation settings is gone (404) and nothing changes', async (who) => {
    const before = await orgRow(ownOrg(who));
    for (const [path, method, body] of TENANT_MUTATIONS) {
      const req = http()[method](path).set('Authorization', `Bearer ${tokens[who]}`);
      const res = body ? await req.send(body) : await req;
      expect([path, method, res.status]).toEqual([path, method, 404]);
    }
    expect(await orgRow(ownOrg(who))).toEqual(before);
  });

  it('the tenant keeps a READ-ONLY view: CEO and Initial Manager read settings (settings.view), a Venue Manager is refused', async () => {
    for (const who of ['ceoA', 'imA']) {
      const sec = await http().get('/rest/v1/workspace/security').set('Authorization', `Bearer ${tokens[who]}`);
      expect([who, sec.status]).toEqual([who, 200]);
      expect(sec.body.password).toEqual({ organisationEnabled: true, systemEnabled: true });
      const ws = await http().get('/rest/v1/workspace').set('Authorization', `Bearer ${tokens[who]}`);
      expect([who, ws.status, ws.body.id]).toEqual([who, 200, orgA]);
    }
    expect((await http().get('/rest/v1/workspace/security').set('Authorization', `Bearer ${tokens.venueManagerA}`)).status).toBe(403);
  });

  it.each(['ceoA', 'imA', 'managerA', 'allFlagsA'])('%s: the platform-admin settings routes refuse 403 on its OWN organisation and on another one, nothing changes', async (who) => {
    const beforeA = await orgRow(ownOrg(who));
    const beforeB = await orgRow(orgB);
    for (const target of [ownOrg(who), orgB]) {
      const auth = { Authorization: `Bearer ${tokens[who]}` };
      expect((await http().get(`/rest/v1/admin/organisations/${target}/settings`).set(auth)).status).toBe(403);
      expect((await http().patch(`/rest/v1/admin/organisations/${target}/settings/security`).set(auth).send({ passwordAuthEnabled: false })).status).toBe(403);
      expect((await http().patch(`/rest/v1/admin/organisations/${target}/settings`).set(auth).send({ name: 'Hijacked' })).status).toBe(403);
      expect((await http().patch(`/rest/v1/admin/organisations/${target}/settings/domain`).set(auth).send({ slug: `hj-${randomUUID().slice(0, 6)}` })).status).toBe(403);
    }
    expect(await orgRow(ownOrg(who))).toEqual(beforeA);
    expect(await orgRow(orgB)).toEqual(beforeB);
  });

  it('layer 2: both services refuse a non-administrator called directly (no controller, no guard)', async () => {
    const before = await orgRow(orgA);
    await expect(adminService.updateAuthProviders({ userId: ceoA.userId, organisationId: ceoA.organisationId, workspaceId: null }, orgA, { passwordAuthEnabled: false })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(adminService.update({ userId: imA.userId, organisationId: imA.organisationId, workspaceId: imA.workspaceId }, orgA, { name: 'Hijacked' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(adminService.get({ userId: managerA.userId, organisationId: managerA.organisationId, workspaceId: managerA.workspaceId }, orgA)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(providers.update({ userId: allFlagsA.userId, organisationId: allFlagsA.organisationId, workspaceId: allFlagsA.workspaceId }, orgAll, { passwordAuthEnabled: false })).rejects.toBeInstanceOf(ForbiddenException);
    // An Admin Inspect session is refused for mutations even when the inspector is an administrator.
    await expect(adminService.update({ userId: platformAdmin.userId, organisationId: platformAdmin.organisationId, workspaceId: platformAdmin.workspaceId, inspectedBy: platformAdmin.userId }, orgA, { name: 'X' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(await orgRow(orgA)).toEqual(before);
  });

  it('a platform administrator changes ANOTHER organisation\'s settings; audited in that organisation, attributed to the administrator', async () => {
    const auth = { Authorization: `Bearer ${tokens.platformAdmin}` };
    const view = await http().get(`/rest/v1/admin/organisations/${orgB}/settings`).set(auth);
    expect(view.status).toBe(200);
    expect(view.body.organisation.id).toBe(orgB);

    const renamed = await http().patch(`/rest/v1/admin/organisations/${orgB}/settings`).set(auth).send({ name: 'Bravo Renamed', timezone: 'Europe/London' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.organisation.name).toBe('Bravo Renamed');
    // Mass-assignment: an undeclared field is a 400, never applied.
    expect((await http().patch(`/rest/v1/admin/organisations/${orgB}/settings`).set(auth).send({ name: 'X', organisationId: orgA })).status).toBe(400);

    const audit = await owner.query(
      `SELECT actor_user_id, metadata FROM core.audit_log WHERE organisation_id = $1 AND action = 'workspace.updated' ORDER BY created_at DESC LIMIT 1`,
      [orgB],
    );
    expect(audit[0]).toMatchObject({ actor_user_id: platformAdmin.userId, metadata: { via: 'platform_admin' } });
    expect((await orgRow(orgA)).name).not.toBe('Bravo Renamed'); // never the administrator's or another tenant's row
  });

  it('turning password sign-in OFF for another organisation keeps the wave-1 behaviour: lockout refusal, then sessions revoked, audited', async () => {
    const auth = { Authorization: `Bearer ${tokens.platformAdmin}` };
    // Lockout refusal still applies to the administrator.
    await owner.query(`UPDATE core.organisation SET google_auth_enabled = false, microsoft_auth_enabled = false WHERE id = $1`, [orgB]);
    expect((await http().patch(`/rest/v1/admin/organisations/${orgB}/settings/security`).set(auth).send({ passwordAuthEnabled: false })).status).toBe(400);
    expect((await orgRow(orgB)).password_auth_enabled).toBe(true);

    const off = await http().patch(`/rest/v1/admin/organisations/${orgB}/settings/security`).set(auth).send({ passwordAuthEnabled: false, googleAuthEnabled: true });
    expect(off.status).toBe(200);
    expect(off.body.authProviders.password.organisationEnabled).toBe(false);
    // managerB's password web session (from beforeAll) is revoked: the access token no longer works.
    expect((await http().get('/rest/v1/auth/me').set('Authorization', `Bearer ${tokens.managerB}`)).status).toBe(401);
    // The administrator's own session (another organisation) is untouched.
    expect((await http().get(`/rest/v1/admin/organisations/${orgB}/settings`).set(auth)).status).toBe(200);

    const rows = await owner.query(
      `SELECT action, actor_user_id, metadata FROM core.audit_log WHERE organisation_id = $1 AND action IN ('organisation.auth_providers_updated', 'organisation.password_sessions_revoked') ORDER BY created_at`,
      [orgB],
    );
    const updated = rows.find((r: { action: string }) => r.action === 'organisation.auth_providers_updated');
    const revoked = rows.find((r: { action: string }) => r.action === 'organisation.password_sessions_revoked');
    expect(updated).toMatchObject({ actor_user_id: platformAdmin.userId, metadata: { via: 'platform_admin' } });
    expect(revoked.metadata.revoked).toBeGreaterThanOrEqual(1);
    expect(updated.metadata.passwordSessionsRevoked).toBe(revoked.metadata.revoked);
    // Organisation A was not touched.
    expect((await orgRow(orgA)).password_auth_enabled).toBe(true);

    const back = await http().patch(`/rest/v1/admin/organisations/${orgB}/settings/security`).set(auth).send({ passwordAuthEnabled: true });
    expect(back.status).toBe(200);
  });

  it('a platform administrator replaces and removes another organisation’s logo (stored under that organisation)', async () => {
    const auth = { Authorization: `Bearer ${tokens.platformAdmin}` };
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const up = await http().post(`/rest/v1/admin/organisations/${orgB}/settings/logo`).set(auth).attach('file', png, { filename: 'logo.png', contentType: 'image/png' });
    expect(up.status).toBe(201);
    const fileId = (await orgRow(orgB)).logo_file_id;
    expect(fileId).toBe(up.body.organisation.logoKey);
    const [file] = await owner.query(`SELECT organisation_id FROM core.stored_file WHERE id = $1`, [fileId]);
    expect(file.organisation_id).toBe(orgB);
    const del = await http().delete(`/rest/v1/admin/organisations/${orgB}/settings/logo`).set(auth);
    expect(del.status).toBe(200);
    expect((await orgRow(orgB)).logo_file_id).toBeNull();
  });

  it('an unknown organisation is 404 and a malformed id is 404 (no existence oracle)', async () => {
    const auth = { Authorization: `Bearer ${tokens.platformAdmin}` };
    expect((await http().get(`/rest/v1/admin/organisations/${randomUUID()}/settings`).set(auth)).status).toBe(404);
    expect((await http().patch(`/rest/v1/admin/organisations/${randomUUID()}/settings/security`).set(auth).send({ passwordAuthEnabled: false })).status).toBe(404);
    expect((await http().get('/rest/v1/admin/organisations/not-a-uuid/settings').set(auth)).status).toBe(404);
  });
});
