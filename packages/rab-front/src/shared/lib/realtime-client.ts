import { getIdentitySnapshot, getSessionId } from './auth-session';
import { BACKGROUND_REQUEST_HEADER } from './user-activity';
import { api } from '../api';

/**
 * Stage 4 — the React Manager Web real-time client. Mirrors Stage 3's own test-harness SSE parser
 * (`realtime-gateway.integration.spec.ts`) byte-for-byte on the wire format, since both sides parse
 * the exact same `text/event-stream` frames the gateway controller writes.
 *
 * `fetch` + a manual `ReadableStream` reader, deliberately NOT the browser's native `EventSource`:
 * `EventSource` cannot send a custom header, and this app's existing cross-tab/session-identity
 * fencing (`X-Crewflow-Expected-Session-Id`, see `api.ts`'s own request interceptor and
 * `jwt-auth.guard.ts`'s server-side check) is a HEADER — `fetch` can attach it directly, reusing
 * the EXACT SAME server-side protection every other authenticated request already gets, with zero
 * new backend code. `EventSource` would have needed a workaround; `fetch` doesn't.
 *
 * `credentials: 'include'` sends the `crewflow_session` HttpOnly cookie automatically, same as
 * every other request `api.ts` makes — no token is ever read or attached by this file for the web
 * path (this package has no Bearer-JWT concept at all; that's mobile's own, separate credential).
 *
 * Phase C1b connection lifecycle (`c1-API-CONTRACT.md` §4):
 *  - 204 → `disabled`: real-time is off on the server; stop until a new session/identity (the provider restarts us).
 *  - 401/403 → `unauthorized`: stop; the app's ordinary re-auth path (the API interceptor on the next request, or a
 *    new login, which changes the identity generation) is what brings a stream back — never a retry loop.
 *  - 429 → `limited`: the per-user stream cap is reached (other tabs hold the slots); wait `Retry-After` (seconds or
 *    HTTP date, 30 s when absent, plus 0–20 % jitter), then try again. Polling keeps this tab current meanwhile.
 *  - anything else (network error, 5xx, a stream that ends) → `reconnecting` with bounded, jittered exponential backoff
 *    (1 s → 30 s). The backoff resets only after a connection has held for `STABLE_CONNECTION_MS`, never merely because
 *    bytes arrived — the server writes a `: connected` comment at once, so "received a frame" proves nothing.
 *  - watchdog: the server writes a `: keepalive` comment at least every `KEEPALIVE_MS`; no bytes at all for
 *    `WATCHDOG_MS` (2 × keepalive) means a dead stream a proxy forgot to close → abort and reconnect.
 *  - hidden tab: hidden for `HIDDEN_RELEASE_MS` → the stream is released (`paused`, freeing a server slot and a socket);
 *    visible again → reconnect at once (the provider reconciles, since events raised meanwhile were never delivered).
 *  - every connect is sent as background traffic (`X-Crewflow-Background: 1`): opening or re-opening a stream is never
 *    user activity, so it can never slide the session idle window (CF-20).
 *
 * One stream per tab: the provider mounts once in `App.tsx` and owns exactly one handle. Several tabs each hold their
 * own stream (the server caps them per user, `REALTIME_MAX_CONNECTIONS_PER_USER`; a tab over the cap is `limited` and
 * keeps polling), and a hidden tab gives its slot back after a minute.
 */

export interface RealtimeEnvelope {
  version: number;
  eventId: string;
  type: string;
  organisationId: string;
  workspaceId: string | null;
  targetUserId: string | null;
  entityId: string;
  occurredAt: string;
}

export type RealtimeConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'offline'
  /** Released while the tab is hidden; reconnects when it is visible again. */
  | 'paused'
  /** 429: the per-user stream cap is reached; retrying after Retry-After. */
  | 'limited'
  /** 204: real-time is switched off on the server. */
  | 'disabled'
  /** 401/403: the session no longer authorises a stream; waits for re-authentication. */
  | 'unauthorized';

export interface RealtimeClientHandle {
  stop: () => void;
}

