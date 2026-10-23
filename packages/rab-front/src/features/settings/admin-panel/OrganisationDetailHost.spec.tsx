import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import OrganisationDetailHost, { openOrganisationDetailDrawer } from './OrganisationDetailHost';
import { api } from '../../../shared/api';

jest.mock('../../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() } }));
const get = api.get as jest.Mock;
const patch = api.patch as jest.Mock;

const DETAIL = {
  id: 'org-1', name: 'Northside Hospitality', slug: 'northside', suspended: false, createdAt: '2026-01-01T00:00:00Z',
  ceo: { id: 'u-1', email: 'ceo@northside.test', firstName: 'Jane', lastName: 'Doe', accountStatus: 'active', invitationStatus: null, pendingInvite: null },
};
const SETTINGS = {
  organisation: { id: 'org-1', name: 'Northside Hospitality', slug: 'northside', logoKey: null, timezone: 'Europe/London' },
  authProviders: {
    password: { organisationEnabled: true, systemEnabled: true },
    google: { organisationEnabled: true, systemEnabled: true },
    microsoft: { organisationEnabled: false, systemEnabled: false },
  },
};

/** Mirrors the shell: the page lives in the main content; the host is mounted once as a direct child of .app-layout. */
function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <div className="app-layout" data-testid="app-layout">
        <div className="main-content"><div className="settings-page">page</div></div>
        <OrganisationDetailHost />
      </div>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  get.mockReset().mockImplementation((url: string) => {
    if (url === '/admin/organisations/org-1') return Promise.resolve({ data: DETAIL });
    if (url === '/admin/organisations/org-1/settings') return Promise.resolve({ data: SETTINGS });
    throw new Error(`unexpected GET ${url}`);
  });
  patch.mockReset();
});

it('W6-E2E-01: the organisation drawer opens docked as a direct child of .app-layout, never inside a settings page', async () => {
  mount();
  expect(document.querySelector('.side-panel-dock')).toBeNull();
  act(() => openOrganisationDetailDrawer('org-1'));
  expect(await screen.findByText('ceo@northside.test')).toBeInTheDocument();
  const dock = document.querySelector('.side-panel-dock')!;
  // The push-layout dock only has a height as a flex child of the .app-layout row; nested in the block .settings-page it
  // collapsed to 0 px (overflow hidden) — invisible and unclickable.
  expect(dock.parentElement).toBe(screen.getByTestId('app-layout'));
  expect(dock.closest('.settings-page')).toBeNull();
});

it('W6-E2E-04: a platform admin turns password sign-in off only after confirming, through the admin route', async () => {
  patch.mockResolvedValue({ data: { ...SETTINGS, authProviders: { ...SETTINGS.authProviders, password: { organisationEnabled: false, systemEnabled: true } } } });
  mount();
  act(() => openOrganisationDetailDrawer('org-1'));
  const password = await screen.findByRole('checkbox', { name: 'Password sign-in' });
  expect(password).toBeChecked();
  fireEvent.click(password);
  expect(patch).not.toHaveBeenCalled(); // nothing is sent before the explicit confirmation
  fireEvent.click(await screen.findByRole('button', { name: 'Turn off password sign-in' }));
  await waitFor(() => expect(patch).toHaveBeenCalledWith('/admin/organisations/org-1/settings/security', { passwordAuthEnabled: false }));
  expect(patch.mock.calls.some(([url]) => String(url).startsWith('/workspace'))).toBe(false);
  expect(screen.getByRole('checkbox', { name: 'Microsoft sign-in' })).toBeDisabled(); // unavailable on the deployment
});
