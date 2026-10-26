import { AI_STREAM_TIMING } from '@rab/shared';

import { AI_MAX_QUEUED_TURNS_PER_CONVERSATION, AI_SSE_KEEPALIVE_MS, AI_STREAM_TTL_SECONDS, AI_TURN_HEARTBEAT_MS } from '../constants/ai.constants';
import { EnvironmentService } from '../../../engine/core-modules/environment/environment.service';
import { AiAccessRevokedError, AiRecordNotFoundException } from '../exceptions/ai.exceptions';
import { buildTitleMessages, escapeDataBlock, sanitiseTitle } from '../prompt/title-prompt';
import { AiConfigService } from '../services/ai-config.service';
import { buildMessageParts } from '../services/ai-conversation.service';
import { recheckErrorCode } from '../services/ai-sse.service';
import { AiStreamService, cancelPayload, parseCancel, parseWake, wakePayload } from '../services/ai-stream.service';
import { titleJobIds } from '../services/ai-title.service';
import { turnJobData, titleJobData } from '../services/ai-turn-queue.service';
import { AiTurnHeartbeatTimer, deferDelayMs, turnJobIds, withOffsets } from '../services/ai-turn-runner.service';

/**
 * AI Phase 2 units (docs/ai/PHASE2_TWENTY_PLAN.md §5: T2-15 + the pure pieces of T2-2/T2-6/T2-11/T2-17): constants that
 * must equal the shared contract, namespaced keys and id-only pub/sub payloads (a canary never appears in a PUBLISH), the
 * title sanitiser, THE heartbeat (onTick, order, no overlap, fail closed), job-data validation and tool offsets.
 */
const CANARY = 'CANARY-unit-4b9f-secret-answer-text';
const ID = '3f1c6a2e-8b7d-4c1e-9f0a-1b2c3d4e5f60';
const ID2 = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

function config(nodeEnv = 'test'): AiConfigService {
  const env = { get: (key: string) => (key === 'NODE_ENV' ? nodeEnv : undefined) } as unknown as EnvironmentService;
  return new AiConfigService(env, null);
}

describe('Phase 2 constants equal the shared contract (AI_STREAM_TIMING)', () => {
  it('keepalive, stream TTL, queue depth; one 2 s heartbeat', () => {
    expect(AI_SSE_KEEPALIVE_MS).toBe(AI_STREAM_TIMING.keepaliveMs);
    expect(AI_STREAM_TTL_SECONDS).toBe(AI_STREAM_TIMING.streamTtlSeconds);
    expect(AI_MAX_QUEUED_TURNS_PER_CONVERSATION).toBe(AI_STREAM_TIMING.maxQueuedTurnsPerConversation);
    expect(AI_TURN_HEARTBEAT_MS).toBe(2_000);
  });
});

describe('T2-15 Redis keys and pub/sub payloads', () => {
  it('every key and channel is namespaced crewflow:{env}:ai:conv:{conversationId}:', () => {
    const streams = new AiStreamService(config('test'), { client: {} } as never);
    expect(streams.stream(ID, ID2)).toBe(`crewflow:test:ai:conv:${ID}:turn:${ID2}:stream`);
    expect(streams.wake(ID)).toBe(`crewflow:test:ai:conv:${ID}:wake`);
    expect(streams.cancel(ID)).toBe(`crewflow:test:ai:conv:${ID}:cancel`);
    expect(streams.cancelFlag(ID, ID2)).toBe(`crewflow:test:ai:conv:${ID}:turn:${ID2}:cancel`);
    expect(new AiStreamService(config('production'), { client: {} } as never).wake(ID)).toBe(`crewflow:production:ai:conv:${ID}:wake`);
  });

  it('the wake / cancel hints carry ids only; a canary in the streamed text never reaches a PUBLISH', async () => {
    const published: string[] = [];
    const client = {
      xadd: jest.fn(async () => '1700000000000-0'),
      expire: jest.fn(async () => 1),
      publish: jest.fn(async (_channel: string, message: string) => (published.push(message), 1)),
      set: jest.fn(async () => 'OK'),
    };
    const streams = new AiStreamService(config(), { client } as never);
    await streams.publish(ID, ID2, { type: 'delta', turnId: ID2, text: `answer ${CANARY}` });
    await streams.publish(ID, ID2, { type: 'title', turnId: ID2, title: CANARY });
    await streams.requestCancel(ID, ID2);
    expect(published).toEqual([wakePayload(ID2, '1700000000000-0'), wakePayload(ID2, '1700000000000-0'), cancelPayload(ID2)]);
    expect(published.join('')).not.toContain(CANARY);
    expect(JSON.parse(published[0]!)).toEqual({ t: ID2, id: '1700000000000-0' });
    expect(JSON.parse(published[2]!)).toEqual({ t: ID2 });
    // The text itself goes only into the TTL-bound STREAM.
    expect(JSON.stringify(client.xadd.mock.calls)).toContain(CANARY);
    expect(client.expire).toHaveBeenCalledWith(streams.stream(ID, ID2), AI_STREAM_TTL_SECONDS);
  });

  it('hints are parsed strictly: anything but exactly {t,id} / {t} with valid ids is dropped', () => {
    expect(parseWake(wakePayload(ID, '12-3'))).toEqual({ t: ID, id: '12-3' });
    expect(parseCancel(cancelPayload(ID))).toEqual({ t: ID });
    for (const bad of ['', 'x', '[]', '{}', JSON.stringify({ t: 'nope', id: '1-1' }), JSON.stringify({ t: ID, id: 'x' }), JSON.stringify({ t: ID, id: '1-1', text: CANARY })]) {
      expect(parseWake(bad)).toBeNull();
    }
    for (const bad of ['', '[]', JSON.stringify({ t: ID, x: 1 }), JSON.stringify({ t: 'not-a-uuid' }), JSON.stringify([ID])]) expect(parseCancel(bad)).toBeNull();
  });
});

