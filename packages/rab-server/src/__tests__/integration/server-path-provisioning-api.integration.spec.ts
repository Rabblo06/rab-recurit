import 'reflect-metadata';
import { INestApplication, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { Organisation } from '../../modules/identity/entities';
import { WorkspaceProvisioningService } from '../../modules/manager-workspace/services/workspace-provisioning.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Server-path workspace provisioning — SERVER layer (owner's brief §13). The real HTTP route `POST
 * /rest/v1/manager-workspaces`, real JWT auth, the real restricted runtime DataSource (`crewflow_app`), two independent
 * Nest application instances standing in for two API replicas, and failure injection done only from the disposable
 * database's superuser connection. No mocks of the provisioning path.
 */
// Needs core.provision_workspace (migration 1786719500000), which every database migrated from the chain now has.
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('server-path workspace provisioning — API layer (two replicas, crewflow_app)', () => {
  jest.setTimeout(180_000);

  let replicaA: INestApplication;
  let replicaB: INestApplication;
  let admin: DataSource;
  let factory: TestIdentityFactory;
  let org: Organisation;
  let otherOrg: Organisation;
  const { adminUrl } = RUN ? resolveIntegrationTestDatabase(process.env) : ({} as never);

  const boot = async (): Promise<INestApplication> => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    return app;
  };

  const newManager = async (o: Organisation = org): Promise<{ id: TestIdentity; token: string }> => {
    const id = await factory.createInternalManager(o, { permissions: 'production', label: `spp-${randomUUID().slice(0, 6)}`, workspace: false });
    return { id, token: await factory.login(id) };
  };

  const post = (app: INestApplication, token: string, body: Record<string, unknown>) =>
    request(app.getHttpServer()).post('/rest/v1/manager-workspaces').set('Authorization', `Bearer ${token}`).send(body);

  const body = () => {
    const sub = `spp-${randomUUID().slice(0, 8)}`;
    return { name: `SPP ${sub}`, subdomain: sub };
  };

  const workspaceOf = async (userId: string) =>
    (await admin.query(
      `SELECT mw.id, mw.schema_status, mw.schema_last_error, r.status AS registry,
              (SELECT count(*)::int FROM pg_namespace n WHERE n.nspname = 'workspace_' || replace(mw.id::text, '-', '')) AS schemas
         FROM core.manager_workspace mw LEFT JOIN core.workspace_schema_registry r ON r.workspace_id = mw.id WHERE mw.owner_user_id = $1`,
      [userId],
    )) as Array<{ id: string; schema_status: string; schema_last_error: string | null; registry: string | null; schemas: number }>;

  const auditCounts = async (workspaceId: string): Promise<Record<string, number>> => {
    const rows = await admin.query(`SELECT action, count(*)::int AS n FROM core.audit_log WHERE entity_id = $1 GROUP BY action`, [workspaceId]);
    return Object.fromEntries(rows.map((r: { action: string; n: number }) => [r.action, r.n]));
  };

  const injectFailure = async (userId: string) => {
    // Fails CREATE TABLE of payroll_run in the workspace schema owned by this user, part-way through the template.
    await admin.query(`
      CREATE OR REPLACE FUNCTION public.spp_api_inject_failure() RETURNS event_trigger LANGUAGE plpgsql AS $$
      DECLARE r record;
      BEGIN
        FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
          IF r.command_tag = 'CREATE TABLE' AND r.object_identity LIKE '%.payroll_run'
             AND current_setting('rab.user_id', true) = '${userId}' THEN
            RAISE EXCEPTION 'injected provisioning SQL failure (internal detail that must never be stored)';
          END IF;
        END LOOP;
      END $$`);
    await admin.query(`DROP EVENT TRIGGER IF EXISTS spp_api_inject_failure`);
    await admin.query(`CREATE EVENT TRIGGER spp_api_inject_failure ON ddl_command_end EXECUTE FUNCTION public.spp_api_inject_failure()`);
  };
  const clearFailure = async () => {
    await admin.query(`DROP EVENT TRIGGER IF EXISTS spp_api_inject_failure`);
    await admin.query(`DROP FUNCTION IF EXISTS public.spp_api_inject_failure()`);
  };

  beforeAll(async () => {
    replicaA = await boot();
    replicaB = await boot();
    admin = createAdminDataSource();
    await admin.initialize();
    factory = new TestIdentityFactory({
      app: replicaA,
      dataSource: replicaA.get(DataSource),
      adminDataSource: admin,
      tenantContext: replicaA.get(TenantContextService),
      passwordHashing: replicaA.get(PasswordHashingService),
    });
    org = await factory.createOrganisation('spp-api');
    otherOrg = await factory.createOrganisation('spp-api-other');
    const [{ current_user: who }] = await replicaA.get(DataSource).query('SELECT current_user');
    expect(who).toBe('crewflow_app');
  }, 180_000);

  afterAll(async () => {
    await clearFailure().catch(() => undefined);
    await admin.query(`GRANT EXECUTE ON FUNCTION core.provision_workspace(uuid) TO crewflow_app`).catch(() => undefined);
    await admin?.destroy();
    await replicaA?.close();
    await replicaB?.close();
  });

  it('authorised creation: 201, READY in the same response, one schema, created + provisioned audited once each', async () => {
    const m = await newManager();
    const res = await post(replicaA, m.token, body());
    expect(res.status).toBe(201);
    expect(res.body.schemaStatus).toBe('READY');
    const [ws] = await workspaceOf(m.id.userId);
    expect(ws).toMatchObject({ id: res.body.id, schema_status: 'READY', registry: 'READY', schemas: 1 });
    expect(await auditCounts(ws!.id)).toEqual({ 'manager_workspace.created': 1, 'manager_workspace.provisioned': 1 });
    // The poll the onboarding screen uses sees READY immediately (no stale cache).
    const me = await request(replicaB.getHttpServer()).get('/rest/v1/manager-workspaces/me?fresh=1').set('Authorization', `Bearer ${m.token}`);
    expect(me.body.schemaStatus).toBe('READY');
  });

  it('unauthorised actors: no token is 401; a Staff account creates nothing', async () => {
    expect((await request(replicaA.getHttpServer()).post('/rest/v1/manager-workspaces').send(body())).status).toBe(401);
    const owner = await factory.createInternalManager(org, { permissions: 'production', label: 'spp-owner' });
    const staff = await factory.createStaff(org, { owner, label: 'spp-staff' });
    const staffToken = await factory.login(staff);
    const res = await post(replicaA, staffToken, body());
    expect([401, 403, 404]).toContain(res.status);
    expect(await workspaceOf(staff.userId)).toHaveLength(0);
  });

  it('client-supplied identity is refused: organisationId / ownerUserId / status / workspaceId in the body are 400', async () => {
    const m = await newManager();
    for (const extra of [{ organisationId: otherOrg.id }, { ownerUserId: randomUUID() }, { schemaStatus: 'READY' }, { workspaceId: randomUUID() }]) {
      expect((await post(replicaA, m.token, { ...body(), ...extra })).status).toBe(400);
    }
    expect(await workspaceOf(m.id.userId)).toHaveLength(0);
  });

  it('cross-organisation and cross-owner provisioning attempts are 404 at the service layer and leave the victim untouched', async () => {
    const victim = await newManager();
    // A victim workspace left CREATING (provisioning unavailable at the time it was created).
    await admin.query(`REVOKE EXECUTE ON FUNCTION core.provision_workspace(uuid) FROM crewflow_app`);
    let victimWs: string;
    try {
      const res = await post(replicaA, victim.token, body());
      expect(res.status).toBe(201);
      expect(res.body.schemaStatus).toBe('CREATING');
      victimWs = res.body.id;
    } finally {
      await admin.query(`GRANT EXECUTE ON FUNCTION core.provision_workspace(uuid) TO crewflow_app`);
    }
    const provisioning = replicaA.get(WorkspaceProvisioningService);
    const foreign = await newManager(otherOrg);
    const colleague = await newManager();
    for (const actor of [foreign.id, colleague.id]) {
      await expect(
        provisioning.provisionOwnWorkspace({ organisationId: actor.organisationId, workspaceId: null, userId: actor.userId, role: '' }, victimWs),
      ).rejects.toBeInstanceOf(NotFoundException);
    }
    // Even with the victim's organisation claimed, a different user is not the owner.
    await expect(
      provisioning.provisionOwnWorkspace({ organisationId: victim.id.organisationId, workspaceId: null, userId: colleague.id.userId, role: '' }, victimWs),
    ).rejects.toBeInstanceOf(NotFoundException);
    const [ws] = await workspaceOf(victim.id.userId);
    expect(ws).toMatchObject({ schema_status: 'CREATING', registry: null, schemas: 0 });
    // The owner's own retry (same request) completes it.
    const retry = await post(replicaA, victim.token, { name: (await admin.query(`SELECT name FROM core.manager_workspace WHERE id = $1`, [victimWs]))[0].name, subdomain: (await admin.query(`SELECT subdomain FROM core.manager_workspace WHERE id = $1`, [victimWs]))[0].subdomain });
    expect(retry.status).toBe(201);
    expect(retry.body).toMatchObject({ id: victimWs, schemaStatus: 'READY' });
  });

  it('duplicate click: two identical concurrent POSTs on one replica both succeed with the same workspace; READY exactly once', async () => {
    const m = await newManager();
    const b = body();
    const [r1, r2] = await Promise.all([post(replicaA, m.token, b), post(replicaA, m.token, b)]);
    expect([r1.status, r2.status]).toEqual([201, 201]);
    expect(r1.body.id).toBe(r2.body.id);
    expect([r1.body.schemaStatus, r2.body.schemaStatus]).toEqual(['READY', 'READY']);
    expect(await workspaceOf(m.id.userId)).toHaveLength(1);
    expect(await auditCounts(r1.body.id)).toEqual({ 'manager_workspace.created': 1, 'manager_workspace.provisioned': 1 });
  });

  it('two API replicas racing on the same workspace: both 201, one schema, READY exactly once', async () => {
    const m = await newManager();
    const b = body();
    const results = await Promise.all([post(replicaA, m.token, b), post(replicaB, m.token, b), post(replicaB, m.token, b)]);
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(results.every((r) => r.body.schemaStatus === 'READY')).toBe(true);
    const [ws] = await workspaceOf(m.id.userId);
    expect(ws).toMatchObject({ schema_status: 'READY', schemas: 1 });
    expect(await auditCounts(ws!.id)).toEqual({ 'manager_workspace.created': 1, 'manager_workspace.provisioned': 1 });
  });

  it('a different body from an owner who already has a workspace is still the original 409', async () => {
    const m = await newManager();
    expect((await post(replicaA, m.token, body())).status).toBe(201);
    expect((await post(replicaA, m.token, body())).status).toBe(409);
  });

  it('request timeout / lost response: the client gives up, the server finishes, the client retry is a replay (no second workspace, no second READY)', async () => {
    const m = await newManager();
    const b = body();
    await expect(post(replicaA, m.token, b).timeout({ response: 5 })).rejects.toBeTruthy();
    // The server keeps going after the client disconnects; wait for the committed outcome.
    for (let i = 0; i < 100; i++) {
      const [ws] = await workspaceOf(m.id.userId);
      if (ws?.schema_status === 'READY') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    // The abandoned request really reached the server and completed there (otherwise this would not test a lost response).
    const [completed] = await workspaceOf(m.id.userId);
    expect(completed).toMatchObject({ schema_status: 'READY', schemas: 1 });
    const retry = await post(replicaB, m.token, b);
    expect(retry.status).toBe(201);
    expect(retry.body).toMatchObject({ id: completed!.id, schemaStatus: 'READY' });
    expect(await workspaceOf(m.id.userId)).toHaveLength(1);
    expect(await auditCounts(retry.body.id)).toEqual({ 'manager_workspace.created': 1, 'manager_workspace.provisioned': 1 });
  });

  it('DB connection lost mid-provisioning: 201 with the real CREATING state (no 500, nothing partial); the retry reaches READY', async () => {
    const m = await newManager();
    const b = body();
    const locker = new Client({ connectionString: adminUrl });
    await locker.connect();
    let res: request.Response;
    try {
      await locker.query('BEGIN');
      // Only the template touches this table (payroll_run's FK), so the request blocks INSIDE provisioning, not in auth.
      await locker.query('LOCK TABLE core.payroll_calendar_period IN ACCESS EXCLUSIVE MODE');
      // supertest is lazy: .then() actually sends the request now.
      const pending = post(replicaA, m.token, b).then((r) => r);
      // Kill the API's own backend once it is blocked inside the template (an outage seen from the API's side).
      let killed = false;
      for (let i = 0; i < 200 && !killed; i++) {
        const rows = await admin.query(
          `SELECT pid FROM pg_stat_activity WHERE usename = 'crewflow_app' AND wait_event_type = 'Lock' AND query LIKE '%provision_workspace%'`,
        );
        if (rows.length) {
          await admin.query('SELECT pg_terminate_backend($1)', [rows[0].pid]);
          killed = true;
        } else await new Promise((r) => setTimeout(r, 50));
      }
      expect(killed).toBe(true);
      res = await pending;
    } finally {
      await locker.query('ROLLBACK');
      await locker.end();
    }
    expect(res!.status).toBe(201);
    expect(res!.body.schemaStatus).toBe('CREATING');
    const [ws] = await workspaceOf(m.id.userId);
    expect(ws).toMatchObject({ schema_status: 'CREATING', registry: null, schemas: 0 });
    const retry = await post(replicaB, m.token, b);
    expect(retry.body).toMatchObject({ id: ws!.id, schemaStatus: 'READY' });
  });

  it('provisioning SQL failure: 201 with FAILED and a SAFE error (audited); a successful retry from FAILED; READY exactly once', async () => {
    const m = await newManager();
    const b = body();
    await injectFailure(m.id.userId);
    let first: request.Response;
    try {
      first = await post(replicaA, m.token, b);
    } finally {
      await clearFailure();
    }
    expect(first.status).toBe(201);
    expect(first.body.schemaStatus).toBe('FAILED');
    const [failed] = await workspaceOf(m.id.userId);
    expect(failed).toMatchObject({ schema_status: 'FAILED', registry: 'FAILED', schemas: 1 });
    expect(failed!.schema_last_error).toBe('V1 provisioning failed at apply (SQLSTATE P0001)');
    const [audit] = await admin.query(`SELECT metadata FROM core.audit_log WHERE entity_id = $1 AND action = 'manager_workspace.provisioning_failed'`, [failed!.id]);
    expect(JSON.stringify(audit.metadata)).not.toMatch(/injected|internal detail/);

    const retry = await post(replicaB, m.token, b);
    expect(retry.status).toBe(201);
    expect(retry.body).toMatchObject({ id: failed!.id, schemaStatus: 'READY' });
    expect(await auditCounts(failed!.id)).toEqual({
      'manager_workspace.created': 1,
      'manager_workspace.provisioning_failed': 1,
      'manager_workspace.provisioned': 1,
    });
  });

  it('server restart: a workspace left CREATING by a process that stopped is completed by a fresh process', async () => {
    const m = await newManager();
    const b = body();
    // The function is unavailable while "the old process" serves the request (e.g. mid-rollback): it answers CREATING.
    await admin.query(`REVOKE EXECUTE ON FUNCTION core.provision_workspace(uuid) FROM crewflow_app`);
    let id: string;
    try {
      const res = await post(replicaA, m.token, b);
      expect(res.body.schemaStatus).toBe('CREATING');
      id = res.body.id;
    } finally {
      await admin.query(`GRANT EXECUTE ON FUNCTION core.provision_workspace(uuid) TO crewflow_app`);
    }
    const restarted = await boot();
    try {
      const res = await post(restarted, m.token, b);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ id, schemaStatus: 'READY' });
    } finally {
      await restarted.close();
    }
    expect(await auditCounts(id)).toEqual({ 'manager_workspace.created': 1, 'manager_workspace.provisioned': 1 });
  });
});
