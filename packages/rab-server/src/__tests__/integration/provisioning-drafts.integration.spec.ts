/**
 * Phase B P8 / E6 — migrations ProvisionWorkspaceGuards1786721210000 (owner decision B: gates 3, 4, 8) and
 * ProvisioningHealth1786721220000 (owner decision C: the counts-only health definer ONLY, gates 10 and 14; the status-only
 * drift wrapper is deferred as an HWS prerequisite and must NOT exist). Runs on the harness-built database (both migrations
 * applied by the restricted migrator), like every other integration suite. It FAILS LOUDLY — never skips — when either
 * migration is missing (first test).
 *
 * Owner requirements proven here: the COMPLETE real owner workflow (invite Initial Manager -> real activation endpoint ->
 * first owner login -> GET /manager-workspaces/me -> POST /manager-workspaces -> READY) with the owner's core."user".status
 * read at the moment provisioning starts; a suspended organisation and a non-active account are refused at the service and
 * in the function; a platform administrator gets no exemption (the route guard lets them through a suspended organisation,
 * the service and the function still refuse); the worker provisioner's lock keyspace is shared.
 * Real HTTP where the behaviour is the API's; direct SQL as crewflow_app (the runtime role) where it is the function's own;
 * failure injection and catalog reads only through the disposable cluster's superuser connection.
 */
