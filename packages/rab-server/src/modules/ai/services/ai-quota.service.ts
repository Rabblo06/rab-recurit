import { createHash } from 'node:crypto';

import { AiErrorCode } from '@rab/shared';
import { Injectable } from '@nestjs/common';

import { TOKEN_BUCKET_SCRIPT } from '../../../engine/core-modules/rate-limit/token-bucket';
import { AiQuotaUnavailableError, AiTooManyRequestsException } from '../exceptions/ai.exceptions';
import { AiConfigService } from './ai-config.service';
import { AiRedisClientProvider } from './ai-redis-client.provider';

/**
 * Per-organisation daily token budget: an atomic RESERVATION. KEYS[1] = the org/day counter (tokens used + reserved).
 * ARGV: amount, ceiling, ttlSeconds, seed ('' = do not seed). A missing key is first seeded from the database's
 * persisted usage for the day (so a Redis restart cannot hand a tenant a fresh budget), then the reservation is admitted
 * only if used + amount <= ceiling. Returns {admitted 1|0, current}.
 */
export const AI_BUDGET_RESERVE_SCRIPT = `
local amount = tonumber(ARGV[1])
local ceiling = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
if redis.call('EXISTS', KEYS[1]) == 0 and ARGV[4] ~= '' then
  redis.call('SET', KEYS[1], ARGV[4], 'EX', ttl)
end
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current + amount > ceiling then
  return {0, current}
end
local after = redis.call('INCRBY', KEYS[1], amount)
redis.call('EXPIRE', KEYS[1], ttl)
return {1, after}
`;

/** Reconciliation: add (actual − reserved), never below zero, only while the day's key exists. Returns the new value or -1. */
export const AI_BUDGET_ADJUST_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
local after = redis.call('INCRBY', KEYS[1], tonumber(ARGV[1]))
if after < 0 then redis.call('SET', KEYS[1], '0', 'KEEPTTL'); after = 0 end
return after
`;

/**
 * Per-organisation active-CONVERSATION semaphore (Phase 2, P2-D10). KEYS[1] = ZSET (member = conversation id, score =
 * expiry ms on the Redis clock). ARGV: member, ttlMs, limit. Expired members are dropped first (a crashed turn frees its
 * slot by itself); an existing member is refreshed (idempotent re-acquire: a queued successor inherits its running
 * predecessor's slot). Returns 1 newly admitted / 2 already held (refreshed) / 0 full.
 */
export const AI_SLOT_ACQUIRE_SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local ttl = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  redis.call('ZADD', KEYS[1], 'XX', now + ttl, ARGV[1])
  redis.call('PEXPIRE', KEYS[1], ttl)
  return 2
end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], now + ttl, ARGV[1])
redis.call('PEXPIRE', KEYS[1], ttl)
return 1
`;

/** Keep a held slot alive (Worker, while the turn runs). Returns 1 if it was held, 0 if it had already expired. */
export const AI_SLOT_REFRESH_SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local ttl = tonumber(ARGV[2])
local updated = redis.call('ZADD', KEYS[1], 'XX', 'CH', now + ttl, ARGV[1])
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  redis.call('PEXPIRE', KEYS[1], ttl)
  return 1
