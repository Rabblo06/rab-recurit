import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { createRef } from 'react';

import { api } from '../shared/api';
import AdminDropdown from './AdminDropdown';

jest.mock('../shared/api', () => ({ api: { get: jest.fn() } }));
const mockApi = api as unknown as { get: jest.Mock };

function serve(me: { roles: string[]; isPlatformAdmin: boolean }, caps: Record<string, boolean>) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/auth/me') return Promise.resolve({ data: me });
    if (url === '/auth/capabilities') return Promise.resolve({ data: caps });
    if (url === '/profile') return Promise.resolve({ data: { id: 'u1', firstName: 'Avery', lastName: 'Quinn', email: 'avery@example.test', jobTitle: null, avatarKey: null } });
    return Promise.resolve({ data: {} });
  });
}
function Where() { return <output data-testid="where">{useLocation().pathname + useLocation().search}</output>; }
function mount(onLogout = jest.fn(), onClose = jest.fn()) {
  const trigger = createRef<HTMLButtonElement>();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/']}>
        <button ref={trigger}>Account</button>
        <Routes><Route path="*" element={<><Where /><AdminDropdown open onClose={onClose} onLogout={onLogout} triggerRef={trigger} /></>} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onLogout, onClose, trigger };
}

beforeEach(() => mockApi.get.mockReset());

describe('Account menu', () => {
  it('shows the real profile, then the Manager actions in order, each opening its EXISTING flow', async () => {
    serve({ roles: ['manager'], isPlatformAdmin: false }, { 'staff.create': true, 'venue_manager.create': true });
    const heard: unknown[] = [];
    const listener = (e: Event) => heard.push((e as CustomEvent).detail);
    document.addEventListener('open-create-user', listener);
    mount();
    expect(await screen.findByText('Avery Quinn')).toBeInTheDocument();
    expect(screen.getByText('avery@example.test')).toBeInTheDocument();
    await screen.findByRole('menuitem', { name: 'Add venue manager' });
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent?.replace(/(Light|Dark|System)$/, ''))).toEqual(['Add Staff', 'Add venue manager', 'Invite member', 'Theme', 'Settings', 'Log out']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add Staff' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add venue manager' }));
    document.removeEventListener('open-create-user', listener);
    // Add venue manager is the workspace Venue Manager creation flow — never member invitations.
    expect(heard).toEqual([{ role: 'staff' }, { role: 'manager', scope: 'workspace' }]);
  });

  it('Invite member opens the member invitation flow; Log out uses the normal logout', async () => {
    serve({ roles: ['manager'], isPlatformAdmin: false }, {});
    const { onLogout } = mount();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Invite member' }));
    expect(screen.getByTestId('where').textContent).toBe('/settings/workspace/members?tab=invite');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Log out' }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it('hides actions the account may not take (no capability → no Add Staff / Add venue manager)', async () => {
    serve({ roles: ['manager'], isPlatformAdmin: false }, { 'staff.create': false, 'venue_manager.create': false });
    mount();
    await screen.findByRole('menuitem', { name: 'Invite member' });
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/auth/capabilities'));
    expect(screen.queryByRole('menuitem', { name: 'Add Staff' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Add venue manager' })).toBeNull();
    expect(screen.queryByText(/sign out everywhere|delete account/i)).toBeNull();
  });

  it('Escape closes it and returns focus to the trigger', async () => {
    serve({ roles: ['manager'], isPlatformAdmin: false }, {});
    const { onClose, trigger } = mount();
    await screen.findByRole('menuitem', { name: 'Settings' });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger.current);
  });
});
