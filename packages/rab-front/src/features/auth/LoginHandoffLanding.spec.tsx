import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { api, resolveIdentityViaCookie } from '../../shared/api';
import LoginHandoffLanding from './LoginHandoffLanding';

jest.mock('../../shared/api', () => ({
  api: { post: jest.fn() },
  resolveIdentityViaCookie: jest.fn(),
  getLastIdentityFailure: jest.fn().mockReturnValue(null),
  getLastMeSnapshot: jest.fn().mockReturnValue(null),
  withAuthLock: jest.fn((run: () => unknown) => run()),
  isTransientAuthFailure: (e: { response?: { status?: number } }) => !e?.response || (e.response.status ?? 0) >= 500,
}));

const post = api.post as jest.Mock;
const resolveIdentity = resolveIdentityViaCookie as jest.Mock;
const token = `lho_${'d'.repeat(43)}`;
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { isAxiosError: true, response: { status, data: { code: 'LOGIN_HANDOFF_INVALID' } } });
const peekOk = { data: { maskedEmail: 'j***@example.test', workspaceName: 'Alpha Events', expiresAt: '2026-10-24T12:00:30.000Z' } };

function mount() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/auth/handoff']}>
        <Routes>
          <Route path="/auth/handoff" element={<LoginHandoffLanding />} />
          <Route path="/" element={<p>Dashboard</p>} />
          <Route path="/login" element={<p>Login page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const calls = (path: string) => post.mock.calls.filter(([p]) => p === path);

beforeEach(() => {
  post.mockReset();
  resolveIdentity.mockReset().mockResolvedValue(true);
});

it('strips the token BEFORE anything is sent, peeks, shows "Continue as <masked>", and exchanges ONLY after Continue', async () => {
  window.history.replaceState(null, '', `/auth/handoff#t=${token}`);
  let hashAtPeek = 'unset';
  post.mockImplementation(async (path: string) => {
    if (path === '/auth/login-handoff/peek') {
      hashAtPeek = window.location.hash;
      return peekOk;
    }
    return { data: { mustResetPassword: false } };
  });
  mount();
  expect(await screen.findByRole('heading', { name: 'Continue to Alpha Events?' })).toBeInTheDocument();
  expect(hashAtPeek).toBe('');
  expect(window.location.hash).toBe('');
  expect(screen.getByTestId('handoff-masked-email')).toHaveTextContent('j***@example.test');
  expect(calls('/auth/login-handoff/peek')).toEqual([['/auth/login-handoff/peek', { token }]]);
  // Nothing consumed yet: the exchange waits for the person.
  expect(calls('/auth/login-handoff/exchange')).toHaveLength(0);
  expect(resolveIdentity).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Continue as j***@example.test' }));
  expect(await screen.findByText('Dashboard')).toBeInTheDocument();
  expect(calls('/auth/login-handoff/exchange')).toEqual([['/auth/login-handoff/exchange', { token }]]);
  expect(resolveIdentity).toHaveBeenCalled();
});

it('ABUSE (attacker-sent link): "Not you?" sends nothing — no exchange, no session — and goes to sign-in', async () => {
  window.history.replaceState(null, '', `/auth/handoff#t=${token}`);
  post.mockResolvedValue({ data: { maskedEmail: 'a***@attacker.example', workspaceName: 'Attacker Co', expiresAt: 'x' } });
  mount();
  expect(await screen.findByRole('heading', { name: 'Continue to Attacker Co?' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Not you? Sign in with another account' }));
  expect(await screen.findByText('Login page')).toBeInTheDocument();
  expect(calls('/auth/login-handoff/exchange')).toHaveLength(0);
  expect(resolveIdentity).not.toHaveBeenCalled();
});

it('a used/expired/foreign token (peek 401) shows the honest "expired" screen; nothing is exchanged, never retried', async () => {
  window.history.replaceState(null, '', `/auth/handoff#t=${token}`);
  post.mockRejectedValue(httpError(401));
  mount();
  expect(await screen.findByRole('heading', { name: 'This sign-in link has expired' })).toBeInTheDocument();
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  expect(calls('/auth/login-handoff/exchange')).toHaveLength(0);
  expect(resolveIdentity).not.toHaveBeenCalled();
});

it('an exchange refused after Continue (the link died meanwhile) shows "expired" and is never retried', async () => {
  window.history.replaceState(null, '', `/auth/handoff#t=${token}`);
  post.mockImplementation(async (path: string) => {
    if (path === '/auth/login-handoff/peek') return peekOk;
    throw httpError(401);
  });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Continue as j***@example.test' }));
  expect(await screen.findByRole('heading', { name: 'This sign-in link has expired' })).toBeInTheDocument();
  expect(calls('/auth/login-handoff/exchange')).toHaveLength(1);
});

it('a network failure during the peek reads as "couldn’t reach", not "expired"', async () => {
  window.history.replaceState(null, '', `/auth/handoff#t=${token}`);
  post.mockRejectedValue(Object.assign(new Error('Network Error'), { isAxiosError: true }));
  mount();
  expect(await screen.findByRole('heading', { name: 'We couldn’t reach Crewflow' })).toBeInTheDocument();
});

it('no (or a malformed) token: nothing is sent', async () => {
  window.history.replaceState(null, '', '/auth/handoff#t=<script>');
  mount();
  expect(await screen.findByRole('heading', { name: 'This sign-in link has expired' })).toBeInTheDocument();
  expect(post).not.toHaveBeenCalled();
  expect(window.location.hash).toBe('');
});
