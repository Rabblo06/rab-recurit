import 'reflect-metadata';
import { ManagerType, UserStatus } from '@rab/shared';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { resolveIntegrationTestDatabase } from '@rab/server/database/typeorm/core/test-database-guard';
import { resolvePgEnvironmentCached } from '@rab/server/database/postgres/index';
import { ManagerProfile } from '@rab/server/modules/manager/entities/manager-profile.entity';
import { ManagerWorkspace } from '@rab/server/modules/manager-workspace/entities/manager-workspace.entity';
import { Organisation, Role, User, UserRole } from '@rab/server/modules/identity/entities/index';
import { workspaceSchemaName } from '@rab/server/database/typeorm/workspace-schema/provision-workspace-schema';
import { ReconnectingPgClient } from '../../core/database/reconnecting-pg-client';
import { runWorkspaceProvisioningCycle } from '../../queues/rab-maintenance/workspace-provisioning.job';
import {
  actAsProvisioningRole,
  assertProvisioningIdentity,
  ProvisioningIdentityError,
  startWorkspaceProvisioningLoops,
} from '../../queues/rab-maintenance/workspace-provisioning.loops';
import { PROVISIONING_LOCK_WAIT_MS } from '../../queues/rab-maintenance/workspace-provisioning.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { integrationTestDatabaseReady } from '@rab/server/database/typeorm/core/integration-test-database-gate';

