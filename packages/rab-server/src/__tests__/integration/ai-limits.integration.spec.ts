import './helpers/ai-env-limits';

import { randomUUID } from 'node:crypto';

import { AiQuotaService, utcDay } from '../../modules/ai/services/ai-quota.service';
import { AiKit, aiOrganisation, ask, bearer, bootAiKit, jobFor, manager, newConversation, turnRow } from './helpers/ai-test-kit';

/**
 * AI Phase 1 — limits and fail-closed behaviour (brief §15 "Limits and reliability"): per-user 429, per-organisation
 * active-turn cap, daily token budget (including after a Redis restart: the counter is re-seeded from PostgreSQL),
 * ATOMIC concurrent reservations, input bound, conversation bound, and a Redis outage refusing new AI work (API 503,
 * Worker AI_SERVICE_UNAVAILABLE) instead of running without limits.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('AI limits (integration)', () => {
  jest.setTimeout(180_000);
  let kit: AiKit;
  let quota: AiQuotaService;

  beforeAll(async () => {
    kit = await bootAiKit();
    quota = kit.moduleRef.get(AiQuotaService);
  });
  afterAll(async () => {
    await kit?.close();
  });

  it('per-organisation active turns (2) then per-user rate (3/min): 202, 202, 429 AI_ORG_BUSY, 429 AI_RATE_LIMITED with retryAfterSeconds', async () => {
    const org = await aiOrganisation(kit, 'ai-lim-rate');
    const statuses: Array<[number, unknown]> = [];
    for (let i = 0; i < 4; i++) {
      const r = await ask(kit, org.token, await newConversation(kit, org.token), `question ${i}`);
      statuses.push([r.status, r.body.code ?? r.body.status]);
      if (r.status === 429) expect(Number(r.body.retryAfterSeconds)).toBeGreaterThan(0);
    }
    expect(statuses).toEqual([[202, 'queued'], [202, 'queued'], [429, 'AI_ORG_BUSY'], [429, 'AI_RATE_LIMITED']]);
    const refused = await kit.owner.query(`SELECT metadata->>'reason' AS reason FROM core.audit_log WHERE organisation_id = $1 AND action = 'ai.turn_refused' ORDER BY created_at`, [org.orgId]);
    expect(refused.map((r: { reason: string }) => r.reason)).toEqual(['AI_ORG_BUSY', 'AI_RATE_LIMITED']);
    // Refused questions left nothing behind.
    const [{ n }] = await kit.owner.query(`SELECT count(*)::int AS n FROM core.ai_message WHERE organisation_id = $1 AND role = 'assistant'`, [org.orgId]);
    expect(n).toBe(2);
  });

  it('concurrent reservations are atomic: 20 parallel budget reservations of 44 000 against 100 000 admit exactly 2; 20 parallel slot claims admit exactly 2; 20 parallel rate hits admit exactly 3', async () => {
    const orgId = randomUUID();
    const day = utcDay();
    const budget = await Promise.allSettled(Array.from({ length: 20 }, () => quota.reserveBudget(orgId, day, 44_000, 0)));
    expect(budget.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(Number(await kit.redis.get(quota.budgetKey(orgId, day)))).toBe(88_000);
    const slots = await Promise.allSettled(Array.from({ length: 20 }, () => quota.acquireSlot(orgId, randomUUID())));
    expect(slots.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const userId = randomUUID();
    const rate = await Promise.allSettled(Array.from({ length: 20 }, () => quota.consumeUserRate(userId)));
    expect(rate.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
  });

  it('daily budget: after a Redis restart the counter is re-seeded from ai_usage_daily, so an exhausted organisation stays exhausted (429 AI_BUDGET_EXHAUSTED)', async () => {
    const org = await aiOrganisation(kit, 'ai-lim-budget');
    await kit.owner.query(`INSERT INTO core.ai_usage_daily (organisation_id, usage_date, input_tokens, output_tokens, turns) VALUES ($1, $2::date, 90000, 9000, 40)`, [org.orgId, utcDay()]);
    await kit.redis.del(quota.budgetKey(org.orgId, utcDay())); // the Redis counter is gone
    const r = await ask(kit, org.token, await newConversation(kit, org.token), 'What is our fill rate?');
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ code: 'AI_BUDGET_EXHAUSTED' });
    expect(Number(await kit.redis.get(quota.budgetKey(org.orgId, utcDay())))).toBe(99_000);
    expect((await kit.redis.zrange(quota.slotKey(org.orgId), 0, -1))).toEqual([]); // the slot taken before the refusal was released
  });

  it('input bound: over AI_MAX_INPUT_CHARS → 400 AI_INPUT_TOO_LONG; over the absolute DTO cap → 400; whitespace only → 400', async () => {
    const org = await aiOrganisation(kit, 'ai-lim-input');
    const id = await newConversation(kit, org.token);
    const post = (content: string) => kit.http().post(`/rest/v1/ai/conversations/${id}/messages`).set(bearer(org.token)).send({ content });
    expect((await post('x'.repeat(4001))).body).toMatchObject({ statusCode: 400, code: 'AI_INPUT_TOO_LONG', maxChars: 4000 });
    expect((await post('x'.repeat(8001))).status).toBe(400);
    expect((await post('   ')).status).toBe(400);
  });

  it('conversation bound: a conversation at the 200-message limit refuses another question (409 AI_CONVERSATION_FULL)', async () => {
    const org = await aiOrganisation(kit, 'ai-lim-full');
    const id = await newConversation(kit, org.token);
    await kit.owner.query(`UPDATE core.ai_conversation SET message_count = 199 WHERE id = $1`, [id]);
    expect((await ask(kit, org.token, id, 'one more')).body).toMatchObject({ code: 'AI_CONVERSATION_FULL' });
  });

  it('Redis outage: the API refuses new AI work (503 AI_SERVICE_UNAVAILABLE, nothing stored, nothing queued); the Worker refuses to run a queued turn', async () => {
    const org = await aiOrganisation(kit, 'ai-lim-redis');
    const im = await manager(kit, org.orgId, { initial: true });
    const id = await newConversation(kit, org.token);
    const queued = await ask(kit, im.token, await newConversation(kit, im.token), 'What is our fill rate?');
    expect(queued.status).toBe(202);
    kit.redis.disconnect();
    try {
      const r = await ask(kit, org.token, id, 'What is our fill rate?');
      expect(r.status).toBe(503);
      expect(r.body.code).toBe('AI_SERVICE_UNAVAILABLE');
      const [{ n }] = await kit.owner.query(`SELECT count(*)::int AS n FROM core.ai_message WHERE conversation_id = $1`, [id]);
      expect(n).toBe(0);
      expect(await kit.runner.run(jobFor(im.id, (await kit.owner.query(`SELECT conversation_id FROM core.ai_message WHERE id = $1`, [queued.turnId]))[0].conversation_id, queued.turnId))).toBe('failed');
      expect(await turnRow(kit, queued.turnId)).toMatchObject({ status: 'failed', error_code: 'AI_SERVICE_UNAVAILABLE' });
    } finally {
      await kit.redis.connect().catch(() => undefined);
    }
    const back = await ask(kit, org.token, id, 'What is our fill rate?');
    expect(back.status).toBe(202);
  });
});
