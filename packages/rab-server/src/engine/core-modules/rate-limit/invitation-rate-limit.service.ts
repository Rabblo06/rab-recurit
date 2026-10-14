import { HttpException, HttpStatus, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'crypto';

import { AuthCacheRedisClientProvider } from '../auth/services/auth-cache-redis-client.provider';
import { EnvironmentService } from '../environment/environment.service';
import { TOKEN_BUCKET_SCRIPT, TokenBucketDecision, TokenBucketSpec } from './token-bucket';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Distributed, atomic rate limits for member invitations — shared by every API instance through the one Redis
 * deployment Crewflow already runs. Deliberately uses `AuthCacheRedisClientProvider`'s client (commandTimeout
 * 150 ms, connectTimeout 500 ms, no offline queue, one retry) and NOT the general throttler/BullMQ client
 * (`maxRetriesPerRequest: null`, which waits indefinitely while Redis is down): an invitation request can
 * never hang on Redis.
 *
 * FAIL CLOSED, EXPLICITLY: any Redis error, timeout or unexpected reply becomes a 503 "temporarily unavailable"
 * (code INVITATION_RATE_LIMIT_UNAVAILABLE) — never "allowed", and never disguised as "too many invitations".
 * Only the operations that SEND email or REDEEM a token consult this service; listing invitations and members
 * never does. PostgreSQL remains the authority for every invitation state change — Redis only meters volume
 * and can never grant, extend or restore anything.
 *
 * Keys: `crewflow:{NODE_ENV}:invite-rate:{scope}:{sha256(identifier)}` — namespaced apart from every other key
 * family, and hashed so no email address (or IP) appears in Redis key names.
 */
@Injectable()
export class InvitationRateLimitService {
  private readonly logger = new Logger(InvitationRateLimitService.name);

  constructor(
    private readonly redis: AuthCacheRedisClientProvider,
    private readonly env: EnvironmentService,
  ) {}

  /** Debits one email-send per recipient plus the actor and organisation buckets, atomically. Throws 429/503. */
  async assertCanSend(params: { actorUserId: string; organisationId: string; recipientEmails: string[] }): Promise<void> {
    const count = params.recipientEmails.length;
    if (count === 0) return;
    const buckets: TokenBucketSpec[] = [
      ...params.recipientEmails.map((email) => ({
        scope: 'recipient',
        identifier: email,
        capacity: this.env.get('MEMBER_INVITE_RATE_RECIPIENT_PER_DAY'),
        windowMs: DAY_MS,
        cost: 1,
      })),
      { scope: 'actor', identifier: params.actorUserId, capacity: this.env.get('MEMBER_INVITE_RATE_ACTOR_PER_HOUR'), windowMs: HOUR_MS, cost: count },
      {
        scope: 'organisation',
        identifier: params.organisationId,
        capacity: this.env.get('MEMBER_INVITE_RATE_ORGANISATION_PER_DAY'),
        windowMs: DAY_MS,
        cost: count,
      },
    ];
    const decision = await this.consume(buckets);
    if (!decision.admitted) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'INVITATION_RATE_LIMITED',
          scope: decision.scope,
          retryAfterSeconds: Math.ceil(decision.retryAfterMs / 1000),
          message:
            decision.scope === 'recipient'
              ? 'Too many invitations have been sent to one of these addresses recently. Please try again later.'
              : 'Too many invitations have been sent recently. Please try again later.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Public look-up / acceptance attempts per client IP. Throws 429/503. */
  async assertCanRedeem(clientIp: string): Promise<void> {
    const decision = await this.consume([
      { scope: 'redeem-ip', identifier: clientIp || 'unknown', capacity: this.env.get('MEMBER_INVITE_RATE_REDEEM_PER_IP_PER_HOUR'), windowMs: HOUR_MS, cost: 1 },
    ]);
    if (!decision.admitted) {
      throw new HttpException(
        { statusCode: HttpStatus.TOO_MANY_REQUESTS, code: 'INVITATION_RATE_LIMITED', retryAfterSeconds: Math.ceil(decision.retryAfterMs / 1000), message: 'Too many attempts. Please try again later.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Exposed for tests: the exact key a bucket uses. */
  keyFor(scope: string, identifier: string): string {
    const digest = createHash('sha256').update(identifier.trim().toLowerCase()).digest('hex');
    return `crewflow:${this.env.get('NODE_ENV')}:invite-rate:${scope}:${digest}`;
  }

  async consume(buckets: TokenBucketSpec[]): Promise<TokenBucketDecision> {
    const keys = buckets.map((b) => this.keyFor(b.scope, b.identifier));
    const specs = JSON.stringify(buckets.map((b) => ({ capacity: b.capacity, windowMs: b.windowMs, cost: b.cost })));
    let reply: unknown;
    try {
      reply = await this.redis.client.eval(TOKEN_BUCKET_SCRIPT, keys.length, ...keys, specs);
    } catch (error) {
      this.logger.warn(`Invitation rate limit unavailable (Redis): ${(error as Error).message}`);
      throw this.unavailable();
    }
    if (!Array.isArray(reply) || reply.length !== 3) {
      this.logger.warn('Invitation rate limit returned an unexpected reply.');
      throw this.unavailable();
    }
    const [admitted, shortIndex, retryAfterMs] = reply.map(Number) as [number, number, number];
    if (admitted === 1) return { admitted: true };
    return { admitted: false, scope: buckets[shortIndex - 1]?.scope ?? 'unknown', retryAfterMs: Math.max(1000, retryAfterMs) };
  }

  private unavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'INVITATION_RATE_LIMIT_UNAVAILABLE',
      message: 'Invitations are temporarily unavailable. Please try again shortly.',
    });
  }
}
