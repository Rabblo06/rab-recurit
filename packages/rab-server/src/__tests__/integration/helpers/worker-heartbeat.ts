import { ThrottlerRedisClientProvider } from '../../../engine/core-modules/throttler/throttler-redis-client.provider';
import { WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_TTL_SECONDS } from '../../../engine/worker-shared/heartbeat.constants';

/**
 * Publishes a fresh `rab-worker` heartbeat in Redis so a suite's stack looks like
 * a normal running one (Jest runs no separate worker process). Since the Phase
 * D-Q "always queue" owner decision the heartbeat NO LONGER decides whether a
 * Staff/Manager account invite is queued (`AccountLifecycleService
 * .isEmailDeliveryEnabled()` reads only EMAIL_DELIVERY_ENABLED); suites that
 * still call this keep working unchanged. Fixture only, never a bypass.
 */
export async function simulateWorkerHeartbeat(redis: ThrottlerRedisClientProvider): Promise<void> {
  await redis.client.set(WORKER_HEARTBEAT_KEY, Date.now().toString(), 'EX', Math.max(30, WORKER_HEARTBEAT_TTL_SECONDS));
}
