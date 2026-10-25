import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { api } from '../../../shared/api';
import GeneralTab from './GeneralTab';
import { ME, renderWithQuery, routeGet, user } from './adminPanelTestKit';
import { RESET_TOOLTIP } from './UserResultCard';

jest.mock('../../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() } }));
jest.mock('./OrganisationDetailHost', () => ({ openOrganisationDetailDrawer: jest.fn() }));
const get = api.get as jest.Mock;
const post = api.post as jest.Mock;

const enrolled = user();
const notEnrolled = user({ id: 'u2-00000-4000-8000-000000000002', firstName: 'Sam', lastName: 'Patel', email: 'sam@example.test', roleKeys: ['venue_manager'], roles: ['Venue Manager'], twoFactor: { enabled: false, enabledAt: null, recoveryCodesRemaining: null, recoveryCodesTotal: null } });
const otherAdmin = user({ id: 'u3-00000-4000-8000-000000000003', firstName: 'Jordan', lastName: 'Lee', email: 'jordan@crewflow.test', isPlatformAdmin: true });
const me = user({ id: ME.id, firstName: 'Issac', lastName: 'Admin', email: 'issac@crewflow.test', isPlatformAdmin: true });

function routes(searchSpy?: jest.Mock) {
  routeGet(get, {
    '/admin/general': { version: 'v0.3.0', latestVersion: null, commit: null },
    '/admin/overview': { organisations: { total: 7, active: 6, suspended: 1 }, users: { total: 1284, signedInLast7Days: 412 }, sessions: { active: 538, platformAdminSessionsToday: 31 }, platformAdmins: { active: 2 }, workspaces: { ready: 11, creating: 1, failed: 1, other: 0 } },
    '/admin/migrations': { applied: 211, latest: 'AdminPanelReadFunctions1786720100000', pending: 0 },
    '/admin/platform-admins': [
      { userId: ME.id, firstName: 'Issac', lastName: 'Admin', email: 'issac@crewflow.test', organisationName: 'HQ', twoFactorEnabled: true, grantedAt: '2026-09-02T00:00:00Z', grantedBy: null, isYou: true },
      { userId: otherAdmin.id, firstName: 'Jordan', lastName: 'Lee', email: 'jordan@crewflow.test', organisationName: 'HQ', twoFactorEnabled: false, grantedAt: '2026-10-14T00:00:00Z', grantedBy: { userId: ME.id, name: 'Issac Admin' }, isYou: false },
    ],
    '/admin/users/search': (params?: Record<string, unknown>) => {
      searchSpy?.(params);
      return [enrolled, notEnrolled, otherAdmin, me];
    },
    [`/admin/users/${enrolled.id}/summary`]: { ...enrolled, sessions: { total: 3, managerWeb: 2, venueManagerApp: 1, staffApp: 0 }, lastSignInProvider: 'google', failedSignIns24h: 0 },
  });
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  routes();
});

it('stat cards show the server’s numbers; a missing commit is "Unknown", never invented', async () => {
  renderWithQuery(<GeneralTab meId={ME.id} />);
  await waitFor(() => expect(screen.getByText('1,284')).toBeTruthy());
  expect(screen.getByText('v0.3.0')).toBeTruthy();
  expect(screen.getByText(/Commit Unknown · 211 migrations applied/)).toBeTruthy();
  expect(screen.getByText('6 active · 1 suspended')).toBeTruthy();
  expect(screen.getByText('412 signed in this week')).toBeTruthy();
  expect(screen.getByText('31 platform-admin sessions today')).toBeTruthy();
});

it('User security table: On/Off badge, enabled date, "8 of 10" recovery codes, organisation + role columns, footer copy', async () => {
  renderWithQuery(<GeneralTab meId={ME.id} />);
  const table = await screen.findByRole('region', { name: 'User security' });
  await waitFor(() => expect(within(table).getByText('Alex Morgan')).toBeTruthy());
  const row = within(table).getByText('Alex Morgan').closest('tr')!;
  expect(within(row).getByText('On')).toBeTruthy();
  expect(within(row).getByText('8 of 10')).toBeTruthy();
  expect(within(row).getByText('Example Agency Ltd')).toBeTruthy();
  expect(within(row).getByText('CEO')).toBeTruthy();
  expect(within(table).getByText('A reset signs the user out on all devices.')).toBeTruthy();
  expect(screen.getByText(/Use a reset only when a user can’t access their authenticator or recovery codes./)).toBeTruthy();
  for (const copy of ['Available to every role', 'Verified on every platform', 'Secure account recovery']) expect(screen.getByText(copy)).toBeTruthy();
});

