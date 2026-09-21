import { ThrottlerRedisClientProvider } from '../../../engine/core-modules/throttler/throttler-redis-client.provider';
import { WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_TTL_SECONDS } from '../../../queue-worker/heartbeat.constants';

/**
 * The API decides whether an account invite can be emailed by checking a live
 * `rab-worker` heartbeat in Redis (`AccountLifecycleService.isEmailDeliveryAvailable`).
 * Jest runs no separate worker process, so any suite that creates Staff/Manager
 * accounts through the real API must publish that heartbeat first — otherwise
 * `POST /staff` / `POST /managers` legitimately return `invite: null` and the
 * suite fails on an unrelated fixture gap. This is the fixture, not a bypass:
 * the production check itself is untouched.
 */
export async function simulateWorkerHeartbeat(redis: ThrottlerRedisClientProvider): Promise<void> {
  await redis.client.set(WORKER_HEARTBEAT_KEY, Date.now().toString(), 'EX', Math.max(30, WORKER_HEARTBEAT_TTL_SECONDS));
}
