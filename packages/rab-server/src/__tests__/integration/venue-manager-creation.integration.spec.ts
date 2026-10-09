import 'reflect-metadata';
import { ManagerType, PermissionFlag } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { Organisation } from '../../modules/identity/entities';
import { ROLE_DEFS } from '../../modules/manager/services/manager.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { BootstrapTimer } from './helpers/bootstrap-trace';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Hyper Workspace Phase 3, Part 1 and 2 (decision C). Two Venue Manager creation flows, kept strictly separate:
 *   - NORMAL Manager:  POST /rest/v1/venue-managers           (VENUE_MANAGER_CREATE, workspace from the session)
 *   - CEO / admin:     POST /rest/v1/org-admin/venue-managers (MANAGER_MANAGE, explicit target workspace validated)
 * Real Postgres, RLS on, real HTTP. Every denial is asserted on its specific control.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('Venue Manager creation: normal Manager flow and CEO/admin flow (integration)', () => {
  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;

  let org: Organisation;
  let managerA: TestIdentity;
  let managerB: TestIdentity;
  let wsA: string;
  let wsB: string;

  const withoutVenueManagerCreate = ROLE_DEFS[ManagerType.INTERNAL]!.permissions.filter((p) => p !== PermissionFlag.VENUE_MANAGER_CREATE);
  const withoutManagerManage = ROLE_DEFS[ManagerType.CEO]!.permissions.filter((p) => p !== PermissionFlag.MANAGER_MANAGE);

  beforeAll(async () => {
    const __bt = new BootstrapTimer('venue-manager-creation');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    __bt.mark('compile');
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    __bt.mark('init');
    await app.get(DataSource).query('SELECT 1');
    __bt.mark('dbPing');
    __bt.log();
    owner = createAdminDataSource();
    await owner.initialize();
    factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource: owner,
      tenantContext: moduleRef.get(TenantContextService),
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
    const seeded = await factory.createOrganisationWithManagers(2, { permissions: 'production', workspace: true, label: 'vmc' });
    org = seeded.organisation;
    managerA = seeded.managers[0]!;
    managerB = seeded.managers[1]!;
    wsA = managerA.workspaceId!;
    wsB = managerB.workspaceId!;
  });

  afterAll(async () => {
    await app?.close();
    await owner?.destroy();
  });

  const post = (path: string, token: string, body: Record<string, unknown>) =>
    request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`).send(body);

  const person = () => ({ email: `vm-${randomUUID().slice(0, 8)}@example.test`, firstName: 'Venue', lastName: 'Manager' });

  /** The user's membership rows, read as the owner with the organisation and user bound (FORCE RLS). */
  async function membershipOf(userId: string, organisationId: string): Promise<Array<{ workspace_id: string; status: string }>> {
    return owner.transaction(async (m) => {
      await m.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true)`, [organisationId, userId]);
      return m.query(`SELECT workspace_id, status FROM core.workspace_membership WHERE user_id = $1`, [userId]);
    });
  }

  async function userIdByEmail(email: string): Promise<string> {
    const [row] = await owner.query(`SELECT id FROM core."user" WHERE email = $1`, [email]);
    return row.id as string;
  }

  // ------------------------------------------------------------------ 1. normal Manager flow

  it('Manager A with VENUE_MANAGER_CREATE creates a Venue Manager whose membership is Workspace A', async () => {
    const token = await factory.login(managerA);
    const p = person();
    const res = await post('/rest/v1/venue-managers', token, p);
    expect(res.status).toBe(201);
    const userId = await userIdByEmail(p.email);
    expect(await membershipOf(userId, org.id)).toEqual([expect.objectContaining({ workspace_id: wsA, status: 'active' })]);
  });

  it('Manager B creates a Venue Manager inside Workspace B only', async () => {
    const token = await factory.login(managerB);
    const p = person();
    expect((await post('/rest/v1/venue-managers', token, p)).status).toBe(201);
    const userId = await userIdByEmail(p.email);
    expect(await membershipOf(userId, org.id)).toEqual([expect.objectContaining({ workspace_id: wsB })]);
  });

  it('Manager A cannot choose Workspace B: a target workspace in the body is rejected (400), nothing is created', async () => {
    const token = await factory.login(managerA);
    const p = person();
    const res = await post('/rest/v1/venue-managers', token, { ...p, workspaceId: wsB });
    expect(res.status).toBe(400);
    expect(await owner.query(`SELECT id FROM core."user" WHERE email = $1`, [p.email])).toEqual([]);
  });

  it('a body carrying organisationId, managerId or schemaName is refused (400): none of them is tenancy authority', async () => {
    const token = await factory.login(managerA);
    for (const extra of [{ organisationId: org.id }, { managerId: randomUUID() }, { schemaName: `workspace_${wsB.replace(/-/g, '')}` }]) {
      const res = await post('/rest/v1/venue-managers', token, { ...person(), ...extra });
      expect(res.status).toBe(400);
    }
  });

  it('a Manager without VENUE_MANAGER_CREATE is denied (403): the narrow permission is the gate, not the role name', async () => {
    // A canonical role key may carry only one permission set per organisation, so the restricted identity lives in its own organisation.
    const limitedOrg = await factory.createOrganisation();
    const limited = await factory.createInternalManager(limitedOrg, { permissions: withoutVenueManagerCreate, label: 'novm' });
    const token = await factory.login(limited);
    const res = await post('/rest/v1/venue-managers', token, person());
    expect(res.status).toBe(403);
  });

  it('a Manager without a workspace is refused (RequireWorkspaceGuard, a deliberate 403), never a database error', async () => {
    const noWs = await factory.createInternalManager(org, { permissions: 'production', label: 'nows', workspace: false });
    const token = await factory.login(noWs);
    const res = await post('/rest/v1/venue-managers', token, person());
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toMatch(/uuid|syntax|QueryFailed/i);
  });

  // ------------------------------------------------------------------ 2. CEO / admin flow

  it('CEO with MANAGER_MANAGE (no workspace of its own) creates a Venue Manager for an explicitly chosen Workspace A', async () => {
    const ceo = await factory.createInternalManager(org, { permissions: 'production', type: ManagerType.CEO, workspace: false, label: 'ceoA' });
    const token = await factory.login(ceo);
    const p = person();
    const res = await post('/rest/v1/org-admin/venue-managers', token, { ...p, targetWorkspaceId: wsA });
    expect(res.status).toBe(201);
    const userId = await userIdByEmail(p.email);
    expect(await membershipOf(userId, org.id)).toEqual([expect.objectContaining({ workspace_id: wsA, status: 'active' })]);
  });

  it('CEO may explicitly create a Venue Manager for Workspace B as well', async () => {
    const ceo = await factory.createInternalManager(org, { permissions: 'production', type: ManagerType.CEO, workspace: false, label: 'ceoB' });
    const token = await factory.login(ceo);
    const p = person();
    expect((await post('/rest/v1/org-admin/venue-managers', token, { ...p, targetWorkspaceId: wsB })).status).toBe(201);
    expect(await membershipOf(await userIdByEmail(p.email), org.id)).toEqual([expect.objectContaining({ workspace_id: wsB })]);
  });

  it('CEO without MANAGER_MANAGE is denied (403) even with a valid target', async () => {
    const weakOrg = await factory.createOrganisation();
    const weakCeo = await factory.createInternalManager(weakOrg, { permissions: withoutManagerManage, type: ManagerType.CEO, workspace: false, label: 'weakCeo' });
    const token = await factory.login(weakCeo);
    const res = await post('/rest/v1/org-admin/venue-managers', token, { ...person(), targetWorkspaceId: wsA });
    expect(res.status).toBe(403);
  });

  it('a normal Manager cannot use the admin flow to pick Workspace B (403: no MANAGER_MANAGE)', async () => {
    const token = await factory.login(managerA);
    const p = person();
    const res = await post('/rest/v1/org-admin/venue-managers', token, { ...p, targetWorkspaceId: wsB });
    expect(res.status).toBe(403);
    expect(await owner.query(`SELECT id FROM core."user" WHERE email = $1`, [p.email])).toEqual([]);
  });

  it('a target workspace that does not exist, or belongs to another organisation, is 404 (no existence oracle)', async () => {
    const ceo = await factory.createInternalManager(org, { permissions: 'production', type: ManagerType.CEO, workspace: false, label: 'ceoC' });
    const token = await factory.login(ceo);
    const other = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'othr' });
    const foreign = other.managers[0]!.workspaceId!;
    const missing = await post('/rest/v1/org-admin/venue-managers', token, { ...person(), targetWorkspaceId: randomUUID() });
    const crossOrg = await post('/rest/v1/org-admin/venue-managers', token, { ...person(), targetWorkspaceId: foreign });
    expect(missing.status).toBe(404);
    expect(crossOrg.status).toBe(404);
    expect(missing.body).toEqual(crossOrg.body);
  });

  it('the CEO admin creation writes an audit event naming admin, organisation, target workspace, created user and action, with no secrets', async () => {
    const ceo = await factory.createInternalManager(org, { permissions: 'production', type: ManagerType.CEO, workspace: false, label: 'ceoAud' });
    const token = await factory.login(ceo);
    const p = person();
    const res = await post('/rest/v1/org-admin/venue-managers', token, { ...p, targetWorkspaceId: wsA });
    expect(res.status).toBe(201);
    const createdUserId = await userIdByEmail(p.email);
    const rows = await owner.transaction(async (m) => {
      await m.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true), set_config('rab.workspace_id', $3, true)`, [org.id, ceo.userId, wsA]);
      return m.query(
        `SELECT actor_user_id, organisation_id, target_user_id, entity_id, action, metadata FROM core.audit_log WHERE action = 'admin.venue_manager_created' AND target_user_id = $1`,
        [createdUserId],
      );
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_user_id: ceo.userId, organisation_id: org.id, target_user_id: createdUserId, action: 'admin.venue_manager_created' });
    expect(rows[0].metadata).toMatchObject({ targetWorkspaceId: wsA, action: 'venue_manager.create', actorUserId: ceo.userId });
    const serialised = JSON.stringify(rows[0].metadata);
    expect(serialised).not.toContain(p.email);
    expect(serialised).not.toMatch(/password|token|hash/i);
  });

  // ------------------------------------------------------------------ 3. the created Venue Manager's own boundary

  it('Venue Manager A logs in and resolves Workspace A, and cannot read Workspace B staff', async () => {
    const vm = await factory.createVenueManager(org, { owner: managerA, label: 'vmBoundary' });
    const bStaff = await factory.createStaff(org, { owner: managerB, label: 'bstaff' });
    const token = await factory.login(vm);
    const me = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(JSON.stringify(me.body)).not.toContain(wsB);
    const direct = await request(app.getHttpServer()).get(`/rest/v1/staff/${bStaff.profileId}`).set('Authorization', `Bearer ${token}`);
    expect(direct.status).toBe(404);
    const list = await request(app.getHttpServer()).get('/rest/v1/staff').set('Authorization', `Bearer ${token}`);
    if (list.status === 200) {
      expect(JSON.stringify(list.body)).not.toContain(bStaff.profileId);
    } else {
      expect([403, 404]).toContain(list.status);
    }
  });

  it('the normal Manager endpoint never trusts a target workspace from the request, even for an admin caller', async () => {
    const ceo = await factory.createInternalManager(org, { permissions: 'production', type: ManagerType.CEO, workspace: false, label: 'ceoNorm' });
    const token = await factory.login(ceo);
    // The CEO has no workspace, so the normal flow must refuse (403), never pick one from the body.
    const res = await post('/rest/v1/venue-managers', token, { ...person(), targetWorkspaceId: wsA, workspaceId: wsA });
    expect([400, 403]).toContain(res.status);
    expect(res.status).not.toBe(201);
  });
});
