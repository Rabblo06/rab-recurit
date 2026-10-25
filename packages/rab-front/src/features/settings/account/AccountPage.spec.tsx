import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { api } from '../../../shared/api';
import AccountPage from './AccountPage';

jest.mock('../../../shared/api', () => ({
  api: { get: jest.fn(), patch: jest.fn() },
}));
jest.mock('./NotificationsCard', () => () => null);

const get = api.get as jest.Mock;

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname + location.search}</p>;
}

function mount(path: string) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/settings/account" element={<AccountPage />} />
          <Route path="/settings/security" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  get
    .mockReset()
    .mockResolvedValue({
      data: { isPlatformAdmin: false, email: 'me@example.test' },
    });
  sessionStorage.clear();
});

it('two-factor authentication moved to Security: Account links there and no longer manages it', () => {
  mount('/settings/account');
  expect(
    screen.getByRole('link', { name: 'Open Security settings' }),
  ).toHaveAttribute('href', '/settings/security');
  expect(
    screen.queryByRole('button', { name: /Set up|Turn on/ }),
  ).not.toBeInTheDocument();
  expect(get).not.toHaveBeenCalledWith('/auth/mfa');
});

it('a Microsoft re-auth started on Security (the server returns to /settings/account) is forwarded back to Security', () => {
  sessionStorage.setItem(
    'cf-security-reauth-intent',
    JSON.stringify({ intent: 'disable', at: Date.now() }),
  );
  mount('/settings/account?reauth=ok');
  expect(screen.getByTestId('where')).toHaveTextContent(
    '/settings/security?reauth=ok',
  );
});

it('a ?reauth= return without the Security page’s note stays on Account (StepUpHost flows are unchanged)', () => {
  mount('/settings/account?reauth=ok');
  expect(screen.queryByTestId('where')).not.toBeInTheDocument();
  expect(
    screen.getByRole('link', { name: 'Open Security settings' }),
  ).toBeInTheDocument();
});

it('a stale note (older than 15 minutes) is ignored', () => {
  sessionStorage.setItem(
    'cf-security-reauth-intent',
    JSON.stringify({ intent: 'enrol', at: Date.now() - 16 * 60 * 1000 }),
  );
  mount('/settings/account?reauth=failed');
  expect(screen.queryByTestId('where')).not.toBeInTheDocument();
});
