import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';

import type { EnvironmentService } from '../environment/environment.service';
import { resolveClientIp } from '../../utils/client-ip.util';
import { isRateLimitBypassEnabled } from './rate-limit-bypass';
import type { ThrottlerRedisClientProvider } from './throttler-redis-client.provider';

/**
 * RabThrottlerModule's options (the `ThrottlerModule.forRootAsync` factory). Kept out of the module file so the skip predicate
 * can be unit-tested without booting ConfigModule (X1.2, rate-limit-bypass.throttler.spec.ts).
 */
export function rabThrottlerOptions(redis: ThrottlerRedisClientProvider, environmentService: EnvironmentService): ThrottlerModuleOptions {
  return {
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
    // The ONE rate-limit switch (rate-limit-bypass.ts, X1.2): on only when explicitly set, never in a production
    // runtime, and production refuses to boot with it set. The Jest setup sets it because the integration suite shares one
    // IP (the local supertest client) across many spec files that each call /auth/login, /auth/refresh etc. repeatedly
    // within the same 60s window; `rate-limiting.integration.spec.ts` sets it to 'false' to exercise the real throttle.
    skipIf: () => isRateLimitBypassEnabled(process.env),
  };
}
