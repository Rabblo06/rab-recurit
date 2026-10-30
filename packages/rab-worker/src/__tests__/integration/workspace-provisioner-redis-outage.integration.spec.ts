import 'reflect-metadata';
import { ManagerType, UserStatus } from '@rab/shared';
import {
  ChildProcessWithoutNullStreams,
  execFileSync,
  spawn,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';

import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { ManagerProfile } from '@rab/server/modules/manager/entities/manager-profile.entity';
import { ManagerWorkspace } from '@rab/server/modules/manager-workspace/entities/manager-workspace.entity';
import {
  Organisation,
  Role,
  User,
  UserRole,
} from '@rab/server/modules/identity/entities/index';
import {
  PROVISIONER_HEARTBEAT_KEY,
  PROVISIONER_STATS_KEY,
} from '@rab/server/engine/worker-shared/heartbeat.constants';
import {
  V1_EXPECTED,
  workspaceSchemaName,
} from '@rab/server/database/typeorm/workspace-schema/provision-workspace-schema';
import { createAdminDataSource } from './helpers/admin-datasource';
import { generateFixturePassword } from './helpers/fixture-password';
import { verifiedCrewflowUrl } from './helpers/verified-role-database';
import { withApplicationName } from './helpers/application-name-url';
import { runtimeChildBaseEnv } from './helpers/runtime-child-env';

/**
 * Phase A verification (pa-prov2) — the workspace provisioner and a Redis outage. The provisioner uses Redis ONLY for its
 * heartbeat/stats (workspace-provisioner.main.ts), but it `await redis.ping()`s at start-up with `maxRetriesPerRequest:
 * null`. These tests drive a THROWAWAY Redis container (stopped and started by the test) and the REAL entrypoint at the
 * committed production configuration, against the disposable test database with the real `crewflow` login.
 *
 *  O1  Redis DOWN at start-up → the process neither exits nor provisions: start-up blocks at the ping (no "started" line,
 *      no provisioning tick) for as long as Redis is down, and resumes by itself when Redis returns.
 *  O2  Redis restarted MID-RUN → provisioning ticks continue during the outage (a workspace seeded while Redis is down
 *      reaches READY), the process stays up, and after Redis returns the heartbeat key and stats are written again.
 *
 * Opt-in (it stops and starts a container): set PA_REDIS_OUTAGE_CONTAINER to a container whose name starts with
 * `crewflow-pa-` and PA_REDIS_OUTAGE_URL to its loopback URL (e.g. `docker run -d --name crewflow-pa-prov2-redis
 * -p 127.0.0.1:16399:6379 redis:7-alpine redis-server --save "" --appendonly no`). Never point it at a shared Redis.
 */
const CONTAINER = process.env.PA_REDIS_OUTAGE_CONTAINER?.trim() ?? '';
const OUTAGE_URL = process.env.PA_REDIS_OUTAGE_URL?.trim() ?? '';
const RUN =
  Boolean(process.env.DATABASE_URL) &&
  /^crewflow-pa-[a-z0-9-]+$/.test(CONTAINER) &&
  /^redis:\/\/127\.0\.0\.1:\d+$/.test(OUTAGE_URL);
const describeIfEnabled = RUN ? describe : describe.skip;
jest.setTimeout(240_000);

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const TS_NODE_BIN = path.join(REPO_ROOT, 'node_modules/ts-node/dist/bin.js');
const PROVISIONER_ENTRY = path.join(
  __dirname,
  '../../workspace-provisioner.main.ts',
);
const PROVISIONER_TSCONFIG = path.join(__dirname, '../../../tsconfig.app.json');
const FIXTURE_PASSWORD = generateFixturePassword();
const STARTED =
  /\[workspace-provisioner\] started, HWS_RUNTIME_ENABLED=false \(provisioning enabled by CREWFLOW_PROVISIONER_ENABLED; interval 5s\)/;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const docker = (...args: string[]) =>
  execFileSync('docker', args, { stdio: 'pipe', timeout: 60_000 })
    .toString()
    .trim();

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
}

