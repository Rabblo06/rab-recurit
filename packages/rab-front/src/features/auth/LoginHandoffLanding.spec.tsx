import { render, screen, waitFor } from '@testing-library/react';
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

beforeEach(() => {
  post.mockReset();
  resolveIdentity.mockReset().mockResolvedValue(true);
});

it('strips the token from the address bar BEFORE the exchange, POSTs it as JSON and lands on the dashboard', async () => {
  window.history.replaceState(null, '', `/auth/handoff#t=${token}`);
  let hashAtExchange = 'unset';
  post.mockImplementation(async () => {
    hashAtExchange = window.location.hash;
    return { data: { mustResetPassword: false } };
  });
  mount();
  expect(await screen.findByText('Dashboard')).toBeInTheDocument();
  expect(hashAtExchange).toBe('');
  expect(window.location.hash).toBe('');
  expect(post).toHaveBeenCalledWith('/auth/login-handoff/exchange', { token });
  expect(resolveIdentity).toHaveBeenCalled();
});

it('a used/expired/foreign token shows an honest "expired" screen and never retries', async () => {
  window.history.replaceState(null, '', `/auth/handoff#t=${token}`);
  post.mockRejectedValue(httpError(401));
  mount();
  expect(await screen.findByRole('heading', { name: 'This sign-in link has expired' })).toBeInTheDocument();
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  expect(resolveIdentity).not.toHaveBeenCalled();
});

it('no (or a malformed) token: nothing is sent', async () => {
  window.history.replaceState(null, '', '/auth/handoff#t=<script>');
  mount();
  expect(await screen.findByRole('heading', { name: 'This sign-in link has expired' })).toBeInTheDocument();
  expect(post).not.toHaveBeenCalled();
  expect(window.location.hash).toBe('');
});
