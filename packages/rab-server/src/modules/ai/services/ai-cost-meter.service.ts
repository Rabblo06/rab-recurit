import { Injectable } from '@nestjs/common';

import { AiQuotaUnavailableError } from '../exceptions/ai.exceptions';
import { AiConfigService } from './ai-config.service';
import { AiRedisClientProvider } from './ai-redis-client.provider';

/**
 * Per-organisation daily COST reservation (micro-USD). KEYS[1] = the org/day meter (settled cost + open reservations).
 * ARGV: amount, ceiling, ttlSeconds, seed. A missing key is NEVER reserved against blind: without a seed the script
 * answers {-1} and the caller reloads the day's persisted cost from `ai_usage_daily` and retries with it, so a lost key
 * (Redis restart, eviction) cannot hand a tenant a fresh budget. `SET … NX` semantics: a concurrent seeder never
 * overwrites a meter another request already created. Admitted only if current + amount <= ceiling, atomically, so any
 * number of concurrent steps on any number of Workers can never jointly pass the budget. Returns {1|0|-1, current}.
 */
export const AI_COST_RESERVE_SCRIPT = `
local amount = tonumber(ARGV[1])
local ceiling = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
if redis.call('EXISTS', KEYS[1]) == 0 then
  if ARGV[4] == '' then return {-1, 0} end
  redis.call('SET', KEYS[1], ARGV[4], 'EX', ttl, 'NX')
end
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current + amount > ceiling then
  return {0, current}
end
local after = redis.call('INCRBY', KEYS[1], amount)
redis.call('EXPIRE', KEYS[1], ttl)
return {1, after}
`;

/** Settlement: add (actual − reserved), never below zero, only while the meter exists (else the DB re-seeds it). */
export const AI_COST_SETTLE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
local after = redis.call('INCRBY', KEYS[1], tonumber(ARGV[1]))
if after < 0 then redis.call('SET', KEYS[1], '0', 'KEEPTTL'); after = 0 end
return after
`;

/** The organisation's estimated-cost budget for the day is spent (or this step's worst case would pass it). */
export class AiCostBudgetExhaustedError extends Error {
  constructor() {
    super('AI daily cost budget exhausted');
    this.name = 'AiCostBudgetExhaustedError';
  }
}

const METER_TTL_SECONDS = 2 * 24 * 3600;

/**
 * AI_DAILY_BUDGET_USD (owner decision 6). Before EVERY model step the Worker reserves that step's worst-case cost
 * (input upper bound + full output allowance, at catalogue prices); after the step it settles to the actual usage; the
 * settled cost of a turn is persisted to `ai_usage_daily.cost_usd_micros` in the turn's terminal transaction. Redis or
 * the database seed unavailable ⇒ AiQuotaUnavailableError: the step is refused (fail closed), never run unmetered.
 */
@Injectable()
export class AiCostMeterService {
  constructor(
    private readonly config: AiConfigService,
    private readonly redis: AiRedisClientProvider,
  ) {}

  meterKey(organisationId: string, day: string): string {
    return this.config.redisKey('cost', organisationId, day);
  }

  /** Reserves `amountMicros` of the organisation's day. `loadSeed` = the day's persisted cost, read only if the meter is missing. */
  async reserve(organisationId: string, day: string, amountMicros: number, loadSeed: () => Promise<number>): Promise<number> {
    const amount = Math.max(0, Math.ceil(amountMicros));
    const key = this.meterKey(organisationId, day);
    const ceiling = this.config.dailyBudgetUsdMicros;
    const run = (seed: string) => this.guard(() => this.redis.client.eval(AI_COST_RESERVE_SCRIPT, 1, key, String(amount), String(ceiling), String(METER_TTL_SECONDS), seed) as Promise<number[]>);
    let result = await run('');
    if (Number(result[0]) === -1) {
      let seed: number;
      try {
        seed = await loadSeed();
      } catch {
        throw new AiQuotaUnavailableError();
      }
      if (!Number.isFinite(seed) || seed < 0) throw new AiQuotaUnavailableError();
      result = await run(String(Math.ceil(seed)));
    }
    if (Number(result[0]) !== 1) throw new AiCostBudgetExhaustedError();
    return amount;
  }

  /** Adds `actual − reserved` (a refund when negative). Best effort: a failure leaves the larger (reserved) charge. */
  async settle(organisationId: string, day: string, deltaMicros: number): Promise<void> {
    if (!Number.isFinite(deltaMicros) || deltaMicros === 0) return;
    await (this.redis.client.eval(AI_COST_SETTLE_SCRIPT, 1, this.meterKey(organisationId, day), String(Math.trunc(deltaMicros))) as Promise<number>).catch(() => undefined);
  }

  /** The day's meter (settled + reserved micro-USD), or null when Redis holds none. */
  async current(organisationId: string, day: string): Promise<number | null> {
    const value = await this.guard(() => this.redis.client.get(this.meterKey(organisationId, day)));
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
