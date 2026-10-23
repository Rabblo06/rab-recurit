import { HttpStatus, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';

import { EnvironmentService } from '../../environment/environment.service';
import { ApplicationTarget } from '../application-access';
import { AuthCacheRedisClientProvider } from './auth-cache-redis-client.provider';

/** A first-time provider link (Google/Microsoft) that must be written only when the session is finally issued (audit F10). */
export type PendingProviderLink =
  | { mode: 'link'; provider: 'google' | 'microsoft'; subject: string; verifiedEmail: string }
  | { mode: 'touch'; provider: 'google' | 'microsoft' };

/**
 * Everything needed to finish ONE sign-in after its second factor, captured by `AuthService.completeLogin` AFTER the
 * password/provider identity was proven and every access gate passed. Re-validated (suspension, application access,
 * membership, provider settings) when the session is finally issued. Never contains a password, code or secret in clear.
 */
export interface PendingLogin {
  v: 1;
  requirement: 'verify' | 'enroll';
  userId: string;
  organisationId: string;
  email: string;
  firstName: string;
  status: string;
  mustResetPassword: boolean;
  authProvider: 'password' | 'google' | 'microsoft';
  mobile: boolean;
  /** What the client asked for at sign-in (completeLogin re-derives the real target from roles again). */
  requestedApplicationTarget: ApplicationTarget | null;
  providerLink: PendingProviderLink | null;
  /** `core.user.security_version` when the challenge was issued: any password reset, MFA change or revocation since kills it. */
  securityVersion: number;
  createdAt: number;
}

export type ChallengeAttempt =
  | { ok: true; login: PendingLogin; attempt: number; pendingSecret: string | null }
  | { ok: false; reason: 'unknown' | 'exhausted' };

const TOKEN_PREFIX = 'mfc_';

/**
 * Atomically: count one attempt; destroy the challenge when the count exceeds the maximum. Returns
 *   {-1}                         unknown / expired
 *   {-2}                         exhausted (now deleted)
 *   {attempt, payload, secret}   admitted
 */
const ATTEMPT_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {-1} end
local n = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
if n > tonumber(ARGV[1]) then
  redis.call('DEL', KEYS[1])
  return {-2}
end
local payload = redis.call('HGET', KEYS[1], 'payload')
local secret = redis.call('HGET', KEYS[1], 'pendingSecret')
if not secret then secret = '' end
return {n, payload, secret}
`;

/** Sets the pending enrolment secret only while the challenge still exists (never resurrects a consumed one). */
const SET_SECRET_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('HSET', KEYS[1], 'pendingSecret', ARGV[1])
return 1
`;

/**
 * Wave 4 lane MFA — the pending sign-in between "password/provider proven" and "second factor proven".
 *
 * - Token: 256 random bits (`mfc_…`), returned once in the 409 body; only its SHA-256 is a Redis key, so a Redis dump
 *   holds no usable token. Never in a URL, never logged.
 * - Short-lived (AUTH_MFA_CHALLENGE_TTL_SECONDS, default 5 min) and SINGLE USE: issuing the session deletes it with an
 *   atomic DEL whose result must be 1, so two parallel completions can never both issue a session.
 * - Attempt-bounded: every verification attempt is counted atomically BEFORE the code is checked; after
 *   AUTH_MFA_CHALLENGE_MAX_ATTEMPTS the challenge is destroyed (sign in again). The per-user attempt bucket
 *   (`LoginAttemptLimiterService.admitSecondFactor`) applies on top, across challenges and IPs.
 * - Bound to the pending login: the payload fixes the account, provider and transport (web/mobile); the verify call
 *   must come over the same transport.
 * - Fail closed: Redis unavailable ⇒ 503, never "skip the factor".
 *
 * Redis (not PostgreSQL) on purpose: this is short-lived, high-churn, single-use state with TTL expiry — the same class
 * as the login limiter's buckets — and it needs no migration. A lost Redis only means the user signs in again.
 */
@Injectable()
export class MfaChallengeService {
  private readonly logger = new Logger(MfaChallengeService.name);

  constructor(
    private readonly redis: AuthCacheRedisClientProvider,
    private readonly env: EnvironmentService,
  ) {}

  private key(token: string): string {
    return `crewflow:${this.env.get('NODE_ENV')}:mfa-challenge:${createHash('sha256').update(token).digest('hex')}`;
  }

  private ttlMs(): number {
    return this.env.get('AUTH_MFA_CHALLENGE_TTL_SECONDS') * 1000;
  }

  static isWellFormedToken(token: unknown): token is string {
    return typeof token === 'string' && token.length === TOKEN_PREFIX.length + 43 && token.startsWith(TOKEN_PREFIX) && /^[A-Za-z0-9_-]+$/.test(token.slice(TOKEN_PREFIX.length));
  }

  async create(login: Omit<PendingLogin, 'v' | 'createdAt'>): Promise<{ token: string; expiresAt: Date }> {
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const payload: PendingLogin = { ...login, v: 1, createdAt: Date.now() };
    const ttl = this.ttlMs();
    try {
      const results = await this.redis.client.multi().hset(this.key(token), 'payload', JSON.stringify(payload), 'attempts', '0').pexpire(this.key(token), ttl).exec();
      if (!results || results.some(([error]) => error)) throw new Error('challenge write failed');
    } catch (error) {
      throw this.unavailable(error);
    }
    return { token, expiresAt: new Date(Date.now() + ttl) };
  }

  /** Counts one attempt (before the code is checked) and returns the pending login, or why it is gone. */
  async attempt(token: unknown): Promise<ChallengeAttempt> {
    if (!MfaChallengeService.isWellFormedToken(token)) return { ok: false, reason: 'unknown' };
    let reply: unknown;
    try {
      reply = await this.redis.client.eval(ATTEMPT_SCRIPT, 1, this.key(token), String(this.env.get('AUTH_MFA_CHALLENGE_MAX_ATTEMPTS')));
    } catch (error) {
      throw this.unavailable(error);
    }
    if (!Array.isArray(reply)) throw this.unavailable(new Error('unexpected challenge reply'));
    const first = Number(reply[0]);
    if (first === -1) return { ok: false, reason: 'unknown' };
    if (first === -2) return { ok: false, reason: 'exhausted' };
    let login: PendingLogin;
    try {
      login = JSON.parse(String(reply[1])) as PendingLogin;
    } catch {
      return { ok: false, reason: 'unknown' };
    }
    if (login?.v !== 1) return { ok: false, reason: 'unknown' };
    const secret = typeof reply[2] === 'string' && reply[2] !== '' ? reply[2] : null;
    return { ok: true, login, attempt: first, pendingSecret: secret };
  }

  /** Stores the (already encrypted, base64) enrolment secret on a live `enroll` challenge. */
  async setPendingSecret(token: string, encryptedBase64: string): Promise<boolean> {
    try {
      return Number(await this.redis.client.eval(SET_SECRET_SCRIPT, 1, this.key(token), encryptedBase64)) === 1;
    } catch (error) {
      throw this.unavailable(error);
    }
  }

  /** Single use: true exactly once per challenge (atomic DEL). */
  async consume(token: string): Promise<boolean> {
    try {
      return (await this.redis.client.del(this.key(token))) === 1;
    } catch (error) {
      throw this.unavailable(error);
    }
  }

  /** Best effort (logout of a half-finished sign-in). */
  async discard(token: unknown): Promise<void> {
    if (!MfaChallengeService.isWellFormedToken(token)) return;
    try {
      await this.redis.client.del(this.key(token));
    } catch (error) {
      this.logger.warn(`mfa challenge discard failed: ${(error as Error).message}`);
    }
  }

  private unavailable(error: unknown): ServiceUnavailableException {
    this.logger.warn(`mfa challenge store unavailable (Redis): ${(error as Error)?.message ?? 'unknown'}; refused with 503`);
    return new ServiceUnavailableException({
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'MFA_UNAVAILABLE',
      message: 'This is temporarily unavailable. Try again in a moment.',
      retryAfter: 5,
    });
  }
}
