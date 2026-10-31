import { act, renderHook } from '@testing-library/react';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMyWorkspace } from './useMyWorkspace';
import { api } from '../api';

jest.mock('../api', () => ({ api: { get: jest.fn() } }));

const get = api.get as jest.Mock;

function mountHook(opts: Parameters<typeof useMyWorkspace>[0]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(() => useMyWorkspace(opts), { wrapper });
}

beforeEach(() => {
  get.mockReset();
  get.mockResolvedValue({ data: { id: 'ws-1', name: 'N', subdomain: 's', logoKey: null, status: 'active', schemaStatus: 'CREATING', onboardingCompletedAt: null, createdAt: new Date().toISOString() } });
});

describe('useMyWorkspace — request URL by call site', () => {
  it('requests the bare URL when not polling (e.g. OnboardingRouteGuard, Settings pages)', async () => {
    const { result } = mountHook({});
    await new Promise((r) => setTimeout(r, 10));
    expect(get).toHaveBeenCalledWith('/manager-workspaces/me');
    expect(result.current).toBeDefined();
  });

  it('requests `?fresh=1` when pollWhileCreating is true (WorkspacePreparationScreen)', async () => {
    mountHook({ pollWhileCreating: true, pollIntervalMs: 2500 });
    await new Promise((r) => setTimeout(r, 10));
    expect(get).toHaveBeenCalledWith('/manager-workspaces/me?fresh=1');
  });
});

// History: a live "stuck on Preparing" bug came from polling stalling while the tab was hidden (the app's QueryClient
// disables refetchOnWindowFocus, so returning to the tab did not resume it); it was first fixed by polling while hidden.
// Phase C1 keeps the recovery but stops background traffic: no request while hidden, one immediate re-read the moment the
// tab is visible again, then the normal cadence; a long CREATING backs off (bounded) but never stops on its own.
describe('useMyWorkspace — preparation polling (Phase C1)', () => {
  const creating = { id: 'ws-1', name: 'N', subdomain: 's', logoKey: null, status: 'active', schemaStatus: 'CREATING', onboardingCompletedAt: null, createdAt: new Date().toISOString() };
  function mountAppLike(opts: Parameters<typeof useMyWorkspace>[0]) {
    // The app's own defaults (App.tsx): no window-focus refetch, 30 s staleTime.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const hook = renderHook(() => useMyWorkspace(opts), { wrapper });
    return { qc, hook };
  }
  const tick = (ms: number) => act(async () => { await jest.advanceTimersByTimeAsync(ms); });
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    get.mockResolvedValue({ data: creating });
  });
  afterEach(() => {
    focusManager.setFocused(undefined);
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('polls while CREATING and the tab is visible, and stops at READY (auto-resume of the wait still works)', async () => {
    const { qc } = mountAppLike({ pollWhileCreating: true, pollIntervalMs: 2500 });
    await tick(20);
    expect(get).toHaveBeenCalledTimes(1);
    await tick(2_600);
    expect(get).toHaveBeenCalledTimes(2);
    get.mockResolvedValue({ data: { ...creating, schemaStatus: 'READY' } });
    await tick(2_600);
    expect(get).toHaveBeenCalledTimes(3);
    await tick(60_000);
    expect(get).toHaveBeenCalledTimes(3);
    qc.clear();
  });

  it('sends nothing while the tab is hidden and re-reads once, immediately, when it becomes visible', async () => {
    const { qc } = mountAppLike({ pollWhileCreating: true, pollIntervalMs: 2500 });
    await tick(20);
    act(() => focusManager.setFocused(false));
    await tick(120_000);
    expect(get).toHaveBeenCalledTimes(1);
    act(() => focusManager.setFocused(true));
    await tick(20);
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenLastCalledWith('/manager-workspaces/me?fresh=1');
    qc.clear();
  });

  it('a long CREATING backs off (bounded at 30 s) but never stops polling on its own', async () => {
    const { qc } = mountAppLike({ pollWhileCreating: true, pollIntervalMs: 2500 });
    await tick(20);
    await tick(10 * 60_000);
    const atTenMinutes = get.mock.calls.length;
    // 2.5 s for the first minute (≈24), then 5 s, 10 s and 30 s steps — far fewer than 240 fixed 2.5 s polls.
    expect(atTenMinutes).toBeLessThan(70);
    await tick(31_000);
    expect(get.mock.calls.length).toBe(atTenMinutes + 1);
    await tick(30_000);
    expect(get.mock.calls.length).toBe(atTenMinutes + 2);
    qc.clear();
  });

  it('without pollWhileCreating nothing polls', async () => {
    const { qc } = mountAppLike({});
    await tick(20);
    await tick(120_000);
    expect(get).toHaveBeenCalledTimes(1);
    qc.clear();
  });
});
