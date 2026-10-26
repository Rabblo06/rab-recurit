import './helpers/ai-env';

import { randomUUID } from 'node:crypto';

import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';

import { AI_QUEUE_NAME, aiTurnDeferredJobId, aiTurnPromotedJobId } from '../../engine/worker-shared/ai-queue.constants';
import { AiQuotaService, utcDay } from '../../modules/ai/services/ai-quota.service';
import { AiRedisSubscriberProvider } from '../../modules/ai/services/ai-redis-subscriber.provider';
import { AiStreamService, cancelPayload } from '../../modules/ai/services/ai-stream.service';
import { AiTurnQueueService } from '../../modules/ai/services/ai-turn-queue.service';
import { countingDeterministicModel, hangingModel, scriptedModel, textParts } from './helpers/ai-models';
import { AiKit, aiOrganisation, ask, bearer, bootAiKit, jobFor, newConversation, turnRow } from './helpers/ai-test-kit';

/**
 * AI Phase 2 — queued second message, deferring claim, promotion, 2 s checkpoints and the cancel channel
 * (docs/ai/PHASE2_TWENTY_PLAN.md §2.1–§2.3; tests T2-1, T2-2, T2-3, T2-6, T2-10, T2-16). Real PostgreSQL (crewflow_app,
 * FORCE RLS) and real Redis; scripted / hanging models only.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const CANARY = 'CANARY-P2-7f3c1e-question-text';

describeIfDb('AI Phase 2: queued turns, checkpoints, cancel channel (integration)', () => {
  jest.setTimeout(240_000);
  let kit: AiKit;
  let org: Awaited<ReturnType<typeof aiOrganisation>>;
  let quota: AiQuotaService;
  let streams: AiStreamService;
  let queueService: AiTurnQueueService;
  let jobs: Queue;
  let connection: Redis;

  beforeAll(async () => {
    kit = await bootAiKit();
    quota = kit.moduleRef.get(AiQuotaService);
    streams = kit.moduleRef.get(AiStreamService);
    queueService = kit.moduleRef.get(AiTurnQueueService);
    connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    jobs = new Queue(AI_QUEUE_NAME, { connection });
  });
  // A fresh organisation per test: fake-running turns keep their reservations, so one org would exhaust its day.
  let n = 0;
  beforeEach(async () => {
    org = await aiOrganisation(kit, `ai-p2-queue-${++n}`);
  });
  afterEach(() => {
    kit.setModel(null);
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await jobs?.close();
    await connection?.quit();
    await kit?.close();
  });

  const run = (conversationId: string, turnId: string) => kit.runner.run(jobFor(org.ceo, conversationId, turnId));
  const until = async (fn: () => boolean | Promise<boolean>, ms = 15_000, step = 25) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, step));
    }
    throw new Error('condition not met in time');
  };
  const running = (turnId: string) => until(async () => (await turnRow(kit, turnId)).status === 'running');
  const slots = () => kit.redis.zrange(quota.slotKey(org.orgId), 0, -1);
  const budgetUse = async () => Number((await kit.redis.get(quota.budgetKey(org.orgId, utcDay()))) ?? 0);
  /** A turn left "running" under a live lease nobody holds (a predecessor without a model call). */
  const fakeRunning = (turnId: string) =>
    kit.owner.query(`UPDATE core.ai_message SET status = 'running', lease_token = gen_random_uuid(), lease_expires_at = now() + interval '5 minutes', started_at = now() WHERE id = $1`, [turnId]);
  const endFake = (turnId: string) =>
    kit.owner.query(`UPDATE core.ai_message SET status = 'failed', error_code = 'AI_INTERNAL_ERROR', lease_token = NULL, lease_expires_at = NULL, completed_at = now() WHERE id = $1 AND status = 'running'`, [turnId]);

  it('T2-1/T2-2: a second question while one RUNS is queued (202, messageId/streamId), runs only after it, in order; a third is 409; the successor is promoted', async () => {
    const words = Array.from({ length: 12 }, (_, i) => `word${i}`).join(' ');
    const slow = scriptedModel([textParts(words)], { chunkDelayInMs: 150 });
    kit.setModel(slow.model);
    const conversationId = await newConversation(kit, org.token);
    const first = await ask(kit, org.token, conversationId, 'First question');
    const p1 = run(conversationId, first.turnId);
    await running(first.turnId);

    const second = await ask(kit, org.token, conversationId, 'Second question');
    expect(second.status).toBe(202);
    expect(second.body).toMatchObject({ status: 'queued', replayed: false, messageId: second.body.userMessageId, streamId: second.turnId, turnId: second.turnId });
    const third = await ask(kit, org.token, conversationId, 'Third question');
    expect(third.status).toBe(409);
    expect(third.body.code).toBe('AI_TURN_IN_PROGRESS');
    // ONE slot for the conversation (P2-D10), held by running + queued together.
    expect((await slots()).filter((s) => s === conversationId)).toHaveLength(1);

    // Delivered early: the successor defers (row unchanged, a delayed job w<n>).
    expect(await run(conversationId, second.turnId)).toBe('deferred');
    expect((await turnRow(kit, second.turnId)).status).toBe('queued');
    const deferred = (await jobs.getDelayed()).find((j) => j.id?.startsWith(`ai-turn.${second.turnId}.w`));
    expect(deferred).toBeTruthy();
    expect([aiTurnDeferredJobId(second.turnId, 0), aiTurnDeferredJobId(second.turnId, 1)]).toContain(deferred!.id);
    expect(Number(deferred!.opts.delay)).toBeGreaterThanOrEqual(1000);
    expect(Object.keys(deferred!.data).sort()).toEqual(['conversationId', 'kind', 'organisationId', 'turnId', 'userId', 'v', 'workspaceId']);

    expect(await p1).toBe('completed');
    // Promotion at finalise (deterministic id, deduplicated).
    expect(await jobs.getJob(aiTurnPromotedJobId(second.turnId))).toBeTruthy();
    expect(await run(conversationId, second.turnId)).toBe('completed');
    // The successor saw the first question AND its completed answer, then its own question (seq order).
    const prompt = JSON.stringify(slow.seen[slow.seen.length - 1]!.prompt);
    expect(prompt.indexOf('First question')).toBeLessThan(prompt.indexOf('word0'));
    expect(prompt.indexOf('word0')).toBeLessThan(prompt.indexOf('Second question'));
    const seqs = await kit.owner.query(`SELECT seq, role FROM core.ai_message WHERE conversation_id = $1 ORDER BY seq`, [conversationId]);
    expect(seqs.map((r: { role: string }) => r.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(await slots()).not.toContain(conversationId);
  });

  it('T2-2: a concurrent double POST behind a running turn → exactly one queued and one 409 (the database index decides)', async () => {
    const conversationId = await newConversation(kit, org.token);
    const first = await ask(kit, org.token, conversationId, 'Question A');
    await fakeRunning(first.turnId);
    try {
      const both = await Promise.all([ask(kit, org.token, conversationId, 'Question B'), ask(kit, org.token, conversationId, 'Question C')]);
      expect(both.map((r) => r.status).sort()).toEqual([202, 409]);
      expect(both.find((r) => r.status === 409)!.body.code).toBe('AI_TURN_IN_PROGRESS');
      const [{ n }] = await kit.owner.query(`SELECT count(*)::int AS n FROM core.ai_message WHERE conversation_id = $1 AND role = 'assistant' AND status = 'queued'`, [conversationId]);
      expect(n).toBe(1);
    } finally {
      await endFake(first.turnId);
    }
  });

  it('T2-3: with promotion suppressed the deferral alone runs the successor (real rab-ai queue + Worker loop)', async () => {
    kit.setModel(scriptedModel([textParts('Answer one two three')], { chunkDelayInMs: 100 }).model);
    const original = queueService.enqueueTurn.bind(queueService);
    jest.spyOn(queueService, 'enqueueTurn').mockImplementation(async (ids, opts = {}) => {
      if (opts.jobId?.endsWith('.next')) return; // promotion lost
      return original(ids, opts);
    });
    await jobs.obliterate({ force: true });
    const worker = new Worker(AI_QUEUE_NAME, async (job) => (job.name === 'ai-turn' ? kit.runner.run(job.data) : 'ignored'), { connection: connection.duplicate(), concurrency: 4 });
    try {
      const conversationId = await newConversation(kit, org.token);
      const first = await ask(kit, org.token, conversationId, 'Deferral first');
      await running(first.turnId);
      const second = await ask(kit, org.token, conversationId, 'Deferral second');
      expect(second.status).toBe(202);
      await until(async () => (await turnRow(kit, second.turnId)).status === 'completed', 30_000, 100);
      expect((await turnRow(kit, first.turnId)).status).toBe('completed');
      expect(await jobs.getJob(aiTurnPromotedJobId(second.turnId))).toBeFalsy();
    } finally {
      await worker.close();
    }
  });

  it('T2-3: past the wait cap (turn timeout + 60 s) a deferred successor fails AI_SERVICE_UNAVAILABLE and is refunded; no model call', async () => {
    const counting = countingDeterministicModel();
    kit.setModel(counting.model);
    const conversationId = await newConversation(kit, org.token);
    const first = await ask(kit, org.token, conversationId, 'Cap first');
    await fakeRunning(first.turnId);
    try {
      const before = await budgetUse();
      const second = await ask(kit, org.token, conversationId, 'Cap second');
      expect((await budgetUse()) - before).toBeGreaterThan(0);
      await kit.owner.query(`UPDATE core.ai_message SET created_at = now() - interval '200 seconds' WHERE id = $1`, [second.turnId]);
      expect(await run(conversationId, second.turnId)).toBe('failed');
      expect(await turnRow(kit, second.turnId)).toMatchObject({ status: 'failed', error_code: 'AI_SERVICE_UNAVAILABLE' });
      expect(counting.calls.n).toBe(0);
      expect(await budgetUse()).toBe(before);
    } finally {
      await endFake(first.turnId);
    }
  });

  it('T2-6: checkpoints — the persisted content grows about every 2 s while running, under the lease', async () => {
    const words = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ');
    kit.setModel(scriptedModel([textParts(words)], { chunkDelayInMs: 200 }).model);
    const conversationId = await newConversation(kit, org.token);
    const turn = await ask(kit, org.token, conversationId, 'Checkpoint please');
    const pending = run(conversationId, turn.turnId);
    await running(turn.turnId);
    const seen: Array<{ at: number; len: number }> = [];
    while ((await turnRow(kit, turn.turnId)).status === 'running') {
      const [row] = await kit.owner.query(`SELECT length(content)::int AS len, checkpointed_at FROM core.ai_message WHERE id = $1`, [turn.turnId]);
      if (row.len > 0 && (seen.length === 0 || seen[seen.length - 1]!.len !== row.len)) seen.push({ at: Date.now(), len: row.len });
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(await pending).toBe('completed');
    expect(seen.length).toBeGreaterThanOrEqual(2); // ≥ 2 checkpoints before the terminal write
    for (let i = 1; i < seen.length; i++) expect(seen[i]!.len).toBeGreaterThan(seen[i - 1]!.len);
    const gaps = seen.slice(1).map((s, i) => s.at - seen[i]!.at);
    for (const g of gaps.slice(0, -1)) expect(g).toBeGreaterThanOrEqual(1_500);
    const [{ checkpointed }] = await kit.owner.query(`SELECT checkpointed_at IS NOT NULL AS checkpointed FROM core.ai_message WHERE id = $1`, [turn.turnId]);
    expect(checkpointed).toBe(true);
  });

  it('T2-6: a dead Worker (lease lost) never writes again; the redelivery ends AI_WORKER_INTERRUPTED with the last checkpoint kept — no second model call', async () => {
    const hanging = hangingModel('Partial checkpointed text ');
    kit.setModel(hanging.model);
    const conversationId = await newConversation(kit, org.token);
    const turn = await ask(kit, org.token, conversationId, 'Kill me');
    const pending = run(conversationId, turn.turnId);
    await until(async () => String((await turnRow(kit, turn.turnId)).content).length > 0, 10_000, 100);
    // The lease is taken away (another Worker's token, already expired): the in-process loop must stop at its next tick.
    await kit.owner.query(`UPDATE core.ai_message SET lease_token = gen_random_uuid(), lease_expires_at = now() - interval '1 minute' WHERE id = $1`, [turn.turnId]);
    const t0 = Date.now();
    const outcome = await pending;
    expect(outcome).toBe('skipped'); // lease_lost → aborted, the terminal CAS lost (nothing written by the dead loop)
    expect(Date.now() - t0).toBeLessThan(4_000);
    expect(await run(conversationId, turn.turnId)).toBe('failed');
    expect(await turnRow(kit, turn.turnId)).toMatchObject({ status: 'failed', error_code: 'AI_WORKER_INTERRUPTED', content: 'Partial checkpointed text ' });
    expect(hanging.seen).toHaveLength(1);
    expect(await kit.redis.zrange(quota.slotKey(org.orgId), 0, -1)).not.toContain(conversationId);
  });

  it('T2-10: a channel-only cancel aborts the running turn fast (durable request in the DB, no Redis flag)', async () => {
    kit.setModel(hangingModel().model);
    const conversationId = await newConversation(kit, org.token);
    const turn = await ask(kit, org.token, conversationId, 'Cancel by channel');
    const pending = run(conversationId, turn.turnId);
    await running(turn.turnId);
    await new Promise((r) => setTimeout(r, 300)); // the cancel subscription is in place
    await kit.owner.query(`UPDATE core.ai_message SET cancel_requested_at = now() WHERE id = $1`, [turn.turnId]);
    const t0 = Date.now();
    await kit.redis.publish(streams.cancel(conversationId), cancelPayload(turn.turnId));
    expect(await pending).toBe('cancelled');
    const elapsed = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`[ai-measure] channel cancel ${elapsed} ms`);
    expect(elapsed).toBeLessThan(400); // the flag poll (500 ms) and lease renewal (15 s) are both slower
  });

  it('T2-10: a flag-only cancel (subscriber connection down) still aborts within ~1 s', async () => {
    const subscriber = kit.moduleRef.get(AiRedisSubscriberProvider);
    // "Down": no subscription is ever established, so no hint can arrive; the flag poll is the only fast path left.
    jest.spyOn(subscriber, 'subscribe').mockResolvedValue(() => undefined);
    {
      kit.setModel(hangingModel().model);
      const conversationId = await newConversation(kit, org.token);
      const turn = await ask(kit, org.token, conversationId, 'Cancel by flag');
      const pending = run(conversationId, turn.turnId);
      await running(turn.turnId);
      const t0 = Date.now();
      await kit.redis.set(streams.cancelFlag(conversationId, turn.turnId), '1', 'EX', 60);
      expect(await pending).toBe('cancelled');
      expect(Date.now() - t0).toBeLessThan(1_200);
    }
  });

  it('T2-10: a cancel hint naming a foreign or unknown turn — or this turn without a durable request — has no effect', async () => {
    const other = await aiOrganisation(kit, 'ai-p2-foreign');
    const otherConversation = await newConversation(kit, other.token);
    const otherTurn = await ask(kit, other.token, otherConversation, 'Other org question');
    kit.setModel(hangingModel().model);
    const conversationId = await newConversation(kit, org.token);
    const turn = await ask(kit, org.token, conversationId, 'Do not cancel me');
    const pending = run(conversationId, turn.turnId);
    await running(turn.turnId);
    await new Promise((r) => setTimeout(r, 300));
    await kit.redis.publish(streams.cancel(conversationId), cancelPayload(randomUUID())); // unknown turn
    await kit.redis.publish(streams.cancel(conversationId), cancelPayload(otherTurn.turnId)); // foreign turn
    await kit.redis.publish(streams.cancel(conversationId), cancelPayload(turn.turnId)); // forged: no flag, no DB request
    await kit.redis.publish(streams.cancel(conversationId), JSON.stringify({ t: turn.turnId, x: 'extra' })); // malformed
    await new Promise((r) => setTimeout(r, 1_200));
    expect((await turnRow(kit, turn.turnId)).status).toBe('running');
    const res = await kit.http().post(`/rest/v1/ai/conversations/${conversationId}/turns/${turn.turnId}/cancel`).set(bearer(org.token));
    expect(res.body.status).toBe('cancelling');
    expect(await pending).toBe('cancelled');
    expect((await turnRow(kit, otherTurn.turnId)).status).toBe('queued');
  });

  it('T2-10 / P2-D7: Stop on the running turn cancels the queued successor too (refunded); the slot is freed once both are done', async () => {
    kit.setModel(hangingModel().model);
    const conversationId = await newConversation(kit, org.token);
    const first = await ask(kit, org.token, conversationId, 'Stop first');
    const pending = run(conversationId, first.turnId);
    await running(first.turnId);
    const before = await budgetUse();
    const second = await ask(kit, org.token, conversationId, 'Stop second');
    expect(second.status).toBe(202);
    const reserved = (await budgetUse()) - before;
    expect(reserved).toBeGreaterThan(0);
    const res = await kit.http().post(`/rest/v1/ai/conversations/${conversationId}/turns/${first.turnId}/cancel`).set(bearer(org.token));
    expect(res.body.status).toBe('cancelling');
    expect((await turnRow(kit, second.turnId)).status).toBe('cancelled');
    expect(await pending).toBe('cancelled');
    expect(await run(conversationId, second.turnId)).toBe('skipped');
    expect(await slots()).not.toContain(conversationId);
    const audit = await kit.owner.query(`SELECT metadata->>'stage' AS stage FROM core.audit_log WHERE entity_id = $1 AND action = 'ai.turn_cancelled'`, [second.turnId]);
    expect(audit.map((a: { stage: string }) => a.stage)).toEqual(['queued_successor']);
  });

  it('T2-16 privacy: the question/answer text never appears in job data, pub/sub hints, audit metadata or slot/flag keys; the stream key has a TTL', async () => {
    const hints: string[] = [];
    const listener = connection.duplicate();
    await listener.psubscribe('crewflow:test:ai:conv:*');
    listener.on('pmessage', (_p, channel, message) => hints.push(`${channel} ${message}`));
    try {
      kit.setModel(scriptedModel([textParts(`Answer about ${CANARY} done`)]).model);
      const conversationId = await newConversation(kit, org.token);
      const turn = await ask(kit, org.token, conversationId, `Question about ${CANARY}?`);
      expect(await run(conversationId, turn.turnId)).toBe('completed');
      await new Promise((r) => setTimeout(r, 200));
      expect(hints.length).toBeGreaterThan(0);
      expect(hints.join('\n')).not.toContain(CANARY);
      for (const h of hints) expect(h.split(' ')[1]).toMatch(/^\{"t":"[0-9a-f-]{36}"(,"id":"\d+-\d+")?\}$/);
      const job = await jobs.getJob(`ai-turn.${turn.turnId}`);
      expect(JSON.stringify(job?.data ?? {})).not.toContain(CANARY);
      const audit = await kit.owner.query(`SELECT metadata FROM core.audit_log WHERE organisation_id = $1`, [org.orgId]);
      expect(JSON.stringify(audit)).not.toContain(CANARY);
      const key = streams.stream(conversationId, turn.turnId);
      expect(key).toBe(`crewflow:test:ai:conv:${conversationId}:turn:${turn.turnId}:stream`);
      const ttl = await kit.redis.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(900);
      // Only the turn STREAM (TTL-bound) may hold text; no other AI key does.
      const keys = await kit.redis.keys(`crewflow:test:ai:*`);
      for (const k of keys.filter((k) => !k.endsWith(':stream'))) {
        const type = await kit.redis.type(k);
        const value = type === 'string' ? await kit.redis.get(k) : type === 'zset' ? JSON.stringify(await kit.redis.zrange(k, 0, -1)) : '';
        expect(`${k} ${value}`).not.toContain(CANARY);
      }
    } finally {
      await listener.quit();
    }
  });
});