it('Reset 2FA is disabled with the right tooltip for no-2FA, yourself and another platform admin', async () => {
  renderWithQuery(<GeneralTab meId={ME.id} />);
  await screen.findByRole('button', { name: 'Reset 2FA for Alex Morgan' });
  expect((screen.getByRole('button', { name: 'Reset 2FA for Alex Morgan' }) as HTMLButtonElement).disabled).toBe(false);
  const sam = screen.getByRole('button', { name: 'Reset 2FA for Sam Patel' }) as HTMLButtonElement;
  expect(sam.disabled).toBe(true);
  expect(sam.title).toBe(RESET_TOOLTIP.off);
  const jordan = screen.getByRole('button', { name: 'Reset 2FA for Jordan Lee' }) as HTMLButtonElement;
  expect(jordan.disabled).toBe(true);
  expect(jordan.title).toBe(RESET_TOOLTIP.admin);
  const self = screen.getByRole('button', { name: 'Reset 2FA for Issac Admin' }) as HTMLButtonElement;
  expect(self.disabled).toBe(true);
  expect(self.title).toBe(RESET_TOOLTIP.self);
});

it('role filter (in place of the design’s tabs) re-queries the server with that role', async () => {
  const spy = jest.fn();
  routes(spy);
  renderWithQuery(<GeneralTab meId={ME.id} />);
  await screen.findByRole('button', { name: 'Reset 2FA for Alex Morgan' });
  fireEvent.change(screen.getByLabelText('Filter by role'), { target: { value: 'venue_manager' } });
  await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.objectContaining({ role: 'venue_manager', limit: 25 })));
});

it('reset completed: the success notice appears only after the 200, with the server’s real revokedSessions count', async () => {
  post.mockResolvedValueOnce({ data: { reset: true, revokedSessions: 3 } });
  renderWithQuery(<GeneralTab meId={ME.id} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Reset 2FA for Alex Morgan' }));
  expect(screen.queryByText(/sessions were ended/)).toBeNull();
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('Reset 2FA for Alex Morgan?')).toBeTruthy();
  fireEvent.change(within(dialog).getByLabelText('Reason for reset'), { target: { value: 'Lost phone, identity checked by call' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Reset two-factor authentication' }));
  await waitFor(() => expect(screen.getByText(/Two-factor authentication was reset for Alex Morgan. 3 sessions were ended./)).toBeTruthy());
  expect(post).toHaveBeenCalledWith(`/admin/users/${enrolled.id}/mfa/reset`, { reason: 'Lost phone, identity checked by call' });
});

it('searching shows the user card with server-backed sessions, last sign-in provider and failed sign-ins; Inspect stays off', async () => {
  routeGet(get, {
    '/admin/general': { version: 'v0.3.0', latestVersion: null, commit: 'efc4709' },
    '/admin/users/search': (params?: Record<string, unknown>) => (params?.q ? [enrolled] : []),
    [`/admin/users/${enrolled.id}/summary`]: { ...enrolled, sessions: { total: 3, managerWeb: 2, venueManagerApp: 1, staffApp: 0 }, lastSignInProvider: 'google', failedSignIns24h: 0 },
  });
  renderWithQuery(<GeneralTab meId={ME.id} />);
  fireEvent.change(screen.getByLabelText('Search'), { target: { value: enrolled.email } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  const card = await screen.findByLabelText('User Alex Morgan');
  await waitFor(() => expect(within(card).getByText(/2 web · 1 venue manager app · 3 sessions/)).toBeTruthy());
  expect(within(card).getByText(/Google/)).toBeTruthy();
  expect(within(card).getByText('0 in the last 24 h')).toBeTruthy();
  expect((within(card).getByRole('button', { name: 'Inspect (off)' }) as HTMLButtonElement).disabled).toBe(true);
});

it('platform admins: "(you)" without Remove; bootstrap shown when there is no granting admin', async () => {
  renderWithQuery(<GeneralTab meId={ME.id} />);
  const region = await screen.findByRole('region', { name: 'Platform admins' });
  await waitFor(() => expect(within(region).getByText('Issac Admin (you)')).toBeTruthy());
  expect(within(region).getByText('bootstrap-admin')).toBeTruthy();
  expect(within(region).getAllByRole('button', { name: 'Remove' })).toHaveLength(1);
});
