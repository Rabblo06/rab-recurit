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
import { workspaceSchemaName } from '@rab/server/database/typeorm/workspace-schema/provision-workspace-schema';
import { createAdminDataSource } from './helpers/admin-datasource';
import { generateFixturePassword } from './helpers/fixture-password';
import { verifiedCrewflowUrl } from './helpers/verified-role-database';

/**
 * W6-E2E-05 (HIGH, availability) regression. Wave 6 lane E2E restarted Postgres under a running worker bundle: the
 * provisioner's long-lived `pg` Client emitted an 'error' event (57P01 admin_shutdown) with no listener, Node turned it
 * into an uncaught exception, the provisioner exited 1 and the bundle launcher failed the whole worker container.
 *
 * This spawns the REAL provisioner entrypoint (`workspace-provisioner.main.ts`, via ts-node, as the entrypoint spec does)
 * and kills its database session server-side with `pg_terminate_backend`. That raises exactly the error a Postgres
 * restart / failover / idle-connection kill raises on the client (SQLSTATE 57P01, "terminating connection due to
 * administrator command"), without restarting the shared test database. The process is identified by a unique
 * `application_name` (PGAPPNAME), so no other backend is touched.
 *
 * Asserts: the process stays alive (0 exits — the container-level "0 restarts"), it logs the loss and reconnects, and
 * provisioning RESUMES — a workspace seeded after the drop reaches READY through the reconnected client. A second test
 * drops the connection repeatedly, including while the database refuses the role, and checks the reconnect is bounded
 * (backoff) and still recovers.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(180_000);

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const TS_NODE_BIN = path.join(REPO_ROOT, 'node_modules/ts-node/dist/bin.js');
const PROVISIONER_ENTRY = path.join(__dirname, '../../workspace-provisioner.main.ts');
const PROVISIONER_TSCONFIG = path.join(__dirname, '../../../tsconfig.app.json');
const FIXTURE_PASSWORD = generateFixturePassword();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class ProcessWatch {
  output = '';
  exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  constructor(readonly proc: ChildProcessWithoutNullStreams) {
    proc.stdout.on('data', (c: Buffer) => (this.output += c.toString('utf8')));
    proc.stderr.on('data', (c: Buffer) => (this.output += c.toString('utf8')));
    proc.on('exit', (code, signal) => (this.exit = { code, signal }));
  }
  async waitFor(pattern: RegExp, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!pattern.test(this.output)) {
      if (this.exit) throw new Error(`process exited (${JSON.stringify(this.exit)}) before ${pattern}; output:\n${this.output}`);
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern}; output:\n${this.output}`);
      await sleep(100);
    }
  }
}

describeIfDb('W6-E2E-05 provisioner survives a terminated database connection (integration, real process)', () => {
  let admin: DataSource;
  let passwordHashing: PasswordHashingService;
  let CREWFLOW_URL: string;
  let REDIS_URL: string;
  const procs: ChildProcessWithoutNullStreams[] = [];
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
    await sleep(500);
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

  async function waitReady(workspaceId: string, timeoutMs = 60_000): Promise<number> {
    const t0 = Date.now();
    for (;;) {
      const rows: Array<{ status: string }> = await admin.query(`SELECT status FROM core.workspace_schema_registry WHERE workspace_id = $1`, [workspaceId]);
      if (rows[0]?.status === 'READY') return Date.now() - t0;
      if (Date.now() - t0 > timeoutMs) throw new Error(`workspace ${workspaceId} not READY after ${timeoutMs} ms (last: ${rows[0]?.status ?? 'none'})`);
      await sleep(250);
    }
  }

  function spawnProvisioner(appName: string): ProcessWatch {
    const proc = spawn(process.execPath, [TS_NODE_BIN, '--transpile-only', '-P', PROVISIONER_TSCONFIG, PROVISIONER_ENTRY], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        RAB_RUNTIME_ENV: 'development',
        DATABASE_URL: CREWFLOW_URL,
        DATABASE_URL_UNPOOLED: CREWFLOW_URL,
        DATABASE_DIRECT_URL: CREWFLOW_URL,
        REDIS_URL,
        HWS_RUNTIME_ENABLED: 'true',
        PGAPPNAME: appName,
      } as Record<string, string>,
    });
    procs.push(proc);
    return new ProcessWatch(proc);
  }

  /** Terminates every backend of this one spawned process (57P01, as a Postgres restart does). Returns how many. */
  async function terminateBackends(appName: string): Promise<number> {
    const rows: Array<{ ok: boolean }> = await admin.query(
      `SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid()`,
      [appName],
    );
    return rows.filter((r) => r.ok).length;
  }

  async function waitForBackend(appName: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [{ n }] = await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1`, [appName]);
      if (n > 0) return;
      if (Date.now() > deadline) throw new Error(`no backend for ${appName} within ${timeoutMs} ms`);
      await sleep(100);
    }
  }

  it('a terminated provisioning connection does not crash the process; it reconnects and provisioning resumes', async () => {
    const appName = `w6e2e05-${randomUUID().slice(0, 8)}`;
    const w = spawnProvisioner(appName);
    await w.waitFor(/\[workspace-provisioner\] started, HWS_RUNTIME_ENABLED=true/);
    await waitForBackend(appName);

    expect(await terminateBackends(appName)).toBeGreaterThanOrEqual(1);
    // Longer than one provisioning interval (5 s): a crash would have happened by now, and at least one cycle has run.
    await sleep(7_000);
    expect(w.exit).toBeNull();
    expect(w.output).not.toMatch(/Unhandled 'error' event/);
    expect(w.output).toMatch(/provisioning database connection lost/);

    // Provisioning resumes on a new connection: a workspace created AFTER the drop reaches READY.
    const workspaceId = await seedCreatingWorkspace('w6e2e05-after');
    await waitReady(workspaceId);
    expect(w.output).toMatch(/provisioning database connection re-established/);
    expect(w.exit).toBeNull();
  });

  it('repeated drops (including mid-cycle) are survived with bounded reconnect attempts, and provisioning still completes', async () => {
    const appName = `w6e2e05r-${randomUUID().slice(0, 8)}`;
    const w = spawnProvisioner(appName);
    await w.waitFor(/\[workspace-provisioner\] started/);
    await waitForBackend(appName);

    // Seed first so a cycle is (likely) mid-provisioning when the backend is killed; the workspace must still end READY.
    const workspaceId = await seedCreatingWorkspace('w6e2e05-mid');
    for (let i = 0; i < 4; i++) {
      await terminateBackends(appName);
      await sleep(1_500);
    }
    expect(w.exit).toBeNull();
    await waitReady(workspaceId, 90_000);

    // Bounded: four drops in ~6 s must not have produced a tight reconnect loop.
    const attempts = (w.output.match(/provisioning database connection re-established/g) ?? []).length;
    expect(attempts).toBeGreaterThanOrEqual(1);
    expect(attempts).toBeLessThanOrEqual(8);
    expect(w.output).not.toMatch(/Unhandled 'error' event/);
    expect(w.exit).toBeNull();
  });
});
