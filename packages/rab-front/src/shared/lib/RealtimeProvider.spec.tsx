import type { ReactNode } from 'react';
import { act, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { EVENT_INVALIDATION_DEBOUNCE_MS, RECONCILE_DEBOUNCE_MS, REALTIME_EVENT_QUERY_KEYS, RealtimeProvider, useIsRealtimeLive, useRealtimeStatus } from './RealtimeProvider';
import { useSessionStatus } from './SessionProvider';
import { getIdentitySnapshot, subscribeToSession } from './auth-session';
import { startRealtimeClient } from './realtime-client';

jest.mock('./SessionProvider', () => ({ useSessionStatus: jest.fn() }));
jest.mock('./auth-session', () => ({
  getIdentitySnapshot: jest.fn(),
  subscribeToSession: jest.fn(),
}));
jest.mock('./realtime-client', () => {
  // The real status store, with the network client itself mocked.
  let status = 'offline';
  const listeners = new Set<() => void>();
  return {
    startRealtimeClient: jest.fn(),
    getRealtimeStatus: () => status,
    subscribeToRealtimeStatus: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    __setStatus: (next: string) => {
      status = next;
      listeners.forEach((l) => l());
    },
  };
});

const { __setStatus } = jest.requireMock('./realtime-client') as { __setStatus: (s: string) => void };
const mockUseSessionStatus = useSessionStatus as jest.Mock;
const mockGetIdentitySnapshot = getIdentitySnapshot as jest.Mock;
const mockSubscribeToSession = subscribeToSession as jest.Mock;
const mockStartRealtimeClient = startRealtimeClient as jest.Mock;

function StatusProbe() {
  const status = useRealtimeStatus();
  const live = useIsRealtimeLive();
  return <div data-testid="status">{`${status}|${live ? 'live' : 'not-live'}`}</div>;
}

function renderProvider(children: ReactNode) {
  const qc = new QueryClient();
  jest.spyOn(qc, 'invalidateQueries');
  return { qc, ...render(<QueryClientProvider client={qc}>{children}</QueryClientProvider>) };
}

const invalidatedKeys = (qc: QueryClient) => (qc.invalidateQueries as jest.Mock).mock.calls.map((c) => JSON.stringify(c[0].queryKey));

describe('RealtimeProvider', () => {
  let capturedOpts: { onEvent: (e: unknown) => void; onStatusChange: (s: string) => void } | null;
  let stopFn: jest.Mock;

  // The client publishes to the status store AND calls onStatusChange; the mock mirrors that.
  const status = (s: string) => act(() => { __setStatus(s); capturedOpts!.onStatusChange(s); });
  const event = (type: string, eventId: string) => act(() => { capturedOpts!.onEvent({ type, eventId, entityId: 'x' }); });
  const advance = (ms: number) => act(() => { jest.advanceTimersByTime(ms); });

  beforeEach(() => {
    jest.useFakeTimers();
    mockUseSessionStatus.mockReturnValue('authenticated');
    mockGetIdentitySnapshot.mockReturnValue({ userId: 'user-1', sessionId: 'sess-1', generation: 1 });
    mockSubscribeToSession.mockReturnValue(() => {});
    capturedOpts = null;
    stopFn = jest.fn();
    mockStartRealtimeClient.mockReset().mockImplementation((opts) => {
      capturedOpts = opts;
      return { stop: stopFn };
    });
    __setStatus('offline');
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('does not start a connection when not authenticated', () => {
    mockUseSessionStatus.mockReturnValue('loading');
    renderProvider(<RealtimeProvider><StatusProbe/></RealtimeProvider>);
    expect(mockStartRealtimeClient).not.toHaveBeenCalled();
  });

  describe('C1b — event → query-key map', () => {
    it('covers every event type in the server catalogue (KNOWN_REALTIME_EVENT_TYPES)', () => {
      expect(Object.keys(REALTIME_EVENT_QUERY_KEYS).sort()).toEqual([
        'attendance.changed',
        'notification.created',
        'offer.accepted',
        'offer.confirmed',
        'offer.declined',
        'offer.expired',
        'offer.rejected',
        'offer.sent',
        'offer.withdrawn',
        'payroll.record_changed',
        'shift.cancelled',
        'shift.updated',
        'shift_request.approved',
        'shift_request.created',
        'shift_request.declined',
      ]);
    });

    it('an offer event refreshes the offer screens, the venue pipeline/offers, shifts and both dashboard families', () => {
      const { qc } = renderProvider(<RealtimeProvider><StatusProbe/></RealtimeProvider>);
      event('offer.declined', 'e1');
      expect(qc.invalidateQueries).not.toHaveBeenCalled(); // coalesced, not immediate
      advance(EVENT_INVALIDATION_DEBOUNCE_MS);
      expect(invalidatedKeys(qc).sort()).toEqual(
        ['["dashboard"]', '["dashboard-summary"]', '["offer-batch"]', '["offers"]', '["shift"]', '["shifts"]', '["venue-offers"]', '["venue-pipeline"]'].sort(),
      );
    });

    it('notification.created refreshes only the notification bell/list', () => {
      const { qc } = renderProvider(<RealtimeProvider><StatusProbe/></RealtimeProvider>);
      event('notification.created', 'n1');
      advance(EVENT_INVALIDATION_DEBOUNCE_MS);
      expect(invalidatedKeys(qc)).toEqual(['["notifications"]']);
    });

    it('payroll.record_changed refreshes only payroll', () => {
      const { qc } = renderProvider(<RealtimeProvider><StatusProbe/></RealtimeProvider>);
      event('payroll.record_changed', 'p1');
      advance(EVENT_INVALIDATION_DEBOUNCE_MS);
      expect(invalidatedKeys(qc)).toEqual(['["payroll"]']);
    });

    it('attendance.changed refreshes attendance, the shift detail/timeline, shifts, the pipeline and the dashboard', () => {
      const { qc } = renderProvider(<RealtimeProvider><StatusProbe/></RealtimeProvider>);
      event('attendance.changed', 'a1');
      advance(EVENT_INVALIDATION_DEBOUNCE_MS);
      expect(invalidatedKeys(qc).sort()).toEqual(['["attendance"]', '["dashboard"]', '["shift"]', '["shifts"]', '["timeline"]', '["venue-pipeline"]'].sort());
    });

    it('a burst of events invalidates each key once (no refetch storm)', () => {
      const { qc } = renderProvider(<RealtimeProvider><StatusProbe/></RealtimeProvider>);
      for (let i = 0; i < 20; i++) event('offer.sent', `s${i}`);
      for (let i = 0; i < 20; i++) event('notification.created', `n${i}`);
      advance(EVENT_INVALIDATION_DEBOUNCE_MS);
      const keys = invalidatedKeys(qc);
      expect(keys.filter((k) => k === '["offers"]')).toHaveLength(1);
      expect(keys.filter((k) => k === '["notifications"]')).toHaveLength(1);
    });

    it('ignores an event type outside the known backend catalogue rather than crashing', () => {
      const { qc } = renderProvider(<RealtimeProvider><StatusProbe/></RealtimeProvider>);
      expect(() => event('something.invented', 'e2')).not.toThrow();
      advance(5_000);
      expect(qc.invalidateQueries).not.toHaveBeenCalled();
    });
  });

  describe('C1b — debounced reconcile after a reconnect', () => {
    it('does NOT reconcile on the very first-ever connect (nothing could have been missed yet)', () => {
      const { qc } = renderProvider(<RealtimeProvider><StatusProbe/></RealtimeProvider>);
      status('connecting');
      status('connected');
      advance(RECONCILE_DEBOUNCE_MS * 2);
      expect(qc.invalidateQueries).not.toHaveBeenCalled();
    });

    it('a reconnect reconciles every mapped key once, after the debounce — flapping reconnects collapse into one', () => {
      const { qc } = renderProvider(<RealtimeProvider><StatusProbe/></RealtimeProvider>);
      status('connected');
      status('reconnecting');
      status('connected');
      status('reconnecting');
      status('connected');
      advance(RECONCILE_DEBOUNCE_MS - 50);
      expect(qc.invalidateQueries).not.toHaveBeenCalled();
      advance(100);
      const keys = invalidatedKeys(qc);
      for (const k of ['["offers"]', '["notifications"]', '["payroll"]', '["venue-pipeline"]', '["venue-offers"]', '["shifts"]', '["dashboard"]', '["attendance"]']) {
        expect(keys.filter((x) => x === k)).toHaveLength(1);
      }
    });

    it('coming back from a hidden-tab release (paused → connected) reconciles', () => {
      const { qc } = renderProvider(<RealtimeProvider><StatusProbe/></RealtimeProvider>);
      status('connected');
      status('paused');
      status('connected');
      advance(RECONCILE_DEBOUNCE_MS);
      expect(invalidatedKeys(qc)).toContain('["offers"]');
    });

    it('a pending reconcile is dropped if the stream drops again before it fires (the next connect reconciles instead)', () => {
      const { qc } = renderProvider(<RealtimeProvider><StatusProbe/></RealtimeProvider>);
      status('connected');
      status('reconnecting');
      status('connected');
      status('reconnecting');
      advance(RECONCILE_DEBOUNCE_MS * 2);
      expect(qc.invalidateQueries).not.toHaveBeenCalled();
    });
  });

  it('exposes connection status and liveness via useRealtimeStatus() / useIsRealtimeLive()', async () => {
    const { findByTestId } = renderProvider(<RealtimeProvider><StatusProbe/></RealtimeProvider>);
    status('connected');
    expect((await findByTestId('status')).textContent).toBe('connected|live');
    status('limited');
    expect((await findByTestId('status')).textContent).toBe('limited|not-live');
  });

  it('tears down the old connection and starts a fresh one on an identity-generation change', () => {
    let sessionListener: () => void = () => {};
    mockSubscribeToSession.mockImplementation((listener: () => void) => {
      sessionListener = listener;
      return () => {};
    });
    renderProvider(<RealtimeProvider><StatusProbe/></RealtimeProvider>);
    expect(mockStartRealtimeClient).toHaveBeenCalledTimes(1);

    mockGetIdentitySnapshot.mockReturnValue({ userId: 'user-2', sessionId: 'sess-2', generation: 2 });
    act(() => { sessionListener(); });

    expect(stopFn).toHaveBeenCalledTimes(1); // old connection torn down
    expect(mockStartRealtimeClient).toHaveBeenCalledTimes(2); // fresh one opened under the new identity
  });

  it('pending invalidations from the old identity never fire after an identity change', () => {
    let sessionListener: () => void = () => {};
    mockSubscribeToSession.mockImplementation((listener: () => void) => {
      sessionListener = listener;
      return () => {};
    });
    const { qc } = renderProvider(<RealtimeProvider><StatusProbe/></RealtimeProvider>);
    event('offer.sent', 'old-1');
    mockGetIdentitySnapshot.mockReturnValue({ userId: 'user-2', sessionId: 'sess-2', generation: 2 });
    act(() => { sessionListener(); });
    advance(EVENT_INVALIDATION_DEBOUNCE_MS * 4);
    expect(qc.invalidateQueries).not.toHaveBeenCalled();
  });

  it('stops the connection when the session transitions away from authenticated', () => {
    const { rerender } = render(
      <QueryClientProvider client={new QueryClient()}>
        <RealtimeProvider><StatusProbe/></RealtimeProvider>
      </QueryClientProvider>,
    );
    expect(mockStartRealtimeClient).toHaveBeenCalledTimes(1);

    mockUseSessionStatus.mockReturnValue('unauthenticated');
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <RealtimeProvider><StatusProbe/></RealtimeProvider>
      </QueryClientProvider>,
    );
    expect(stopFn).toHaveBeenCalledTimes(1);
  });

  // Stage 4 exit gate: "out-of-order events cannot restore stale business state" / "duplicate events do not create
  // duplicate UI data". Structural: `onEvent` and the reconciliation path call ONLY `invalidateQueries` — never
  // `setQueryData` with any part of the envelope. If a future change starts writing envelope data into the cache
  // directly, this fails immediately.
  it('never writes cache data directly from an event — out-of-order and duplicate delivery are structurally inert', () => {
    const { qc } = renderProvider(<RealtimeProvider><StatusProbe/></RealtimeProvider>);
    const setQueryDataSpy = jest.spyOn(qc, 'setQueryData');
    event('offer.accepted', 'evt-2');
    event('offer.accepted', 'evt-1');
    event('offer.accepted', 'evt-1');
    advance(EVENT_INVALIDATION_DEBOUNCE_MS);
    expect(qc.invalidateQueries).toHaveBeenCalled();
    expect(setQueryDataSpy).not.toHaveBeenCalled();
  });

  // Stage 4 exit gate: "React remounts do not accumulate SSE connections or event listeners."
  it('tears down its connection and session subscription on unmount — no leak across repeated mounts', () => {
    const unsubscribeFns: jest.Mock[] = [];
    mockSubscribeToSession.mockImplementation(() => {
      const fn = jest.fn();
      unsubscribeFns.push(fn);
      return fn;
    });

    for (let i = 0; i < 3; i++) {
      const qc = new QueryClient();
      const { unmount } = render(
        <QueryClientProvider client={qc}>
          <RealtimeProvider><StatusProbe/></RealtimeProvider>
        </QueryClientProvider>,
      );
      unmount();
    }

    expect(mockStartRealtimeClient).toHaveBeenCalledTimes(3);
    expect(stopFn).toHaveBeenCalledTimes(3);
    expect(unsubscribeFns).toHaveLength(3);
    for (const fn of unsubscribeFns) expect(fn).toHaveBeenCalledTimes(1);
  });
});
