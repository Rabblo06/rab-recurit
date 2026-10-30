import { releaseEarlyBootSignalGuard } from '@rab/server/engine/utils/early-boot-signal-guard'; // MUST stay the first import
import { config as loadDotenv } from 'dotenv';
import * as path from 'node:path';

// Deliberately NOT `import 'dotenv/config'` (which loads the default `.env` next to the process's
// cwd) — this process loads its OWN, separate env file, explicitly, and nothing else. See this
// file's own top doc comment and `.env.provisioner`'s own comment for why.
loadDotenv({ path: path.join(__dirname, '..', '.env.provisioner') });

import '@rab/server/instrument';

import { Logger as NestLogger } from '@nestjs/common';
import Redis from 'ioredis';

import { assertRuntimeDatabaseIdentity } from '@rab/server/database/typeorm/core/runtime-database-guard';
import { checkSchemaCompatibility, isProductionProcess, runDatabaseBootGates } from '@rab/server/database/boot-checks/database-boot-gates';
import { pgClientConfig, probePgSessionAffinity, resolvePgEnvironmentCached, setPgProcessRole } from '@rab/server/database/postgres/index';
import {
  PROVISIONER_CYCLE_DURATIONS_KEY,
  PROVISIONER_HEARTBEAT_KEY,
  PROVISIONER_STATS_KEY,
  WORKER_STATS_KEY,
} from '@rab/server/engine/worker-shared/heartbeat.constants';
import { runWorkspaceProvisioningCycle } from './queues/rab-maintenance/workspace-provisioning.job';
import { runWorkspaceSchemaDriftCycle } from './queues/rab-maintenance/workspace-schema-drift.job';
import { ReconnectingPgClient } from './core/database/reconnecting-pg-client';
import { createInstanceHeartbeat } from './core/runtime/instance-heartbeat';
import { WorkerRuntime } from './core/runtime/worker-runtime';
import { resolveProvisionerConfig } from './workspace-provisioner.config';

/**
 * Worker credential isolation checkpoint — the ONE process in this whole monorepo that holds
 * `DATABASE_URL_UNPOOLED`, the privileged migration/provisioning identity (`crewflow`, which owns
 * the 36 ordinary business tables and can `CREATE SCHEMA`/`CREATE TABLE` inside a newly-provisioned
 * workspace). The ordinary API and Worker processes (`rab-server/src/main.ts`,
 * `rab-worker/src/main.ts`) never read this env var, never hold this connection, and now actively
 * refuse to boot if it is present in their environment at all (see `runtime-database-guard.ts`).
 *
 * This is Option A from the credential-isolation dependency map: workspace provisioning was the
 * one genuinely privileged, DDL-performing operation the ordinary Worker used to run (on a
 * dedicated connection, but still inside the same process) — moved here, a wholly separate
 * deployable, instead of narrowed to a SECURITY DEFINER function, because the actual DDL
 * (`provisionWorkspaceSchema`'s own CREATE TABLE/INDEX/POLICY statements — the full V1 template)
 * cannot be expressed as one narrow, auditable function without becoming either an arbitrary-SQL
 * interface or an unmaintainable pile of workspace-shape-specific functions. See
 * `docs/architecture/WORKSPACE-PROVISIONER-OPERATIONS.md` for how to run this separately in
 * production, environment variables, scheduling, health/monitoring and restart behaviour — none
 * of that is decided or deployed by this change; this file is the code-level separation only.
 *
 * Reuses `runWorkspaceProvisioningCycle` and `provisionWorkspaceSchema` UNCHANGED — same durable
 * lifecycle states (`CREATING`/`FAILED`/`READY`), same session-level `pg_advisory_lock` (so two
 * provisioner instances — or this process and, before this change, the ordinary Worker — can never
 * provision the same workspace concurrently), same idempotent retry-from-`FAILED` semantics, same
 * audit trail. Nothing about the provisioning WORKFLOW changed, only which process and credential
 * runs it.
 *
 * No HTTP server, no BullMQ queue consumer, no email/notification/report logic — this process does
 * exactly one thing on a fixed interval, and nothing else. Phase A (pa-provisioner): gated by
 * `CREWFLOW_PROVISIONER_ENABLED` (the Worker bundle's explicit opt-in; standalone with it unset, the legacy
 * `HWS_RUNTIME_ENABLED=true` gate), decided BEFORE any connection is opened; interval from
 * `WORKSPACE_PROVISIONER_INTERVAL_SECONDS` (default 60 s) — see workspace-provisioner.config.ts. It cannot be asked to run arbitrary SQL: its only exposed surface is this one scheduled
 * cycle, with no network listener at all.
 */
