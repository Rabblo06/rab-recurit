import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from './App';
import { api, bootstrapSession, resolveIdentityViaCookie } from './shared/api';
import { applyIdentityFromServer, getUserId, markUnauthenticated } from './shared/lib/auth-session';
import Login from './features/auth/Login';
import LogoutDialog from './features/settings/LogoutDialog';

jest.mock('./shared/api', () => ({
  api: { get: jest.fn(), post: jest.fn() },
  // The real bootstrapSession() calls the (unmocked-here) axios instance
  // directly against a real network — not appropriate in a unit test, and
  // not what any of these tests are exercising (Login/LogoutDialog update
  // the shared session store directly, independent of this). Defaults to
  // "no valid cookie", matching a fresh unauthenticated visitor.
  bootstrapSession: jest.fn().mockResolvedValue(false),
  // W6-E2E-02: the workspace-host gate subscribes to identity-read failures (wrong-host 404 on the bootstrap).
  observeIdentityErrors: jest.fn(() => () => undefined),
  // P0.1: Login/LogoutDialog now serialize their API calls through withAuthLock and
  // LogoutDialog broadcasts a logout message — matching real behaviour under jsdom, which has
  // no navigator.locks (see api.ts's own fallback), a plain pass-through is the correct mock,
  // not a no-op stub that would silently swallow the wrapped call.
  withAuthLock: jest.fn((run: () => unknown) => run()),
  broadcastLogout: jest.fn(),
  broadcastLogin: jest.fn(),
  // P1C.1C-F: Login.tsx/OAuthCallbackComplete.tsx now resolve identity via this cookie-first call
  // instead of decoding the login response's JWT — mocked here the same way `bootstrapSession` is,
  // since the real implementation hits the (unmocked-here) raw axios instance directly. Tests that
  // exercise a successful sign-in override this per-test to also call `applyIdentityFromServer`,
  // matching what the real call does on success.
  resolveIdentityViaCookie: jest.fn().mockResolvedValue(false),
  // P1G: SessionBootstrap seeds React Query's ['me'] cache from this after a successful
  // bootstrap; every test here mocks bootstrapSession to resolve false, so that branch never
  // runs, but the mock must still exist or the module-level jest.mock factory above throws.
  getLastMeSnapshot: jest.fn().mockReturnValue(null),
  // Audit F5: only a confirmed rejection logs out; these tests model a plain "no session".
  getLastIdentityFailure: jest.fn().mockReturnValue('rejected'),
}));

const mockApi = api as unknown as { get: jest.Mock; post: jest.Mock };
const mockBootstrapSession = bootstrapSession as jest.Mock;
const mockResolveIdentityViaCookie = resolveIdentityViaCookie as jest.Mock;

async function fillLoginStepOne(user: ReturnType<typeof userEvent.setup>) {
  // Wave 3 lane H: the workspace-host gate resolves the host before the app renders, so the login form appears async.
  await user.click(await screen.findByRole('button', { name: 'Continue with email' }));
  await user.type(await screen.findByLabelText('Work email'), 'admin@acme.test');
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  // The email→password step transition runs through framer-motion's
  // AnimatePresence — the Password field isn't in the DOM synchronously
  // after the click, so wait for it rather than a plain getByLabelText.
  await screen.findByLabelText('Password');
}

