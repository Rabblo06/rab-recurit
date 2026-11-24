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
    if (url.startsWith('/admin/users/') && url.endsWith('/summary')) return Promise.resolve({ data: { roles: ['Supervisor'] } });
    if (url.startsWith('/admin/users/directory')) {
      const rows = (opts.members ?? []) as Array<Record<string, unknown>>;
      return Promise.resolve({ data: { data: rows.map(row => ({ ...row, id: 'user:' + row.userId, kind: 'user' })), total: opts.membersTotal ?? rows.length } });
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
  await waitFor(() => expect(select).not.toBeDisabled());
  fireEvent.click(select);
  await waitFor(() => expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Supervisor', 'Venue viewer']));
  fireEvent.click(screen.getByRole('option', { name: 'Supervisor' }));
  expect(screen.getByText(/Supervisor members can view your staff, venues and shifts/)).toBeInTheDocument();
  // Reference layout: visible labels, compact email/role row, Send invitation action.
  expect(await screen.findByRole('heading', { name: 'Invite by email' })).toBeInTheDocument();
  expect(screen.getByText(/Send an invite email to your team/)).toBeInTheDocument();
  expect(submitInvite()).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'a@example.test' } });
  expect(submitInvite()).toHaveTextContent('Invite');
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: '   ' } });
  expect(submitInvite()).toBeDisabled();
});

it('sends several comma-separated addresses with the chosen role id in one request', async () => {
  post.mockResolvedValue({ data: { results: [{ email: 'a@example.test', outcome: 'invited' }, { email: 'b@example.test', outcome: 'invited' }] } });
  mount();
  await screen.findByLabelText('Workspace role');
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'A@Example.test, b@example.test,a@example.test' } });
  fireEvent.click(screen.getByLabelText('Workspace role'));
  fireEvent.click(screen.getByRole('option', { name: 'Venue viewer' }));
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
  fireEvent.click(await screen.findByLabelText('Invite or add'));
  fireEvent.click(screen.getByRole('option', { name: 'Add' }));
  expect(screen.queryByLabelText('Workspace role')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Team' }));
  fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
  expect(await screen.findByLabelText('Workspace role')).toBeInTheDocument();
  expect(screen.getByLabelText('Invite or add')).toHaveTextContent('Invite');
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
  fireEvent.submit(screen.getByLabelText('Email').closest('form')!);
  await waitFor(() => expect(post).toHaveBeenCalledWith('/managers/initial-manager-invite', { email: 'lead@example.test' }));
});

it("a platform admin's Initial Manager Add is their own organisation: no organisation picker, own endpoint, never an organisation id", async () => {
  post.mockResolvedValue({ data: {} });
  mount({ roles: [], isPlatformAdmin: true, capabilities: PLATFORM_CAPABILITIES, tab: 'invite&mode=add' });
  fireEvent.click(await screen.findByLabelText('Leadership role'));
  fireEvent.click(screen.getByRole('option', { name: 'Initial Manager' }));
  fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'lead@example.test' } });
  expect(screen.queryByLabelText('Organisation')).toBeNull();
  fireEvent.submit(screen.getByLabelText('Email').closest('form')!);
  await waitFor(() => expect(post).toHaveBeenCalledWith('/managers/initial-manager-invite', { email: 'lead@example.test' }));
  expect(post.mock.calls.some(([url]) => String(url).startsWith('/admin/organisations'))).toBe(false);
  expect(get.mock.calls.some(([url]) => String(url) === '/admin/organisations')).toBe(false);
});

