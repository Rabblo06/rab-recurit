import 'reflect-metadata';
import { ManagerType, UserStatus } from '@rab/shared';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { ManagerProfile } from '@rab/server/modules/manager/entities/manager-profile.entity';
import { ManagerWorkspace } from '@rab/server/modules/manager-workspace/entities/manager-workspace.entity';
import { Organisation, Role, User, UserRole } from '@rab/server/modules/identity/entities/index';
import { V1_EXPECTED, workspaceSchemaName } from '@rab/server/database/typeorm/workspace-schema/provision-workspace-schema';
import { runWorkspaceProvisioningCycle } from '../../queues/rab-maintenance/workspace-provisioning.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { generateFixturePassword } from './helpers/fixture-password';
import { verifiedCrewflowUrl } from './helpers/verified-role-database';

/**
 * Phase A (pa-provisioner): opt-in provisioner, HWS pass-through, bounded lock — against the disposable test database with
 * the REAL `crewflow` login (verified live by `verifiedCrewflowUrl()`; no superuser shortcut) and the REAL entrypoint
 * (`workspace-provisioner.main.ts` via ts-node, as workspace-provisioner-entrypoint.integration.spec.ts does).
 *
 *  1. Another provisioner session holding the provisioning lock makes a cycle SKIP within its bound (no unbounded wait,
 *     no DDL); once it is released the next cycle provisions a synthetic workspace to READY and releases the lock.
 *  2. Enabled explicitly with HWS_RUNTIME_ENABLED=false (production's configuration) the entrypoint still provisions.
 *  3. Not enabled: the entrypoint exits 0 BEFORE opening any database or Redis connection (proved with unreachable URLs
 *     and, with real URLs, by the absence of any backend carrying its application_name).
 *  4. An invalid switch or interval refuses to start (exit 1) without opening a connection.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(150_000);

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const TS_NODE_BIN = path.join(REPO_ROOT, 'node_modules/ts-node/dist/bin.js');
const PROVISIONER_ENTRY = path.join(__dirname, '../../workspace-provisioner.main.ts');
const PROVISIONER_TSCONFIG = path.join(__dirname, '../../../tsconfig.app.json');
const FIXTURE_PASSWORD = generateFixturePassword();
const UNREACHABLE_DB = 'postgres://crewflow:unused@127.0.0.1:1/rab_unreachable';
const UNREACHABLE_REDIS = 'redis://127.0.0.1:1';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class ProcessWatch {
  output = '';
  exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  constructor(readonly proc: ChildProcessWithoutNullStreams) {
    proc.stdout.on('data', (c: Buffer) => (this.output += c.toString('utf8')));
    proc.stderr.on('data', (c: Buffer) => (this.output += c.toString('utf8')));
    proc.on('exit', (code, signal) => (this.exit = { code, signal }));
  }
  async waitFor(pattern: RegExp, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!pattern.test(this.output)) {
      if (this.exit) throw new Error(`process exited (${JSON.stringify(this.exit)}) before ${pattern}; output:\n${this.output}`);
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern}; output:\n${this.output}`);
      await sleep(100);
    }
  }
  async waitExit(timeoutMs = 60_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    const deadline = Date.now() + timeoutMs;
    while (!this.exit) {
      if (Date.now() > deadline) throw new Error(`process did not exit within ${timeoutMs} ms; output:\n${this.output}`);
      await sleep(100);
    }
    return this.exit;
  }
}

describeIfDb('Phase A — opt-in workspace provisioner (integration)', () => {
  let admin: DataSource;
  let passwordHashing: PasswordHashingService;
  let CREWFLOW_URL: string;
  let REDIS_URL: string;
  const procs: ChildProcessWithoutNullStreams[] = [];
  const clients: Client[] = [];
  const orgIds: string[] = [];
  const workspaceIds: string[] = [];

  beforeAll(async () => {
    CREWFLOW_URL = await verifiedCrewflowUrl();
    const redisUrl = process.env.REDIS_URL?.trim();
    if (!redisUrl) throw new Error('REDIS_URL (the isolated test Redis) is required; there is no fallback.');
    REDIS_URL = redisUrl;
    admin = createAdminDataSource();
    await admin.initialize();
    passwordHashing = new PasswordHashingService();
  });

  afterEach(async () => {
    for (const p of procs) if (p.exitCode === null && !p.killed) p.kill('SIGKILL');
    procs.length = 0;
    for (const c of clients) await c.end().catch(() => undefined);
    clients.length = 0;
    await sleep(300);
    for (const workspaceId of workspaceIds) {
      const org = await admin.query(`SELECT organisation_id FROM core.manager_workspace WHERE id = $1`, [workspaceId]);
      if (org.length > 0) {
        await admin.transaction(async (m) => {
          await m.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true)`, [org[0].organisation_id, workspaceId]);
          await m.query(`DELETE FROM core.workspace_schema_registry WHERE workspace_id = $1`, [workspaceId]);
          await m.query(`DELETE FROM core.manager_profile WHERE workspace_id = $1`, [workspaceId]);
          await m.query(`DELETE FROM core.manager_workspace WHERE id = $1`, [workspaceId]);
        });
      }
      await admin.query(`DROP SCHEMA IF EXISTS ${workspaceSchemaName(workspaceId)} CASCADE`);
    }
    for (const organisationId of orgIds) {
      await admin.transaction(async (m) => {
        await m.query(`SELECT set_config('rab.organisation_id', $1, true)`, [organisationId]);
        await m.query(`DELETE FROM core."user" WHERE organisation_id = $1`, [organisationId]);
      });
      // Not DELETE FROM core.organisation — same recorded audit_log FK reason as the sibling provisioning specs.
    }
    workspaceIds.length = 0;
    orgIds.length = 0;
  });

  afterAll(async () => {
    await admin.destroy();
  });

  async function seedCreatingWorkspace(label: string): Promise<string> {
    const orgInsert = await admin.manager.insert(Organisation, { name: `${label}-${randomUUID()}`, slug: `${label}-${randomUUID()}` });
    const organisationId = orgInsert.identifiers[0]!.id as string;
    orgIds.push(organisationId);
    const workspaceId = await admin.transaction(async (m) => {
      await m.query(`SELECT set_config('rab.organisation_id', $1, true)`, [organisationId]);
      let role = await m.findOne(Role, { where: { organisationId, key: 'manager' } });
      if (!role) {
        const r = await m.insert(Role, { organisationId, key: 'manager', name: 'Manager', isSystem: true });
        role = await m.findOneByOrFail(Role, { id: r.identifiers[0]!.id as string });
      }
      const u = await m.insert(User, {
        organisationId,
        email: `${label}-${randomUUID()}@example.test`,
        passwordHash: await passwordHashing.hash(FIXTURE_PASSWORD),
        firstName: label,
        lastName: 'Owner',
        status: UserStatus.ACTIVE,
      });
      const ownerUserId = u.identifiers[0]!.id as string;
      await m.insert(UserRole, { userId: ownerUserId, roleId: role.id, organisationId });
      await m.query(`SELECT set_config('rab.user_id', $1, true)`, [ownerUserId]);
      const ws = await m.save(ManagerWorkspace, {
        organisationId,
        ownerUserId,
        name: `${label} Workspace`,
        subdomain: `${label}-${randomUUID().slice(0, 8)}`,
        status: 'active',
        schemaStatus: 'CREATING',
      });
      await m.query(`SELECT set_config('rab.workspace_id', $1, true)`, [ws.id]);
      await m.insert(ManagerProfile, { organisationId, userId: ownerUserId, type: ManagerType.INTERNAL, workspaceId: ws.id });
      return ws.id as string;
    });
    workspaceIds.push(workspaceId);
    return workspaceId;
  }

  async function status(workspaceId: string): Promise<string> {
    const rows: Array<{ s: string }> = await admin.query(
      `SELECT coalesce(mw.schema_status, 'NULL') || '|' || coalesce(r.status, '-') AS s
         FROM core.manager_workspace mw LEFT JOIN core.workspace_schema_registry r ON r.workspace_id = mw.id WHERE mw.id = $1`,
      [workspaceId],
    );
    return rows[0]?.s ?? 'missing';
  }

  async function waitReady(workspaceId: string, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await status(workspaceId)) === 'READY|READY') return;
      if (Date.now() > deadline) throw new Error(`workspace ${workspaceId} not READY after ${timeoutMs} ms (last: ${await status(workspaceId)})`);
      await sleep(250);
    }
  }

  async function crewflowClient(appName: string): Promise<Client> {
    const c = new Client({ connectionString: CREWFLOW_URL, application_name: appName });
    c.on('error', () => undefined);
    await c.connect();
    clients.push(c);
    return c;
  }

  function spawnProvisioner(env: Record<string, string | undefined>): ProcessWatch {
    const base: Record<string, string | undefined> = { ...process.env };
    // Start from a clean slate for every switch this spec controls (dotenv never overrides a set variable, and this
    // worktree packages no .env.provisioner).
    for (const k of ['CREWFLOW_PROVISIONER_ENABLED', 'HWS_RUNTIME_ENABLED', 'WORKSPACE_PROVISIONER_INTERVAL_SECONDS', 'CREWFLOW_PROVISIONER_DATABASE_URL']) delete base[k];
    const merged: Record<string, string | undefined> = { ...base, NODE_ENV: 'development', RAB_RUNTIME_ENV: 'development', ...env };
    for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
    const proc = spawn(process.execPath, [TS_NODE_BIN, '--transpile-only', '-P', PROVISIONER_TSCONFIG, PROVISIONER_ENTRY], {
      cwd: REPO_ROOT,
      env: merged as Record<string, string>,
    });
    procs.push(proc);
    return new ProcessWatch(proc);
  }

  const backends = async (appName: string): Promise<number> =>
    ((await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1`, [appName])) as Array<{ n: number }>)[0]!.n;

  it('1. another session holding the provisioning lock → the cycle skips within its bound; after release it provisions to READY and releases the lock', async () => {
    const workspaceId = await seedCreatingWorkspace('pa-lock');
    const holder = await crewflowClient(`pa-lock-holder-${randomUUID().slice(0, 8)}`);
    const provisioner = await crewflowClient(`pa-lock-prov-${randomUUID().slice(0, 8)}`);
    await holder.query(`SELECT pg_advisory_lock(hashtext('rab_workspace_provisioning'))`);

    const t0 = Date.now();
    const skipped = await runWorkspaceProvisioningCycle(provisioner, undefined, { waitMs: 1_500, pollMs: 100 });
    const waited = Date.now() - t0;
    expect(skipped).toEqual({ attempted: 0, ready: 0, failed: 0, lockAcquired: false });
    expect(waited).toBeGreaterThanOrEqual(1_400);
    expect(waited).toBeLessThan(6_000); // bounded: never the unbounded pg_advisory_lock wait
    expect(await status(workspaceId)).toBe('CREATING|-'); // no DDL ran

    await holder.query(`SELECT pg_advisory_unlock(hashtext('rab_workspace_provisioning'))`);
    const result = await runWorkspaceProvisioningCycle(provisioner, undefined, { waitMs: 1_500, pollMs: 100 });
    expect(result.lockAcquired).toBe(true);
    expect(result.ready).toBeGreaterThanOrEqual(1);
    expect(await status(workspaceId)).toBe('READY|READY');
    const [{ n }] = await admin.query(
      `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = $1 AND c.relkind = 'r' AND c.relforcerowsecurity`,
      [workspaceSchemaName(workspaceId)],
    );
    expect(n).toBe(V1_EXPECTED.tables);

    // Released after the cycle: the other session can take it immediately (and gives it back).
    const [{ locked }] = (await holder.query(`SELECT pg_try_advisory_lock(hashtext('rab_workspace_provisioning')) AS locked`)).rows;
    expect(locked).toBe(true);
    await holder.query(`SELECT pg_advisory_unlock(hashtext('rab_workspace_provisioning'))`);
  });

  it('2. explicitly enabled with HWS_RUNTIME_ENABLED=false (the production configuration) → the real entrypoint provisions to READY', async () => {
    const appName = `pa-optin-${randomUUID().slice(0, 8)}`;
    const w = spawnProvisioner({
      DATABASE_URL: CREWFLOW_URL,
      DATABASE_URL_UNPOOLED: CREWFLOW_URL,
      DATABASE_DIRECT_URL: CREWFLOW_URL,
      REDIS_URL,
      CREWFLOW_PROVISIONER_ENABLED: 'true',
      HWS_RUNTIME_ENABLED: 'false',
      WORKSPACE_PROVISIONER_INTERVAL_SECONDS: '5',
      PGAPPNAME: appName,
    });
    await w.waitFor(/\[workspace-provisioner\] started, HWS_RUNTIME_ENABLED=false \(provisioning enabled by CREWFLOW_PROVISIONER_ENABLED; interval 5s\)/);
    const workspaceId = await seedCreatingWorkspace('pa-optin');
    await waitReady(workspaceId, 60_000);
    expect(w.exit).toBeNull();
    w.proc.kill('SIGTERM');
    const { code } = await w.waitExit(30_000);
    if (process.platform !== 'win32') expect(code).toBe(0);
  });

  it('3a. not enabled (switch unset, HWS off) → exit 0 before any connection: unreachable database and Redis are never contacted', async () => {
    const w = spawnProvisioner({
      DATABASE_URL: UNREACHABLE_DB,
      DATABASE_URL_UNPOOLED: UNREACHABLE_DB,
      REDIS_URL: UNREACHABLE_REDIS,
      HWS_RUNTIME_ENABLED: 'false',
    });
    const { code } = await w.waitExit(60_000);
    expect(code).toBe(0);
    expect(w.output).toMatch(/\[workspace-provisioner\] provisioning is not enabled .* nothing to do/);
    expect(w.output).not.toMatch(/runtime-db-guard|ECONNREFUSED|Cannot reach/);
  });

  it('3b. explicit opt-out wins over HWS_RUNTIME_ENABLED=true → exit 0, and no backend with its application_name ever appears', async () => {
    const appName = `pa-optout-${randomUUID().slice(0, 8)}`;
    const w = spawnProvisioner({
      DATABASE_URL: CREWFLOW_URL,
      DATABASE_URL_UNPOOLED: CREWFLOW_URL,
      REDIS_URL,
      CREWFLOW_PROVISIONER_ENABLED: 'false',
      HWS_RUNTIME_ENABLED: 'true',
      PGAPPNAME: appName,
    });
    let maxBackends = 0;
    while (!w.exit) {
      maxBackends = Math.max(maxBackends, await backends(appName));
      await sleep(50);
    }
    expect(w.exit!.code).toBe(0);
    expect(maxBackends).toBe(0);
    expect(await backends(appName)).toBe(0);
    expect(w.output).not.toMatch(/runtime-db-guard\] process=provisioner/);
  });

  it('4. an invalid switch or interval refuses to start (exit 1), names the variable only, opens no connection', async () => {
    for (const [env, pattern] of [
      [{ CREWFLOW_PROVISIONER_ENABLED: 'yes' }, /CREWFLOW_PROVISIONER_ENABLED must be "true" or "false"/],
      [{ CREWFLOW_PROVISIONER_ENABLED: 'true', WORKSPACE_PROVISIONER_INTERVAL_SECONDS: '3600' }, /WORKSPACE_PROVISIONER_INTERVAL_SECONDS must be a whole number of seconds from 5 to 120/],
    ] as const) {
      const w = spawnProvisioner({ DATABASE_URL: UNREACHABLE_DB, DATABASE_URL_UNPOOLED: UNREACHABLE_DB, REDIS_URL: UNREACHABLE_REDIS, ...env });
      const { code } = await w.waitExit(60_000);
      expect(code).toBe(1);
      expect(w.output).toMatch(pattern);
      expect(w.output).not.toMatch(/runtime-db-guard|ECONNREFUSED|Cannot reach/);
    }
  });
});
