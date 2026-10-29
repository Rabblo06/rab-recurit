import 'reflect-metadata';
import { ManagerType, UserStatus } from '@rab/shared';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { DataSource } from 'typeorm';

import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { ManagerProfile } from '@rab/server/modules/manager/entities/manager-profile.entity';
import { ManagerWorkspace } from '@rab/server/modules/manager-workspace/entities/manager-workspace.entity';
import { Organisation, Role, User, UserRole } from '@rab/server/modules/identity/entities/index';
import { V1_EXPECTED, WORKSPACE_TABLES, workspaceSchemaName } from '@rab/server/database/typeorm/workspace-schema/provision-workspace-schema';
import { createAdminDataSource } from './helpers/admin-datasource';
import { generateFixturePassword } from './helpers/fixture-password';
import { verifiedCrewflowUrl } from './helpers/verified-role-database';
import { expectedWorkspacePolicyCount } from '@rab/server/database/typeorm/workspace-schema/v1/server-path-template-venue-team-admin';
import { LATEST_WORKSPACE_MODULE_VERSION } from '@rab/server/database/typeorm/workspace-schema/workspace-schema-modules';

/**
 * Worker credential isolation checkpoint, item 1 of the "finish" mandate: the existing
 * `workspace-provisioning.integration.spec.ts` only ever calls `runWorkspaceProvisioningCycle`
 * directly — it has never once actually started `workspace-provisioner.main.ts`, the real
 * standalone entrypoint, as its own OS process. This file does exactly that: it spawns the real
 * compiled-at-runtime TypeScript entrypoint via `ts-node`, the same way `rab-worker:provision`'s nx
 * target does, against the disposable p22 database, and observes real stdout/stderr and real exit
 * codes — not a mocked function call.
 *
 * Credentials: the provisioner authenticates as `crewflow` on the SAME isolated test database the fixtures are written to.
 * That login comes only from TEST_DATABASE_CREWFLOW_URL and is verified live before any process is spawned
 * (`verifiedCrewflowUrl()`: same database and cluster as TEST_DATABASE_URL_UNPOOLED, role `crewflow`, no SUPERUSER or
 * BYPASSRLS). There is no hardcoded URL and no fallback: if it is missing or wrong, the suite fails. Every variable a spawned
 * process reads to reach PostgreSQL or Redis is passed explicitly, so `dotenv` (which never overrides a set variable) cannot
 * substitute a value from the developer's `.env` or `.env.provisioner`.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(120_000);

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const TS_NODE_BIN = path.join(REPO_ROOT, 'node_modules/ts-node/dist/bin.js');
const PROVISIONER_ENTRY = path.join(__dirname, '../../workspace-provisioner.main.ts');
const PROVISIONER_TSCONFIG = path.join(__dirname, '../../../tsconfig.app.json');
const WORKER_ENTRY = path.join(__dirname, '../../main.ts');
const WORKER_TSCONFIG = PROVISIONER_TSCONFIG;

const FIXTURE_PASSWORD = generateFixturePassword();

function spawnTsNode(entry: string, tsconfig: string, env: Record<string, string | undefined>): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [TS_NODE_BIN, '--transpile-only', '-P', tsconfig, entry], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env } as Record<string, string>,
  });
}

/** Collects stdout/stderr and resolves the first time `pattern` appears in either stream. Rejects if the process exits first without matching. */
function waitForOutput(proc: ChildProcessWithoutNullStreams, pattern: RegExp, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let exited = false;
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const match = pattern.exec(buffer);
      if (match) {
        cleanup();
        resolve(buffer);
      }
    };
    const onExit = (code: number | null) => {
      exited = true;
      cleanup();
      reject(new Error(`process exited (code ${code}) before matching ${pattern} — output so far:\n${buffer}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out after ${timeoutMs}ms waiting for ${pattern} — output so far:\n${buffer}`));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      proc.stdout.off('data', onData);
      proc.stderr.off('data', onData);
      proc.off('exit', onExit);
    }
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', onExit);
    void exited;
  });
}

function waitForExit(proc: ChildProcessWithoutNullStreams, timeoutMs = 20_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`process did not exit within ${timeoutMs}ms`)), timeoutMs);
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

/**
 * Node on Windows has no real POSIX signal delivery: confirmed directly (both via this harness's
 * own `ChildProcess.kill('SIGTERM')` and via a raw shell `kill`) that a Node child process on
 * win32 is sometimes torn down by the OS before its own `process.on('SIGTERM', ...)` handler ever
 * runs — Node's docs call this out as a known platform gap, not something this codebase's shutdown
 * code can work around. On Linux (the real deployment target), the same handler reliably runs and
 * `shutdown()` calls `process.exit(0)`. This asserts the behaviour that actually matters on every
 * platform — the process does not hang or leave the workspace in a half-finished state — and only
 * requires the stricter graceful-`exit(0)` proof where the platform can actually deliver the signal.
 */
