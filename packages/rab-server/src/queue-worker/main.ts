import 'dotenv/config';
import '../instrument';

import Redis from 'ioredis';

import { WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_TTL_SECONDS } from './heartbeat.constants';

const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Deploys as a separate Railway service from the same image (§3). Payslip
 * rendering must never compete with API request handling for CPU.
 *
 * No BullMQ processors are registered yet — those land with the domain
 * modules starting M3 (outbox dispatch, push/email, PDF, auto-close). For
 * now this entrypoint proves the worker process boots and can reach Redis,
 * and writes a periodic heartbeat key so the Admin Panel's Health tab has a
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
  // eslint-disable-next-line no-console
  console.log('rab-server worker ready (no processors registered yet)');

  const beat = () => {
    redis.set(WORKER_HEARTBEAT_KEY, Date.now().toString(), 'EX', WORKER_HEARTBEAT_TTL_SECONDS).catch(() => {
      // Best-effort — a missed heartbeat just makes the next Health tab read report Down/stale, which is correct.
    });
  };
  beat();
  const heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);

  const shutdown = async (signal: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(`Worker received ${signal}, shutting down`);
    clearInterval(heartbeatTimer);
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