end
return 0
`;

export interface AiBudgetReservation {
  key: string;
  amount: number;
}

/** UTC day of a timestamp, `YYYY-MM-DD` (the budget and `ai_usage_daily` day). */
export function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Redis-backed AI limits (docs/ai/PHASE1_PLAN.md §4.3–4.4). Every operation is ONE atomic script, so concurrent requests
 * on any number of API instances can never jointly pass a limit. Any Redis failure surfaces as AiQuotaUnavailableError —
 * the caller refuses the AI work (503), never runs it unlimited.
 */
@Injectable()
export class AiQuotaService {
  constructor(
    private readonly config: AiConfigService,
    private readonly redis: AiRedisClientProvider,
  ) {}

  budgetKey(organisationId: string, day: string): string {
    return this.config.redisKey('budget', organisationId, day);
  }

  slotKey(organisationId: string): string {
    return this.config.redisKey('slots', organisationId);
  }

  /**
   * 7b (owner decision 2026-10-25: 10 / user / minute, 60 / organisation / minute, 100 / user / day): ONE atomic call of
   * the shared token-bucket script over the three buckets — all checked before any is consumed (a refusal by one burns
   * none). 429 AI_RATE_LIMITED with Retry-After; Redis unavailable ⇒ 503 (`guard`). Titles and approval / answer
   * requests never call it (rate-exempt, still metered — D7-9).
   */
  async consumeRate(organisationId: string, userId: string): Promise<void> {
    const user = createHash('sha256').update(userId).digest('hex').slice(0, 32);
    const keys = [this.config.redisKey('rate', 'user', user), this.config.redisKey('rate', 'userday', user), this.config.redisKey('rate', 'org', organisationId)];
    const specs = [
      { capacity: this.config.userRatePerMinute, windowMs: 60_000, cost: 1 },
      { capacity: this.config.userTurnsPerDay, windowMs: 86_400_000, cost: 1 },
      { capacity: this.config.orgRatePerMinute, windowMs: 60_000, cost: 1 },
    ];
    const result = await this.guard(() => this.redis.client.eval(TOKEN_BUCKET_SCRIPT, keys.length, ...keys, JSON.stringify(specs)) as Promise<number[]>);
    if (Number(result[0]) !== 1) throw new AiTooManyRequestsException(AiErrorCode.RATE_LIMITED, Math.max(1, Math.ceil(Number(result[2]) / 1000)));
  }


  /**
   * Takes (or refreshes) the active slot of `conversationId` — Phase 2: the member is the CONVERSATION, so a running turn
   * and its queued successor hold ONE slot and AI_ORG_MAX_ACTIVE_TURNS still bounds the running turns (P2-D10). 429
   * AI_ORG_BUSY when the organisation is at its cap. `held` = this conversation already had it (a release on a later
   * failure must then leave it to its other turn).
   */
  async acquireSlot(organisationId: string, conversationId: string): Promise<'acquired' | 'held'> {
    const admitted = await this.guard(() =>
      this.redis.client.eval(AI_SLOT_ACQUIRE_SCRIPT, 1, this.slotKey(organisationId), conversationId, String(this.config.slotTtlMs), String(this.config.orgMaxActiveTurns)) as Promise<number>,
    );
    if (Number(admitted) === 2) return 'held';
    if (Number(admitted) !== 1) throw new AiTooManyRequestsException(AiErrorCode.ORG_BUSY, 10);
    return 'acquired';
  }

  /** Keeps the conversation's slot alive (the turn heartbeat). False when it had already expired or was released. */
  async refreshSlot(organisationId: string, conversationId: string): Promise<boolean> {
    const held = await this.guard(() => this.redis.client.eval(AI_SLOT_REFRESH_SCRIPT, 1, this.slotKey(organisationId), conversationId, String(this.config.slotTtlMs)) as Promise<number>);
    return Number(held) === 1;
  }

  /**
   * Best effort: a release that fails leaves the member to expire on its own (bounded by slotTtlMs). Callers release
   * only once the conversation has no queued or running turn left (they check that in their own tenant transaction); a
   * successor that loses the slot to a race re-acquires it at its claim, within the cap.
   */
  async releaseSlot(organisationId: string, conversationId: string): Promise<void> {
    await this.redis.client.zrem(this.slotKey(organisationId), conversationId).catch(() => undefined);
  }

  /** Whether the day's counter exists (the caller then skips reading the database seed). */
  async budgetKeyExists(organisationId: string, day: string): Promise<boolean> {
    return (await this.guard(() => this.redis.client.exists(this.budgetKey(organisationId, day)))) === 1;
  }

  /**
   * Reserves `amount` tokens of today's organisation budget. `seedTokens` = the day's persisted usage, used only when the
   * counter does not exist yet. 429 AI_BUDGET_EXHAUSTED when the reservation would pass the budget.
   */
  async reserveBudget(organisationId: string, day: string, amount: number, seedTokens: number | null): Promise<AiBudgetReservation> {
    const key = this.budgetKey(organisationId, day);
    const result = await this.guard(
      () => this.redis.client.eval(AI_BUDGET_RESERVE_SCRIPT, 1, key, String(amount), String(this.config.orgDailyTokenBudget), String(2 * 24 * 3600), seedTokens === null ? '' : String(seedTokens)) as Promise<number[]>,
    );
    if (Number(result[0]) !== 1) throw new AiTooManyRequestsException(AiErrorCode.BUDGET_EXHAUSTED, secondsToUtcMidnight());
    return { key, amount };
  }

  /** Reconciles a reservation with the real usage (`actual − reserved`; a refund when negative). Best effort. */
  async adjustBudget(organisationId: string, day: string, delta: number): Promise<void> {
    if (!Number.isFinite(delta) || delta === 0) return;
    await (this.redis.client.eval(AI_BUDGET_ADJUST_SCRIPT, 1, this.budgetKey(organisationId, day), String(Math.trunc(delta))) as Promise<number>).catch(() => undefined);
  }

  /** Today's counter (used + reserved), or null when Redis has none. Read-only; for the availability/usage view. */
  async currentBudgetUse(organisationId: string, day: string): Promise<number | null> {
    const value = await this.guard(() => this.redis.client.get(this.budgetKey(organisationId, day)));
    return value === null ? null : Number(value);
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch {
      throw new AiQuotaUnavailableError();
    }
  }
}

function secondsToUtcMidnight(now: Date = new Date()): number {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000));
}
