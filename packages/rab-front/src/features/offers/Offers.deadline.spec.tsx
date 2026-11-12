import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { CONFIRMATION_DEADLINE_LABELS, CONFIRMATION_DEADLINE_MESSAGES, OFFER_CLOSED_REASON } from '@rab/shared';

import { api } from '../../shared/api';
import { toast } from '../../shared/lib/toast';
import { formatApprovalDeadline } from '../../shared/lib/offerConfirmation';
import Offers from './Offers';

/**
 * Manager-confirmation deadline (owner rule 2026-11-06): the system never confirms; Confirm is offered only while the
 * server says the manager may still confirm, the deadline is the server's, and a withdrawal reads "Not confirmed in
 * time" (never the stored reason code). Missing fields (older API) keep today's behaviour.
 */
jest.mock('../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn() } }));
jest.mock('../../shared/lib/toast', () => ({ toast: { error: jest.fn(), success: jest.fn(), info: jest.fn(), warning: jest.fn() } }));
const get = api.get as jest.Mock;
const post = api.post as jest.Mock;

const DEADLINE = '2030-03-01T17:30:00.000Z';
const base = {
  sentAt: '2030-02-27T09:00:00.000Z', expiresAt: '2030-03-01T09:00:00.000Z', respondedAt: '2030-02-27T10:00:00.000Z',
  declineReason: null, staffAcceptedAt: '2030-02-27T10:00:00.000Z', managerConfirmedAt: null, managerRejectedAt: null,
  rejectionReason: null, estimatedPayPence: 6000, shiftId: 'shift-1', startsAt: '2030-03-01T18:00:00.000Z',
  endsAt: '2030-03-01T23:00:00.000Z', venueName: 'The Grand', roleName: 'Waiter', staffProfileId: 'sp',
};
const mine = { ...base, id: 'o-mine', status: 'staff_accepted', staffName: 'Amelia Mine', offerBatchId: 'b-mine', approvalDeadlineAt: DEADLINE, awaitingManagerConfirmation: true, closedReason: null, canConfirm: true };
const someoneElses = { ...base, id: 'o-other', status: 'staff_accepted', staffName: 'Bilal Other', offerBatchId: 'b-other', approvalDeadlineAt: DEADLINE, awaitingManagerConfirmation: true, closedReason: null, canConfirm: false };
const pastDeadline = { ...base, id: 'o-late', status: 'staff_accepted', staffName: 'Chen Late', offerBatchId: 'b-late', approvalDeadlineAt: DEADLINE, awaitingManagerConfirmation: false, closedReason: OFFER_CLOSED_REASON.CONFIRMATION_DEADLINE_PASSED, canConfirm: false };
const withdrawn = { ...base, id: 'o-gone', status: 'manager_rejected', staffName: 'Dara Withdrawn', offerBatchId: 'b-gone', rejectionReason: 'confirmation_deadline_passed', managerRejectedAt: DEADLINE, approvalDeadlineAt: DEADLINE, awaitingManagerConfirmation: false, closedReason: OFFER_CLOSED_REASON.CONFIRMATION_DEADLINE_PASSED, canConfirm: false };
const legacy = { ...base, id: 'o-legacy', status: 'staff_accepted', staffName: 'Eve Legacy', offerBatchId: 'b-legacy' };
const rejectedByManager = { ...base, id: 'o-rej', status: 'manager_rejected', staffName: 'Finn Rejected', offerBatchId: null, rejectionReason: 'Venue reduced headcount', closedReason: null, awaitingManagerConfirmation: false, canConfirm: false };

let rows: unknown[];
beforeEach(() => {
  get.mockReset();
  post.mockReset();
  (toast.warning as jest.Mock).mockReset();
  (toast.success as jest.Mock).mockReset();
  rows = [mine, someoneElses, pastDeadline, withdrawn, legacy, rejectedByManager];
  get.mockImplementation(async (url: string) => {
    if (url === '/offers') return { data: { data: rows, total: rows.length } };
    return { data: { data: [], total: 0 } };
  });
});

function mount(path = '/offers') {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}><Offers /></MemoryRouter>
    </QueryClientProvider>,
  );
}
const row = async (name: string) => (await screen.findByText(name)).closest('tr') as HTMLElement;

it('shows the server deadline on an accepted offer the manager can confirm, and offers Confirm and Reject', async () => {
  mount();
  const r = await row('Amelia Mine');
  expect(within(r).getByText(`Confirm by ${formatApprovalDeadline(DEADLINE)}`)).toBeInTheDocument();
  expect(within(r).getByTitle('Confirm shift')).toBeInTheDocument();
  expect(within(r).getByTitle('Reject')).toBeInTheDocument();
});

