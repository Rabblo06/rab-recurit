import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../../shared/api';
import ShiftApprovalDrawer from './ShiftApprovalDrawer';

jest.mock('../../shared/api', () => ({ api: { get: jest.fn(), put: jest.fn(), post: jest.fn(), delete: jest.fn() } }));
const mock = api as unknown as Record<'get' | 'put' | 'post' | 'delete', jest.Mock>;
const row = (id: string, accountStatus = 'active', employmentStatus = 'active') => ({ id, firstName: id, lastName: 'Staff', email: `${id}@example.test`, staffRef: `REF-${id}`, phone: null, defaultPayRatePence: 1500, accountStatus, employmentStatus, available: true, createdAt: '2026-09-01T00:00:00Z' });
let rows: ReturnType<typeof row>[];
let selected: string[];
const requested = () => selected.map((id) => ({ staffProfileId: id, firstName: id, lastName: 'Staff', email: `${id}@example.test`, stillActive: true }));
function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><aside>Existing sidebar</aside><main className="main-content"><div>Existing workspace</div></main><ShiftApprovalDrawer /></QueryClientProvider>);
}
const open = (shiftId = 'shift-1') => act(() => { document.dispatchEvent(new CustomEvent('open-shift-approval', { detail: { shiftId } })); });
async function picker() { mount(); open(); await userEvent.click(await screen.findByRole('button', { name: 'Select 2 Staff' })); await screen.findByRole('checkbox', { name: 'Select Alpha Staff' }); }
beforeEach(() => {
  Object.values(mock).forEach((m) => m.mockReset()); selected = ['Alpha']; rows = [row('Alpha'), row('Bravo'), row('Charlie'), row('Delta')];
  mock.get.mockImplementation(async (url: string, options?: { params: { q?: string; page?: number; limit?: number } }) => {
    if (url === '/shifts/shift-1') return { data: { id: 'shift-1', venueId: 'venue', jobRoleId: 'role', status: 'pending_manager_approval', requiredCount: 3, startsAt: '2026-10-01T12:00:00Z', endsAt: '2026-10-01T18:00:00Z', payRatePence: 1500 } };
    if (url.endsWith('/requested-staff')) return { data: requested() };
    if (url === '/shifts/shift-1/selectable-staff') { const filtered = rows.filter((r) => !options?.params.q || `${r.firstName} ${r.email} ${r.staffRef}`.includes(options.params.q)); return { data: { data: filtered.slice(((options?.params.page ?? 1) - 1) * (options?.params.limit ?? 25), (options?.params.page ?? 1) * (options?.params.limit ?? 25)), total: filtered.length } }; }
    if (url === '/job-roles') return { data: [{ id: 'role', name: 'Hospitality' }] };
    return { data: { name: 'Example venue' } };
  });
  mock.put.mockImplementation(async (_url: string, body: { staffProfileIds: string[] }) => { selected = body.staffProfileIds; return { data: {} }; });
  mock.post.mockResolvedValue({ data: {} });
});
it('opens a full workspace page, prechecks existing staff and requests ACTIVE-only private data', async () => {
  await picker(); expect(screen.getByRole('heading', { name: 'Select Staff' })).toBeTruthy();
  expect(screen.getByRole('checkbox', { name: 'Select Alpha Staff' })).toBeChecked();
  expect(screen.getByText('1 of 3 selected · 2 remaining')).toBeTruthy();
  expect(mock.get).toHaveBeenCalledWith('/shifts/shift-1/selectable-staff', { params: expect.objectContaining({ page: 1, limit: 25 }) });
  expect(screen.queryByText('Password')).toBeNull(); expect(screen.getByText('Existing sidebar')).toBeTruthy();
});
it.each(['inactive', 'suspended', 'deactivated', 'invited', 'invite_expired', 'archived'])('never renders %s accounts even in a stale response', async (status) => {
  rows.push(row('Hidden', status)); await picker(); expect(screen.queryByRole('checkbox', { name: 'Select Hidden Staff' })).toBeNull();
});
it('never renders nonactive employment', async () => { rows.push(row('Hidden', 'active', 'inactive')); await picker(); expect(screen.queryByText('Hidden Staff')).toBeNull(); });
it('enforces capacity, deduplicates toggles and keeps changes local until Confirm', async () => {
  await picker(); await userEvent.click(screen.getByRole('checkbox', { name: 'Select Bravo Staff' })); await userEvent.click(screen.getByRole('checkbox', { name: 'Select Charlie Staff' }));
  await userEvent.click(screen.getByRole('checkbox', { name: 'Select Delta Staff' })); expect(screen.getByRole('checkbox', { name: 'Select Delta Staff' })).not.toBeChecked();
  expect(screen.getByText(/All 3 places/)).toBeTruthy(); expect(mock.put).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(await screen.findByText('3 selected / 3 required (0 open)')).toBeTruthy(); expect(screen.getByRole('button', { name: /Staff Complete/ })).toBeDisabled();
  expect(mock.put).toHaveBeenCalledWith('/shifts/shift-1/requested-staff', { staffProfileIds: ['Alpha', 'Bravo', 'Charlie'], expectedStaffProfileIds: ['Alpha'] });
  expect(mock.post).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Approve' })); expect(mock.post).toHaveBeenCalledWith('/shifts/shift-1/approve', {});
});
it('Cancel discards additions and removals and restores the same drawer without offers', async () => {
  await picker(); await userEvent.click(screen.getByRole('checkbox', { name: 'Select Alpha Staff' })); await userEvent.click(screen.getByRole('checkbox', { name: 'Select Bravo Staff' })); open('different-request');
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' })); expect(await screen.findByText('1 selected / 3 required (2 open)')).toBeTruthy(); expect(mock.put).not.toHaveBeenCalled(); expect(mock.post).not.toHaveBeenCalled();
});
it('searches on the server and preserves selection across search', async () => {
  await picker(); await userEvent.type(screen.getByRole('textbox', { name: 'Search staff' }), 'REF-Bravo');
  await waitFor(() => expect(mock.get).toHaveBeenCalledWith('/shifts/shift-1/selectable-staff', { params: expect.objectContaining({ q: 'REF-Bravo' }) }));
  await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Select Alpha Staff' })).toBeNull());
  expect(screen.getByText('1 of 3 selected · 2 remaining')).toBeTruthy();
});
it('empty results disable Confirm', async () => { rows = []; mount(); open(); await userEvent.click(await screen.findByRole('button', { name: 'Select 2 Staff' })); expect(await screen.findByText('No active staff available')).toBeTruthy(); expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled(); });
it('failed atomic save stays in selection mode with a safe error', async () => { mock.put.mockRejectedValue(new Error('private SQL')); await picker(); await userEvent.click(screen.getByRole('button', { name: 'Confirm' })); expect(await screen.findByRole('alert')).toHaveTextContent('Could not save'); expect(screen.queryByText('private SQL')).toBeNull(); expect(mock.post).not.toHaveBeenCalled(); });
it('keyboard Space toggles a checkbox once', async () => { await picker(); const checkbox = screen.getByRole('checkbox', { name: 'Select Bravo Staff' }); checkbox.focus(); await userEvent.keyboard(' '); expect(checkbox).toBeChecked(); expect(screen.getByText('2 of 3 selected · 1 remaining')).toBeTruthy(); });

