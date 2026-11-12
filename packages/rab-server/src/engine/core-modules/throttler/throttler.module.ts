import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';

import { EnvironmentService } from '../environment/environment.service';
import { rabThrottlerOptions } from './throttler-options.factory';
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
      // X1.2: the options live in throttler-options.factory.ts so the skip predicate has a behavioural unit test.
      useFactory: rabThrottlerOptions,
    }),
  ],
  // CF-17: explicit Redis-outage policy (credential routes fail closed, ordinary routes stay available).
  providers: [{ provide: APP_GUARD, useClass: RabThrottlerGuard }],
})
export class RabThrottlerModule {}
