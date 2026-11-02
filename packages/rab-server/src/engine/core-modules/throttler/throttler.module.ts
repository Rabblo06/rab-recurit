import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';

import { EnvironmentService } from '../environment/environment.service';
import { resolveClientIp } from '../../utils/client-ip.util';
import { isTestRateLimitBypassActive } from './rate-limit-test-bypass';
import { ThrottlerRedisClientModule } from './throttler-redis-client.module';
import { ThrottlerRedisClientProvider } from './throttler-redis-client.provider';
import { RabThrottlerGuard } from './rab-throttler.guard';

/**
 * One named tier (`default`, 120 req/min/IP — generous enough that a busy
 * office behind one NAT IP never notices it in normal use), applied globally
 * via the `APP_GUARD` below. Sensitive routes (login/refresh/forgot-password/
 * reset-password/set-password, see `AuthController`) override it per-route
 * with a much tighter `@Throttle({ default: { limit: 5, ttl: 60_000 } })` —
 * same named key, tighter values for that handler only, not a second
 * simultaneously-enforced tier (nest/throttler: multiple *distinct* named
 * throttlers in the `throttlers` array are ALL checked on every route unless
 * explicitly skipped, so a real second tier would mean every route silently
 * had to satisfy both limits at once — a per-route override of the same
 * name is the correct tool here, not two tiers).
 *
 * This is IP-scoped and catches exactly what the per-(email, IP)/account
 * limiter in `AuthService.login` (LoginAttemptLimiterService) can't: credential stuffing spread across
 * many different accounts, and forgot-password/reset-password abuse
 * (neither of those has any other throttling today).
 *
 * Backed by the same Redis instance already required to boot this app
 * (`REDIS_URL`, also used by the BullMQ worker) — not a new piece of
 * infrastructure, so counts survive a restart and are shared correctly
 * across however many API instances run in production.
 */
@Module({
  imports: [
    ThrottlerRedisClientModule,
    ThrottlerModule.forRootAsync({
      imports: [ThrottlerRedisClientModule],
      inject: [ThrottlerRedisClientProvider, EnvironmentService],
      useFactory: (redis: ThrottlerRedisClientProvider, environmentService: EnvironmentService) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
        storage: new ThrottlerStorageRedisService(redis.client),
        // SEC-03 / PHASE 11 EDGE-01: the tracker's identity is only as
        // trustworthy as `resolveClientIp`'s own trusted-proxy check — see
        // that function's doc comment. Typed `Record<string, any>` to match
        // Nest's own (transport-agnostic) `ThrottlerGetTrackerFunction`
        // signature — an actual Express request is what's passed at
        // runtime; `resolveClientIp` only reads the fields it declares.
        getTracker: (req: Record<string, any>) =>
          resolveClientIp(req as { headers: Record<string, any>; ip?: string; socket?: { remoteAddress?: string } }, environmentService.trustedProxyCidrs),
        // The integration suite shares one IP (the local supertest client) across many spec files that each call
        // /auth/login, /auth/refresh etc. repeatedly within the same 60s window: none of that is the abuse this guard exists
        // to catch. The skip is the ONE shared predicate (rate-limit-test-bypass.ts, X1.4): RAB_DISABLE_RATE_LIMIT exactly
        // 'true' AND JEST_WORKER_ID set, never in a production runtime. Both are ordinary environment variables, not proof
        // of a Jest run, which is why production also refuses to boot while either is present (env.validation.ts).
        // `rate-limiting.integration.spec.ts` flips the flag to 'false' to exercise the real throttle end-to-end.
        skipIf: () => isTestRateLimitBypassActive(process.env),
      }),
    }),
  ],
  // CF-17: explicit Redis-outage policy (credential routes fail closed, ordinary routes stay available).
  providers: [{ provide: APP_GUARD, useClass: RabThrottlerGuard }],
})
export class RabThrottlerModule {}
