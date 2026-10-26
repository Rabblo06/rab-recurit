import './helpers/ai-env';

import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';

import { AI_QUEUE_NAME, AiTurnJobData } from '../../engine/worker-shared/ai-queue.constants';
import { AiQuotaService, utcDay } from '../../modules/ai/services/ai-quota.service';
import { AiStreamService } from '../../modules/ai/services/ai-stream.service';
import { AiToolRegistry } from '../../modules/ai/tools/ai-tool-registry.service';
import { seedStaffing } from './helpers/ai-fixtures';
import { countingDeterministicModel, failingModel, hangingModel, scriptedModel, textParts, toolCallParts, usage } from './helpers/ai-models';
import { AiKit, aiOrganisation, ask, bearer, bootAiKit, jobFor, newConversation, readSse, turnRow } from './helpers/ai-test-kit';

/**
 * AI Phase 1 — the full turn: API → `rab-ai` BullMQ queue (real Redis) → Worker step loop → tool (real data under RLS)
 * → model (deterministic) → Redis stream → SSE; plus the reliability cases of brief §15: duplicate delivery, Worker
 * restart (lease expiry), cancellation (queued and running), timeout, provider outage, per-turn token ceiling, step
 * limit, SSE reconnect without re-running the model, idempotent persistence and usage/budget reconciliation.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('AI turn: queue → worker → tools → model → SSE (integration)', () => {
  jest.setTimeout(240_000);
  let kit: AiKit;
  let org: Awaited<ReturnType<typeof aiOrganisation>>;
  let quota: AiQuotaService;
  let streams: AiStreamService;

  beforeAll(async () => {
    kit = await bootAiKit();
    quota = kit.moduleRef.get(AiQuotaService);
    streams = kit.moduleRef.get(AiStreamService);
    org = await aiOrganisation(kit, 'ai-turn');
    await seedStaffing(kit, org.ceo);
  });
  afterEach(() => kit.setModel(null));
  afterAll(async () => {
    await kit?.close();
  });

  const run = (conversationId: string, turnId: string) => kit.runner.run(jobFor(org.ceo, conversationId, turnId));
  const budgetUse = async () => Number((await kit.redis.get(quota.budgetKey(org.orgId, utcDay()))) ?? 0);
  const slots = () => kit.redis.zrange(quota.slotKey(org.orgId), 0, -1);

  it('end to end over the REAL rab-ai queue: question → Worker → list_unfilled_shifts → streamed answer → persisted, audited, reconciled', async () => {
    const connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    const queue = new Queue<AiTurnJobData>(AI_QUEUE_NAME, { connection });
    await queue.obliterate({ force: true });
    const started = Date.now();
    const timings: Record<string, number> = {};
    const worker = new Worker<AiTurnJobData>(AI_QUEUE_NAME, async (job) => {
      timings.queueWaitMs = Date.now() - job.timestamp;
      const t0 = Date.now();
      const outcome = await kit.runner.run(job.data);
      timings.workerMs = Date.now() - t0;
      return outcome;
    }, { connection, concurrency: 4 });
    try {
      const before = await budgetUse();
      const conversationId = await newConversation(kit, org.token);
      const turn = await ask(kit, org.token, conversationId, 'Which shifts still need staff?');
      timings.submitMs = Date.now() - started;
      expect(turn.status).toBe(202);
      expect(turn.body).toMatchObject({ status: 'queued', replayed: false });
      const job = await queue.getJob(`ai-turn.${turn.turnId}`);
      expect(Object.keys(job!.data).sort()).toEqual(['conversationId', 'kind', 'organisationId', 'turnId', 'userId', 'v', 'workspaceId']); // IDs only (+ v2 kind)
      expect(turn.body).toMatchObject({ messageId: turn.body.userMessageId, streamId: turn.turnId }); // T2-1

      const sse = await readSse(kit, org.token, conversationId, turn.turnId);
      timings.endToEndMs = Date.now() - started;
      expect(sse.status).toBe(200);
      const types = sse.events.map((e) => e.data.type);
      expect(types[0]).toBe('status');
      expect(types).toContain('tool');
      expect(types).toContain('delta');
      expect(types[types.length - 1]).toBe('done');
      const done = sse.events[sse.events.length - 1]!.data;
      expect(done).toMatchObject({ status: 'completed', errorCode: null });
      expect(String(done.content)).toMatch(/2 shift\(s\) still need staff/);
      expect(sse.events.filter((e) => e.data.type === 'tool').map((e) => e.data.name)).toEqual(['list_unfilled_shifts', 'list_unfilled_shifts']);

      const row = await turnRow(kit, turn.turnId);
      expect(row).toMatchObject({ status: 'completed', error_code: null, tool_calls: [{ name: 'list_unfilled_shifts', outcome: 'ok', rows: 2 }] });
      expect(row.content).toBe(done.content);
      const tokens = Number(row.input_tokens) + Number(row.output_tokens);
      expect(tokens).toBeGreaterThan(0);
      // Reservation reconciled to the real usage, slot released.
      expect((await budgetUse()) - before).toBe(tokens);
      expect(await slots()).not.toContain(conversationId);
      const [usageRow] = await kit.owner.query(`SELECT turns, tool_calls, input_tokens, output_tokens FROM core.ai_usage_daily WHERE organisation_id = $1 AND usage_date = $2::date`, [org.orgId, utcDay()]);
      expect(Number(usageRow.turns)).toBeGreaterThanOrEqual(1);
      const audit = await kit.owner.query(`SELECT action, metadata FROM core.audit_log WHERE entity_id = $1 ORDER BY created_at`, [turn.turnId]);
      expect(audit.map((a: { action: string }) => a.action)).toEqual(['ai.turn_started', 'ai.tool_called', 'ai.turn_completed']);
      expect(JSON.stringify(audit)).not.toMatch(/still need staff|Which shifts/); // metadata only, never content
      // eslint-disable-next-line no-console
      console.log(`[ai-measure] e2e ${JSON.stringify({ ...timings, tokens, inputTokens: row.input_tokens, outputTokens: row.output_tokens })}`);
    } finally {
      await worker.close();
      await queue.close();
      await connection.quit();
    }
  });

  it('duplicate delivery: the second run of the same job is skipped; one answer, one usage increment', async () => {
    const conversationId = await newConversation(kit, org.token);
    const turn = await ask(kit, org.token, conversationId, 'How many offers are awaiting replies?');
    expect(await run(conversationId, turn.turnId)).toBe('completed');
    const [{ turns: t1 }] = await kit.owner.query(`SELECT turns FROM core.ai_usage_daily WHERE organisation_id = $1 AND usage_date = $2::date`, [org.orgId, utcDay()]);
    expect(await run(conversationId, turn.turnId)).toBe('skipped');
    const [{ turns: t2 }] = await kit.owner.query(`SELECT turns FROM core.ai_usage_daily WHERE organisation_id = $1 AND usage_date = $2::date`, [org.orgId, utcDay()]);
    expect(t2).toBe(t1);
    const answers = await kit.owner.query(`SELECT count(*)::int AS n FROM core.ai_message WHERE conversation_id = $1 AND role = 'assistant'`, [conversationId]);
    expect(answers[0].n).toBe(1);
  });

  it('idempotent submit: the same clientRequestId returns the same turn (replayed), never a second question', async () => {
    const conversationId = await newConversation(kit, org.token);
    const body = { content: 'What is our fill rate?', clientRequestId: crypto.randomUUID() };
    const first = await kit.http().post(`/rest/v1/ai/conversations/${conversationId}/messages`).set(bearer(org.token)).send(body);
    const second = await kit.http().post(`/rest/v1/ai/conversations/${conversationId}/messages`).set(bearer(org.token)).send(body);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body).toMatchObject({ turnId: first.body.turnId, replayed: true });
    // A different question while one is in flight is a 409, not a parallel turn.
    const third = await kit.http().post(`/rest/v1/ai/conversations/${conversationId}/messages`).set(bearer(org.token)).send({ content: 'And attendance?', clientRequestId: crypto.randomUUID() });
    expect(third.status).toBe(409);
    expect(third.body.code).toBe('AI_TURN_IN_PROGRESS');
    await run(conversationId, first.body.turnId);
  });

  it('Worker restart: a turn left running with an expired lease ends AI_WORKER_INTERRUPTED; the model is not called again', async () => {
    const counting = countingDeterministicModel();
    kit.setModel(counting.model);
    const conversationId = await newConversation(kit, org.token);
    const turn = await ask(kit, org.token, conversationId, 'What is our fill rate?');
    await kit.owner.query(`UPDATE core.ai_message SET status = 'running', lease_token = gen_random_uuid(), lease_expires_at = now() - interval '1 minute', started_at = now() WHERE id = $1`, [turn.turnId]);
    expect(await run(conversationId, turn.turnId)).toBe('failed');
    expect(await turnRow(kit, turn.turnId)).toMatchObject({ status: 'failed', error_code: 'AI_WORKER_INTERRUPTED' });
    expect(counting.calls.n).toBe(0);
    expect(await slots()).not.toContain(conversationId);
  });

  it('a running turn with a LIVE lease is never run twice (concurrent duplicate delivery)', async () => {
    const conversationId = await newConversation(kit, org.token);
    const turn = await ask(kit, org.token, conversationId, 'What is our fill rate?');
    await kit.owner.query(`UPDATE core.ai_message SET status = 'running', lease_token = gen_random_uuid(), lease_expires_at = now() + interval '1 minute' WHERE id = $1`, [turn.turnId]);
    expect(await run(conversationId, turn.turnId)).toBe('skipped');
    expect((await turnRow(kit, turn.turnId)).status).toBe('running');
    await kit.owner.query(`UPDATE core.ai_message SET status = 'failed', lease_token = NULL, lease_expires_at = NULL, error_code = 'AI_INTERNAL_ERROR' WHERE id = $1`, [turn.turnId]);
  });

  it('cancel while QUEUED: cancelled at once, reservation refunded, slot freed; the Worker then skips it', async () => {
    const before = await budgetUse();
    const conversationId = await newConversation(kit, org.token);
    const turn = await ask(kit, org.token, conversationId, 'What is our fill rate?');
    expect((await budgetUse()) - before).toBeGreaterThan(0);
    const res = await kit.http().post(`/rest/v1/ai/conversations/${conversationId}/turns/${turn.turnId}/cancel`).set(bearer(org.token));
    expect(res.body).toEqual({ turnId: turn.turnId, status: 'cancelled' });
    expect(await budgetUse()).toBe(before);
    expect(await slots()).not.toContain(conversationId);
    expect(await run(conversationId, turn.turnId)).toBe('skipped');
    const again = await kit.http().post(`/rest/v1/ai/conversations/${conversationId}/turns/${turn.turnId}/cancel`).set(bearer(org.token));
    expect(again.body.status).toBe('cancelled'); // idempotent
  });

  it('cancel while RUNNING: the model stream is aborted, the partial answer is kept, the turn ends cancelled', async () => {
    const hanging = hangingModel('Partial answer ');
    kit.setModel(hanging.model);
    const conversationId = await newConversation(kit, org.token);
    const turn = await ask(kit, org.token, conversationId, 'Tell me something');
    const pending = run(conversationId, turn.turnId);
    for (let i = 0; i < 50 && (await turnRow(kit, turn.turnId)).status !== 'running'; i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 300));
    const res = await kit.http().post(`/rest/v1/ai/conversations/${conversationId}/turns/${turn.turnId}/cancel`).set(bearer(org.token));
    expect(res.body.status).toBe('cancelling');
    expect(await pending).toBe('cancelled');
    expect(await turnRow(kit, turn.turnId)).toMatchObject({ status: 'cancelled', error_code: null, content: 'Partial answer ' });
  });

  it('timeout: a model that never finishes is aborted at AI_TURN_TIMEOUT_SECONDS and ends AI_MODEL_TIMEOUT', async () => {
    kit.setModel(hangingModel().model);
    const conversationId = await newConversation(kit, org.token);
    const turn = await ask(kit, org.token, conversationId, 'Tell me something');
    const t0 = Date.now();
    expect(await run(conversationId, turn.turnId)).toBe('failed');
    const elapsed = Date.now() - t0;
    expect(await turnRow(kit, turn.turnId)).toMatchObject({ status: 'failed', error_code: 'AI_MODEL_TIMEOUT' });
    expect(elapsed).toBeGreaterThanOrEqual(Number(process.env.AI_TURN_TIMEOUT_SECONDS) * 1000 - 500);
  });

  it('provider outage: the turn fails AI_MODEL_ERROR, nothing is charged beyond actual usage (0), the error text never reaches the client', async () => {
    const before = await budgetUse();
    const failing = failingModel();
    kit.setModel(failing.model);
    const conversationId = await newConversation(kit, org.token);
    const turn = await ask(kit, org.token, conversationId, 'What is our fill rate?');
    expect(await run(conversationId, turn.turnId)).toBe('failed');
    expect(await turnRow(kit, turn.turnId)).toMatchObject({ status: 'failed', error_code: 'AI_MODEL_ERROR' });
    expect(await budgetUse()).toBe(before);
    const got = await kit.http().get(`/rest/v1/ai/conversations/${conversationId}`).set(bearer(org.token));
    expect(JSON.stringify(got.body)).not.toMatch(/provider unavailable|503/);
  });

  it('per-turn token ceiling: a step reporting usage above the reservation stops the turn (AI_TURN_TOKEN_LIMIT)', async () => {
    // Its own organisation: the reported 900 000 tokens ARE charged (actual usage beyond the reservation is never forgiven),
    // which exhausts that organisation's day — the next question there is refused.
    const own = await aiOrganisation(kit, 'ai-turn-ceiling');
    kit.setModel(scriptedModel([toolCallParts('execute_tool', { name: 'get_fill_rate', args: { from: '2026-10-01', to: '2026-10-07' } }, usage(900_000, 10)), textParts('done')]).model);
    const conversationId = await newConversation(kit, own.token);
    const turn = await ask(kit, own.token, conversationId, 'What is our fill rate?');
    expect(await kit.runner.run(jobFor(own.ceo, conversationId, turn.turnId))).toBe('failed');
    expect(await turnRow(kit, turn.turnId)).toMatchObject({ status: 'failed', error_code: 'AI_TURN_TOKEN_LIMIT' });
    const next = await ask(kit, own.token, await newConversation(kit, own.token), 'And now?');
    expect(next.status).toBe(429);
    expect(next.body.code).toBe('AI_BUDGET_EXHAUSTED');
  });

  it('3w: the permission fingerprint re-check rides THE 2 s heartbeat (X-10) — revoking a catalogued flag mid-turn stops it', async () => {
    const own = await aiOrganisation(kit, 'ai-turn-3w-recheck');
    const hanging = hangingModel();
    kit.setModel(hanging.model);
    const registry = kit.moduleRef.get(AiToolRegistry);
    const rechecks: number[] = [];
    const original = registry.forTurn.bind(registry);
    const spy = jest.spyOn(registry, 'forTurn').mockImplementation(async (r, c) => {
      const binding = await original(r, c);
      return { ...binding, recheck: async () => (rechecks.push(Date.now()), binding.recheck()) };
    });
    const ticks: string[] = [];
    const stopObserving = kit.runner.observeHeartbeats((turnId, heartbeat) => heartbeat.onTick(() => void ticks.push(turnId)));
    try {
      const conversationId = await newConversation(kit, own.token);
      const turn = await ask(kit, own.token, conversationId, 'What is our fill rate?');
      const running = kit.runner.run(jobFor(own.ceo, conversationId, turn.turnId));
      for (let i = 0; i < 100 && hanging.seen.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
      // The system prompt carries the catalogue; the SDK set is only the meta tools.
      const system = hanging.seen[0]!.prompt.find((m) => m.role === 'system')!.content as string;
      expect(system).toContain('- compare_payroll_runs: ');
      expect((hanging.seen[0]!.tools ?? []).map((t) => t.name)).toEqual(['execute_tool', 'learn_tools', 'update_plan']);
      await kit.owner.query(
        `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect) SELECT $1, id, $2, 'revoke' FROM core.permission WHERE key = 'payroll.view'`,
        [own.ceo.userId, own.orgId],
      );
      const revokedAt = Date.now();
      expect(await running).toBe('failed');
      expect(await turnRow(kit, turn.turnId)).toMatchObject({ status: 'failed', error_code: 'AI_ACCESS_REVOKED' });
      expect(Date.now() - revokedAt).toBeLessThan(6_000);
      // The re-check ran on the heartbeat's ticks (one recheck per tick, same timer), never on a timer of its own.
      expect(rechecks.length).toBeGreaterThan(0);
      expect(rechecks.length).toBeLessThanOrEqual(ticks.filter((t) => t === turn.turnId).length + 1);
    } finally {
      stopObserving();
      spy.mockRestore();
      await kit.owner.query(`DELETE FROM core.user_permission_override WHERE user_id = $1`, [own.ceo.userId]);
    }
  });

  it('step limit: a model that keeps calling tools is stopped after AI_MAX_STEPS (8) model calls', async () => {
    const looping = scriptedModel([toolCallParts('execute_tool', { name: 'get_fill_rate', args: { from: '2026-10-01', to: '2026-10-07' } })]);
    kit.setModel(looping.model);
    const conversationId = await newConversation(kit, org.token);
    const turn = await ask(kit, org.token, conversationId, 'What is our fill rate?');
    await run(conversationId, turn.turnId);
    expect(looping.seen.length).toBe(8);
    const row = await turnRow(kit, turn.turnId);
    expect(row.status).toBe('failed'); // no answer text was produced
    expect((row.tool_calls as unknown[]).length).toBe(8);
  });

  it('SSE reconnect resumes after Last-Event-ID and, once the stream has expired, replays the PERSISTED answer — never the model', async () => {
    const counting = countingDeterministicModel();
    kit.setModel(counting.model);
    const conversationId = await newConversation(kit, org.token);
    const turn = await ask(kit, org.token, conversationId, 'How many offers are awaiting replies?');
    expect(await run(conversationId, turn.turnId)).toBe('completed');
    const callsAfterRun = counting.calls.n;
    const full = await readSse(kit, org.token, conversationId, turn.turnId);
    const firstDelta = full.events.find((e) => e.data.type === 'delta')!;
    const resumed = await readSse(kit, org.token, conversationId, turn.turnId, firstDelta.id);
    expect(resumed.events.length).toBeLessThan(full.events.length);
    expect(resumed.events.every((e) => !e.id || e.id > firstDelta.id!)).toBe(true);
    expect(resumed.events[resumed.events.length - 1]!.data.type).toBe('done');
    await kit.redis.del(streams.stream(conversationId, turn.turnId)); // the 15-minute stream TTL has passed
    const late = await readSse(kit, org.token, conversationId, turn.turnId);
    expect(late.events.map((e) => e.data.type)).toEqual(['done']);
    expect(late.events[0]!.data).toMatchObject({ status: 'completed', content: (await turnRow(kit, turn.turnId)).content });
    expect(counting.calls.n).toBe(callsAfterRun);
  });

  it('deleting a conversation with a queued turn refunds its reservation and removes its messages (cascade)', async () => {
    const before = await budgetUse();
    const conversationId = await newConversation(kit, org.token);
    const turn = await ask(kit, org.token, conversationId, 'What is our fill rate?');
    expect((await kit.http().delete(`/rest/v1/ai/conversations/${conversationId}`).set(bearer(org.token))).status).toBe(204);
    expect(await budgetUse()).toBe(before);
    expect((await kit.owner.query(`SELECT count(*)::int AS n FROM core.ai_message WHERE conversation_id = $1`, [conversationId]))[0].n).toBe(0);
    expect(await run(conversationId, turn.turnId)).toBe('skipped');
    const audit = await kit.owner.query(`SELECT action FROM core.audit_log WHERE entity_id = $1`, [conversationId]);
    expect(audit.map((a: { action: string }) => a.action)).toContain('ai.conversation_deleted');
  });
});
