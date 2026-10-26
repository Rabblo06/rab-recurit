import './helpers/ai-env';

import { createHash, randomUUID } from 'node:crypto';

import { AI_RATE_LIMIT_DEFAULTS } from '@rab/shared';
import Redis from 'ioredis';

import { TOKEN_BUCKET_SCRIPT } from '../../engine/core-modules/rate-limit/token-bucket';
import { AuditService } from '../../engine/core-modules/audit/audit.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { AiQuotaUnavailableError } from '../../modules/ai/exceptions/ai.exceptions';
import { AiConfigService } from '../../modules/ai/services/ai-config.service';
import { AiCostBudgetExhaustedError, AiCostMeterService } from '../../modules/ai/services/ai-cost-meter.service';
import { utcDay } from '../../modules/ai/services/ai-quota.service';
import { AiKit, aiOrganisation, bootAiKit } from './helpers/ai-test-kit';

/**
 * Phase 7a meter v2 on the REAL Redis (+ PostgreSQL for the alert's audit row). Mock models only; no provider is called.
 *   T7-M1  a concurrent burst over two meter instances (two "Workers", two Redis connections) never passes either ceiling;
 *          user exhausted while the organisation has room → kind 'user', neither key charged; the seed path for each key;
 *          a seed read failure or Redis down → AiQuotaUnavailableError (refused, never unmetered); settle charges both
 *          keys; a settlement failure keeps the reservation; the Phase 1 adapter shares the org key.
 *   T7-A1  the 80 % alert: exactly one `ai.budget_threshold` audit row per organisation / day / kind under concurrency,
 *          also after the Redis flag is lost.
 *   T7-R1 (prep for 7b, script level only — no rate code changes in 7a) the owner's three buckets 10 / 60 / 100 in one
 *          atomic TOKEN_BUCKET_SCRIPT call: all checked before any is consumed, with Retry-After.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('AI meter v2 (integration)', () => {
  jest.setTimeout(180_000);
  let kit: AiKit;
  let meter: AiCostMeterService;
  let config: AiConfigService;
  let second: Redis;
  let secondMeter: AiCostMeterService;
  const day = utcDay();
  const loaders = (org = 0, user = 0) => ({ org: jest.fn(async () => org), user: jest.fn(async () => user) });
  const cleanup = async (org: string, ...users: string[]) => {
    await kit.redis.del(meter.meterKey(org, day), ...users.map((u) => meter.userMeterKey(org, u, day)), meter.alertKey(org, day, 'cost'), meter.alertKey(org, day, 'tokens'));
  };

  beforeAll(async () => {
    kit = await bootAiKit();
    meter = kit.moduleRef.get(AiCostMeterService);
    config = kit.moduleRef.get(AiConfigService);
    // A second, independent connection and meter instance: what a second Worker process would hold.
    second = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 });
    secondMeter = new AiCostMeterService(config, { client: second } as never, kit.moduleRef.get(AuditService), kit.moduleRef.get(TenantContextService));
  });
  afterAll(async () => {
    second?.disconnect();
    await kit?.close();
  });

  it('ceilings: org = AI_DAILY_BUDGET_USD (2 USD), user = min(1 USD default, org) in integer micro-USD; the user key never holds a raw id', () => {
    expect(meter.orgCeilingMicros).toBe(2_000_000);
    expect(meter.userCeilingMicros).toBe(1_000_000);
    const org = randomUUID();
    const user = randomUUID();
    const key = meter.userMeterKey(org, user, day);
    expect(key).toBe(`crewflow:test:ai:cost:${org}:user:${createHash('sha256').update(user).digest('hex').slice(0, 32)}:${day}`);
    expect(key).not.toContain(user);
    expect(meter.meterKey(org, day)).toBe(`crewflow:test:ai:cost:${org}:${day}`);
  });

  it('T7-M1 concurrent burst on two meters: no user passes 1 USD, the organisation never passes 2 USD, meters equal what was admitted', async () => {
    const org = randomUUID();
    const users = Array.from({ length: 5 }, () => randomUUID());
    const step = 300_000;
    const attempts = users.flatMap((u, i) => Array.from({ length: 8 }, (_, j) => ({ u, m: (i + j) % 2 === 0 ? meter : secondMeter })));
    const results = await Promise.all(attempts.map(({ u, m }) => m.reserveSeeded(org, u, day, step, loaders()).then((r) => ({ u, r }))));
    const admitted = results.filter((x) => x.r.admitted);
    expect(admitted).toHaveLength(Math.floor(2_000_000 / step)); // 6: the org ceiling binds
    const perUser = users.map((u) => admitted.filter((x) => x.u === u).length);
    for (const n of perUser) expect(n).toBeLessThanOrEqual(Math.floor(1_000_000 / step)); // ≤ 3 each
    expect(Number(await kit.redis.get(meter.meterKey(org, day)))).toBe(admitted.length * step);
    for (const [i, u] of users.entries()) expect(Number((await kit.redis.get(meter.userMeterKey(org, u, day))) ?? 0)).toBe(perUser[i]! * step);
    const refusals = results.filter((x) => !x.r.admitted).map((x) => (x.r as { kind: string }).kind);
    expect(refusals.every((k) => k === 'org' || k === 'user')).toBe(true);
    await cleanup(org, ...users);
  });

  it('T7-M1 one user burst: exactly floor(1 USD / step) admitted, the rest refused kind=user while the organisation still has room', async () => {
    const org = randomUUID();
    const user = randomUUID();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? meter : secondMeter).reserveSeeded(org, user, day, 300_000, loaders())));
    expect(results.filter((r) => r.admitted)).toHaveLength(3);
    expect(results.filter((r) => !r.admitted)).toEqual(Array.from({ length: 17 }, () => ({ admitted: false, kind: 'user' })));
    expect(await meter.current(org, user, day)).toEqual({ orgMicros: 900_000, userMicros: 900_000 });
    // Another user of the same organisation still works (the org has 1.1 USD left).
    expect(await meter.reserveSeeded(org, randomUUID(), day, 300_000, loaders())).toEqual({ admitted: true });
    await cleanup(org, user);
  });

  it('T7-M1 all-or-nothing: an org refusal charges neither key; the org is reported first when both are full', async () => {
    const org = randomUUID();
    const user = randomUUID();
    await kit.redis.set(meter.meterKey(org, day), '1950000');
    await kit.redis.set(meter.userMeterKey(org, user, day), '100000');
    expect(await meter.reserve(org, user, day, 100_000)).toEqual({ admitted: false, kind: 'org' });
    expect(await meter.current(org, user, day)).toEqual({ orgMicros: 1_950_000, userMicros: 100_000 });
    await kit.redis.set(meter.userMeterKey(org, user, day), '999999');
    expect(await meter.reserve(org, user, day, 100_000)).toEqual({ admitted: false, kind: 'org' });
    await cleanup(org, user);
  });

  it('T7-M1 seed path per key: a missing org key asks for the org seed, then the user seed; seeds are respected (a spent user stays spent)', async () => {
    const org = randomUUID();
    const user = randomUUID();
    expect(await meter.reserve(org, user, day, 10)).toEqual({ seedNeeded: 'org' });
    expect(await meter.reserve(org, user, day, 10, { orgMicros: 500_000 })).toEqual({ seedNeeded: 'user' });
    expect(await meter.reserve(org, user, day, 10, { orgMicros: 123, userMicros: 950_000 })).toEqual({ admitted: true });
    // SET NX: the org seed written first (500 000) is kept; the later 123 never overwrote it.
    expect(await meter.current(org, user, day)).toEqual({ orgMicros: 500_010, userMicros: 950_010 });
    await cleanup(org, user);
    const l = loaders(400_000, 990_000);
    expect(await meter.reserveSeeded(org, user, day, 20_000, l)).toEqual({ admitted: false, kind: 'user' });
    expect(l.org).toHaveBeenCalledTimes(1);
    expect(l.user).toHaveBeenCalledTimes(1);
    expect(await meter.current(org, user, day)).toEqual({ orgMicros: 400_000, userMicros: 990_000 });
    // The pre-check reads (and seeds) without charging.
    expect(await meter.readSeeded(org, user, day, loaders())).toEqual({ orgMicros: 400_000, userMicros: 990_000, orgCeilingMicros: 2_000_000, userCeilingMicros: 1_000_000, exhausted: null });
    await kit.redis.set(meter.userMeterKey(org, user, day), '1000000');
    expect((await meter.readSeeded(org, user, day, loaders())).exhausted).toBe('user');
    await cleanup(org, user);
  });

  it('T7-M1 fail closed: a seed read that throws / is NaN / is negative, a corrupt meter, bad input, or Redis down → AiQuotaUnavailableError', async () => {
    const org = randomUUID();
    const user = randomUUID();
    await expect(meter.reserveSeeded(org, user, day, 1, { org: async () => { throw new Error('db down'); }, user: async () => 0 })).rejects.toBeInstanceOf(AiQuotaUnavailableError);
    await expect(meter.reserveSeeded(org, user, day, 1, { org: async () => 0, user: async () => Number.NaN })).rejects.toBeInstanceOf(AiQuotaUnavailableError);
    await cleanup(org, user);
    await expect(meter.reserveSeeded(org, user, day, 1, { org: async () => -1, user: async () => 0 })).rejects.toBeInstanceOf(AiQuotaUnavailableError);
    await expect(meter.reserve(org, user, day, 1, { orgMicros: -5 })).rejects.toBeInstanceOf(AiQuotaUnavailableError);
    await expect(meter.reserve(org, user, day, Number.NaN, { orgMicros: 0, userMicros: 0 })).rejects.toBeInstanceOf(AiQuotaUnavailableError);
    await expect(meter.reserve(org, '', day, 1, { orgMicros: 0, userMicros: 0 })).rejects.toBeInstanceOf(AiQuotaUnavailableError);
    await kit.redis.set(meter.meterKey(org, day), 'not-a-number');
    await kit.redis.set(meter.userMeterKey(org, user, day), '0');
    await expect(meter.reserve(org, user, day, 1)).rejects.toBeInstanceOf(AiQuotaUnavailableError);
    await cleanup(org, user);
    const dead = new Redis('redis://127.0.0.1:1', { enableOfflineQueue: false, maxRetriesPerRequest: 0, connectTimeout: 200, lazyConnect: true, retryStrategy: () => null });
    dead.on('error', () => undefined);
    const broken = new AiCostMeterService(config, { client: dead } as never, kit.moduleRef.get(AuditService), kit.moduleRef.get(TenantContextService));
    await expect(broken.reserveSeeded(org, user, day, 1, loaders())).rejects.toBeInstanceOf(AiQuotaUnavailableError);
    await expect(broken.readSeeded(org, user, day, loaders())).rejects.toBeInstanceOf(AiQuotaUnavailableError);
    await expect(broken.current(org, user, day)).rejects.toBeInstanceOf(AiQuotaUnavailableError);
    await expect(broken.alerts(org, day)).rejects.toBeInstanceOf(AiQuotaUnavailableError);
    dead.disconnect();
  });

  it('T7-M1 settle charges the same delta to BOTH keys (never below zero); a failed settlement keeps the larger reserved charge', async () => {
    const org = randomUUID();
    const user = randomUUID();
    expect(await meter.reserveSeeded(org, user, day, 500_000, loaders())).toEqual({ admitted: true });
    await meter.settle(org, user, day, 120_000 - 500_000);
    expect(await meter.current(org, user, day)).toEqual({ orgMicros: 120_000, userMicros: 120_000 });
    await meter.settle(org, user, day, -10_000_000);
    expect(await meter.current(org, user, day)).toEqual({ orgMicros: 0, userMicros: 0 });
    // Settlement through a dead connection: no throw, and the reservation stays charged (over-count only).
    expect(await meter.reserveSeeded(org, user, day, 400_000, loaders())).toEqual({ admitted: true });
    const dead = new Redis('redis://127.0.0.1:1', { enableOfflineQueue: false, maxRetriesPerRequest: 0, connectTimeout: 200, lazyConnect: true, retryStrategy: () => null });
    dead.on('error', () => undefined);
    const broken = new AiCostMeterService(config, { client: dead } as never, kit.moduleRef.get(AuditService), kit.moduleRef.get(TenantContextService));
    await expect(broken.settle(org, user, day, -300_000)).resolves.toBeUndefined();
    await expect(broken.settle(org, day, -300_000)).resolves.toBeUndefined();
    dead.disconnect();
    expect(await meter.current(org, user, day)).toEqual({ orgMicros: 400_000, userMicros: 400_000 });
    // A missing key is not re-created by a settlement (the next reservation re-seeds it from the database).
    await kit.redis.del(meter.userMeterKey(org, user, day));
    await meter.settle(org, user, day, -100_000);
    expect(await kit.redis.exists(meter.userMeterKey(org, user, day))).toBe(0);
    expect(await meter.current(org, day)).toBe(300_000);
    await cleanup(org, user);
  });

  it('the Phase 1 one-key adapter reserves on the SAME org key v2 reads (a deploy never resets the budget)', async () => {
    const org = randomUUID();
    const user = randomUUID();
    await expect(meter.reserve(org, day, 1_500_000, async () => 0)).resolves.toBe(1_500_000);
    expect(await meter.reserveSeeded(org, user, day, 600_000, loaders())).toEqual({ admitted: false, kind: 'org' });
    expect(await meter.reserveSeeded(org, user, day, 500_000, loaders())).toEqual({ admitted: true });
    await expect(meter.reserve(org, day, 1, async () => 0)).rejects.toEqual(new AiCostBudgetExhaustedError('org'));
    expect(await meter.current(org, day)).toBe(2_000_000);
    await cleanup(org, user);
  });

  // ── T7-A1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  it('T7-A1 the 80 % alert: 20 concurrent crossings (both meters) write exactly ONE ai.budget_threshold row; a lost flag does not duplicate it', async () => {
    const org = await aiOrganisation(kit, 'ai-usage-alert');
    await cleanup(org.orgId, org.ceo.userId);
    // The organisation's day stands at 1.7 USD of 2 (85 %): every settlement below leaves it above 80 %.
    await kit.redis.set(meter.meterKey(org.orgId, day), String(1_700_000));
    await kit.redis.set(meter.userMeterKey(org.orgId, org.ceo.userId, day), '0');
    const settles = Array.from({ length: 20 }, (_, i) => (i % 2 ? meter : secondMeter).settle(org.orgId, org.ceo.userId, day, -1_000));
    await Promise.all(settles);
    const rows = await kit.owner.query(`SELECT actor_user_id, metadata FROM core.audit_log WHERE organisation_id = $1 AND action = 'ai.budget_threshold'`, [org.orgId]);
    expect(rows).toEqual([{ actor_user_id: null, metadata: { kind: 'cost', pct: 80, day } }]);
    expect(await meter.alerts(org.orgId, day)).toEqual(['cost']);
    // Direct concurrent calls of the token kind: one winner.
    const winners = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? meter : secondMeter).noteThreshold(org.orgId, day, 'tokens')));
    expect(winners.filter(Boolean)).toHaveLength(1);
    // The Redis flags are lost (restart): the database dedupe keeps it at one row per kind.
    await kit.redis.del(meter.alertKey(org.orgId, day, 'cost'), meter.alertKey(org.orgId, day, 'tokens'));
    expect(await meter.noteThreshold(org.orgId, day, 'cost')).toBe(false);
    expect(await meter.noteThreshold(org.orgId, day, 'tokens')).toBe(false);
    const [{ n }] = await kit.owner.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE organisation_id = $1 AND action = 'ai.budget_threshold'`, [org.orgId]);
    expect(n).toBe(2);
    expect(await meter.alerts(org.orgId, day)).toEqual(['cost', 'tokens']);
    await cleanup(org.orgId, org.ceo.userId);
  });

  it('T7-A1 below 80 % no alert; the threshold is integer arithmetic at exactly 80 %', async () => {
    const org = await aiOrganisation(kit, 'ai-usage-noalert');
    await kit.redis.set(meter.meterKey(org.orgId, day), String(1_600_001));
    await kit.redis.set(meter.userMeterKey(org.orgId, org.ceo.userId, day), '0');
    await meter.settle(org.orgId, org.ceo.userId, day, -2);
    expect(await kit.owner.query(`SELECT 1 FROM core.audit_log WHERE organisation_id = $1 AND action = 'ai.budget_threshold'`, [org.orgId])).toEqual([]);
    expect(AiCostMeterService.crossesAlert(1_599_999, 2_000_000)).toBe(false);
    expect(AiCostMeterService.crossesAlert(1_600_000, 2_000_000)).toBe(true);
    expect(AiCostMeterService.crossesAlert(5, 0)).toBe(false);
    // The Phase 1 adapter's settlement raises it too (the runner is unchanged until 7b).
    await meter.settle(org.orgId, day, 1);
    expect(await kit.owner.query(`SELECT metadata->>'kind' AS kind FROM core.audit_log WHERE organisation_id = $1 AND action = 'ai.budget_threshold'`, [org.orgId])).toEqual([{ kind: 'cost' }]);
    await cleanup(org.orgId, org.ceo.userId);
  });

  // ── T7-R1 prep (script level) ────────────────────────────────────────────────────────────────────────────────────
  it('T7-R1 prep: the owner rates 10 / 60 / 100 in ONE atomic three-bucket call — one empty bucket consumes none, Retry-After given', async () => {
    expect(AI_RATE_LIMIT_DEFAULTS).toEqual({ userPerMinute: 10, orgPerMinute: 60, userPerDay: 100 });
    const prefix = `crewflow:test:ai:p7-rate-prep:${randomUUID()}`;
    const keys = (user: string) => [`${prefix}:user:${user}`, `${prefix}:userday:${user}`, `${prefix}:org`];
    const spec = JSON.stringify([
      { capacity: AI_RATE_LIMIT_DEFAULTS.userPerMinute, windowMs: 60_000, cost: 1 },
      { capacity: AI_RATE_LIMIT_DEFAULTS.userPerDay, windowMs: 86_400_000, cost: 1 },
      { capacity: AI_RATE_LIMIT_DEFAULTS.orgPerMinute, windowMs: 60_000, cost: 1 },
    ]);
    const hit = (user: string) => kit.redis.eval(TOKEN_BUCKET_SCRIPT, 3, ...keys(user), spec) as Promise<number[]>;
    const burst = await Promise.all(Array.from({ length: 15 }, () => hit('u1')));
    expect(burst.filter((r) => Number(r[0]) === 1)).toHaveLength(10);
    const refused = burst.filter((r) => Number(r[0]) === 0);
    expect(refused.every((r) => Number(r[1]) === 1 && Number(r[2]) > 0)).toBe(true); // the user/minute bucket, with a wait
    // Fill the organisation's minute with 50 more users → the 61st request of the org is refused by bucket 3 …
    for (let i = 0; i < 50; i++) expect(Number((await hit(`f${i}`))[0])).toBe(1);
    const fresh = await hit('fresh');
    expect([Number(fresh[0]), Number(fresh[1])]).toEqual([0, 3]);
    // … and consumed nothing from the fresh user's own buckets (all-or-nothing).
    expect(await kit.redis.exists(keys('fresh')[0]!, keys('fresh')[1]!)).toBe(0);
    await kit.redis.del(...keys('u1'), ...keys('fresh'), ...Array.from({ length: 50 }, (_, i) => keys(`f${i}`).slice(0, 2)).flat());
  });
});