/**
 * Owner-login architecture, T4: workspace provisioning IN-PROCESS in the Worker on the one schema-owning login, real
 * PostgreSQL. The login here has the M0 §3.1 `crewflow_owner` shape (INHERIT + SET on rab_secure_owner and crewflow); every
 * provisioning session acts as crewflow (SET ROLE, re-asserted on reconnect), so the result must be structurally identical
 * to what the separate crewflow provisioner builds.
 *
 *  1. first workspace → READY; same tables, owners, RLS/FORCE flags, policies and indexes as a crewflow-provisioned one;
 *  2. several organisations in one sweep → each READY in its own schema, registry rows bound to the right organisation;
 *  3. two concurrent in-process provisioners (two Worker replicas) → each workspace READY exactly once, no error;
 *  4. a mid-provisioning failure → FAILED with nothing routable; the next cycle retries to READY;
 *  5. interruption: the provisioning session is terminated mid-cycle → the cycle fails, the client reconnects, SET ROLE is
 *     re-asserted, the advisory lock died with the session, and the next cycle finishes the workspace;
 *  6. schema upgrade: a database AHEAD of this code (one more migration applied than it knows) → the per-cycle
 *     provisioner-strict check skips the cycle and nothing is provisioned; with the matching code it provisions;
 *  7. permission failures: a login that cannot SET crewflow, and crewflow_app, are refused before any cycle.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(240_000);

function withUser(url: string, user: string, password: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
}

describeIfDb('T4: in-process workspace provisioning on the owner login (integration)', () => {
  let admin: DataSource;
  let adminClient: Client;
  const suffix = randomBytes(4).toString('hex');
  const ownerRole = `t4_owner_${suffix}`;
  const ownerPassword = randomBytes(18).toString('hex');
  const noSetRole = `t4_noset_${suffix}`;
  const noSetPassword = randomBytes(18).toString('hex');
  let ownerUrl: string;
  const opened: Array<{ close(): Promise<void> }> = [];
  const logger = { log: () => undefined, warn: () => undefined, error: () => undefined };

  function ownerClient(label = 'provisioning', initialBackoffMs = 10): ReconnectingPgClient {
    const c = new ReconnectingPgClient({ connectionString: ownerUrl }, { label, logger, initialBackoffMs, maxBackoffMs: 50, onConnect: async (client) => void (await actAsProvisioningRole(client)) });
    opened.push(c);
    return c;
  }

  async function seedCreatingWorkspace(label: string): Promise<{ organisationId: string; workspaceId: string }> {
    const orgInsert = await admin.manager.insert(Organisation, { name: `${label}-${randomUUID()}`, slug: `${label}-${randomUUID()}` });
    const organisationId = orgInsert.identifiers[0]!.id as string;
    return admin.transaction(async (manager) => {
      await manager.query(`SELECT set_config('rab.organisation_id', $1, true)`, [organisationId]);
      const roleResult = await manager.insert(Role, { organisationId, key: 'manager', name: 'Manager', isSystem: true });
      const userResult = await manager.insert(User, {
        organisationId,
        email: `${label}-${randomUUID()}@example.test`,
        firstName: label,
        lastName: 'Owner',
        status: UserStatus.ACTIVE,
      });
      const ownerUserId = userResult.identifiers[0]!.id as string;
      await manager.insert(UserRole, { userId: ownerUserId, roleId: roleResult.identifiers[0]!.id as string, organisationId });
      await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [ownerUserId]);
      const workspace = await manager.save(ManagerWorkspace, {
        organisationId,
        ownerUserId,
        name: `${label} Workspace`,
        subdomain: `${label}-${randomUUID().slice(0, 8)}`,
        status: 'active',
        schemaStatus: 'CREATING',
      });
      await manager.query(`SELECT set_config('rab.workspace_id', $1, true)`, [workspace.id]);
      await manager.insert(ManagerProfile, { organisationId, userId: ownerUserId, type: ManagerType.INTERNAL, workspaceId: workspace.id });
      return { organisationId, workspaceId: workspace.id };
    });
  }

  const registry = async (workspaceId: string) =>
    (await admin.query<Array<{ status: string; organisation_id: string; schema_name: string }>>(
      `SELECT status, organisation_id, schema_name FROM core.workspace_schema_registry WHERE workspace_id = $1`,
      [workspaceId],
    ))[0] ?? null;

  /** Tables (owner, RLS, FORCE), policies and indexes of one workspace schema, with the schema name abstracted away. */
  async function structure(workspaceId: string): Promise<unknown> {
    const schema = workspaceSchemaName(workspaceId);
    const tables = await admin.query(
      `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY c.relname`,
      [schema],
    );
    const policies = await admin.query(`SELECT tablename, policyname, cmd, roles::text FROM pg_policies WHERE schemaname = $1 ORDER BY tablename, policyname`, [schema]);
    const [{ n: indexes }] = await admin.query(`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = $1`, [schema]);
    const [{ owner: schemaOwner }] = await admin.query(`SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = $1`, [schema]);
    return { schemaOwner, tables, policies, indexes };
  }

  /** Repeated ticks, as production runs them (other suites' CREATING debris may share the bounded batch). */
  async function provisionUntilReady(client: ReconnectingPgClient, ids: string[], max = 15): Promise<void> {
    for (let i = 0; i < max; i += 1) {
      const states = await Promise.all(ids.map(async (id) => (await registry(id))?.status));
      if (states.every((s) => s === 'READY')) return;
      await runWorkspaceProvisioningCycle(await client.acquire());
    }
  }

  beforeAll(async () => {
    admin = createAdminDataSource();
    await admin.initialize();
    const { adminUrl } = resolveIntegrationTestDatabase(process.env);
    adminClient = new Client({ connectionString: adminUrl });
    await adminClient.connect();
    const database = new URL(process.env.TEST_DATABASE_URL!).pathname.slice(1);
    // The M0 §3.1 crewflow_owner shape (rab_owner / rab_app memberships are only needed by the migration phases).
    await adminClient.query(`CREATE ROLE ${ownerRole} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT PASSWORD '${ownerPassword}'`);
    await adminClient.query(`GRANT rab_secure_owner TO ${ownerRole} WITH INHERIT TRUE, SET TRUE`);
    await adminClient.query(`GRANT crewflow TO ${ownerRole} WITH INHERIT TRUE, SET TRUE`);
    await adminClient.query(`GRANT CONNECT ON DATABASE "${database}" TO ${ownerRole}`);
    // Can read as crewflow (INHERIT) but may not SET it.
    await adminClient.query(`CREATE ROLE ${noSetRole} LOGIN NOSUPERUSER NOBYPASSRLS INHERIT PASSWORD '${noSetPassword}'`);
    await adminClient.query(`GRANT crewflow TO ${noSetRole} WITH INHERIT TRUE, SET FALSE`);
    await adminClient.query(`GRANT CONNECT ON DATABASE "${database}" TO ${noSetRole}`);
    ownerUrl = withUser(process.env.TEST_DATABASE_URL!, ownerRole, ownerPassword);
  });

  afterAll(async () => {
    for (const c of opened.reverse()) await c.close().catch(() => undefined);
    for (const role of [ownerRole, noSetRole]) {
      await adminClient.query(`DROP OWNED BY ${role}`).catch(() => undefined);
      await adminClient.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    }
    await adminClient.end();
    await admin.destroy();
  });

  it('1. first workspace → READY, structurally identical to one the crewflow provisioner builds; the session acts as crewflow', async () => {
    const owned = await seedCreatingWorkspace('t4-first');
    const client = ownerClient();
    const session = await client.acquire();
    const [{ who, login }] = (await session.query(`SELECT current_user::text AS who, session_user::text AS login`)).rows;
    expect([who, login]).toEqual(['crewflow', ownerRole]);
    await provisionUntilReady(client, [owned.workspaceId]);
    expect((await registry(owned.workspaceId))?.status).toBe('READY');

    // Reference: the separated-mode provisioner identity (crewflow), same code.
    const reference = await seedCreatingWorkspace('t4-reference');
    const crewflow = new Client({ connectionString: resolveIntegrationTestDatabase(process.env).adminUrl });
    await crewflow.connect();
    try {
      await crewflow.query('SET ROLE crewflow');
      for (let i = 0; i < 15 && (await registry(reference.workspaceId))?.status !== 'READY'; i += 1) await runWorkspaceProvisioningCycle(crewflow);
    } finally {
      await crewflow.end();
    }
    expect((await registry(reference.workspaceId))?.status).toBe('READY');
    const ownerLogin = (await structure(owned.workspaceId)) as { schemaOwner: string; tables: Array<{ owner: string }> };
    // P1C.2: core.provision_workspace_schema creates the schema AUTHORIZATION rab_secure_owner — the same for the crewflow
    // provisioner and the in-process owner-login one; the equality below is the real check (owners, RLS/FORCE, policies, indexes).
    expect(ownerLogin.schemaOwner).toBe('rab_secure_owner');
    expect(ownerLogin.tables.length).toBeGreaterThan(10);
    expect(ownerLogin).toEqual(await structure(reference.workspaceId));
  });

  it('2. several organisations in one sweep → each READY in its own schema, bound to its own organisation', async () => {
    const fixtures = await Promise.all(['t4-org-a', 't4-org-b', 't4-org-c'].map((l) => seedCreatingWorkspace(l)));
    await provisionUntilReady(ownerClient(), fixtures.map((f) => f.workspaceId));
    for (const f of fixtures) {
      const row = await registry(f.workspaceId);
      expect(row).toEqual({ status: 'READY', organisation_id: f.organisationId, schema_name: workspaceSchemaName(f.workspaceId) });
    }
    expect(new Set(fixtures.map((f) => workspaceSchemaName(f.workspaceId))).size).toBe(3);
  });

  it('3. two concurrent in-process provisioners (two Worker replicas) → every workspace READY exactly once, no error', async () => {
    const fixtures = await Promise.all([1, 2, 3, 4].map((n) => seedCreatingWorkspace(`t4-conc-${n}`)));
    const [a, b] = [ownerClient('replica-a'), ownerClient('replica-b')];
    for (let round = 0; round < 15; round += 1) {
      const states = await Promise.all(fixtures.map(async (f) => (await registry(f.workspaceId))?.status));
      if (states.every((s) => s === 'READY')) break;
      const results = await Promise.all([runWorkspaceProvisioningCycle(await a.acquire()), runWorkspaceProvisioningCycle(await b.acquire())]);
      // The provisioning advisory lock: never two cycles at once (the loser waited, bounded, or skipped).
      expect(results.filter((r) => r.lockAcquired).length).toBeGreaterThanOrEqual(1);
    }
    for (const f of fixtures) {
      expect((await registry(f.workspaceId))?.status).toBe('READY');
      const [{ n }] = await admin.query(`SELECT count(*)::int AS n FROM core.workspace_schema_registry WHERE workspace_id = $1`, [f.workspaceId]);
      expect(n).toBe(1);
    }
  });

  it('4. a mid-provisioning failure → FAILED, nothing routable; the next cycle retries to READY', async () => {
    const fx = await seedCreatingWorkspace('t4-retry');
    const client = ownerClient();
    for (let i = 0; i < 15 && (await registry(fx.workspaceId))?.status !== 'FAILED'; i += 1) {
      await runWorkspaceProvisioningCycle(await client.acquire(), {
        afterApply: async () => {
          throw new Error('INJECTED-TEST-FAILURE');
        },
      });
    }
    expect((await registry(fx.workspaceId))?.status).toBe('FAILED');
    const [{ n }] = await admin.query(
      `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = $1 AND c.relkind = 'r'`,
      [workspaceSchemaName(fx.workspaceId)],
    );
    expect(n).toBe(0);
    await provisionUntilReady(client, [fx.workspaceId]);
    expect((await registry(fx.workspaceId))?.status).toBe('READY');
  });

  it('5. interruption: the session is terminated mid-cycle → the client reconnects, SET ROLE is re-asserted, the lock died with the session, the next cycle finishes', async () => {
    const fx = await seedCreatingWorkspace('t4-interrupt');
    const client = ownerClient();
    const first = await client.acquire();
    const [{ pid }] = (await first.query('SELECT pg_backend_pid() AS pid')).rows;
    let interrupted = false;
    for (let i = 0; i < 15 && !interrupted; i += 1) {
      await runWorkspaceProvisioningCycle(await client.acquire(), {
        afterApply: async () => {
          interrupted = true;
          await adminClient.query('SELECT pg_terminate_backend($1)', [pid]);
          await new Promise((r) => setTimeout(r, 200));
        },
      }).catch(() => undefined);
    }
    expect(interrupted).toBe(true);
    expect((await registry(fx.workspaceId))?.status).not.toBe('READY');
    // The terminated session's advisory lock is gone (the server released it with the session).
    const [{ held }] = await admin.query(`SELECT count(*)::int AS held FROM pg_locks WHERE locktype = 'advisory' AND pid = $1`, [pid]);
    expect(held).toBe(0);
    let second: Client | null = null;
    for (let i = 0; i < 50 && !second; i += 1) {
      second = await client.acquire().catch(async () => {
        await new Promise((r) => setTimeout(r, 20));
        return null;
      });
    }
    expect(second).not.toBe(first);
    const [{ who }] = (await second!.query('SELECT current_user::text AS who')).rows;
    expect(who).toBe('crewflow');
    await provisionUntilReady(client, [fx.workspaceId]);
    expect((await registry(fx.workspaceId))?.status).toBe('READY');
  });

  it('6. schema upgrade: a database AHEAD of this code skips the cycle (provisioner-strict check); the matching code provisions', async () => {
    const fx = await seedCreatingWorkspace('t4-upgrade');
    const applied = (await admin.query<Array<{ name: string }>>(`SELECT name FROM core.migrations ORDER BY timestamp, id`)).map((r) => r.name);
    const pg = resolvePgEnvironmentCached({ NODE_ENV: 'test', PG_DATABASE_URL: ownerUrl }, { processRole: 'worker' });
    const runs: Array<{ name: string; run: () => Promise<unknown> }> = [];
    const errors: string[] = [];
    const runtime = { every: (def: { name: string; run: () => Promise<unknown> }) => runs.push(def), isShuttingDown: false };
    const loops = await startWorkspaceProvisioningLoops({
      pg,
      endpoint: 'primary',
      runtime: runtime as never,
      logger: { log: () => undefined, warn: () => undefined, error: (m: string) => errors.push(m) },
      intervalMs: 60_000,
      expectedMigrations: applied.slice(0, -1), // this "older" code does not know the newest applied migration
      production: false,
      actAsCrewflow: true,
    });
    opened.push(loops);
    const provisioning = runs.find((r) => r.name === 'workspace provisioning')!;
    expect(await provisioning.run()).toBe(false);
    expect(errors.join('\n')).toMatch(/workspace provisioning: skipped/);
    expect((await registry(fx.workspaceId))?.status ?? 'CREATING').not.toBe('READY');

    const current = await startWorkspaceProvisioningLoops({
      pg,
      endpoint: 'primary',
      runtime: { every: (def: { name: string; run: () => Promise<unknown> }) => runs.push(def), isShuttingDown: false } as never,
      logger,
      intervalMs: 60_000,
      expectedMigrations: applied,
      production: false,
      actAsCrewflow: true,
    });
    opened.push(current);
    const matching = runs.filter((r) => r.name === 'workspace provisioning').at(-1)!;
    for (let i = 0; i < 15 && (await registry(fx.workspaceId))?.status !== 'READY'; i += 1) expect(await matching.run()).toBe(true);
    expect((await registry(fx.workspaceId))?.status).toBe('READY');
  });

  it('7. permission failures: a login that cannot SET crewflow, and crewflow_app, are refused before any cycle', async () => {
    // The no-SET login always; crewflow_app only where the harness provides it (a separated-built fixture: on an owner-login
    // database TEST_DATABASE_URL IS the owner login, and crewflow_app has no password).
    const refusedUrls = [withUser(process.env.TEST_DATABASE_URL!, noSetRole, noSetPassword)];
    if (process.env.TEST_DATABASE_SEPARATED_APP_URL) refusedUrls.push(process.env.TEST_DATABASE_SEPARATED_APP_URL);
    else if (!process.env.TEST_DATABASE_URL!.includes('crewflow_owner')) refusedUrls.push(process.env.TEST_DATABASE_URL!);
    for (const url of refusedUrls) {
      const client = new Client({ connectionString: url });
      await client.connect();
      try {
        await expect(actAsProvisioningRole(client)).rejects.toThrow(ProvisioningIdentityError);
        const [{ who }] = (await client.query('SELECT current_user::text AS who')).rows;
        expect(who).not.toBe('crewflow');
      } finally {
        await client.end();
      }
    }
    const pg = resolvePgEnvironmentCached({ NODE_ENV: 'test', PG_DATABASE_URL: withUser(process.env.TEST_DATABASE_URL!, noSetRole, noSetPassword) }, { processRole: 'worker' });
    await expect(
      startWorkspaceProvisioningLoops({
        pg,
        endpoint: 'primary',
        runtime: { every: () => undefined, isShuttingDown: false } as never,
        logger,
        intervalMs: 60_000,
        expectedMigrations: ['x'],
        production: false,
        actAsCrewflow: true,
      }),
    ).rejects.toThrow(/cannot act as crewflow/);
  });

  // ---------------------------------------------------------------------------------------------------------------------
  // Agent 5's review: in-process equivalents of the superseded provisioner-process tests (R5a, R5b, opt-in 1 and 2), so they
  // exist before PR #9 removes the process tests. Opt-in 3a / 3b / 4 need no database (workspace-provisioning.loops.spec.ts).
  // ---------------------------------------------------------------------------------------------------------------------
  const LOCK_KEY = `hashtext('rab_workspace_provisioning')`;

  /** The loops as the Worker runs them (owner login, SET ROLE crewflow), with a hand-driven runtime. */
  async function loopsWith(isShuttingDown: () => boolean, extra: { production?: boolean } = {}) {
    const applied = (await admin.query<Array<{ name: string }>>(`SELECT name FROM core.migrations ORDER BY timestamp, id`)).map((r) => r.name);
    const runs: Array<{ name: string; run: () => Promise<unknown> }> = [];
    const runtime = {
      every: (def: { name: string; run: () => Promise<unknown> }) => runs.push(def),
      get isShuttingDown() {
        return isShuttingDown();
      },
    };
    const pg = resolvePgEnvironmentCached({ NODE_ENV: 'test', PG_DATABASE_URL: ownerUrl, HWS_RUNTIME_ENABLED: 'false' }, { processRole: 'worker' });
    const loops = await startWorkspaceProvisioningLoops({
      pg,
      endpoint: 'primary',
      runtime: runtime as never,
      logger,
      intervalMs: 5_000,
      expectedMigrations: applied,
      production: extra.production ?? false,
      actAsCrewflow: true,
    });
    opened.push(loops);
    return runs.find((r) => r.name === 'workspace provisioning')!.run;
  }

  /** A foreign session holding the provisioning advisory lock (another replica, or the superseded provisioner). */
  async function foreignLockHolder(): Promise<{ client: Client; pid: number }> {
    const client = new Client({ connectionString: resolveIntegrationTestDatabase(process.env).adminUrl });
    client.on('error', () => undefined);
    await client.connect();
    await client.query(`SELECT pg_advisory_lock(${LOCK_KEY})`);
    const [{ pid }] = (await client.query('SELECT pg_backend_pid() AS pid')).rows;
    return { client, pid };
  }

  /** Advisory locks currently held by any session of the owner-member login (the in-process provisioner's sessions). */
  const ownerAdvisoryLocks = async () =>
    (
      await admin.query<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE l.locktype = 'advisory' AND l.granted AND a.usename = $1`,
        [ownerRole],
      )
    )[0]!.n;

  it('R5a. shutdown aborts the bounded lock wait at once (real lock holder): no provisioning, nothing left held', async () => {
    const fx = await seedCreatingWorkspace('t4-r5a');
    const holder = await foreignLockHolder();
    try {
      const run = await loopsWith(() => true); // shutdown has begun
      const started = Date.now();
      expect(await run()).toBe(false);
      expect(Date.now() - started).toBeLessThan(2_000); // never the full bounded wait
      expect((await registry(fx.workspaceId))?.status ?? 'CREATING').not.toBe('READY');
      expect(await ownerAdvisoryLocks()).toBe(0);
    } finally {
      await holder.client.end().catch(() => undefined);
    }
  });

  it('R5b. a foreign lock holder whose session dies releases the lock at once; the waiting in-process cycle provisions within its bound', async () => {
    const fx = await seedCreatingWorkspace('t4-r5b');
    const holder = await foreignLockHolder();
    const run = await loopsWith(() => false);
    const started = Date.now();
    const cycle = run();
    await new Promise((r) => setTimeout(r, 1_000));
    await adminClient.query('SELECT pg_terminate_backend($1)', [holder.pid]); // the holder "process" dies
    expect(await cycle).toBe(true);
    expect(Date.now() - started).toBeLessThan(PROVISIONING_LOCK_WAIT_MS + 5_000);
    for (let i = 0; i < 15 && (await registry(fx.workspaceId))?.status !== 'READY'; i += 1) await run();
    expect((await registry(fx.workspaceId))?.status).toBe('READY');
    expect(await ownerAdvisoryLocks()).toBe(0);
  });

  it('opt-in 1. another session holds the lock for the whole bound → the cycle skips within the bound; after release it provisions and releases the lock', async () => {
    const fx = await seedCreatingWorkspace('t4-optin1');
    const holder = await foreignLockHolder();
    const run = await loopsWith(() => false);
    try {
      const started = Date.now();
      expect(await run()).toBe(false); // lock busy for the whole bounded wait: an idle tick, never stamped
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(PROVISIONING_LOCK_WAIT_MS - 500);
      expect(elapsed).toBeLessThan(PROVISIONING_LOCK_WAIT_MS + 5_000);
      expect((await registry(fx.workspaceId))?.status ?? 'CREATING').not.toBe('READY');
    } finally {
      await holder.client.query(`SELECT pg_advisory_unlock(${LOCK_KEY})`).catch(() => undefined);
      await holder.client.end().catch(() => undefined);
    }
    for (let i = 0; i < 15 && (await registry(fx.workspaceId))?.status !== 'READY'; i += 1) await run();
    expect((await registry(fx.workspaceId))?.status).toBe('READY');
    expect(await ownerAdvisoryLocks()).toBe(0); // released after the cycle
  });

  it('opt-in 2. the production configuration (HWS_RUNTIME_ENABLED=false, production compatibility policy) provisions to READY through the real loops', async () => {
    const fx = await seedCreatingWorkspace('t4-optin2');
    // The loops read no HWS switch: in-process provisioning is always on (the only path that builds createFor workspaces,
    // and any workspace in production). The per-cycle compatibility check runs with the production policy.
    const run = await loopsWith(() => false, { production: true });
    for (let i = 0; i < 15 && (await registry(fx.workspaceId))?.status !== 'READY'; i += 1) await run();
    expect((await registry(fx.workspaceId))?.status).toBe('READY');
  });

  it('identity re-check: a session whose role was reset is refused for the cycle and reopened; the new session is crewflow again', async () => {
    const client = ownerClient('identity-recheck');
    const first = await client.acquire();
    await first.query('RESET ROLE'); // what a stray / injected RESET ROLE would leave behind
    await expect(assertProvisioningIdentity(first)).rejects.toThrow(ProvisioningIdentityError);
    client.invalidate(first, 'the session is no longer crewflow');
    const second = await client.acquire();
    expect(second).not.toBe(first);
    const [{ who }] = (await second.query('SELECT current_user::text AS who')).rows;
    expect(who).toBe('crewflow');
    await expect(assertProvisioningIdentity(second)).resolves.toBeUndefined();
  });
});
