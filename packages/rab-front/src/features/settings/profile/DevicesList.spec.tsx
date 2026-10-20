import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import { api, withAuthLock, broadcastLogout } from '../../../shared/api';
import { markUnauthenticated } from '../../../shared/lib/auth-session';
import DevicesList from './DevicesList';

/**
 * Settings → Profile → Devices: server-backed session rows, the server-identified current device ("This device"), a per-row
 * "More options" menu with "Log out", and the conditional "Log out all other devices". "Sign out everywhere" was removed from
 * the Profile UI (owner decision 2026-10-19); the server's revoke-all primitive stays for security workflows. Only `shared/api` and `shared/lib/auth-session` are mocked (`api.ts`'s `import.meta.env` doesn't parse under
 * this project's CommonJS `tsconfig.spec.json`; see `ProfilePage.spec.tsx`).
 */
jest.mock('../../../shared/api', () => ({
  api: { get: jest.fn(), delete: jest.fn(), post: jest.fn() },
  withAuthLock: jest.fn((run: () => Promise<unknown>) => run()),
  broadcastLogout: jest.fn(),
}));
jest.mock('../../../shared/lib/auth-session', () => ({
  markUnauthenticated: jest.fn(),
}));
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

const mockApi = api as unknown as { get: jest.Mock; delete: jest.Mock; post: jest.Mock };
const mockNavigate = jest.fn();
const CHROME_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

function session(familyId: string, isCurrentDevice: boolean, extra: Record<string, unknown> = {}) {
  return {
    familyId, deviceId: null, userAgent: CHROME_WINDOWS, ip: '203.0.113.7', ipScope: 'public',
    createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), isCurrentDevice, ...extra,
  };
}

function renderIt(node = <DevicesList />) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => jest.clearAllMocks());

describe('DevicesList', () => {
  it('shows each server session with its browser/OS label, last activity and IP, and badges the current one "This device"', async () => {
    mockApi.get.mockResolvedValue({ data: [session('current', true), session('other', false, { ip: '172.18.0.1', ipScope: 'private' })] });
    renderIt();
    expect(await screen.findByText('This device')).toBeInTheDocument();
    expect(screen.getAllByText('Chrome on Windows')).toHaveLength(2);
    expect(screen.getByText(/203\.0\.113\.7/)).toBeInTheDocument();
    // An unverifiable (private/Docker) address is labelled as such, never presented as the client's public IP.
    expect(screen.getByText(/Private network \(172\.18\.0\.1\)/)).toBeInTheDocument();
    expect(screen.getAllByText('This device')).toHaveLength(1);
  });

  it('a failed request is an error with Retry — never "no active sessions"', async () => {
    mockApi.get.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ data: [session('current', true)] });
    renderIt();
    expect(await screen.findByRole('alert')).toHaveTextContent('Your devices could not be loaded. Check your connection.');
    expect(screen.queryByText(/No active sessions/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('This device')).toBeInTheDocument();
  });

  it('"Log out all other devices" appears only when there is a current session AND another one', async () => {
    mockApi.get.mockResolvedValue({ data: [session('current', true)] });
    renderIt();
    await screen.findByText('This device');
    expect(screen.queryByText('Log out all other devices')).toBeNull();
  });

  it('confirming "Log out all other devices" calls DELETE /profile/sessions and leaves this device signed in', async () => {
    mockApi.get.mockResolvedValue({ data: [session('current', true), session('other', false)] });
    mockApi.delete.mockResolvedValue({ data: { revokedCount: 1 } });
    renderIt();
    fireEvent.click(await screen.findByText('Log out all other devices'));
    fireEvent.click(await screen.findByText('Log out other devices'));
    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith('/profile/sessions'));
    expect(markUnauthenticated).not.toHaveBeenCalled();
    expect(broadcastLogout).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('the per-session "More options" menu logs out exactly that session; the current session has no menu', async () => {
    mockApi.get.mockResolvedValue({ data: [session('current', true), session('other', false)] });
    mockApi.delete.mockResolvedValue({});
    renderIt();
    const triggers = await screen.findAllByRole('button', { name: 'More options for Chrome on Windows' });
    expect(triggers).toHaveLength(1);
    fireEvent.click(triggers[0]!);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Log out' }));
    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith('/profile/sessions/other'));
  });
});

describe('DevicesList error and empty states', () => {
  const failWith = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });

  it.each([
    [401, 'Your session has ended'],
    [503, 'The session service is unavailable'],
  ])('a %s says what failed and offers Retry — never an empty list', async (status, text) => {
    mockApi.get.mockRejectedValue(failWith(status));
    renderIt();
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText(/No active sessions/)).toBeNull();
  });

  it('only a successful empty response shows the empty message', async () => {
    mockApi.get.mockResolvedValue({ data: [] });
    renderIt();
    expect(await screen.findByText('No active sessions were returned for your account.')).toBeInTheDocument();
    expect(screen.queryByText('Log out all other devices')).toBeNull();
  });

  it('automated and script sessions are labelled truthfully, not as a person\'s Chrome', async () => {
    mockApi.get.mockResolvedValue({ data: [
      session('current', true),
      session('bot', false, { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36' }),
      session('cli', false, { userAgent: 'node' }),
    ] });
    renderIt();
    expect(await screen.findByText('Automated browser (Headless Chrome) on Windows')).toBeInTheDocument();
    expect(screen.getByText('Script or API client')).toBeInTheDocument();
    // Every session stays its own row, each with its own menu.
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });
});