/** The slice of `document` the client needs (injectable for tests; `null` disables hidden-tab release). */
export interface VisibilitySource {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;
/** A connection must hold this long before the backoff resets — a server that keeps accepting and immediately closing grows the backoff instead. */
export const STABLE_CONNECTION_MS = 30_000;
/** The server's keepalive cadence (contract: at least every 25 s). */
export const KEEPALIVE_MS = 25_000;
/** No bytes for this long ⇒ the stream is dead even though nothing closed it. */
export const WATCHDOG_MS = 2 * KEEPALIVE_MS;
/** A tab hidden this long releases its stream. */
export const HIDDEN_RELEASE_MS = 60_000;
export const DEFAULT_RETRY_AFTER_MS = 30_000;
/** Extra wait added on top of a 429 Retry-After (0–20 %), so tabs refused together do not all return together. */
const RETRY_AFTER_JITTER = 0.2;
const DEDUP_WINDOW_SIZE = 200;

/** Retry-After as milliseconds: delta-seconds or an HTTP date; 30 s when absent or unreadable. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number {
  const text = (value ?? '').trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  if (text) {
    const at = Date.parse(text);
    if (!Number.isNaN(at)) return Math.max(0, at - now);
  }
  return DEFAULT_RETRY_AFTER_MS;
}

// ---------------------------------------------------------------------------------------- status store
// The ONE live status of this tab's stream, readable outside React (e.g. by a poll interval deciding whether to slow
// down while events are flowing). `useRealtimeStatus()` reads the same value through the provider.
let currentStatus: RealtimeConnectionStatus = 'offline';
const statusListeners = new Set<() => void>();

export function getRealtimeStatus(): RealtimeConnectionStatus {
  return currentStatus;
}

/** True only while a stream is open and delivering — the signal a covered poll may slow down on. */
export function isRealtimeLive(): boolean {
  return currentStatus === 'connected';
}

/** Subscribe to status changes; returns the unsubscribe function. */
export function subscribeToRealtimeStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

function publishRealtimeStatus(status: RealtimeConnectionStatus): void {
  if (status === currentStatus) return;
  currentStatus = status;
  for (const listener of [...statusListeners]) listener();
}

type Timer = ReturnType<typeof setTimeout> | null;

export function startRealtimeClient(opts: {
  onEvent: (envelope: RealtimeEnvelope) => void;
  onStatusChange: (status: RealtimeConnectionStatus) => void;
  /** Defaults to `document`; pass `null` to opt out of hidden-tab release. */
  visibility?: VisibilitySource | null;
  random?: () => number;
}): RealtimeClientHandle {
  const random = opts.random ?? Math.random;
  const visibility = opts.visibility === undefined ? (typeof document === 'undefined' ? null : document) : opts.visibility;
  let stopped = false;
  let paused = false;
  let attempt = 0;
  let controller: AbortController | null = null;
  let retryTimer: Timer = null;
  let hiddenTimer: Timer = null;
  let watchdogTimer: Timer = null;
  let stableTimer: Timer = null;
  const seenEventIds: string[] = [];
  const seenEventIdSet = new Set<string>();

  function setStatus(status: RealtimeConnectionStatus): void {
    publishRealtimeStatus(status);
    opts.onStatusChange(status);
  }

  function clear(timer: Timer): null {
    if (timer) clearTimeout(timer);
    return null;
  }

  function scheduleRetry(delayMs: number, status: RealtimeConnectionStatus): void {
    if (stopped || paused) return;
    setStatus(status);
    retryTimer = clear(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, delayMs);
  }

  function scheduleReconnect(): void {
    attempt += 1;
    // Bounded exponential backoff with jitter — never a tight retry loop hammering a struggling
    // API, and never every tab reconnecting in lockstep on the same schedule.
    const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
    scheduleRetry(backoff * (0.5 + random() * 0.5), 'reconnecting');
  }

  function armWatchdog(own: AbortController): void {
    watchdogTimer = clear(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      watchdogTimer = null;
      own.abort(); // the pending read rejects → handled as a drop → backoff reconnect
    }, WATCHDOG_MS);
  }

  /** Closes the current stream (if any) and every timer tied to it; never schedules anything. */
  function release(): void {
    retryTimer = clear(retryTimer);
    watchdogTimer = clear(watchdogTimer);
    stableTimer = clear(stableTimer);
    const current = controller;
    controller = null;
    current?.abort();
  }

  function afterDrop(own: AbortController): void {
    if (controller !== own) return; // released/stopped/superseded on purpose — not a drop
    controller = null;
    watchdogTimer = clear(watchdogTimer);
    stableTimer = clear(stableTimer);
    if (!stopped && !paused) scheduleReconnect();
  }

