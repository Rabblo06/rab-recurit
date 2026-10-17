import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import OrganisationsTab from './OrganisationsTab';
import { api } from '../../../shared/api';

jest.mock('../../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn() } }));
const get = api.get as jest.Mock;
const post = api.post as jest.Mock;

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><OrganisationsTab /></QueryClientProvider>);
}

const LIST = [
  { id: 'org-1', name: 'Northside Hospitality', slug: 'northside', suspended: false, createdAt: '2026-01-01T00:00:00Z', ceo: { id: 'u-1', email: 'ceo@northside.test', firstName: 'Jane', lastName: 'Doe', accountStatus: 'active' } },
  { id: 'org-2', name: 'Southside Venues', slug: 'southside', suspended: true, createdAt: '2026-02-01T00:00:00Z', ceo: { id: 'u-2', email: 'ceo@southside.test', firstName: 'Sam', lastName: 'Lee', accountStatus: 'invited' } },
];

const ORG_1_DETAIL = {
  id: 'org-1', name: 'Northside Hospitality', slug: 'northside', suspended: false, createdAt: '2026-01-01T00:00:00Z',
  ceo: { id: 'u-1', email: 'ceo@northside.test', firstName: 'Jane', lastName: 'Doe', accountStatus: 'active', invitationStatus: null, pendingInvite: null },
};

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  get.mockImplementation((url: string) => {
    if (url === '/admin/organisations') return Promise.resolve({ data: LIST });
    if (url === '/admin/organisations/org-1') return Promise.resolve({ data: ORG_1_DETAIL });
    throw new Error(`unexpected GET ${url}`);
  });
});

it('lists organisations with a coarse, honestly-available status badge (accountStatus only, never invented invitation detail)', async () => {
  mount();
  expect(await screen.findByText('Northside Hospitality')).toBeInTheDocument();
  expect(screen.getByText('Southside Venues')).toBeInTheDocument();
  expect(screen.getByText('CEO active')).toBeInTheDocument();
  expect(screen.getByText('Suspended')).toBeInTheDocument();
});

it('search filters by organisation name or CEO identity, client-side', async () => {
  mount();
  await screen.findByText('Northside Hospitality');
  fireEvent.change(screen.getByPlaceholderText('Search by name or CEO…'), { target: { value: 'southside' } });
  expect(screen.queryByText('Northside Hospitality')).toBeNull();
  expect(screen.getByText('Southside Venues')).toBeInTheDocument();
});

it('creating an organisation shows the real saved state and never claims the invitation was delivered', async () => {
  post.mockResolvedValue({
    data: {
      id: 'org-3', name: 'New Co', slug: 'new-co',
      ceo: { id: 'u-3', email: 'ceo@new.test', firstName: 'Alex', lastName: 'Kim', invitationStatus: 'queued' },
    },
  });
  mount();
  await screen.findByText('Northside Hospitality');

  fireEvent.click(screen.getByRole('button', { name: '+ New Organisation' }));
  fireEvent.change(screen.getByLabelText('Organisation name'), { target: { value: 'New Co' } });
  fireEvent.change(screen.getByLabelText('CEO email'), { target: { value: 'ceo@new.test' } });
  fireEvent.change(screen.getByLabelText('CEO first name'), { target: { value: 'Alex' } });
  fireEvent.change(screen.getByLabelText('CEO last name'), { target: { value: 'Kim' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create Organisation & Invite CEO' }));

  await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/organisations', {
    name: 'New Co', ceoEmail: 'ceo@new.test', ceoFirstName: 'Alex', ceoLastName: 'Kim',
  }));
  expect(await screen.findByText('Organisation created.')).toBeInTheDocument();
  expect(screen.getByText('Invitation queued for delivery. The CEO has not received it yet.')).toBeInTheDocument();
  expect(screen.queryByText(/delivered/i)).toBeNull();
  expect(screen.queryByText(/accepted/i)).toBeNull();
});