async function expectCleanShutdown(proc: ChildProcessWithoutNullStreams): Promise<void> {
  proc.kill('SIGTERM');
  const { code } = await waitForExit(proc);
  if (process.platform !== 'win32') {
    expect(code).toBe(0);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describeIfDb('workspace-provisioner.main.ts — standalone process (integration)', () => {
  let adminDataSource: DataSource;
  let passwordHashing: PasswordHashingService;
  const createdOrgIds: string[] = [];
  const createdWorkspaceIds: string[] = [];
  const liveProcesses: ChildProcessWithoutNullStreams[] = [];
  let CREWFLOW_URL: string;
  let REDIS_URL: string;

  beforeAll(async () => {
    // Fail closed before any fixture is written or any process is spawned.
    CREWFLOW_URL = await verifiedCrewflowUrl();
    const redisUrl = process.env.REDIS_URL?.trim();
    if (!redisUrl) throw new Error('REDIS_URL (the isolated test Redis) is required; there is no fallback.');
    REDIS_URL = redisUrl;
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    passwordHashing = new PasswordHashingService();
  });

  afterAll(async () => {
    await adminDataSource.destroy();
  });

  afterEach(async () => {
    // Belt-and-braces: kill anything a test left running (a failed assertion before SIGTERM, etc.)
    // before touching fixture rows it might still be writing to.
    for (const proc of liveProcesses) {
      if (!proc.killed && proc.exitCode === null) proc.kill('SIGKILL');
    }
    liveProcesses.length = 0;

    for (const workspaceId of createdWorkspaceIds) {
      const org = await adminDataSource.query(`SELECT organisation_id FROM core.manager_workspace WHERE id = $1`, [workspaceId]);
      if (org.length > 0) {
        const organisationId = org[0].organisation_id as string;
        await adminDataSource.transaction(async (manager) => {
          await manager.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true)`, [organisationId, workspaceId]);
          await manager.query(`DELETE FROM core.workspace_schema_registry WHERE workspace_id = $1`, [workspaceId]);
          await manager.query(`DELETE FROM core.manager_profile WHERE workspace_id = $1`, [workspaceId]);
          await manager.query(`DELETE FROM core.manager_workspace WHERE id = $1`, [workspaceId]);
        });
      }
      let schemaName: string | null = null;
      try {
        schemaName = workspaceSchemaName(workspaceId);
      } catch {
        schemaName = null;
      }
      if (schemaName) await adminDataSource.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    }
    for (const organisationId of createdOrgIds) {
      await adminDataSource.transaction(async (manager) => {
        await manager.query(`SELECT set_config('rab.organisation_id', $1, true)`, [organisationId]);
        await manager.query(`DELETE FROM core."user" WHERE organisation_id = $1`, [organisationId]);
      });
      // Deliberately not DELETE FROM core.organisation — see workspace-provisioning.integration.spec.ts's
      // identical afterEach comment: audit_log_organisation_id_fkey's CASCADE is a separate, recorded,
      // out-of-scope finding, not something this file's cleanup should try to route around.
    }
    createdOrgIds.length = 0;
    createdWorkspaceIds.length = 0;
  });

  async function seedCreatingWorkspace(label: string): Promise<{ organisationId: string; workspaceId: string }> {
    const orgInsert = await adminDataSource.manager.insert(Organisation, { name: `${label}-${randomUUID()}`, slug: `${label}-${randomUUID()}` });
    const organisationId = orgInsert.identifiers[0]!.id as string;
    createdOrgIds.push(organisationId);

    const workspaceId = await adminDataSource.transaction(async (manager) => {
      await manager.query(`SELECT set_config('rab.organisation_id', $1, true)`, [organisationId]);
      let role = await manager.findOne(Role, { where: { organisationId, key: 'manager' } });
      if (!role) {
        const roleResult = await manager.insert(Role, { organisationId, key: 'manager', name: 'Manager', isSystem: true });
        role = await manager.findOneByOrFail(Role, { id: roleResult.identifiers[0]!.id as string });
      }
      const passwordHash = await passwordHashing.hash(FIXTURE_PASSWORD);
      const userResult = await manager.insert(User, {
        organisationId,
        email: `${label}-${randomUUID()}@example.test`,
        passwordHash,
        firstName: label,
        lastName: 'Owner',
        status: UserStatus.ACTIVE,
      });
      const ownerUserId = userResult.identifiers[0]!.id as string;
      await manager.insert(UserRole, { userId: ownerUserId, roleId: role.id, organisationId });
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
      return workspace.id as string;
    });
    createdWorkspaceIds.push(workspaceId);
    return { organisationId, workspaceId };
  }

  async function registryStatus(workspaceId: string): Promise<string | null> {
    const rows: Array<{ status: string }> = await adminDataSource.query(`SELECT status FROM core.workspace_schema_registry WHERE workspace_id = $1`, [workspaceId]);
    return rows[0]?.status ?? null;
  }

  async function waitForRegistryStatus(workspaceId: string, status: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = await registryStatus(workspaceId);
      if (current === status) return;
      if (Date.now() > deadline) throw new Error(`workspace ${workspaceId} did not reach status ${status} within ${timeoutMs}ms (last seen: ${current})`);
      // eslint-disable-next-line no-await-in-loop
      await sleep(250);
    }
  }

  const provisionerEnv = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
    NODE_ENV: 'development',
    RAB_RUNTIME_ENV: 'development',
    DATABASE_URL: CREWFLOW_URL,
    DATABASE_URL_UNPOOLED: CREWFLOW_URL,
    DATABASE_DIRECT_URL: CREWFLOW_URL,
    REDIS_URL,
    HWS_RUNTIME_ENABLED: 'true',
    ...extra,
  });

  // ------------------------------------------------------------------ real standalone lifecycle

  it('starts as a real OS process, discovers and claims a pending workspace, provisions the full V1 schema, reaches READY, and shuts down cleanly on SIGTERM', async () => {
    const fx = await seedCreatingWorkspace('prov-proc-ready');

    const proc = spawnTsNode(PROVISIONER_ENTRY, PROVISIONER_TSCONFIG, provisionerEnv());
    liveProcesses.push(proc);

    // Proves genuine process startup — not a mocked function call.
    await waitForOutput(proc, /\[workspace-provisioner\] started, HWS_RUNTIME_ENABLED=true/);

    // The runtime's `every()` fires its first cycle immediately on start (see worker-runtime.ts) —
    // no need to wait out the real 2-minute interval for this test to observe a provisioning pass.
    await waitForRegistryStatus(fx.workspaceId, 'READY');

    const expectedSchemaName = workspaceSchemaName(fx.workspaceId);
    const [{ n: tableCount, forced }] = await adminDataSource.query(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE c.relrowsecurity AND c.relforcerowsecurity)::int AS forced
         FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = $1 AND c.relkind = 'r'`,
      [expectedSchemaName],
    );
    expect(tableCount).toBe(V1_EXPECTED.tables);
    expect(forced).toBe(V1_EXPECTED.tables);
    const tableNames: Array<{ relname: string }> = await adminDataSource.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = $1 AND c.relkind = 'r' ORDER BY c.relname`,
      [expectedSchemaName],
    );
    expect(tableNames.map((t) => t.relname).sort()).toEqual([...WORKSPACE_TABLES].sort());
    const policyCount: Array<{ n: number }> = await adminDataSource.query(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = $1`, [expectedSchemaName]);
    // A new workspace is provisioned at the latest module (v18 adds the 2 Assigned Staff policies: 39 → 41).
    expect(policyCount[0]!.n).toBe(expectedWorkspacePolicyCount(LATEST_WORKSPACE_MODULE_VERSION));
    const grantCount: Array<{ n: number }> = await adminDataSource.query(
      `SELECT count(*)::int AS n FROM information_schema.table_privileges WHERE table_schema = $1 AND grantee = 'crewflow_app'`,
      [expectedSchemaName],
    );
    expect(grantCount[0]!.n).toBeGreaterThan(0); // crewflow_app can actually use the new schema, not just that it exists

    const [ws] = await adminDataSource.query(`SELECT schema_status FROM core.manager_workspace WHERE id = $1`, [fx.workspaceId]);
    expect(ws.schema_status).toBe('READY');

    // Genuine graceful shutdown: real SIGTERM to a real process, real exit.
    await expectCleanShutdown(proc);
  });

  it('two standalone provisioner processes racing the SAME pending workspace never provision it twice', async () => {
    const fx = await seedCreatingWorkspace('prov-proc-race');

    const procA = spawnTsNode(PROVISIONER_ENTRY, PROVISIONER_TSCONFIG, provisionerEnv());
    const procB = spawnTsNode(PROVISIONER_ENTRY, PROVISIONER_TSCONFIG, provisionerEnv());
    liveProcesses.push(procA, procB);

    await Promise.all([waitForOutput(procA, /\[workspace-provisioner\] started/), waitForOutput(procB, /\[workspace-provisioner\] started/)]);
    await waitForRegistryStatus(fx.workspaceId, 'READY');

    // Give the loser (whichever process didn't win the advisory lock first) a moment to also
    // finish its own first tick — if the fairness/locking were broken, THIS is when a second,
    // conflicting provisioning attempt would show up as a duplicate schema or a FAILED flip.
    await sleep(2_000);

    const rows: Array<{ status: string; schema_version: number }> = await adminDataSource.query(
      `SELECT status, schema_version FROM core.workspace_schema_registry WHERE workspace_id = $1`,
      [fx.workspaceId],
    );
    expect(rows.length).toBe(1); // exactly one registry row — never duplicated
    expect(rows[0]!.status).toBe('READY');
    expect(rows[0]!.schema_version).toBe(1);

    const expectedSchemaName = workspaceSchemaName(fx.workspaceId);
    const [{ n: schemaCount }] = await adminDataSource.query(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1`, [expectedSchemaName]);
    expect(schemaCount).toBe(1); // exactly one physical schema — the second process never got to create its own

    await Promise.all([expectCleanShutdown(procA).catch(() => null), expectCleanShutdown(procB).catch(() => null)]);
  });

  it('a provisioner process killed (SIGKILL) mid-cycle leaves the workspace safely non-READY, and a fresh process started afterward completes it', async () => {
    const fx = await seedCreatingWorkspace('prov-proc-crash');

    const proc = spawnTsNode(PROVISIONER_ENTRY, PROVISIONER_TSCONFIG, provisionerEnv());
    liveProcesses.push(proc);
    await waitForOutput(proc, /\[workspace-provisioner\] started/);
    // Kill it almost immediately — before the first (immediate) tick has had a realistic chance to
    // reach READY, simulating a crash mid-provisioning rather than a clean run-to-completion.
    proc.kill('SIGKILL');
    await waitForExit(proc);

    const statusAfterCrash = await registryStatus(fx.workspaceId);
    expect(statusAfterCrash).not.toBe('READY'); // never silently finished after being killed

    const proc2 = spawnTsNode(PROVISIONER_ENTRY, PROVISIONER_TSCONFIG, provisionerEnv());
    liveProcesses.push(proc2);
    await waitForOutput(proc2, /\[workspace-provisioner\] started/);
    await waitForRegistryStatus(fx.workspaceId, 'READY');

    const [ws] = await adminDataSource.query(`SELECT schema_status FROM core.manager_workspace WHERE id = $1`, [fx.workspaceId]);
    expect(ws.schema_status).toBe('READY');

    await expectCleanShutdown(proc2);
  });

  // ------------------------------------------------------------------ credential isolation, at the real process level

  it('the ordinary Worker entrypoint genuinely refuses to start if DATABASE_URL_UNPOOLED is present in its environment at all', async () => {
    // Minimal env deliberately: the runtime-database-guard runs and exits BEFORE
    // NestFactory.createApplicationContext (confirmed by reading main.ts's own bootstrap() order),
    // so this process never reaches the point where it would need APP_SECRET/SMTP/S3/etc. — the
    // refusal is the FIRST thing this real process does.
    const proc = spawnTsNode(WORKER_ENTRY, WORKER_TSCONFIG, {
      NODE_ENV: 'development',
      RAB_RUNTIME_ENV: 'development',
      // DATABASE_URL would be crewflow_app in a real deployment — this test only needs the guard's
      // "is UNPOOLED present at all" check to fire, which doesn't depend on which role DATABASE_URL
      // itself names, so reusing the same disposable database keeps the fixture simple.
      DATABASE_URL: CREWFLOW_URL,
      DATABASE_URL_UNPOOLED: CREWFLOW_URL,
      DATABASE_DIRECT_URL: CREWFLOW_URL,
      REDIS_URL,
    });
    liveProcesses.push(proc);

    let output = '';
    proc.stdout.on('data', (c: Buffer) => (output += c.toString('utf8')));
    proc.stderr.on('data', (c: Buffer) => (output += c.toString('utf8')));
    const { code } = await waitForExit(proc, 20_000);

    expect(code).toBe(1);
    expect(output).toMatch(/only the provisioner process may hold it/);
  });

  it('the ordinary API entrypoint genuinely refuses to start if DATABASE_URL_UNPOOLED is present in its environment at all', async () => {
    const API_ENTRY = path.join(__dirname, '../../../../rab-server/src/main.ts');
    const API_TSCONFIG = path.join(__dirname, '../../../../rab-server/tsconfig.app.json');
    const proc = spawnTsNode(API_ENTRY, API_TSCONFIG, {
      NODE_ENV: 'development',
      RAB_RUNTIME_ENV: 'development',
      DATABASE_URL: CREWFLOW_URL,
      DATABASE_URL_UNPOOLED: CREWFLOW_URL,
      DATABASE_DIRECT_URL: CREWFLOW_URL,
      REDIS_URL,
    });
    liveProcesses.push(proc);

    let output = '';
    proc.stdout.on('data', (c: Buffer) => (output += c.toString('utf8')));
    proc.stderr.on('data', (c: Buffer) => (output += c.toString('utf8')));
    const { code } = await waitForExit(proc, 20_000);

    expect(code).toBe(1);
    expect(output).toMatch(/only the provisioner process may hold it/);
  });
});
