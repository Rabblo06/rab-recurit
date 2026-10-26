import './helpers/ai-env-slow';

import http from 'node:http';
import { AddressInfo } from 'node:net';

import { AiRedisSubscriberProvider } from '../../modules/ai/services/ai-redis-subscriber.provider';
import { AiSseService } from '../../modules/ai/services/ai-sse.service';
import { AiStreamService } from '../../modules/ai/services/ai-stream.service';
import { AiKit, aiOrganisation, ask, bearer, bootAiKit, newConversation, setOrgAi } from './helpers/ai-test-kit';

/**
 * AI Phase 2 — the SSE relay (docs/ai/PHASE2_TWENTY_PLAN.md §2.4; T2-7, T2-8, T2-9): wake-driven delivery, the poll
 * fallback while the subscriber is down, resume without duplicates or gaps, and the 2 s fail-closed keepalive (no SSE id)
 * that ends the stream within one period when access goes. Turns are put in the `running` state directly and their
 * stream is written through AiStreamService, so the relay is measured on its own (no model, no Worker timing).
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const sidOf = (token: string): string => (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { sid: string }).sid;

interface Frame {
  id?: string;
  event?: string;
  data: Record<string, unknown>;
  at: number;
}

describeIfDb('AI SSE keepalive, wake-ups and resume (integration)', () => {
  jest.setTimeout(240_000);
  let kit: AiKit;
  let sse: AiSseService;
  let streams: AiStreamService;
  let port: number;

  beforeAll(async () => {
    kit = await bootAiKit();
    sse = kit.moduleRef.get(AiSseService);
    streams = kit.moduleRef.get(AiStreamService);
    await kit.app.listen(0, '127.0.0.1');
    port = (kit.app.getHttpServer().address() as AddressInfo).port;
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await kit?.close();
  });

  const until = async (fn: () => boolean | Promise<boolean>, ms = 15_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('condition not met in time');
  };

  /** A raw SSE connection whose frames are parsed as they arrive (with their arrival time). */
  function open(token: string, conversationId: string, turnId: string, lastEventId?: string) {
    return new Promise<{ req: http.ClientRequest; frames: Frame[]; ended: Promise<void>; status: number }>((resolve, reject) => {
      const frames: Frame[] = [];
      let buffer = '';
      const headers: Record<string, string> = { ...bearer(token), Accept: 'text/event-stream' };
      if (lastEventId) headers['Last-Event-ID'] = lastEventId;
      const req = http.get({ host: '127.0.0.1', port, path: `/rest/v1/ai/conversations/${conversationId}/stream?turnId=${turnId}`, headers }, (res) => {
        res.setEncoding('utf8');
        const ended = new Promise<void>((done) => {
          res.on('data', (chunk: string) => {
            buffer += chunk;
            let idx: number;
            while ((idx = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              const lines = block.split('\n');
              const data = lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
              if (!data) continue;
              frames.push({ id: lines.find((l) => l.startsWith('id: '))?.slice(4), event: lines.find((l) => l.startsWith('event: '))?.slice(7), data: JSON.parse(data), at: Date.now() });
            }
          });
          res.on('end', () => done());
          res.on('close', () => done());
        });
        resolve({ req, frames, ended, status: res.statusCode ?? 0 });
      });
      req.on('error', (e) => (e.message.includes('aborted') || e.message.includes('socket hang up') ? undefined : reject(e)));
    });
  }

  /** A conversation whose turn is RUNNING under a lease nobody holds (the relay is tested without a Worker). */
  async function runningTurn(label: string) {
    const org = await aiOrganisation(kit, label);
    const conversationId = await newConversation(kit, org.token);
    const turn = await ask(kit, org.token, conversationId, 'Relay test');
    await kit.owner.query(`UPDATE core.ai_message SET status = 'running', lease_token = gen_random_uuid(), lease_expires_at = now() + interval '10 minutes', started_at = now() WHERE id = $1`, [turn.turnId]);
    const end = () => kit.owner.query(`UPDATE core.ai_message SET status = 'failed', error_code = 'AI_INTERNAL_ERROR', lease_token = NULL, lease_expires_at = NULL, completed_at = now() WHERE id = $1 AND status = 'running'`, [turn.turnId]);
    return { org, conversationId, turnId: turn.turnId, end };
  }

  it('T2-7: wake-driven — each delta reaches the client in < 250 ms while the poll is 1 s', async () => {
    const t = await runningTurn('ai-sse-wake');
    const c = await open(t.org.token, t.conversationId, t.turnId);
    await until(() => c.frames.some((f) => f.data.type === 'status'));
    await new Promise((r) => setTimeout(r, 300)); // the wake subscription is in place
    expect(kit.moduleRef.get(AiRedisSubscriberProvider).ready).toBe(true);
    const latencies: number[] = [];
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const sent = Date.now();
      await streams.publish(t.conversationId, t.turnId, { type: 'delta', turnId: t.turnId, text: `wake-${i} ` });
      await until(() => c.frames.some((f) => f.data.text === `wake-${i} `), 3_000);
      latencies.push(c.frames.find((f) => f.data.text === `wake-${i} `)!.at - sent);
    }
    // eslint-disable-next-line no-console
    console.log(`[ai-measure] sse wake latencies ${JSON.stringify(latencies)}`);
    for (const l of latencies) expect(l).toBeLessThan(250);
    c.req.destroy();
    await until(() => sse.openCount() === 0);
    await t.end();
  });

  it('T2-7: with the subscriber down the 250 ms poll still delivers every delta, in order', async () => {
    const subscriber = kit.moduleRef.get(AiRedisSubscriberProvider);
    jest.spyOn(subscriber, 'subscribe').mockResolvedValue(() => undefined);
    jest.spyOn(subscriber, 'ready', 'get').mockReturnValue(false);
    const t = await runningTurn('ai-sse-fallback');
    const c = await open(t.org.token, t.conversationId, t.turnId);
    for (let i = 0; i < 20; i++) await streams.publish(t.conversationId, t.turnId, { type: 'delta', turnId: t.turnId, text: `f${i};` });
    await until(() => c.frames.filter((f) => f.data.type === 'delta').length === 20, 5_000);
    expect(c.frames.filter((f) => f.data.type === 'delta').map((f) => f.data.text)).toEqual(Array.from({ length: 20 }, (_, i) => `f${i};`));
    c.req.destroy();
    await until(() => sse.openCount() === 0);
    await t.end();
  });

  it('T2-8: resume with Last-Event-ID — no duplicate and no gap across 500 deltas', async () => {
    const t = await runningTurn('ai-sse-resume');
    for (let i = 0; i < 500; i++) await streams.publish(t.conversationId, t.turnId, { type: 'delta', turnId: t.turnId, text: `${i},` });
    await streams.publish(t.conversationId, t.turnId, { type: 'done', turnId: t.turnId, status: 'completed', errorCode: null, content: 'x' });
    const full = await open(t.org.token, t.conversationId, t.turnId);
    await full.ended;
    const deltas = full.frames.filter((f) => f.data.type === 'delta');
    expect(deltas.map((f) => f.data.text)).toEqual(Array.from({ length: 500 }, (_, i) => `${i},`));
    const cut = deltas[249]!;
    const resumed = await open(t.org.token, t.conversationId, t.turnId, cut.id);
    await resumed.ended;
    const after = resumed.frames.filter((f) => f.data.type === 'delta').map((f) => f.data.text);
    expect(after).toEqual(Array.from({ length: 250 }, (_, i) => `${i + 250},`));
    expect(resumed.frames[resumed.frames.length - 1]!.data.type).toBe('done');
    await t.end();
  });

  it('T2-9: a keepalive every 2 s (± 500 ms) that never moves the resume cursor (its id = the current cursor)', async () => {
    const t = await runningTurn('ai-sse-keepalive');
    const c = await open(t.org.token, t.conversationId, t.turnId);
    await new Promise((r) => setTimeout(r, 3_100));
    await streams.publish(t.conversationId, t.turnId, { type: 'delta', turnId: t.turnId, text: 'between keepalives' });
    await new Promise((r) => setTimeout(r, 4_200));
    const keepalives = c.frames.filter((f) => f.data.type === 'keepalive');
    expect(keepalives.length).toBeGreaterThanOrEqual(3);
    let cursor = '0-0';
    for (const f of c.frames) {
      if (f.data.type !== 'keepalive') {
        cursor = f.id!;
        continue;
      }
      expect(f.id).toBe(cursor); // Nest would otherwise number it ("1", "2", …), which a browser would send back
      expect(f.event).toBe('keepalive');
      expect(f.data).toEqual({ type: 'keepalive', turnId: t.turnId });
    }
    expect(new Set(keepalives.map((k) => k.id)).size).toBeGreaterThanOrEqual(2); // the cursor moved only with the delta
    const gaps = keepalives.slice(1).map((k, i) => k.at - keepalives[i]!.at);
    for (const g of gaps) {
      expect(g).toBeGreaterThanOrEqual(1_500);
      expect(g).toBeLessThanOrEqual(2_500);
    }
    // Every other frame (status, delta…) does carry the resume cursor.
    for (const f of c.frames.filter((x) => x.data.type !== 'keepalive')) expect(f.id).toMatch(/^\d+-\d+$/);
    c.req.destroy();
    await until(() => sse.openCount() === 0);
    await t.end();
  });

  describe('T2-9: access gone ⇒ the stream ends within ≤ 2.5 s (fail closed)', () => {
    const cases: Array<[string, (t: Awaited<ReturnType<typeof runningTurn>>) => Promise<unknown>, string]> = [
      ['session revoked', (t) => kit.owner.query(`UPDATE core.refresh_token SET revoked_at = now() WHERE family_id = $1`, [sidOf(t.org.token)]), 'AI_ACCESS_REVOKED'],
      [
        'ai.use removed',
        (t) =>
          kit.owner.query(`INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect) SELECT $1, id, $2, 'revoke' FROM core.permission WHERE key = 'ai.use'`, [
            t.org.ceo.userId,
            t.org.orgId,
          ]),
        'AI_ACCESS_REVOKED',
      ],
      ['organisation switch off', (t) => setOrgAi(kit, t.org.orgId, false), 'AI_ACCESS_REVOKED'],
      ['conversation deleted', (t) => kit.owner.query(`DELETE FROM core.ai_conversation WHERE id = $1`, [t.conversationId]), 'AI_ACCESS_REVOKED'],
    ];
    it.each(cases)('%s', async (label, revoke, code) => {
      const t = await runningTurn(`ai-sse-gone-${label.replace(/\W+/g, '-')}`);
      const c = await open(t.org.token, t.conversationId, t.turnId);
      await until(() => c.frames.some((f) => f.data.type === 'keepalive'), 5_000).catch(() => {
        throw new Error(`no keepalive: ${JSON.stringify({ status: c.status, frames: c.frames })}`);
      }); // just after a re-check
      await revoke(t);
      const t0 = Date.now();
      await Promise.race([c.ended, new Promise((r) => setTimeout(r, 5_000))]);
      const elapsed = Date.now() - t0;
      expect(c.frames[c.frames.length - 1]!.data).toEqual({ type: 'error', turnId: t.turnId, errorCode: code });
      expect(elapsed).toBeLessThanOrEqual(2_500);
      await until(() => sse.openCount() === 0);
      await t.end().catch(() => undefined);
    });
  });
});