// Was 2 minutes ("same cadence the ordinary Worker used") — correct for a background sweep nobody
// is watching, but wrong once `WorkspacePreparationScreen` became a real-time screen a person sits
// and stares at: a brand-new workspace could wait up to the FULL interval before the provisioner
// even notices it exists, on top of however long the actual DDL work then takes. Confirmed live,
// not theoretical — a real test run spent well over a minute on "Still preparing…" purely waiting
// for this cycle to come back around, not because of any polling/caching bug (both were separately
// confirmed working correctly). 5 seconds keeps the provisioner's own DB load modest (a single
// `core.worker_list_pending_workspace_schemas()` call on an otherwise-empty queue is cheap) while
// keeping the worst-case wait small enough that it comfortably fits inside the 4-second minimum
// animation floor most of the time, and never balloons past the owner's explicit "feel instant"
// requirement for self-service onboarding.
//
// Phase A (pa-provisioner): no longer a fixed constant. WORKSPACE_PROVISIONER_INTERVAL_SECONDS (5..120, default 60 —
// owner-directed default for Phase A) via workspace-provisioner.config.ts. Set it to 5 to restore the cadence above where
// this reconciler is the onboarding path (production and QA compose pin 5; the first cycle still runs immediately).
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
// Wave 2 lane S2 (B4): workspace-schema drift detector, alert-only. Daily is plenty (one catalog read per workspace); it
// also runs once at start-up so a freshly deployed provisioner reports immediately.
const WORKSPACE_SCHEMA_DRIFT_INTERVAL_MS = 24 * 60 * 60 * 1000;

function refuseStartup(error: unknown): never {
  const message = error instanceof Error ? error.message : 'unknown error';
  const prefix =
    error instanceof Error && error.name === 'RuntimeDbError'
      ? '[runtime-db-guard] refused: '
      : error instanceof Error && error.name === 'DatabaseBootGateError'
        ? '[db-boot-gates] '
      : error instanceof Error && error.name === 'PgConfigError'
        ? '[pg-config] refused: '
        : '';
  // eslint-disable-next-line no-console
  console.error(`${prefix}${message}`);
  process.exit(1);
}

