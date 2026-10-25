import './helpers/ai-env-slow';

import http from 'node:http';
import { AddressInfo } from 'node:net';

import { AiSseService } from '../../modules/ai/services/ai-sse.service';
import { hangingModel } from './helpers/ai-models';
import { AiKit, aiOrganisation, ask, bearer, bootAiKit, jobFor, newConversation, turnRow } from './helpers/ai-test-kit';

/**
 * AI Phase 1 — the AI SSE endpoint while a turn is RUNNING (brief §11, §15 "SSE disconnect / reconnect"): live deltas,
 * a client disconnect releases everything server-side without touching the turn, the per-user connection cap, and a
 * session revoked mid-stream ends the stream (AI_ACCESS_REVOKED) within one re-validation period. Reconnect/replay of a
 * finished turn: ai-turn.integration.spec.ts.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const sidOf = (token: string): string => (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { sid: string }).sid;

describeIfDb('AI SSE while a turn runs (integration)', () => {
  jest.setTimeout(240_000);
  let kit: AiKit;
  let sse: AiSseService;
  let port: number;

  beforeAll(async () => {
    kit = await bootAiKit();
    sse = kit.moduleRef.get(AiSseService);
    await kit.app.listen(0, '127.0.0.1');
    port = (kit.app.getHttpServer().address() as AddressInfo).port;
  });
  afterEach(() => kit.setModel(null));
  afterAll(async () => {
    await kit?.close();
  });

  /** Opens a raw SSE connection; resolves with the response and a live buffer of received text. */
  function open(token: string, conversationId: string, turnId: string): Promise<{ res: http.IncomingMessage; req: http.ClientRequest; text: () => string; ended: Promise<void> }> {
    return new Promise((resolve, reject) => {
      let buffer = '';
      const req = http.get({ host: '127.0.0.1', port, path: `/rest/v1/ai/conversations/${conversationId}/stream?turnId=${turnId}`, headers: { ...bearer(token), Accept: 'text/event-stream' } }, (res) => {
        res.setEncoding('utf8');
        const ended = new Promise<void>((done) => {
          res.on('data', (c: string) => (buffer += c));
          res.on('end', () => done());
          res.on('close', () => done());
        });
        resolve({ res, req, text: () => buffer, ended });
      });
      req.on('error', (e) => (e.message.includes('aborted') || e.message.includes('socket hang up') ? undefined : reject(e)));
    });
  }
  const until = async (fn: () => boolean | Promise<boolean>, ms = 15_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('condition not met in time');
  };

  async function runningTurn(label: string) {
    const org = await aiOrganisation(kit, label);
    kit.setModel(hangingModel('Counting the shifts ').model);
    const conversationId = await newConversation(kit, org.token);
    const turn = await ask(kit, org.token, conversationId, 'Tell me something');
    const pending = kit.runner.run(jobFor(org.ceo, conversationId, turn.turnId));
    await until(async () => (await turnRow(kit, turn.turnId)).status === 'running');
    const cancel = async () => {
      await kit.http().post(`/rest/v1/ai/conversations/${conversationId}/turns/${turn.turnId}/cancel`).set(bearer(org.token));
      return pending;
    };
    return { org, conversationId, turnId: turn.turnId, cancel };
  }

  it('live deltas reach the open stream; a client disconnect frees the server side and leaves the turn running', async () => {
    const t = await runningTurn('ai-sse-live');
    const c = await open(t.org.token, t.conversationId, t.turnId);
    expect(c.res.statusCode).toBe(200);
    expect(c.res.headers['content-type']).toMatch(/text\/event-stream/);
    await until(() => c.text().includes('Counting the shifts'));
    expect(c.text()).toMatch(/event: status/);
    expect(sse.openCount()).toBe(1);
    c.req.destroy();
    await until(() => sse.openCount() === 0);
    expect((await turnRow(kit, t.turnId)).status).toBe('running'); // the browser leaving never stops or re-runs the turn
    expect(await t.cancel()).toBe('cancelled');
  });

  it('per-user cap: a 4th concurrent stream of the same user is refused with 429 before any stream opens', async () => {
    const t = await runningTurn('ai-sse-cap');
    const streams = [await open(t.org.token, t.conversationId, t.turnId), await open(t.org.token, t.conversationId, t.turnId), await open(t.org.token, t.conversationId, t.turnId)];
    await until(() => sse.openCount() === 3);
    const fourth = await kit.http().get(`/rest/v1/ai/conversations/${t.conversationId}/stream?turnId=${t.turnId}`).set(bearer(t.org.token));
    expect(fourth.status).toBe(429);
    for (const s of streams) s.req.destroy();
    await until(() => sse.openCount() === 0);
    await t.cancel();
  });

  it('a session revoked while streaming ends the stream with AI_ACCESS_REVOKED within one re-validation period (10 s)', async () => {
    const t = await runningTurn('ai-sse-revoke');
    const c = await open(t.org.token, t.conversationId, t.turnId);
    await until(() => c.text().includes('event: status'));
    await kit.owner.query(`UPDATE core.refresh_token SET revoked_at = now() WHERE family_id = $1`, [sidOf(t.org.token)]);
    await Promise.race([c.ended, new Promise((r) => setTimeout(r, 14_000))]);
    expect(c.text()).toMatch(/AI_ACCESS_REVOKED/);
    await until(() => sse.openCount() === 0);
    // The Worker re-authorises a long model call at every lease renewal (15 s): the turn stops AI_ACCESS_REVOKED.
    await until(async () => (await turnRow(kit, t.turnId)).status === 'failed', 25_000);
    expect(await turnRow(kit, t.turnId)).toMatchObject({ error_code: 'AI_ACCESS_REVOKED' });
  });
});