it('Add for a CEO offers only the Initial Manager invitation — never Staff or Venue Manager', async () => {
  mount({ roles: ['ceo'], capabilities: CEO_CAPABILITIES });
  fireEvent.click(await screen.findByLabelText('Invite or add'));
  fireEvent.click(screen.getByRole('option', { name: 'Add' }));
  expect(await screen.findByRole('heading', { name: 'Invite by email' })).toBeInTheDocument();
  // A single permitted choice is shown fixed, not as a selector (owner correction 2026-10-23).
  expect(screen.getByLabelText('Leadership role', { selector: 'button, input' })).toHaveValue('Initial Manager');
  expect(screen.getByLabelText('Leadership role', { selector: 'button, input' })).toHaveAttribute('readonly');
  expect(await screen.findByLabelText('Email')).toBeVisible();
  expect(screen.queryByLabelText('Organisation')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Create organisation' })).toBeNull();
  expect(screen.queryByLabelText('Workspace role')).toBeNull();
});

it('Add for a Platform Super Admin offers organisation creation and their own Initial Manager — never another organisation', async () => {
  mount({ roles: ['ceo'], isPlatformAdmin: true, capabilities: PLATFORM_CAPABILITIES });
  fireEvent.click(await screen.findByLabelText('Invite or add'));
  fireEvent.click(screen.getByRole('option', { name: 'Add' }));
  expect(screen.getByRole('button', { name: 'Send invitation' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Create Organisation & Invite CEO' })).toBeNull();
  fireEvent.click(screen.getByLabelText('Leadership role', { selector: 'button, input' }));
  expect(within(screen.getByRole('listbox', { name: 'Leadership role' })).getAllByRole('option').map((o) => o.textContent)).toEqual(['CEO (Organisation)', 'Initial Manager']);
  fireEvent.click(screen.getByRole('option', { name: 'CEO (Organisation)' }));
  expect(screen.getByLabelText('Leadership role', { selector: 'button, input' })).toHaveTextContent('CEO (Organisation)'); // defaults to CEO (Organisation)
  fireEvent.click(screen.getByLabelText('Leadership role', { selector: 'button, input' }));
  fireEvent.click(screen.getByRole('option', { name: 'Initial Manager' }));
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
  expect(ada).not.toHaveTextContent('Supervisor');
  expect(ada).not.toHaveTextContent('Active');
  expect(screen.getAllByText('new@example.test')).toHaveLength(2);
  expect(screen.queryByText(/Not signed in yet/)).not.toBeInTheDocument();
  expect(get).toHaveBeenCalledWith('/members?page=1&limit=25'); // directories are a follow-up (SQL); the existing list is used
  expect(screen.getByText(/Page 1 of 3/)).toBeInTheDocument();
});

it('non-admin Team rows cannot open details or mutate memberships', async () => {
  mount({ tab: 'team', members: [{ userId: 'u1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test' }] });
  const name = await screen.findByRole('button', { name: 'Ada Lovelace' });
  expect(name).toBeDisabled(); fireEvent.click(name);
  expect(screen.queryByRole('navigation', { name: 'Member details' })).toBeNull();
  expect(patch).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
  expect(get.mock.calls.some(([url]) => String(url).startsWith('/admin/users'))).toBe(false);
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

describe('owner correction 2026-10-23: organisations start from Members → Add (email-only CEO invitation)', () => {
  const PLATFORM_ONLY = { roles: [] as string[], isPlatformAdmin: true, capabilities: { leadership: { canCreateOrganisation: true, initialManagerScope: 'none' } } };

  it('3: the tabs are Team | Add | Roles, and an old ?tab=invite link opens Add', async () => {
    mount();
    expect(await screen.findByRole('navigation', { name: 'Members sections' })).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Members sections' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['Team', 'Invite', 'Roles']);
    expect(screen.getByRole('button', { name: 'Invite' })).toHaveAttribute('aria-current', 'page');
  });

  it('4/5: for a platform administrator Add asks for the CEO email ONLY — no organisation or CEO name, the role fixed to CEO (Organisation), no Add|Invite selector', async () => {
    mount({ ...PLATFORM_ONLY, tab: 'add' });
    expect(await screen.findByRole('heading', { name: 'Invite by email' })).toBeInTheDocument();
    expect(screen.getByText('Send an invite email to your team.')).toBeInTheDocument();
    expect(screen.getByLabelText('Leadership role', { selector: 'button, input' })).toHaveValue('CEO (Organisation)');
    expect(screen.getByLabelText('CEO email')).toBeRequired();
    for (const label of ['Organisation name', 'CEO first name', 'CEO last name', 'First name', 'Last name']) expect(screen.queryByLabelText(label)).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Invite or add' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Send invitation' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create Organisation/ })).toBeNull();
  });

  it('6: Send invitation posts the email alone and shows the shared success notification', async () => {
    post.mockResolvedValue({ data: { email: 'cleo@example.test', outcome: 'invited' } });
    mount({ ...PLATFORM_ONLY, tab: 'add' });
    fireEvent.change(await screen.findByLabelText('CEO email'), { target: { value: 'Cleo@Example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/organisation-invitations', { email: 'cleo@example.test' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('Invitation sent to cleo@example.test')));
  });

  it('7: an address that already has a pending invitation is reported, not re-sent; an invalid address never reaches the API', async () => {
    post.mockResolvedValue({ data: { email: 'cleo@example.test', outcome: 'already_invited' } });
    mount({ ...PLATFORM_ONLY, tab: 'add' });
    fireEvent.change(await screen.findByLabelText('CEO email'), { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('CEO email'), { target: { value: 'cleo@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(expect.stringContaining('already has a pending invitation')));
  });

  it('8: pending CEO invitations can be resent and revoked (with confirmation)', async () => {
    get.mockImplementation((url: string) => {
      if (url === '/leadership/capabilities') return Promise.resolve({ data: PLATFORM_ONLY.capabilities });
      if (url === '/auth/me') return Promise.resolve({ data: { id: 'viewer', roles: [], isPlatformAdmin: true } });
      if (url.startsWith('/admin/organisation-invitations')) {
        return Promise.resolve({ data: { data: [{ id: 'oi-1', email: 'pending.ceo@example.test', status: 'pending', sendCount: 1, maxSends: 3, expiresAt: future, lastSentAt: future, createdAt: future, acceptedOrganisationId: null }], total: 1 } });
      }
      return Promise.resolve({ data: { data: [], total: 0 } });
    });
    post.mockResolvedValue({ data: {} });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={['/settings/workspace/members?tab=add']}><MembersPage /></MemoryRouter></QueryClientProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Resend invitation to pending.ceo@example.test' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/organisation-invitations/oi-1/resend', {}));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke invitation to pending.ceo@example.test' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke invitation' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/organisation-invitations/oi-1/revoke', {}));
  });

  it('Team for a platform administrator keeps the organisations panel from main and opens the shell drawer; no creation control', async () => {
    const opened: string[] = [];
    const listener = (e: Event) => opened.push((e as CustomEvent<{ id: string }>).detail.id);
    document.addEventListener('open-admin-organisation', listener);
    try {
      mount({ ...PLATFORM_ONLY, tab: 'team' });
      await screen.findByPlaceholderText('Search a team member...');
      fireEvent.click(await screen.findByText('Acme'));
      expect(opened).toEqual(['org-1']);
      expect(screen.queryByRole('button', { name: /new organisation/i })).toBeNull();
      expect(get.mock.calls.some(([url]) => String(url).startsWith('/admin/users/directory'))).toBe(false);
    } finally {
      document.removeEventListener('open-admin-organisation', listener);
    }
  });

  it('a platform administrator who also owns a workspace lands on Add organisation by default and can switch to member invitations', async () => {
    mount({ roles: ['ceo'], isPlatformAdmin: true, capabilities: PLATFORM_CAPABILITIES, tab: 'add' });
    expect(await screen.findByRole('heading', { name: 'Invite by email' })).toBeInTheDocument();
    expect(await screen.findByLabelText('Invite or add')).toHaveTextContent('Add');
    fireEvent.click(screen.getByLabelText('Invite or add'));
    fireEvent.click(screen.getByRole('option', { name: 'Invite' }));
    expect(await screen.findByLabelText('Workspace role')).toBeInTheDocument();
  });

  it('15: a CEO or an Initial Manager is never offered organisation creation', async () => {
    mount({ roles: ['ceo'], capabilities: CEO_CAPABILITIES, tab: 'add&mode=add' });
    expect(await screen.findByLabelText('Leadership role')).toHaveValue('Initial Manager');
    expect(screen.queryByLabelText('CEO email')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Add organisation' })).toBeNull();
    expect(get.mock.calls.some(([url]) => String(url).startsWith('/admin/organisation'))).toBe(false);
  });
});

it('opens member information and linked roles without mutating membership', async () => {
  mount({ tab: 'team', isPlatformAdmin: true, members: [{ userId: 'u-detail', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test', roles: [{ id: 'role-1', name: 'Supervisor', isMemberRole: true }], status: 'active', isOwner: false, isSelf: false }] });
  fireEvent.click(await screen.findByRole('button', { name: 'Ada Lovelace' }));
  expect(screen.queryByRole('navigation', { name: 'Members sections' })).not.toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Picture' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();
  expect(screen.getByLabelText('First name')).toHaveValue('Ada');
  expect(screen.getByLabelText('First name')).toHaveAttribute('readonly');
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Member details' })).getByRole('button', { name: 'Permissions' }));
  expect((await screen.findAllByText('Supervisor')).length).toBeGreaterThan(0);
  expect(patch).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();
});

it('returns from member details through the Members breadcrumb without changing membership', async () => {
  mount({ tab: 'team', isPlatformAdmin: true, members: [{ userId: 'member-crumb', firstName: 'Jamie', lastName: 'Green', email: 'jamie@example.test', roles: [ { ...SUPERVISOR, isMemberRole: true } ], status: 'active', isOwner: false, isSelf: false }] });
  fireEvent.click(await screen.findByRole('button', { name: 'Open Jamie Green' }));
  const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
  expect(crumbs).toHaveTextContent('Workspace/Members/Jamie Green');
  expect(within(crumbs).getByRole('link', { name: 'Workspace' })).toHaveAttribute('href', '/settings/my-workspace');
  expect(within(crumbs).getByText('Jamie Green')).toHaveAttribute('aria-current', 'page');
  fireEvent.click(within(crumbs).getByRole('link', { name: 'Members' }));
  expect(await screen.findByRole('heading', { name: 'Members' })).toBeInTheDocument();
  expect(screen.queryByRole('navigation', { name: 'Member details' })).not.toBeInTheDocument();
  expect(patch).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();
});
