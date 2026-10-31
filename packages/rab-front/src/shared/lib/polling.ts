import { hashKey, type Query, type QueryClient, type QueryKey } from '@tanstack/react-query';

/**
 * Phase C1 — the shared polling policy for the web console, applied on top of TanStack Query's own `refetchInterval`.
 *
 * What TanStack already gives us (verified against query-core 5.101's QueryObserver):
 * - an interval tick is skipped while the tab is hidden (`refetchIntervalInBackground: false`);
 * - an interval tick never starts a second request while one is in flight (it joins the running fetch);
 * - the interval is re-armed after every query update, so the next poll is measured from the last result.
 *
 * What this module adds:
 * - ±20 % jitter, stable within one cycle (a re-render must not re-arm the timer with a new random value, or a busy
 *   screen would never poll at all);
 * - backoff: HTTP 429 waits `Retry-After` (seconds or HTTP date, 30 s when absent, never earlier); any other failure
 *   doubles the interval per consecutive failure, capped at 5 minutes, and resets after the next success;
 * - one catch-up refresh when the tab becomes visible again (the app keeps `refetchOnWindowFocus: false` globally;
 *   only polled queries opt in, and only while their poll is active and not inside a Retry-After window);
 * - `refreshQuery`: a refresh after the user's own action that waits for an in-flight poll and then runs once
 *   (queued, never dropped), coalescing duplicate requests raised by the same action.
 *
 * Interval-driven requests are marked as background traffic by the existing CF-20 mechanism (`user-activity.ts`): any
 * request sent after 60 s without real input carries `X-Crewflow-Background: 1`, so an abandoned tab's polls never
 * slide the session idle window. A poll sent while the person is actively using the tab is not marked; that is the
 * same rule every other request follows, and it can only keep alive a session somebody is really using.
 */

export const POLL_JITTER = 0.2;
export const POLL_MAX_BACKOFF_MS = 5 * 60_000;
export const DEFAULT_RETRY_AFTER_MS = 30_000;
/** Shown next to data that is still on screen when a background refresh failed (never an error page). */
export const REFRESH_FAILED_NOTE = 'Couldn’t refresh. Showing the last loaded data.';

/** `ms` scaled by a random factor in [1 − POLL_JITTER, 1 + POLL_JITTER]. */
export function jittered(ms: number, random: () => number = Math.random): number {
  return Math.round(ms * (1 - POLL_JITTER + 2 * POLL_JITTER * random()));
}

/** For an HTTP 429 answer: how long the server asked us to wait (Retry-After seconds or HTTP date; 30 s when absent). */
export function retryAfterMs(error: unknown, now: number = Date.now()): number | null {
  const response = (error as { response?: { status?: number; headers?: unknown } } | null | undefined)?.response;
  if (response?.status !== 429) return null;
  const headers = response.headers as { get?: (name: string) => unknown; [name: string]: unknown } | undefined;
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'] ?? (typeof headers?.get === 'function' ? headers.get('retry-after') : undefined);
  const text = raw == null ? '' : String(raw).trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  if (text) {
    const at = Date.parse(text);
    if (!Number.isNaN(at)) return Math.max(0, at - now);
  }
  return DEFAULT_RETRY_AFTER_MS;
}

/**
 * A refusal that will not change by asking again (401/403/404/410: signed out, no permission, outside the caller's
 * scope, gone). A poll stops on it, and a screen does not keep showing data it has just been refused.
 */
export function isPermanentRefusal(error: unknown): boolean {
  const status = (error as { response?: { status?: number } } | null | undefined)?.response?.status;
  return status === 401 || status === 403 || status === 404 || status === 410;
}

/**
 * True when a query's error must replace its data on screen: nothing loaded yet, or a permanent refusal (a screen never
 * keeps showing data the server has just refused). Any other failure keeps the last data with `REFRESH_FAILED_NOTE`.
 */
export function showsError(query: { isError: boolean; data?: unknown; error?: unknown }): boolean {
  return query.isError && (query.data === undefined || isPermanentRefusal(query.error));
}

