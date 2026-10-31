import { act, fireEvent, screen, waitFor } from '@testing-library/react';

import { api } from '../../../shared/api';
import AdminPanelPage, { ADMIN_TAB_STORAGE_KEY } from './AdminPanelPage';
import { ME, renderWithQuery, routeGet } from './adminPanelTestKit';

jest.mock('../../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() } }));
const get = api.get as jest.Mock;

function routes(maintenance = false) {
  routeGet(get, {
    '/auth/me': ME,
    '/admin/config': { maintenanceMode: { enabled: maintenance, message: null } },
    '/admin/health/report': { checkedAt: new Date().toISOString(), attention: 2, cards: [] },
    '/admin/users/search': [],
    '/admin/platform-admins': [],
    [`/admin/lookup/organisations/${ME.organisationId}/summary`]: { id: ME.organisationId, name: 'Crewflow HQ', slug: 'hq', suspended: false, suspendedAt: null, createdAt: '2026-01-01T00:00:00Z', ceo: null, members: { active: 3 }, workspaces: { total: 1, ready: 1, creating: 0, failed: 0 } },
  });
}

beforeEach(() => {
  get.mockReset();
  window.localStorage.clear();
  routes();
});

it('renders the "Admin panel" header and six tabs General | Health | Config | Security | Workspaces | Audit (role=tab, aria-selected)', async () => {
  renderWithQuery(<AdminPanelPage />);
  expect(screen.getByRole('heading', { level: 1, name: 'Admin panel' })).toBeTruthy();
  const tabs = screen.getAllByRole('tab');
  expect(tabs.map((t) => t.textContent?.replace(/\d+$/, ''))).toEqual(['General', 'Health', 'Config', 'Security', 'Workspaces', 'Audit']);
  expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('ap-tab-general');
  // The Health badge is the server's count of cards needing attention.
  await waitFor(() => expect(screen.getByLabelText('2 need attention')).toBeTruthy());
});

it('remembers the tab in localStorage cf-admin-tab and restores it', () => {
  const first = renderWithQuery(<AdminPanelPage />);
  fireEvent.click(screen.getByRole('tab', { name: /Security/ }));
  expect(window.localStorage.getItem(ADMIN_TAB_STORAGE_KEY)).toBe('security');
  first.unmount();
  renderWithQuery(<AdminPanelPage />);
  expect(screen.getByRole('tab', { name: /Security/ }).getAttribute('aria-selected')).toBe('true');
});

it('keeps working when storage throws (private window) — falls back to General', () => {
  const spy = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  const set = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  renderWithQuery(<AdminPanelPage />);
  expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('true');
  fireEvent.click(screen.getByRole('tab', { name: 'Audit' }));
  expect(screen.getByRole('tab', { name: 'Audit' }).getAttribute('aria-selected')).toBe('true');
  spy.mockRestore();
  set.mockRestore();
});

it('arrow keys move between tabs (roving tabindex)', () => {
  renderWithQuery(<AdminPanelPage />);
  const general = screen.getByRole('tab', { name: 'General' });
  fireEvent.keyDown(general, { key: 'ArrowRight' });
  expect(screen.getByRole('tab', { name: /Health/ }).getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(screen.getByRole('tab', { name: /Health/ }), { key: 'End' });
  expect(screen.getByRole('tab', { name: 'Audit' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('tab', { name: 'Audit' }).getAttribute('tabindex')).toBe('0');
  expect(general.getAttribute('tabindex')).toBe('-1');
});

it('shows the maintenance banner only when the server says maintenance is on for the admin’s organisation', async () => {
  routes(true);
  renderWithQuery(<AdminPanelPage />);
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Maintenance mode is on for your organisation'));
  fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
  expect(screen.getByRole('tab', { name: 'Config' }).getAttribute('aria-selected')).toBe('true');
});

it('owner correction 2026-10-23: no organisation creation anywhere in the panel', () => {
  renderWithQuery(<AdminPanelPage />);
  for (const t of ['General', 'Health', 'Config', 'Security', 'Workspaces', 'Audit']) fireEvent.click(screen.getByRole('tab', { name: new RegExp(t) }));
  expect(screen.queryByRole('button', { name: /new organisation/i })).toBeNull();
  expect(screen.queryByLabelText('Organisation name')).toBeNull();
  expect(get.mock.calls.some(([url]) => String(url) === '/admin/organisations')).toBe(false);
});

describe('Phase C1: the health report is polled fast only on the Health tab', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5); // jitter factor exactly 1
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
  const tick = (ms: number) => act(async () => { await jest.advanceTimersByTimeAsync(ms); });
  const reportCalls = () => get.mock.calls.filter(([u]: [string]) => u === '/admin/health/report').length;

  it('elsewhere (General) the attention badge refreshes every 60 s, not every 15 s', async () => {
    const { qc } = renderWithQuery(<AdminPanelPage />);
    await tick(20);
    expect(reportCalls()).toBe(1);
    await tick(45_000);
    expect(reportCalls()).toBe(1);
    await tick(15_100);
    expect(reportCalls()).toBe(2);
    qc.clear();
  });

  it('on the Health tab the report is polled every 15 s', async () => {
    window.localStorage.setItem(ADMIN_TAB_STORAGE_KEY, 'health');
    const { qc } = renderWithQuery(<AdminPanelPage />);
    await tick(20);
    const first = reportCalls();
    await tick(15_100);
    expect(reportCalls()).toBe(first + 1);
    await tick(15_000);
    expect(reportCalls()).toBe(first + 2);
    qc.clear();
  });
});