it('unavailable active staff cannot be newly selected', async () => { rows[1]!.available = false; await picker(); expect(screen.getByRole('checkbox', {name:'Select Bravo Staff'})).toBeDisabled(); expect(screen.getByText('Unavailable')).toBeTruthy(); });
it('pagination fetches the next real page without discarding selections', async () => {
  rows = [...rows,...Array.from({length:25},(_,i)=>row(`Member${i}`))]; await picker();
  await userEvent.click(screen.getByRole('button',{name:'Next'}));
  await screen.findByText('Page 2 of 2'); expect(screen.getByText('1 of 3 selected \u00b7 2 remaining')).toBeTruthy();
  expect(mock.get).toHaveBeenCalledWith('/shifts/shift-1/selectable-staff',{params:expect.objectContaining({page:2,limit:25})});
});
it('loading, safe failure and Retry use the same request context', async () => {
  const original=mock.get.getMockImplementation()!; let reject: (e: Error)=>void = () => {};
  mock.get.mockImplementation((url: string, params: unknown) => url.endsWith('/selectable-staff') ? new Promise((_resolve, fail)=>{reject=fail;}) : original(url,params));
  mount();open();await userEvent.click(await screen.findByRole('button',{name:'Select 2 Staff'}));
  expect(await screen.findByRole('status',{name:'Loading records'})).toBeTruthy();
  await act(async()=>reject(new Error('private database detail')));
  expect(await screen.findByText('Could not load staff')).toBeTruthy();expect(screen.queryByText('private database detail')).toBeNull();
  mock.get.mockImplementation(original);await userEvent.click(screen.getByRole('button',{name:'Retry'}));
  expect(await screen.findByRole('checkbox',{name:'Select Alpha Staff'})).toBeChecked();expect(screen.queryByText('Could not load staff')).toBeNull();
});
