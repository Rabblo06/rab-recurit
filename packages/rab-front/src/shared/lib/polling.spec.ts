import { focusManager, QueryClient, QueryObserver, type Query } from '@tanstack/react-query';
import {
  DEFAULT_RETRY_AFTER_MS,
  POLL_MAX_BACKOFF_MS,
  REALTIME_FALLBACK_POLL_MS,
  jittered,
  nextPollDelay,
  pollingOptions,
  refreshQuery,
  retryAfterMs,
  showsError,
} from './polling';

const tooMany = (retryAfter?: string) =>
  Object.assign(new Error('429'), { response: { status: 429, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter } } });
const serverError = () => Object.assign(new Error('503'), { response: { status: 503, headers: {} } });

function fakeQuery(state: Partial<Query['state']>): Query {
  return {
    state: { status: 'success', dataUpdatedAt: 1, errorUpdatedAt: 0, errorUpdateCount: 0, error: null, ...state },
  } as unknown as Query;
}

describe('showsError', () => {
  const refused = (status: number) => Object.assign(new Error(String(status)), { response: { status } });
  it('keeps data on a transient failure, drops it on a permanent refusal, errors when nothing is loaded', () => {
    expect(showsError({ isError: false, data: [1] })).toBe(false);
    expect(showsError({ isError: true, data: [1], error: refused(503) })).toBe(false);
    expect(showsError({ isError: true, data: [1], error: tooMany('5') })).toBe(false);
    for (const status of [401, 403, 404, 410]) expect(showsError({ isError: true, data: [1], error: refused(status) })).toBe(true);
    expect(showsError({ isError: true, data: undefined, error: refused(503) })).toBe(true);
  });
});

describe('jitter and Retry-After', () => {
  it('jitter stays within ±20 % of the interval', () => {
    expect(jittered(15_000, () => 0)).toBe(12_000);
    expect(jittered(15_000, () => 0.5)).toBe(15_000);
    expect(jittered(15_000, () => 0.999999)).toBeLessThanOrEqual(18_000);
    for (let i = 0; i < 200; i++) {
      const v = jittered(30_000);
      expect(v).toBeGreaterThanOrEqual(24_000);
      expect(v).toBeLessThanOrEqual(36_000);
    }
  });

  it('reads Retry-After as seconds or an HTTP date, 30 s when absent, and only for a 429', () => {
    expect(retryAfterMs(tooMany('7'))).toBe(7_000);
    const now = Date.parse('2030-01-01T00:00:00Z');
    expect(retryAfterMs(tooMany('Tue, 01 Jan 2030 00:01:30 GMT'), now)).toBe(90_000);
    expect(retryAfterMs(tooMany())).toBe(DEFAULT_RETRY_AFTER_MS);
    expect(retryAfterMs(serverError())).toBeNull();
    expect(retryAfterMs(new Error('network'))).toBeNull();
  });
});

describe('realtime-covered polls (C1b)', () => {
  it('slow to the 120 s fallback while realtime is live and use the normal interval otherwise', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const q = fakeQuery({});
    expect(pollingOptions(15_000).refetchInterval(q)).toBe(15_000);
    expect(pollingOptions(15_000, { realtimeLive: false }).refetchInterval(fakeQuery({}))).toBe(15_000);
    expect(pollingOptions(15_000, { realtimeLive: true }).refetchInterval(fakeQuery({}))).toBe(REALTIME_FALLBACK_POLL_MS);
    // A longer nominal interval is never shortened by realtime.
    expect(pollingOptions(300_000, { realtimeLive: true }).refetchInterval(fakeQuery({}))).toBe(300_000);
    jest.restoreAllMocks();
  });
});

