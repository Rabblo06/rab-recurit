import axios from 'axios';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getLastIdentityFailure, resolveIdentityViaCookie } from '../../shared/api';
import OAuthCallbackComplete from './OAuthCallbackComplete';

jest.mock('axios', () => {
  const isAxiosError = (e: unknown) => !!(e as { isAxiosError?: boolean })?.isAxiosError;
  return { __esModule: true, default: { get: jest.fn(), post: jest.fn(), isAxiosError } };
});
jest.mock('../../shared/api', () => ({
  api: { defaults: { baseURL: 'http://api.test/rest/v1' } },
  resolveIdentityViaCookie: jest.fn(),
  getLastIdentityFailure: jest.fn(),
  getLastMeSnapshot: jest.fn().mockReturnValue({ id: 'u1', email: 'ada@example.test' }),
  withAuthLock: jest.fn((run: () => unknown) => run()),
  isTransientAuthFailure: (e: { response?: { status?: number } }) => !e?.response || (e.response.status ?? 0) >= 500 || e.response.status === 429,
}));

const get = axios.get as jest.Mock;
const post = axios.post as jest.Mock;
const resolveIdentity = resolveIdentityViaCookie as jest.Mock;
const lastFailure = getLastIdentityFailure as jest.Mock;
const httpError = (status: number, data: unknown = {}) => Object.assign(new Error(`HTTP ${status}`), { isAxiosError: true, response: { status, data } });

function mount(path: string) {
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/oauth/callback-complete" element={<OAuthCallbackComplete />} />
          <Route path="/" element={<p>Dashboard</p>} />
          <Route path="/shifts" element={<p>Shifts page</p>} />
          <Route path="/set-password" element={<p>Set password</p>} />
          <Route path="/login" element={<p>Login page</p>} />
          <Route path="/accept-invitation" element={<p>Invitation page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return qc;
}

const signInSummary = { intent: 'sign_in', provider: 'google', email: 'ada@example.test', returnTo: '/shifts', secondFactor: 'none', invitation: null };

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  resolveIdentity.mockReset().mockResolvedValue(true);
  lastFailure.mockReset().mockReturnValue(null);
});

it('handoff sign-in completes automatically with a credentialed POST (no credential in the URL) and lands on the return path', async () => {
  get.mockResolvedValue({ data: signInSummary });
  post.mockResolvedValue({ data: { mustResetPassword: false, returnTo: '/shifts' } });
  mount('/oauth/callback-complete?handoff=1');
  expect(await screen.findByText('Shifts page')).toBeInTheDocument();
  expect(get).toHaveBeenCalledWith('http://api.test/rest/v1/auth/oauth/handoff', { withCredentials: true });
  expect(post).toHaveBeenCalledWith('http://api.test/rest/v1/auth/oauth/complete', {}, { withCredentials: true });
  expect(resolveIdentity).toHaveBeenCalled();
});

it('a forced password reset goes to set-password', async () => {
  get.mockResolvedValue({ data: signInSummary });
  post.mockResolvedValue({ data: { mustResetPassword: true, returnTo: '/shifts' } });
  mount('/oauth/callback-complete?handoff=1');
  expect(await screen.findByText('Set password')).toBeInTheDocument();
});

it('an invitation asks before joining; Accept completes it, Cancel abandons it', async () => {
  get.mockResolvedValue({
    data: { ...signInSummary, intent: 'accept_invitation', returnTo: '/', invitation: { email: 'ada@example.test', workspaceName: 'Northwind', roleLabel: 'Supervisor' } },
  });
  post.mockResolvedValue({ data: { mustResetPassword: false, returnTo: '/' } });
  mount('/oauth/callback-complete?handoff=1');
  expect(await screen.findByRole('heading', { name: 'Join Northwind' })).toBeInTheDocument();
  expect(screen.getByText(/invited as Supervisor/)).toBeInTheDocument();
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));
  expect(await screen.findByText('Dashboard')).toBeInTheDocument();
  expect(post).toHaveBeenCalledWith('http://api.test/rest/v1/auth/oauth/complete', {}, { withCredentials: true });
});

it('cancel on the invitation screen abandons the handoff and returns to sign-in', async () => {
  get.mockResolvedValue({ data: { ...signInSummary, intent: 'accept_invitation', invitation: { email: 'a@x.test', workspaceName: null, roleLabel: 'Member' } } });
  post.mockResolvedValue({});
  mount('/oauth/callback-complete?handoff=1');
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
  expect(await screen.findByText('Login page')).toBeInTheDocument();
  expect(post).toHaveBeenCalledWith('http://api.test/rest/v1/auth/oauth/cancel', {}, { withCredentials: true });
});

it('a refused or reused handoff goes to the sign-in error, never a different account', async () => {
  get.mockRejectedValue(httpError(401));
  mount('/oauth/callback-complete?handoff=1');
  expect(await screen.findByText('Login page')).toBeInTheDocument();
  expect(post).not.toHaveBeenCalled();
  expect(resolveIdentity).not.toHaveBeenCalled();
});

it('a refused invitation completion returns to the invitation error page', async () => {
  get.mockResolvedValue({ data: { ...signInSummary, intent: 'accept_invitation', invitation: { email: 'a@x.test', workspaceName: 'W', roleLabel: 'R' } } });
  post.mockRejectedValue(httpError(401));
  mount('/oauth/callback-complete?handoff=1');
  fireEvent.click(await screen.findByRole('button', { name: 'Accept invitation' }));
  expect(await screen.findByText('Invitation page')).toBeInTheDocument();
});

it('audit F5: an outage during completion offers a retry (in red) instead of a sign-in error', async () => {
  get.mockResolvedValue({ data: signInSummary });
  post.mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce({ data: { mustResetPassword: false, returnTo: '/shifts' } });
  mount('/oauth/callback-complete?handoff=1');
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/haven’t been signed out/);
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Shifts page')).toBeInTheDocument();
  expect(post).toHaveBeenCalledTimes(2);
});

it('a required second factor is reported honestly — no session, no fake verification screen', async () => {
  get.mockResolvedValue({ data: { ...signInSummary, secondFactor: 'verify' } });
  mount('/oauth/callback-complete?handoff=1');
  expect(await screen.findByRole('heading', { name: 'Additional verification required' })).toBeInTheDocument();
  expect(post).not.toHaveBeenCalled();
});

it('legacy mode (cookies already set by the callback) only resolves identity', async () => {
  mount('/oauth/callback-complete?mustResetPassword=false&returnTo=%2Fshifts');
  expect(await screen.findByText('Shifts page')).toBeInTheDocument();
  expect(get).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();
});

it('legacy mode refuses an unsafe return path', async () => {
  mount('/oauth/callback-complete?mustResetPassword=false&returnTo=%2F%2Fevil.example');
  expect(await screen.findByText('Dashboard')).toBeInTheDocument();
});

it('legacy mode with an unreachable API shows a retry, not a logout', async () => {
  resolveIdentity.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  lastFailure.mockReturnValueOnce('unavailable');
  mount('/oauth/callback-complete?mustResetPassword=false&returnTo=%2Fshifts');
  fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Shifts page')).toBeInTheDocument();
});
