import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../../shared/api';
import ShiftDrawers, { currentShiftDraft, shiftEndDate } from './ShiftDrawers';

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
    if (url === '/venues') return { data: { data: [{ id: 'venue-1', name: 'Venue Test 1', status: 'active' }] } };
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


it('prefills venue instructions, replaces untouched defaults, and preserves manually edited shift notes', async () => {
  const original=mock.get.getMockImplementation();
  mock.get.mockImplementation(async (url:string,...args:unknown[])=>url==='/venues'?{data:[
    {id:'one',name:'First venue',status:'active',instructions:'Arrive early.\nUse reception.'},
    {id:'two',name:'Second venue',status:'active',instructions:'Bring ID.'},
  ]}:original!(url,...args));
  mount();act(()=>document.dispatchEvent(new CustomEvent('open-create-placement')));
  await userEvent.click(await screen.findByRole('button',{name:'Search venues…'}));
  await userEvent.click(await screen.findByRole('button',{name:'First venue'}));
  expect(screen.getByLabelText('Notes')).toHaveValue('Arrive early.\nUse reception.');
  await userEvent.click(screen.getAllByText('First venue')[0].closest('button')!);
  await userEvent.click(await screen.findByRole('button',{name:'Second venue'}));
  expect(screen.getByLabelText('Notes')).toHaveValue('Bring ID.');
  await userEvent.clear(screen.getByLabelText('Notes'));await userEvent.type(screen.getByLabelText('Notes'),'Custom note');
  await userEvent.click(screen.getAllByText('Second venue')[0].closest('button')!);
  await userEvent.click(await screen.findByRole('button',{name:'First venue'}));
  expect(screen.getByLabelText('Notes')).toHaveValue('Custom note');
  expect(mock.post).not.toHaveBeenCalled();
});


it('starts a fresh shift draft with the current local date and minute, without inventing an end time', () => {
 const first=currentShiftDraft(new Date(2026,10,9,14,7,45));
 expect(first).toMatchObject({date:'2026-11-09',startTime:'14:07',endTime:''});
 const next=currentShiftDraft(new Date(2026,10,10,0,3));
 expect(next).toMatchObject({date:'2026-11-10',startTime:'00:03',endTime:''});
});


it('advances overnight ends across month/year boundaries and retains same-day times',()=>{
 const overnight=shiftEndDate('2026-12-31','08:00','20:00');
 expect([overnight.getFullYear(),overnight.getMonth(),overnight.getDate(),overnight.getHours()]).toEqual([2027,0,1,8]);
 const sameDay=shiftEndDate('2026-12-31','08:00','07:00');
 expect(sameDay.getDate()).toBe(31);
 const equal=shiftEndDate('2026-12-31','08:00','08:00');expect(equal.getDate()).toBe(31);
 const leap=shiftEndDate('2028-02-28','08:00','20:00');expect(leap.getDate()).toBe(29);
});

it('sends individual staff times under one shift without changing another staff draft', async () => {
  mount();
  act(() => { document.dispatchEvent(new CustomEvent('open-create-placement')); });
  await userEvent.click(await screen.findByRole('button', { name: 'Search venues…' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Venue Test 1' }));
  await userEvent.click(screen.getByRole('button', { name: 'Search roles…' }));
  await userEvent.click(await screen.findByRole('button', { name: /Test Role 1/ }));
  await userEvent.type(screen.getByPlaceholderText('123 Oxford Street, London W1D 2JE, United Kingdom'), 'Test address');
  await userEvent.clear(screen.getByRole('textbox', { name: 'Start time' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Start time' }), '09:00');
  await userEvent.tab();
  await userEvent.type(screen.getByRole('textbox', { name: 'End time' }), '17:00');
  await userEvent.tab();
  await pickAlphaAndBravo();
  const alpha = screen.getByRole('textbox', { name: 'Alpha Staff start time' });
  const bravo = screen.getByRole('textbox', { name: 'Bravo Staff start time' });
  const originalBravo = (bravo as HTMLInputElement).value;
  await userEvent.clear(alpha);
  await userEvent.type(alpha, '20:00');
  await userEvent.tab();
  expect(bravo).toHaveValue(originalBravo);
  await userEvent.click(screen.getByRole('button', { name: /Send Offer/ }));
  await waitFor(() => expect(mock.post).toHaveBeenCalledTimes(1));
  const [url, payload] = mock.post.mock.calls[0];
  expect(url).toBe('/shifts/with-offers');
  expect(payload.staffAssignments).toHaveLength(2);
  expect(payload.staffAssignments.map((row: { staffProfileId: string }) => row.staffProfileId)).toEqual(['Alpha', 'Bravo']);
  expect(payload.staffAssignments.every((row: Record<string, unknown>) => !('jobRoleId' in row))).toBe(true); // per-recipient role is held (AssignmentRole)
  expect(new Date(payload.staffAssignments[0].startsAt).getHours()).toBe(20);
  expect(new Date(payload.staffAssignments[1].startsAt).getHours()).toBe(9);
  expect(new Date(payload.staffAssignments[0].endsAt).getTime()).toBeGreaterThan(new Date(payload.staffAssignments[0].startsAt).getTime());
});


it('chooses a venue shift and sends additional offers against the same shift without creating another', async () => {
  const original = mock.get.getMockImplementation();
  mock.get.mockImplementation(async (url: string, ...args: unknown[]) => url === '/shifts' ? {data:{data:[{id:'existing-shift',venueId:'venue-1',jobRoleId:'role-1',startsAt:'2099-01-01T09:00:00Z',endsAt:'2099-01-01T17:00:00Z',status:'fully_filled',requiredCount:3,filledCount:3}]}} : original!(url,...args));
  mock.post.mockResolvedValue({data:{results:[{staffProfileId:'Alpha',ok:true},{staffProfileId:'Bravo',ok:true}]}});
  mount();act(()=>document.dispatchEvent(new CustomEvent('open-create-placement')));
  await userEvent.click(await screen.findByRole('button',{name:'Search venues…'}));
  await userEvent.click(await screen.findByRole('button',{name:'Venue Test 1'}));
  await userEvent.click(await screen.findByRole('button',{name:'Choose an existing shift…'}));
  await userEvent.click(await screen.findByRole('button',{name:/Test Role 1 ·.*2099/}));
  await userEvent.clear(screen.getByLabelText('Total staff required'));
  await userEvent.type(screen.getByLabelText('Total staff required'),'5');
  await pickAlphaAndBravo();
  await userEvent.click(await screen.findByRole('button',{name:/Send offers \(2\)/}));
  await waitFor(()=>expect(mock.post).toHaveBeenCalledWith('/shifts/existing-shift/offers/bulk',expect.objectContaining({staffProfileIds:['Alpha','Bravo'],requiredCount:5,expectedRequiredCount:3})));
  expect(mock.post.mock.calls.every(([url])=>url==='/shifts/existing-shift/offers/bulk')).toBe(true);
});
