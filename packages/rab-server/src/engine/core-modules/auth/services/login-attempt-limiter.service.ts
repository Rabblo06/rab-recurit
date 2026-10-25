import { HttpException, HttpStatus, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { EnvironmentService } from '../../environment/environment.service';
import { TOKEN_BUCKET_SCRIPT, TokenBucketDecision, TokenBucketSpec } from '../../rate-limit/token-bucket';
import { AuthCacheRedisClientProvider } from './auth-cache-redis-client.provider';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Retry hint for a 503 (Redis unavailable) — the same value `RabThrottlerGuard` sends for its own fail-closed 503. */
const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/**
 * Account security step 1 (P4): per platform ADMINISTRATOR, how many second-factor resets of other accounts may be
 * attempted. Conservative on purpose (a code constant, no env var): 5 per rolling hour, continuously refilling. A real
 * support desk resets a handful of factors a day; a phished admin session that tries to strip factors in bulk is slowed
 * to one every 12 minutes after the first five, while each reset still emails its target and is audited in both orgs.
 * The route also keeps its per-IP @Throttle (10/min).
 */
export const ADMIN_MFA_RESET_LIMIT = { capacity: 5, windowMs: 60 * 60 * 1000 } as const;

/**
 * Wave 1 lane A — finding D-A1 (targeted login lockout). Owner decision: "per email + IP, slowing down".
 *
 * BEFORE: `AuthService.login` counted failures per EMAIL (`core.auth_count_recent_login_failures`) and refused every
 * attempt — from anyone, anywhere — for 15 minutes once 10 had failed. Anyone who knew an address could keep its owner
 * locked out indefinitely.
 *
 * NOW: password sign-in attempts are metered by the existing atomic Redis token bucket (`rate-limit/token-bucket.ts`,
 * the same script the invitation limits use — not a second limiter) on the bounded auth-cache client:
 *
 *  1. (normalised email, client IP), burst tier — AUTH_LOGIN_EMAIL_IP_BURST attempts, then one more per
 *     (AUTH_LOGIN_EMAIL_IP_WINDOW_SECONDS / burst). An attacker only slows down THEIR OWN address.
 *  2. (normalised email, client IP), daily tier — AUTH_LOGIN_EMAIL_IP_DAILY_LIMIT per 24 h: the progressive second step
 *     for a persistent single-address guesser.
 *  3. normalised email, ACCOUNT-WIDE across all IPs — AUTH_LOGIN_ACCOUNT_BURST, refilling over
 *     AUTH_LOGIN_ACCOUNT_WINDOW_SECONDS: distributed guessing (many IPs, one account) slows down. It is applied only to
 *     an address that has NOT signed in to this account successfully in the last AUTH_LOGIN_KNOWN_IP_TTL_DAYS, so a
 *     distributed attack cannot keep the owner out of the device/network they already use.
 *
 * Every bucket refills continuously, so nothing is ever an indefinite hard lock. All buckets are checked and debited in
 * ONE atomic EVAL (deny-all: a refused attempt writes nothing, so hammering a throttled address never extends its wait).
 * Each attempt costs one token whether or not the password turns out to be right; a FULLY successful sign-in (session
 * issued) then clears that (email, IP)'s own buckets and marks the address as known. Refusals after a correct password
 * (password sign-in disabled, second factor required, application denied) deliberately clear nothing — clearing there
 * would let an attacker learn that a guessed password was correct from the next attempt's 429 behaviour.
 *
 * Uniformity: `admit()` runs for every attempt BEFORE any account lookup, keyed only on the submitted address, so an
 * unknown email and a real one are throttled identically (no enumeration through 429 timing or count).
 *
 * Fail closed: any Redis error/timeout/unexpected reply refuses the attempt with 503 RATE_LIMIT_UNAVAILABLE — the same
 * code and policy as `RabThrottlerGuard` on `@RateLimitRequired` routes (CF-17). Never "allow unlimited".
 *
 * Keys: `crewflow:{NODE_ENV}:login-rate:{scope}:{sha256(identifier)}` — no email address or IP appears in Redis.
 *
 * Jest: skipped exactly like `RabThrottlerModule` (JEST_WORKER_ID set AND RAB_DISABLE_RATE_LIMIT !== 'false'), because the
 * integration suite shares one client IP across hundreds of logins. `login-attempt-limiter.integration.spec.ts` turns the
 * real limiter on.
 */
@Injectable()
export class LoginAttemptLimiterService {
  private readonly logger = new Logger(LoginAttemptLimiterService.name);

  constructor(
    private readonly redis: AuthCacheRedisClientProvider,
    private readonly env: EnvironmentService,
  ) {}

  /** Throws 429 (slowed down) or 503 (limiter unavailable). Call BEFORE any account lookup or password verification. */
  async admit(email: string, clientIp: string | undefined): Promise<void> {
    if (this.skipped()) return;
    const pair = this.pairIdentifier(email, clientIp);
    let known: boolean;
    try {
      known = (await this.redis.client.exists(this.keyFor('known-ip', pair))) === 1;
    } catch (error) {
      throw this.unavailable(error);
    }
    const buckets: TokenBucketSpec[] = [
      {
        scope: 'email-ip',
        identifier: pair,
        capacity: this.env.get('AUTH_LOGIN_EMAIL_IP_BURST'),
        windowMs: this.env.get('AUTH_LOGIN_EMAIL_IP_WINDOW_SECONDS') * 1000,
        cost: 1,
      },
      { scope: 'email-ip-daily', identifier: pair, capacity: this.env.get('AUTH_LOGIN_EMAIL_IP_DAILY_LIMIT'), windowMs: DAY_MS, cost: 1 },
    ];
    if (!known) {
      buckets.push({
        scope: 'account',
        identifier: email,
        capacity: this.env.get('AUTH_LOGIN_ACCOUNT_BURST'),
        windowMs: this.env.get('AUTH_LOGIN_ACCOUNT_WINDOW_SECONDS') * 1000,
        cost: 1,
      });
    }
    const decision = await this.consume(buckets);
    if (!decision.admitted) {
      const retryAfter = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
      const minutes = Math.max(1, Math.ceil(retryAfter / 60));
      // Same wording whichever bucket was short: the client only needs to know when to retry.
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'LOGIN_RATE_LIMITED',
          message: `Too many sign-in attempts. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
          retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Wave 4 lane MFA: one second-factor code attempt (sign-in challenge, enrolment confirmation, step-up, disable,
   * regenerate). Per USER across every IP and challenge — AUTH_MFA_USER_ATTEMPTS_BURST, refilling over
   * AUTH_MFA_USER_ATTEMPTS_WINDOW_SECONDS — so an attacker who already holds the password cannot spread six-digit
   * guesses over many challenges or addresses. Same atomic token bucket and fail-closed 503 as `admit()`; a refused
   * attempt writes nothing. Never cleared by a success (a correct code is not evidence the guesser went away).
   */
  async admitSecondFactor(userId: string): Promise<void> {
    if (this.skipped()) return;
    const decision = await this.consume([
      {
        scope: 'mfa-user',
        identifier: userId,
        capacity: this.env.get('AUTH_MFA_USER_ATTEMPTS_BURST'),
        windowMs: this.env.get('AUTH_MFA_USER_ATTEMPTS_WINDOW_SECONDS') * 1000,
        cost: 1,
      },
    ]);
    if (!decision.admitted) {
      const retryAfter = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
      const minutes = Math.max(1, Math.ceil(retryAfter / 60));
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'MFA_RATE_LIMITED',
          // Account security step 1: the sign-in screens map this to their "locked / start again" state.
          state: 'locked',
          message: `Too many verification attempts. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
          retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Account security step 1 (P4): one admin reset attempt by `actorUserId` (ADMIN_MFA_RESET_LIMIT). Debited BEFORE the
   * proof is checked, so a bad password or code still costs the attempt. 429 MFA_RESET_RATE_LIMITED (Retry-After) or the
   * shared fail-closed 503. Skipped under Jest exactly like every other bucket here.
   */
  async admitAdminMfaReset(actorUserId: string): Promise<void> {
    if (this.skipped()) return;
    const decision = await this.consume([{ scope: 'admin-mfa-reset', identifier: actorUserId, capacity: ADMIN_MFA_RESET_LIMIT.capacity, windowMs: ADMIN_MFA_RESET_LIMIT.windowMs, cost: 1 }]);
    if (!decision.admitted) {
      const retryAfter = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'MFA_RESET_RATE_LIMITED',
          message: 'You have reset several accounts’ two-factor authentication recently. Try again later.',
          retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * After a session has actually been issued: clear this (email, IP)'s own buckets and remember the address as one that
   * has signed in successfully (exempt from the account-wide ceiling). Best effort — the sign-in has already succeeded;
   * a Redis failure here only means the address keeps its current counters.
   */
  async recordSuccess(email: string, clientIp: string | undefined): Promise<void> {
    if (this.skipped()) return;
    const pair = this.pairIdentifier(email, clientIp);
    try {
      await this.redis.client
        .multi()
        .del(this.keyFor('email-ip', pair), this.keyFor('email-ip-daily', pair))
        .set(this.keyFor('known-ip', pair), '1', 'PX', this.env.get('AUTH_LOGIN_KNOWN_IP_TTL_DAYS') * DAY_MS)
        .exec();
    } catch (error) {
      this.logger.warn(`login limiter: could not record a successful sign-in (${(error as Error).message})`);
    }
  }

  /** Exposed for tests: the exact Redis key a scope/identifier uses. */
  keyFor(scope: string, identifier: string): string {
    const digest = createHash('sha256').update(identifier).digest('hex');
    return `crewflow:${this.env.get('NODE_ENV')}:login-rate:${scope}:${digest}`;
  }

  private pairIdentifier(email: string, clientIp: string | undefined): string {
    // `email` is already normalised by the caller; the IP comes from `resolveClientIp` (TRUSTED_PROXY_CIDRS-aware).
    return `${email}\n${clientIp || 'unknown'}`;
  }

  private skipped(): boolean {
    return process.env.JEST_WORKER_ID !== undefined && process.env.RAB_DISABLE_RATE_LIMIT !== 'false';
  }

  private async consume(buckets: TokenBucketSpec[]): Promise<TokenBucketDecision> {
    const keys = buckets.map((b) => this.keyFor(b.scope, b.identifier));
    const specs = JSON.stringify(buckets.map((b) => ({ capacity: b.capacity, windowMs: b.windowMs, cost: b.cost })));
    let reply: unknown;
    try {
      reply = await this.redis.client.eval(TOKEN_BUCKET_SCRIPT, keys.length, ...keys, specs);
    } catch (error) {
      throw this.unavailable(error);
    }
    if (!Array.isArray(reply) || reply.length !== 3) throw this.unavailable(new Error('unexpected token-bucket reply'));
    const [admitted, shortIndex, retryAfterMs] = reply.map(Number) as [number, number, number];
    if (admitted === 1) return { admitted: true };
    return { admitted: false, scope: buckets[shortIndex - 1]?.scope ?? 'unknown', retryAfterMs: Math.max(1000, retryAfterMs) };
  }

  private unavailable(error: unknown): ServiceUnavailableException {
    this.logger.warn(`login limiter unavailable (Redis): ${(error as Error)?.message ?? 'unknown error'}; sign-in refused with 503`);
    return new ServiceUnavailableException({
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'RATE_LIMIT_UNAVAILABLE',
      message: 'This is temporarily unavailable. Try again in a moment.',
      retryAfter: UNAVAILABLE_RETRY_AFTER_SECONDS,
    });
  }
}