describe('App', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockApi.get.mockReset();
    mockApi.post.mockReset();
    mockBootstrapSession.mockReset().mockResolvedValue(false);
    mockResolveIdentityViaCookie.mockReset().mockResolvedValue(false);
    markUnauthenticated();
    window.history.pushState({}, '', '/');
  });

  it('redirects an unauthenticated visitor to the login form', async () => {
    render(<App />);
    expect(await screen.findByText('Welcome to your workspace')).toBeInTheDocument();
  });

  it('shows the API error message on failed login', async () => {
    mockApi.post.mockRejectedValue({ response: { status: 401, data: { message: 'Invalid email or password.' } } });
    const user = userEvent.setup();

    render(<App />);
    await fillLoginStepOne(user);
    await user.type(screen.getByLabelText('Password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The email or password is incorrect. Check your details and try again.');
    // A failed login stays on the password step (not bounced back to the
    // email step) — the "Welcome back" heading is that step's title.
    expect(screen.getByText('Try signing in again')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('stores tokens and renders the console after a successful login', async () => {
    mockApi.post.mockResolvedValue({ data: { accessToken: 'access-1', refreshToken: 'refresh-1' } });
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/auth/me') {
        return Promise.resolve({
          data: { id: '1', email: 'admin@acme.test', firstName: 'Super', lastName: 'Admin', roles: ['super_admin'] },
        });
      }
      // /staff, /managers, /venues — Dashboard queries all three.
      return Promise.resolve({ data: [] });
    });
    // P1C.1C-F: identity is resolved via the cookie-authenticated `/auth/me` call
    // (`resolveIdentityViaCookie`, mocked at the module level — it hits the raw axios instance
    // directly, not the `api` mock above), never a decoded JWT — this is the same side effect the
    // real implementation has on success.
    mockResolveIdentityViaCookie.mockImplementation(async () => {
      applyIdentityFromServer({ userId: '1', sessionId: 'session-1' });
      return true;
    });
    const user = userEvent.setup();

    render(<App />);
    await fillLoginStepOne(user);
    await user.type(screen.getByLabelText('Password'), 'ChangeMe123!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    // No access token is stored for a cookie-resolved identity (P1C.1C-F) — the refresh token and
    // the web session credential both never reach this JS at all, the server sets both as HttpOnly
    // cookies instead, which this mocked-`api` unit test can't observe directly (covered by the
    // Playwright browser test instead). `userId` is this test's observable proof identity resolved.
    await waitFor(() => expect(getUserId()).toBe('1'));
    // Layout's route transition also runs through framer-motion's
    // AnimatePresence, on top of the login step transition already waited
    // for above — give it more room than the default 1000ms. "Dashboard"
    // legitimately appears twice (sidebar nav link + topbar tab).
    expect(await screen.findAllByText('Dashboard', {}, { timeout: 3000 })).not.toHaveLength(0);
  });

  // Gap-review finding (platform-admin-only navigation): a platform admin with no operational org
  // role (the bootstrap/recovery case) used to land on the ordinary staffing Dashboard, where
  // every nav route 403s — `OnboardingGate` now redirects it straight to the one place it can
  // actually operate from.
  it('redirects a platform-admin-only account (no operational roles) straight to the Admin Panel, never the staffing Dashboard', async () => {
    mockApi.post.mockResolvedValue({ data: { accessToken: 'access-1', refreshToken: 'refresh-1' } });
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/auth/me') {
        return Promise.resolve({
          data: { id: '1', email: 'sebu@acme.test', firstName: 'Sebu', lastName: 'Admin', roles: [], isPlatformAdmin: true },
        });
      }
      return Promise.resolve({ data: [] });
    });
    mockResolveIdentityViaCookie.mockImplementation(async () => {
      applyIdentityFromServer({ userId: '1', sessionId: 'session-1' });
      return true;
    });
    const user = userEvent.setup();

    render(<App />);
    await fillLoginStepOne(user);
    await user.type(screen.getByLabelText('Password'), 'ChangeMe123!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    // The Admin Panel (General | Config | Health since the owner correction of 2026-10-23 — no Organisations tab).
    expect(await screen.findByRole('button', { name: 'Config' }, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Organisations' })).toBeNull();
    expect(screen.queryByText('Earnings timeline')).toBeNull();
    // Never fired for this account — it owns no workspace to look up (useMyWorkspace's `enabled` gate).
    expect(mockApi.get).not.toHaveBeenCalledWith('/manager-workspaces/me');
  });

  // Cross-user cache-isolation regression (per-user-data-isolation audit):
  // the app-wide QueryClient is a single module-level instance that outlives
  // any one login session. A client-side logout (useNavigate, not a full
  // page reload) leaves it alive in memory — without an explicit clear, a
  // different account logging in on the same tab could briefly render the
  // previous user's cached ['me']/profile/offers/etc. Tested directly
  // against the mechanism (queryClient.clear()) rather than through the full
  // Settings-drawer click-through, which is flaky under jsdom's real timers.
  it("LogoutDialog's confirm clears the QueryClient cache", async () => {
    mockApi.post.mockResolvedValue({ data: {} });
    const qc = new QueryClient();
    qc.setQueryData(['me'], { firstName: 'Alex' });
    expect(qc.getQueryData(['me'])).toEqual({ firstName: 'Alex' });

    const user = userEvent.setup();
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <LogoutDialog open onClose={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(qc.getQueryData(['me'])).toBeUndefined());
  });

  it("Login's successful sign-in clears any stale QueryClient cache from a prior session", async () => {
    mockApi.post.mockResolvedValue({ data: { accessToken: 'access-1', refreshToken: 'refresh-1', mustResetPassword: false } });
    mockResolveIdentityViaCookie.mockImplementation(async () => {
      applyIdentityFromServer({ userId: '1', sessionId: 'session-1' });
      return true;
    });
    const qc = new QueryClient();
    qc.setQueryData(['me'], { firstName: 'Alex' });

    const user = userEvent.setup();
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <Login />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Continue with email' }));
  await user.type(await screen.findByLabelText('Work email'), 'bailey@acme.test');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByLabelText('Password');
    await user.type(screen.getByLabelText('Password'), 'ChangeMe123!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(qc.getQueryData(['me'])).toBeUndefined());
  });
});
