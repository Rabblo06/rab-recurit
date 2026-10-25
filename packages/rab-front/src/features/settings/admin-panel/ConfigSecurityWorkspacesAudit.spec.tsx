import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { api } from '../../../shared/api';
import AuditTab from './AuditTab';
import { renderWithQuery, routeGet } from './adminPanelTestKit';
import ConfigTab from './ConfigTab';
import SecurityTab from './SecurityTab';
import WorkspacesTab from './WorkspacesTab';

jest.mock('../../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn(), patch: jest.fn() } }));
const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const patch = api.patch as jest.Mock;

const security = {
  switches: [
    { label: 'Accept tokens signed with legacy APP_SECRET', variable: 'APP_JWT_LEGACY_VERIFY_ENABLED', state: 'On', recommended: 'Off', tone: 'bad' },
    { label: 'Workspace schemas hold business data', variable: 'HWS_RUNTIME_ENABLED', state: 'Off', recommended: 'After the production rehearsal', tone: 'neutral' },
  ],
  signingKeys: [{ kid: 'derived-v1', use: 'signs_and_verifies', derivedFrom: 'HKDF purpose key from APP_SECRET', status: 'active', verified24h: null }],
  encryptionKeys: { activeKid: 'k1', kids: ['k1'] },
};

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  patch.mockReset();
  routeGet(get, {
    '/admin/config': { maintenanceMode: { enabled: false, message: null } },
    '/admin/config/email': { driver: 'RESEND', fromAddress: 'no-reply@example-crewflow.test', replyToSet: false, deliveryEnabled: true, credential: 'set' },
    '/admin/config/environment': [
      { group: 'Secrets', key: 'APP_SECRET', state: 'set', value: null, source: 'env (secret)' },
      { group: 'App', key: 'NODE_ENV', state: 'value', value: 'production', source: 'env' },
      { group: 'Email', key: 'RESEND_API_KEY', state: 'not_set', value: null, source: 'env (secret)' },
    ],
    '/admin/security': security,
    '/admin/overview': { organisations: { total: 2, active: 2, suspended: 0 }, users: { total: 3, signedInLast7Days: 1 }, sessions: { active: 1, platformAdminSessionsToday: 1 }, platformAdmins: { active: 1 }, workspaces: { ready: 11, creating: 1, failed: 1, other: 0 } },
    '/admin/migrations': { applied: 211, latest: 'AuditLogOrganisationActionIndex1786720110000', pending: 0 },
    '/admin/workspaces': { nextCursor: null, items: [{ workspaceId: 'w1', organisationId: 'o1', organisationName: 'Demo Hospitality', workspaceName: 'North', schemaName: 'workspace_77b20000000000000000000000000e0e', schemaStatus: 'FAILED', schemaVersion: null, moduleVersion: null, registryStatus: 'FAILED', driftStatus: null, error: 'module v1.001-template refused (BASELINE_MISMATCH)', updatedAt: '2026-10-23T09:00:00Z' }] },
    '/admin/audit': (params?: Record<string, unknown>) => ({
      nextCursor: null,
      items: params?.user
        ? []
        : [{ id: 'a1', action: 'user.mfa_reset_by_admin', organisationId: 'o1', organisationName: 'Example Agency Ltd', createdAt: '2026-10-22T11:45:00Z', actor: { userId: 'me', name: 'Issac' }, target: { userId: 't', name: 'Alex Morgan' }, entity: null, reason: 'Lost phone, identity checked by call', detail: {} }],
    }),
    '/admin/users/search': [{ id: 'u-target', firstName: 'Alex', lastName: 'Morgan', email: 'alex@example.test' }],
  });
});

describe('Config tab', () => {
  it('maintenance copy is honest (this organisation only, sign-in still works) and turning it on needs a reason + step-up', async () => {
    patch.mockResolvedValue({ data: { maintenanceMode: { enabled: true, message: null } } });
    renderWithQuery(<ConfigTab organisationName="Crewflow HQ" />);
    expect(screen.getByText(/People in Crewflow HQ \(except platform admins\) see a maintenance message instead of their data. Sign-in still works, and other organisations are not affected./)).toBeTruthy();
    const toggle = (await screen.findByRole('checkbox', { name: 'Maintenance mode' })) as HTMLInputElement;
    await waitFor(() => expect(toggle.disabled).toBe(false));
    fireEvent.click(toggle);
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Reason (saved to the audit log)'), { target: { value: 'Planned upgrade' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/admin/config/maintenance-mode', { enabled: true, reason: 'Planned upgrade' }));
  });

  it('email delivery is read-only from the environment; no editable SMTP form; test email goes to me only', async () => {
    post.mockResolvedValue({ data: { sent: true, to: 'is…@crewflow.test', driver: 'RESEND' } });
    renderWithQuery(<ConfigTab />);
    expect(await screen.findByText('no-reply@example-crewflow.test')).toBeTruthy();
    expect(screen.getByText('Configured')).toBeTruthy();
    expect(screen.queryByLabelText(/SMTP host/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send test email to me' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/config/email/test', {}));
  });

  it('environment: secrets show Set / Not set only; plain values in mono; filter narrows rows', async () => {
    renderWithQuery(<ConfigTab />);
    const secret = (await screen.findByText('APP_SECRET')).closest('tr')!;
    expect(within(secret).getByText('Set')).toBeTruthy();
    expect(within(screen.getByText('RESEND_API_KEY').closest('tr')!).getByText('Not set')).toBeTruthy();
    expect(screen.getByText('production')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Filter variables'), { target: { value: 'node' } });
    expect(screen.queryByText('APP_SECRET')).toBeNull();
  });
});

describe('Security tab', () => {
  it('switch states from the server; token counters say "Not measured" (never a number) and no retirement advice', async () => {
    renderWithQuery(<SecurityTab />);
    expect(await screen.findByText('APP_JWT_LEGACY_VERIFY_ENABLED')).toBeTruthy();
    expect(screen.getByText('derived-v1')).toBeTruthy();
    expect(screen.getByText('Not measured')).toBeTruthy();
    expect(screen.queryByText(/safe to set APP_JWT_LEGACY_VERIFY_ENABLED=false/)).toBeNull();
  });
});

describe('Workspaces tab', () => {
  it('counts + rows from the server; FAILED says "Retries automatically" (no Retry button, D6); data-placement copy follows HWS', async () => {
    renderWithQuery(<WorkspacesTab />);
    expect(await screen.findByText('North')).toBeTruthy();
    expect(screen.getByText('Retries automatically')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    expect(screen.getByText('module v1.001-template refused (BASELINE_MISMATCH)')).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/HWS_RUNTIME_ENABLED is off, so business data still lives in the core schema./)).toBeTruthy());
    expect(screen.getByText('211')).toBeTruthy();
  });
});

describe('Audit tab', () => {
  it('labels admin actions ("2FA reset"), shows the reason, and "filter by admin or target" resolves a user id first', async () => {
    renderWithQuery(<AuditTab />);
    expect(await screen.findByText('Lost phone, identity checked by call')).toBeTruthy();
    expect(within(screen.getByRole('table')).getByText('2FA reset')).toBeTruthy();
    const options = Array.from((screen.getByLabelText('Filter by action') as HTMLSelectElement).options).map((o) => o.textContent);
    expect(options).toEqual(expect.arrayContaining(['2FA reset', '2FA reset refused', 'User searched', 'Job retried', 'Email replayed', 'Platform admin added', 'Organisation suspended']));
    fireEvent.change(screen.getByLabelText('Filter audit log'), { target: { value: 'alex@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/admin/audit', { params: { user: 'u-target' } }));
  });
});
