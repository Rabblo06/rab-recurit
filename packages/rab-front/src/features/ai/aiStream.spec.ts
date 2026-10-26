import { openAiStream, parseSseFrame, sanitiseCd7Event, type AiStreamEnd } from './aiStream';
import { getAccessToken, getIdentitySnapshot, getSessionId } from '../../shared/lib/auth-session';

jest.mock('../../shared/lib/auth-session', () => ({ getIdentitySnapshot: jest.fn(), getSessionId: jest.fn(), getAccessToken: jest.fn() }));
jest.mock('../../shared/api', () => ({ api: { defaults: { baseURL: 'http://api.test/rest/v1' } } }));

const snapshot = getIdentitySnapshot as jest.Mock;
const TURN = '11111111-2222-4333-8444-555555555555';
const CONV = '99999999-8888-4777-8666-555555555555';

/** A controllable `response.body` reader, like realtime-client.spec's. */
function fakeBody() {
  const chunks: Uint8Array[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  const poke = () => { const w = wake; wake = null; w?.(); };
  return {
    body: {
      getReader: () => ({
        read: async () => {
          for (;;) {
            if (chunks.length) return { done: false, value: chunks.shift()! };
            if (ended) return { done: true, value: undefined };
            await new Promise<void>((r) => { wake = r; });
          }
        },
      }),
    },
    push: (text: string) => { chunks.push(new TextEncoder().encode(text)); poke(); },
    end: () => { ended = true; poke(); },
  };
}
const frame = (id: string, data: object) => `id: ${id}\nevent: ${(data as { type: string }).type}\ndata: ${JSON.stringify(data)}\n\n`;
const ok = (body: ReturnType<typeof fakeBody>) => ({ ok: true, status: 200, body: body.body }) as unknown as Response;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  snapshot.mockReturnValue({ generation: 1, userId: 'u1', sessionId: 's1' });
  (getSessionId as jest.Mock).mockReturnValue('s1');
  (getAccessToken as jest.Mock).mockReturnValue(null);
});

it('parses id / event / data fields and ignores comments', () => {
  expect(parseSseFrame(': keep-alive\nid: 1-0\nevent: delta\ndata: {"a":1}')).toEqual({ id: '1-0', event: 'delta', data: '{"a":1}' });
  expect(parseSseFrame(': only a comment')).toBeNull();
});