describe('nextPollDelay', () => {
  it('is the jittered base interval after a success and stays stable until the query changes', () => {
    const q = fakeQuery({});
    const first = nextPollDelay(q, 15_000);
    expect(first).toBeGreaterThanOrEqual(12_000);
    expect(first).toBeLessThanOrEqual(18_000);
    for (let i = 0; i < 20; i++) expect(nextPollDelay(q, 15_000)).toBe(first);
  });

  it('backs off ×2 per consecutive failure, capped at 5 minutes, and resets after a success', () => {
    const mid = () => 0.5;
    const ok = fakeQuery({ status: 'success', errorUpdateCount: 0 });
    expect(nextPollDelay(ok, 15_000, mid)).toBe(15_000);
    const failing = fakeQuery({ status: 'error', error: serverError(), errorUpdateCount: 1, errorUpdatedAt: 2 });
    expect(nextPollDelay(failing, 15_000, mid)).toBe(30_000);
    (failing.state as { errorUpdateCount: number; errorUpdatedAt: number }).errorUpdateCount = 3;
    (failing.state as { errorUpdatedAt: number }).errorUpdatedAt = 3;
    expect(nextPollDelay(failing, 15_000, mid)).toBe(120_000);
    (failing.state as { errorUpdateCount: number }).errorUpdateCount = 12;
    (failing.state as { errorUpdatedAt: number }).errorUpdatedAt = 4;
    expect(nextPollDelay(failing, 15_000, mid)).toBe(POLL_MAX_BACKOFF_MS);
    // A success resets the count; the next failure starts at ×2 again.
    Object.assign(failing.state, { status: 'success', dataUpdatedAt: 5 });
    expect(nextPollDelay(failing, 15_000, mid)).toBe(15_000);
    Object.assign(failing.state, { status: 'error', errorUpdateCount: 13, errorUpdatedAt: 6 });
    expect(nextPollDelay(failing, 15_000, mid)).toBe(30_000);
  });

  it('after a 429 waits at least Retry-After (never earlier, jitter only later)', () => {
    const q = fakeQuery({ status: 'error', error: tooMany('120'), errorUpdateCount: 1, errorUpdatedAt: 2 });
    expect(nextPollDelay(q, 15_000, () => 0)).toBe(120_000);
    const q2 = fakeQuery({ status: 'error', error: tooMany(), errorUpdateCount: 1, errorUpdatedAt: 2 });
    const d = nextPollDelay(q2, 15_000, () => 0.999);
    expect(d).toBeGreaterThanOrEqual(DEFAULT_RETRY_AFTER_MS);
    expect(d).toBeLessThanOrEqual(DEFAULT_RETRY_AFTER_MS * 1.2);
  });
});

