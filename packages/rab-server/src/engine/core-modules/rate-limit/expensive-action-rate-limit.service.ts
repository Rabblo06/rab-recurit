import { HttpException, HttpStatus, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'crypto';

import { AuthCacheRedisClientProvider } from '../auth/services/auth-cache-redis-client.provider';
import { EnvironmentService } from '../environment/environment.service';
import { isRateLimitBypassEnabled } from '../throttler/rate-limit-bypass';
import { TOKEN_BUCKET_SCRIPT } from './token-bucket';

/**
 * The EXPENSIVE request class of rab-workforce-architecture.md §5.5 (reports, search, bulk scheduling): at most
 * 10 calls a minute per user AND 30 a minute per organisation, both buckets debited together in one atomic Redis step
 * (TOKEN_BUCKET_SCRIPT: a call refused by either bucket burns neither). The global route throttler only tracks the
 * client IP, so a per-user and per-organisation limit needs its own buckets.
 *
 * Called from the SERVICE (layer 2), so a job or another service that reaches the expensive action directly is
 * metered too, not only the HTTP route. Keys are namespaced per action and hashed: no id appears in a key name.
 *
 * FAIL CLOSED: a Redis error, timeout or unexpected reply is a 503 (RATE_LIMIT_UNAVAILABLE), never "allowed". Uses the
 * auth cache client (bounded timeouts, no offline queue), so a request can never hang on Redis. Skipped only through
 * the repository's one rate-limit switch (`isRateLimitBypassEnabled`: never in a production runtime).
 */
export const EXPENSIVE_LIMIT = { perUser: 10, perOrganisation: 30, windowMs: 60_000 } as const;

@Injectable()
export class ExpensiveActionRateLimitService {
  private readonly logger = new Logger(ExpensiveActionRateLimitService.name);

  constructor(
    private readonly redis: AuthCacheRedisClientProvider,
    private readonly env: EnvironmentService,
  ) {}

  /** Debits one call of `action` for the user and the organisation. Throws 429 (limit reached) or 503 (limiter down). */
  async admit(action: string, actor: { userId: string; organisationId: string }): Promise<void> {
    if (isRateLimitBypassEnabled(process.env)) return;
    const keys = [this.keyFor(action, 'user', actor.userId), this.keyFor(action, 'organisation', actor.organisationId)];
    const specs = JSON.stringify([
      { capacity: EXPENSIVE_LIMIT.perUser, windowMs: EXPENSIVE_LIMIT.windowMs, cost: 1 },
      { capacity: EXPENSIVE_LIMIT.perOrganisation, windowMs: EXPENSIVE_LIMIT.windowMs, cost: 1 },
    ]);
    let reply: unknown;
    try {
      reply = await this.redis.client.eval(TOKEN_BUCKET_SCRIPT, keys.length, ...keys, specs);
    } catch (error) {
      this.logger.warn(`expensive-action limiter unavailable (Redis): ${(error as Error)?.message ?? 'unknown error'}; refused with 503`);
      throw this.unavailable();
    }
    if (!Array.isArray(reply) || reply.length !== 3) {
      this.logger.warn('expensive-action limiter returned an unexpected reply; refused with 503');
      throw this.unavailable();
    }
    const [admitted, , retryAfterMs] = reply.map(Number) as [number, number, number];
    if (admitted === 1) return;
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: 'RATE_LIMITED',
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
        message: 'Too many of these requests in the last minute. Please wait a moment, then try again.',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /** Exposed for tests: the exact key a bucket uses. */
  keyFor(action: string, scope: 'user' | 'organisation', identifier: string): string {
    const digest = createHash('sha256').update(identifier).digest('hex');
    return `crewflow:${this.env.get('NODE_ENV')}:expensive-rate:${action}:${scope}:${digest}`;
  }

  private unavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'RATE_LIMIT_UNAVAILABLE',
      message: 'This is temporarily unavailable. Try again in a moment.',
    });
  }
}
