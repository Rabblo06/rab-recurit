import 'reflect-metadata';
import { ManagerType } from '@rab/shared';
import { ForbiddenException, INestApplication, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { ThrottlerRedisClientProvider } from '../../engine/core-modules/throttler/throttler-redis-client.provider';
import { WORKER_HEARTBEAT_KEY } from '../../engine/worker-shared/heartbeat.constants';
import { Organisation } from '../../modules/identity/entities';
import { ManagerWorkspaceService } from '../../modules/manager-workspace/services/manager-workspace.service';
import { WorkspaceProvisioningService } from '../../modules/manager-workspace/services/workspace-provisioning.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Phase B P8 — the owner's own request is the only provisioning path (no privileged background builder):
 *  1. Initial Manager: invite creates NO workspace row; an owner who never signs in has none (nothing to strand); after
 *     activation + sign-in the owner reaches onboarding (GET me = 404), creates, and the same request provisions READY.
 *  2. HWS_RUNTIME_ENABLED=true (inv-p8 finding 4): an owner whose session already routes through its own CREATING
 *     workspace can poll (GET me), complete the profile step and resume (re-POST) — never a 404 — and `schemaRequired`
 *     (navigation only) is true exactly then; false with HWS off.
 *  3. Backend permissions hold whatever the navigation says: a non-owner cannot create/resume/provision someone else's
 *     workspace; a suspended organisation or an inactive account is refused at the SERVICE layer (no guard involved).
 *  4. The create / resume route has its own throttle (429).
 * Real HTTP, real JWT auth, the restricted runtime role (crewflow_app); failure injection only through the disposable
 * database's superuser connection.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('workspace provisioning — owner-driven flow (Phase B P8)', () => {
  jest.setTimeout(180_000);

  let app: INestApplication;
  let admin: DataSource;
  let factory: TestIdentityFactory;
  let org: Organisation;
  let environment: EnvironmentService;
  let hwsOn = false;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const body = () => {
    const sub = `p8-${randomUUID().slice(0, 8)}`;
    return { name: `P8 ${sub}`, subdomain: sub };
  };
  const newManager = async (o: Organisation = org): Promise<{ id: TestIdentity; token: string }> => {
    const id = await factory.createInternalManager(o, { permissions: 'production', label: `p8-${randomUUID().slice(0, 6)}`, workspace: false });
    return { id, token: await factory.login(id) };
  };
  const workspaceRows = async (userId: string) =>
    (await admin.query(`SELECT id, schema_status FROM core.manager_workspace WHERE owner_user_id = $1`, [userId])) as Array<{ id: string; schema_status: string }>;
  const withProvisioningUnavailable = async <T>(fn: () => Promise<T>): Promise<T> => {
    // The function is unavailable (e.g. mid-rollback): create answers CREATING (DEFERRED) and nothing is built.
    await admin.query(`REVOKE EXECUTE ON FUNCTION core.provision_workspace(uuid) FROM crewflow_app`);
    try {
      return await fn();
    } finally {
      await admin.query(`GRANT EXECUTE ON FUNCTION core.provision_workspace(uuid) TO crewflow_app`);
    }
  };
  const ctxOf = (id: TestIdentity, workspaceId: string | null = null): AuthContext => ({
    organisationId: id.organisationId,
    workspaceId,
    userId: id.userId,
    role: 'manager',
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    admin = createAdminDataSource();
    await admin.initialize();
    factory = new TestIdentityFactory({
      app,
      dataSource: app.get(DataSource),
      adminDataSource: admin,
      tenantContext: app.get(TenantContextService),
      passwordHashing: app.get(PasswordHashingService),
    });
    org = await factory.createOrganisation('p8-owner-flow');
    // Invitation e-mail is queued only while a Worker heartbeat is fresh (same as initial-manager-invitation.integration.spec.ts).
    await app.get(ThrottlerRedisClientProvider).client.set(WORKER_HEARTBEAT_KEY, Date.now().toString(), 'EX', 300);
    // HWS_RUNTIME_ENABLED is read per call (TenantContextService, ManagerWorkspaceService): toggle it per test on the one
    // shared EnvironmentService instance, exactly as the real env var would set it at boot.
    environment = app.get(EnvironmentService);
    const realGet = environment.get.bind(environment) as (key: string) => unknown;
    jest.spyOn(environment, 'get').mockImplementation(((key: string) => (key === 'HWS_RUNTIME_ENABLED' ? hwsOn : realGet(key))) as never);
    const [{ current_user: who }] = await app.get(DataSource).query('SELECT current_user');
    expect(who).toBe('crewflow_app');
  }, 180_000);

  afterEach(() => {
    hwsOn = false;
  });

  afterAll(async () => {
    await admin?.query(`GRANT EXECUTE ON FUNCTION core.provision_workspace(uuid) TO crewflow_app`).catch(() => undefined);
    await admin?.destroy();
    await app?.close();
  });

  describe('1. Initial Manager: provisioned only by the owner\'s own request', () => {
    it('invite → no workspace row; never signed in → still none; activate → sign in → onboarding → POST create → READY', async () => {
      const target = await factory.createOrganisation('p8-im');
      const ceo = await factory.createInternalManager(target, { permissions: 'all', type: ManagerType.CEO, label: 'p8-ceo' });
      const ceoToken = await factory.loginByEmail(ceo.email);
      const suffix = `${Date.now()}-p8`;
      const email = `im-${suffix}@example.test`;

      const invited = await http().post('/rest/v1/managers/initial-manager-invite').set(auth(ceoToken)).send({ email, firstName: 'Ida', lastName: 'Manager' });
      expect(invited.status).toBe(201);
      const [user] = await admin.query(`SELECT id, status FROM core."user" WHERE organisation_id = $1 AND email = $2`, [target.id, email]);
      expect(user.status).toBe('invited');
      // Nothing to strand: an owner who never signs in has NO workspace row (not a CREATING one), so the stuck-workspace
      // alert never counts an un-activated invitation.
      expect(await workspaceRows(user.id)).toEqual([]);

      const [invite] = await admin.query(`SELECT id FROM core.account_invite WHERE user_id = $1`, [user.id]);
      const [outbox] = await admin.query(`SELECT rendered_html FROM core.email_outbox WHERE account_invite_id = $1`, [invite.id]);
      const token = /token=([a-f0-9]+)/.exec(outbox.rendered_html)?.[1];
      expect(token).toBeDefined();
      expect((await http().post('/rest/v1/auth/activate-account').send({ token, newPassword: 'InitialMgr1!' })).status).toBe(200);
      const login = await http().post('/rest/v1/auth/login').send({ email, password: 'InitialMgr1!', applicationTarget: 'manager_web' });
      expect(login.status).toBe(200);
      const access = login.body.accessToken as string;

      // The web gate's first step: no workspace yet → /onboarding/workspace.
      expect((await http().get('/rest/v1/manager-workspaces/me').set(auth(access))).status).toBe(404);
      const b = body();
      const created = await http().post('/rest/v1/manager-workspaces').set(auth(access)).send(b);
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ schemaStatus: 'READY', schemaRequired: false });
      expect((await http().post('/rest/v1/manager-workspaces/me/complete-onboarding').set(auth(access))).status).toBe(200);
      const me = await http().get('/rest/v1/manager-workspaces/me?fresh=1').set(auth(access));
      expect(me.body).toMatchObject({ id: created.body.id, schemaStatus: 'READY', schemaRequired: false });
      expect(await workspaceRows(user.id)).toEqual([{ id: created.body.id, schema_status: 'READY' }]);
    });
  });

  describe('2. HWS_RUNTIME_ENABLED=true: poll, profile step and resume never 404 for the owner of a CREATING workspace', () => {
    it('CREATING (deferred) → GET me 200 schemaRequired=true → complete-onboarding 200 → resume re-POST → READY', async () => {
      hwsOn = true;
      const m = await newManager();
      const b = body();
      const first = await withProvisioningUnavailable(() => http().post('/rest/v1/manager-workspaces').set(auth(m.token)).send(b));
      expect(first.status).toBe(201);
      expect(first.body.schemaStatus).toBe('CREATING');
      // This very request bound the workspace as the internal Manager's operational home.
      expect(first.body.schemaRequired).toBe(true);

      // The session now routes through the CREATING workspace (membership). Before P8 both of these were 404.
      const polled = await http().get('/rest/v1/manager-workspaces/me?fresh=1').set(auth(m.token));
      expect(polled.status).toBe(200);
      expect(polled.body).toMatchObject({ id: first.body.id, schemaStatus: 'CREATING', schemaRequired: true });
      const profileDone = await http().post('/rest/v1/manager-workspaces/me/complete-onboarding').set(auth(m.token));
      expect(profileDone.status).toBe(200);
      expect(profileDone.body).toMatchObject({ schemaStatus: 'CREATING', schemaRequired: true });

      // The owner's own resume (the preparation screen re-POSTs the same body).
      const resumed = await http().post('/rest/v1/manager-workspaces').set(auth(m.token)).send(b);
      expect(resumed.status).toBe(201);
      expect(resumed.body).toMatchObject({ id: first.body.id, schemaStatus: 'READY', schemaRequired: true });
      const after = await http().get('/rest/v1/manager-workspaces/me?fresh=1').set(auth(m.token));
      expect(after.body).toMatchObject({ schemaStatus: 'READY', schemaRequired: true });
      expect(await workspaceRows(m.id.userId)).toEqual([{ id: first.body.id, schema_status: 'READY' }]);
    });

    it('HWS off: the same CREATING workspace reports schemaRequired=false (console access unchanged, no redirect)', async () => {
      const m = await newManager();
      const created = await withProvisioningUnavailable(() => http().post('/rest/v1/manager-workspaces').set(auth(m.token)).send(body()));
      expect(created.body).toMatchObject({ schemaStatus: 'CREATING', schemaRequired: false });
      const me = await http().get('/rest/v1/manager-workspaces/me?fresh=1').set(auth(m.token));
      expect(me.body).toMatchObject({ schemaStatus: 'CREATING', schemaRequired: false });
    });
  });

  describe('3. backend permissions are enforced independently of navigation', () => {
    it('a non-owner cannot see, create into, resume or provision another owner\'s workspace', async () => {
      const owner = await newManager();
      const b = body();
      const created = await withProvisioningUnavailable(() => http().post('/rest/v1/manager-workspaces').set(auth(owner.token)).send(b));
      expect(created.body.schemaStatus).toBe('CREATING');

      // Staff: every route answers as if it did not exist; nothing is written.
      const staff = await factory.createStaff(org, { owner: { userId: owner.id.userId, workspaceId: created.body.id }, label: 'p8-staff' });
      const staffToken = await factory.login(staff);
      // A Staff session is refused by application access (403) before the route; never a workspace answer.
      expect([403, 404]).toContain((await http().get('/rest/v1/manager-workspaces/me').set(auth(staffToken))).status);
      expect([401, 403, 404]).toContain((await http().post('/rest/v1/manager-workspaces').set(auth(staffToken)).send(b)).status);
      expect(await workspaceRows(staff.userId)).toEqual([]);

      // Another Manager replaying the owner's exact body (what a forged "resume" would look like): a conflict, never a resume.
      const other = await newManager();
      const replay = await http().post('/rest/v1/manager-workspaces').set(auth(other.token)).send(b);
      expect(replay.status).toBe(409);
      expect(await workspaceRows(other.id.userId)).toEqual([]);

      // The service called directly (no guard, no navigation): another user's workspace id is 404, nothing is built.
      const provisioning = app.get(WorkspaceProvisioningService, { strict: false });
      await expect(provisioning.provisionOwnWorkspace(ctxOf(other.id), created.body.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(provisioning.provisionOwnWorkspace(ctxOf(staff), created.body.id)).rejects.toBeInstanceOf(NotFoundException);
      expect(await workspaceRows(owner.id.userId)).toEqual([{ id: created.body.id, schema_status: 'CREATING' }]);
    });

    it('suspended organisation: refused at the service layer (403) for create AND provision, workspace untouched', async () => {
      const suspendedOrg = await factory.createOrganisation('p8-suspended');
      const m = await newManager(suspendedOrg);
      const b = body();
      const created = await withProvisioningUnavailable(() => http().post('/rest/v1/manager-workspaces').set(auth(m.token)).send(b));
      expect(created.body.schemaStatus).toBe('CREATING');
      await admin.query(`UPDATE core.organisation SET suspended_at = now(), suspended_by = $2, suspended_reason = 'p8 test' WHERE id = $1`, [suspendedOrg.id, m.id.userId]);
      try {
        // HTTP: the guard layer already refuses.
        expect((await http().post('/rest/v1/manager-workspaces').set(auth(m.token)).send(b)).status).toBe(401);
        // Service layer, reached without any guard (a job / CLI / another service).
        const service = app.get(ManagerWorkspaceService, { strict: false });
        const provisioning = app.get(WorkspaceProvisioningService, { strict: false });
        const createError = await service.create(ctxOf(m.id), b).catch((e) => e);
        expect(createError).toBeInstanceOf(ForbiddenException);
        expect(createError.getResponse()).toMatchObject({ code: 'ORGANISATION_SUSPENDED' });
        await expect(provisioning.provisionOwnWorkspace(ctxOf(m.id), created.body.id)).rejects.toBeInstanceOf(ForbiddenException);
        expect(await workspaceRows(m.id.userId)).toEqual([{ id: created.body.id, schema_status: 'CREATING' }]);
      } finally {
        await admin.query(`UPDATE core.organisation SET suspended_at = NULL, suspended_by = NULL, suspended_reason = NULL WHERE id = $1`, [suspendedOrg.id]);
      }
    });

    it('inactive account: refused at the service layer (403), workspace untouched', async () => {
      const m = await newManager();
      const created = await withProvisioningUnavailable(() => http().post('/rest/v1/manager-workspaces').set(auth(m.token)).send(body()));
      await admin.query(`UPDATE core."user" SET status = 'suspended' WHERE id = $1`, [m.id.userId]);
      const provisioning = app.get(WorkspaceProvisioningService, { strict: false });
      const error = await provisioning.provisionOwnWorkspace(ctxOf(m.id), created.body.id).catch((e) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error.getResponse()).toMatchObject({ code: 'ACCOUNT_NOT_ACTIVE' });
      expect(await workspaceRows(m.id.userId)).toEqual([{ id: created.body.id, schema_status: 'CREATING' }]);
    });
  });

  describe('4. route throttle on create / resume', () => {
    it('more than 10 requests a minute from one client get 429', async () => {
      // A Manager who already owns a workspace: every create with a different body is a cheap 409 (no DDL) — until the cap.
      const owner = await factory.createInternalManager(org, { permissions: 'production', label: 'p8-throttle' });
      const ownerToken = await factory.login(owner);
      // Start from an empty window for this route (a re-run within 60 s would otherwise inherit the previous run's hits).
      // Key format: @nestjs/throttler generateKey + @nest-lab/throttler-storage-redis increment.
      const redis = app.get(ThrottlerRedisClientProvider).client;
      for (const ip of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) {
        const key = createHash('sha256').update(`ManagerWorkspaceController-create-default-${ip}`).digest('hex');
        await redis.del(`{${key}:default}:hits`, `{${key}:default}:blocked`);
      }
      const previous = process.env.RAB_DISABLE_RATE_LIMIT;
      process.env.RAB_DISABLE_RATE_LIMIT = 'false';
      try {
        const statuses: number[] = [];
        for (let i = 0; i < 11; i++) statuses.push((await http().post('/rest/v1/manager-workspaces').set(auth(ownerToken)).send(body())).status);
        expect(statuses.slice(0, 10)).toEqual(Array(10).fill(409));
        expect(statuses[10]).toBe(429);
      } finally {
        if (previous === undefined) delete process.env.RAB_DISABLE_RATE_LIMIT;
        else process.env.RAB_DISABLE_RATE_LIMIT = previous;
      }
    });
  });
});
