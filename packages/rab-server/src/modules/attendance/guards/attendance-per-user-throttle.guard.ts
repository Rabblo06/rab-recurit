import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';

import { AuthenticatedRequest } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { isTestRateLimitBypassActive } from '../../../engine/core-modules/throttler/rate-limit-test-bypass';
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
  private readonly logger = new Logger(AttendancePerUserThrottleGuard.name);

  constructor(private readonly redis: ThrottlerRedisClientProvider) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // The same shared predicate as `RabThrottlerModule`'s skip (rate-limit-test-bypass.ts, X1.4): the integration suite
    // exercises the same seeded Staff account well beyond 10 clock actions across one spec file, none of which is the abuse
    // this guard exists to catch. `attendance-abuse-cases.integration.spec.ts` flips `RAB_DISABLE_RATE_LIMIT` to 'false' to
    // exercise this guard for real. Never active in production (and production refuses to boot with the switch present).
    if (isTestRateLimitBypassActive(process.env)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const userId = request.authContext?.userId;
    // No authenticated user yet — JwtAuthGuard (which always runs first,
    // at the controller level) would already have rejected this request;
    // fail open here rather than crash on a null key.
    if (!userId) return true;

    const key = `attendance-clock-throttle:${userId}`;
    let count: number;
    try {
      count = await this.redis.client.incr(key);
      if (count === 1) {
        await this.redis.client.expire(key, WINDOW_SECONDS);
      }
    } catch (error) {
      // CF-17 (owner decision 2026-10-15): clock-in/out is an ordinary authorised route. While the rate-limit store is
      // unavailable a Staff member must still be able to clock in and out (the request is already authenticated against
      // PostgreSQL, and the attendance service enforces its own state machine). Fail open, bounded by the client timeout.
      this.logger.warn(`attendance rate-limit store unavailable (${(error as Error)?.message ?? 'unknown'}); request allowed`);
      return true;
    }
    if (count > LIMIT) {
      throw new ThrottlerException();
    }
    return true;
  }
}
