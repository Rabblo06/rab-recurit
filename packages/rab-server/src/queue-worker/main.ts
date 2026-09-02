import 'dotenv/config';
import '../instrument';

import Redis from 'ioredis';
import { DataSource } from 'typeorm';

import { WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_TTL_SECONDS } from './heartbeat.constants';
import { runAccountInviteCleanupCycle } from './jobs/account-invite-cleanup.job';

const HEARTBEAT_INTERVAL_MS = 15_000;
// 15 min — frequent enough that "3rd attempt expired" / "grace period
// passed" become true within a bounded, predictable window rather than
// depending on the next arbitrary restart; infrequent enough that this
// genuinely cross-org job (see the job's own doc comment) isn't a
// meaningful load source. No existing scheduled-job/cron architecture was
// found to reuse in this codebase (`bullmq` is an unused dependency — see
// the job file's own doc comment for why a plain interval was chosen over
// standing up a first-ever BullMQ Queue/Worker pair for this) — this is
// the smallest reliable application-level mechanism available.
const ACCOUNT_INVITE_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Deploys as a separate service from the same image (§3), never merged
 * into the API process — payslip rendering must never compete with API
 * request handling for CPU. Not deployed at all yet (see DEPLOYMENT.md):
 * no free host offers a free always-on worker instance.
 *
 * The account-invite cleanup cycle below is the first real scheduled
 * mechanism this process runs — see `account-invite-cleanup.job.ts`'s own
 * doc comment for what it does and why it connects the way it does. It
 * writes a periodic heartbeat key so the Admin Panel's Health tab has a
 * genuine signal for "Worker" status rather than a hardcoded Operational —
 * there's no HTTP endpoint on this process to ping directly, so a
 * TTL'd heartbeat in the same Redis instance both processes already share
 * is the honest way to answer "is it actually running."
 */
async function bootstrap(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error('REDIS_URL is required — the worker must not start without it');
  }

  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  await redis.ping();

  // A dedicated, entity-less DataSource — every query this job runs is raw
  // SQL (see the job file), so no entity metadata is needed. Connects via
  // DATABASE_URL_UNPOOLED as `rab_owner`, the same cross-org-maintenance
  // convention `BootstrapAdminCommand` already established this session —
  // this job genuinely needs to see every organisation's pending accounts,
  // unlike every request-driven service in this app.
  const cleanupUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!cleanupUrl) {
    throw new Error('DATABASE_URL_UNPOOLED (or DATABASE_URL) is required — the worker must not start without it');
  }
  const cleanupDataSource = new DataSource({ type: 'postgres', url: cleanupUrl, schema: 'core', entities: [], synchronize: false });
  await cleanupDataSource.initialize();

  // eslint-disable-next-line no-console
  console.log('rab-server worker ready');

  const beat = () => {
    redis.set(WORKER_HEARTBEAT_KEY, Date.now().toString(), 'EX', WORKER_HEARTBEAT_TTL_SECONDS).catch(() => {
      // Best-effort — a missed heartbeat just makes the next Health tab read report Down/stale, which is correct.
    });
  };
  beat();
  const heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);

  const runCleanup = () => {
    runAccountInviteCleanupCycle(cleanupDataSource)
      .then((result) => {
        if (result.expired || result.deleted || result.retained) {
          // eslint-disable-next-line no-console
          console.log(`account-invite cleanup: expired=${result.expired} deleted=${result.deleted} retained=${result.retained}`);
        }
      })
      .catch((error) => {
        // Best-effort, resilient to partial failure (per the spec's own
        // requirement) — one failed cycle never crashes the worker; the
        // next scheduled tick just tries again against whatever state is
        // still true then.
        // eslint-disable-next-line no-console
        console.error('account-invite cleanup cycle failed:', error);
      });
  };
  runCleanup();
  const cleanupTimer = setInterval(runCleanup, ACCOUNT_INVITE_CLEANUP_INTERVAL_MS);

  const shutdown = async (signal: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(`Worker received ${signal}, shutting down`);
    clearInterval(heartbeatTimer);
    clearInterval(cleanupTimer);
    await cleanupDataSource.destroy();
    await redis.quit();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Worker failed to start:', error);
  process.exit(1);
});
