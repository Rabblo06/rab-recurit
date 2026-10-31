import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useSessionStatus } from './SessionProvider';
import { getIdentitySnapshot, subscribeToSession } from './auth-session';
import { getRealtimeStatus, startRealtimeClient, subscribeToRealtimeStatus, type RealtimeConnectionStatus, type RealtimeEnvelope } from './realtime-client';

/**
 * Maps a real-time event's `type` to the query keys it invalidates. Audited against the real backend
 * catalogue — `realtime-envelope.ts`'s `KNOWN_REALTIME_EVENT_TYPES` on the server is the single
 * source of truth this map mirrors (`navigation_layout.saved` is left out: no web query reads it).
 * Every event is recipient-only and the gateway already re-checks it against this connection's
 * identity (`envelopeMatchesConnection`), so by the time `onEvent` fires it is meant for the
 * CURRENTLY authenticated user. An envelope carries ids only (no payload), so invalidation is by
 * key PREFIX (TanStack's default partial match): `['venue-pipeline']` covers
 * `['venue-pipeline', shiftId]`, `['dashboard']` covers every `['dashboard', …]` panel, and so on.
 * Keys are the real ones in the feature folders (Phase C1b audit):
 *  - offers: `Offers.tsx` `['offers', params]`, `['offer-batch', id]`; scheduling `['venue-pipeline', shiftId]`,
 *    `['venue-offers', params]`, `['shifts', …]`, `['shift', id]`; `Dashboard.tsx` `['dashboard', …]`,
 *    `['dashboard-summary']` (also the nav badge in `Layout.tsx`);
 *  - shift detail timeline `ShiftTimelinePanel.tsx` `['timeline', 'shift', id]`;
 *  - notifications `NotificationBell.tsx` `['notifications', 'unread-count' | 'list']`;
 *  - payroll `usePayroll.ts` / `PayrollRunsView.tsx` `['payroll', …]`; attendance `['attendance']`.
 */
const OFFER_KEYS: QueryKey[] = [['offers'], ['offer-batch'], ['venue-pipeline'], ['venue-offers'], ['shifts'], ['shift'], ['dashboard'], ['dashboard-summary']];
const SHIFT_KEYS: QueryKey[] = [['shifts'], ['shift'], ['timeline'], ['venue-offers'], ['venue-pipeline'], ['offers'], ['dashboard'], ['dashboard-summary']];
const SHIFT_REQUEST_KEYS: QueryKey[] = [['venue-offers'], ['shifts'], ['shift'], ['timeline'], ['venue-pipeline'], ['dashboard'], ['dashboard-summary']];
const ATTENDANCE_KEYS: QueryKey[] = [['attendance'], ['shift'], ['shifts'], ['timeline'], ['venue-pipeline'], ['dashboard']];

export const REALTIME_EVENT_QUERY_KEYS: Readonly<Record<string, QueryKey[]>> = {
  'offer.sent': OFFER_KEYS,
  'offer.accepted': OFFER_KEYS,
  'offer.confirmed': OFFER_KEYS,
  'offer.declined': OFFER_KEYS,
  'offer.withdrawn': OFFER_KEYS,
  'offer.expired': OFFER_KEYS,
  'offer.rejected': OFFER_KEYS,
  'shift.updated': SHIFT_KEYS,
  'shift.cancelled': SHIFT_KEYS,
  'shift_request.created': SHIFT_REQUEST_KEYS,
  'shift_request.approved': SHIFT_REQUEST_KEYS,
  'shift_request.declined': SHIFT_REQUEST_KEYS,
  'attendance.changed': ATTENDANCE_KEYS,
  'notification.created': [['notifications']],
  'payroll.record_changed': [['payroll']],
};

/** Events are coalesced for this long before invalidating, so a bulk action (20 offers → 40 events) refetches each screen once. */
export const EVENT_INVALIDATION_DEBOUNCE_MS = 250;
/** After a reconnect, wait this long (resetting on every further flap) before the full reconcile. */
export const RECONCILE_DEBOUNCE_MS = 750;

