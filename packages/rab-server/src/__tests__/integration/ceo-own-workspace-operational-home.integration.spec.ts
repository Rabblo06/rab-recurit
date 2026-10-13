import 'reflect-metadata';
import { ManagerType } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentityFactory } from './helpers/test-identities';

/**
 * Owner decision 2026-10-13: a self-service CEO (incl. a Platform Super Admin's CEO identity) with no
 * operational workspace gets the workspace they create as their operational home. Abuse cases: an
 * existing assignment is never overridden, nobody gains another workspace, invite-time creation for
 * someone else never binds the actor. Real Postgres, RLS on, no mocks.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('CEO own workspace as operational home (integration)', () => {
  let app: INestApplication;
  let admin: DataSource;
  let factory: TestIdentityFactory;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    admin = createAdminDataSource();
    await admin.initialize();
    factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource: admin,
      tenantContext: moduleRef.get(TenantContextService),
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
  });

  afterAll(async () => {
    await app.close();
    await admin.destroy();
  });

  async function createWorkspace(email: string) {
    const token = await factory.loginByEmail(email);
    return request(app.getHttpServer())
      .post('/rest/v1/manager-workspaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Own workspace', subdomain: `own-${randomUUID().slice(0, 8)}` });
  }

  async function memberships(userId: string) {
    return admin.query(`SELECT workspace_id, status FROM core.workspace_membership WHERE user_id = $1 ORDER BY created_at`, [userId]);
  }

  async function profileWorkspace(userId: string): Promise<string | null> {
    const [row] = await admin.query(`SELECT workspace_id FROM core.manager_profile WHERE user_id = $1`, [userId]);
    return row.workspace_id;
  }

  it('a Platform Super Admin CEO with no operational workspace is bound to the workspace they create', async () => {
    const org = await factory.createOrganisation('ceo-home');
    const ceo = await factory.createInternalManager(org, { type: ManagerType.CEO, workspace: false, platformAdmin: true });

    const res = await createWorkspace(ceo.email);
    expect(res.status).toBe(201);

    expect(await memberships(ceo.userId)).toEqual([{ workspace_id: res.body.id, status: 'active' }]);
    expect(await profileWorkspace(ceo.userId)).toBe(res.body.id);
  });

  it('never overrides an existing operational assignment — the new workspace stays inert for that CEO', async () => {
    const org = await factory.createOrganisation('ceo-assigned');
    const owner = await factory.createInternalManager(org);
    const ceo = await factory.createInternalManager(org, { type: ManagerType.CEO, workspace: false });
    await admin.query(
      `INSERT INTO core.workspace_membership (organisation_id, user_id, workspace_id, status, source) VALUES ($1, $2, $3, 'active', 'write_path')`,
      [org.id, ceo.userId, owner.workspaceId],
    );
    await admin.query(`UPDATE core.manager_profile SET workspace_id = $1 WHERE user_id = $2`, [owner.workspaceId, ceo.userId]);

    const res = await createWorkspace(ceo.email);
    expect(res.status).toBe(201);

    expect(await memberships(ceo.userId)).toEqual([{ workspace_id: owner.workspaceId, status: 'active' }]);
    expect(await profileWorkspace(ceo.userId)).toBe(owner.workspaceId);
  });

  it('reproduces the reported 404s: a Super Admin CEO with no operational membership is refused on every workspace endpoint', async () => {
    const org = await factory.createOrganisation('ceo-unbound');
    const ceo = await factory.createInternalManager(org, { type: ManagerType.CEO, workspace: false, platformAdmin: true });
    const token = await factory.loginByEmail(ceo.email, 'ceo');
    for (const path of ['/staff', '/venues', '/shifts', '/offers', '/job-roles', '/attendance']) {
      const res = await request(app.getHttpServer()).get(`/rest/v1${path}`).set('Authorization', `Bearer ${token}`);
      expect({ path, status: res.status, body: res.body }).toEqual({ path, status: 404, body: { statusCode: 404, message: 'Not found.' } });
    }
  });

  it('end to end: the bound Super Admin CEO gets 200 empty lists on every operational endpoint, never another Manager\'s data', async () => {
    const org = await factory.createOrganisation('ceo-e2e');
    const other = await factory.createInternalManager(org);
    const otherToken = await factory.loginByEmail(other.email);
    const venue = await request(app.getHttpServer())
      .post('/rest/v1/venues')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ name: 'Other Manager venue', type: 'hotel' });
    expect(venue.status).toBe(201);

    const ceo = await factory.createInternalManager(org, { type: ManagerType.CEO, workspace: false, platformAdmin: true });
    expect((await createWorkspace(ceo.email)).status).toBe(201);
    // Fresh login: the session must resolve the newly bound workspace.
    const token = await factory.loginByEmail(ceo.email, 'ceo');

    for (const path of ['/staff', '/venues', '/shifts', '/shifts/requests', '/offers', '/job-roles', '/attendance', '/managers']) {
      const res = await request(app.getHttpServer()).get(`/rest/v1${path}`).set('Authorization', `Bearer ${token}`);
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
    }
    const venues = await request(app.getHttpServer()).get('/rest/v1/venues').set('Authorization', `Bearer ${token}`);
    const ids = (venues.body.data ?? venues.body).map((v: { id: string }) => v.id);
    expect(ids).not.toContain(venue.body.id);
    expect((await request(app.getHttpServer()).get(`/rest/v1/venues/${venue.body.id}`).set('Authorization', `Bearer ${token}`)).status).toBe(404);
  });

  it('binding a CEO to their own workspace never grants another Manager\'s workspace in the same organisation', async () => {
    const org = await factory.createOrganisation('ceo-isolation');
    const other = await factory.createInternalManager(org);
    const ceo = await factory.createInternalManager(org, { type: ManagerType.CEO, workspace: false, platformAdmin: true });

    const res = await createWorkspace(ceo.email);
    expect(res.status).toBe(201);

    const rows = await memberships(ceo.userId);
    expect(rows.map((r: { workspace_id: string }) => r.workspace_id)).not.toContain(other.workspaceId);
    expect(await memberships(other.userId)).toEqual([{ workspace_id: other.workspaceId, status: 'active' }]);
  });
});
