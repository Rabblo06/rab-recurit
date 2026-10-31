import {
  getRealtimeStatus,
  HIDDEN_RELEASE_MS,
  parseRetryAfter,
  startRealtimeClient,
  STABLE_CONNECTION_MS,
  WATCHDOG_MS,
  type RealtimeConnectionStatus,
  type RealtimeEnvelope,
  type VisibilitySource,
} from './realtime-client';
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
 * Like a real fetch body, a pending `read()` rejects when the request's AbortSignal fires.
 */
function makeFakeReader(signal?: AbortSignal) {
  const chunks: Uint8Array[] = [];
  let ended = false;
  let aborted = false;
  let waiter: (() => void) | null = null;
  function wake() {
    if (waiter) { const w = waiter; waiter = null; w(); }
  }
  signal?.addEventListener('abort', () => { aborted = true; wake(); });
  return {
    reader: {
      read: async () => {
        for (;;) {
          if (aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
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
    get aborted() { return aborted; },
  };
}

type FakeReader = ReturnType<typeof makeFakeReader>;

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

function fakeVisibility(initial: DocumentVisibilityState = 'visible') {
  let state = initial;
  const listeners = new Set<() => void>();
  const source: VisibilitySource = {
    get visibilityState() { return state; },
    addEventListener: (_t, l) => listeners.add(l),
    removeEventListener: (_t, l) => listeners.delete(l),
  };
  return { source, set(next: DocumentVisibilityState) { state = next; listeners.forEach((l) => l()); }, listeners };
}

/** fetch answering with a live stream each call; the readers are kept so a test can drive them. */
function streamingFetch(fetchMock: jest.Mock): FakeReader[] {
  const readers: FakeReader[] = [];
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
    const fake = makeFakeReader(init.signal ?? undefined);
    readers.push(fake);
    return { ok: true, status: 200, headers: { get: () => null }, body: { getReader: () => fake.reader } };
  });
  return readers;
}

const statusResponse = (status: number, retryAfter?: string) => ({ ok: status >= 200 && status < 300, status, headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' ? retryAfter ?? null : null) }, body: null });

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

  it('sends credentials, the expected-session header and the background marker on connect (a stream never slides the idle window)', async () => {
    streamingFetch(fetchMock);
    const handle = startRealtimeClient({ onEvent: jest.fn(), onStatusChange: jest.fn(), visibility: null });
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/rest/v1/realtime/stream',
      expect.objectContaining({
        credentials: 'include',
        headers: expect.objectContaining({ 'X-Crewflow-Expected-Session-Id': 'sess-1', 'X-Crewflow-Background': '1' }),
      }),
    );
    handle.stop();
  });

  it('parses a delivered frame and calls onEvent with the decoded envelope; comment frames are not events', async () => {
    const readers = streamingFetch(fetchMock);
    const onEvent = jest.fn();
    const onStatusChange = jest.fn();

    const handle = startRealtimeClient({ onEvent, onStatusChange, visibility: null });
    await jest.advanceTimersByTimeAsync(0);
    expect(onStatusChange).toHaveBeenCalledWith('connected');
    expect(getRealtimeStatus()).toBe('connected');

    readers[0].push(': connected\n\n');
    readers[0].push(': keepalive\n\n');
    readers[0].push(sseFrame(envelope({ eventId: 'evt-A' })));
    await jest.advanceTimersByTimeAsync(0);

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'evt-A', type: 'offer.accepted' }));
    handle.stop();
    expect(getRealtimeStatus()).toBe('offline');
  });

  it('drops a duplicate eventId delivered twice in the same stream (at-least-once outbox delivery)', async () => {
    const readers = streamingFetch(fetchMock);
    const onEvent = jest.fn();
    const handle = startRealtimeClient({ onEvent, onStatusChange: jest.fn(), visibility: null });
    await jest.advanceTimersByTimeAsync(0);

    readers[0].push(sseFrame(envelope({ eventId: 'evt-dup' })));
    await jest.advanceTimersByTimeAsync(0);
    readers[0].push(sseFrame(envelope({ eventId: 'evt-dup' })));
    await jest.advanceTimersByTimeAsync(0);

    expect(onEvent).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it('discards a frame whose identity generation moved on while the read was in flight — the cross-tab/logout fencing', async () => {
    const readers = streamingFetch(fetchMock);
    const onEvent = jest.fn();
    const handle = startRealtimeClient({ onEvent, onStatusChange: jest.fn(), visibility: null });
    await jest.advanceTimersByTimeAsync(0); // connect() captures generation 1 here

    mockGetIdentitySnapshot.mockReturnValue({ userId: 'user-2', sessionId: 'sess-2', generation: 2 });
    readers[0].push(sseFrame(envelope({ eventId: 'evt-stale' })));
    await jest.advanceTimersByTimeAsync(0);

    expect(onEvent).not.toHaveBeenCalled();
    handle.stop();
  });

  it('never connects when there is no authenticated identity', async () => {
    mockGetIdentitySnapshot.mockReturnValue({ userId: null, sessionId: null, generation: 0 });
    const onStatusChange = jest.fn();
    const handle = startRealtimeClient({ onEvent: jest.fn(), onStatusChange, visibility: null });
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onStatusChange).toHaveBeenCalledWith('offline');
    handle.stop();
  });

  it('schedules a bounded, jittered reconnect after the stream ends, and reconnects successfully', async () => {
    const readers = streamingFetch(fetchMock);
    const onStatusChange = jest.fn();
    const handle = startRealtimeClient({ onEvent: jest.fn(), onStatusChange, visibility: null });
    await jest.advanceTimersByTimeAsync(0);
    expect(onStatusChange).toHaveBeenCalledWith('connected');

    readers[0].end(); // server/network drops the connection
    await jest.advanceTimersByTimeAsync(0);
    expect(onStatusChange).toHaveBeenCalledWith('reconnecting');
    expect(fetchMock).toHaveBeenCalledTimes(1); // not yet retried — still inside the backoff window

    await jest.advanceTimersByTimeAsync(2000); // base backoff (1s) with up to 2x jitter covers this
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onStatusChange).toHaveBeenLastCalledWith('connected');
    handle.stop();
  });

  describe('C1b — terminal answers stop; 429 honours Retry-After', () => {
    it('a 204 (real-time disabled on the server) is `disabled` and never reconnects', async () => {
      fetchMock.mockResolvedValue(statusResponse(204));
      const onStatusChange = jest.fn();
      const handle = startRealtimeClient({ onEvent: jest.fn(), onStatusChange, visibility: null });
      await jest.advanceTimersByTimeAsync(10 * 60_000);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(onStatusChange).not.toHaveBeenCalledWith('connected');
      expect(onStatusChange).toHaveBeenLastCalledWith('disabled');
      handle.stop();
    });

    it.each([401, 403])('a %i stops (re-auth path) instead of reconnecting forever', async (status) => {
      fetchMock.mockResolvedValue(statusResponse(status));
      const onStatusChange = jest.fn();
      const handle = startRealtimeClient({ onEvent: jest.fn(), onStatusChange, visibility: null });
      await jest.advanceTimersByTimeAsync(10 * 60_000);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(onStatusChange).toHaveBeenLastCalledWith('unauthorized');
      handle.stop();
    });

    it('a 429 waits Retry-After (seconds) before the next attempt, not the 1 s backoff', async () => {
      fetchMock.mockResolvedValueOnce(statusResponse(429, '10'));
      streamingFetch(fetchMock); // later calls: a live stream
      const onStatusChange = jest.fn();
      const handle = startRealtimeClient({ onEvent: jest.fn(), onStatusChange, visibility: null, random: () => 0.5 });
      await jest.advanceTimersByTimeAsync(0);
      expect(onStatusChange).toHaveBeenLastCalledWith('limited');

      await jest.advanceTimersByTimeAsync(9_900);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1_200); // 10 s + 10 % jitter (random 0.5 × 20 %)
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(onStatusChange).toHaveBeenLastCalledWith('connected');
      handle.stop();
    });

    it('a 429 without Retry-After waits the 30 s default', async () => {
      fetchMock.mockResolvedValueOnce(statusResponse(429));
      streamingFetch(fetchMock);
      const handle = startRealtimeClient({ onEvent: jest.fn(), onStatusChange: jest.fn(), visibility: null, random: () => 0 });
      await jest.advanceTimersByTimeAsync(29_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1_500);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      handle.stop();
    });

    it('parseRetryAfter reads delta-seconds and HTTP dates', () => {
      const now = Date.parse('2026-10-31T10:00:00Z');
      expect(parseRetryAfter('7', now)).toBe(7_000);
      expect(parseRetryAfter('Sat, 31 Oct 2026 10:00:45 GMT', now)).toBe(45_000);
      expect(parseRetryAfter(null, now)).toBe(30_000);
      expect(parseRetryAfter('garbage', now)).toBe(30_000);
    });

    it('treats a 5xx as a connection failure and schedules a backoff reconnect', async () => {
      fetchMock.mockResolvedValueOnce(statusResponse(503));
      streamingFetch(fetchMock);
      const onStatusChange: jest.Mock<void, [RealtimeConnectionStatus]> = jest.fn();
      const handle = startRealtimeClient({ onEvent: jest.fn(), onStatusChange, visibility: null });
      await jest.advanceTimersByTimeAsync(0);
      expect(onStatusChange).toHaveBeenCalledWith('reconnecting');

      await jest.advanceTimersByTimeAsync(2000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      handle.stop();
    });
  });

  describe('C1b — backoff resets only after a sustained connection', () => {
    it('a stream that sends its `: connected` comment and closes at once keeps backing off (bytes alone never reset it)', async () => {
      fetchMock.mockImplementation(async () => {
        const fake = makeFakeReader();
        fake.push(': connected\n\n');
        fake.end();
        return { ok: true, status: 200, headers: { get: () => null }, body: { getReader: () => fake.reader } };
      });
      const handle = startRealtimeClient({ onEvent: jest.fn(), onStatusChange: jest.fn(), visibility: null });
      await jest.advanceTimersByTimeAsync(60_000);
      // Reset-on-any-frame reconnected ~40–60 times a minute here; bounded backoff (1,2,4,8,16,30 s) stays ≤ 8.
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(8);
      handle.stop();
    });

    it('a connection that genuinely held resets the backoff, so the next drop reconnects quickly', async () => {
      const readers = streamingFetch(fetchMock);
      const handle = startRealtimeClient({ onEvent: jest.fn(), onStatusChange: jest.fn(), visibility: null });
      await jest.advanceTimersByTimeAsync(0);
      // Fail a few times first so the backoff has grown.
      readers[0].end();
      await jest.advanceTimersByTimeAsync(1_000);
      readers[1].end();
      await jest.advanceTimersByTimeAsync(2_000);
      expect(fetchMock).toHaveBeenCalledTimes(3);

      // Hold, with keepalives, past STABLE_CONNECTION_MS.
      for (let t = 0; t < STABLE_CONNECTION_MS + 5_000; t += 20_000) {
        readers[2].push(': keepalive\n\n');
        await jest.advanceTimersByTimeAsync(20_000);
      }
      readers[2].end();
      await jest.advanceTimersByTimeAsync(1_000); // base 1 s backoff (≤ 1× jitter) — not the grown one
      expect(fetchMock).toHaveBeenCalledTimes(4);
      handle.stop();
    });
  });

  describe('C1b — watchdog', () => {
    it('no bytes for 2 × keepalive aborts the dead stream and reconnects', async () => {
      const readers = streamingFetch(fetchMock);
      const onStatusChange = jest.fn();
      const handle = startRealtimeClient({ onEvent: jest.fn(), onStatusChange, visibility: null });
      await jest.advanceTimersByTimeAsync(0);

      await jest.advanceTimersByTimeAsync(WATCHDOG_MS - 1_000);
      expect(readers[0].aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(1_500);
      expect(readers[0].aborted).toBe(true);
      expect(onStatusChange).toHaveBeenCalledWith('reconnecting');
      await jest.advanceTimersByTimeAsync(2_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      handle.stop();
    });

    it('keepalive comments keep a quiet stream alive indefinitely', async () => {
      const readers = streamingFetch(fetchMock);
      const handle = startRealtimeClient({ onEvent: jest.fn(), onStatusChange: jest.fn(), visibility: null });
      await jest.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 12; i++) {
        readers[0].push(': keepalive\n\n');
        await jest.advanceTimersByTimeAsync(25_000);
      }
      expect(readers[0].aborted).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      handle.stop();
    });
  });

  describe('C1b — hidden tab releases the stream', () => {
    it('hidden for more than 60 s releases the stream (paused); visible again reconnects at once', async () => {
      const readers = streamingFetch(fetchMock);
      const vis = fakeVisibility('visible');
      const onStatusChange = jest.fn();
      const handle = startRealtimeClient({ onEvent: jest.fn(), onStatusChange, visibility: vis.source });
      await jest.advanceTimersByTimeAsync(0);

      vis.set('hidden');
      readers[0].push(': keepalive\n\n');
      await jest.advanceTimersByTimeAsync(25_000);
      readers[0].push(': keepalive\n\n');
      await jest.advanceTimersByTimeAsync(HIDDEN_RELEASE_MS - 25_000 - 1_000); // 59 s hidden
      expect(readers[0].aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(2_000);
      expect(readers[0].aborted).toBe(true);
      expect(onStatusChange).toHaveBeenLastCalledWith('paused');

      await jest.advanceTimersByTimeAsync(10 * 60_000);
      expect(fetchMock).toHaveBeenCalledTimes(1); // no reconnect while hidden

      vis.set('visible');
      await jest.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(onStatusChange).toHaveBeenLastCalledWith('connected');
      handle.stop();
    });

    it('a short hide (< 60 s) keeps the stream', async () => {
      const readers = streamingFetch(fetchMock);
      const vis = fakeVisibility('visible');
      const handle = startRealtimeClient({ onEvent: jest.fn(), onStatusChange: jest.fn(), visibility: vis.source });
      await jest.advanceTimersByTimeAsync(0);
      vis.set('hidden');
      readers[0].push(': keepalive\n\n');
      await jest.advanceTimersByTimeAsync(30_000);
      vis.set('visible');
      readers[0].push(': keepalive\n\n');
      await jest.advanceTimersByTimeAsync(40_000);
      expect(readers[0].aborted).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      handle.stop();
    });

    it('stop() removes the visibility listener', () => {
      streamingFetch(fetchMock);
      const vis = fakeVisibility('visible');
      const handle = startRealtimeClient({ onEvent: jest.fn(), onStatusChange: jest.fn(), visibility: vis.source });
      expect(vis.listeners.size).toBe(1);
      handle.stop();
      expect(vis.listeners.size).toBe(0);
    });
  });

  it('stop() prevents any further reconnect attempt', async () => {
    const readers = streamingFetch(fetchMock);
    const onStatusChange = jest.fn();
    const handle = startRealtimeClient({ onEvent: jest.fn(), onStatusChange, visibility: null });
    await jest.advanceTimersByTimeAsync(0);
    handle.stop();
    expect(onStatusChange).toHaveBeenCalledWith('offline');

    readers[0].end();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1); // never retried post-stop
  });

  it('ignores a malformed (non-JSON) data frame without crashing the stream', async () => {
    const readers = streamingFetch(fetchMock);
    const onEvent = jest.fn();
    const handle = startRealtimeClient({ onEvent, onStatusChange: jest.fn(), visibility: null });
    await jest.advanceTimersByTimeAsync(0);

    readers[0].push('data: {not-json\n\n');
    await jest.advanceTimersByTimeAsync(0);
    expect(onEvent).not.toHaveBeenCalled();

    readers[0].push(sseFrame(envelope({ eventId: 'evt-after-malformed' })));
    await jest.advanceTimersByTimeAsync(0);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'evt-after-malformed' }));
    handle.stop();
  });
});
