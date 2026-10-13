import { getIdentitySnapshot, getSessionId } from './auth-session';
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

export type RealtimeConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline';

export interface RealtimeClientHandle {
  stop: () => void;
}

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;
/** A stream that ends sooner than this without delivering a frame counts as a failed attempt, so a
 * server that keeps accepting and immediately closing grows the backoff instead of resetting it. */
export const STABLE_CONNECTION_MS = 10_000;
const DEDUP_WINDOW_SIZE = 200;

export function startRealtimeClient(opts: { onEvent: (envelope: RealtimeEnvelope) => void; onStatusChange: (status: RealtimeConnectionStatus) => void }): RealtimeClientHandle {
  let stopped = false;
  let attempt = 0;
  let controller: AbortController | null = null;
  const seenEventIds: string[] = [];
  const seenEventIdSet = new Set<string>();

  function scheduleReconnect(): void {
    if (stopped) return;
    attempt += 1;
    // Bounded exponential backoff with jitter — never a tight retry loop hammering a struggling
    // API, and never every tab reconnecting in lockstep on the same schedule.
    const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
    const jitterMs = backoff * (0.5 + Math.random() * 0.5);
    opts.onStatusChange('reconnecting');
    setTimeout(() => {
      if (!stopped) void connect();
    }, jitterMs);
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    // Captured ONCE, at the start of THIS connection attempt — never re-read mid-stream except to
    // compare against. A tab that logs out, logs in as someone else, or has its ambient identity
    // changed by another tab (the exact scenario `auth-session.ts`'s own `generation` counter
    // exists for) must never let an in-flight stream keep delivering/acting on events captured
    // under the OLD identity — mirrors `shouldAcceptResponse`'s fencing idea, applied to a
        // long-lived stream instead of one request/response pair.
    const connectGeneration = getIdentitySnapshot().generation;
    if (getIdentitySnapshot().userId === null) {
      opts.onStatusChange('offline');
      return; // not authenticated — the provider restarts this once auth status changes
    }

    controller = new AbortController();
    opts.onStatusChange('connecting');
    try {
      const sid = getSessionId();
      const response = await fetch(`${api.defaults.baseURL}/realtime/stream`, {
        method: 'GET',
        credentials: 'include',
        headers: {
          Accept: 'text/event-stream',
          ...(sid ? { 'X-Crewflow-Expected-Session-Id': sid } : {}),
        },
        signal: controller.signal,
      });
      // 204: the server has real-time updates switched off — there is no stream to reconnect to.
      if (response.status === 204) {
        opts.onStatusChange('offline');
        return;
      }
      if (!response.ok || !response.body) {
        scheduleReconnect();
        return;
      }
      opts.onStatusChange('connected');
      const openedAt = Date.now();
      let receivedFrame = false;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedFrame = true;
        if (getIdentitySnapshot().generation !== connectGeneration) {
          controller.abort();
          return; // identity moved on while this read was in flight — discard, never deliver stale-identity data
        }
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        // eslint-disable-next-line no-cond-assign
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = raw.split('\n').find((line) => line.startsWith('data:'));
          if (!dataLine) continue;
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
            controller.abort();
            return;
          }
          opts.onEvent(envelope);
        }
      }
      // Only a connection that genuinely held (or delivered data) resets the backoff.
      if (receivedFrame || Date.now() - openedAt >= STABLE_CONNECTION_MS) attempt = 0;
      if (!stopped) scheduleReconnect();
    } catch {
      if (!stopped) scheduleReconnect();
    }
  }

  void connect();

  return {
    stop: () => {
      stopped = true;
      controller?.abort();
      opts.onStatusChange('offline');
    },
  };
}
