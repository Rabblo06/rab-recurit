import { startRealtimeClient, STABLE_CONNECTION_MS, type RealtimeConnectionStatus, type RealtimeEnvelope } from './realtime-client';
import { getIdentitySnapshot, getSessionId } from './auth-session';

jest.mock('./auth-session', () => ({
  getIdentitySnapshot: jest.fn(),
  getSessionId: jest.fn(),
}));
jest.mock('../api', () => ({
  api: { defaults: { baseURL: 'http://localhost:3000/rest/v1' } },
}));

const mockGetIdentitySnapshot = getIdentitySnapshot as jest.Mock;
const mockGetSessionId = getSessionId as jest.Mock;

/**
 * A controllable fake of `response.body.getReader()` — `realtime-client.ts` only ever calls
 * `.read()` on it, so this is the entire surface that needs faking. Each `push` becomes one
 * resolved `{ done: false, value }`; `end()` makes the NEXT `read()` resolve `{ done: true }`,
 * matching a real stream closing (the server dropping the connection, a network interruption).
 */
function makeFakeReader() {
  const chunks: Uint8Array[] = [];
  let ended = false;
  let waiter: (() => void) | null = null;
  function wake() {
    if (waiter) { const w = waiter; waiter = null; w(); }
  }
  return {
    reader: {
      read: async () => {
        for (;;) {
          if (chunks.length > 0) return { done: false, value: chunks.shift()! };
          if (ended) return { done: true, value: undefined };
          await new Promise<void>((resolve) => { waiter = resolve; });
        }
      },
    },
    push(frame: string) {
      chunks.push(new TextEncoder().encode(frame));
      wake();
    },
    end() {
      ended = true;
      wake();
    },
  };
}

