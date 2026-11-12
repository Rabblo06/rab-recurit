import { HttpException, HttpStatus, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { normalizeEmail } from '@rab/shared';
import { createHash } from 'node:crypto';

import { EnvironmentService } from '../../environment/environment.service';
import { TOKEN_BUCKET_SCRIPT } from '../../rate-limit/token-bucket';
import { AuthCacheRedisClientProvider } from './auth-cache-redis-client.provider';

/**
 * Phase X Part 2, X1.4 (XA-04). Owner decision, matching Twenty (`auth.resolver.ts` emailPasswordResetLink:
 * `password-reset-email:<email>`, 3 tokens per 15 minutes): one token bucket per ADDRESS, whether or not an account
 * exists. Code constants, not env vars, like `ADMIN_MFA_RESET_LIMIT`.
 */
export const PASSWORD_RESET_EMAIL_LIMIT = { capacity: 3, windowMs: 15 * 60 * 1000 } as const;

/** Same retry hint the route throttler and the login limiter send with their fail-closed 503. */
const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/**
 * Forgot-password limit per address (X1.4).
 *
 * BEFORE: `POST /auth/forgot-password` was limited only per client IP (AUTH_THROTTLE, 5/min/IP). Anyone with many IPs
 * could have an unbounded number of reset emails sent to one person's mailbox (mail-bombing, and burning our sending
 * reputation).
 *
 * NOW: `AuthService.doForgotPassword` calls `admit(email)` FIRST, before any account lookup, token, outbox row or audit
 * row. The bucket is the existing atomic Redis token bucket (`rate-limit/token-bucket.ts`, the same script the login,
 * MFA and invitation limits use) on the bounded auth-cache client: capacity 3, refilling continuously over 15 minutes
 * (one token per 5 minutes), keyed only on the lower-cased, trimmed submitted address. A refused request writes nothing
 * (deny-all), so hammering an exhausted address never extends its wait. The per-IP route limit stays as it is.
 *
 * Uniformity (no enumeration): the key, the decision and the 429 body depend only on the submitted string, never on
 * whether an account exists, so a known and an unknown address are refused identically. The response-time floor in
 * `AuthService.forgotPassword` pads the 429 too.
 *
 * Fail closed: a Redis error, timeout or unexpected reply refuses with 503 RATE_LIMIT_UNAVAILABLE, the same code and
 * policy as `RabThrottlerGuard` on `@RateLimitRequired` routes (CF-17) and `LoginAttemptLimiterService`. The guard has
 * already returned 503 when Redis is down; this only meets an error in the narrow race where the guard's own call
 * succeeded. Never "send anyway".
 *
 * Key: `crewflow:{NODE_ENV}:password-reset-email:{sha256(normalised email)}`. The identity is Twenty's
 * `password-reset-email:<email>`; the address is hashed, like every other Crewflow token-bucket key, so no email
 * address appears in Redis.
 *
 * Jest: skipped exactly like `LoginAttemptLimiterService` (JEST_WORKER_ID set AND RAB_DISABLE_RATE_LIMIT !== 'false'),
 * because many suites request resets for the same fixture address. `forgot-password-email-limit.integration.spec.ts`
 * turns the real limiter on.
 */
@Injectable()
export class PasswordResetEmailLimiterService {
  private readonly logger = new Logger(PasswordResetEmailLimiterService.name);

  constructor(
    private readonly redis: AuthCacheRedisClientProvider,
    private readonly env: EnvironmentService,
  ) {}

  /** Debits one reset email for this address. Throws 429 (limit reached) or 503 (limiter unavailable). */
  async admit(email: string): Promise<void> {
    if (this.skipped()) return;
    const key = this.keyFor(email);
    const spec = JSON.stringify([{ capacity: PASSWORD_RESET_EMAIL_LIMIT.capacity, windowMs: PASSWORD_RESET_EMAIL_LIMIT.windowMs, cost: 1 }]);
    let reply: unknown;
    try {
      reply = await this.redis.client.eval(TOKEN_BUCKET_SCRIPT, 1, key, spec);
    } catch (error) {
      throw this.unavailable(error);
    }
    if (!Array.isArray(reply) || reply.length !== 3) throw this.unavailable(new Error('unexpected token-bucket reply'));
    if (Number(reply[0]) === 1) return;
    // One constant body: no retry time (it would differ between two otherwise identical refusals by the clock alone) and
    // nothing that depends on whether an account exists.
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: 'PASSWORD_RESET_RATE_LIMITED',
        message: 'Too many password reset requests for this address. Please wait a few minutes, then try again.',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /** Exposed for tests: the exact Redis key an address uses. */
  keyFor(email: string): string {
    const digest = createHash('sha256').update(normalizeEmail(email)).digest('hex');
    return `crewflow:${this.env.get('NODE_ENV')}:password-reset-email:${digest}`;
  }

  private skipped(): boolean {
    return process.env.JEST_WORKER_ID !== undefined && process.env.RAB_DISABLE_RATE_LIMIT !== 'false';
  }

  private unavailable(error: unknown): ServiceUnavailableException {
    this.logger.warn(`password-reset limiter unavailable (Redis): ${(error as Error)?.message ?? 'unknown error'}; request refused with 503`);
    return new ServiceUnavailableException({
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'RATE_LIMIT_UNAVAILABLE',
      message: 'This is temporarily unavailable. Try again in a moment.',
      retryAfter: UNAVAILABLE_RETRY_AFTER_SECONDS,
    });
  }
}
