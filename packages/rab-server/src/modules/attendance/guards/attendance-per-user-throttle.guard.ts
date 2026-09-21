import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';

import { AuthenticatedRequest } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { ThrottlerRedisClientProvider } from '../../../engine/core-modules/throttler/throttler-redis-client.provider';

const LIMIT = 10;
const WINDOW_SECONDS = 60;

/**
 * Per-USER (not per-IP) limit on Clock In / Clock Out / geofence-exit —
 * deliberately separate from `RabThrottlerModule`'s global 120/min/IP guard,
 * which already runs on every route via `APP_GUARD` and is left completely
 * untouched here (this guard is additive, applied only via `@UseGuards` on
 * these three handlers, keyed on a different Redis key space so it can never
 * collide with or narrow the global tier).
 *
 * Per-IP alone would risk throttling a legitimate 500-person venue-Wi-Fi
 * clock-in burst (many real staff sharing one NAT IP); per-user does not,
 * since each person has their own budget — 10/min is far more than any real
 * shift ever needs (a handful of clock-in/out taps), while still blunting a
 * scripted single-account QR-guessing/retry loop. Defense-in-depth only —
 * the QR signature + geofence + assignment checks are the real controls.
 *
 * Reuses the SAME Redis instance `RabThrottlerModule` already requires
 * (`ThrottlerRedisClientProvider`) rather than a second rate-limiting
 * system, via a plain fixed-window INCR/EXPIRE (not `nestjs/throttler`'s own
 * tiered `ThrottlerGuard`, whose named-tier metadata is shared with the
 * global guard — reusing it here would risk silently narrowing or widening
 * the global per-IP tier for these routes instead of adding an independent
 * dimension).
 */
@Injectable()
export class AttendancePerUserThrottleGuard implements CanActivate {
  constructor(private readonly redis: ThrottlerRedisClientProvider) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Same convention as `RabThrottlerModule`'s own skip — the integration
    // suite exercises the same seeded Staff account well beyond 10 clock
    // actions across one spec file; none of that is the abuse this guard
    // exists to catch. `rate-limiting.integration.spec.ts` is the one file
    // that already flips `RAB_DISABLE_RATE_LIMIT` back to 'false' to
    // exercise real throttling end-to-end, so this guard is bound by the
    // same flag rather than an independent one.
    if (process.env.JEST_WORKER_ID !== undefined && process.env.RAB_DISABLE_RATE_LIMIT !== 'false') {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const userId = request.authContext?.userId;
    // No authenticated user yet — JwtAuthGuard (which always runs first,
    // at the controller level) would already have rejected this request;
    // fail open here rather than crash on a null key.
    if (!userId) return true;

    const key = `attendance-clock-throttle:${userId}`;
    const count = await this.redis.client.incr(key);
    if (count === 1) {
      await this.redis.client.expire(key, WINDOW_SECONDS);
    }
    if (count > LIMIT) {
      throw new ThrottlerException();
    }
    return true;
  }
}
