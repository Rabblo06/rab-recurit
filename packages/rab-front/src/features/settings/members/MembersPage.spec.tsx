import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import MembersPage from './MembersPage';
import { describeRole, expiresIn, parseEmails } from './InviteMembersPanel';

jest.mock('../../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn() } }));
const get = api.get as jest.Mock;
const post = api.post as jest.Mock;

const future = new Date(Date.now() + 23 * 3600_000).toISOString();
const SUPERVISOR = { id: 'role-1', name: 'Supervisor', permissionKeys: ['staff.view', 'venue.view', 'schedule.view'] };
const VIEWER = { id: 'role-2', name: 'Venue viewer', permissionKeys: ['venue.view'] };
const invitation = (over: Record<string, unknown> = {}) => ({
  id: 'inv-1', email: 'pending@example.test', role: { id: 'role-1', name: 'Supervisor' }, status: 'sent', sendCount: 1, maxSends: 3,
  expiresAt: future, lastSentAt: future, createdAt: future, invitedByName: 'Jordan Hale', ...over,
});

interface MountOptions { roles?: string[]; isPlatformAdmin?: boolean; tab?: string; assignable?: unknown[]; invitations?: unknown[]; failInvitations?: boolean; failMembers?: boolean; members?: unknown[]; membersTotal?: number }

function mount(opts: MountOptions = {}) {
  const roles = opts.roles ?? ['manager'];
  get.mockImplementation((url: string) => {
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

beforeEach(() => { get.mockReset(); post.mockReset(); });

it('the Invite form is email-first and offers exactly the server’s custom workspace roles — no names, no Staff or Venue Manager', async () => {
  mount();
  const select = await screen.findByLabelText('Workspace role');
  expect(screen.queryByLabelText(/first name/i)).toBeNull();
  expect(screen.queryByLabelText(/last name/i)).toBeNull();
  await waitFor(() => expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Supervisor', 'Venue viewer']));
  expect(screen.getByText(/Supervisor members can view your staff, venues and shifts/)).toBeInTheDocument();
  expect(screen.getByText(/Invitees set up their own profile after accepting/)).toBeInTheDocument();
});

it('sends several comma-separated addresses with the chosen role id in one request', async () => {
  post.mockResolvedValue({ data: { results: [{ email: 'a@example.test', outcome: 'invited' }, { email: 'b@example.test', outcome: 'invited' }] } });
  mount();
  await screen.findByLabelText('Workspace role');
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'A@Example.test, b@example.test,a@example.test' } });
  fireEvent.change(screen.getByLabelText('Workspace role'), { target: { value: 'role-2' } });
  expect(screen.getByText(/Venue viewer members can view your venues/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
  await waitFor(() => expect(post).toHaveBeenCalledWith('/member-invitations', { emails: ['a@example.test', 'b@example.test'], roleId: 'role-2' }));
  expect(await screen.findByRole('status')).toHaveTextContent('2 invitations queued for delivery.');
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
  fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
  const results = await screen.findByRole('list', { name: 'Invitation results' });
  expect(within(results).getByText('old@example.test').parentElement).toHaveTextContent('Already has an account in this organisation');
  expect(screen.getByRole('status')).toHaveTextContent('1 invitation queued for delivery. 1 could not be sent');
  expect(screen.getByLabelText('Email address')).toHaveValue('old@example.test');
});

it('a server error is shown as an error and never as a success or an empty state', async () => {
  post.mockRejectedValue({ response: { status: 429, data: { message: 'Too many invitations have been sent recently. Please try again later.' } } });
  mount();
  await screen.findByLabelText('Workspace role');
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'x@example.test' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Too many invitations');
  expect(screen.queryByText(/queued for delivery/)).toBeNull();
  expect(screen.getByLabelText('Email address')).toHaveValue('x@example.test');
});

it('an invitations load failure is reported instead of claiming there are none', async () => {
  mount({ failInvitations: true });
  expect(await screen.findByText(/Invitations could not be loaded/)).toBeInTheDocument();
  expect(screen.queryByText(/No invitations pending/)).toBeNull();
});

it('lists pending invitations with role, status and expiry; filters by status; revoke needs confirmation', async () => {
  post.mockResolvedValue({ data: invitation({ status: 'revoked' }) });
  mount({ invitations: [invitation()] });
  const row = (await screen.findByText('pending@example.test')).closest('tr')!;
  expect(row).toHaveTextContent('Supervisor');
  expect(row).toHaveTextContent('Sent');
  expect(row).toHaveTextContent(/in 2[23] hours/);
  fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'expired' } });
  await waitFor(() => expect(get).toHaveBeenCalledWith('/member-invitations?page=1&limit=10&status=expired'));
  fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: '' } });
  const again = (await screen.findByText('pending@example.test')).closest('tr')!;
  fireEvent.click(within(again).getByRole('button', { name: /Revoke/ }));
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Revoke invitation' }));
  await waitFor(() => expect(post).toHaveBeenCalledWith('/member-invitations/inv-1/revoke', {}));
  expect(await screen.findByRole('status')).toHaveTextContent('Invitation revoked');
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

it('Add for a CEO offers only the Initial Manager invitation — never Staff or Venue Manager', async () => {
  mount({ roles: ['ceo'] });
  fireEvent.change(await screen.findByRole('combobox', { name: 'Invite or add' }), { target: { value: 'add' } });
  expect(screen.getByRole('heading', { name: 'Add organisation leadership' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Invite Initial Manager' })).toHaveAttribute('href', '/settings/workspace/team');
  expect(screen.queryByRole('button', { name: 'Create organisation' })).toBeNull();
  expect(screen.queryByLabelText('Workspace role')).toBeNull();
});

it('Add for a Platform Super Admin offers organisation creation and an organisation picker from the server', async () => {
  mount({ roles: ['ceo'], isPlatformAdmin: true });
  fireEvent.change(await screen.findByRole('combobox', { name: 'Invite or add' }), { target: { value: 'add' } });
  expect(screen.getByRole('button', { name: 'Create organisation' })).toBeInTheDocument();
  expect(await screen.findByRole('option', { name: 'Acme' })).toBeInTheDocument();
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
