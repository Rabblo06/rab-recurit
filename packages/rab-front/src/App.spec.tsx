import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from './App';
import { api, bootstrapSession } from './shared/api';
import { getAccessToken, markUnauthenticated } from './shared/lib/auth-session';
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
}));

const mockApi = api as unknown as { get: jest.Mock; post: jest.Mock };
const mockBootstrapSession = bootstrapSession as jest.Mock;

async function fillLoginStepOne(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Email'), 'admin@acme.test');
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
    markUnauthenticated();
    window.history.pushState({}, '', '/');
  });

  it('redirects an unauthenticated visitor to the login form', () => {
    render(<App />);
    expect(screen.getByText('Sign in to rab')).toBeInTheDocument();
  });

  it('shows the API error message on failed login', async () => {
    mockApi.post.mockRejectedValue({ response: { data: { message: 'Invalid email or password.' } } });
    const user = userEvent.setup();

    render(<App />);
    await fillLoginStepOne(user);
    await user.type(screen.getByLabelText('Password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password.');
    // A failed login stays on the password step (not bounced back to the
    // email step) — the "Enter your password" heading is that step's title.
    expect(screen.getByText('Enter your password')).toBeInTheDocument();
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
    const user = userEvent.setup();

    render(<App />);
    await fillLoginStepOne(user);
    await user.type(screen.getByLabelText('Password'), 'ChangeMe123!');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    // The access token lives only in memory now (never localStorage); the
    // refresh token never reaches this JS at all — the server sets it as an
    // HttpOnly cookie instead, which this mocked-`api` unit test can't
    // observe directly (covered by the Playwright browser test instead).
    await waitFor(() => expect(getAccessToken()).toBe('access-1'));
    // Layout's route transition also runs through framer-motion's
    // AnimatePresence, on top of the login step transition already waited
    // for above — give it more room than the default 1000ms. "Dashboard"
    // legitimately appears twice (sidebar nav link + topbar tab).
    expect(await screen.findAllByText('Dashboard', {}, { timeout: 3000 })).not.toHaveLength(0);
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

    await user.type(screen.getByLabelText('Email'), 'bailey@acme.test');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByLabelText('Password');
    await user.type(screen.getByLabelText('Password'), 'ChangeMe123!');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(qc.getQueryData(['me'])).toBeUndefined());
  });
});
