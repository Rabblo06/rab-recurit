import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../../shared/api';
import RightSidePanel from '../../shared/components/RightSidePanel';
import VenueManagerTeamSection from './VenueManagerTeamSection';

jest.mock('../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn(), delete: jest.fn() } }));
jest.mock('../../shared/lib/toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
const mock = api as unknown as Record<'get' | 'post' | 'delete', jest.Mock>;

const member = (id: string, extra: Record<string, unknown> = {}) => ({
  id, firstName: id, lastName: 'Staff', email: `${id.toLowerCase()}@example.test`, staffRef: `REF-${id}`, phone: null,
  accountStatus: 'active', employmentStatus: 'active', jobRoleName: 'Waiter', assignedAt: '2026-10-16T10:00:00Z', createdAt: '2026-10-16T10:00:00Z', ...extra,
});
let team: ReturnType<typeof member>[];

/** The panel owns the footer "Add Staff" button; this harness stands in for it. */
function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <main className="main-content"><div>Workspace</div></main>
      <button type="button" onClick={() => setOpen(true)}>Footer Add Staff</button>
      <VenueManagerTeamSection venueManagerId="vm-1" venueManagerName="Venue Test 1" pickerOpen={open} onPickerClose={() => setOpen(false)} />
    </>
  );
}
function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Harness /></QueryClientProvider>);
}

beforeEach(() => {
  Object.values(mock).forEach((m) => m.mockReset());
  team = [member('Alpha')];
  mock.get.mockImplementation(async (url: string) => {
    if (url === '/venue-managers/vm-1/staff') return { data: team };
    if (url === '/staff') return { data: { data: [member('Alpha'), member('Bravo'), member('Charlie'), member('Suspended', { accountStatus: 'suspended' })], total: 4 } };
    return { data: [] };
  });
  mock.post.mockImplementation(async (_url: string, body: { staffProfileIds: string[] }) => {
    team = [...team, ...body.staffProfileIds.map((id) => member(id))];
    return { data: { added: body.staffProfileIds, alreadyAssigned: [] } };
  });
  mock.delete.mockImplementation(async (url: string) => { team = team.filter((m) => !url.endsWith(`/${m.id}`)); return { data: null }; });
});

it('lists the assigned staff with a count, role and status', async () => {
  mount();
  expect(await screen.findByText('Assigned Staff · 1')).toBeInTheDocument();
  const list = screen.getByRole('list', { name: 'Assigned staff' });
  expect(within(list).getByText('Alpha Staff')).toBeInTheDocument();
  expect(within(list).getByText('Assigned')).toBeInTheDocument();
});

it('Add Staff opens the full-page Select Staff picker: assigned staff are checked and locked, non-assignable accounts are hidden, Confirm posts only the new selection', async () => {
  mount();
  await screen.findByText('Assigned Staff · 1');
  await userEvent.click(screen.getByRole('button', { name: 'Footer Add Staff' }));
  const page = await screen.findByRole('region', { name: 'Select staff for Venue Test 1' });
  expect(within(page).getByRole('heading', { name: 'Select Staff' })).toBeInTheDocument();
  const alpha = await within(page).findByRole('checkbox', { name: 'Select Alpha Staff' });
  expect(alpha).toBeChecked();
  expect(alpha).toBeDisabled();
  expect(within(page).queryByText('Suspended Staff')).toBeNull();
  expect(within(page).getByRole('button', { name: 'Confirm' })).toBeDisabled();
  await userEvent.click(within(page).getByRole('checkbox', { name: 'Select Bravo Staff' }));
  expect(within(page).getByText('1 selected · 1 already assigned')).toBeInTheDocument();
  await userEvent.click(within(page).getByRole('button', { name: 'Confirm' }));
  await waitFor(() => expect(mock.post).toHaveBeenCalledWith('/venue-managers/vm-1/staff', { staffProfileIds: ['Bravo'] }));
  expect(await screen.findByText('Assigned Staff · 2')).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Select staff for Venue Test 1' })).toBeNull();
});

it('Cancel on the picker changes nothing', async () => {
  mount();
  await screen.findByText('Assigned Staff · 1');
  await userEvent.click(screen.getByRole('button', { name: 'Footer Add Staff' }));
  const page = await screen.findByRole('region', { name: 'Select staff for Venue Test 1' });
  await userEvent.click(await within(page).findByRole('checkbox', { name: 'Select Bravo Staff' }));
  await userEvent.click(within(page).getByRole('button', { name: 'Cancel' }));
  expect(mock.post).not.toHaveBeenCalled();
  expect(screen.getByText('Assigned Staff · 1')).toBeInTheDocument();
});

it('selecting staff inside the picker does not close the detail panel it was opened from', async () => {
  const closePanel = jest.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <main className="main-content"><div>Workspace</div></main>
      <RightSidePanel open onClose={closePanel}>
        <VenueManagerTeamSection venueManagerId="vm-1" venueManagerName="Venue Test 1" pickerOpen onPickerClose={() => undefined} />
      </RightSidePanel>
    </QueryClientProvider>,
  );
  const page = await screen.findByRole('region', { name: 'Select staff for Venue Test 1' });
  const bravo = await within(page).findByRole('checkbox', { name: 'Select Bravo Staff' });
  await userEvent.click(bravo);
  await userEvent.click(within(page).getByText('Charlie Staff'));
  expect(closePanel).not.toHaveBeenCalled();
  expect(bravo).toBeChecked();
  expect(within(page).getByText('2 selected · 1 already assigned')).toBeInTheDocument();
});

it('Remove asks for confirmation, then deletes only that assignment', async () => {
  mount();
  await userEvent.click(await screen.findByRole('button', { name: 'Remove Alpha Staff' }));
  const confirm = await screen.findByRole('alertdialog');
  expect(confirm).toHaveTextContent('account, shifts, offers and attendance are not changed');
  await userEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(mock.delete).toHaveBeenCalledWith('/venue-managers/vm-1/staff/Alpha'));
  expect(await screen.findByText('Assigned Staff · 0')).toBeInTheDocument();
});

it('a non-owner sees an explained refusal, never a fake empty team', async () => {
  mock.get.mockImplementation(async () => { throw { response: { status: 403 } }; });
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('Only the workspace owner');
  expect(screen.queryByText(/Assigned Staff · /)).toBeNull();
});
