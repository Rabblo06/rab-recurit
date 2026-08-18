import 'dotenv/config';
import '../instrument';

import Redis from 'ioredis';

/**
 * Deploys as a separate Railway service from the same image (§3). Payslip
 * rendering must never compete with API request handling for CPU.
 *
 * No BullMQ processors are registered yet — those land with the domain
 * modules starting M3 (outbox dispatch, push/email, PDF, auto-close). For
 * now this entrypoint proves the worker process boots and can reach Redis.
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

  const shutdown = async (signal: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(`Worker received ${signal}, shutting down`);
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
