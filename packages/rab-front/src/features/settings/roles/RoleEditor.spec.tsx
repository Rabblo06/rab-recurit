import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import RoleEditorLayout from './RoleEditorLayout';
import RoleEditorMain from './RoleEditorMain';
import { ObjectPermissionsStep, SelectObjectStep } from './RoleObjectSteps';

jest.mock('../../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() } }));
const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const put = api.put as jest.Mock;
const del = api.delete as jest.Mock;

const field = (key: string, label: string, over: Record<string, unknown> = {}) => ({
  key, label, dataType: 'text', locked: false, defaultVisible: true, sensitive: false, grantable: true, filter: null, ...over,
});
const METADATA = {
  icons: ['shield', 'users', 'star'],
  objects: [
    {
      key: 'staff', label: 'Staff', labelPlural: 'Staff', icon: 'users', description: 'Recruitment staff in your workspace.',
      actions: { read: true, update: false, softDelete: false, destroy: false },
      unsupportedReason: 'Workspace members have read-only access.', grantable: true,
      fields: [
        field('name', 'Name', { locked: true }),
        field('city', 'City', { filter: { kind: 'text', operators: ['eq', 'neq', 'is_empty'], nullable: true, options: null, relation: null } }),
        field('phone', 'Phone', { defaultVisible: false, sensitive: true, dataType: 'phone' }),
        field('payRate', 'Default pay rate', { defaultVisible: false, sensitive: true, grantable: false, dataType: 'money' }),
      ],
    },
    {
      key: 'venue', label: 'Venue', labelPlural: 'Venues', icon: 'building', description: 'Client venues.',
      actions: { read: true, update: false, softDelete: false, destroy: false },
      unsupportedReason: 'Workspace members have read-only access.', grantable: false,
      fields: [field('name', 'Name', { locked: true })],
    },
  ],
};
const CUSTOM = {
  id: 'role-1', key: 'custom_supervisor', name: 'Supervisor', description: null, icon: 'shield', isSystem: false, isMemberRole: true,
  assignableToMembers: true, readAllObjects: false, objects: [], permissionKeys: [], updatedAt: '2026-10-14T00:00:00Z',
};
const SYSTEM = { ...CUSTOM, id: 'role-sys', key: 'manager', name: 'Manager', isSystem: true, isMemberRole: false, permissionKeys: ['staff.view', 'role.manage'] };

function mount(path: string) {
  get.mockImplementation((url: string) => {
    if (url === '/roles/object-metadata') return Promise.resolve({ data: METADATA });
    if (url === '/roles/role-1/definition') return Promise.resolve({ data: CUSTOM });
    if (url === '/roles/role-sys/definition') return Promise.resolve({ data: SYSTEM });
    return Promise.resolve({ data: [] });
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/settings/workspace/members/roles/:roleId" element={<RoleEditorLayout />}>
            <Route index element={<RoleEditorMain />} />
            <Route path="objects" element={<SelectObjectStep />} />
            <Route path="objects/:objectKey" element={<ObjectPermissionsStep />} />
          </Route>
          <Route path="/settings/workspace/members" element={<p>Roles list</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Reference behaviour: the role name is a heading; clicking it turns it into the "Role name" input. */
async function rename(value: string) {
  fireEvent.click(await screen.findByRole('button', { name: /Click to rename/ }));
  const input = screen.getByRole('textbox', { name: 'Role name' });
  expect(input).toHaveFocus();
  fireEvent.change(input, { target: { value } });
  return input;
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  put.mockReset();
  del.mockReset();
});

it('has exactly two tabs (Permissions, Settings), a breadcrumb, and starts a new role with nothing granted', async () => {
  mount('/settings/workspace/members/roles/new');
  const tabs = within(await screen.findByRole('navigation', { name: 'Role sections' })).getAllByRole('button');
  expect(tabs.map((t) => t.textContent)).toEqual(['Permissions', 'Settings']);
  expect(screen.queryByText(/Assignment/)).toBeNull();
  const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
  expect(crumbs).toHaveTextContent('Workspace/Members/Roles/Untitled role');
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Untitled role');
  expect(screen.getByRole('checkbox', { name: 'All Objects' })).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'See Records on All Objects' })).not.toBeChecked();
  // Edit / Delete / Destroy are shown but never offered as fake toggles.
  for (const label of ['Edit', 'Delete', 'Destroy']) expect(screen.getByRole('checkbox', { name: `${label} Records on All Objects (not available)` })).toBeDisabled();
  // Layout / Logic: honest, disabled switches (no layout/logic permission model exists for members).
  expect(screen.getByRole('switch', { name: 'Layout All Access (not available)' })).toHaveAttribute('aria-checked', 'false');
  expect(screen.getByRole('switch', { name: 'Logic All Access (not available)' })).toHaveAttribute('aria-checked', 'false');
  expect(screen.getByText('No permissions have been set for individual objects.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
});

it('creates a role through the two-step wizard: object, fields and a record filter are saved in one request', async () => {
  post.mockResolvedValue({ data: { ...CUSTOM, id: 'role-new', name: 'Floor lead' } });
  mount('/settings/workspace/members/roles/new');
  const title = await rename('Floor lead');
  fireEvent.keyDown(title, { key: 'Enter' });
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Floor lead');
  expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('Floor lead');

  fireEvent.click(screen.getByRole('link', { name: /Add rule/ }));
  expect(await screen.findByText('1. Select an object')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: 'Search an object' }), { target: { value: 'ven' } });
  expect(screen.queryByText('Staff')).toBeNull();
  fireEvent.change(screen.getByRole('textbox', { name: 'Search an object' }), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: /Staff/ }));

  expect(await screen.findByText('2. Set Staff permissions')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox', { name: 'See Staff' }));
  expect(screen.getByRole('checkbox', { name: 'See Staff' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'See Name' })).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: 'See Name' })).toBeChecked();
  // A sensitive field the editor cannot see themselves can't be revealed.
  expect(screen.getByRole('checkbox', { name: 'See Default pay rate' })).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: 'Edit Phone (not available)' })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: 'See Phone' }));

  fireEvent.click(screen.getByRole('button', { name: /Add filter/ }));
  // Incomplete conditions are flagged in red before saving.
  expect(screen.getByText('Enter a value.')).toHaveClass('feedback-error');
  fireEvent.change(screen.getByRole('textbox', { name: 'Value' }), { target: { value: 'London' } });
  fireEvent.click(screen.getByRole('link', { name: 'Finish' }));

  expect(await screen.findByText('Object-Level')).toBeInTheDocument();
  expect(screen.getByText(/See: granted · 1 hidden field · 1 record filter/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  expect(post).toHaveBeenCalledWith('/roles', {
    name: 'Floor lead',
    description: null,
    icon: 'shield',
    assignableToMembers: true,
    readAllObjects: false,
    objects: [{ object: 'staff', read: 'grant', fields: { phone: 'visible' }, recordFilter: { op: 'and', conditions: [{ field: 'city', operator: 'eq', value: 'London' }] } }],
  });
  expect(await screen.findByText('Roles list')).toBeInTheDocument();
});