async function bootstrap(): Promise<void> {
  // Phase A: decide whether to run at all — and validate the switch and interval — BEFORE the privileged identity probe or
  // any Redis connection. An invalid value refuses to start (names only); "not enabled" exits 0 having opened nothing.
  const config = (() => {
    try {
      return resolveProvisionerConfig(process.env);
    } catch (error) {
      return refuseStartup(error);
    }
  })();
  if (!config.provision) {
    // eslint-disable-next-line no-console
    console.log(
      '[workspace-provisioner] provisioning is not enabled (CREWFLOW_PROVISIONER_ENABLED is not "true", and HWS_RUNTIME_ENABLED is not "true" with the switch unset) — nothing to do. Exiting cleanly before opening any database or Redis connection.',
    );
    process.exit(0);
  }

  await assertRuntimeDatabaseIdentity('provisioner').catch(refuseStartup);
  // Phase B (schema-version compatibility): the same database boot gates as the API and the jobs child, on the privileged
  // provisioning connection and expecting `crewflow` (the provisioner identity until G2). On top of role, version,
  // extensions, deployment identity, FORCE RLS, TLS and pending migrations, the provisioner REFUSES what the API only warns
  // about: a ledger ahead of this code, a core.provision_workspace body that is not exactly this code's module, and any
  // READY workspace above this code's module — it would provision a mixed fleet its verifier cannot check.
  const gateReport = await runDatabaseBootGates('provisioner').catch(refuseStartup);
  const logger = new NestLogger('WorkspaceProvisioner');

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error('REDIS_URL is required — the provisioner must not start without it (used only for its own stats/heartbeat, never a privileged operation)');
  }
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  await redis.ping();

  // Phase B (B1): the privileged provisioning connection comes from the connection factory. Its source is this process's
  // own PG_DATABASE_URL (the Worker bundle launcher hands the provisioner child the provisioner credential under that
  // name); outside production the deprecated DATABASE_URL_UNPOOLED still wins when the launcher sets it (the historical
  // name for this credential). A transaction-pooler URL shape is refused: `provisionWorkspaceSchema` manages its own
  // BEGIN/COMMIT/ROLLBACK pairs on this client and holds a session advisory lock, so it must be a direct connection.
  setPgProcessRole('provisioner');
  const pg = (() => {
    try {
      return resolvePgEnvironmentCached(process.env, { processRole: 'provisioner' });
    } catch (error) {
      return refuseStartup(error);
    }
  })();
  const privilegedEndpoint = pg.elevated ? 'elevated' : 'primary';
  // No statement or query timeout on the provisioning client, exactly as before (workspace DDL can run long); the drift
  // check keeps its own 60 s statement timeout (set by the drift job, which wins over the startup option).
  const provisioningConfig = pgClientConfig(pg, { endpoint: privilegedEndpoint, purpose: 'provisioning', sessionAffinity: true, statementTimeoutMs: 0, queryTimeoutMs: 0 });
  const driftConfig = pgClientConfig(pg, { endpoint: privilegedEndpoint, purpose: 'drift', sessionAffinity: true, statementTimeoutMs: 60_000 });
  // Security review L-3: the provisioning lock is a SESSION advisory lock held across the cycle's own BEGIN/COMMIT pairs,
  // so its connection must be session-stable. Same live two-connection probe the Worker runs (pg-session-probe.ts), on the
  // provisioning endpoint, before the first connection and cycle. The URL denylist above only knows documented shapes.
  await probePgSessionAffinity(
    pgClientConfig(pg, { endpoint: privilegedEndpoint, purpose: 'probe', sessionAffinity: true, statementTimeoutMs: 5_000, queryTimeoutMs: 5_000 }),
    { label: 'the provisioner session-lock connection' },
  ).catch(refuseStartup);
  // W6-E2E-05: the connection is long-lived, so it must survive the database going away (restart, failover, an idle kill,
  // a network blip). A bare pg Client emitted an unhandled 'error' (57P01) on a Postgres restart, the process exited 1 and
  // the Worker bundle failed the whole service. ReconnectingPgClient always listens for 'error', marks the client broken
  // and reconnects on the next cycle with bounded exponential backoff (1 s doubling to 30 s). A cycle interrupted by the
  // drop fails as a whole; the session advisory lock is released by the server with the dead session, and the durable
  // CREATING/FAILED/READY states make the next cycle's retry safe. The first connection must still succeed at start-up.
  const provisioning = new ReconnectingPgClient(
    provisioningConfig,
    { label: 'provisioning', logger, initialBackoffMs: 1_000, maxBackoffMs: 30_000 },
  );
  await provisioning.acquire();

  // Own stats identity (BullMQ migration, owner-approved interval-mode fix): the provisioner's full stats — including ITS
  // startedAt — go to rab:workspace-provisioner:stats. It used to HSET its whole object into rab:worker:stats every 5 s,
  // overwriting the jobs process's startedAt. For existing readers (E2E 5.3, Admin queue health) it still mirrors ONLY
  // its own loop fields (lastWorkspaceProvisioningAt, workspaceProvisioningFailures, drift) into rab:worker:stats —
  // never startedAt — so old and new jobs/provisioner versions can run side by side.
  const runtime = new WorkerRuntime(redis, {
    statsKey: PROVISIONER_STATS_KEY,
    mirrorKey: WORKER_STATS_KEY,
    durationsKey: PROVISIONER_CYCLE_DURATIONS_KEY,
  });
  // Per-instance heartbeat file — a no-op unless CREWFLOW_INSTANCE_HEALTH_FILE is set (the Worker bundle sets it). The
  // global Redis key below can be refreshed by another replica's provisioner; see instance-heartbeat.ts.
  const instanceHeartbeat = createInstanceHeartbeat('provisioner', runtime);
  const beat = () => {
    instanceHeartbeat.beat();
    redis.set(PROVISIONER_HEARTBEAT_KEY, Date.now().toString(), 'EX', 30).then(instanceHeartbeat.markRedisOk, () => {
      // Best-effort — a missed heartbeat just makes the next health check report stale.
    });
  };
  beat();
  runtime.interval(beat, 15_000);

  // Phase B: a release can migrate the database while this (older) provisioner keeps running. Before every cycle the ledger
  // and the provision function are re-assessed (two catalog reads); an incompatible database skips the cycle — nothing is
  // provisioned by this image — and is logged once per change, never once per tick.
  const production = isProductionProcess('provisioner', process.env);
  let lastCompatibilityRefusal: string | null = null;
  const compatibleForThisCycle = async (): Promise<boolean> => {
    const client = await provisioning.acquire();
    try {
      await checkSchemaCompatibility(async (sql, params) => (await client.query(sql, params as unknown[])).rows, {
        process: 'provisioner',
        production,
        expected: gateReport.expectedMigrations ?? [],
        label: 'provisioner process',
      });
      if (lastCompatibilityRefusal !== null) logger.log('workspace provisioning: the database is compatible with this image again; provisioning resumes');
      lastCompatibilityRefusal = null;
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === 'SchemaCompatibilityError') {
        if (error.message !== lastCompatibilityRefusal) logger.error(`workspace provisioning: skipped, ${error.message}`);
        lastCompatibilityRefusal = error.message;
        return false;
      }
      throw error;
    }
  };

  runtime.every({
    name: 'workspace provisioning',
    intervalMs: config.intervalMs,
    statKeys: { lastRunAt: 'lastWorkspaceProvisioningAt', failures: 'workspaceProvisioningFailures' },
    run: async () => {
      if (!(await compatibleForThisCycle())) return false;
      // Phase A: bounded lock wait (default 10 s), abandoned at once when shutdown begins; a busy lock skips this tick.
      const result = await runWorkspaceProvisioningCycle(await provisioning.acquire(), undefined, { shouldAbort: () => runtime.isShuttingDown });
      if (!result.lockAcquired) {
        logger.log('workspace provisioning: skipped — another provisioner held the provisioning lock for the whole bounded wait');
        // Phase A review F6: `false` records the tick as idle (not stamped), so a wedged lock holder elsewhere is not
        // hidden behind a fresh lastWorkspaceProvisioningAt on this replica.
        return false;
      }
      if (result.attempted) logger.log(`workspace provisioning: attempted=${result.attempted} ready=${result.ready} failed=${result.failed}`);
      return true;
    },
  });

  runtime.every({
    name: 'workspace schema drift',
    intervalMs: WORKSPACE_SCHEMA_DRIFT_INTERVAL_MS,
    statKeys: { lastRunAt: 'lastWorkspaceSchemaDriftAt', failures: 'workspaceSchemaDriftFailures' },
    run: async () => {
      // Its own short-lived connection (never the provisioning client, whose BEGIN/COMMIT pairs must not interleave).
      const drift = await runWorkspaceSchemaDriftCycle(driftConfig);
      for (const f of drift.findings) {
        logger.warn(`workspace schema drift: workspace=${f.workspaceId} status=${f.status} module=${f.moduleVersion ?? '?'} ${f.detail}`);
      }
      logger.log(`workspace schema drift: checked=${drift.checked} ok=${drift.ok} notReady=${drift.notReady} findings=${drift.findings.length}`);
    },
  });

  // eslint-disable-next-line no-console
  console.log(
    `[workspace-provisioner] started, HWS_RUNTIME_ENABLED=${config.hwsRuntimeEnabled ?? 'unset'} (provisioning enabled by ${config.enabledBy}; interval ${config.intervalSeconds}s)`,
  );
  releaseEarlyBootSignalGuard();

  const shutdown = async (timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS) => {
    runtime.beginShutdown();
    const { drained, pending } = await runtime.drain(timeoutMs);
    if (!drained) logger.warn(`${pending} cycle(s) still running after ${timeoutMs}ms — closing anyway (the advisory lock releases with the connection)`);
    await provisioning.close();
    await redis.quit();
    // eslint-disable-next-line no-console
    console.log('[workspace-provisioner] shut down cleanly');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

bootstrap().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[workspace-provisioner] fatal error during bootstrap:', error instanceof Error ? error.message : error);
  process.exit(1);
});
