import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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

// Regression test for a real live bug: TanStack Query's `refetchInterval` only fires while the
// document is visible by default — if the owner's browser tab lost focus even once while a
// workspace was CREATING, automatic polling silently stalled (the app's QueryClient also disables
// refetchOnWindowFocus, so returning to the tab didn't resume it either). Only a manual "Check
// again" click broke it loose. `refetchIntervalInBackground` must be explicitly enabled for the
// one call site that's actively waiting on a time-sensitive one-time event.
describe('useMyWorkspace — refetchIntervalInBackground (regression)', () => {
  it('continues polling even while the document is hidden, when pollWhileCreating is true', async () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    mountHook({ pollWhileCreating: true, pollIntervalMs: 50 });
    await new Promise((r) => setTimeout(r, 10));
    const callsBefore = get.mock.calls.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(get.mock.calls.length).toBeGreaterThan(callsBefore);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });
});
