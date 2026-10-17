import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { api } from '../../shared/api';
import UserDetailPanel from './UserDetailPanel';

jest.mock('../../shared/api', () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

jest.mock('../../shared/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const mockApi = api as unknown as { get: jest.Mock; post: jest.Mock; patch: jest.Mock; delete: jest.Mock };

function staffRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'staff-1',
    staffRef: 'STAFF 1',
    email: 'jordan@example.test',
    firstName: 'Jordan',
    lastName: 'QA',
    phone: null,
    dateOfBirth: null,
    avatarKey: null,
    employmentStatus: 'active',
    startDate: null,
    defaultPayRatePence: 0,
    createdAt: new Date().toISOString(),
    createdByName: null,
    accountStatus: 'active',
    invitationStatus: null,
    mustResetPassword: false,
    pendingInvite: null,
    emergencyContactName: null,
    emergencyContactRelationship: null,
    emergencyContactPhone: null,
    jobRoleId: null,
    preferredName: null,
    employmentType: null,
    address: null,
    city: null,
    postcode: null,
    otherSkills: null,
    yearsExperience: null,
    availableDays: null,
    preferredShiftTimes: null,
    maxHoursPerWeek: null,
    rightToWorkStatus: null,
    documentType: null,
    expiryDate: null,
    languages: null,
    notes: null,
    ...overrides,
  };
}

function managerRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'manager-1',
    email: 'bob@example.test',
    firstName: 'Bob',
    lastName: 'Manager',
    phone: null,
    avatarKey: null,
    type: 'internal',
    jobTitle: null,
    createdAt: new Date().toISOString(),
    accountStatus: 'active',
    invitationStatus: null,
    mustResetPassword: false,
    pendingInvite: null,
    ...overrides,
  };
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <UserDetailPanel />
    </QueryClientProvider>,
  );
}

const openStaffDetail = (id = 'staff-1') => act(() => {
  document.dispatchEvent(new CustomEvent('open-user-detail', { detail: { id, type: 'staff' } }));
});

const openManagerDetail = (id = 'manager-1') => act(() => {
  document.dispatchEvent(new CustomEvent('open-user-detail', { detail: { id, type: 'manager' } }));
});

// The record's name renders twice (drawer header title + Overview summary)
// — `getAllByText` instead of `getByText` throughout this file, since a
// bare `getByText` throws "Found multiple elements" against either.
const waitForLoaded = (name: string) => waitFor(() => expect(screen.getAllByText(name).length).toBeGreaterThan(0));

beforeEach(() => {
  (URL as any).createObjectURL = jest.fn(() => 'blob:mock-preview-url');
  (URL as any).revokeObjectURL = jest.fn();
  Object.values(mockApi).forEach((m) => m.mockReset());
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/job-roles') return Promise.resolve({ data: [] });
    if (url === '/staff/staff-1') return Promise.resolve({ data: staffRecord() });
    if (url === '/managers/manager-1') return Promise.resolve({ data: managerRecord() });
    return Promise.reject(new Error(`unexpected ${url}`));
  });
});

describe('UserDetailPanel — Staff avatar (Part 3/4)', () => {
  it('renders the avatar as a clickable upload button for a Staff record', async () => {
    mount();
    openStaffDetail();
    await waitForLoaded('Jordan QA');
    expect(screen.getByRole('button', { name: 'Change photo' })).toBeTruthy();
  });

  it('picking a file uploads immediately to POST /staff/:id/avatar and invalidates the record on success', async () => {
    mockApi.post.mockResolvedValue({ data: { avatarKey: 'file-99' } });
    mount();
    openStaffDetail();
    await waitForLoaded('Jordan QA');

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([new Uint8Array(10)], 'avatar.png', { type: 'image/png' });
    await userEvent.upload(input, file);

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith(
      '/staff/staff-1/avatar',
      expect.anything(),
      expect.objectContaining({ headers: expect.objectContaining({ 'Content-Type': 'multipart/form-data' }) }),
    ));
    const call = mockApi.post.mock.calls[0]!;
    expect(call[1]).toBeInstanceOf(FormData);
    expect((call[1] as FormData).get('file')).toBe(file);
  });

  it('shows "Remove photo" only once an avatar exists, and it calls DELETE /staff/:id/avatar', async () => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/job-roles') return Promise.resolve({ data: [] });
      if (url === '/staff/staff-1') return Promise.resolve({ data: staffRecord({ avatarKey: 'file-1' }) });
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    mockApi.delete.mockResolvedValue({ data: { avatarKey: null } });
    mount();
    openStaffDetail();
    await waitForLoaded('Jordan QA');

    const removeButton = screen.getByRole('button', { name: 'Remove photo' });
    await userEvent.click(removeButton);
    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith('/staff/staff-1/avatar'));
  });

  it('does not show "Remove photo" when there is no avatar yet', async () => {
    mount();
    openStaffDetail();
    await waitForLoaded('Jordan QA');
    expect(screen.queryByRole('button', { name: 'Remove photo' })).toBeNull();
  });

  it('a Manager record renders the plain, non-interactive avatar — no Manager avatar endpoint exists yet', async () => {
    mount();
    openManagerDetail();
    await waitForLoaded('Bob Manager');
    expect(screen.queryByRole('button', { name: 'Change photo' })).toBeNull();
  });
});

