import { ExecutionContext, Injectable, Logger, ServiceUnavailableException, SetMetadata } from '@nestjs/common';
import { ThrottlerException, ThrottlerGuard } from '@nestjs/throttler';
import { Response } from 'express';

export const RATE_LIMIT_REQUIRED = 'rateLimitRequired';

/**
 * CF-17 (owner decision 2026-10-15): routes that ISSUE or RECOVER a credential (sign-in, refresh, password
 * forgot/reset/activate/set, OAuth start/callback/handoff, invitation redemption) and abuse-sensitive probes must never
 * run without their rate limit. If the throttler's Redis storage is unavailable they fail closed with 503.
 */
export const RateLimitRequired = () => SetMetadata(RATE_LIMIT_REQUIRED, true);

const OUTAGE_LOG_INTERVAL_MS = 10_000;

/**
 * The global throttler with an explicit Redis-outage policy (CF-17; §5.8 trade-off recorded in THREAT-MODEL.md):
 *   - a real limit hit is unchanged: 429 (ThrottlerException);
 *   - storage unavailable on a @RateLimitRequired route: 503 RATE_LIMIT_UNAVAILABLE, within the client's bounded timeouts
 *     (never an unbounded wait, never unlimited credential attempts);
 *   - storage unavailable on any other route: allowed. Ordinary requests are authenticated against PostgreSQL on every
 *     call, so availability is kept without weakening authentication. Logged (rate-limited) so the outage is monitored.
 * Session state is never touched here: a 503 never clears a browser or Flutter session.
 */
@Injectable()
export class RabThrottlerGuard extends ThrottlerGuard {
  private readonly outageLogger = new Logger('RateLimitStorage');
  private lastOutageLog = 0;
  private suppressed = 0;

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      return await super.canActivate(context);
    } catch (error) {
      if (error instanceof ThrottlerException) throw error;
      const required = this.reflector.getAllAndOverride<boolean>(RATE_LIMIT_REQUIRED, [context.getHandler(), context.getClass()]) === true;
      this.logOutage(error, required);
      if (required) {
        context.switchToHttp().getResponse<Response>().setHeader('Retry-After', '5');
        throw new ServiceUnavailableException({ code: 'RATE_LIMIT_UNAVAILABLE', message: 'This is temporarily unavailable. Try again in a moment.' });
      }
      return true;
    }
  }

  private logOutage(error: unknown, required: boolean): void {
    const now = Date.now();
    if (now - this.lastOutageLog < OUTAGE_LOG_INTERVAL_MS) {
      this.suppressed++;
      return;
    }
    this.outageLogger.warn(
      `rate-limit storage unavailable (${(error as Error)?.message ?? 'unknown error'}); ${required ? 'credential route refused with 503' : 'ordinary route allowed'}` +
        (this.suppressed ? `; ${this.suppressed} similar event(s) suppressed` : ''),
    );
    this.lastOutageLog = now;
    this.suppressed = 0;
  }
}