describeIfEnabled(
  'Phase A verification — provisioner vs a Redis outage (integration, throwaway Redis)',
  () => {
    let admin: DataSource;
    let passwordHashing: PasswordHashingService;
    let CREWFLOW_URL: string;
    const procs: ChildProcessWithoutNullStreams[] = [];
    const orgIds: string[] = [];
    const workspaceIds: string[] = [];

    async function redisUp(): Promise<void> {
      docker('start', CONTAINER);
      const deadline = Date.now() + 30_000;
      for (;;) {
        const probe = new Redis(OUTAGE_URL, {
          lazyConnect: true,
          maxRetriesPerRequest: 0,
          retryStrategy: () => null,
          enableOfflineQueue: false,
        });
        probe.on('error', () => undefined);
        try {
          await probe.connect();
          if ((await probe.ping()) === 'PONG') {
            probe.disconnect();
            return;
          }
        } catch {
          // not yet
        }
        probe.disconnect();
        if (Date.now() > deadline)
          throw new Error('throwaway Redis did not come up');
        await sleep(250);
      }
    }

    async function withRedis<T>(fn: (r: Redis) => Promise<T>): Promise<T> {
      const r = new Redis(OUTAGE_URL, {
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      });
      r.on('error', () => undefined);
      try {
        return await fn(r);
      } finally {
        r.disconnect();
      }
    }

    beforeAll(async () => {
      // Safety: the container must be a loopback-published throwaway of ours.
      const ports = docker('port', CONTAINER, '6379/tcp');
      if (!/^127\.0\.0\.1:\d+$/m.test(ports))
        throw new Error(
          `refusing: ${CONTAINER} is not published on loopback only`,
        );
      CREWFLOW_URL = await verifiedCrewflowUrl();
      admin = createAdminDataSource();
      await admin.initialize();
      passwordHashing = new PasswordHashingService();
      await redisUp();
    });

    afterEach(async () => {
      for (const p of procs)
        if (p.exitCode === null && !p.killed) p.kill('SIGKILL');
      procs.length = 0;
      await redisUp();
      await sleep(500);
      try {
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
              await m.query(
                `DELETE FROM core.manager_workspace WHERE id = $1`,
                [workspaceId],
              );
            });
          }
          await admin.query(
            `DROP SCHEMA IF EXISTS ${workspaceSchemaName(workspaceId)} CASCADE`,
          );
        }
        for (const organisationId of orgIds) {
          await admin.transaction(async (m) => {
            await m.query(
              `SELECT set_config('rab.organisation_id', $1, true)`,
              [organisationId],
            );
            await m.query(
              `DELETE FROM core."user" WHERE organisation_id = $1`,
              [organisationId],
            );
          });
        }
      } finally {
        workspaceIds.length = 0;
        orgIds.length = 0;
      }
    });

    afterAll(async () => {
      await admin?.destroy();
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

    async function status(workspaceId: string): Promise<string> {
      const rows: Array<{ s: string }> = await admin.query(
        `SELECT coalesce(mw.schema_status, 'NULL') || '|' || coalesce(r.status, '-') AS s
         FROM core.manager_workspace mw LEFT JOIN core.workspace_schema_registry r ON r.workspace_id = mw.id WHERE mw.id = $1`,
        [workspaceId],
      );
      return rows[0]?.s ?? 'missing';
    }

    async function waitReady(
      workspaceId: string,
      timeoutMs: number,
    ): Promise<number> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if ((await status(workspaceId)) === 'READY|READY') return Date.now();
        if (Date.now() > deadline)
          throw new Error(
            `workspace ${workspaceId} not READY after ${timeoutMs} ms (last: ${await status(workspaceId)})`,
          );
        await sleep(250);
      }
    }

    function spawnProvisioner(appName: string): ProcessWatch {
      const base: Record<string, string | undefined> = runtimeChildBaseEnv();
      for (const k of [
        'CREWFLOW_PROVISIONER_ENABLED',
        'HWS_RUNTIME_ENABLED',
        'WORKSPACE_PROVISIONER_INTERVAL_SECONDS',
        'CREWFLOW_PROVISIONER_DATABASE_URL',
      ])
        delete base[k];
      const url = withApplicationName(CREWFLOW_URL, appName);
      const merged: Record<string, string | undefined> = {
        ...base,
        NODE_ENV: 'development',
        RAB_RUNTIME_ENV: 'development',
        DATABASE_URL: url,
        DATABASE_URL_UNPOOLED: url,
        DATABASE_DIRECT_URL: url,
        REDIS_URL: OUTAGE_URL,
        CREWFLOW_PROVISIONER_ENABLED: 'true',
        HWS_RUNTIME_ENABLED: 'false',
        WORKSPACE_PROVISIONER_INTERVAL_SECONDS: '5',
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

    it('O1 Redis DOWN at start-up: the provisioner blocks at its Redis ping — alive, no "started", NO provisioning tick — and resumes by itself once Redis returns', async () => {
      docker('stop', '-t', '1', CONTAINER);
      const workspaceId = await seedCreatingWorkspace('pa2-redis-down');
      const appName = `pa2-o1-${randomUUID().slice(0, 8)}`;
      const w = spawnProvisioner(appName);
      // The live identity probe runs BEFORE the Redis ping, so reaching it proves the process got that far.
      await w.waitFor(/\[runtime-db-guard\] process=provisioner/, 60_000);
      await sleep(20_000); // four 5 s intervals' worth of time with Redis down
      expect(w.exit).toBeNull(); // neither crashes nor exits
      expect(STARTED.test(w.output)).toBe(false); // never got past `await redis.ping()`
      expect(await status(workspaceId)).toBe('CREATING|-'); // no provisioning tick ran at all
      // eslint-disable-next-line no-console
      console.log(
        `[O1 evidence] output while Redis was down (tail):\n${w.output.slice(-600)}`,
      );

      const upAt = Date.now();
      await redisUp();
      const startedAt = await w.waitFor(STARTED, 60_000);
      const readyAt = await waitReady(workspaceId, 60_000);
      // eslint-disable-next-line no-console
      console.log(
        `[O1 evidence] started ${startedAt - upAt} ms after Redis came back; READY ${readyAt - upAt} ms after`,
      );
      const [{ n }] = await admin.query(
        `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = $1 AND c.relkind = 'r'`,
        [workspaceSchemaName(workspaceId)],
      );
      expect(n).toBe(V1_EXPECTED.tables);
      expect(w.exit).toBeNull();
    });

    it('O2 Redis restarted MID-RUN: provisioning continues while Redis is down, the process stays up, and heartbeat/stats resume after Redis returns', async () => {
      const appName = `pa2-o2-${randomUUID().slice(0, 8)}`;
      const w = spawnProvisioner(appName);
      await w.waitFor(STARTED, 60_000);
      // Heartbeat reached Redis while it was up.
      const hbDeadline = Date.now() + 20_000;
      while (!(await withRedis((r) => r.get(PROVISIONER_HEARTBEAT_KEY)))) {
        if (Date.now() > hbDeadline)
          throw new Error('no provisioner heartbeat in Redis');
        await sleep(250);
      }

      docker('stop', '-t', '1', CONTAINER);
      const downAt = Date.now();
      const workspaceId = await seedCreatingWorkspace('pa2-redis-mid');
      const readyAt = await waitReady(workspaceId, 45_000); // within a few 5 s ticks, Redis still down
      // eslint-disable-next-line no-console
      console.log(
        `[O2 evidence] workspace seeded during the outage reached READY ${readyAt - downAt} ms after Redis stopped`,
      );
      await sleep(3_000);
      expect(w.exit).toBeNull();

      await redisUp(); // the throwaway runs with no persistence, so it comes back EMPTY
      const upAt = Date.now();
      const deadline = Date.now() + 40_000;
      let hb: string | null = null;
      let stats: Record<string, string> = {};
      for (;;) {
        hb = await withRedis((r) => r.get(PROVISIONER_HEARTBEAT_KEY));
        stats = await withRedis((r) => r.hgetall(PROVISIONER_STATS_KEY));
        if (hb && stats.lastWorkspaceProvisioningAt) break;
        if (Date.now() > deadline)
          throw new Error(
            `heartbeat/stats not written after Redis returned: hb=${hb} stats=${JSON.stringify(stats)}\n${w.output.slice(-800)}`,
          );
        await sleep(500);
      }
      // eslint-disable-next-line no-console
      console.log(
        `[O2 evidence] heartbeat+stats back ${Date.now() - upAt} ms after Redis returned; stats=${JSON.stringify(stats)}`,
      );
      expect(Number(hb)).toBeGreaterThanOrEqual(downAt);
      expect(w.exit).toBeNull();
    });
  },
);