import 'reflect-metadata';
import { ForbiddenException, INestApplication, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { ManagerType } from '@rab/shared';

import { AppModule } from '../../app.module';
import { ProvisionWorkspaceGuards1786721210000 } from '../../database/typeorm/core/migrations/1786721210000-ProvisionWorkspaceGuards';
import { ProvisioningHealth1786721220000 } from '../../database/typeorm/core/migrations/1786721220000-ProvisioningHealth';
import { PROVISION_WORKSPACE_STATE_SQL } from '../../database/typeorm/core/provision-workspace-guards-sql';
import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { PROVISIONING_HEALTH_EXPECTED_STATE, PROVISIONING_HEALTH_STATE_SQL } from '../../database/typeorm/core/workspace-provisioning-health-sql';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { ThrottlerRedisClientProvider } from '../../engine/core-modules/throttler/throttler-redis-client.provider';
import { WORKER_HEARTBEAT_KEY } from '../../engine/worker-shared/heartbeat.constants';
import { Organisation } from '../../modules/identity/entities';
import { ManagerWorkspaceService } from '../../modules/manager-workspace/services/manager-workspace.service';
import { WorkspaceProvisioningService } from '../../modules/manager-workspace/services/workspace-provisioning.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

const { appUrl } = resolveIntegrationTestDatabase(process.env);

describe('Phase B P8 provisioning guards + counts-only health (migrations 1786721210000, 1786721220000)', () => {
  jest.setTimeout(180_000);

  let app: INestApplication;
  let admin: DataSource;
  let runtime: DataSource;
  let factory: TestIdentityFactory;
  let org: Organisation;

  const http = () => request(app.getHttpServer());
  const body = () => {
    const sub = `p8d-${randomUUID().slice(0, 8)}`;
    return { name: `P8D ${sub}`, subdomain: sub };
  };
  const newManager = async (o: Organisation = org): Promise<{ id: TestIdentity; token: string }> => {
    const id = await factory.createInternalManager(o, { permissions: 'production', label: `p8d-${randomUUID().slice(0, 6)}`, workspace: false });
    return { id, token: await factory.login(id) };
  };
  /** A CREATING workspace owned by `m` (create while the function is unavailable to the runtime role). */
  const creatingWorkspace = async (m: { token: string }): Promise<string> => {
    await admin.query(`REVOKE EXECUTE ON FUNCTION core.provision_workspace(uuid) FROM crewflow_app`);
    try {
      const res = await http().post('/rest/v1/manager-workspaces').set('Authorization', `Bearer ${m.token}`).send(body());
      expect(res.body.schemaStatus).toBe('CREATING');
      return res.body.id as string;
    } finally {
      await admin.query(`GRANT EXECUTE ON FUNCTION core.provision_workspace(uuid) TO crewflow_app`);
    }
  };
  /** Runs core.provision_workspace as crewflow_app with the given identity bound; returns the outcome or the SQLSTATE. */
  const provisionAs = async (id: TestIdentity, workspaceId: string): Promise<string> => {
    const runner = runtime.createQueryRunner();
    await runner.startTransaction();
    try {
      await runner.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true)`, [id.organisationId, id.userId]);
      const [row] = await runner.query(`SELECT core.provision_workspace($1) AS outcome`, [workspaceId]);
      await runner.commitTransaction();
      return row.outcome as string;
    } catch (error) {
      await runner.rollbackTransaction();
      return `SQLSTATE ${(error as { code?: string; driverError?: { code?: string } }).driverError?.code ?? (error as { code?: string }).code}`;
    } finally {
      await runner.release();
    }
  };
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const ctxOf = (id: TestIdentity, extra: Partial<AuthContext> = {}): AuthContext =>
    ({ organisationId: id.organisationId, workspaceId: null, userId: id.userId, role: 'manager', ...extra }) as AuthContext;
  const schemaStatus = async (workspaceId: string) =>
    ((await admin.query(`SELECT schema_status FROM core.manager_workspace WHERE id = $1`, [workspaceId])) as Array<{ schema_status: string }>)[0]?.schema_status;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    runtime = app.get(DataSource);
    admin = createAdminDataSource();
    await admin.initialize();
    factory = new TestIdentityFactory({ app, dataSource: runtime, adminDataSource: admin, tenantContext: app.get(TenantContextService), passwordHashing: app.get(PasswordHashingService) });
    org = await factory.createOrganisation('p8-drafts');
    // Invitation e-mail is queued only while a Worker heartbeat is fresh (same as initial-manager-invitation.integration.spec.ts).
    await app.get(ThrottlerRedisClientProvider).client.set(WORKER_HEARTBEAT_KEY, Date.now().toString(), 'EX', 300);
    const [{ current_user: who }] = await runtime.query('SELECT current_user');
    expect(who).toBe('crewflow_app');
  }, 180_000);

  afterAll(async () => {
    await admin?.query(`GRANT EXECUTE ON FUNCTION core.provision_workspace(uuid) TO crewflow_app`).catch(() => undefined);
    await admin?.destroy();
    await app?.close();
  });

  it('both migrations are applied with the reviewed shape (fails loudly, never skips); the deferred drift wrapper does not exist', async () => {
    const [guards] = await admin.query(PROVISION_WORKSPACE_STATE_SQL);
    expect(guards).toMatchObject({ owner: 'crewflow', definer: true, path_ok: true, lock_timeout_ok: true, executors: 'crewflow,crewflow_app', is_guarded_body: true, has_guards: true });
    expect(await admin.query(PROVISIONING_HEALTH_STATE_SQL)).toEqual([...PROVISIONING_HEALTH_EXPECTED_STATE]);
    const [{ n }] = await admin.query(`SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace = 'core'::regnamespace AND proname = 'worker_record_workspace_schema_drift'`);
    expect(n).toBe(0);
    const ledger = await admin.query(`SELECT name FROM core.migrations WHERE name IN ('ProvisionWorkspaceGuards1786721210000', 'ProvisioningHealth1786721220000', 'DeploymentIdentity1786721200000') ORDER BY name`);
    expect(ledger.map((r: { name: string }) => r.name)).toEqual(['ProvisionWorkspaceGuards1786721210000', 'ProvisioningHealth1786721220000']);
    // Template + FORCE RLS preserved: the workspace-schema registry the function writes stays FORCE.
    const [reg] = await admin.query(`SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class WHERE oid = 'core.workspace_schema_registry'::regclass`);
    expect(reg).toEqual({ enabled: true, forced: true });
  });

  describe('the COMPLETE real owner workflow (owner decision B): invite -> activation -> first login -> preparation -> READY', () => {
    it('the owner is ACTIVE at the moment provisioning starts, and the guarded function builds READY in that same request', async () => {
      const target = await factory.createOrganisation('p8d-real-flow');
      const ceo = await factory.createInternalManager(target, { permissions: 'all', type: ManagerType.CEO, label: 'p8d-ceo' });
      const ceoToken = await factory.loginByEmail(ceo.email);
      const email = `im-${Date.now()}-p8d@example.test`;

      // 1. Invite the Initial Manager (real endpoint).
      const invited = await http().post('/rest/v1/managers/initial-manager-invite').set(auth(ceoToken)).send({ email, firstName: 'Ina', lastName: 'Owner' });
      expect(invited.status).toBe(201);
      const [user] = await admin.query(`SELECT id, status FROM core."user" WHERE organisation_id = $1 AND email = $2`, [target.id, email]);
      expect(user.status).toBe('invited');
      expect(await admin.query(`SELECT id FROM core.manager_workspace WHERE owner_user_id = $1`, [user.id])).toEqual([]);

      // 2. Account activation through the REAL activation endpoint, with the token from the queued invitation e-mail.
      const [invite] = await admin.query(`SELECT id FROM core.account_invite WHERE user_id = $1`, [user.id]);
      const [outbox] = await admin.query(`SELECT rendered_html FROM core.email_outbox WHERE account_invite_id = $1`, [invite.id]);
      const token = /token=([a-f0-9]+)/.exec(outbox.rendered_html)?.[1];
      expect(token).toBeDefined();
      expect((await http().post('/rest/v1/auth/activate-account').send({ token, newPassword: 'InitialOwner1!' })).status).toBe(200);
      const [afterActivation] = await admin.query(`SELECT status FROM core."user" WHERE id = $1`, [user.id]);

      // 3. First owner login.
      const login = await http().post('/rest/v1/auth/login').send({ email, password: 'InitialOwner1!', applicationTarget: 'manager_web' });
      expect(login.status).toBe(200);
      const access = login.body.accessToken as string;
      // The real flow: activate-account only sets the password (status stays 'invited'); the FIRST successful login is the
      // one place an account becomes 'active' (AuthService.login, invited -> active, audited). Provisioning needs a signed-in
      // session, so it can only ever start after that transition.
      const [afterLogin] = await admin.query(`SELECT status FROM core."user" WHERE id = $1`, [user.id]);

      // 4. Preparation: the web gate's GET me (no workspace yet), then POST create — which provisions in the same request.
      expect((await http().get('/rest/v1/manager-workspaces/me').set(auth(access))).status).toBe(404);
      const provisioning = app.get(WorkspaceProvisioningService, { strict: false });
      const original = provisioning.provisionOwnWorkspace.bind(provisioning);
      const statusAtStart: Array<{ status: string; organisation_active: boolean }> = [];
      const spy = jest.spyOn(provisioning, 'provisionOwnWorkspace').mockImplementation(async (ctx: AuthContext, workspaceId: string) => {
        // The owner's account and organisation state at the exact moment provisioning starts (just before the call).
        const [row] = await admin.query(
          `SELECT u.status, o.suspended_at IS NULL AS organisation_active FROM core."user" u JOIN core.organisation o ON o.id = u.organisation_id WHERE u.id = $1`,
          [ctx.userId],
        );
        statusAtStart.push(row);
        return original(ctx, workspaceId);
      });
      let created: request.Response;
      try {
        const sub = `p8d-${randomUUID().slice(0, 8)}`;
        created = await http().post('/rest/v1/manager-workspaces').set(auth(access)).send({ name: `P8D ${sub}`, subdomain: sub });
      } finally {
        spy.mockRestore();
      }
      // eslint-disable-next-line no-console
      console.log(`[p8d real-flow evidence] status after activation=${afterActivation.status}; after first login=${afterLogin.status}; at provisioning start=${JSON.stringify(statusAtStart)}; create=${created.status} ${created.body.schemaStatus}`);
      expect(afterActivation.status).toBe('invited');
      expect(afterLogin.status).toBe('active');
      expect(statusAtStart).toEqual([{ status: 'active', organisation_active: true }]);
      expect(created.status).toBe(201);
      // READY can only come from the guarded function, which itself refuses a non-active owner (CWP02) in this transaction.
      expect(created.body.schemaStatus).toBe('READY');
      expect(await schemaStatus(created.body.id)).toBe('READY');
      const [audit] = await admin.query(
        `SELECT count(*)::int AS n FROM core.audit_log WHERE entity_id = $1 AND action = 'manager_workspace.provisioned'`,
        [created.body.id],
      );
      expect(audit.n).toBe(1);
      const me = await http().get('/rest/v1/manager-workspaces/me?fresh=1').set(auth(access));
      expect(me.body).toMatchObject({ id: created.body.id, schemaStatus: 'READY' });
    });
  });

  describe('platform administrators get NO exemption (owner decision B)', () => {
    it('suspended organisation: the guard lets a platform admin through, the service refuses (403) and so does the function (CWP01)', async () => {
      const suspendedOrg = await factory.createOrganisation('p8d-pa-suspended');
      const pa = await newManager(suspendedOrg);
      await factory.grantPlatformAdmin(pa.id.userId);
      const ws = await creatingWorkspace(pa);
      await admin.query(`UPDATE core.organisation SET suspended_at = now(), suspended_by = $2, suspended_reason = 'p8 platform admin' WHERE id = $1`, [suspendedOrg.id, pa.id.userId]);
      try {
        // Route: past OrganisationSuspendedGuard (platform-admin exemption) — refused by the SERVICE, not the guard (401).
        const sub = `p8d-${randomUUID().slice(0, 8)}`;
        const res = await http().post('/rest/v1/manager-workspaces').set(auth(pa.token)).send({ name: `P8D ${sub}`, subdomain: sub });
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code: 'ORGANISATION_SUSPENDED' });
        // Service, as a platform admin (no guard at all).
        const service = app.get(ManagerWorkspaceService, { strict: false });
        const provisioning = app.get(WorkspaceProvisioningService, { strict: false });
        const asAdmin = ctxOf(pa.id, { isPlatformAdmin: true } as Partial<AuthContext>);
        const createError = await service.create(asAdmin, { name: 'P8D admin', subdomain: `p8d-${randomUUID().slice(0, 8)}` }).catch((e) => e);
        expect(createError).toBeInstanceOf(ForbiddenException);
        expect(createError.getResponse()).toMatchObject({ code: 'ORGANISATION_SUSPENDED' });
        const provisionError = await provisioning.provisionOwnWorkspace(asAdmin, ws).catch((e) => e);
        expect(provisionError).toBeInstanceOf(ForbiddenException);
        // The function itself, as crewflow_app with the platform admin's identity bound.
        expect(await provisionAs(pa.id, ws)).toBe('SQLSTATE CWP01');
        expect(await schemaStatus(ws)).toBe('CREATING');
      } finally {
        await admin.query(`UPDATE core.organisation SET suspended_at = NULL, suspended_by = NULL, suspended_reason = NULL WHERE id = $1`, [suspendedOrg.id]);
        await admin.query(`DELETE FROM core.platform_admin WHERE user_id = $1`, [pa.id.userId]);
      }
    });

    it('a platform admin whose own account is not active is refused by the service (403) and the function (CWP02)', async () => {
      const pa = await newManager();
      await factory.grantPlatformAdmin(pa.id.userId);
      const ws = await creatingWorkspace(pa);
      try {
        await admin.query(`UPDATE core."user" SET status = 'suspended' WHERE id = $1`, [pa.id.userId]);
        const provisioning = app.get(WorkspaceProvisioningService, { strict: false });
        const error = await provisioning.provisionOwnWorkspace(ctxOf(pa.id, { isPlatformAdmin: true } as Partial<AuthContext>), ws).catch((e) => e);
        expect(error).toBeInstanceOf(ForbiddenException);
        expect(error.getResponse()).toMatchObject({ code: 'ACCOUNT_NOT_ACTIVE' });
        expect(await provisionAs(pa.id, ws)).toBe('SQLSTATE CWP02');
        expect(await schemaStatus(ws)).toBe('CREATING');
      } finally {
        await admin.query(`DELETE FROM core.platform_admin WHERE user_id = $1`, [pa.id.userId]);
      }
    });

    it('a platform admin cannot provision ANOTHER owner\'s workspace: P0002 / 404, never a 403 that confirms it exists', async () => {
      const victim = await newManager();
      const ws = await creatingWorkspace(victim);
      const pa = await newManager();
      await factory.grantPlatformAdmin(pa.id.userId);
      try {
        expect(await provisionAs(pa.id, ws)).toBe('SQLSTATE P0002');
        const provisioning = app.get(WorkspaceProvisioningService, { strict: false });
        await expect(provisioning.provisionOwnWorkspace(ctxOf(pa.id, { isPlatformAdmin: true } as Partial<AuthContext>), ws)).rejects.toBeInstanceOf(NotFoundException);
        expect(await schemaStatus(ws)).toBe('CREATING');
      } finally {
        await admin.query(`DELETE FROM core.platform_admin WHERE user_id = $1`, [pa.id.userId]);
      }
    });
  });

  describe('non-active statuses at the service layer (owner decision B: only ACTIVE owner accounts provision)', () => {
    it.each(['invited', 'suspended', 'deactivated'])('status %s: service 403 ACCOUNT_NOT_ACTIVE and function CWP02, nothing built', async (status) => {
      const m = await newManager();
      const ws = await creatingWorkspace(m);
      await admin.query(`UPDATE core."user" SET status = $2 WHERE id = $1`, [m.id.userId, status]);
      const provisioning = app.get(WorkspaceProvisioningService, { strict: false });
      const error = await provisioning.provisionOwnWorkspace(ctxOf(m.id), ws).catch((e) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error.getResponse()).toMatchObject({ code: 'ACCOUNT_NOT_ACTIVE' });
      expect(await provisionAs(m.id, ws)).toBe('SQLSTATE CWP02');
      expect(await schemaStatus(ws)).toBe('CREATING');
    });
  });

  describe('guarded core.provision_workspace (gates 3, 4)', () => {
    it('suspended organisation: CWP01 from the function itself, nothing built; HTTP answers 401 (guard) / the service 403', async () => {
      const suspended = await factory.createOrganisation('p8d-suspended');
      const m = await newManager(suspended);
      const ws = await creatingWorkspace(m);
      await admin.query(`UPDATE core.organisation SET suspended_at = now(), suspended_by = $2, suspended_reason = 'p8 drafts' WHERE id = $1`, [suspended.id, m.id.userId]);
      try {
        expect(await provisionAs(m.id, ws)).toBe('SQLSTATE CWP01');
        expect(await schemaStatus(ws)).toBe('CREATING');
      } finally {
        await admin.query(`UPDATE core.organisation SET suspended_at = NULL, suspended_by = NULL, suspended_reason = NULL WHERE id = $1`, [suspended.id]);
      }
      expect(await provisionAs(m.id, ws)).toBe('READY');
    });

    it('account not active: CWP02, nothing built', async () => {
      const m = await newManager();
      const ws = await creatingWorkspace(m);
      await admin.query(`UPDATE core."user" SET status = 'deactivated' WHERE id = $1`, [m.id.userId]);
      expect(await provisionAs(m.id, ws)).toBe('SQLSTATE CWP02');
      expect(await schemaStatus(ws)).toBe('CREATING');
    });

    it('a foreign id is still P0002 (no suspension disclosure), and the victim is untouched', async () => {
      const victim = await newManager();
      const ws = await creatingWorkspace(victim);
      const attacker = await newManager();
      await admin.query(`UPDATE core."user" SET status = 'deactivated' WHERE id = $1`, [attacker.id.userId]);
      expect(await provisionAs(attacker.id, ws)).toBe('SQLSTATE P0002');
      expect(await schemaStatus(ws)).toBe('CREATING');
    });
  });

  describe('one advisory-lock keyspace with the worker provisioner (gate 8)', () => {
    it('a worker cycle holding its session lock makes the API wait; releasing it lets the same request finish READY', async () => {
      const m = await newManager();
      const ws = await creatingWorkspace(m);
      const worker = new Client({ connectionString: appUrl });
      await worker.connect();
      try {
        // Exactly the worker provisioner's statement (workspace-provisioning.job.ts).
        const [{ locked }] = (await worker.query(`SELECT pg_try_advisory_lock(hashtext('rab_workspace_provisioning')) AS locked`)).rows;
        expect(locked).toBe(true);
        const pending = provisionAs(m.id, ws);
        await new Promise((r) => setTimeout(r, 1_500));
        const waiting = await admin.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND mode = 'ShareLock'`);
        expect(waiting[0].n).toBeGreaterThanOrEqual(1);
        expect(await schemaStatus(ws)).toBe('CREATING');
        await worker.query(`SELECT pg_advisory_unlock(hashtext('rab_workspace_provisioning'))`);
        expect(await pending).toBe('READY');
      } finally {
        await worker.end();
      }
    });

    it('while any API provisioning holds the shared lock, the worker\'s non-blocking try-lock fails (it skips its tick)', async () => {
      const runner = runtime.createQueryRunner();
      const worker = new Client({ connectionString: appUrl });
      await worker.connect();
      await runner.startTransaction();
      try {
        await runner.query(`SELECT pg_advisory_xact_lock_shared(hashtext('rab_workspace_provisioning')::bigint)`);
        const [{ locked }] = (await worker.query(`SELECT pg_try_advisory_lock(hashtext('rab_workspace_provisioning')) AS locked`)).rows;
        expect(locked).toBe(false);
      } finally {
        await runner.rollbackTransaction();
        await runner.release();
        await worker.end();
      }
    });
  });

  describe('counts-only health definer (gates 10, 14)', () => {
    it('counts stale CREATING (> 10 min) and FAILED across organisations; never a fresh CREATING, READY, NULL or SUPERSEDED row', async () => {
      const before = (await runtime.query(`SELECT creating_over_10_min, failed FROM core.worker_workspace_provisioning_health()`))[0];
      const otherOrg = await factory.createOrganisation('p8d-health-other');
      const stale = await newManager(otherOrg);
      const staleWs = await creatingWorkspace(stale);
      await admin.query(`UPDATE core.manager_workspace SET created_at = now() - interval '20 minutes' WHERE id = $1`, [staleWs]);
      const fresh = await newManager();
      await creatingWorkspace(fresh);
      const failed = await newManager();
      const failedWs = await creatingWorkspace(failed);
      await admin.query(`UPDATE core.manager_workspace SET schema_status = 'FAILED' WHERE id = $1`, [failedWs]);

      const [after] = await runtime.query(`SELECT creating_over_10_min, failed FROM core.worker_workspace_provisioning_health()`);
      expect(Object.keys(after).sort()).toEqual(['creating_over_10_min', 'failed']);
      expect(after.creating_over_10_min - before.creating_over_10_min).toBe(1);
      expect(after.failed - before.failed).toBe(1);
      // Without the definer the runtime role sees no workspace at all (fail closed, no tenant context).
      const [{ n }] = await runtime.query(`SELECT count(*)::int AS n FROM core.manager_workspace`);
      expect(n).toBe(0);
    });

    it('EXECUTE: crewflow_app only (never PUBLIC, never crewflow); the crewflow-only drift recorder stays out of crewflow_app reach', async () => {
      const [row] = await admin.query(`
        SELECT has_function_privilege('crewflow_app', 'core.worker_workspace_provisioning_health()', 'EXECUTE') AS app,
               has_function_privilege('crewflow', 'core.worker_workspace_provisioning_health()', 'EXECUTE') AS crewflow,
               has_function_privilege('crewflow_app', 'core.record_workspace_schema_drift(uuid)', 'EXECUTE') AS recorder_app,
               (SELECT proacl::text FROM pg_proc WHERE oid = 'core.worker_workspace_provisioning_health()'::regprocedure) !~ '(^|[{,])=X' AS no_public`);
      expect(row).toEqual({ app: true, crewflow: false, recorder_app: false, no_public: true });
    });

    it('returns exactly two integer columns and takes no argument (no identifier can leave, no row can be selected)', async () => {
      const cols = await admin.query(`
        SELECT u.n AS name, format_type(u.t, NULL) AS type
          FROM pg_proc p, unnest(p.proallargtypes, p.proargnames) WITH ORDINALITY AS u(t, n, o)
         WHERE p.oid = 'core.worker_workspace_provisioning_health()'::regprocedure ORDER BY u.o`);
      expect(cols).toEqual([{ name: 'creating_over_10_min', type: 'integer' }, { name: 'failed', type: 'integer' }]);
      const [{ nargs }] = await admin.query(`SELECT pronargs::int AS nargs FROM pg_proc WHERE oid = 'core.worker_workspace_provisioning_health()'::regprocedure`);
      expect(nargs).toBe(0);
    });
  });

  describe('down() / up() round trip (restricted to a rolled-back transaction)', () => {
    it('down() restores the 1786721090000 body and drops the health definer; up() re-applies; the privilege shape holds throughout', async () => {
      const runner = admin.createQueryRunner();
      await runner.startTransaction();
      try {
        await new ProvisioningHealth1786721220000().down(runner);
        await new ProvisionWorkspaceGuards1786721210000().down(runner);
        const [restored] = await runner.query(PROVISION_WORKSPACE_STATE_SQL);
        expect(restored).toMatchObject({ is_previous_body: true, is_guarded_body: false, has_guards: false, executors: 'crewflow,crewflow_app' });
        expect(await runner.query(PROVISIONING_HEALTH_STATE_SQL)).toEqual([]);

        await new ProvisionWorkspaceGuards1786721210000().up(runner);
        await new ProvisioningHealth1786721220000().up(runner);
        const [reapplied] = await runner.query(PROVISION_WORKSPACE_STATE_SQL);
        expect(reapplied).toMatchObject({ is_guarded_body: true, has_guards: true, executors: 'crewflow,crewflow_app' });
        expect(await runner.query(PROVISIONING_HEALTH_STATE_SQL)).toEqual([...PROVISIONING_HEALTH_EXPECTED_STATE]);
      } finally {
        await runner.rollbackTransaction();
        await runner.release();
      }
    });
  });
});