it('hides Confirm and Reject when canConfirm is false (another manager sent it)', async () => {
  mount();
  const r = await row('Bilal Other');
  expect(within(r).queryByTitle('Confirm shift')).toBeNull();
  expect(within(r).queryByTitle('Reject')).toBeNull();
});

it('past the deadline (server projection, Worker not yet run): "Not confirmed in time", no deadline promise, no Confirm', async () => {
  mount();
  const r = await row('Chen Late');
  expect(within(r).getByText(CONFIRMATION_DEADLINE_LABELS.MANAGER_STATE)).toBeInTheDocument();
  expect(within(r).getByText(CONFIRMATION_DEADLINE_LABELS.CONSOLE_DETAIL)).toBeInTheDocument();
  expect(within(r).queryByText(/^Confirm by/)).toBeNull();
  expect(within(r).queryByText(/staff accepted/i)).toBeNull();
  expect(within(r).queryByTitle('Confirm shift')).toBeNull();
});

it('a withdrawn offer reads "Not confirmed in time" with the console detail, never the stored reason code', async () => {
  mount();
  const r = await row('Dara Withdrawn');
  expect(within(r).getByText('Not confirmed in time')).toHaveClass('badge');
  expect(within(r).getByText('Withdrawn — not confirmed before the approval deadline')).toBeInTheDocument();
  expect(within(r).queryByText('confirmation_deadline_passed')).toBeNull();
  expect(within(r).queryByText('manager rejected')).toBeNull();
});

it('an ordinary manager rejection is unchanged', async () => {
  mount();
  const r = await row('Finn Rejected');
  expect(within(r).getByText('manager rejected')).toBeInTheDocument();
  expect(within(r).getByText('Venue reduced headcount')).toBeInTheDocument();
});

it('tolerates an older API without the fields: today\'s Confirm and Reject, and no invented deadline', async () => {
  mount();
  const r = await row('Eve Legacy');
  expect(within(r).getByTitle('Confirm shift')).toBeInTheDocument();
  expect(within(r).getByTitle('Reject')).toBeInTheDocument();
  expect(within(r).queryByText(/^Confirm by/)).toBeNull();
});

it('opening Confirm passes the server deadline fields to the drawer', async () => {
  const opened = jest.fn();
  document.addEventListener('open-offer-confirm', opened);
  mount();
  await userEvent.click(within(await row('Amelia Mine')).getByTitle('Confirm shift'));
  expect(opened).toHaveBeenCalledTimes(1);
  expect((opened.mock.calls[0][0] as CustomEvent).detail.offer).toMatchObject({ id: 'o-mine', approvalDeadlineAt: DEADLINE, canConfirm: true });
  document.removeEventListener('open-offer-confirm', opened);
});

it('Confirm All Accepted counts and confirms only the offers the server still lets this manager confirm', async () => {
  post.mockResolvedValue({ data: { results: [{ ok: true }] } });
  mount('/offers?status=staff_accepted');
  const button = await screen.findByRole('button', { name: 'Confirm All Accepted (2)' });
  await userEvent.click(button);
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  expect(post.mock.calls.map(([url]) => url).sort()).toEqual(['/offers/batches/b-legacy/confirm-all', '/offers/batches/b-mine/confirm-all']);
});

it('confirm-all results refused at the deadline show the server reason', async () => {
  post.mockImplementation(async (url: string) => ({
    data: { results: url.includes('b-mine') ? [{ ok: true }] : [{ ok: false, message: CONFIRMATION_DEADLINE_MESSAGES.CONFIRM }] },
  }));
  mount('/offers?status=staff_accepted');
  await userEvent.click(await screen.findByRole('button', { name: 'Confirm All Accepted (2)' }));
  await waitFor(() => expect(toast.warning).toHaveBeenCalled());
  expect((toast.warning as jest.Mock).mock.calls[0][0]).toBe(`1 of 2 accepted offers confirmed. ${CONFIRMATION_DEADLINE_MESSAGES.CONFIRM}`);
});

it('no Confirm All button when nothing on the page can still be confirmed', async () => {
  rows = [someoneElses, pastDeadline];
  mount('/offers?status=staff_accepted');
  await screen.findByText('Bilal Other');
  expect(screen.queryByRole('button', { name: /Confirm All Accepted/ })).toBeNull();
});