it('waits for a complete successful save before returning to Roles', async () => {
  let finish!: (response: unknown) => void;
  put.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const confirm = jest.spyOn(window, 'confirm');
  mount('/settings/workspace/members/roles/role-1');
  fireEvent.blur(await rename('Floor lead'));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  expect(screen.queryByText('Roles list')).toBeNull();
  await act(async () => finish({ data: { ...CUSTOM, name: 'Floor lead' } }));
  expect(await screen.findByText('Roles list')).toBeInTheDocument();
  expect(confirm).not.toHaveBeenCalled();
  confirm.mockRestore();
});

it.each([undefined, {}, { id: 'role-1', name: 'Floor lead' }, { ...CUSTOM, id: 'another-role' }, { ...CUSTOM, objects: null }])(
  'keeps the draft when HTTP success has an incomplete or mismatched role: %j', async (data) => {
    put.mockResolvedValue({ data });
    mount('/settings/workspace/members/roles/role-1');
    fireEvent.blur(await rename('Floor lead'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('did not return a complete saved role');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Floor lead');
    expect(screen.queryByText('Roles list')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  },
);

it('renders the breadcrumb in the shell slot once, preserving other header actions', async () => {
  const host = document.createElement('header');
  host.innerHTML = '<div data-role-breadcrumb-slot></div><button>Notifications</button>';
  document.body.appendChild(host);
  const view = mount('/settings/workspace/members/roles/role-1');
  await screen.findByRole('button', { name: /Click to rename/ });
  expect(screen.getAllByRole('navigation', { name: 'Breadcrumb' })).toHaveLength(1);
  expect(within(host).getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('Workspace/Members/Roles/Supervisor');
  expect(within(host).getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
  view.unmount();
  host.remove();
});

it('an object the editor cannot see themselves cannot be granted', async () => {
  mount('/settings/workspace/members/roles/role-1/objects/venue');
  const see = await screen.findByRole('checkbox', { name: 'See Venues' });
  expect(see).not.toBeChecked();
  expect(see).toBeDisabled();
  expect(screen.getByText(/You can’t grant Venues/)).toBeInTheDocument();
});

it('shows a server rejection in red and keeps the draft', async () => {
  put.mockRejectedValue({ response: { data: { message: 'A role with this name already exists.' } } });
  mount('/settings/workspace/members/roles/role-1');
  // Clicking Save blurs the title input in a real browser; jsdom's click doesn't, so blur explicitly.
  fireEvent.blur(await rename('Manager'));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('A role with this name already exists.');
  expect(alert).toHaveClass('feedback-error');
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Manager');
});

it('system roles open read-only: no Save, no editable name, no rules', async () => {
  mount('/settings/workspace/members/roles/role-sys');
  expect(await screen.findByRole('note')).toHaveTextContent(/read-only/);
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  expect(screen.queryByRole('textbox', { name: 'Role name' })).toBeNull();
  expect(screen.getByText('role.manage')).toBeInTheDocument();
});

it('Settings: icon, description and applicability are saved before returning to Roles', async () => {
  put.mockResolvedValue({ data: { ...CUSTOM, description: 'Leads the floor', assignableToMembers: false, icon: 'star' } });
  del.mockRejectedValue({ response: { data: { message: 'This role is still in use (1 member, 0 invitations).' } } });
  const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
  const view = mount('/settings/workspace/members/roles/role-1?tab=settings');
  fireEvent.click(await screen.findByRole('radio', { name: 'star' }));
  fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Leads the floor' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /Assignable to Workspace Members/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(put).toHaveBeenCalledWith('/roles/role-1', expect.objectContaining({ icon: 'star', description: 'Leads the floor', assignableToMembers: false })));

  expect(await screen.findByText('Roles list')).toBeInTheDocument();
  expect(confirm).not.toHaveBeenCalled();
  view.unmount();
  mount('/settings/workspace/members/roles/role-1?tab=settings');
  fireEvent.click(await screen.findByRole('button', { name: 'Delete role' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('still in use');
  expect(alert).toHaveClass('feedback-error');
  confirm.mockRestore();
});

it('Cancel with unsaved changes asks before leaving', async () => {
  const confirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
  mount('/settings/workspace/members/roles/role-1');
  fireEvent.blur(await rename('Changed'));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(confirm).toHaveBeenCalled();
  expect(screen.queryByText('Roles list')).toBeNull();
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(await screen.findByText('Roles list')).toBeInTheDocument();
  confirm.mockRestore();
});

it('inline title: Escape restores the name it had before editing; the Settings name field stays in sync', async () => {
  mount('/settings/workspace/members/roles/role-1');
  const input = await rename('Typo name');
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Supervisor');
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  fireEvent.keyDown(await rename('Shift Coordinator'), { key: 'Enter' });
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Shift Coordinator');
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Shift Lead' } });
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Shift Lead');
});

describe('regression: "This role could not be opened" — every load failure has its own, correct state', () => {
  const failWith = (status: number | undefined) => {
    get.mockImplementation((url: string) => {
      if (url === '/roles/object-metadata') return Promise.resolve({ data: METADATA });
      return Promise.reject(Object.assign(new Error('fail'), { isAxiosError: true, response: status === undefined ? undefined : { status, data: {} } }));
    });
  };
  const mountRaw = () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/settings/workspace/members/roles/role-1']}>
          <Routes>
            <Route path="/settings/workspace/members/roles/:roleId" element={<RoleEditorLayout />}>
              <Route index element={<RoleEditorMain />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  };

  it('404 (deleted, or not in this workspace — never distinguished) → Role not found', async () => {
    failWith(404);
    mountRaw();
    expect(await screen.findByRole('heading', { name: 'Role not found' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('403 → no access, without revealing anything about the role', async () => {
    failWith(403);
    mountRaw();
    expect(await screen.findByRole('heading', { name: 'You don’t have access to roles' })).toBeInTheDocument();
  });

  it('server error or network failure → a red, retryable error that recovers', async () => {
    failWith(500);
    mountRaw();
    expect(await screen.findByRole('heading', { name: 'We couldn’t load this role' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveClass('feedback-error');
    get.mockImplementation((url: string) => {
      if (url === '/roles/object-metadata') return Promise.resolve({ data: METADATA });
      if (url === '/roles/role-1/definition') return Promise.resolve({ data: CUSTOM });
      return Promise.resolve({ data: [] });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Supervisor');
  });

  it('a missing network response is also retryable, never "not found"', async () => {
    failWith(undefined);
    mountRaw();
    expect(await screen.findByRole('heading', { name: 'We couldn’t load this role' })).toBeInTheDocument();
  });
});