it('a duplicate CEO email surfaces the real server error, not a fabricated success', async () => {
  post.mockRejectedValue({ response: { data: { message: 'A user with this email already exists.' } } });
  mount();
  await screen.findByText('Northside Hospitality');

  fireEvent.click(screen.getByRole('button', { name: '+ New Organisation' }));
  fireEvent.change(screen.getByLabelText('Organisation name'), { target: { value: 'Dup Co' } });
  fireEvent.change(screen.getByLabelText('CEO email'), { target: { value: 'ceo@northside.test' } });
  fireEvent.change(screen.getByLabelText('CEO first name'), { target: { value: 'Jane' } });
  fireEvent.change(screen.getByLabelText('CEO last name'), { target: { value: 'Doe' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create Organisation & Invite CEO' }));

  expect(await screen.findByText('A user with this email already exists.')).toBeInTheDocument();
  expect(screen.queryByText('Organisation created.')).toBeNull();
});

it('opening an organisation shows its real CEO invitation status, and no Initial Manager actions — those belong to that organisation’s CEO', async () => {
  mount();
  await screen.findByText('Northside Hospitality');

  fireEvent.click(screen.getByText('Northside Hospitality'));
  expect(await screen.findByText('ceo@northside.test')).toBeInTheDocument();
  // CEO already active — no pending-invite actions should be offered.
  expect(screen.queryByRole('button', { name: /Resend invitation/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /Revoke invitation/i })).toBeNull();
  // Organisation isolation (2026-10-15): no cross-organisation Initial Manager invite form (formerly shown here).
  expect(screen.getByText(/Managed by this organisation’s CEO in Settings → Members → Add/)).toBeInTheDocument();
  expect(screen.queryByLabelText('Email')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Send Invitation' })).toBeNull();
});

it('a pending CEO invitation offers resend through the CEO endpoint only (platform-level onboarding is unchanged)', async () => {
  get.mockImplementation((url: string) => {
    if (url === '/admin/organisations') return Promise.resolve({ data: LIST });
    if (url === '/admin/organisations/org-1') {
      return Promise.resolve({ data: { ...ORG_1_DETAIL, ceo: { ...ORG_1_DETAIL.ceo, accountStatus: 'invited', invitationStatus: 'pending', pendingInvite: { sendNumber: 1, maxSendAttempts: 3 } } } });
    }
    throw new Error(`unexpected GET ${url}`);
  });
  post.mockResolvedValue({ data: { sendNumber: 2, expiresAt: '2026-03-01T00:00:00Z', queued: true } });
  mount();
  await screen.findByText('Northside Hospitality');
  fireEvent.click(screen.getByText('Northside Hospitality'));

  const resendButtons = await screen.findAllByRole('button', { name: /Resend invitation/i });
  expect(resendButtons).toHaveLength(1);
  fireEvent.click(resendButtons[0]!);
  await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/organisations/org-1/ceo-invite/resend'));
  expect(post.mock.calls.some(([url]) => String(url).includes('initial-manager'))).toBe(false);
});

it.each([
  ['pending', { accountStatus: 'invited', invitationStatus: 'pending', pendingInvite: { sendNumber: 1, maxSendAttempts: 3 } }],
  ['maxed out', { accountStatus: 'invite_expired', invitationStatus: 'expired', pendingInvite: { sendNumber: 3, maxSendAttempts: 3 } }],
])('even if a response still carried another organisation’s Initial Manager (%s), the drawer shows nothing and offers no resend, revoke or replace for it', async (_label, state) => {
  get.mockImplementation((url: string) => {
    if (url === '/admin/organisations') return Promise.resolve({ data: LIST });
    if (url === '/admin/organisations/org-1') {
      return Promise.resolve({ data: { ...ORG_1_DETAIL, initialManager: { id: 'mp-im', email: 'im@northside.test', firstName: 'Ida', lastName: 'Manager', ...state } } });
    }
    throw new Error(`unexpected GET ${url}`);
  });
  mount();
  await screen.findByText('Northside Hospitality');
  fireEvent.click(screen.getByText('Northside Hospitality'));

  expect(await screen.findByText('ceo@northside.test')).toBeInTheDocument();
  expect(screen.queryByText('im@northside.test')).toBeNull();
  expect(screen.queryByRole('button', { name: /Replace Invitation/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /Resend invitation|Re-invite/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /Revoke invitation/i })).toBeNull();
  expect(post).not.toHaveBeenCalled();
});
