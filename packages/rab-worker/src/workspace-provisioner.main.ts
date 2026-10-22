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
import { Client } from 'pg';

import { assertRuntimeDatabaseIdentity } from '@rab/server/database/typeorm/core/runtime-database-guard';
import { runWorkspaceProvisioningCycle } from './queues/rab-maintenance/workspace-provisioning.job';
import { createInstanceHeartbeat } from './core/runtime/instance-heartbeat';
import { WorkerRuntime } from './core/runtime/worker-runtime';

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
 * exactly one thing on a fixed interval, gated by `HWS_RUNTIME_ENABLED` same as before, and nothing
 * else. It cannot be asked to run arbitrary SQL: its only exposed surface is this one scheduled
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
const WORKSPACE_PROVISIONING_INTERVAL_MS = 5_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

function refuseStartup(error: unknown): never {
  const message = error instanceof Error ? error.message : 'unknown error';
  const prefix = error instanceof Error && error.name === 'RuntimeDbError' ? '[runtime-db-guard] refused: ' : '';
  // eslint-disable-next-line no-console
  console.error(`${prefix}${message}`);
  process.exit(1);
}

async function bootstrap(): Promise<void> {
  await assertRuntimeDatabaseIdentity('provisioner').catch(refuseStartup);
  const logger = new NestLogger('WorkspaceProvisioner');

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error('REDIS_URL is required — the provisioner must not start without it (used only for its own stats/heartbeat, never a privileged operation)');
  }
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  await redis.ping();

  const hwsEnabled = process.env.HWS_RUNTIME_ENABLED === 'true';
  if (!hwsEnabled) {
    // eslint-disable-next-line no-console
    console.log('[workspace-provisioner] HWS_RUNTIME_ENABLED is not true — nothing to do. Exiting cleanly rather than idling forever.');
    await redis.quit();
    process.exit(0);
  }

  // Deliberately `DATABASE_URL_UNPOOLED`, never `DATABASE_URL` — see this file's own top doc
  // comment. `provisionWorkspaceSchema` manages its own BEGIN/COMMIT/ROLLBACK pairs directly on
  // this client, so it must be a direct (unpooled) connection, exactly as it was inside the
  // ordinary Worker before this split.
  const privilegedUrl = process.env.DATABASE_URL_UNPOOLED;
  if (!privilegedUrl) {
    throw new Error('DATABASE_URL_UNPOOLED is required — this process has no other purpose.');
  }
  const provisioningClient = new Client({ connectionString: privilegedUrl });
  await provisioningClient.connect();

  const runtime = new WorkerRuntime(redis);
  // Per-instance heartbeat file — a no-op unless CREWFLOW_INSTANCE_HEALTH_FILE is set (the Worker bundle sets it). The
  // global Redis key below can be refreshed by another replica's provisioner; see instance-heartbeat.ts.
  const instanceHeartbeat = createInstanceHeartbeat('provisioner', runtime);
  const beat = () => {
    instanceHeartbeat.beat();
    redis.set('rab:workspace-provisioner:heartbeat', Date.now().toString(), 'EX', 30).then(instanceHeartbeat.markRedisOk, () => {
      // Best-effort — a missed heartbeat just makes the next health check report stale.
    });
  };
  beat();
  runtime.interval(beat, 15_000);

  runtime.every({
    name: 'workspace provisioning',
    intervalMs: WORKSPACE_PROVISIONING_INTERVAL_MS,
    statKeys: { lastRunAt: 'lastWorkspaceProvisioningAt', failures: 'workspaceProvisioningFailures' },
    run: async () => {
      const result = await runWorkspaceProvisioningCycle(provisioningClient);
      if (result.attempted) logger.log(`workspace provisioning: attempted=${result.attempted} ready=${result.ready} failed=${result.failed}`);
    },
  });

  // eslint-disable-next-line no-console
  console.log('[workspace-provisioner] started, HWS_RUNTIME_ENABLED=true');
  releaseEarlyBootSignalGuard();

  const shutdown = async (timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS) => {
    runtime.beginShutdown();
    const { drained, pending } = await runtime.drain(timeoutMs);
    if (!drained) logger.warn(`${pending} cycle(s) still running after ${timeoutMs}ms — closing anyway (the advisory lock releases with the connection)`);
    await provisioningClient.end();
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
