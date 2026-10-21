import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import MembersPage from './MembersPage';
import { describeRole, expiresIn, parseEmails } from './InviteMembersPanel';

jest.mock('../../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn(), patch: jest.fn() } }));
jest.mock('../../../shared/lib/toast', () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() } }));
import { toast } from '../../../shared/lib/toast';
const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const patch = api.patch as jest.Mock;

beforeEach(() => (Object.values(toast) as jest.Mock[]).forEach((fn) => fn.mockClear()));

const future = new Date(Date.now() + 23 * 3600_000).toISOString();
const SUPERVISOR = { id: 'role-1', name: 'Supervisor', permissionKeys: ['staff.view', 'venue.view', 'schedule.view'] };
const VIEWER = { id: 'role-2', name: 'Venue viewer', permissionKeys: ['venue.view'] };
const invitation = (over: Record<string, unknown> = {}) => ({
  id: 'inv-1', email: 'pending@example.test', role: { id: 'role-1', name: 'Supervisor' }, status: 'sent', sendCount: 1, maxSends: 3,
  expiresAt: future, lastSentAt: future, createdAt: future, invitedByName: 'Jordan Hale', ...over,
});

const CEO_CAPABILITIES = { leadership: { canCreateOrganisation: false, initialManagerScope: "own" } };
// Organisation isolation (2026-10-15): a platform admin's Initial Manager scope is their OWN organisation; there is no 'select'.
const PLATFORM_CAPABILITIES = { leadership: { canCreateOrganisation: true, initialManagerScope: "own" } };

interface MountOptions { capabilities?: unknown; failCapabilities?: boolean; roles?: string[]; isPlatformAdmin?: boolean; tab?: string; assignable?: unknown[]; invitations?: unknown[]; failInvitations?: boolean; failMembers?: boolean; members?: unknown[]; membersTotal?: number }