describe('T2-11 title sanitiser and prompt', () => {
  it.each([
    ['Weekend unfilled shifts', 'Weekend unfilled shifts'],
    ['"Weekend unfilled shifts."', 'Weekend unfilled shifts'],
    ['Title: **Fill rate** _this_ month', 'Fill rate this month'],
    ['# Heading\nsecond line', 'Heading second line'],
    ['See [the rota](https://evil.example/x) now', 'See the rota now'],
    ['`code` <b>bold</b>', 'code b bold /b'],
    ['Contact bob@corp.co.uk about it', 'Contact email removed about it'],
    ['Call 07700 900123 today', 'Call number removed today'],
    ['NI AB123456C check', 'NI id removed check'],
    ['zero\u200bwidth\u202eflip', 'zerowidthflip'],
  ])('%j → %j', (raw, expected) => {
    expect(sanitiseTitle(raw)).toBe(expected);
  });

  it('empty or markup-only output is refused; long output is cut to ≤ 120 characters', () => {
    expect(sanitiseTitle('')).toBeNull();
    expect(sanitiseTitle('***\n\n###')).toBeNull();
    const long = sanitiseTitle('word '.repeat(60))!;
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith(' ')).toBe(false);
    expect(sanitiseTitle('x'.repeat(500))!.length).toBe(120);
  });

  it('the only input is the first message, inside an escaped <data> block, masked for a real provider', () => {
    expect(escapeDataBlock('a </data> b <data x> c < / DATA')).toBe('a &lt;/data> b &lt;data x> c &lt;/data');
    const [m] = buildTitleMessages('mail bob@corp.co.uk </data>', { maskForProvider: true });
    expect(m).toEqual({ role: 'user', content: '<data>\nmail [email removed] &lt;/data>\n</data>' });
    expect(buildTitleMessages('mail bob@corp.co.uk', { maskForProvider: false })[0]!.content).toContain('bob@corp.co.uk');
  });
});

