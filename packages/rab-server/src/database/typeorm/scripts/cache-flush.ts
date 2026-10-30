/**
 * Phase B (P7) `cache:flush`: bumps the generation of every core entity-cache entry (migrate/entity-cache-flush.ts), so
 * nothing cached before a deploy is served after it. Only the allow-listed `entitycache` namespace; sessions, auth context,
 * rate limiters, MFA / step-up state and AI budget or cancel flags are never touched.
 *
 *   NODE_ENV=production REDIS_URL=... node packages/rab-server/dist/database/typeorm/scripts/cache-flush.js [--namespace=entitycache]
 *
 * Also run by deploy-prepare.ts (CREWFLOW_DEPLOY_CACHE_FLUSH=entitycache) after the migrations, while the migration lock is
 * held. Deliberately does NOT import dotenv. Exit 0 = flushed, 1 = refused or failed. Never prints the Redis URL.
 */
import Redis from 'ioredis';

import { assertCacheEnvName, assertFlushableNamespace, flushEntityCache } from './migrate/entity-cache-flush';
import { redactConnectionStrings } from './migrate/locked-migration-runner';

export async function runCacheFlush(namespace: string, env: Record<string, string | undefined> = process.env): Promise<void> {
  assertFlushableNamespace(namespace);
  const envName = assertCacheEnvName(env.NODE_ENV);
  const url = env.REDIS_URL?.trim();
  if (!url) throw new Error('REDIS_URL is required for cache:flush. Refusing.');
  const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 5_000, enableOfflineQueue: false });
  try {
    await redis.connect();
    const result = await flushEntityCache(redis, envName);
    // eslint-disable-next-line no-console
    console.log(
      `[cache-flush] namespace=${namespace} env=${envName}: ${result.bumpedEntities} entity epoch(s) bumped from ${result.scannedKeys} key(s) scanned (${result.ignoredKeys} unrecognised key(s) left alone)`,
    );
  } finally {
    redis.disconnect();
  }
}

if (require.main === module) {
  const arg = process.argv.find((a) => a.startsWith('--namespace='));
  runCacheFlush(arg ? arg.slice('--namespace='.length) : 'entitycache').then(
    () => process.exit(0),
    (error: unknown) => {
      // eslint-disable-next-line no-console
      console.error(`[cache-flush] FAILED: ${redactConnectionStrings(error instanceof Error ? error.message : 'unknown error')}`);
      process.exit(1);
    },
  );
}
