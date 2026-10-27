import './helpers/ai-env';

import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { Logger } from '@nestjs/common';

import { AiStreamService } from '../../modules/ai/services/ai-stream.service';
import { scriptedModel, usage } from './helpers/ai-models';
import { AiKit, aiOrganisation, ask, bootAiKit, jobFor, newConversation, readSse } from './helpers/ai-test-kit';

/**
 * C1 CD-7 / TW-D7 — REASONING-CANARY: the Worker discards every reasoning delta and every provider signature and
 * publishes only `{type:'reasoning', phase, durationMs}` (server clock). The canary text and signature must be absent
 * from the Redis stream, the SSE, every database row of the conversation, the audit log and the logs.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const CANARY = 'REASONING-CANARY-9d2e41-private-chain-of-thought';
const SIGNATURE = 'REASONING-SIGNATURE-CANARY-c0ffee';

describeIfDb('AI reasoning: duration only, never text (integration)', () => {
  jest.setTimeout(240_000);
  let kit: AiKit;

  beforeAll(async () => {
    kit = await bootAiKit();
  });
  afterEach(() => kit.setModel(null));
  afterAll(async () => {
    await kit?.close();
  });

  it('REASONING-CANARY: absent from the stream, the SSE, the rows, the audit and the logs; the duration is published', async () => {
    const logs: string[] = [];
    const spies = [
      ...(['log', 'warn', 'error', 'debug', 'verbose'] as const).map((l) => jest.spyOn(Logger.prototype, l).mockImplementation((...a: unknown[]) => void logs.push(JSON.stringify(a)))),
      ...(['log', 'warn', 'error', 'info', 'debug'] as const).map((l) => jest.spyOn(console, l).mockImplementation((...a: unknown[]) => void logs.push(JSON.stringify(a)))),
    ];
    try {
      const parts: LanguageModelV3StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', delta: `thinking about ${CANARY}` },
        { type: 'reasoning-delta', id: 'r1', delta: ' more private thoughts' },
        { type: 'reasoning-end', id: 'r1', providerMetadata: { anthropic: { signature: SIGNATURE } } },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'The visible answer.' },
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usage(10, 5) },
      ];
      kit.setModel(scriptedModel([parts], { chunkDelayInMs: 30 }).model);
      const org = await aiOrganisation(kit, 'ai-reasoning');
      const conversationId = await newConversation(kit, org.token);
      const turn = await ask(kit, org.token, conversationId, 'Think, then answer');
      expect(await kit.runner.run(jobFor(org.ceo, conversationId, turn.turnId))).toBe('completed');

      const streamed = await kit.moduleRef.get(AiStreamService).read(conversationId, turn.turnId, '0-0', 500);
      const reasoning = streamed.map((e) => e.event).filter((e) => e.type === 'reasoning');
      expect(reasoning).toEqual([
        { type: 'reasoning', turnId: turn.turnId, phase: 'started' },
        { type: 'reasoning', turnId: turn.turnId, phase: 'finished', durationMs: expect.any(Number) },
      ]);
      const finished = reasoning[1] as { durationMs: number };
      expect(finished.durationMs).toBeGreaterThanOrEqual(0);
      const raw = await kit.redis.xrange(kit.moduleRef.get(AiStreamService).stream(conversationId, turn.turnId), '-', '+');
      expect(JSON.stringify(raw)).not.toMatch(new RegExp(`${CANARY}|${SIGNATURE}|private thoughts`));

      const sse = await readSse(kit, org.token, conversationId, turn.turnId);
      expect(JSON.stringify(sse.events)).not.toMatch(new RegExp(`${CANARY}|${SIGNATURE}|private thoughts`));
      expect(sse.events.some((e) => e.data.type === 'reasoning')).toBe(true);
      expect(sse.events[sse.events.length - 1]!.data).toMatchObject({ type: 'done', status: 'completed', content: 'The visible answer.' });

      const rows = await kit.owner.query(`SELECT * FROM core.ai_message WHERE conversation_id = $1`, [conversationId]);
      expect(JSON.stringify(rows)).not.toMatch(new RegExp(`${CANARY}|${SIGNATURE}|private thoughts`));
      // p2 merge (CD-7): only the DURATION is persisted, on the assistant turn (AiTurnLevelReasoning column).
      const [assistant] = rows.filter((r: { role: string }) => r.role === 'assistant') as Array<{ reasoning_ms: number | null }>;
      expect(assistant!.reasoning_ms).toBe(finished.durationMs);
      const audit = await kit.owner.query(`SELECT action, metadata FROM core.audit_log WHERE organisation_id = $1`, [org.orgId]);
      expect(JSON.stringify(audit)).not.toMatch(new RegExp(`${CANARY}|${SIGNATURE}|private thoughts`));
      expect(logs.join('\n')).not.toMatch(new RegExp(`${CANARY}|${SIGNATURE}|private thoughts`));
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
