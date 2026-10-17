import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import App from './App';
import { api, bootstrapSession, resolveIdentityViaCookie, broadcastLogout } from './shared/api';
import { applyIdentityFromServer, markUnauthenticated } from './shared/lib/auth-session';
import { markPendingManagerWelcome } from './features/onboarding/onboardingMotion';

jest.mock('./shared/api', () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn() },
  bootstrapSession: jest.fn().mockResolvedValue(false),
  withAuthLock: jest.fn((run: () => unknown) => run()),
  broadcastLogout: jest.fn(),
  broadcastLogin: jest.fn(),
  resolveIdentityViaCookie: jest.fn().mockResolvedValue(false),
  getLastMeSnapshot: jest.fn().mockReturnValue(null),
  // Audit F5: only a confirmed rejection logs out; these tests model a plain "no session".
  getLastIdentityFailure: jest.fn().mockReturnValue('rejected'),
}));

const mockApi = api as unknown as { get: jest.Mock; post: jest.Mock; patch: jest.Mock };
const mockBootstrapSession = bootstrapSession as jest.Mock;
const mockResolveIdentityViaCookie = resolveIdentityViaCookie as jest.Mock;
const mockBroadcastLogout = broadcastLogout as jest.Mock;

function workspaceResponse(onboardingCompletedAt: string | null) {
  return {
    id: 'ws-1', name: 'Northside Staffing', subdomain: 'northside', logoKey: null,
    status: 'active', schemaStatus: 'READY', onboardingCompletedAt, createdAt: new Date().toISOString(),
  };
}

/**
 * Starts the test already authenticated as a Manager, landing directly on `path`. Establishes
 * identity SYNCHRONOUSLY before the first render — `RequireAuth` reads `getSessionStatus()` via
 * `useSyncExternalStore` on its very first render, which happens before any effect (including
 * `SessionBootstrap`'s own `bootstrapSession()` call) runs. Doing this inside an async
 * `bootstrapSession` mock callback instead races: `RequireAuth` sees `beforeEach`'s
 * `markUnauthenticated()` state on that first synchronous render and navigates to `/login`
 * immediately, before the mock's `.then()` ever resolves — a real page load never hits this race
 * because `status` starts as `'loading'` (not `'unauthenticated'`) until bootstrap decides either
 * way, which `RequireAuth` waits out by rendering nothing; these tests can't replicate that
 * starting state via `beforeEach`'s shared `markUnauthenticated()` reset, so identity is applied
 * directly here instead.
 */
function mountAuthenticatedAt(path: string) {
  applyIdentityFromServer({ userId: '1', sessionId: 'session-1' });
  mockBootstrapSession.mockResolvedValue(true);
  mockResolveIdentityViaCookie.mockResolvedValue(false); // not exercised in this flow — identity is already applied above
  window.history.pushState({}, '', path);
  return render(<App />);
}

beforeEach(() => {
  window.localStorage.clear();
  mockApi.get.mockReset();
  mockApi.post.mockReset();
  mockApi.patch.mockReset();
  mockApi.post.mockResolvedValue({ data: {} }); // default: /auth/logout succeeds
  mockBootstrapSession.mockReset().mockResolvedValue(false);
  mockResolveIdentityViaCookie.mockReset().mockResolvedValue(false);
  mockBroadcastLogout.mockReset();
  markUnauthenticated();
});

