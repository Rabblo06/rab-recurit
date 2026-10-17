import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../../shared/api';
import ShiftDrawers from './ShiftDrawers';

/**
 * "New shift" and "Send offers" pick staff on the full-page StaffSelectionPage (draft mode): "Select staff" opens it,
 * Confirm returns the chosen staff to the drawer WITHOUT any server write, and only the drawer's Send creates offers.
 */
jest.mock('../../shared/api', () => ({ api: { get: jest.fn(), put: jest.fn(), post: jest.fn(), delete: jest.fn() } }));
const mock = api as unknown as Record<'get' | 'put' | 'post' | 'delete', jest.Mock>;

const staffRow = (id: string) => ({
  id, firstName: id, lastName: 'Staff', email: `${id.toLowerCase()}@example.test`, staffRef: `REF-${id}`, phone: null,
  defaultPayRatePence: null, accountStatus: 'active', employmentStatus: 'active', createdAt: '2026-09-01T00:00:00Z',
});
const STAFF = ['Alpha', 'Bravo', 'Charlie'].map(staffRow);

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><main className="main-content"><div>Existing workspace</div></main><ShiftDrawers /></QueryClientProvider>);
}

beforeEach(() => {
  Object.values(mock).forEach((m) => m.mockReset());
  mock.get.mockImplementation(async (url: string) => {
    if (url === '/staff') return { data: { data: STAFF, total: STAFF.length } };
    if (url === '/venues') return { data: { data: [{ id: 'venue-1', name: 'Venue Test 1' }] } };
    if (url === '/job-roles') return { data: [{ id: 'role-1', name: 'Test Role 1' }] };
    return { data: [] };
  });
  mock.post.mockResolvedValue({ data: { batchId: 'b1', results: [] } });
});

async function pickAlphaAndBravo() {
  await userEvent.click(await screen.findByRole('button', { name: /Select staff/ }));
  expect(await screen.findByRole('heading', { name: 'Select Staff' })).toBeInTheDocument();
  await userEvent.click(await screen.findByRole('checkbox', { name: 'Select Alpha Staff' }));
  await userEvent.click(screen.getByRole('checkbox', { name: 'Select Bravo Staff' }));
  await userEvent.click(within(screen.getByRole('region', { name: 'Select staff for this shift' })).getByRole('button', { name: 'Confirm' }));
}

it('New shift: "Select staff" opens the full-page picker (active staff from GET /staff), Confirm lists the chosen staff in the drawer and saves nothing', async () => {
  mount();
  act(() => { document.dispatchEvent(new CustomEvent('open-create-placement')); });
  expect(screen.queryByPlaceholderText('Search staff…')).toBeNull();
  await pickAlphaAndBravo();

  expect(mock.get).toHaveBeenCalledWith('/staff', { params: expect.objectContaining({ status: 'active', accountStatus: 'active', page: 1 }) });
  const list = await screen.findByRole('list', { name: 'Selected staff' });
  expect(within(list).getByText('Alpha Staff')).toBeInTheDocument();
  expect(within(list).getByText('Bravo Staff')).toBeInTheDocument();
  expect(screen.getByText('2 staff selected')).toBeInTheDocument();
  expect(mock.put).not.toHaveBeenCalled();
  expect(mock.post).not.toHaveBeenCalled();

  await userEvent.click(within(list).getByRole('button', { name: 'Remove Alpha Staff' }));
  expect(screen.getByText('1 staff selected')).toBeInTheDocument();
  expect(within(screen.getByRole('list', { name: 'Selected staff' })).queryByText('Alpha Staff')).toBeNull();
});

it('reopening the picker keeps the current selection checked, and Cancel leaves the drawer selection unchanged', async () => {
  mount();
  act(() => { document.dispatchEvent(new CustomEvent('open-create-placement')); });
  await pickAlphaAndBravo();
  await userEvent.click(screen.getByRole('button', { name: /Change staff/ }));
  expect(await screen.findByRole('checkbox', { name: 'Select Alpha Staff' })).toBeChecked();
  await userEvent.click(screen.getByRole('checkbox', { name: 'Select Charlie Staff' }));
  await userEvent.click(within(screen.getByRole('region', { name: 'Select staff for this shift' })).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.getByText('2 staff selected')).toBeInTheDocument());
});

it('Send offers (existing shift): the chosen staff are the only ones sent', async () => {
  mount();
  const shift = { id: 'shift-9', venueId: 'venue-1', jobRoleId: 'role-1', startsAt: '2026-10-20T10:00:00Z', endsAt: '2026-10-20T18:00:00Z', requiredCount: 3, filledCount: 0, status: 'open' };
  act(() => { document.dispatchEvent(new CustomEvent('open-send-offer', { detail: { shift } })); });
  await pickAlphaAndBravo();
  await userEvent.click(await screen.findByRole('button', { name: /Send offers \(2\)/ }));
  await waitFor(() => expect(mock.post).toHaveBeenCalled());
  const [url, body] = mock.post.mock.calls[0]!;
  expect(url).toBe('/shifts/shift-9/offers/bulk');
  expect(body.staffProfileIds).toEqual(['Alpha', 'Bravo']);
});