  async function connect(): Promise<void> {
    if (stopped || paused) return;
    // Captured ONCE, at the start of THIS connection attempt — never re-read mid-stream except to
    // compare against. A tab that logs out, logs in as someone else, or has its ambient identity
    // changed by another tab (the exact scenario `auth-session.ts`'s own `generation` counter
    // exists for) must never let an in-flight stream keep delivering/acting on events captured
    // under the OLD identity — mirrors `shouldAcceptResponse`'s fencing idea, applied to a
    // long-lived stream instead of one request/response pair.
    const connectGeneration = getIdentitySnapshot().generation;
    if (getIdentitySnapshot().userId === null) {
      setStatus('offline');
      return; // not authenticated — the provider restarts this once auth status changes
    }

    const own = new AbortController();
    controller = own;
    setStatus(attempt === 0 ? 'connecting' : 'reconnecting');
    try {
      const sid = getSessionId();
      const response = await fetch(`${api.defaults.baseURL}/realtime/stream`, {
        method: 'GET',
        credentials: 'include',
        headers: {
          Accept: 'text/event-stream',
          // Opening a stream is never user activity: it must not slide the session idle window (CF-20).
          [BACKGROUND_REQUEST_HEADER]: '1',
          ...(sid ? { 'X-Crewflow-Expected-Session-Id': sid } : {}),
        },
        signal: own.signal,
      });
      if (controller !== own) return; // released or stopped while the request was in flight
      // 204: the server has real-time updates switched off — there is no stream to reconnect to.
      if (response.status === 204) {
        controller = null;
        setStatus('disabled');
        return;
      }
      if (response.status === 401 || response.status === 403) {
        controller = null;
        setStatus('unauthorized');
        return;
      }
      if (response.status === 429) {
        controller = null;
        const wait = parseRetryAfter(response.headers?.get?.('Retry-After'));
        scheduleRetry(wait + wait * RETRY_AFTER_JITTER * random(), 'limited');
        return;
      }
      if (!response.ok || !response.body) {
        afterDrop(own);
        return;
      }
      setStatus('connected');
      armWatchdog(own);
      // Only a connection that genuinely HELD resets the backoff (see the file comment).
      stableTimer = clear(stableTimer);
      stableTimer = setTimeout(() => {
        stableTimer = null;
        attempt = 0;
      }, STABLE_CONNECTION_MS);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (controller !== own) return;
        armWatchdog(own); // any byte — an event or a keepalive comment — proves the stream is alive
        if (getIdentitySnapshot().generation !== connectGeneration) {
          own.abort();
          return; // identity moved on while this read was in flight — discard, never deliver stale-identity data
        }
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        // eslint-disable-next-line no-cond-assign
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = raw.split('\n').find((line) => line.startsWith('data:'));
          if (!dataLine) continue; // a `: keepalive` / `: connected` comment, or an empty frame
          let envelope: RealtimeEnvelope;
          try {
            envelope = JSON.parse(dataLine.slice(5).trim());
          } catch {
            continue; // malformed frame — drop, never crash the stream over it
          }
          if (seenEventIdSet.has(envelope.eventId)) continue; // at-least-once duplicate, already handled
          seenEventIdSet.add(envelope.eventId);
          seenEventIds.push(envelope.eventId);
          if (seenEventIds.length > DEDUP_WINDOW_SIZE) seenEventIdSet.delete(seenEventIds.shift()!);
          if (getIdentitySnapshot().generation !== connectGeneration) {
            own.abort();
            return;
          }
          opts.onEvent(envelope);
        }
      }
      afterDrop(own);
    } catch {
      afterDrop(own);
    }
  }

  function onVisibilityChange(): void {
    if (stopped || !visibility) return;
    if (visibility.visibilityState === 'hidden') {
      if (!hiddenTimer && !paused) {
        hiddenTimer = setTimeout(() => {
          hiddenTimer = null;
          if (stopped || visibility.visibilityState !== 'hidden') return;
          paused = true;
          release();
          setStatus('paused');
        }, HIDDEN_RELEASE_MS);
      }
      return;
    }
    hiddenTimer = clear(hiddenTimer);
    if (paused) {
      paused = false;
      attempt = 0; // a deliberate release is not a failure
      void connect();
    }
  }

  visibility?.addEventListener('visibilitychange', onVisibilityChange);
  if (visibility?.visibilityState === 'hidden') onVisibilityChange();
  void connect();

  return {
    stop: () => {
      stopped = true;
      hiddenTimer = clear(hiddenTimer);
      visibility?.removeEventListener('visibilitychange', onVisibilityChange);
      release();
      setStatus('offline');
    },
  };
}
