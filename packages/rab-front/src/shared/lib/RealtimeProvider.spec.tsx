import type { ReactNode } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { RealtimeProvider, useRealtimeStatus } from './RealtimeProvider';
import { useSessionStatus } from './SessionProvider';
import { getIdentitySnapshot, subscribeToSession } from './auth-session';
import { startRealtimeClient } from './realtime-client';

jest.mock('./SessionProvider', () => ({ useSessionStatus: jest.fn() }));
jest.mock('./auth-session', () => ({
  getIdentitySnapshot: jest.fn(),
  subscribeToSession: jest.fn(),
}));
jest.mock('./realtime-client', () => ({ startRealtimeClient: jest.fn() }));

const mockUseSessionStatus = useSessionStatus as jest.Mock;
const mockGetIdentitySnapshot = getIdentitySnapshot as jest.Mock;
const mockSubscribeToSession = subscribeToSession as jest.Mock;
const mockStartRealtimeClient = startRealtimeClient as jest.Mock;

function StatusProbe() {
  const status = useRealtimeStatus();
  return <div data-testid="status">{status}</div>;
}

function renderProvider(children: ReactNode) {
  const qc = new QueryClient();
  jest.spyOn(qc, 'invalidateQueries');
  return { qc, ...render(<QueryClientProvider client={qc}>{children}</QueryClientProvider>) };
}

describe('RealtimeProvider', () => {
  let capturedOpts: { onEvent: (e: unknown) => void; onStatusChange: (s: string) => void } | null;
  let stopFn: jest.Mock;

  beforeEach(() => {
    mockUseSessionStatus.mockReturnValue('authenticated');
    mockGetIdentitySnapshot.mockReturnValue({ userId: 'user-1', sessionId: 'sess-1', generation: 1 });
    mockSubscribeToSession.mockReturnValue(() => {});
    capturedOpts = null;
    stopFn = jest.fn();
    mockStartRealtimeClient.mockReset().mockImplementation((opts) => {
      capturedOpts = opts;
      return { stop: stopFn };
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('does not start a connection when not authenticated', () => {
    mockUseSessionStatus.mockReturnValue('loading');
    renderProvider(<RealtimeProvider><StatusProbe/></RealtimeProvider>);
    expect(mockStartRealtimeClient).not.toHaveBeenCalled();
  });

  it('invalidates the mapped query keys for a known event type', async () => {
    const { qc } = renderProvider(<RealtimeProvider><StatusProbe/></RealtimeProvider>);
    expect(mockStartRealtimeClient).toHaveBeenCalledTimes(1);

    act(() => { capturedOpts!.onEvent({ type: 'offer.accepted', eventId: 'e1' }); });

    await waitFor(() => {
      expect(qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['offers'] });
      expect(qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['dashboard-summary'] });
    });
  });

  it('ignores an event type outside the known backend catalogue rather than crashing', async () => {
    const { qc } = renderProvider(<RealtimeProvider><StatusProbe/></RealtimeProvider>);
    (qc.invalidateQueries as jest.Mock).mockClear();

    expect(() => act(() => { capturedOpts!.onEvent({ type: 'something.invented', eventId: 'e2' }); })).not.toThrow();
    expect(qc.invalidateQueries).not.toHaveBeenCalled();
  });

  it('does NOT reconcile on the very first-ever connect (nothing could have been missed yet)', async () => {
    const { qc } = renderProvider(<RealtimeProvider><StatusProbe/></RealtimeProvider>);
    act(() => { capturedOpts!.onStatusChange('connected'); });
    await waitFor(() => expect(qc.getQueryData(['probe'])).toBeUndefined());
    expect(qc.invalidateQueries).not.toHaveBeenCalled();
  });

  it('reconciles (invalidates every real-time-relevant query) on a RECONNECT after a drop', async () => {
    const { qc } = renderProvider(<RealtimeProvider><StatusProbe/></RealtimeProvider>);
    act(() => { capturedOpts!.onStatusChange('connected'); }); // first connect — baseline
    act(() => { capturedOpts!.onStatusChange('reconnecting'); }); // dropped
    (qc.invalidateQueries as jest.Mock).mockClear();

    act(() => { capturedOpts!.onStatusChange('connected'); }); // back — may have missed events while down

    await waitFor(() => {
      expect(qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['offers'] });
      expect(qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['dashboard-summary'] });
    });
  });

  it('exposes connection status via useRealtimeStatus()', async () => {
    const { findByTestId } = renderProvider(<RealtimeProvider><StatusProbe/></RealtimeProvider>);
    act(() => { capturedOpts!.onStatusChange('connected'); });
    expect((await findByTestId('status')).textContent).toBe('connected');
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

  it('stops the connection when the session transitions away from authenticated', () => {
    const { rerender, container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <RealtimeProvider><StatusProbe/></RealtimeProvider>
      </QueryClientProvider>,
    );
    void container;
    expect(mockStartRealtimeClient).toHaveBeenCalledTimes(1);

    mockUseSessionStatus.mockReturnValue('unauthenticated');
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <RealtimeProvider><StatusProbe/></RealtimeProvider>
      </QueryClientProvider>,
    );
    expect(stopFn).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------------------- Stage
  // 4 exit gate: "out-of-order events cannot restore stale business state" / "duplicate events do
  // not create duplicate UI data". Both are structural, not behavioural, in this design: `onEvent`
  // and the reconciliation path call ONLY `invalidateQueries` — never `setQueryData` with any part
  // of the envelope's own payload. A query marked stale is always refetched from the live,
  // authoritative API, so there is no cached "event-shaped" data for a late or repeated event to
  // overwrite or duplicate in the first place. This test locks that invariant down: if a future
  // change ever starts writing envelope data into the cache directly, this fails immediately.
  it('never writes cache data directly from an event — out-of-order and duplicate delivery are structurally inert', async () => {
    const { qc } = renderProvider(<RealtimeProvider><StatusProbe/></RealtimeProvider>);
    const setQueryDataSpy = jest.spyOn(qc, 'setQueryData');

    // "Out of order": a later-numbered business event followed by an earlier one.
    act(() => { capturedOpts!.onEvent({ type: 'offer.accepted', eventId: 'evt-2', occurredAt: '2026-01-01T00:00:02.000Z' }); });
    act(() => { capturedOpts!.onEvent({ type: 'offer.accepted', eventId: 'evt-1', occurredAt: '2026-01-01T00:00:01.000Z' }); });
    // "Duplicate": the same eventId delivered twice (e.g. across a reconnect's fresh dedup window).
    act(() => { capturedOpts!.onEvent({ type: 'offer.accepted', eventId: 'evt-1', occurredAt: '2026-01-01T00:00:01.000Z' }); });

    await waitFor(() => expect(qc.invalidateQueries).toHaveBeenCalled());
    expect(setQueryDataSpy).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------------------- Stage
  // 4 exit gate: "React remounts do not accumulate SSE connections or event listeners."
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

    // Exactly one start per mount, each immediately paired with its own stop on unmount — never an
    // accumulating set of live connections left behind by a prior mount.
    expect(mockStartRealtimeClient).toHaveBeenCalledTimes(3);
    expect(stopFn).toHaveBeenCalledTimes(3);
    expect(unsubscribeFns).toHaveLength(3);
    for (const fn of unsubscribeFns) expect(fn).toHaveBeenCalledTimes(1);
  });
});