describe('pollingOptions with a real QueryClient (fake timers)', () => {
  let qc: QueryClient;
  let unsubscribe: () => void = () => {};

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5); // jitter factor exactly 1
    qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } } });
    qc.mount();
    focusManager.setFocused(true);
  });
  afterEach(() => {
    unsubscribe();
    qc.unmount();
    qc.clear();
    focusManager.setFocused(undefined);
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  function observe(queryFn: () => Promise<unknown>, base = 15_000) {
    const observer = new QueryObserver(qc, { queryKey: ['poll-test'], queryFn, ...pollingOptions(base) });
    unsubscribe = observer.subscribe(() => undefined);
    return observer;
  }
  const flush = async (ms = 0) => {
    await jest.advanceTimersByTimeAsync(ms);
  };

  it('polls on the jittered interval, never before it', async () => {
    const fn = jest.fn().mockResolvedValue({ ok: 1 });
    observe(fn);
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
    await flush(14_900);
    expect(fn).toHaveBeenCalledTimes(1);
    await flush(200);
    expect(fn).toHaveBeenCalledTimes(2);
    await flush(15_000);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('pauses while the tab is hidden and refreshes once when it becomes visible', async () => {
    const fn = jest.fn().mockResolvedValue({ ok: 1 });
    observe(fn);
    await flush();
    focusManager.setFocused(false);
    await flush(120_000);
    expect(fn).toHaveBeenCalledTimes(1);
    focusManager.setFocused(true);
    await flush();
    expect(fn).toHaveBeenCalledTimes(2);
    // Then back on the normal cadence, measured from the catch-up.
    await flush(14_000);
    expect(fn).toHaveBeenCalledTimes(2);
    await flush(1_100);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('never overlaps: a slow request is not joined by another poll', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    const fn = jest.fn().mockResolvedValueOnce({ ok: 1 }).mockImplementation(() => new Promise((r) => (resolve = r)));
    observe(fn);
    await flush();
    await flush(15_000);
    expect(fn).toHaveBeenCalledTimes(2); // in flight, never answered yet
    await flush(60_000);
    expect(fn).toHaveBeenCalledTimes(2);
    resolve({ ok: 2 });
    await flush();
    await flush(15_000);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('after a 429 waits Retry-After before the next poll, and the visible catch-up respects it too', async () => {
    const fn = jest.fn().mockResolvedValueOnce({ ok: 1 }).mockRejectedValueOnce(tooMany('120')).mockResolvedValue({ ok: 2 });
    observe(fn);
    await flush();
    await flush(15_000);
    expect(fn).toHaveBeenCalledTimes(2); // the 429
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await flush(119_000);
    expect(fn).toHaveBeenCalledTimes(2);
    await flush(25_000); // Retry-After 120 s, plus at most 20 % jitter (10 % here)
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('keeps the last data when a background refresh fails (refetch error, not an empty list)', async () => {
    const fn = jest.fn().mockResolvedValueOnce({ rows: [1, 2] }).mockRejectedValueOnce(serverError());
    const observer = observe(fn);
    await flush();
    await flush(15_000);
    const result = observer.getCurrentResult();
    expect(result.data).toEqual({ rows: [1, 2] });
    expect(result.isRefetchError).toBe(true);
    // ×2 backoff after the failure: nothing at +15 s, the retry by +30 s.
    fn.mockResolvedValue({ rows: [1, 2, 3] });
    await flush(15_000);
    expect(fn).toHaveBeenCalledTimes(2);
    await flush(15_100);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(observer.getCurrentResult().data).toEqual({ rows: [1, 2, 3] });
  });

  it('refreshQuery waits for an in-flight poll, then fetches exactly once (queued, coalesced, never dropped)', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    const fn = jest.fn().mockResolvedValueOnce({ v: 1 }).mockImplementationOnce(() => new Promise((r) => (resolve = r))).mockResolvedValue({ v: 3 });
    const observer = observe(fn);
    await flush();
    await flush(15_000);
    expect(fn).toHaveBeenCalledTimes(2); // poll in flight
    const a = refreshQuery(qc, ['poll-test']);
    const b = refreshQuery(qc, ['poll-test']);
    await flush(5);
    expect(fn).toHaveBeenCalledTimes(2); // queued behind the poll, not cancelling it
    resolve({ v: 2 });
    await flush();
    await Promise.all([a, b]);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(observer.getCurrentResult().data).toEqual({ v: 3 });
  });

  it('stops polling on a permanent refusal (403/404): asking again cannot change the answer', async () => {
    const fn = jest.fn().mockResolvedValueOnce({ ok: 1 }).mockRejectedValue(Object.assign(new Error('404'), { response: { status: 404 } }));
    observe(fn);
    await flush();
    await flush(15_000);
    expect(fn).toHaveBeenCalledTimes(2);
    await flush(600_000);
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await flush();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('a function base pauses the poll (false) and the catch-up with it', async () => {
    let active = true;
    const fn = jest.fn().mockResolvedValue({ ok: 1 });
    const observer = new QueryObserver(qc, { queryKey: ['poll-fn'], queryFn: fn, ...pollingOptions(() => (active ? 2_000 : false)) });
    unsubscribe = observer.subscribe(() => undefined);
    await flush();
    await flush(2_000);
    expect(fn).toHaveBeenCalledTimes(2);
    active = false;
    await flush(2_000); // the already-armed tick still runs once and re-arms with `false`
    const settled = fn.mock.calls.length;
    await flush(60_000);
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await flush();
    expect(fn).toHaveBeenCalledTimes(settled);
  });
});