describe('UserDetailPanel — lifecycle actions match the account state machine', () => {
  const openMenu = async () => userEvent.click(await screen.findByRole('button', { name: 'More actions' }));
  const withManager = (overrides: Record<string, unknown>) => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/job-roles') return Promise.resolve({ data: [] });
      if (url === '/managers/manager-1') return Promise.resolve({ data: managerRecord(overrides) });
      return Promise.reject(new Error(`unexpected ${url}`));
    });
  };

  it('accepted Venue Manager (password set, not signed in): shows the real type and state, offers no Reset/Reactivate', async () => {
    withManager({ type: 'venue', accountStatus: 'invited', invitationStatus: 'accepted', pendingInvite: { sendNumber: 1, maxSendAttempts: 3 } });
    mount();
    openManagerDetail();
    await waitForLoaded('Bob Manager');
    expect(screen.getAllByText('Awaiting first sign-in').length).toBeGreaterThan(0);
    expect(screen.queryByText('Pending — invite not sent')).toBeNull();
    expect(screen.getByText(/becomes active the first time they sign in to the ADOLPHUS mobile app/)).toBeInTheDocument();
    await openMenu();
    expect(screen.queryByRole('button', { name: /Reset password/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reactivate/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Send a new setup link/ })).toBeInTheDocument();
  });

  it('invited with no invitation sent: offers Send invitation, not Reset/Reactivate', async () => {
    withManager({ accountStatus: 'invited', invitationStatus: null, pendingInvite: null });
    mount();
    openManagerDetail();
    await waitForLoaded('Bob Manager');
    await openMenu();
    expect(screen.getByRole('button', { name: /Send invitation/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reset password/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reactivate/ })).toBeNull();
  });

  it('active: Reset password and Suspend; suspended: Reactivate; deactivated: neither', async () => {
    withManager({ accountStatus: 'active' });
    const { unmount } = mount();
    openManagerDetail();
    await waitForLoaded('Bob Manager');
    await openMenu();
    expect(screen.getByRole('button', { name: /Reset password/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Suspend/ })).toBeInTheDocument();
    unmount();

    withManager({ accountStatus: 'suspended' });
    const second = mount();
    openManagerDetail();
    await waitForLoaded('Bob Manager');
    await openMenu();
    expect(screen.getByRole('button', { name: /Reactivate/ })).toBeInTheDocument();
    second.unmount();

    withManager({ accountStatus: 'deactivated' });
    mount();
    openManagerDetail();
    await waitForLoaded('Bob Manager');
    await openMenu();
    expect(screen.queryByRole('button', { name: /Reactivate/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reset password/ })).toBeNull();
  });

  it('labels a CEO as CEO and the Initial Manager as such', async () => {
    withManager({ type: 'ceo' });
    const { unmount } = mount();
    openManagerDetail();
    await waitForLoaded('Bob Manager');
    expect(screen.getByText('Manager • CEO')).toBeInTheDocument();
    unmount();
    withManager({ type: 'internal', isInitialManager: true });
    mount();
    openManagerDetail();
    await waitForLoaded('Bob Manager');
    expect(screen.getByText('Manager • Initial Manager')).toBeInTheDocument();
  });

  it('Delete sends the actor’s current password and shows the server refusal (never a silent success)', async () => {
    withManager({ accountStatus: 'active' });
    mockApi.delete.mockRejectedValue({ response: { status: 403, data: { message: 'Re-enter your current password to continue.' } } });
    mount();
    openManagerDetail();
    await waitForLoaded('Bob Manager');
    await openMenu();
    await userEvent.click(screen.getByRole('button', { name: /Delete user/ }));
    const confirm = screen.getAllByRole('button', { name: 'Delete user' }).at(-1)!;
    await userEvent.type(screen.getByLabelText('Type DELETE to confirm'), 'DELETE');
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Your current password'), 'my-own-password');
    await userEvent.click(confirm);
    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith('/managers/manager-1', { data: { currentPassword: 'my-own-password' } }));
    expect(await screen.findByText('Re-enter your current password to continue.')).toBeInTheDocument();
  });
});