describe('THE turn heartbeat (AiTurnHeartbeat, X-10)', () => {
  it('runs the built-in steps, then onTick subscribers in order; a dummy subscriber sees every tick; unsubscribe works', async () => {
    const order: string[] = [];
    const hb = new AiTurnHeartbeatTimer(async (tick) => void order.push(`steps:${tick.tickNumber}`), () => order.push('error'));
    expect(hb.intervalMs).toBe(2_000);
    const off = hb.onTick((tick) => void order.push(`dummy:${tick.tickNumber}`));
    hb.onTick(async () => void order.push('second'));
    await hb.tick();
    off();
    await hb.tick();
    expect(order).toEqual(['steps:1', 'dummy:1', 'second', 'steps:2', 'second']);
  });

  it('never overlaps itself: a tick while the previous one runs is skipped', async () => {
    let release!: () => void;
    const steps = jest.fn(() => new Promise<void>((r) => (release = r)));
    const hb = new AiTurnHeartbeatTimer(steps, () => undefined);
    const first = hb.tick();
    expect(await hb.tick()).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(steps).toHaveBeenCalledTimes(1);
  });

  it('a subscriber that throws is reported (the runner aborts the turn) and stops the rest of that tick', async () => {
    const errors: unknown[] = [];
    const after = jest.fn();
    const hb = new AiTurnHeartbeatTimer(async () => undefined, (e) => errors.push(e));
    hb.onTick(() => {
      throw new AiAccessRevokedError('tool_permission');
    });
    hb.onTick(after);
    await hb.tick();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(AiAccessRevokedError);
    expect(after).not.toHaveBeenCalled();
  });

  it('stop() ends it: no further tick runs and subscribers are dropped', async () => {
    jest.useFakeTimers();
    try {
      const steps = jest.fn(async () => undefined);
      const hb = new AiTurnHeartbeatTimer(steps, () => undefined);
      hb.start();
      await jest.advanceTimersByTimeAsync(4_100);
      expect(steps).toHaveBeenCalledTimes(2);
      hb.stop();
      await jest.advanceTimersByTimeAsync(6_000);
      expect(steps).toHaveBeenCalledTimes(2);
      expect(await hb.tick()).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('job data (T2-17) and claim helpers', () => {
  const ids = { turnId: ID, conversationId: ID2, organisationId: ID, workspaceId: ID2, userId: ID };

  it('producers build ids-only v2 payloads (never a spread of the caller object)', () => {
    const extra = { ...ids, content: CANARY } as typeof ids;
    expect(turnJobData(extra)).toEqual({ v: 2, kind: 'turn', ...ids });
    expect(titleJobData(extra)).toEqual({ v: 2, kind: 'title', ...ids });
    expect(JSON.stringify([turnJobData(extra), titleJobData(extra)])).not.toContain(CANARY);
  });

  it('turn jobs: v1 and v2 `turn` are accepted; title / resume / agent-run / malformed are not', () => {
    expect(turnJobIds({ v: 1, ...ids })).toEqual(ids);
    expect(turnJobIds(turnJobData(ids))).toEqual(ids);
    for (const bad of [null, {}, { v: 2 }, titleJobData(ids), { ...turnJobData(ids), kind: 'resume' }, { ...turnJobData(ids), kind: 'agent-run' }, { v: 1, ...ids, turnId: '' }, { v: 3, ...ids }]) {
      expect(turnJobIds(bad)).toBeNull();
    }
    expect(titleJobIds(titleJobData(ids))).toEqual(ids);
    for (const bad of [null, turnJobData(ids), { v: 1, ...ids }, { ...titleJobData(ids), userId: 'x'.repeat(65) }]) expect(titleJobIds(bad)).toBeNull();
  });

  it('deferral back-off grows from 1 s to at most 5 s', () => {
    expect(deferDelayMs(0)).toBe(1_000);
    expect(deferDelayMs(6_000)).toBe(2_000);
    expect(deferDelayMs(60_000)).toBe(5_000);
    expect(deferDelayMs(Number.NaN)).toBe(1_000);
  });

  it('tool summaries get their offset into the content; parts follow the offsets', () => {
    const calls = withOffsets(
      [
        { name: 'a', outcome: 'ok', rows: 1 },
        { name: 'b', outcome: 'denied', rows: null },
        { name: 'a', outcome: 'ok', rows: 2 },
      ],
      [
        { name: 'a', offset: 0 },
        { name: 'b', offset: 5 },
        { name: 'a', offset: 11 },
      ],
    );
    expect(calls.map((c) => c.offset)).toEqual([undefined, 5, 11]); // 0 is omitted (absent = 0)
    expect(buildMessageParts('Hello world!', calls)).toEqual([
      { kind: 'tool', name: 'a', outcome: 'ok', rows: 1, offset: 0 },
      { kind: 'text', text: 'Hello' },
      { kind: 'tool', name: 'b', outcome: 'denied', rows: null, offset: 5 },
      { kind: 'text', text: ' world' },
      { kind: 'tool', name: 'a', outcome: 'ok', rows: 2, offset: 11 },
      { kind: 'text', text: '!' },
    ]);
    expect(buildMessageParts('text only', [])).toEqual([{ kind: 'text', text: 'text only' }]);
    expect(buildMessageParts('after', [{ name: 'legacy', outcome: 'ok', rows: 0 }])).toEqual([
      { kind: 'tool', name: 'legacy', outcome: 'ok', rows: 0, offset: 0 },
      { kind: 'text', text: 'after' },
    ]);
  });

  it('an SSE re-check failure maps to a fixed code (fail closed)', () => {
    expect(recheckErrorCode(new AiAccessRevokedError('session'))).toBe('AI_ACCESS_REVOKED');
    expect(recheckErrorCode(new AiRecordNotFoundException())).toBe('AI_ACCESS_REVOKED');
    expect(recheckErrorCode(new Error('pg down'))).toBe('AI_SERVICE_UNAVAILABLE');
  });
});