describe('OnboardingRouteGuard — browser Back after completed onboarding', () => {
  it('a completed workspace landing on /onboarding/profile (e.g. via Back) is signed out, not shown the stale form', async () => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/auth/me') return Promise.resolve({ data: { id: '1', roles: ['manager'], isPlatformAdmin: false } });
      if (url === '/manager-workspaces/me') return Promise.resolve({ data: workspaceResponse(new Date().toISOString()) });
      throw new Error(`unexpected GET ${url}`);
    });

    mountAuthenticatedAt('/onboarding/profile');

    await waitFor(() => expect(screen.getByText('Welcome to your workspace')).toBeInTheDocument());
    expect(screen.queryByText('Create your profile')).toBeNull();
    expect(mockApi.post).toHaveBeenCalledWith('/auth/logout');
    expect(mockBroadcastLogout).toHaveBeenCalled();
  });

  it('a completed workspace landing on /onboarding/workspace (direct URL / stale bookmark) is also signed out', async () => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/auth/me') return Promise.resolve({ data: { id: '1', roles: ['manager'], isPlatformAdmin: false } });
      if (url === '/manager-workspaces/me') return Promise.resolve({ data: workspaceResponse(new Date().toISOString()) });
      throw new Error(`unexpected GET ${url}`);
    });

    mountAuthenticatedAt('/onboarding/workspace');

    await waitFor(() => expect(screen.getByText('Welcome to your workspace')).toBeInTheDocument());
    expect(screen.queryByText('Create your workspace')).toBeNull();
    expect(mockApi.post).toHaveBeenCalledWith('/auth/logout');
  });

  it('still signs out and returns to Login even if the server logout call fails — never traps the user on the stale form', async () => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/auth/me') return Promise.resolve({ data: { id: '1', roles: ['manager'], isPlatformAdmin: false } });
      if (url === '/manager-workspaces/me') return Promise.resolve({ data: workspaceResponse(new Date().toISOString()) });
      throw new Error(`unexpected GET ${url}`);
    });
    mockApi.post.mockRejectedValue(new Error('network down'));

    mountAuthenticatedAt('/onboarding/profile');

    await waitFor(() => expect(screen.getByText('Welcome to your workspace')).toBeInTheDocument());
    expect(screen.queryByText('Create your profile')).toBeNull();
  });

  it('does NOT sign out a legitimately mid-flow visit — onboardingCompletedAt still unset', async () => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/auth/me') return Promise.resolve({ data: { id: '1', roles: ['manager'], isPlatformAdmin: false } });
      if (url === '/manager-workspaces/me') return Promise.resolve({ data: workspaceResponse(null) });
      throw new Error(`unexpected GET ${url}`);
    });

    mountAuthenticatedAt('/onboarding/profile');

    expect(await screen.findByText('Create your profile')).toBeInTheDocument();
    expect(mockApi.post).not.toHaveBeenCalledWith('/auth/logout');
  });

  // Regression guard: /onboarding/preparing is legitimately visited WHILE onboardingCompletedAt is
  // already set (CreateProfileScreen sets it immediately before navigating there) — wrapping this
  // route in the same guard as the two editable forms would sign the user out the instant they
  // land on the real preparation screen, before they ever see it. See App.tsx's own comment on why
  // this route is deliberately excluded from OnboardingRouteGuard.
  it('does NOT sign out a legitimate first-time visit to /onboarding/preparing, even though onboardingCompletedAt is already set there', async () => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/auth/me') return Promise.resolve({ data: { id: '1', firstName: 'Issac', roles: ['manager'], isPlatformAdmin: false } });
      if (url === '/profile') return Promise.resolve({ data: { id: '1', email: 'i@example.com', firstName: 'Issac', lastName: 'N', jobTitle: null, avatarKey: null } });
      // startsWith: WorkspacePreparationScreen polls with `?fresh=1`.
      if (url.startsWith('/manager-workspaces/me')) return Promise.resolve({ data: workspaceResponse(new Date().toISOString()) });
      return Promise.reject(new Error(`unmocked GET ${url}`));
    });
    // CreateProfileScreen sets this one-time trigger when onboarding genuinely completes.
    markPendingManagerWelcome('ws-1');

    mountAuthenticatedAt('/onboarding/preparing');

    // READY → the 8s presentation floor, then the animated welcome overlay. Never a sign-out.
    await waitFor(() => expect(document.querySelector('.welcome-overlay')).not.toBeNull(), { timeout: 10_000 });
    expect(mockApi.post).not.toHaveBeenCalledWith('/auth/logout');
  }, 14_000);

  // Regression test for a real bug caught live: the guard used to trust `['manager-workspace']`
  // data the instant it existed in the QueryClient cache (`isLoading === false`), regardless of
  // age — React Query's 30s default `staleTime` means a value cached by an EARLIER mount (e.g. the
  // same account's previous workspace, before an out-of-band reset) was treated as current with no
  // network round trip at all, signing the user straight back out on the very next visit even
  // though the fresh server state said otherwise.
  it('forces a fresh check instead of trusting stale cached workspace data left over from an earlier mount', async () => {
    // First mount: workspace completed — this is what populates the QueryClient's
    // ['manager-workspace'] cache entry (the guard's own `useMyWorkspace()` call writes it on a
    // successful fetch, independent of what the guard then decides to do with it).
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/auth/me') return Promise.resolve({ data: { id: '1', roles: ['manager'], isPlatformAdmin: false } });
      if (url === '/manager-workspaces/me') return Promise.resolve({ data: workspaceResponse(new Date().toISOString()) });
      throw new Error(`unexpected GET ${url}`);
    });
    const first = mountAuthenticatedAt('/onboarding/profile');
    await waitFor(() => expect(screen.getByText('Welcome to your workspace')).toBeInTheDocument());
    first.unmount();

    // Second mount, same tab — the QueryClient singleton (and its cache) survives the unmount.
    // The workspace has since been reset server-side: no workspace exists any more. The guard must
    // verify this fresh, not act on the leftover "completed" entry still sitting in cache.
    mockApi.post.mockReset();
    mockApi.post.mockResolvedValue({ data: {} });
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/auth/me') return Promise.resolve({ data: { id: '1', roles: ['manager'], isPlatformAdmin: false } });
      if (url === '/manager-workspaces/me') {
        const err: any = new Error('not found');
        err.response = { status: 404 };
        return Promise.reject(err);
      }
      throw new Error(`unexpected GET ${url}`);
    });
    applyIdentityFromServer({ userId: '1', sessionId: 'session-2' });
    window.history.pushState({}, '', '/onboarding/workspace');
    render(<App />);

    expect(await screen.findByText('Create your workspace')).toBeInTheDocument();
    expect(mockApi.post).not.toHaveBeenCalledWith('/auth/logout');
  });

  // Regression test for the real bug caught live: completing Create Profile writes the
  // now-completed workspace into the SAME shared ['manager-workspace'] cache entry
  // OnboardingRouteGuard is still subscribed to at that exact moment (the guard hasn't unmounted
  // yet — `nav('/onboarding/preparing', { replace: true })` hasn't taken effect). A guard that
  // re-derives its verdict reactively from that cache would see "onboarding just became complete"
  // and sign the user out instead of letting the legitimate completion proceed — confirmed live via
  // the server log showing `complete-onboarding` immediately followed by `auth/logout`, every time.
  it('completing the profile step itself must never trigger the guard it is subject to', async () => {
    let workspaceCompletedAt: string | null = null;
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/auth/me') return Promise.resolve({ data: { id: '1', firstName: 'Issac', roles: ['manager'], isPlatformAdmin: false } });
      if (url === '/profile') return Promise.resolve({ data: { id: '1', email: 'i@example.com', firstName: 'Issac', lastName: 'N', jobTitle: null, avatarKey: null } });
      // startsWith, not exact equality: once navigation reaches /onboarding/preparing,
      // WorkspacePreparationScreen polls with `?fresh=1` (see useMyWorkspace.ts's own doc comment).
      if (url.startsWith('/manager-workspaces/me')) return Promise.resolve({ data: workspaceResponse(workspaceCompletedAt) });
      throw new Error(`unexpected GET ${url}`);
    });
    mockApi.patch.mockResolvedValue({ data: { firstName: 'Issac', lastName: 'N', jobTitle: null } });
    mockApi.post.mockImplementation((url: string) => {
      if (url === '/manager-workspaces/me/complete-onboarding') {
        workspaceCompletedAt = new Date().toISOString();
        return Promise.resolve({ data: workspaceResponse(workspaceCompletedAt) });
      }
      if (url === '/auth/logout') return Promise.resolve({ data: {} });
      throw new Error(`unexpected POST ${url}`);
    });

    mountAuthenticatedAt('/onboarding/profile');
    await screen.findByText('Create your profile');

    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Issac' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'N' } });
    fireEvent.click(screen.getByRole('button', { name: 'Complete setup' }));

    // Must reach the animated welcome overlay (after the 8s presentation floor, since this mock
    // workspace is already READY) — never bounce back to Login, never a Continue button.
    await waitFor(() => expect(document.querySelector('.welcome-overlay')).not.toBeNull(), { timeout: 10_000 });
    expect(mockApi.post).not.toHaveBeenCalledWith('/auth/logout');
    expect(screen.queryByLabelText('Email')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open workspace' })).toBeNull();
  }, 14_000);

  it('a brand-new Manager with no workspace yet still reaches Create Workspace normally', async () => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/auth/me') return Promise.resolve({ data: { id: '1', roles: ['manager'], isPlatformAdmin: false } });
      if (url === '/manager-workspaces/me') {
        const err: any = new Error('not found');
        err.response = { status: 404 };
        return Promise.reject(err);
      }
      throw new Error(`unexpected GET ${url}`);
    });

    mountAuthenticatedAt('/onboarding/workspace');

    expect(await screen.findByText('Create your workspace')).toBeInTheDocument();
    expect(mockApi.post).not.toHaveBeenCalledWith('/auth/logout');
  });
});