it('authenticates with the cookie and session fence headers — never a token in the URL — and ends on done', async () => {
  const body = fakeBody();
  const fetchImpl = jest.fn().mockResolvedValue(ok(body));
  const events: unknown[] = [];
  const ends: AiStreamEnd[] = [];
  openAiStream({ conversationId: CONV, turnId: TURN, fetchImpl, onEvent: (e) => events.push(e), onEnd: (e) => ends.push(e) });
  await flush();
  const [url, init] = fetchImpl.mock.calls[0];
  expect(url).toBe(`http://api.test/rest/v1/ai/conversations/${CONV}/stream?turnId=${TURN}`);
  expect(url).not.toMatch(/token|sid|session|auth/i);
  expect(init).toMatchObject({ credentials: 'include', headers: { Accept: 'text/event-stream', 'X-Crewflow-Expected-Session-Id': 's1', 'X-Application-Target': 'manager_web' } });
  expect(init.headers['Last-Event-ID']).toBeUndefined();
  body.push(frame('1-0', { type: 'status', turnId: TURN, status: 'running' }));
  body.push(frame('2-0', { type: 'delta', turnId: TURN, text: 'Hello ' }));
  // Another turn's event on the same wire is never delivered.
  body.push(frame('3-0', { type: 'delta', turnId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', text: 'LEAK' }));
  body.push(frame('4-0', { type: 'done', turnId: TURN, status: 'completed', errorCode: null, content: 'Hello world' }));
  await flush();
  await flush();
  expect(events.map((e) => (e as { type: string }).type)).toEqual(['status', 'delta', 'done']);
  expect(JSON.stringify(events)).not.toContain('LEAK');
  expect(ends).toEqual([{ kind: 'done' }]);
  expect(fetchImpl).toHaveBeenCalledTimes(1); // a finished turn is never reconnected
});

it('reconnects after a dropped stream with Last-Event-ID = the last id received, and continues from there', async () => {
  const first = fakeBody();
  const second = fakeBody();
  const fetchImpl = jest.fn().mockResolvedValueOnce(ok(first)).mockResolvedValueOnce(ok(second));
  const texts: string[] = [];
  const reconnecting = jest.fn();
  const handle = openAiStream({ conversationId: CONV, turnId: TURN, fetchImpl, backoffMs: () => 0, onReconnecting: reconnecting, onEvent: (e) => { if (e.type === 'delta') texts.push(e.text); }, onEnd: jest.fn() });
  await flush();
  first.push(frame('1700000000000-0', { type: 'delta', turnId: TURN, text: 'One ' }));
  first.push(frame('1700000000000-1', { type: 'delta', turnId: TURN, text: 'two ' }));
  await flush();
  first.end();
  await flush();
  await flush();
  await flush();
  expect(reconnecting).toHaveBeenCalledWith(1);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(fetchImpl.mock.calls[1][1].headers['Last-Event-ID']).toBe('1700000000000-1');
  second.push(frame('1700000000000-2', { type: 'delta', turnId: TURN, text: 'three' }));
  await flush();
  expect(texts.join('')).toBe('One two three');
  expect(handle.lastEventId()).toBe('1700000000000-2');
  handle.stop();
});

it('an error event (access revoked) ends the stream for good; a 404 refusal is final and reported', async () => {
  const body = fakeBody();
  const ends: AiStreamEnd[] = [];
  const fetchImpl = jest.fn().mockResolvedValue(ok(body));
  openAiStream({ conversationId: CONV, turnId: TURN, fetchImpl, onEvent: jest.fn(), onEnd: (e) => ends.push(e) });
  await flush();
  body.push(frame('1-0', { type: 'error', turnId: TURN, errorCode: 'AI_ACCESS_REVOKED' }));
  await flush();
  expect(ends).toEqual([{ kind: 'error', errorCode: 'AI_ACCESS_REVOKED' }]);

  const refused = jest.fn().mockResolvedValue({ ok: false, status: 404, body: null, json: async () => ({ statusCode: 404, code: 'AI_NOT_AVAILABLE' }) });
  const ends2: AiStreamEnd[] = [];
  openAiStream({ conversationId: CONV, turnId: TURN, fetchImpl: refused, onEvent: jest.fn(), onEnd: (e) => ends2.push(e) });
  await flush();
  await flush();
  expect(ends2).toEqual([{ kind: 'http', status: 404, code: 'AI_NOT_AVAILABLE' }]);
  expect(refused).toHaveBeenCalledTimes(1);
});

it('gives up after the bounded number of failed attempts, and stops at once when the browser identity changes', async () => {
  const failing = jest.fn().mockRejectedValue(new TypeError('network'));
  const ends: AiStreamEnd[] = [];
  openAiStream({ conversationId: CONV, turnId: TURN, fetchImpl: failing, maxFailures: 2, backoffMs: () => 0, onEvent: jest.fn(), onEnd: (e) => ends.push(e) });
  for (let i = 0; i < 10; i += 1) await flush();
  expect(failing).toHaveBeenCalledTimes(3);
  expect(ends).toEqual([{ kind: 'network' }]);

  const body = fakeBody();
  const events: unknown[] = [];
  const ends2: AiStreamEnd[] = [];
  openAiStream({ conversationId: CONV, turnId: TURN, fetchImpl: jest.fn().mockResolvedValue(ok(body)), onEvent: (e) => events.push(e), onEnd: (e) => ends2.push(e) });
  await flush();
  snapshot.mockReturnValue({ generation: 2, userId: 'someone-else', sessionId: 's2' });
  body.push(frame('1-0', { type: 'delta', turnId: TURN, text: 'previous identity' }));
  await flush();
  expect(events).toEqual([]);
  expect(ends2).toEqual([{ kind: 'identity' }]);
});

describe('CD-7 events are rebuilt from their allowed fields only', () => {
  it('reasoning: phase + numeric duration survive; any text / delta / signature is dropped (TW-D7)', () => {
    const out = sanitiseCd7Event({ type: 'reasoning', turnId: TURN, phase: 'finished', durationMs: 2100.4, text: 'REASONING-CANARY', delta: 'x', signature: 'sig' }, TURN);
    expect(out).toEqual({ type: 'reasoning', turnId: TURN, phase: 'finished', durationMs: 2100 });
    expect(JSON.stringify(out)).not.toContain('REASONING-CANARY');
    expect(sanitiseCd7Event({ type: 'reasoning', turnId: TURN, phase: 'thinking' }, TURN)).toBeNull();
    expect(sanitiseCd7Event({ type: 'reasoning', turnId: 'another-turn', phase: 'started' }, TURN)).toBeNull();
  });

  it('plan: at most 8 steps, labels cut to 100 characters, unknown statuses dropped, extra fields never kept', () => {
    const steps = Array.from({ length: 12 }, (_, i) => ({ label: `${'L'.repeat(150)}${i}`, status: i === 3 ? 'approved' : 'pending', html: '<b>x</b>' }));
    const out = sanitiseCd7Event({ type: 'plan', turnId: TURN, steps }, TURN) as { steps: Array<Record<string, unknown>> };
    expect(out.steps).toHaveLength(7);
    for (const step of out.steps) {
      expect(Object.keys(step).sort()).toEqual(['label', 'status']);
      expect(String(step.label).length).toBe(100);
    }
  });

  it('a reasoning frame on the wire reaches onEvent sanitised and moves the resume cursor', async () => {
    const body = fakeBody();
    const fetchImpl = jest.fn().mockResolvedValue(ok(body));
    const events: unknown[] = [];
    openAiStream({ conversationId: CONV, turnId: TURN, onEvent: (e) => events.push(e), onEnd: () => undefined, fetchImpl });
    await flush();
    body.push(frame('5-0', { type: 'reasoning', turnId: TURN, phase: 'started', text: 'REASONING-CANARY' }));
    await flush();
    expect(events).toEqual([{ type: 'reasoning', turnId: TURN, phase: 'started' }]);
  });
});
