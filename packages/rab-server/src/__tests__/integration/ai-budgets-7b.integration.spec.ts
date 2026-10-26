import './helpers/ai-env';

import { randomUUID } from 'node:crypto';

import { TEST_SMART_MODEL_ID, testModel } from '../support/ai/test-catalogue';
import { AiCostMeterService } from '../../modules/ai/services/ai-cost-meter.service';
import { utcDay } from '../../modules/ai/services/ai-quota.service';
import { AiRetentionService } from '../../modules/ai/services/ai-retention.service';
import { titleLedgerId } from '../../modules/ai/services/ai-title.service';
import { AiKit, aiOrganisation, ask, bearer, bootAiKit, jobFor, manager, newConversation, turnRow } from './helpers/ai-test-kit';

/**
 * AI Phase 7b — budgets and limits LIVE, end to end on rab_int with a PRICED in-process test model (no network):
 *   - submit: the caller's own daily allowance spent ⇒ 429 AI_USER_BUDGET_EXHAUSTED with Retry-After (the organisation
 *     still has room); the meter is re-seeded from the persisted ledger after a Redis loss (deleting a chat never hands
 *     budget back);
 *   - Worker: the same refusal before the model is called when the allowance is spent between submit and run;
 *   - terminal transaction: ONE ledger row per turn (kind chat) with the cost and context facts, and the turn row's cost /
 *     cache split; a re-delivered job writes nothing twice;
 *   - availability: the owner's limits and the caller's own cost figures;
 *   - retention: the usage ledger's own 400-day purge, purge mode only, audited with `usageRows`.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

const PRICED_ID = 'crewflow-mock-priced-1';
const PRICED = testModel({
  id: PRICED_ID,
  label: 'Crewflow priced test model',
  tier: 'fast',
  // $1 / $5 per 1M tokens: a step costs a few thousand micro-USD at most, far below the 1 USD allowance.
  price: { inputUsdMicrosPerMTok: 1_000_000, cachedInputUsdMicrosPerMTok: 100_000, cacheWriteUsdMicrosPerMTok: 1_250_000, outputUsdMicrosPerMTok: 5_000_000 },
});
const SMART = testModel({ id: TEST_SMART_MODEL_ID, label: 'Crewflow deterministic test model (smart)', tier: 'smart' });

describeIfDb('AI 7b budgets and limits (integration)', () => {
  jest.setTimeout(240_000);
  let kit: AiKit;
  let meter: AiCostMeterService;
  const day = utcDay();

  beforeAll(async () => {
    kit = await bootAiKit({ testModels: [PRICED, SMART] });
    meter = kit.moduleRef.get(AiCostMeterService);
  });
  afterAll(async () => {
    await kit?.close();
  });

  /** A persisted ledger row spending `micros` of the user's day (the seed the meter reads when its key is gone). */
  const spend = (orgId: string, userId: string, micros: number) =>
    kit.owner.query(
      `INSERT INTO core.ai_usage (organisation_id, user_id, turn_id, usage_date, kind, model, steps, input_tokens, output_tokens, cost_usd_micros, outcome)
       VALUES ($1, $2, gen_random_uuid(), $3::date, 'chat', $4, 1, 10, 10, $5, 'completed')`,
      [orgId, userId, day, PRICED_ID, String(micros)],
    );
  const forgetMeters = (orgId: string, userId: string) => kit.redis.del(meter.meterKey(orgId, day), meter.userMeterKey(orgId, userId, day));

  it("submit: the caller's own allowance spent ⇒ 429 AI_USER_BUDGET_EXHAUSTED + Retry-After, re-seeded from the ledger after a Redis loss; another user of the organisation still asks", async () => {
    const org = await aiOrganisation(kit, 'ai-7b-user-budget');
    await spend(org.orgId, org.ceo.userId, meter.userCeilingMicros);
    await forgetMeters(org.orgId, org.ceo.userId);
    const refused = await ask(kit, org.token, await newConversation(kit, org.token), 'How many shifts are open?');
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ code: 'AI_USER_BUDGET_EXHAUSTED', message: 'You have used your AI allowance for today.' });
    expect(Number(refused.body.retryAfterSeconds)).toBeGreaterThan(0);
    // The organisation meter was not charged by the refusal, and its own figure is untouched.
    expect((await meter.current(org.orgId, org.ceo.userId, day)).userMicros).toBe(meter.userCeilingMicros);
    const other = await manager(kit, org.orgId, { initial: true });
    expect((await ask(kit, other.token, await newConversation(kit, other.token), 'How many shifts are open?')).status).toBe(202);
  });

  it('Worker: an allowance spent between submit and run refuses the step BEFORE the model is called (AI_USER_BUDGET_EXHAUSTED)', async () => {
    const org = await aiOrganisation(kit, 'ai-7b-worker-budget');
    const conversationId = await newConversation(kit, org.token);
    const q = await ask(kit, org.token, conversationId, 'How many shifts are open?');
    expect(q.status).toBe(202);
    await spend(org.orgId, org.ceo.userId, meter.userCeilingMicros);
    await forgetMeters(org.orgId, org.ceo.userId);
    await expect(kit.runner.run(jobFor(org.ceo, conversationId, q.turnId))).resolves.toBe('failed');
    const row = await turnRow(kit, q.turnId);
    expect(row).toMatchObject({ status: 'failed', error_code: 'AI_USER_BUDGET_EXHAUSTED', input_tokens: 0, output_tokens: 0 });
  });

  it('terminal transaction: exactly ONE ledger row (kind chat, cost + context facts) and the turn row cost; a re-delivered job writes nothing twice', async () => {
    const org = await aiOrganisation(kit, 'ai-7b-ledger');
    const conversationId = await newConversation(kit, org.token);
    const q = await ask(kit, org.token, conversationId, 'How many shifts are open?');
    await expect(kit.runner.run(jobFor(org.ceo, conversationId, q.turnId))).resolves.toBe('completed');
    const [turn] = await kit.owner.query(`SELECT cost_usd_micros, cached_input_tokens, cache_write_tokens, input_tokens, output_tokens FROM core.ai_message WHERE id = $1`, [q.turnId]);
    expect(Number(turn.cost_usd_micros)).toBeGreaterThan(0);
    expect([turn.cached_input_tokens, turn.cache_write_tokens]).toEqual([0, 0]);
    const ledger = await kit.owner.query(
      `SELECT user_id, kind, model, steps, input_tokens, output_tokens, cost_usd_micros, outcome, context_used_tokens, context_limit_tokens FROM core.ai_usage WHERE turn_id = $1`,
      [q.turnId],
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ user_id: org.ceo.userId, kind: 'chat', model: PRICED_ID, outcome: 'completed' });
    expect(Number(ledger[0].cost_usd_micros)).toBe(Number(turn.cost_usd_micros));
    expect(Number(ledger[0].input_tokens)).toBe(Number(turn.input_tokens));
    expect(Number(ledger[0].context_used_tokens)).toBeGreaterThan(0);
    expect(Number(ledger[0].context_limit_tokens)).toBeGreaterThan(Number(ledger[0].context_used_tokens));
    // The daily counter got the same cost; the user's meter holds exactly what was settled.
    const [daily] = await kit.owner.query(`SELECT cost_usd_micros FROM core.ai_usage_daily WHERE organisation_id = $1 AND usage_date = $2::date AND model = $3`, [org.orgId, day, PRICED_ID]);
    expect(Number(daily.cost_usd_micros)).toBe(Number(turn.cost_usd_micros));
    expect((await meter.current(org.orgId, org.ceo.userId, day)).userMicros).toBe(Number(turn.cost_usd_micros));
    // Re-delivery: the compare-and-set finds no running turn; nothing is written twice.
    await expect(kit.runner.run(jobFor(org.ceo, conversationId, q.turnId))).resolves.toBe('skipped');
    expect(await kit.owner.query(`SELECT 1 FROM core.ai_usage WHERE turn_id = $1`, [q.turnId])).toHaveLength(1);
  });

  it("availability: the owner's limits and the caller's OWN cost figures (no other person's), reset at the next UTC midnight", async () => {
    const org = await aiOrganisation(kit, 'ai-7b-availability');
    await spend(org.orgId, org.ceo.userId, 250_000);
    await forgetMeters(org.orgId, org.ceo.userId);
    const res = await kit.http().get('/rest/v1/ai/availability').set(bearer(org.token));
    expect(res.status).toBe(200);
    expect(res.body.limits).toMatchObject({ userRatePerMinute: 60, orgRatePerMinute: 600, userTurnsPerDay: 10000 });
    expect(res.body.usage).toMatchObject({ day, userCostMicros: 250_000, userCostCeilingMicros: meter.userCeilingMicros, orgCostCeilingMicros: meter.orgCeilingMicros });
    const midnight = new Date(`${day}T00:00:00.000Z`);
    midnight.setUTCDate(midnight.getUTCDate() + 1);
    expect(res.body.usage.resetsAt).toBe(midnight.toISOString());
    expect(['user', 'org']).toContain(res.body.usage.limitingBudget);
  });

  it('title ledger id: deterministic per turn, distinct from the turn id, a valid RFC 4122 v5-layout UUID', () => {
    const turnId = randomUUID();
    expect(titleLedgerId(turnId)).toBe(titleLedgerId(turnId));
    expect(titleLedgerId(turnId)).not.toBe(turnId);
    expect(titleLedgerId(turnId)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('retention: purge mode deletes ledger rows older than 400 days for the bound organisation only, audited with usageRows; report mode never deletes', async () => {
    const org = await aiOrganisation(kit, 'ai-7b-usage-purge');
    const other = await aiOrganisation(kit, 'ai-7b-usage-purge-b');
    const old = (o: { orgId: string; ceo: { userId: string } }, days: number) =>
      kit.owner.query(
        `INSERT INTO core.ai_usage (organisation_id, user_id, turn_id, usage_date, kind, model, outcome) VALUES ($1, $2, gen_random_uuid(), (now() - make_interval(days => $3))::date, 'chat', $4, 'completed')`,
        [o.orgId, o.ceo.userId, days, PRICED_ID],
      );
    await old(org, 500);
    await old(org, 10);
    await old(other, 500);
    const retention = kit.moduleRef.get(AiRetentionService);
    expect(await retention.purgeUsage(org.orgId)).toBe(1);
    expect(await kit.owner.query(`SELECT 1 FROM core.ai_usage WHERE organisation_id = $1`, [org.orgId])).toHaveLength(1);
    expect(await kit.owner.query(`SELECT 1 FROM core.ai_usage WHERE organisation_id = $1`, [other.orgId])).toHaveLength(1);
    const [audit] = await kit.owner.query(`SELECT metadata FROM core.audit_log WHERE organisation_id = $1 AND action = 'ai.retention_purged' AND entity_type = 'ai_usage'`, [org.orgId]);
    expect(audit.metadata).toMatchObject({ usageRows: 1, retentionDays: 400 });
  });
});