// Per-query state lives here (not in a closure) so `pollingOptions(...)` may be called inline on every render.
const errorCountAtLastSuccess = new WeakMap<Query<any, any, any, any>, number>();
const stableDelays = new WeakMap<Query<any, any, any, any>, Map<string, { stamp: string; value: number }>>();

/** Consecutive failed fetches since the last success (0 while the latest outcome is a success). */
export function consecutiveFailures(query: Query<any, any, any, any>): number {
  const { status, errorUpdateCount } = query.state;
  if (status !== 'error') {
    errorCountAtLastSuccess.set(query, errorUpdateCount);
    return 0;
  }
  return Math.max(1, errorUpdateCount - (errorCountAtLastSuccess.get(query) ?? 0));
}

/** The next delay for a poll with base interval `baseMs`, before jitter. */
function plannedDelay(query: Query<any, any, any, any>, baseMs: number, now: number): { ms: number; retryAfter: boolean } {
  const failures = consecutiveFailures(query);
  if (failures === 0) return { ms: baseMs, retryAfter: false };
  const wait = retryAfterMs(query.state.error, now);
  if (wait != null) return { ms: Math.max(wait, Math.min(baseMs, POLL_MAX_BACKOFF_MS)), retryAfter: true };
  return { ms: Math.min(baseMs * 2 ** failures, POLL_MAX_BACKOFF_MS), retryAfter: false };
}

/**
 * The jittered delay before the next poll. Stable for one query state (same result until the query updates), so it can
 * be returned from `refetchInterval` on every render without re-arming the timer.
 */
export function nextPollDelay(query: Query<any, any, any, any>, baseMs: number, random: () => number = Math.random, now: number = Date.now()): number {
  const { status, dataUpdatedAt, errorUpdatedAt, errorUpdateCount } = query.state;
  const stamp = `${status}|${dataUpdatedAt}|${errorUpdatedAt}|${errorUpdateCount}`;
  let perBase = stableDelays.get(query);
  if (!perBase) stableDelays.set(query, (perBase = new Map()));
  const key = String(baseMs);
  const cached = perBase.get(key);
  if (cached && cached.stamp === stamp) return cached.value;
  const planned = plannedDelay(query, baseMs, now);
  // Retry-After is a floor: jitter only ever pushes that wait later, so clients behind one IP do not return together.
  const value = planned.retryAfter
    ? Math.round(planned.ms * (1 + POLL_JITTER * random()))
    : Math.min(jittered(planned.ms, random), Math.round(POLL_MAX_BACKOFF_MS * (1 + POLL_JITTER)));
  perBase.set(key, { stamp, value });
  return value;
}

/** True while a 429's Retry-After window from the latest failure has not elapsed yet. */
function insideRetryAfter(query: Query<any, any, any, any>, now: number): boolean {
  if (query.state.status !== 'error') return false;
  const wait = retryAfterMs(query.state.error, query.state.errorUpdatedAt || now);
  return wait != null && now < query.state.errorUpdatedAt + wait;
}

export type PollBase<TQuery> = number | ((query: TQuery) => number | false | undefined);

/** Phase C1b: while this tab's realtime stream is live, a poll covered by realtime events slows to this fallback. */
export const REALTIME_FALLBACK_POLL_MS = 120_000;

export interface PollingOptionsConfig {
  /**
   * Pass `useIsRealtimeLive()` for a poll whose data realtime events invalidate. While true the interval is at least
   * `REALTIME_FALLBACK_POLL_MS`; the component re-renders when the stream drops, TanStack recomputes the interval, and
   * the normal C1a rate resumes at once (no extra request).
   */
  realtimeLive?: boolean;
}

/**
 * Query options implementing the polling policy. `base` is the nominal interval, or a function of the query returning
 * the interval or `false` (poll paused, e.g. nothing pending any more). A permanent refusal (`isPermanentRefusal`) stops
 * the poll until something else (a manual retry, a navigation) fetches again. Spread into `useQuery({...})`.
 */
