import Redis from 'ioredis';

import { resolveScanPrefix, SCAN_QUEUE_NAMES } from '../core/scheduler/queue-registry';
import { removeCrewflowSchedulers } from '../core/scheduler/scheduler-manager';

/**
 * Operator command — rollback housekeeping after switching WORKER_SCHEDULER from `bullmq` back to `interval` (owner
 * decision D5: explicit, never automatic). Removes ONLY the Crewflow-owned job schedulers (`crewflow:<scan-queue>:*`)
 * from the scan queues under the scan prefix; never touches rab-email / rab-push / rab-shift-statements, foreign
 * schedulers, or any other key. Not required for correctness: without a bullmq-mode consumer each scheduler holds at
 * most one pending job (BullMQ only creates the next job when the current one starts), so leftovers are inert.
 *
 *   REDIS_URL=... NODE_ENV=production [BULLMQ_PREFIX=...] node packages/rab-worker/dist/tools/remove-crewflow-schedulers.js --confirm
 *
 * Refuses without --confirm. Prints scheduler ids only (never the Redis URL).
 */
async function main(): Promise<number> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.error('remove-crewflow-schedulers: REDIS_URL is required');
    return 64;
  }
  const prefix = resolveScanPrefix(process.env.NODE_ENV ?? 'development', process.env.BULLMQ_PREFIX);
  if (!process.argv.includes('--confirm')) {
    console.error(`remove-crewflow-schedulers: refusing without --confirm (would remove crewflow:* schedulers on ${SCAN_QUEUE_NAMES.length} scan queues under prefix ${prefix})`);
    return 64;
  }
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  try {
    const removed = await removeCrewflowSchedulers(redis, prefix, SCAN_QUEUE_NAMES);
    console.log(`remove-crewflow-schedulers: prefix ${prefix}: removed ${removed.length}${removed.length ? `: ${removed.join(', ')}` : ''}`);
    return 0;
  } finally {
    await redis.quit();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`remove-crewflow-schedulers failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exit(1);
  },
);
