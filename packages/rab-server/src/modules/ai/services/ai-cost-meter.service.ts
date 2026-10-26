import { createHash } from 'node:crypto';

import { AI_BUDGET_ALERT_PERCENT } from '@rab/shared';
import { Injectable, Logger } from '@nestjs/common';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AiCostMeterV2Contract, AiCostReserveResult, AiMeterSeeds } from '../contracts/usage';
import { AiQuotaUnavailableError } from '../exceptions/ai.exceptions';
import { AiConfigService } from './ai-config.service';
import { AiRedisClientProvider } from './ai-redis-client.provider';

/**
 * Phase 1 (v1) per-organisation daily COST reservation (micro-USD). KEYS[1] = the org/day meter (settled cost + open
 * reservations). ARGV: amount, ceiling, ttlSeconds, seed. A missing key is NEVER reserved against blind: without a seed
 * the script answers {-1} and the caller reloads the day's persisted cost from `ai_usage_daily` and retries with it, so a
 * lost key (Redis restart, eviction) cannot hand a tenant a fresh budget. `SET … NX` semantics: a concurrent seeder never
 * overwrites a meter another request already created. Admitted only if current + amount <= ceiling, atomically, so any
 * number of concurrent steps on any number of Workers can never jointly pass the budget. Returns {1|0|-1, current}.
 *
 * KEPT as the Phase 1 one-key ADAPTER until 7b moves the runner onto v2 (then it is removed). It reads and writes the
 * SAME org key as v2, so the switch never resets a budget.
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

/** v1 settlement: add (actual − reserved), never below zero, only while the meter exists (else the DB re-seeds it). */
export const AI_COST_SETTLE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
local after = redis.call('INCRBY', KEYS[1], tonumber(ARGV[1]))
if after < 0 then redis.call('SET', KEYS[1], '0', 'KEEPTTL'); after = 0 end
return after
`;

/**
 * Meter v2 (P7 §2.1): ONE atomic call over TWO keys — KEYS[1] the organisation's day (the unchanged v1 name, so a deploy
 * never resets it) and KEYS[2] the user's day. ARGV: amount, orgCeiling, userCeiling, ttlSeconds, orgSeed, userSeed.
 *   - A missing key with no seed returns {-1, 'org'|'user', 0, 0}: the caller loads THAT seed and calls again. A seed is
 *     written with SET … NX, so a concurrent seeder never overwrites a meter another request already created.
 *   - All-or-nothing admission: `org + a <= orgCeiling AND user + a <= userCeiling`, else {0, kind, org, user} and
 *     NEITHER key is charged (org reported first: it stops everyone in the organisation).
 *   - Admitted: both keys are charged, TTL refreshed, {1, '', orgAfter, userAfter}.
 *   - Anything malformed (argument, seed or stored value not a number) is a script error → AiQuotaUnavailableError at the
 *     caller: the step is refused, never run unmetered.
 * `amount = 0` charges nothing and is how the submit pre-check reads (and, if needed, seeds) both meters.
 */
export const AI_COST_RESERVE_SCRIPT_V2 = `
local amount = tonumber(ARGV[1])
local orgCeiling = tonumber(ARGV[2])
local userCeiling = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
if amount == nil or orgCeiling == nil or userCeiling == nil or ttl == nil or amount < 0 or ttl <= 0 then
  return redis.error_reply('ai-cost-v2: invalid arguments')
end
local kinds = {'org', 'user'}
for i = 1, 2 do
  if redis.call('EXISTS', KEYS[i]) == 0 then
    local seed = ARGV[4 + i]
    if seed == '' then return {-1, kinds[i], 0, 0} end
    if tonumber(seed) == nil or tonumber(seed) < 0 then return redis.error_reply('ai-cost-v2: invalid seed') end
    redis.call('SET', KEYS[i], seed, 'EX', ttl, 'NX')
  end
end
local org = tonumber(redis.call('GET', KEYS[1]))
local user = tonumber(redis.call('GET', KEYS[2]))
if org == nil or user == nil then return redis.error_reply('ai-cost-v2: meter value is not a number') end
if org + amount > orgCeiling then return {0, 'org', org, user} end
if user + amount > userCeiling then return {0, 'user', org, user} end
if amount > 0 then
  org = redis.call('INCRBY', KEYS[1], amount)
  user = redis.call('INCRBY', KEYS[2], amount)