function mount(opts: MountOptions = {}) {
  const roles = opts.roles ?? ['manager'];
  get.mockImplementation((url: string) => {
    if (url === '/leadership/capabilities') return opts.failCapabilities ? Promise.reject(new Error('offline')) : Promise.resolve({ data: opts.capabilities ?? {} });
    if (url === '/admin/organisations/org-1') return Promise.resolve({ data: { initialManager: null } });
    if (url === '/auth/me') return Promise.resolve({ data: { id: 'viewer', roles, isPlatformAdmin: !!opts.isPlatformAdmin } });
    if (url.startsWith('/manager-workspaces/me')) return Promise.resolve({ data: { id: 'workspace', name: 'Northwind Staffing' } });
    if (url === '/member-invitations/assignable-roles') return Promise.resolve({ data: opts.assignable ?? [SUPERVISOR, VIEWER] });
    if (url.startsWith('/member-invitations')) {
      if (opts.failInvitations) return Promise.reject(new Error('down'));
      const rows = opts.invitations ?? [];
      return Promise.resolve({ data: { data: rows, total: rows.length, page: 1, limit: 10 } });
    }
    if (url.startsWith('/members')) {
      if (opts.failMembers) return Promise.reject(new Error('down'));
      const rows = opts.members ?? [];
      return Promise.resolve({ data: { data: rows, total: opts.membersTotal ?? rows.length } });
    }
    if (url === '/admin/organisations') return Promise.resolve({ data: [{ id: 'org-1', name: 'Acme', slug: 'acme', suspended: false, createdAt: future, ceo: null }] });
    if (url === '/roles') return Promise.resolve({ data: [] });
    return Promise.resolve({ data: { data: [], total: 0 } });
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/settings/workspace/members?tab=${opts.tab ?? 'invite'}`]}><MembersPage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => { get.mockReset(); post.mockReset(); patch.mockReset(); });

/** The invite form's submit button, separate from the Invite navigation tab. */
const submitInvite = () => screen.getByLabelText('Email address').closest('form')!.querySelector('button.invite-submit') as HTMLButtonElement;

it('the Invite form is email-first and offers exactly the server’s custom workspace roles — no names, no Staff or Venue Manager', async () => {
  mount();
  const select = await screen.findByLabelText('Workspace role');
  expect(screen.queryByLabelText(/first name/i)).toBeNull();
  expect(screen.queryByLabelText(/last name/i)).toBeNull();
  await waitFor(() => expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Supervisor', 'Venue viewer']));
  expect(screen.getByText(/Supervisor members can view your staff, venues and shifts/)).toBeInTheDocument();
  // Reference layout: visible labels, compact email/role row, Send invitation action.
  expect(screen.getByRole('heading', { name: 'Invite your team' })).toBeInTheDocument();
  expect(screen.getByText(/Send an invitation to join/)).toBeInTheDocument();
  expect(submitInvite()).toHaveTextContent('Send invitation');
});

it('sends several comma-separated addresses with the chosen role id in one request', async () => {
  post.mockResolvedValue({ data: { results: [{ email: 'a@example.test', outcome: 'invited' }, { email: 'b@example.test', outcome: 'invited' }] } });
  mount();
  await screen.findByLabelText('Workspace role');
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'A@Example.test, b@example.test,a@example.test' } });
  fireEvent.change(screen.getByLabelText('Workspace role'), { target: { value: 'role-2' } });
  expect(screen.getByText(/Venue viewer members can view your venues/)).toBeInTheDocument();
  fireEvent.click(submitInvite());
  await waitFor(() => expect(post).toHaveBeenCalledWith('/member-invitations', { emails: ['a@example.test', 'b@example.test'], roleId: 'role-2' }));
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith('2 invitations queued for delivery.'));
});

it('with no custom role yet, Invite explains why and links to Roles instead of offering a role', async () => {
  mount({ assignable: [] });
  expect(await screen.findByText(/Create a workspace role first/)).toBeInTheDocument();
  expect(screen.queryByLabelText('Workspace role')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Create a role' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Roles' })).toHaveAttribute('aria-current', 'page'));
});

it('shows real per-recipient outcomes when only some invitations succeed', async () => {
  post.mockResolvedValue({ data: { results: [{ email: 'new@example.test', outcome: 'invited' }, { email: 'old@example.test', outcome: 'already_member' }] } });
  mount();
  await screen.findByLabelText('Workspace role');
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'new@example.test, old@example.test' } });
  fireEvent.click(submitInvite());
  const results = await screen.findByRole('list', { name: 'Invitation results' });
  expect(within(results).getByText('old@example.test').parentElement).toHaveTextContent('Already has an account in this organisation');
  expect(toast.warning).toHaveBeenCalledWith('1 invitation queued for delivery. 1 could not be sent — see below.');
  expect(screen.getByLabelText('Email address')).toHaveValue('old@example.test');
});

it('a server error is shown as an error and never as a success or an empty state', async () => {
  post.mockRejectedValue({ response: { status: 429, data: { message: 'Too many invitations have been sent recently. Please try again later.' } } });
  mount();
  await screen.findByLabelText('Workspace role');
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'x@example.test' } });
  fireEvent.click(submitInvite());
  expect(await screen.findByRole('alert')).toHaveTextContent('Too many invitations');
  expect(screen.queryByText(/queued for delivery/)).toBeNull();
  expect(toast.success).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Email address')).toHaveValue('x@example.test');
});

it('an invitations load failure is reported instead of claiming there are none', async () => {
  mount({ failInvitations: true });
  expect(await screen.findByText(/Invitations could not be loaded/)).toBeInTheDocument();
  expect(screen.queryByText(/No invitations pending/)).toBeNull();
});

it('lists pending invitations with role and expiry; delivery failures in red; revoke needs confirmation', async () => {
  post.mockResolvedValue({ data: invitation({ status: 'revoked' }) });
  mount({ invitations: [invitation(), invitation({ id: 'inv-f', email: 'bounced@example.test', status: 'delivery_failed' })] });
  const row = (await screen.findByText('pending@example.test')).closest('tr')!;
  expect(row).toHaveTextContent('Supervisor');
  expect(row).toHaveTextContent(/in 2[23] hours/);
  const failed = screen.getByText('bounced@example.test').closest('tr')!;
  const failedCell = within(failed).getByText('Delivery failed');
  expect(failedCell).toHaveClass('feedback-error');
  fireEvent.click(within(row).getByRole('button', { name: /Revoke/ }));
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Revoke invitation' }));
  await waitFor(() => expect(post).toHaveBeenCalledWith('/member-invitations/inv-1/revoke', {}));
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Invitation revoked. The link no longer works.'));
});

it('regression: returning to Invite after choosing Add (leadership) shows the member invitation form again', async () => {
  mount({ roles: ['ceo'], capabilities: CEO_CAPABILITIES });
  fireEvent.change(await screen.findByRole('combobox', { name: 'Invite or add' }), { target: { value: 'add' } });
  expect(screen.queryByLabelText('Workspace role')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Team' }));
  fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
  expect(await screen.findByLabelText('Workspace role')).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Invite or add' })).toHaveValue('invite');
});

it('resend calls the API and is disabled once all three sends are used', async () => {
  post.mockResolvedValue({ data: invitation({ sendCount: 2 }) });
  mount({ invitations: [invitation(), invitation({ id: 'inv-2', email: 'maxed@example.test', sendCount: 3 })] });
  const row = (await screen.findByText('pending@example.test')).closest('tr')!;
  fireEvent.click(within(row).getByRole('button', { name: /Resend/ }));
  await waitFor(() => expect(post).toHaveBeenCalledWith('/member-invitations/inv-1/resend', {}));
  const maxed = screen.getByText('maxed@example.test').closest('tr')!;
  expect(within(maxed).getByRole('button', { name: /Resend/ })).toBeDisabled();
});

it('an Initial Manager (manager role) has Invite but no Add selector', async () => {
  mount();
  await screen.findByLabelText('Workspace role');
  expect(screen.queryByRole('combobox', { name: 'Invite or add' })).toBeNull();
});

it.each([
  undefined, {}, { leadership: {} },
  { leadership: { canCreateOrganisation: 'true', initialManagerScope: 'select' } },
  { leadership: { canCreateOrganisation: true, initialManagerScope: 'anything' } },
  // The retired cross-organisation scope fails closed even when well-typed: the client never offers an organisation picker.
  { leadership: { canCreateOrganisation: false, initialManagerScope: 'select' } },
])(
  'fails closed for missing/malformed Add capabilities, even for a platform CEO: %j', async (capabilities) => {
    mount({ roles: ['ceo'], isPlatformAdmin: true, capabilities, tab: 'invite&mode=add' });
    expect(await screen.findByLabelText('Workspace role')).toBeVisible();
    await waitFor(() => expect(get).toHaveBeenCalledWith('/leadership/capabilities'));
    expect(screen.queryByLabelText('Invite or add')).toBeNull();
    expect(screen.queryByLabelText('Leadership role')).toBeNull();
    expect(get.mock.calls.some(([url]) => String(url).startsWith('/admin/organisations'))).toBe(false);
  },
);

it('a failed capability request cannot expose Add', async () => {
  mount({ roles: ['ceo'], isPlatformAdmin: true, failCapabilities: true });
  await screen.findByLabelText('Workspace role');
  expect(screen.queryByLabelText('Invite or add')).toBeNull();
});

it('the CEO Initial Manager form submits the existing own-organisation endpoint without an organisation ID', async () => {
  post.mockResolvedValue({ data: {} });
  mount({ roles: ['ceo'], capabilities: CEO_CAPABILITIES, tab: 'invite&mode=add' });
  fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'lead@example.test' } });
  fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Alex' } });
  fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Sample' } });
  fireEvent.submit(screen.getByLabelText('Email').closest('form')!);
  await waitFor(() => expect(post).toHaveBeenCalledWith('/managers/initial-manager-invite', { email: 'lead@example.test', firstName: 'Alex', lastName: 'Sample' }));
});

it("a platform admin's Initial Manager Add is their own organisation: no organisation picker, own endpoint, never an organisation id", async () => {
  post.mockResolvedValue({ data: {} });
  mount({ roles: [], isPlatformAdmin: true, capabilities: PLATFORM_CAPABILITIES, tab: 'invite&mode=add' });
  fireEvent.change(await screen.findByLabelText('Leadership role'), { target: { value: 'initial-manager' } });
  fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'lead@example.test' } });
  expect(screen.queryByLabelText('Organisation')).toBeNull();
  fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Alex' } });
  fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Sample' } });
  fireEvent.submit(screen.getByLabelText('Email').closest('form')!);
  await waitFor(() => expect(post).toHaveBeenCalledWith('/managers/initial-manager-invite', { email: 'lead@example.test', firstName: 'Alex', lastName: 'Sample' }));
  expect(post.mock.calls.some(([url]) => String(url).startsWith('/admin/organisations'))).toBe(false);
  expect(get.mock.calls.some(([url]) => String(url) === '/admin/organisations')).toBe(false);
});

it('Add for a CEO offers only the Initial Manager invitation — never Staff or Venue Manager', async () => {
  mount({ roles: ['ceo'], capabilities: CEO_CAPABILITIES });
  fireEvent.change(await screen.findByRole('combobox', { name: 'Invite or add' }), { target: { value: 'add' } });
  expect(screen.getByRole('heading', { name: 'Add organisation leadership' })).toBeInTheDocument();
  expect(within(screen.getByLabelText('Leadership role')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Initial Manager']);
  expect(await screen.findByLabelText('Email')).toBeVisible();
  expect(screen.queryByLabelText('Organisation')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Create organisation' })).toBeNull();
  expect(screen.queryByLabelText('Workspace role')).toBeNull();
});

it('Add for a Platform Super Admin offers organisation creation and their own Initial Manager — never another organisation', async () => {
  mount({ roles: ['ceo'], isPlatformAdmin: true, capabilities: PLATFORM_CAPABILITIES });
  fireEvent.change(await screen.findByRole('combobox', { name: 'Invite or add' }), { target: { value: 'add' } });
  expect(screen.getByRole('button', { name: 'Create Organisation & Invite CEO' })).toBeInTheDocument();
  expect(within(screen.getByLabelText('Leadership role')).getAllByRole('option').map((o) => o.textContent)).toEqual(['CEO (Organisation)', 'Initial Manager']);
  fireEvent.change(screen.getByLabelText('Leadership role'), { target: { value: 'initial-manager' } });
  expect(await screen.findByLabelText('Email')).toBeVisible();
  expect(screen.queryByLabelText('Organisation')).toBeNull();
  expect(screen.queryByRole('option', { name: 'Acme' })).toBeNull();
  expect(get.mock.calls.some(([url]) => String(url) === '/admin/organisations')).toBe(false);
});

it.each([[['staff']], [['venue_manager']], [['custom_supervisor']]])('%j sees no Members administration and never calls the invitation API', async (roles) => {
  mount({ roles });
  expect(await screen.findByText('Members are managed by your workspace administrator')).toBeInTheDocument();
  expect(get.mock.calls.some(([url]) => String(url).startsWith('/member-invitations'))).toBe(false);
});

it('Team lists real workspace members from the paginated endpoint, showing the email until a name is set', async () => {
  mount({
    tab: 'team',
    members: [
      { userId: 'u1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test', roles: [{ id: 'role-1', name: 'Supervisor', isMemberRole: true }], status: 'active', isOwner: false, isSelf: false },
      { userId: 'u2', firstName: '', lastName: '', email: 'new@example.test', roles: [{ id: 'role-1', name: 'Supervisor', isMemberRole: true }], status: 'pending_setup', isOwner: false, isSelf: false },
    ],
    membersTotal: 60,
  });
  const ada = (await screen.findByText('Ada Lovelace')).closest('tr')!;
  expect(ada).toHaveTextContent('Supervisor');
  expect(ada).toHaveTextContent('Active');
  expect(screen.getAllByText('new@example.test')).toHaveLength(2);
  expect(screen.getByText('Not signed in yet')).toBeInTheDocument();
  expect(get).toHaveBeenCalledWith('/members?page=1&limit=25');
  expect(screen.getByText(/Page 1 of 3/)).toBeInTheDocument();
});

it('Team: the owner can change a member’s role and suspend them; results are green, failures red; owner and self rows have no actions', async () => {
  const member = { userId: 'u1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test', roles: [{ id: 'role-1', name: 'Supervisor', isMemberRole: true }], status: 'active', isOwner: false, isSelf: false };
  const ownerRow = { userId: 'me', firstName: 'Jo', lastName: 'Owner', email: 'jo@example.test', roles: [{ id: 'sys', name: 'Manager', isMemberRole: false }], status: 'active', isOwner: true, isSelf: true };
  patch.mockResolvedValueOnce({ data: undefined });
  post.mockRejectedValueOnce({ response: { data: { message: 'Member not found.' } } });
  const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
  mount({ tab: 'team', members: [ownerRow, member] });
  const ada = (await screen.findByText('Ada Lovelace')).closest('tr')!;
  const jo = screen.getByText('Jo Owner').closest('tr')!;
  expect(within(jo).queryByRole('button')).toBeNull();
  expect(within(jo).queryByRole('combobox')).toBeNull();

  fireEvent.change(await within(ada).findByRole('combobox', { name: 'Role for Ada Lovelace' }), { target: { value: 'role-2' } });
  await waitFor(() => expect(patch).toHaveBeenCalledWith('/members/u1/role', { roleId: 'role-2' }));
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Role updated. It applies on their next action.'));

  fireEvent.click(within(ada).getByRole('button', { name: 'Suspend' }));
  await waitFor(() => expect(post).toHaveBeenCalledWith('/members/u1/suspend', {}));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Member not found.'));
  confirm.mockRestore();
});

it('Team load failure is an error, not an empty team', async () => {
  mount({ tab: 'team', failMembers: true });
  expect(await screen.findByRole('alert')).toHaveTextContent('Members could not be loaded');
  expect(screen.queryByText('Your team starts here')).toBeNull();
});

it('parses, de-duplicates and validates addresses; formats expiry; describes roles from their permissions', () => {
  expect(parseEmails(' A@x.test;b@x.test\nA@x.test, nope ')).toEqual({ emails: ['a@x.test', 'b@x.test'], invalid: ['nope'] });
  expect(expiresIn(new Date(Date.now() - 1000).toISOString())).toBe('Expired');
  expect(expiresIn(new Date(Date.now() + 30 * 60_000).toISOString())).toBe('in 30 minutes');
  expect(describeRole({ id: 'r', name: 'Empty', permissionKeys: [] })).toBe('Empty has no permissions yet.');
  expect(describeRole({ id: 'r', name: 'Two', permissionKeys: ['staff.view', 'schedule.view'] })).toBe('Two members can view your staff and shifts.');
});