export function pollingOptions<TQuery extends Query<any, any, any, any>>(base: PollBase<TQuery>, config: PollingOptionsConfig = {}) {
  const baseOf = (query: TQuery): number | false => {
    if (query.state.status === 'error' && isPermanentRefusal(query.state.error)) return false;
    const value = typeof base === 'function' ? base(query) : base;
    if (typeof value !== 'number' || value <= 0) return false;
    return config.realtimeLive ? Math.max(value, REALTIME_FALLBACK_POLL_MS) : value;
  };
  return {
    refetchInterval: (query: TQuery): number | false => {
      const ms = baseOf(query);
      return ms === false ? false : nextPollDelay(query, ms);
    },
    refetchIntervalInBackground: false,
    // Catch-up: one refresh when the tab becomes visible again, while the poll is active and not told to wait.
    refetchOnWindowFocus: (query: TQuery): boolean | 'always' =>
      baseOf(query) !== false && !insideRetryAfter(query, Date.now()) ? 'always' : false,
  } as const;
}

/** Settling poll for a short-lived server state (an invitation email being queued/sent): 2 → 4 → 8 → 15 s. */
export const SETTLING_STEPS_MS = [2_000, 4_000, 8_000, 15_000] as const;
/** A settling poll gives up after this long; the row then updates on the next manual refresh or navigation. */
export const SETTLING_WINDOW_MS = 3 * 60_000;

/**
 * When the query last got an answer (data or error), or now if it never did. A time-based poll interval must be computed
 * from this, never from the current time: `refetchInterval` is re-evaluated on every render, and a value that drifts
 * between renders re-arms the timer (a busy screen would then never poll).
 */
export function lastAnsweredAt(query: Query<any, any, any, any>): number {
  return Math.max(query.state.dataUpdatedAt, query.state.errorUpdatedAt) || Date.now();
}

/**
 * The next settling-poll interval, `startedAt` being when the pending state was first seen and `now` the last answer
 * (`lastAnsweredAt`): 2 s, then 4 s, 8 s and 15 s thereafter (step boundaries at half a step, so ±20 % jitter never
 * repeats or skips a step), `false` once 3 minutes have passed.
 */
export function settlingInterval(startedAt: number, now: number = Date.now()): number | false {
  const elapsed = now - startedAt;
  if (elapsed >= SETTLING_WINDOW_MS) return false;
  let boundary = 0;
  for (const step of SETTLING_STEPS_MS) {
    if (elapsed < boundary + step / 2) return step;
    boundary += step;
  }
  return SETTLING_STEPS_MS[SETTLING_STEPS_MS.length - 1];
}

// One pending refresh per (client, query key): later requests join it until its fetch has started.
const pendingRefreshes = new WeakMap<QueryClient, Map<string, Promise<void>>>();

/**
 * Refreshes `queryKey` after the user's own action, never waiting for the next poll. If a fetch for it is in flight
 * (e.g. a poll that started before the action was committed), this waits for it and then fetches once more (queued,
 * never dropped). Requests raised by the same action (e.g. a mutation's success and the event it dispatches) arrive in
 * the same task and are coalesced into one refresh.
 */
export function refreshQuery(qc: QueryClient, queryKey: QueryKey): Promise<void> {
  let perClient = pendingRefreshes.get(qc);
  if (!perClient) pendingRefreshes.set(qc, (perClient = new Map()));
  const key = hashKey(queryKey);
  const existing = perClient.get(key);
  if (existing) return existing;
  const pending = perClient;
  const run = (async () => {
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const inFlight = qc
        .getQueryCache()
        .findAll({ queryKey })
        .filter((q) => q.state.fetchStatus === 'fetching')
        .map((q) => q.promise);
      await Promise.allSettled(inFlight);
    } finally {
      pending.delete(key);
    }
    await qc.invalidateQueries({ queryKey });
  })();
  pending.set(key, run);
  return run;
}