end
redis.call('EXPIRE', KEYS[1], ttl)
redis.call('EXPIRE', KEYS[2], ttl)
return {1, '', org, user}
`;

/**
 * v2 settlement: the SAME delta (actual − reserved, usually ≤ 0) on BOTH keys, each never below zero, each only while
 * it exists (a missing key is re-seeded from the database by the next reservation). Returns {orgAfter, userAfter}, -1
 * for a missing key.
 */
export const AI_COST_SETTLE_SCRIPT_V2 = `
local delta = tonumber(ARGV[1])
if delta == nil then return redis.error_reply('ai-cost-v2: invalid delta') end
local out = {}
for i = 1, 2 do
  if redis.call('EXISTS', KEYS[i]) == 0 then
    out[i] = -1
  else
    local after = redis.call('INCRBY', KEYS[i], delta)
    if after < 0 then redis.call('SET', KEYS[i], '0', 'KEEPTTL'); after = 0 end
    out[i] = after
  end
end
return out
`;

/** The day's estimated-cost budget is spent (or this step's worst case would pass it). `kind` names the ceiling that refused. */
export class AiCostBudgetExhaustedError extends Error {
  constructor(readonly kind: 'org' | 'user' = 'org') {
    super(kind === 'user' ? 'AI daily user cost budget exhausted' : 'AI daily cost budget exhausted');
    this.name = 'AiCostBudgetExhaustedError';
  }
}

/** The two budget kinds the 80 % alert covers (P7 §2.1, D7-6): the org cost budget and the org daily token budget. */
export type AiBudgetAlertKind = 'cost' | 'tokens';
export const AI_BUDGET_ALERT_KINDS: readonly AiBudgetAlertKind[] = ['cost', 'tokens'];

/** Database seed loaders for the v2 seed path (org: `ai_usage_daily`; user: `core.ai_usage`, which survives conversation deletion). */
export interface AiMeterSeedLoaders {
  org: () => Promise<number>;
  user: () => Promise<number>;
}

export interface AiMeterReading {
  orgMicros: number;
  userMicros: number;
  orgCeilingMicros: number;
  userCeilingMicros: number;
  /** The ceiling already reached (current ≥ ceiling), org first; null while both have room. */
  exhausted: 'org' | 'user' | null;
}

const METER_TTL_SECONDS = 2 * 24 * 3600;
const MAX_SEED_ROUNDS = 3;

type V2Reply = [number | string, string, number | string, number | string];

/**
 * Estimated-cost meters (owner decision 6 + Phase 7 D7-2). Before EVERY model step the Worker reserves that step's
 * worst-case cost (input upper bound + full output allowance, at catalogue prices); after the step it settles to the
 * actual usage; the settled cost of a turn is persisted (`ai_usage_daily.cost_usd_micros`, and from 7b `core.ai_usage`)
 * in the turn's terminal transaction.
 *
 * v2 (this phase): the organisation key AND the user key in one atomic script; the effective user ceiling is
 * min(user, org). The Phase 1 one-key signatures (`reserve(org, day, amount, loadSeed)`, `settle(org, day, delta)`,
 * `current(org, day)`) stay as an ADAPTER on the same org key until 7b moves the runner onto v2.
 *
 * Fail closed everywhere: Redis, a seed read or a script error ⇒ AiQuotaUnavailableError (the step / submit is refused,
 * never run unmetered). A settlement failure leaves the larger reserved charge in place.
 *
 * 80 % alert (rules 10.2 / 14.2, D7-6): when a settlement leaves the organisation's cost meter at or above
 * AI_BUDGET_ALERT_PERCENT of its ceiling, `noteThreshold` sets a per-organisation/day/kind Redis flag with SET NX; only
 * the caller that created the flag writes ONE audit row `ai.budget_threshold {kind, pct, day}` (actor-less, metadata
 * only). The same method serves the token budget (`kind = 'tokens'`, called by the quota service in 7b).
 */
@Injectable()
export class AiCostMeterService implements AiCostMeterV2Contract {
  private readonly logger = new Logger(AiCostMeterService.name);

  constructor(
    private readonly config: AiConfigService,
    private readonly redis: AiRedisClientProvider,
    private readonly audit: AuditService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** The organisation's day meter (the v1 name, unchanged so a deploy never resets the budget). */
  meterKey(organisationId: string, day: string): string {
    return this.config.redisKey('cost', organisationId, day);
  }

  /** `crewflow:<env>:ai:cost:<org>:user:<sha256(userId)[0..32]>:<day>` — no raw user id in Redis. */
  userMeterKey(organisationId: string, userId: string, day: string): string {
    return this.config.redisKey('cost', organisationId, 'user', createHash('sha256').update(userId).digest('hex').slice(0, 32), day);
  }

  /** The once-per-organisation/day/kind 80 % flag. */
  alertKey(organisationId: string, day: string, kind: AiBudgetAlertKind): string {
    return this.config.redisKey('budget-alert', organisationId, day, kind);
  }

  /** AI_DAILY_BUDGET_USD in integer micro-USD. */
  get orgCeilingMicros(): number {
    return this.config.dailyBudgetUsdMicros;
  }

  /** The per-user daily ceiling in integer micro-USD: min(AI_USER_DAILY_BUDGET_USD, AI_DAILY_BUDGET_USD) (D7-2). */
  get userCeilingMicros(): number {
    // 7b: the env value AI_USER_DAILY_BUDGET_USD (PROVISIONAL default 1 USD), already capped at the org ceiling.
    return this.config.userDailyBudgetUsdMicros;
  }

  // ── reserve ───────────────────────────────────────────────────────────────────────────────────────────────────────
  /** v1 adapter: reserves `amountMicros` of the organisation's day only; `loadSeed` = the persisted org cost, read only if the meter is missing. */
  reserve(organisationId: string, day: string, amountMicros: number, loadSeed: () => Promise<number>): Promise<number>;
  /** v2: one atomic, all-or-nothing reservation on the org AND the user key (`AiCostMeterV2Contract`). */
  reserve(organisationId: string, userId: string, day: string, amountMicros: number, seeds?: AiMeterSeeds): Promise<AiCostReserveResult>;
  async reserve(organisationId: string, a: string, b: string | number, c: number | (() => Promise<number>), d?: AiMeterSeeds): Promise<number | AiCostReserveResult> {
    if (typeof b === 'number' && typeof c === 'function') return this.reserveV1(organisationId, a, b, c);
    if (typeof b !== 'string' || typeof c !== 'number') throw new AiQuotaUnavailableError();
    return this.reserveV2(organisationId, a, b, c, d ?? {});
  }

  /**
   * v2 with the seed path resolved: loads each missing key's seed through `loaders` and retries (bounded). A loader that
   * throws or returns anything but a finite number ≥ 0 ⇒ AiQuotaUnavailableError. Returns the admission decision.
   */
  async reserveSeeded(organisationId: string, userId: string, day: string, amountMicros: number, loaders: AiMeterSeedLoaders): Promise<{ admitted: true } | { admitted: false; kind: 'org' | 'user' }> {
    const seeds: AiMeterSeeds = {};
    for (let round = 0; round < MAX_SEED_ROUNDS; round++) {
      const result = await this.reserveV2(organisationId, userId, day, amountMicros, seeds);
      if ('seedNeeded' in result) {
        if (result.seedNeeded === 'org') seeds.orgMicros = await this.loadSeed(loaders.org);
        else seeds.userMicros = await this.loadSeed(loaders.user);
        continue;
      }
      return result;
    }
    throw new AiQuotaUnavailableError();
  }

  /** Reads (and, when missing, seeds) both meters without charging anything: the submit pre-check (7b). */
  async readSeeded(organisationId: string, userId: string, day: string, loaders: AiMeterSeedLoaders): Promise<AiMeterReading> {
    const seeds: AiMeterSeeds = {};
    for (let round = 0; round < MAX_SEED_ROUNDS; round++) {
      const reply = await this.evalReserveV2(organisationId, userId, day, 0, seeds);
      if (Number(reply[0]) === -1) {
        if (String(reply[1]) === 'org') seeds.orgMicros = await this.loadSeed(loaders.org);
        else seeds.userMicros = await this.loadSeed(loaders.user);
        continue;
      }
      const orgMicros = this.finite(reply[2]);
      const userMicros = this.finite(reply[3]);
      const orgCeilingMicros = this.orgCeilingMicros;
      const userCeilingMicros = this.userCeilingMicros;
      const exhausted = orgMicros >= orgCeilingMicros ? 'org' : userMicros >= userCeilingMicros ? 'user' : null;
      return { orgMicros, userMicros, orgCeilingMicros, userCeilingMicros, exhausted };
    }
    throw new AiQuotaUnavailableError();
  }

  // ── settle ────────────────────────────────────────────────────────────────────────────────────────────────────────
  /** v1 adapter: adds `actual − reserved` to the org key (a refund when negative). A failure leaves the larger (reserved) charge. */
  settle(organisationId: string, day: string, deltaMicros: number): Promise<void>;
  /** v2: the same delta on BOTH keys. A failure leaves the larger (reserved) charge. */
  settle(organisationId: string, userId: string, day: string, deltaMicros: number): Promise<void>;
  async settle(organisationId: string, a: string, b: string | number, c?: number): Promise<void> {
    if (typeof b === 'number') return this.settleV1(organisationId, a, b);
    if (typeof c === 'number') return this.settleV2(organisationId, a, b, c);
  }

  // ── current ───────────────────────────────────────────────────────────────────────────────────────────────────────
  /** v1 adapter: the org meter (settled + reserved micro-USD), or null when Redis holds none. */
  current(organisationId: string, day: string): Promise<number | null>;
  /** v2: both meters; a missing key reads 0 (NOT authoritative: a missing key is seeded by `reserveSeeded` / `readSeeded`). */
  current(organisationId: string, userId: string, day: string): Promise<{ orgMicros: number; userMicros: number }>;
  async current(organisationId: string, a: string, b?: string): Promise<number | null | { orgMicros: number; userMicros: number }> {
    if (b === undefined) {
      const value = await this.guard(() => this.redis.client.get(this.meterKey(organisationId, a)));
      return value === null ? null : Number(value);
    }
    const [org, user] = await this.guard(() => this.redis.client.mget(this.meterKey(organisationId, b), this.userMeterKey(organisationId, a, b)));
    return { orgMicros: org === null || org === undefined ? 0 : this.finite(org), userMicros: user === null || user === undefined ? 0 : this.finite(user) };
  }

  // ── 80 % alert ────────────────────────────────────────────────────────────────────────────────────────────────────
  /**
   * Fires the day's alert of `kind` at most once per organisation: `SET NX` decides which caller writes, then ONE audit
   * row `ai.budget_threshold` (actor-less, `{kind, pct, day}`) unless one already exists for that day (a lost Redis flag
   * does not duplicate it). Returns true only for the caller that wrote the row. Best effort: a failure clears the flag
   * so a later settlement retries, and never fails the step.
   */
  async noteThreshold(organisationId: string, day: string, kind: AiBudgetAlertKind): Promise<boolean> {
    const key = this.alertKey(organisationId, day, kind);
    let first: boolean;
    try {
      first = (await this.redis.client.set(key, '1', 'EX', METER_TTL_SECONDS, 'NX')) === 'OK';
    } catch {
      return false;
    }
    if (!first) return false;
    try {
      return await this.tenantContext.runInTenantContext({ organisationId, workspaceId: null, userId: '', role: '' }, async (m) => {
        const existing = await m.query<unknown[]>(
          `SELECT 1 FROM core.audit_log WHERE organisation_id = $1 AND action = $2 AND metadata->>'day' = $3 AND metadata->>'kind' = $4 LIMIT 1`,
          [organisationId, AuditAction.AI_BUDGET_THRESHOLD, day, kind],
        );
        if (existing.length > 0) return false;
        await this.audit.record(m, { organisationId, userId: '' }, AuditAction.AI_BUDGET_THRESHOLD, {
          actorUserId: null,
          entityType: 'ai_budget',
          metadata: { kind, pct: AI_BUDGET_ALERT_PERCENT, day },
        });
        return true;
      });
    } catch {
      await this.redis.client.del(key).catch(() => undefined);
      this.logger.warn('AI budget threshold alert could not be recorded; it will be retried on the next settlement');
      return false;
    }
  }

  /** Today's raised alerts (flags only): `AiUsageView.today.alerts` and the admin overview (7b). */
  async alerts(organisationId: string, day: string): Promise<AiBudgetAlertKind[]> {
    const values = await this.guard(() => this.redis.client.mget(...AI_BUDGET_ALERT_KINDS.map((k) => this.alertKey(organisationId, day, k))));
    return AI_BUDGET_ALERT_KINDS.filter((_, i) => values[i] !== null && values[i] !== undefined);
  }

  /** True when `used` is at or above AI_BUDGET_ALERT_PERCENT of `ceiling` (integer arithmetic). */
  static crossesAlert(used: number, ceiling: number): boolean {
    return Number.isFinite(used) && Number.isFinite(ceiling) && ceiling > 0 && used * 100 >= ceiling * AI_BUDGET_ALERT_PERCENT;
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────────────────────────
  private async reserveV1(organisationId: string, day: string, amountMicros: number, loadSeed: () => Promise<number>): Promise<number> {
    const amount = Math.max(0, Math.ceil(amountMicros));
    const key = this.meterKey(organisationId, day);
    const ceiling = this.orgCeilingMicros;
    const run = (seed: string) => this.guard(() => this.redis.client.eval(AI_COST_RESERVE_SCRIPT, 1, key, String(amount), String(ceiling), String(METER_TTL_SECONDS), seed) as Promise<number[]>);
    let result = await run('');
    if (Number(result[0]) === -1) result = await run(String(await this.loadSeed(loadSeed)));
    if (Number(result[0]) !== 1) throw new AiCostBudgetExhaustedError('org');
    return amount;
  }

  private async reserveV2(organisationId: string, userId: string, day: string, amountMicros: number, seeds: AiMeterSeeds): Promise<AiCostReserveResult> {
    const reply = await this.evalReserveV2(organisationId, userId, day, amountMicros, seeds);
    const status = Number(reply[0]);
    const kind = String(reply[1]);
    if (status === 1) return { admitted: true };
    if (kind === 'org' || kind === 'user') {
      if (status === 0) return { admitted: false, kind };
      if (status === -1) return { seedNeeded: kind };
    }
    throw new AiQuotaUnavailableError();
  }

  private async evalReserveV2(organisationId: string, userId: string, day: string, amountMicros: number, seeds: AiMeterSeeds): Promise<V2Reply> {
    if (!userId || !Number.isFinite(amountMicros) || amountMicros < 0) throw new AiQuotaUnavailableError();
    for (const v of [seeds.orgMicros, seeds.userMicros]) {
      if (v !== undefined && !(Number.isFinite(v) && v >= 0)) throw new AiQuotaUnavailableError();
    }
    const seed = (v: number | undefined) => (v === undefined ? '' : String(Math.ceil(v)));
    return this.guard(
      () =>
        this.redis.client.eval(
          AI_COST_RESERVE_SCRIPT_V2,
          2,
          this.meterKey(organisationId, day),
          this.userMeterKey(organisationId, userId, day),
          String(Math.ceil(amountMicros)),
          String(this.orgCeilingMicros),
          String(this.userCeilingMicros),
          String(METER_TTL_SECONDS),
          seed(seeds.orgMicros),
          seed(seeds.userMicros),
        ) as Promise<V2Reply>,
    );
  }

  private async settleV1(organisationId: string, day: string, deltaMicros: number): Promise<void> {
    if (!Number.isFinite(deltaMicros) || Math.trunc(deltaMicros) === 0) return;
    let after: number;
    try {
      after = Number(await (this.redis.client.eval(AI_COST_SETTLE_SCRIPT, 1, this.meterKey(organisationId, day), String(Math.trunc(deltaMicros))) as Promise<number>));
    } catch {
      this.settleFailed();
      return;
    }
    await this.afterSettle(organisationId, day, after);
  }

  private async settleV2(organisationId: string, userId: string, day: string, deltaMicros: number): Promise<void> {
    if (!userId || !Number.isFinite(deltaMicros) || Math.trunc(deltaMicros) === 0) return;
    let after: number[];
    try {
      const reply = (await this.redis.client.eval(
        AI_COST_SETTLE_SCRIPT_V2,
        2,
        this.meterKey(organisationId, day),
        this.userMeterKey(organisationId, userId, day),
        String(Math.trunc(deltaMicros)),
      )) as Array<number | string>;
      after = reply.map(Number);
    } catch {
      this.settleFailed();
      return;
    }
    await this.afterSettle(organisationId, day, after[0] ?? -1);
  }

  private async afterSettle(organisationId: string, day: string, orgAfter: number): Promise<void> {
    if (orgAfter >= 0 && AiCostMeterService.crossesAlert(orgAfter, this.orgCeilingMicros)) await this.noteThreshold(organisationId, day, 'cost');
  }

  private settleFailed(): void {
    // The reservation (the worst case, ≥ the actual cost) stays charged: the meter can only over-count.
    this.logger.warn('AI cost meter settlement failed; the reserved charge stays in place');
  }

  private async loadSeed(load: () => Promise<number>): Promise<number> {
    let seed: number;
    try {
      seed = await load();
    } catch {
      throw new AiQuotaUnavailableError();
    }
    if (typeof seed !== 'number' || !Number.isFinite(seed) || seed < 0) throw new AiQuotaUnavailableError();
    return Math.ceil(seed);
  }

  private finite(value: unknown): number {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new AiQuotaUnavailableError();
    return n;
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch {
      throw new AiQuotaUnavailableError();
    }
  }
}
