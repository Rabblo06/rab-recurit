import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import { api, withAuthLock, broadcastLogout } from '../../../shared/api';
import { markUnauthenticated } from '../../../shared/lib/auth-session';
import DevicesList from './DevicesList';

/**
 * P2.2 — the two bulk session-revocation controls this file added: "sign out of all other
 * devices" (keeps the caller's own session alive) and "sign out everywhere" (ends every session,
 * including this one, with the same client-side cleanup a normal logout already does). Only
 * `shared/api` and `shared/lib/auth-session` are mocked, matching every other component spec in
 * this project (`ProfilePage.spec.tsx`'s own doc comment explains why: `api.ts`'s
 * `import.meta.env` access doesn't parse under this project's CommonJS `tsconfig.spec.json`).
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

function session(familyId: string, isCurrentDevice: boolean) {
  return { familyId, deviceId: null, userAgent: 'Chrome on Windows', ip: '127.0.0.1', createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), isCurrentDevice };
}

function renderIt() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <DevicesList />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => jest.clearAllMocks());

describe('DevicesList — bulk session revocation (P2.2)', () => {
  it('"sign out of all other devices" is disabled when there are no other sessions', async () => {
    mockApi.get.mockResolvedValue({ data: [session('current', true)] });
    renderIt();
    await waitFor(() => expect(screen.getByText('Sign out of all other devices')).toBeDisabled());
  });

  it('confirming "sign out of all other devices" calls DELETE /profile/sessions and leaves this device alone (no navigation, no logout cleanup)', async () => {
    mockApi.get.mockResolvedValue({ data: [session('current', true), session('other', false)] });
    mockApi.delete.mockResolvedValue({ data: { revokedCount: 1 } });
    renderIt();

    await waitFor(() => expect(screen.getByText('Sign out of all other devices')).not.toBeDisabled());
    fireEvent.click(screen.getByText('Sign out of all other devices'));
    fireEvent.click(await screen.findByText('Sign out others'));

    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith('/profile/sessions'));
    expect(markUnauthenticated).not.toHaveBeenCalled();
    expect(broadcastLogout).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('confirming "sign out everywhere" calls POST /profile/sessions/logout-all under the auth lock, then runs the same client cleanup a normal logout does', async () => {
    mockApi.get.mockResolvedValue({ data: [session('current', true)] });
    mockApi.post.mockResolvedValue({ data: { revokedCount: 1 } });
    renderIt();

    // "Sign out everywhere" is both the trigger button and the confirm dialog's own confirm
    // label — the trigger is the FIRST one in the DOM before the dialog opens.
    fireEvent.click((await screen.findAllByText('Sign out everywhere'))[0]!);
    const confirmButtons = await screen.findAllByText('Sign out everywhere');
    fireEvent.click(confirmButtons[confirmButtons.length - 1]!);

    await waitFor(() => expect(withAuthLock).toHaveBeenCalled());
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/profile/sessions/logout-all'));
    await waitFor(() => expect(markUnauthenticated).toHaveBeenCalled());
    expect(broadcastLogout).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/login');
  });

  it('a per-device "Revoke" button is still unaffected by the new bulk controls', async () => {
    mockApi.get.mockResolvedValue({ data: [session('current', true), session('other', false)] });
    mockApi.delete.mockResolvedValue({});
    renderIt();

    fireEvent.click(await screen.findByText('Revoke'));
    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith('/profile/sessions/other'));
  });
});
