import 'reflect-metadata';
import { ManagerType, UserStatus } from '@rab/shared';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { resolveIntegrationTestDatabase } from '@rab/server/database/typeorm/core/test-database-guard';
import { ManagerProfile } from '@rab/server/modules/manager/entities/manager-profile.entity';
import { ManagerWorkspace } from '@rab/server/modules/manager-workspace/entities/manager-workspace.entity';
import {
  Organisation,
  Role,
  User,
  UserRole,
} from '@rab/server/modules/identity/entities/index';
import {
  V1_EXPECTED,
  WORKSPACE_TABLES,
  workspaceSchemaName,
} from '@rab/server/database/typeorm/workspace-schema/provision-workspace-schema';
import {
  runWorkspaceProvisioningCycle,
  WorkspaceProvisioningResult,
} from '../../queues/rab-maintenance/workspace-provisioning.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { generateFixturePassword } from './helpers/fixture-password';
import { verifiedCrewflowUrl } from './helpers/verified-role-database';

/**
 * Phase A verification (pa-prov2) — the provisioner's durability, concurrency and lock-boundedness, against the disposable
 * test database with the REAL `crewflow` login (verified live, never the superuser) and, where a process matters, the REAL
 * entrypoint (`workspace-provisioner.main.ts` via ts-node) at the committed production configuration
 * (CREWFLOW_PROVISIONER_ENABLED=true, HWS_RUNTIME_ENABLED=false, WORKSPACE_PROVISIONER_INTERVAL_SECONDS=5).
 *
 *  R1  real process, failure path: a workspace whose provisioning fails is recorded FAILED (safe error), the process keeps
 *      running, and once the cause is removed the SAME request is retried to READY.
 *  R3  real process killed MID-CYCLE, deterministically: the apply transaction is held at a lock (a test session holds
 *      SHARE on core.stored_file, which the template's FKs need), so the kill provably lands after the committed
 *      attempt-start step and inside the DDL transaction. The request survives in the database (manager_workspace
 *      CREATING + registry PROVISIONING + an empty schema); a restarted provisioner finishes it. Also proves a second
 *      replica's lock wait is BOUNDED at the process level while the dead holder's backend still holds the lock, and that
 *      the lock is released once that backend ends.
 *  R4  two concurrent provisioning cycles (two replicas' connections) against the SAME three CREATING workspaces: one
 *      schema each, one READY transition each (one ledger row per module), no failure, no DDL error.
 *  R5  the bounded wait: shutdown aborts it at once (real lock holder), and a holder whose session dies releases the lock
 *      so a waiting cycle provisions within its bound.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(240_000);

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const TS_NODE_BIN = path.join(REPO_ROOT, 'node_modules/ts-node/dist/bin.js');
const PROVISIONER_ENTRY = path.join(
  __dirname,
  '../../workspace-provisioner.main.ts',
);
const PROVISIONER_TSCONFIG = path.join(__dirname, '../../../tsconfig.app.json');
const FIXTURE_PASSWORD = generateFixturePassword();
const LOCK_KEY = `hashtext('rab_workspace_provisioning')`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class ProcessWatch {
  output = '';
  exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  constructor(readonly proc: ChildProcessWithoutNullStreams) {
    proc.stdout.on('data', (c: Buffer) => (this.output += c.toString('utf8')));
    proc.stderr.on('data', (c: Buffer) => (this.output += c.toString('utf8')));
    proc.on('exit', (code, signal) => (this.exit = { code, signal }));
  }
  async waitFor(pattern: RegExp, timeoutMs = 60_000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (!pattern.test(this.output)) {
      if (this.exit)
        throw new Error(
          `process exited (${JSON.stringify(this.exit)}) before ${pattern}; output:\n${this.output}`,
        );
      if (Date.now() > deadline)
        throw new Error(
          `timed out waiting for ${pattern}; output:\n${this.output}`,
        );
      await sleep(100);
    }
    return Date.now();
  }
  async waitExit(
    timeoutMs = 30_000,
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    const deadline = Date.now() + timeoutMs;
    while (!this.exit) {
      if (Date.now() > deadline)
        throw new Error(`process did not exit within ${timeoutMs} ms`);
      await sleep(100);
    }
    return this.exit;
  }
}

describeIfDb(
  'Phase A verification — provisioner resilience (integration)',
  () => {
    let admin: DataSource;
    let superClient: Client;
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
      if (!redisUrl)
        throw new Error(
          'REDIS_URL (the isolated test Redis) is required; there is no fallback.',
        );
      REDIS_URL = redisUrl;
      admin = createAdminDataSource();
      await admin.initialize();
      superClient = new Client({
        connectionString: resolveIntegrationTestDatabase(process.env).adminUrl,
      });
      await superClient.connect();
      passwordHashing = new PasswordHashingService();
    });

    afterEach(async () => {
      for (const p of procs)
        if (p.exitCode === null && !p.killed) p.kill('SIGKILL');
      procs.length = 0;
      for (const c of clients) await c.end().catch(() => undefined);
      clients.length = 0;
      await sleep(500);
      for (const workspaceId of workspaceIds) {
        const org = await admin.query(
          `SELECT organisation_id FROM core.manager_workspace WHERE id = $1`,
          [workspaceId],
        );
        if (org.length > 0) {
          await admin.transaction(async (m) => {
            await m.query(
              `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true)`,
              [org[0].organisation_id, workspaceId],
            );
            await m.query(
              `DELETE FROM core.workspace_schema_registry WHERE workspace_id = $1`,
              [workspaceId],
            );
            await m.query(
              `DELETE FROM core.manager_profile WHERE workspace_id = $1`,
              [workspaceId],
            );
            await m.query(`DELETE FROM core.manager_workspace WHERE id = $1`, [
              workspaceId,
            ]);
          });
        }
        await admin.query(
          `DROP SCHEMA IF EXISTS ${workspaceSchemaName(workspaceId)} CASCADE`,
        );
      }
      for (const organisationId of orgIds) {
        await admin.transaction(async (m) => {
          await m.query(`SELECT set_config('rab.organisation_id', $1, true)`, [
            organisationId,
          ]);
          await m.query(`DELETE FROM core."user" WHERE organisation_id = $1`, [
            organisationId,
          ]);
        });
        // Not DELETE FROM core.organisation — same recorded audit_log FK reason as the sibling provisioning specs.
      }
      workspaceIds.length = 0;
      orgIds.length = 0;
    });

    afterAll(async () => {
      await superClient.end().catch(() => undefined);
      await admin.destroy();
    });

    async function seedCreatingWorkspace(label: string): Promise<string> {
      const orgInsert = await admin.manager.insert(Organisation, {
        name: `${label}-${randomUUID()}`,
        slug: `${label}-${randomUUID()}`,
      });
      const organisationId = orgInsert.identifiers[0]!.id as string;
      orgIds.push(organisationId);
      const workspaceId = await admin.transaction(async (m) => {
        await m.query(`SELECT set_config('rab.organisation_id', $1, true)`, [
          organisationId,
        ]);
        let role = await m.findOne(Role, {
          where: { organisationId, key: 'manager' },
        });
        if (!role) {
          const r = await m.insert(Role, {
            organisationId,
            key: 'manager',
            name: 'Manager',
            isSystem: true,
          });
          role = await m.findOneByOrFail(Role, {
            id: r.identifiers[0]!.id as string,
          });
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
        await m.insert(UserRole, {
          userId: ownerUserId,
          roleId: role.id,
          organisationId,
        });
        await m.query(`SELECT set_config('rab.user_id', $1, true)`, [
          ownerUserId,
        ]);
        const ws = await m.save(ManagerWorkspace, {
          organisationId,
          ownerUserId,
          name: `${label} Workspace`,
          subdomain: `${label}-${randomUUID().slice(0, 8)}`,
          status: 'active',
          schemaStatus: 'CREATING',
        });
        await m.query(`SELECT set_config('rab.workspace_id', $1, true)`, [
          ws.id,
        ]);
        await m.insert(ManagerProfile, {
          organisationId,
          userId: ownerUserId,
          type: ManagerType.INTERNAL,
          workspaceId: ws.id,
        });
        return ws.id as string;
      });
      workspaceIds.push(workspaceId);
      return workspaceId;
    }

    /** "<manager_workspace.schema_status>|<registry status or ->" — read as the superuser admin (no RLS). */
    async function status(workspaceId: string): Promise<string> {
      const rows: Array<{ s: string }> = await admin.query(
        `SELECT coalesce(mw.schema_status, 'NULL') || '|' || coalesce(r.status, '-') AS s
         FROM core.manager_workspace mw LEFT JOIN core.workspace_schema_registry r ON r.workspace_id = mw.id WHERE mw.id = $1`,
        [workspaceId],
      );
      return rows[0]?.s ?? 'missing';
    }

    async function waitStatus(
      workspaceId: string,
      want: string | RegExp,
      timeoutMs = 60_000,
    ): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const s = await status(workspaceId);
        if (typeof want === 'string' ? s === want : want.test(s)) return;
        if (Date.now() > deadline)
          throw new Error(
            `workspace ${workspaceId} not ${want} after ${timeoutMs} ms (last: ${s})`,
          );
        await sleep(250);
      }
    }

    async function relationCount(schema: string): Promise<number> {
      const [{ n }] = await admin.query(
        `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = $1 AND c.relkind = 'r'`,
        [schema],
      );
      return n;
    }

    async function assertProvisionedOnce(workspaceId: string): Promise<void> {
      const schema = workspaceSchemaName(workspaceId);
      expect(await status(workspaceId)).toBe('READY|READY');
      const [{ n: schemas }] = await admin.query(
        `SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1`,
        [schema],
      );
      expect(schemas).toBe(1);
      expect(await relationCount(schema)).toBe(V1_EXPECTED.tables);
      const names: Array<{ relname: string }> = await admin.query(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = $1 AND c.relkind = 'r'`,
        [schema],
      );
      expect(names.map((r) => r.relname).sort()).toEqual(
        [...WORKSPACE_TABLES].sort(),
      );
      const [{ n: policies }] = await admin.query(
        `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = $1`,
        [schema],
      );
      expect(policies).toBe(V1_EXPECTED.policies);
      const reg: Array<{ n: number; err: string | null }> = await admin.query(
        `SELECT count(*)::int AS n, max(migration_error) AS err FROM core.workspace_schema_registry WHERE workspace_id = $1`,
        [workspaceId],
      );
      expect(reg[0]!.n).toBe(1);
      expect(reg[0]!.err).toBeNull();
      const [mw] = await admin.query(
        `SELECT schema_last_error FROM core.manager_workspace WHERE id = $1`,
        [workspaceId],
      );
      expect(mw.schema_last_error).toBeNull();
      // One READY transition: recordProvisioned writes exactly one APPLIED ledger row per module inside the READY transaction.
      // A second (duplicate) provisioning would add attempt-2 rows for the same modules.
      const ledger: Array<{
        rows: number;
        modules: number;
        maxAttempt: number;
        notApplied: number;
      }> = await admin.query(
        `SELECT count(*)::int AS rows, count(DISTINCT module_id)::int AS modules, coalesce(max(attempt), 0)::int AS "maxAttempt",
              count(*) FILTER (WHERE status <> 'APPLIED')::int AS "notApplied"
         FROM core.workspace_schema_migration WHERE workspace_id = $1`,
        [workspaceId],
      );
      expect(ledger[0]!.rows).toBeGreaterThan(0);
      expect(ledger[0]!.rows).toBe(ledger[0]!.modules);
      expect(ledger[0]!.maxAttempt).toBe(1);
      expect(ledger[0]!.notApplied).toBe(0);
    }

    async function crewflowClient(appName: string): Promise<Client> {
      const c = new Client({
        connectionString: CREWFLOW_URL,
        application_name: appName,
      });
      c.on('error', () => undefined);
      await c.connect();
      clients.push(c);
      return c;
    }

    function spawnProvisioner(
      appName: string,
      extra: Record<string, string | undefined> = {},
    ): ProcessWatch {
      const base: Record<string, string | undefined> = { ...process.env };
      for (const k of [
        'CREWFLOW_PROVISIONER_ENABLED',
        'HWS_RUNTIME_ENABLED',
        'WORKSPACE_PROVISIONER_INTERVAL_SECONDS',
        'CREWFLOW_PROVISIONER_DATABASE_URL',
      ])
        delete base[k];
      const merged: Record<string, string | undefined> = {
        ...base,
        NODE_ENV: 'development',
        RAB_RUNTIME_ENV: 'development',
        DATABASE_URL: CREWFLOW_URL,
        DATABASE_URL_UNPOOLED: CREWFLOW_URL,
        DATABASE_DIRECT_URL: CREWFLOW_URL,
        REDIS_URL,
        // The committed production / QA / e2e configuration after Phase A.
        CREWFLOW_PROVISIONER_ENABLED: 'true',
        HWS_RUNTIME_ENABLED: 'false',
        WORKSPACE_PROVISIONER_INTERVAL_SECONDS: '5',
        PGAPPNAME: appName,
        ...extra,
      };
      for (const [k, v] of Object.entries(merged))
        if (v === undefined) delete merged[k];
      const proc = spawn(
        process.execPath,
        [
          TS_NODE_BIN,
          '--transpile-only',
          '-P',
          PROVISIONER_TSCONFIG,
          PROVISIONER_ENTRY,
        ],
        {
          cwd: REPO_ROOT,
          env: merged as Record<string, string>,
        },
      );
      procs.push(proc);
      return new ProcessWatch(proc);
    }

    const STARTED =
      /\[workspace-provisioner\] started, HWS_RUNTIME_ENABLED=false \(provisioning enabled by CREWFLOW_PROVISIONER_ENABLED; interval 5s\)/;

    async function backendsOf(
      appName: string,
    ): Promise<
      Array<{
        pid: number;
        wait_event_type: string | null;
        state: string | null;
      }>
    > {
      return superClient
        .query(
          `SELECT pid, wait_event_type, state FROM pg_stat_activity WHERE application_name = $1`,
          [appName],
        )
        .then((r) => r.rows);
    }

    async function advisoryHolders(): Promise<number[]> {
      const r = await superClient.query<{ pid: number }>(
        `SELECT l.pid FROM pg_locks l WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1 AND l.objid::bigint = ((${LOCK_KEY})::bigint & 4294967295)`,
      );
      return r.rows.map((x) => x.pid);
    }

    // ------------------------------------------------------------------------------------------------------------- R1
    it('R1 real process (prod config): a failing workspace is recorded FAILED with a safe error, the process keeps running, and the same request is retried to READY once the cause is removed', async () => {
      const workspaceId = await seedCreatingWorkspace('pa2-fail');
      const schema = workspaceSchemaName(workspaceId);
      // Deterministic, real failure cause: a pre-existing schema of that name NOT owned by rab_secure_owner — the attempt's
      // committed step (core.provision_workspace_schema) refuses it with 42501.
      await superClient.query(`CREATE SCHEMA ${schema}`);
      await superClient.query(`CREATE TABLE ${schema}.planted (id int)`);

      const w = spawnProvisioner(`pa2-r1-${randomUUID().slice(0, 8)}`);
      await w.waitFor(STARTED);
      // The refused attempt rolled back its own registry insert, so the registry may have no row: manager_workspace is the record.
      await waitStatus(workspaceId, /^FAILED\|(FAILED|-)$/, 60_000);
      const [mw] = await admin.query(
        `SELECT schema_last_error FROM core.manager_workspace WHERE id = $1`,
        [workspaceId],
      );
      expect(typeof mw.schema_last_error).toBe('string');
      expect(mw.schema_last_error).not.toMatch(
        /planted|rab_secure_owner|existing schema/,
      ); // safe summary, never the driver text
      // FAILED is retried every tick and stays FAILED while the cause persists — never READY, process alive.
      await sleep(6_000);
      expect(await status(workspaceId)).toMatch(/^FAILED\|(FAILED|-)$/);
      expect(w.exit).toBeNull();

      await superClient.query(`DROP SCHEMA ${schema} CASCADE`);
      await waitStatus(workspaceId, 'READY|READY', 60_000);
      expect(w.exit).toBeNull();
      const [{ n: tables }] = await admin.query(
        `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = $1 AND c.relkind = 'r'`,
        [schema],
      );
      expect(tables).toBe(V1_EXPECTED.tables);
      w.proc.kill('SIGKILL');
    });

    // ------------------------------------------------------------------------------------------------------------- R3
    it('R3 a provisioner killed MID-CYCLE (inside the DDL transaction) loses nothing: the request lives on as manager_workspace CREATING; a second replica waits only its bound while the dead backend holds the lock; the restarted provisioner finishes it', async () => {
      const workspaceId = await seedCreatingWorkspace('pa2-kill');
      const schema = workspaceSchemaName(workspaceId);
      const blocker = new Client({
        connectionString: resolveIntegrationTestDatabase(process.env).adminUrl,
        application_name: 'pa2-blocker',
      });
      await blocker.connect();
      clients.push(blocker);
      await blocker.query('BEGIN');
      // The template's FKs to core.stored_file need SHARE ROW EXCLUSIVE on it; SHARE conflicts, so the apply transaction
      // parks at that statement — deterministically mid-DDL. Reads of stored_file are unaffected.
      await blocker.query('LOCK TABLE core.stored_file IN SHARE MODE');

      const appA = `pa2-r3a-${randomUUID().slice(0, 8)}`;
      const a = spawnProvisioner(appA);
      await a.waitFor(STARTED);
      // Wait until A's PROVISIONING backend is blocked on the blocker's table lock (i.e. inside the apply transaction).
      // Identified by the lock it waits for, not as "any backend of A in a Lock wait": process A also opens its own
      // workspace-schema-drift connection at start-up (same application_name), and on a database holding other workspaces
      // (the shared CI database) that pass can still be running and park on the registry row A's apply transaction holds
      // FOR UPDATE (core.record_workspace_schema_drift) — also a 'Lock' wait, but not the backend that holds the lock.
      const deadline = Date.now() + 60_000;
      let aPid: number | null = null;
      for (;;) {
        const rows = await backendsOf(appA);
        const blocked = await superClient.query<{ pid: number }>(
          `SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE a.application_name = $1 AND l.locktype = 'relation' AND NOT l.granted
              AND l.relation = 'core.stored_file'::regclass`,
          [appA],
        );
        if (blocked.rows.length > 0) {
          expect(blocked.rows).toHaveLength(1);
          aPid = blocked.rows[0]!.pid;
          break;
        }
        if (Date.now() > deadline)
          throw new Error(
            `provisioner A never blocked mid-DDL; backends: ${JSON.stringify(rows)}; output:\n${a.output}`,
          );
        await sleep(100);
      }

      // Where the request lives at the moment of the kill: committed attempt-start step + discoverable lifecycle state.
      expect(await status(workspaceId)).toBe('CREATING|PROVISIONING');
      expect(await relationCount(schema)).toBe(0); // the in-flight DDL is invisible (uncommitted)
      expect(await advisoryHolders()).toEqual([aPid]);
      const discoverable = await superClient.query(
        `SELECT workspace_id FROM core.worker_list_pending_workspace_schemas(50) WHERE workspace_id = $1`,
        [workspaceId],
      );
      expect(discoverable.rows).toHaveLength(1);

      a.proc.kill('SIGKILL');
      await a.waitExit(30_000);

      // PostgreSQL 16 with client_connection_check_interval=0: a backend blocked on a lock does not notice its client died, so
      // the DEAD holder's session (and the provisioning advisory lock) survives until its statement can proceed.
      const holdersAfterKill = await advisoryHolders();
      const deadHolderStillHolds = holdersAfterKill.includes(aPid!);

      const appB = `pa2-r3b-${randomUUID().slice(0, 8)}`;
      const b = spawnProvisioner(appB);
      const bStarted = await b.waitFor(STARTED);
      if (deadHolderStillHolds) {
        // Bounded: B gives up after its 10 s wait and SKIPS the tick (no hang, no DDL), and keeps ticking.
        const skippedAt = await b.waitFor(
          /workspace provisioning: skipped — another provisioner held the provisioning lock/,
          40_000,
        );
        expect(skippedAt - bStarted).toBeGreaterThanOrEqual(8_000);
        expect(skippedAt - bStarted).toBeLessThan(25_000);
        expect(await status(workspaceId)).toBe('CREATING|PROVISIONING');
        expect(b.exit).toBeNull();
      }

      // Release the table lock: the dead client's backend runs into its closed socket, aborts (ROLLBACK, never COMMIT) and
      // ends, releasing the advisory lock; B's next attempt takes it and provisions the SAME request.
      await blocker.query('ROLLBACK');
      const releaseDeadline = Date.now() + 30_000;
      while ((await advisoryHolders()).includes(aPid!)) {
        if (Date.now() > releaseDeadline)
          throw new Error(
            'the dead holder never released the provisioning lock',
          );
        await sleep(200);
      }
      // Every backend of the dead process ends — including its drift connection, which (on a shared database) may have been
      // queued behind the dead holder's registry row lock and only reaches its closed socket once that lock is gone.
      while (
        (await backendsOf(appA)).length > 0 &&
        Date.now() <= releaseDeadline
      )
        await sleep(200);
      expect((await backendsOf(appA)).length).toBe(0);
      await waitStatus(workspaceId, 'READY|READY', 60_000);
      await assertProvisionedOnce(workspaceId);
      expect(b.exit).toBeNull();
      // eslint-disable-next-line no-console
      console.log(
        `[R3 evidence] dead holder still held the lock after SIGKILL: ${deadHolderStillHolds}`,
      );
    });

    // ------------------------------------------------------------------------------------------------------------- R4
    it('R4 two concurrent cycles (two replicas) on the SAME three CREATING workspaces: one schema and one READY transition each, no failure, no DDL error; a re-run is a no-op', async () => {
      const ids = [
        await seedCreatingWorkspace('pa2-race1'),
        await seedCreatingWorkspace('pa2-race2'),
        await seedCreatingWorkspace('pa2-race3'),
      ];
      const a = await crewflowClient(`pa2-r4a-${randomUUID().slice(0, 8)}`);
      const b = await crewflowClient(`pa2-r4b-${randomUUID().slice(0, 8)}`);

      const results: WorkspaceProvisioningResult[] = await Promise.all([
        runWorkspaceProvisioningCycle(a),
        runWorkspaceProvisioningCycle(b),
      ]);
      // eslint-disable-next-line no-console
      console.log(`[R4 evidence] cycle results: ${JSON.stringify(results)}`);
      expect(results.some((r) => r.lockAcquired)).toBe(true);
      expect(results.reduce((n, r) => n + r.failed, 0)).toBe(0);
      expect(results.reduce((n, r) => n + r.ready, 0)).toBeGreaterThanOrEqual(
        ids.length,
      );
      // Whichever cycle came second (if it got the lock within its bound) found nothing of ours left to do.
      const acquired = results.filter((r) => r.lockAcquired);
      if (acquired.length === 2)
        expect(Math.min(acquired[0]!.attempted, acquired[1]!.attempted)).toBe(
          0,
        );
      for (const id of ids) await assertProvisionedOnce(id);

      const again = await Promise.all([
        runWorkspaceProvisioningCycle(a),
        runWorkspaceProvisioningCycle(b),
      ]);
      expect(again.reduce((n, r) => n + r.failed, 0)).toBe(0);
      for (const id of ids) await assertProvisionedOnce(id);
    });

    // ------------------------------------------------------------------------------------------------------------- R5
    it('R5a shutdown aborts the bounded lock wait at once (real lock holder): no discovery, no DDL, nothing left held', async () => {
      const workspaceId = await seedCreatingWorkspace('pa2-abort');
      const holder = await crewflowClient(
        `pa2-r5a-h-${randomUUID().slice(0, 8)}`,
      );
      const prov = await crewflowClient(
        `pa2-r5a-p-${randomUUID().slice(0, 8)}`,
      );
      await holder.query(`SELECT pg_advisory_lock(${LOCK_KEY})`);
      let shuttingDown = false;
      setTimeout(() => (shuttingDown = true), 400);
      const t0 = Date.now();
      const result = await runWorkspaceProvisioningCycle(prov, undefined, {
        shouldAbort: () => shuttingDown,
      }); // default 10 s wait
      const took = Date.now() - t0;
      expect(result).toEqual({
        attempted: 0,
        ready: 0,
        failed: 0,
        lockAcquired: false,
      });
      expect(took).toBeLessThan(2_000); // not the 10 s bound, and never unbounded
      expect(await status(workspaceId)).toBe('CREATING|-');
      const held = await prov.query(
        `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()`,
      );
      expect(held.rows[0].n).toBe(0);
      await holder.query(`SELECT pg_advisory_unlock(${LOCK_KEY})`);
    });

    it('R5b a lock holder whose process dies (socket gone while idle) releases the session lock at once; a waiting cycle then provisions within its bound', async () => {
      const workspaceId = await seedCreatingWorkspace('pa2-holder-dies');
      const holderApp = `pa2-r5b-h-${randomUUID().slice(0, 8)}`;
      const holder = await crewflowClient(holderApp);
      const prov = await crewflowClient(
        `pa2-r5b-p-${randomUUID().slice(0, 8)}`,
      );
      await holder.query(`SELECT pg_advisory_lock(${LOCK_KEY})`);
      const holderPid = (
        await superClient.query(
          `SELECT pid FROM pg_stat_activity WHERE application_name = $1`,
          [holderApp],
        )
      ).rows[0].pid as number;
      const provPid = (await prov.query(`SELECT pg_backend_pid() AS pid`))
        .rows[0].pid as number;
      expect(await advisoryHolders()).toEqual([holderPid]);
      const pending = runWorkspaceProvisioningCycle(prov); // default bounded wait (10 s)
      await sleep(1_500);
      // Simulate the holder's process dying: its TCP connection is torn down without a Terminate message.
      (
        holder as unknown as { connection: { stream: { destroy(): void } } }
      ).connection.stream.destroy();
      const killedAt = Date.now();
      // The waiting cycle takes the lock as soon as the server notices the dead (idle) session — well inside its 10 s bound.
      for (;;) {
        const holders = await advisoryHolders();
        if (holders.length === 1 && holders[0] === provPid) break;
        if (Date.now() - killedAt > 8_000)
          throw new Error(
            `lock not handed over after the holder died; holders=${JSON.stringify(holders)}`,
          );
        await sleep(50);
      }
      const handoverMs = Date.now() - killedAt;
      // eslint-disable-next-line no-console
      console.log(
        `[R5b evidence] lock handed to the waiting cycle ${handoverMs} ms after the holder's connection died`,
      );
      expect(handoverMs).toBeLessThan(3_000);
      const result = await pending;
      expect(result.lockAcquired).toBe(true);
      expect(result.failed).toBe(0);
      expect(result.ready).toBeGreaterThanOrEqual(1);
      await assertProvisionedOnce(workspaceId);
      expect(await advisoryHolders()).toEqual([]); // released by the cycle that took it
    });
  },
);
