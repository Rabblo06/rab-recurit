import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from '../../shared/api';
import UsersBulkActions, { eligibility, type SelectedRecord, type SelectionKind } from './UsersBulkActions';

jest.mock('../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn(), delete: jest.fn() } }));
const mockApi = api as unknown as { post: jest.Mock; delete: jest.Mock };

const fail = (status: number, message: string) => Promise.reject({ response: { status, data: { message } } });

function Harness({ kind, initial, lifecycle = true, email = true }: { kind: SelectionKind; initial: Array<[string, SelectedRecord]>; lifecycle?: boolean; email?: boolean }) {
  const [selected, setSelected] = useState(new Map(initial));
  return (
    <>
      <output data-testid="selected">{[...selected.keys()].join(',')}</output>
      <UsersBulkActions kind={kind} selected={selected} setSelected={setSelected} permissions={{ lifecycle, email }} />
    </>
  );
}
function mount(node: JSX.Element) {
  return render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);
}
const bar = () => screen.getByRole('toolbar', { name: 'Bulk actions for selected records' });

beforeEach(() => jest.clearAllMocks());

describe('eligibility (preview mirrors the server lifecycle rules)', () => {
  it('never activates or deactivates an unaccepted invitation, and treats staff activation as employment status', () => {
    expect(eligibility('staff', 'activate', { name: 'a', accountStatus: 'invite_expired' })).toEqual({ ok: false, reason: 'invitation not accepted yet' });
    expect(eligibility('venueManager', 'deactivate', { name: 'a', accountStatus: 'invited' }).ok).toBe(false);
    expect(eligibility('staff', 'deactivate', { name: 'a', accountStatus: 'active', employmentStatus: 'active' }).ok).toBe(true);
    expect(eligibility('staff', 'activate', { name: 'a', accountStatus: 'active', employmentStatus: 'inactive' }).ok).toBe(true);
    expect(eligibility('venueManager', 'activate', { name: 'a', accountStatus: 'suspended' }).ok).toBe(true);
    expect(eligibility('venueManager', 'activate', { name: 'a', accountStatus: 'active' })).toEqual({ ok: false, reason: 'already active' });
    // Delete is decided by the server (deletion safety gates + step-up), never pre-filtered.
    expect(eligibility('staff', 'delete', { name: 'a', accountStatus: 'invited' }).ok).toBe(true);
  });
});

describe('UsersBulkActions', () => {
  it('shows only permitted actions, with the reference labels and order', () => {
    mount(<Harness kind="venueManager" initial={[['vm-1', { name: 'VM One', accountStatus: 'active' }]]} />);
    expect(within(bar()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Activate', 'Deactivate', 'Send Email', 'Delete']);
    expect(bar()).toHaveTextContent('Selected: 1');
  });

  it('without lifecycle permission only Send Email is offered (no Delete)', () => {
    mount(<Harness kind="staff" lifecycle={false} initial={[['s-1', { name: 'Staff One', accountStatus: 'active', employmentStatus: 'active' }]]} />);
    expect(within(bar()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Send Email']);
  });

  it('previews who is skipped and why, runs only the eligible records one at a time on their own endpoint, and keeps failures selected', async () => {
    mockApi.post.mockImplementation((url: string) => (url === '/venue-managers/vm-2/deactivate' ? fail(409, 'Account is protected.') : Promise.resolve({ data: {} })));
    mount(<Harness kind="venueManager" initial={[
      ['vm-1', { name: 'VM One', accountStatus: 'active' }],
      ['vm-2', { name: 'VM Two', accountStatus: 'active' }],
      ['vm-3', { name: 'VM Three', accountStatus: 'invite_expired' }],
    ]} />);
    fireEvent.click(within(bar()).getByRole('button', { name: 'Deactivate' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Deactivate accounts' });
    expect(dialog).toHaveTextContent('2 of 3 selected are eligible');
    expect(within(dialog).getByRole('list', { name: 'Skipped records' })).toHaveTextContent('VM Threeinvitation not accepted yet');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Deactivate 2' }));
    await waitFor(() => expect(dialog).toHaveTextContent('1 of 2 deactivated · 1 failed and stay selected'));
    expect(mockApi.post.mock.calls.map(([u]) => u)).toEqual(['/venue-managers/vm-1/deactivate', '/venue-managers/vm-2/deactivate']);
    expect(within(dialog).getByRole('list', { name: 'Results' })).toHaveTextContent('VM TwoAccount is protected.');
    // Succeeded leaves the selection; the failure and the skipped record stay for retry / another action.
    expect(screen.getByTestId('selected').textContent).toBe('vm-2,vm-3');
  });

  it('delete requires the current password, sends it with each request, and stops when the step-up is refused', async () => {
    mockApi.delete.mockImplementationOnce(() => fail(401, 'Current password is incorrect.'));
    mount(<Harness kind="staff" initial={[
      ['s-1', { name: 'Staff One', accountStatus: 'active', employmentStatus: 'active' }],
      ['s-2', { name: 'Staff Two', accountStatus: 'active', employmentStatus: 'active' }],
    ]} />);
    fireEvent.click(within(bar()).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete accounts' });
    const go = within(dialog).getByRole('button', { name: 'Delete 2' });
    expect(go).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Your current password'), { target: { value: 'pw-123' } });
    fireEvent.click(go);
    await waitFor(() => expect(dialog).toHaveTextContent('0 of 2 deleted'));
    expect(mockApi.delete).toHaveBeenCalledTimes(1);
    expect(mockApi.delete).toHaveBeenCalledWith('/staff/s-1', { data: { currentPassword: 'pw-123' } });
    expect(within(dialog).getByRole('list', { name: 'Results' })).toHaveTextContent('Staff TwoNot attempted.');
    expect(screen.getByTestId('selected').textContent).toBe('s-1,s-2');
  });

  it('Send Email hands exactly this roster\'s ids to the existing composer (never another record type)', () => {
    const heard: unknown[] = [];
    const listener = (e: Event) => heard.push((e as CustomEvent).detail);
    document.addEventListener('open-bulk-email', listener);
    mount(<Harness kind="venueManager" initial={[['vm-1', { name: 'VM One', accountStatus: 'active' }], ['vm-2', { name: 'VM Two', accountStatus: 'invited' }]]} />);
    fireEvent.click(within(bar()).getByRole('button', { name: 'Send Email' }));
    document.removeEventListener('open-bulk-email', listener);
    expect(heard).toEqual([{ role: 'venueManager', userIds: ['vm-1', 'vm-2'], names: ['VM One', 'VM Two'] }]);
  });

  it('the X clears the selection only (no request)', () => {
    mount(<Harness kind="staff" initial={[['s-1', { name: 'Staff One', accountStatus: 'active', employmentStatus: 'active' }]]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.getByTestId('selected').textContent).toBe('');
    expect(mockApi.post).not.toHaveBeenCalled();
    expect(mockApi.delete).not.toHaveBeenCalled();
  });
});
