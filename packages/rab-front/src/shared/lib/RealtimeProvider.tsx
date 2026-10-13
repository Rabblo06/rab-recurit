import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useSessionStatus } from './SessionProvider';
import { getIdentitySnapshot, subscribeToSession } from './auth-session';
import { startRealtimeClient, type RealtimeConnectionStatus, type RealtimeEnvelope } from './realtime-client';

/**
 * Stage 4/5 — maps a real-time event's `type` to the query keys it should invalidate. Audited
 * against the real backend event catalogue, not invented: `offer.sent`, `offer.accepted` and
 * (Stage 5) `offer.confirmed` are the only event types the gateway can ever actually deliver today
 * (see `realtime-envelope.ts`'s `KNOWN_REALTIME_EVENT_TYPES` on the server — the single source of
 * truth this map must never get ahead of). All three are recipient-only (never workspace-
 * broadcast), but React Query invalidation doesn't need the recipient check repeated here — the
 * gateway already only ever delivers an event to a connection whose own bound identity matches it
 * (Stage 3's own `envelopeMatchesConnection`), so by the time `onEvent` fires in this tab, it is
 * already known to be meant for the CURRENTLY authenticated user. `offer.sent` and `offer.confirmed`
 * both target the STAFF member (never reachable from this Manager-Web-only console — kept in this
 * map anyway so it stays a complete, honest mirror of the real catalogue, not a curated subset);
 * `offer.accepted` targets the manager who sent it, which this console genuinely does receive.
 *
 * Query keys match the real ones in `Offers.tsx` (`['offers', params]`) and `Dashboard.tsx`
 * (`['offers']`, `['dashboard-summary']`) — using `exact: false` so a parametrised offers-list
 * key is invalidated regardless of its current filter/sort params.
 */
const EVENT_QUERY_KEYS: Record<string, QueryKey[]> = {
  'offer.sent': [['offers'], ['dashboard-summary']],
  'offer.accepted': [['offers'], ['dashboard-summary']],
  'offer.confirmed': [['offers'], ['dashboard-summary']],
};

// Reconnect reconciliation: the gateway only ever pushes events published WHILE a connection is
// live (Stage 1/2's outbox is drained by `publish-outbox.job.ts` into Redis Pub/Sub at publish
// time, not replayed to a late-joining subscriber) — so any event raised during a drop (a dead
// Wi-Fi stretch, a laptop sleep, the bounded backoff window itself) is simply never delivered,
// not merely delayed. A per-event `onEvent` invalidation can never compensate for that: there is
// no missed envelope to react to. On every reconnect (never the first-ever connect — nothing can
// have been missed before any connection existed), force a refetch of every query this client's
// event map ever invalidates, so a gap closes the moment the stream comes back regardless of what,
// if anything, was missed inside it.
const RECONCILIATION_QUERY_KEYS: QueryKey[] = Array.from(
  new Map(Object.values(EVENT_QUERY_KEYS).flat().map((key) => [JSON.stringify(key), key])).values(),
);

const RealtimeStatusContext = createContext<RealtimeConnectionStatus>('offline');

/** For a small, optional connection-status indicator — never a hard dependency for correctness (every screen still works, just less instantly, if this is never rendered). */
export function useRealtimeStatus(): RealtimeConnectionStatus {
  return useContext(RealtimeStatusContext);
}

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const sessionStatus = useSessionStatus();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<RealtimeConnectionStatus>('offline');
  const [generation, setGeneration] = useState(() => getIdentitySnapshot().generation);

  // Tracks the identity-generation counter reactively (`auth-session.ts`'s own store) so the
  // effect below restarts the connection on EVERY identity transition — a fresh login, a
  // logout-then-different-account-login in the same tab, or a cross-tab broadcast that changes
  // this tab's ambient identity — never just once at mount.
  useEffect(
    () =>
      subscribeToSession(() => {
        const current = getIdentitySnapshot().generation;
        setGeneration((prev) => (prev === current ? prev : current));
      }),
    [],
  );

  // Per-identity, not global: a fresh login/account-switch (the `generation` dependency below
  // tears this effect down and re-runs it) must count as its own "first connect" — nothing could
  // have been missed under an identity that didn't hold a connection yet.
  const hasConnectedOnceRef = useRef(false);

  useEffect(() => {
    if (sessionStatus !== 'authenticated') {
      setStatus('offline');
      return;
    }
    hasConnectedOnceRef.current = false;
    const handle = startRealtimeClient({
      onStatusChange: (next) => {
        if (next === 'connected') {
          if (hasConnectedOnceRef.current) {
            for (const key of RECONCILIATION_QUERY_KEYS) queryClient.invalidateQueries({ queryKey: key });
          }
          hasConnectedOnceRef.current = true;
        }
        setStatus(next);
      },
      onEvent: (envelope: RealtimeEnvelope) => {
        const keys = EVENT_QUERY_KEYS[envelope.type];
        if (!keys) return; // an event type this build doesn't yet know how to react to — ignored, never a crash
        for (const key of keys) queryClient.invalidateQueries({ queryKey: key });
      },
    });
    return () => handle.stop();
    // `generation` is a dependency specifically so a login/logout/account-switch tears down the
    // OLD connection and opens a fresh one under the new identity, rather than letting a stale
    // stream (captured under the previous generation) keep running across the boundary.
  }, [sessionStatus, generation, queryClient]);

  return <RealtimeStatusContext.Provider value={status}>{children}</RealtimeStatusContext.Provider>;
}