// Reconnect reconciliation: the gateway only ever pushes events published WHILE a connection is
// live (the outbox is drained into Redis Pub/Sub at publish time, not replayed to a late-joining
// subscriber) — so any event raised during a drop (a dead Wi-Fi stretch, a laptop sleep, the
// backoff window, a hidden-tab release, a 429 wait) is never delivered, not merely delayed. On every
// reconnect (never the first-ever connect for an identity — nothing can have been missed before any
// connection existed), refetch every query this map ever invalidates, once, debounced so a flapping
// connection reconciles once when it settles rather than on every flap.
const RECONCILIATION_QUERY_KEYS: QueryKey[] = Array.from(
  new Map(Object.values(REALTIME_EVENT_QUERY_KEYS).flat().map((key) => [JSON.stringify(key), key])).values(),
);

const RealtimeStatusContext = createContext<RealtimeConnectionStatus | null>(null);

/**
 * This tab's stream status. Optional for correctness — every screen still works (by polling) without it. Reads the
 * provider's value, or the client's own status store when rendered outside the provider.
 */
export function useRealtimeStatus(): RealtimeConnectionStatus {
  const fromProvider = useContext(RealtimeStatusContext);
  const fromStore = useSyncExternalStore(subscribeToRealtimeStatus, getRealtimeStatus, getRealtimeStatus);
  return fromProvider ?? fromStore;
}

/**
 * True only while events are flowing (`connected`). The signal for a covered poll to slow down; any other state
 * (`reconnecting`, `paused`, `limited`, `disabled`, `unauthorized`, `offline`) means "poll at the normal rate".
 * Non-React code can use `isRealtimeLive()` / `subscribeToRealtimeStatus()` from `realtime-client.ts`.
 */
export function useIsRealtimeLive(): boolean {
  return useRealtimeStatus() === 'connected';
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
  // tears this effect down and re-runs it) must count as its own "first connect".
  const hasConnectedOnceRef = useRef(false);

  useEffect(() => {
    if (sessionStatus !== 'authenticated') {
      setStatus('offline');
      return;
    }
    hasConnectedOnceRef.current = false;
    const pendingKeys = new Map<string, QueryKey>();
    let eventTimer: ReturnType<typeof setTimeout> | null = null;
    let reconcileTimer: ReturnType<typeof setTimeout> | null = null;

    const flushEvents = () => {
      eventTimer = null;
      const keys = [...pendingKeys.values()];
      pendingKeys.clear();
      for (const key of keys) void queryClient.invalidateQueries({ queryKey: key });
    };

    const handle = startRealtimeClient({
      onStatusChange: (next) => {
        if (next === 'connected') {
          if (hasConnectedOnceRef.current) {
            if (reconcileTimer) clearTimeout(reconcileTimer);
            reconcileTimer = setTimeout(() => {
              reconcileTimer = null;
              for (const key of RECONCILIATION_QUERY_KEYS) void queryClient.invalidateQueries({ queryKey: key });
            }, RECONCILE_DEBOUNCE_MS);
          }
          hasConnectedOnceRef.current = true;
        } else if (reconcileTimer) {
          // Dropped again before the reconcile fired: the next successful connect reconciles instead.
          clearTimeout(reconcileTimer);
          reconcileTimer = null;
        }
        setStatus(next);
      },
      onEvent: (envelope: RealtimeEnvelope) => {
        const keys = REALTIME_EVENT_QUERY_KEYS[envelope.type];
        if (!keys) return; // an event type this build doesn't yet know how to react to — ignored, never a crash
        for (const key of keys) pendingKeys.set(JSON.stringify(key), key);
        if (!eventTimer) eventTimer = setTimeout(flushEvents, EVENT_INVALIDATION_DEBOUNCE_MS);
      },
    });
    return () => {
      // Nothing queued under this identity may fire after it is gone.
      if (eventTimer) clearTimeout(eventTimer);
      if (reconcileTimer) clearTimeout(reconcileTimer);
      pendingKeys.clear();
      handle.stop();
    };
    // `generation` is a dependency specifically so a login/logout/account-switch tears down the
    // OLD connection and opens a fresh one under the new identity, rather than letting a stale
    // stream (captured under the previous generation) keep running across the boundary.
  }, [sessionStatus, generation, queryClient]);

  return <RealtimeStatusContext.Provider value={status}>{children}</RealtimeStatusContext.Provider>;
}
