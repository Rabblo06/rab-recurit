import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation, type Location } from 'react-router-dom';
import type { ReactElement } from 'react';

import { api } from '../../shared/api';
import PasswordCard from '../settings/security/PasswordCard';
import ForgotPassword from './ForgotPassword';
import Login from './Login';

jest.mock('../../shared/api', () => ({
  api: { get: jest.fn(), post: jest.fn(), defaults: { baseURL: 'http://api.test/rest/v1' } },
  withAuthLock: jest.fn((run: () => unknown) => run()),
  resolveIdentityViaCookie: jest.fn().mockResolvedValue(true),
  getLastMeSnapshot: jest.fn().mockReturnValue(null),
}));

/**
 * XA-08 (Phase X2, X6.2): the address typed on the sign-in screen (or the signed-in user's own address on the security
 * page) is handed to /forgot-password in router state, never in the URL. A query string or fragment lands in browser
 * history, server and proxy access logs and any Referer; an email address is personal data. The UX stays: the field
 * on the forgot-password screen is still pre-filled.
 */
const get = api.get as jest.Mock;
const ADDRESS = 'ada.lovelace+reset@example.test';

let seen: Location[] = [];
function LocationProbe() {
  seen.push(useLocation());
  return null;
}

beforeEach(() => {
  seen = [];
  get.mockReset().mockResolvedValue({ data: { authProviders: { password: true, google: false, microsoft: false } } });
  (api.post as jest.Mock).mockReset();
});

function renderRoutes(start: string | { pathname: string; search?: string; state?: unknown }, from: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[start]}>
        <LocationProbe />
        <Routes>
          <Route path="/login" element={from} />
          <Route path="/settings/security" element={from} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The address must appear nowhere in any URL the router ever held: path, query string or fragment. */
function expectAddressNeverInUrl() {
  const encoded = encodeURIComponent(ADDRESS);
  for (const location of seen) {
    for (const part of [location.pathname, location.search, location.hash]) {
      expect(part).not.toContain(ADDRESS);
      expect(part).not.toContain(encoded);
      expect(part).not.toContain('email');
    }
  }
}

describe('forgot-password e-mail hand-over (XA-08)', () => {
  it('from the sign-in password step: the field is pre-filled, and the address is never in location.search or location.hash', async () => {
    renderRoutes('/login', <Login />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with email' }));
    fireEvent.change(await screen.findByLabelText('Work email'), { target: { value: ADDRESS } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByLabelText('Password');

    const link = screen.getByRole('link', { name: 'Forgot password?' });
    expect(link).toHaveAttribute('href', '/forgot-password');
    fireEvent.click(link);

    expect(await screen.findByRole('heading', { name: 'Forgot your password?' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveValue(ADDRESS);
    const last = seen[seen.length - 1];
    expect(last.pathname).toBe('/forgot-password');
    expect(last.search).toBe('');
    expect(last.hash).toBe('');
    expectAddressNeverInUrl();
  });

  it('from the security page "Reset password": the field is pre-filled, and the address is never in the URL', async () => {
    renderRoutes('/settings/security', <PasswordCard email={ADDRESS} />);
    const link = screen.getByRole('link', { name: 'Reset password' });
    expect(link).toHaveAttribute('href', '/forgot-password');
    fireEvent.click(link);

    expect(await screen.findByLabelText('Email')).toHaveValue(ADDRESS);
    const last = seen[seen.length - 1];
    expect(last.search).toBe('');
    expect(last.hash).toBe('');
    expectAddressNeverInUrl();
  });

  it('with no address to hand over (empty field / no password account) the screen opens with an empty field', async () => {
    renderRoutes('/settings/security', <PasswordCard />);
    fireEvent.click(screen.getByRole('link', { name: 'Reset password' }));
    expect(await screen.findByLabelText('Email')).toHaveValue('');
  });

  it('a legacy ?email= link is not read back into the form (the URL is never a carrier, in either direction)', async () => {
    renderRoutes(`/forgot-password?email=${encodeURIComponent(ADDRESS)}`, <Login />);
    expect(await screen.findByLabelText('Email')).toHaveValue('');
  });

  it('router state that is not a string address is ignored, not rendered', async () => {
    renderRoutes({ pathname: '/forgot-password', state: { email: { toString: () => ADDRESS } } }, <Login />);
    expect(await screen.findByLabelText('Email')).toHaveValue('');
  });
});