function envelope(overrides: Partial<RealtimeEnvelope> = {}): RealtimeEnvelope {
  return {
    version: 1,
    eventId: 'evt-1',
    type: 'offer.accepted',
    organisationId: 'org-1',
    workspaceId: 'ws-1',
    targetUserId: 'user-1',
    entityId: 'offer-1',
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}

function sseFrame(env: RealtimeEnvelope): string {
  return `data: ${JSON.stringify(env)}\n\n`;
}

describe('startRealtimeClient', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    mockGetIdentitySnapshot.mockReset().mockReturnValue({ userId: 'user-1', sessionId: 'sess-1', generation: 1 });
    mockGetSessionId.mockReset().mockReturnValue('sess-1');
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('sends credentials and the expected-session header on connect', async () => {
    const fake = makeFakeReader();
    fetchMock.mockResolvedValue({ ok: true, body: { getReader: () => fake.reader } });

    const handle = startRealtimeClient({ onEvent: jest.fn(), onStatusChange: jest.fn() });
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/rest/v1/realtime/stream',
      expect.objectContaining({
        credentials: 'include',
        headers: expect.objectContaining({ 'X-Crewflow-Expected-Session-Id': 'sess-1' }),
      }),
    );
    handle.stop();
  });

  it('parses a delivered frame and calls onEvent with the decoded envelope', async () => {
    const fake = makeFakeReader();
    fetchMock.mockResolvedValue({ ok: true, body: { getReader: () => fake.reader } });
    const onEvent = jest.fn();
    const onStatusChange = jest.fn();

    const handle = startRealtimeClient({ onEvent, onStatusChange });
    await Promise.resolve();
    expect(onStatusChange).toHaveBeenCalledWith('connected');

    fake.push(sseFrame(envelope({ eventId: 'evt-A' })));
    await Promise.resolve();
    await Promise.resolve();

    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'evt-A', type: 'offer.accepted' }));
    handle.stop();
  });

  it('drops a duplicate eventId delivered twice in the same stream (at-least-once outbox delivery)', async () => {
    const fake = makeFakeReader();
    fetchMock.mockResolvedValue({ ok: true, body: { getReader: () => fake.reader } });
    const onEvent = jest.fn();

    const handle = startRealtimeClient({ onEvent, onStatusChange: jest.fn() });
    await Promise.resolve();

    fake.push(sseFrame(envelope({ eventId: 'evt-dup' })));
    await Promise.resolve();
    await Promise.resolve();
    fake.push(sseFrame(envelope({ eventId: 'evt-dup' })));
    await Promise.resolve();
    await Promise.resolve();

    expect(onEvent).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it('discards a frame whose identity generation moved on while the read was in flight — the cross-tab/logout fencing', async () => {
    const fake = makeFakeReader();
    fetchMock.mockResolvedValue({ ok: true, body: { getReader: () => fake.reader } });
    const onEvent = jest.fn();

    const handle = startRealtimeClient({ onEvent, onStatusChange: jest.fn() });
    await Promise.resolve(); // connect() captures generation 1 here

    // The ambient identity moves on (logout / different-account login in this tab) before the
    // next frame is processed — must never deliver data captured under the OLD identity.
    mockGetIdentitySnapshot.mockReturnValue({ userId: 'user-2', sessionId: 'sess-2', generation: 2 });
    fake.push(sseFrame(envelope({ eventId: 'evt-stale' })));
    await Promise.resolve();
    await Promise.resolve();

    expect(onEvent).not.toHaveBeenCalled();
    handle.stop();
  });

  it('never connects when there is no authenticated identity', async () => {
    mockGetIdentitySnapshot.mockReturnValue({ userId: null, sessionId: null, generation: 0 });
    const onStatusChange = jest.fn();

    const handle = startRealtimeClient({ onEvent: jest.fn(), onStatusChange });
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onStatusChange).toHaveBeenCalledWith('offline');
    handle.stop();
  });

  it('schedules a bounded, jittered reconnect after the stream ends, and reconnects successfully', async () => {
    const fakeA = makeFakeReader();
    const fakeB = makeFakeReader();
    fetchMock
      .mockResolvedValueOnce({ ok: true, body: { getReader: () => fakeA.reader } })
      .mockResolvedValueOnce({ ok: true, body: { getReader: () => fakeB.reader } });
    const onStatusChange = jest.fn();

    const handle = startRealtimeClient({ onEvent: jest.fn(), onStatusChange });
    await Promise.resolve();
    expect(onStatusChange).toHaveBeenCalledWith('connected');

    fakeA.end(); // server/network drops the connection
    await Promise.resolve();
    await Promise.resolve();
    expect(onStatusChange).toHaveBeenCalledWith('reconnecting');
    expect(fetchMock).toHaveBeenCalledTimes(1); // not yet retried — still inside the backoff window

    await jest.advanceTimersByTimeAsync(2000); // base backoff (1s) with up to 2x jitter covers this
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onStatusChange).toHaveBeenCalledWith('connected');
    handle.stop();
  });

  it('a 204 (real-time disabled on the server) goes offline and never reconnects', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204, body: null });
    const onStatusChange = jest.fn();

    const handle = startRealtimeClient({ onEvent: jest.fn(), onStatusChange });
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(120_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onStatusChange).not.toHaveBeenCalledWith('connected');
    expect(onStatusChange).toHaveBeenLastCalledWith('offline');
    handle.stop();
  });

  it('a stream that keeps closing immediately backs off instead of reconnecting every second (regression)', async () => {
    fetchMock.mockImplementation(async () => {
      const fake = makeFakeReader();
      fake.end();
      return { ok: true, status: 200, body: { getReader: () => fake.reader } };
    });
    const handle = startRealtimeClient({ onEvent: jest.fn(), onStatusChange: jest.fn() });
    await jest.advanceTimersByTimeAsync(60_000);
    // Unbounded, the old behaviour reconnected ~60–120 times a minute (backoff reset on every 200).
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(8);
    handle.stop();
  });

  it('a connection that genuinely held resets the backoff, so the next drop reconnects quickly', async () => {
    const fakes = [makeFakeReader(), makeFakeReader(), makeFakeReader()];
    let i = 0;
    fetchMock.mockImplementation(async () => ({ ok: true, status: 200, body: { getReader: () => fakes[i++].reader } }));
    const handle = startRealtimeClient({ onEvent: jest.fn(), onStatusChange: jest.fn() });
    await Promise.resolve();

    await jest.advanceTimersByTimeAsync(STABLE_CONNECTION_MS + 1_000);
    fakes[0].end();
    await jest.advanceTimersByTimeAsync(1_000); // base 1s backoff (with ≤1x jitter)
    expect(fetchMock).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it('stop() prevents any further reconnect attempt', async () => {
    const fake = makeFakeReader();
    fetchMock.mockResolvedValue({ ok: true, body: { getReader: () => fake.reader } });
    const onStatusChange = jest.fn();

    const handle = startRealtimeClient({ onEvent: jest.fn(), onStatusChange });
    await Promise.resolve();
    handle.stop();
    expect(onStatusChange).toHaveBeenCalledWith('offline');

    fake.end();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1); // never retried post-stop
  });

  it('treats a non-ok response as a connection failure and schedules reconnect', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, body: null }).mockResolvedValueOnce({
      ok: true,
      body: { getReader: () => makeFakeReader().reader },
    });
    const onStatusChange: jest.Mock<void, [RealtimeConnectionStatus]> = jest.fn();

    const handle = startRealtimeClient({ onEvent: jest.fn(), onStatusChange });
    await Promise.resolve();
    expect(onStatusChange).toHaveBeenCalledWith('reconnecting');

    await jest.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it('ignores a malformed (non-JSON) data frame without crashing the stream', async () => {
    const fake = makeFakeReader();
    fetchMock.mockResolvedValue({ ok: true, body: { getReader: () => fake.reader } });
    const onEvent = jest.fn();

    const handle = startRealtimeClient({ onEvent, onStatusChange: jest.fn() });
    await Promise.resolve();

    fake.push('data: {not-json\n\n');
    await Promise.resolve();
    await Promise.resolve();
    expect(onEvent).not.toHaveBeenCalled();

    fake.push(sseFrame(envelope({ eventId: 'evt-after-malformed' })));
    await Promise.resolve();
    await Promise.resolve();
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'evt-after-malformed' }));
    handle.stop();
  });
});
