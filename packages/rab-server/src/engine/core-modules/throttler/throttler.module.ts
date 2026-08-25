import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { ThrottlerRedisClientModule } from './throttler-redis-client.module';
import { ThrottlerRedisClientProvider } from './throttler-redis-client.provider';

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
 * This is IP-scoped and catches exactly what the existing per-account
 * lockout in `AuthService.login` can't: credential stuffing spread across
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
      inject: [ThrottlerRedisClientProvider],
      useFactory: (redis: ThrottlerRedisClientProvider) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
        storage: new ThrottlerStorageRedisService(redis.client),
        // The integration suite shares one IP (the local supertest client)
        // across many spec files that each call /auth/login, /auth/refresh
        // etc. repeatedly within the same 60s window — none of that is the
        // abuse this guard exists to catch. Deliberately keyed off
        // JEST_WORKER_ID (Jest always and only sets this, unlike NODE_ENV,
        // which this toolchain sets inconsistently across nx/jest/dotenv
        // layering) rather than a plain env flag, so this can never be
        // mistakenly left on outside an actual Jest run even if
        // RAB_DISABLE_RATE_LIMIT ends up set somewhere it shouldn't be.
        // `rate-limiting.integration.spec.ts` is the one file that flips the
        // flag back off, to exercise the real throttle end-to-end.
        skipIf: () => process.env.JEST_WORKER_ID !== undefined && process.env.RAB_DISABLE_RATE_LIMIT !== 'false',
      }),
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class RabThrottlerModule {}
