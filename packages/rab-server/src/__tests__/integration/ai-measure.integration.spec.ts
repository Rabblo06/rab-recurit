import './helpers/ai-env';

import { seedStaffing } from './helpers/ai-fixtures';
import { AiKit, aiOrganisation, ask, bootAiKit, jobFor, newConversation, readSse, turnRow } from './helpers/ai-test-kit';

/**
 * AI Phase 1 — MEASUREMENTS on the local test stack (deterministic mock model, so model latency here is NOT a provider
 * figure). Prints `[ai-measure]` lines that the implementation report quotes; asserts only loose sanity bounds.
 * Measured: per-stage latency, database transactions per turn (pg_stat_database delta — this suite runs alone on its
 * database), peak crewflow_app connections, Redis keys left per turn, heap growth over 20 turns, mock token use.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('AI measurements (integration)', () => {
  jest.setTimeout(240_000);
  let kit: AiKit;

  beforeAll(async () => {
    kit = await bootAiKit();
  });
  afterAll(async () => {
    await kit?.close();
  });

  const xacts = async () => Number((await kit.owner.query(`SELECT xact_commit + xact_rollback AS n FROM pg_stat_database WHERE datname = current_database()`))[0].n);
  const appConnections = async () => Number((await kit.owner.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = 'crewflow_app' AND datname = current_database()`))[0].n);

  it('per-stage latency, transactions, connections, Redis keys, memory and tokens for real turns', async () => {
    const org = await aiOrganisation(kit, 'ai-measure');
    await seedStaffing(kit, org.ceo);
    const questions = ['Which shifts still need staff?', 'What is our fill rate this week?', 'How many offers are awaiting replies?', 'How many late clock-ins this month?', 'How does payroll compare?'];
    const samples: Array<Record<string, number | string>> = [];
    for (const q of questions) {
      const conversationId = await newConversation(kit, org.token);
      // Stats are flushed per backend at transaction end; give the collector a moment between samples.
      await new Promise((r) => setTimeout(r, 600));
      const x0 = await xacts();
      const t0 = Date.now();
      const turn = await ask(kit, org.token, conversationId, q);
      const submitMs = Date.now() - t0;
      let peak = 0;
      const t1 = Date.now();
      const watcher = setInterval(() => void appConnections().then((n) => (peak = Math.max(peak, n))), 20);
      await kit.runner.run(jobFor(org.ceo, conversationId, turn.turnId));
      clearInterval(watcher);
      const workerMs = Date.now() - t1;
      const t2 = Date.now();
      const sse = await readSse(kit, org.token, conversationId, turn.turnId);
      const sseMs = Date.now() - t2;
      await new Promise((r) => setTimeout(r, 600));
      const row = await turnRow(kit, turn.turnId);
      samples.push({
        question: q,
        submitMs,
        workerMs,
        sseReplayMs: sseMs,
        dbTransactions: (await xacts()) - x0,
        peakAppConnections: peak,
        sseEvents: sse.events.length,
        tools: (row.tool_calls as Array<{ name: string }>).map((c) => c.name).join(','),
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
        reservedTokens: Number(row.reserved_tokens),
        status: String(row.status),
      });
    }
    // eslint-disable-next-line no-console
    for (const s of samples) console.log(`[ai-measure] turn ${JSON.stringify(s)}`);
    for (const s of samples) expect(s.status).toBe('completed');

    const keys = await kit.redis.keys(`crewflow:${process.env.NODE_ENV}:ai:*`);
    const perKind = keys.reduce<Record<string, number>>((acc, k) => {
      const kind = k.split(':')[3] ?? '?';
      acc[kind] = (acc[kind] ?? 0) + 1;
      return acc;
    }, {});
    // eslint-disable-next-line no-console
    console.log(`[ai-measure] redis ${JSON.stringify({ aiKeys: keys.length, perKind })}`);

    global.gc?.();
    const heap0 = process.memoryUsage().heapUsed;
    const conversationId = await newConversation(kit, org.token);
    for (let i = 0; i < 20; i++) {
      const turn = await ask(kit, org.token, conversationId, 'What is our fill rate?');
      await kit.runner.run(jobFor(org.ceo, conversationId, turn.turnId));
    }
    global.gc?.();
    const heapDeltaMb = Math.round(((process.memoryUsage().heapUsed - heap0) / 1024 / 1024) * 10) / 10;
    // eslint-disable-next-line no-console
    console.log(`[ai-measure] memory ${JSON.stringify({ turns: 20, heapDeltaMb, rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024) })}`);
    expect(heapDeltaMb).toBeLessThan(200);
  });
});
