import { act, render, screen } from '@testing-library/react';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { api } from '../../shared/api';
import NotificationBell from './NotificationBell';

jest.mock('../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn() } }));
// C1b: a controllable "realtime is live" signal (the real one comes from the stream client's status store).
let mockRealtimeLive = false;
const mockLiveListeners = new Set<() => void>();
jest.mock('../../shared/lib/RealtimeProvider', () => {
  const { useSyncExternalStore } = jest.requireActual('react');
  return {
    useIsRealtimeLive: () =>
      useSyncExternalStore(
        (l: () => void) => { mockLiveListeners.add(l); return () => mockLiveListeners.delete(l); },
        () => mockRealtimeLive,
      ),
  };
});
const setRealtimeLive = (live: boolean) => act(() => { mockRealtimeLive = live; mockLiveListeners.forEach((l) => l()); });
const get = api.get as jest.Mock;

let count = 2;
beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(Math, 'random').mockReturnValue(0.5); // jitter factor exactly 1
  count = 2;
  mockRealtimeLive = false;
  get.mockReset();
  get.mockImplementation(async (url: string) => (url === '/notifications/unread-count' ? { data: { count } } : { data: [] }));
});
afterEach(() => {
  focusManager.setFocused(undefined);
  jest.restoreAllMocks();
  jest.useRealTimers();
});

const tick = (ms: number) => act(async () => { await jest.advanceTimersByTimeAsync(ms); });
const countCalls = () => get.mock.calls.filter(([u]: [string]) => u === '/notifications/unread-count').length;
function mount() {
  // The app's own defaults (App.tsx): no window-focus refetch, 30 s staleTime.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 } } });
  render(<QueryClientProvider client={qc}><NotificationBell /></QueryClientProvider>);
  return qc;
}

it('Phase C1: the unread badge is a 60 s (±20 %) fallback poll, not 30 s', async () => {
  const qc = mount();
  await tick(20);
  expect(countCalls()).toBe(1);
  await tick(45_000);
  expect(countCalls()).toBe(1);
  count = 5;
  await tick(15_100);
  expect(countCalls()).toBe(2);
  qc.clear();
});

it('C1b: slows to the 120 s fallback while realtime is live and returns to 60 s as soon as it drops', async () => {
  const qc = mount();
  await tick(20);
  expect(countCalls()).toBe(1);
  setRealtimeLive(true);
  await tick(61_000);
  expect(countCalls()).toBe(1); // a 60 s poll would have fired by now
  await tick(60_000);
  expect(countCalls()).toBe(2); // 120 s after the stream went live
  setRealtimeLive(false);
  await tick(59_000);
  expect(countCalls()).toBe(2);
  await tick(1_100);
  expect(countCalls()).toBe(3); // back on the 60 s fallback, without an extra request at the switch
  qc.clear();
});

it('pauses while the tab is hidden and catches up once when it becomes visible', async () => {
  const qc = mount();
  await tick(20);
  act(() => focusManager.setFocused(false));
  await tick(300_000);
  expect(countCalls()).toBe(1);
  act(() => focusManager.setFocused(true));
  await tick(20);
  expect(countCalls()).toBe(2);
  qc.clear();
});

it('keeps the last unread count when a refresh fails', async () => {
  const qc = mount();
  await tick(20);
  const badge = () => screen.queryByText('2');
  expect(badge()).toBeTruthy();
  get.mockRejectedValue(Object.assign(new Error('503'), { response: { status: 503 } }));
  await tick(60_100);
  expect(countCalls()).toBe(2);
  expect(badge()).toBeTruthy();
  qc.clear();
});
