import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { api } from '../../../shared/api';
import CeoRoute from '../CeoRoute';
import SettingsSidebar from '../layout/SettingsSidebar';

/**
 * U1 condition 7: Settings → AI is the CEO's only. A non-CEO gets no menu entry and the route sends them away (the
 * server answers 404 to every /ai/settings route for them — proven server-side in ai-settings-phase8.integration.spec).
 */
jest.mock('../../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn(), defaults: { baseURL: 'http://api.test/rest/v1' } } }));
const get = api.get as jest.Mock;

const wrap = (ui: JSX.Element, path = '/settings/ai') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  get.mockReset();
  get.mockImplementation((url: string) => (url === '/leadership/capabilities' ? Promise.resolve({ data: { leadership: { canCreateOrganisation: false, initialManagerScope: 'none' } } }) : Promise.reject({ isAxiosError: true, response: { status: 404, data: {} } })));
});

it('the settings menu shows "AI" only when the shell says so (CEO + AI chrome allowed)', async () => {
  const { unmount } = wrap(<SettingsSidebar isPlatformAdmin={false} isPlatformAdminOnly={false} onLogoutClick={() => undefined} showAi={false} />);
  expect(await screen.findByText('General')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'AI' })).not.toBeInTheDocument();
  unmount();
  wrap(<SettingsSidebar isPlatformAdmin={false} isPlatformAdminOnly={false} onLogoutClick={() => undefined} showAi />);
  expect(await screen.findByRole('link', { name: 'AI' })).toHaveAttribute('href', '/settings/ai');
});

it('a non-CEO opening /settings/ai is sent away before the page mounts; nothing of Settings → AI is requested', async () => {
  get.mockImplementation((url: string) => (url === '/auth/me' ? Promise.resolve({ data: { roles: ['manager'] } }) : Promise.reject({ isAxiosError: true, response: { status: 404, data: {} } })));
  wrap(
    <Routes>
      <Route path="/settings/ai" element={<CeoRoute><p>AI settings page</p></CeoRoute>} />
      <Route path="/settings/profile" element={<p>Profile page</p>} />
    </Routes>,
  );
  expect(await screen.findByText('Profile page')).toBeInTheDocument();
  expect(screen.queryByText('AI settings page')).not.toBeInTheDocument();
  expect(get.mock.calls.some(([u]) => String(u).startsWith('/ai/settings'))).toBe(false);
});

it('the CEO reaches it', async () => {
  get.mockImplementation((url: string) => (url === '/auth/me' ? Promise.resolve({ data: { roles: ['ceo'] } }) : Promise.reject({ isAxiosError: true, response: { status: 404, data: {} } })));
  wrap(
    <Routes>
      <Route path="/settings/ai" element={<CeoRoute><p>AI settings page</p></CeoRoute>} />
      <Route path="/settings/profile" element={<p>Profile page</p>} />
    </Routes>,
  );
  expect(await screen.findByText('AI settings page')).toBeInTheDocument();
});
