import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CONFIRMATION_DEADLINE_MESSAGES } from '@rab/shared';

import { api } from '../../shared/api';
import { formatApprovalDeadline } from '../../shared/lib/offerConfirmation';
import BatchOfferDrawer, { batchStatusCounts } from './BatchOfferDrawer';

jest.mock('../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn() } }));
const get = api.get as jest.Mock;
const post = api.post as jest.Mock;

const DEADLINE = '2030-03-01T17:30:00.000Z';
const recipient = (over: Record<string, unknown>) => ({ id: 'r', status: 'pending', staffName: 'Someone', staffProfileId: 'sp', rejectionReason: null, declineReason: null, ...over });
const recipients = [
  recipient({ id: 'mine', staffName: 'Amelia Mine', status: 'staff_accepted', approvalDeadlineAt: DEADLINE, awaitingManagerConfirmation: true, closedReason: null, canConfirm: true }),
  recipient({ id: 'late', staffName: 'Chen Late', status: 'staff_accepted', approvalDeadlineAt: DEADLINE, awaitingManagerConfirmation: false, closedReason: 'confirmation_deadline_passed', canConfirm: false }),
  recipient({ id: 'gone', staffName: 'Dara Withdrawn', status: 'manager_rejected', rejectionReason: 'confirmation_deadline_passed', approvalDeadlineAt: DEADLINE, awaitingManagerConfirmation: false, closedReason: 'confirmation_deadline_passed', canConfirm: false }),
  recipient({ id: 'legacy', staffName: 'Eve Legacy', status: 'staff_accepted' }),
];
const batch = {
  batchId: 'b-1',
  shift: { id: 's', startsAt: '2030-03-01T18:00:00.000Z', endsAt: '2030-03-01T23:00:00.000Z', venueName: 'The Grand', roleName: 'Waiter' },
  counts: { staff_accepted: 3, manager_rejected: 1 },
  recipients,
};

let toasts: Array<{ message: string; variant: string }>;
const onToast = (e: Event) => toasts.push((e as CustomEvent).detail);
beforeEach(() => {
  get.mockReset();
  post.mockReset();
  get.mockImplementation(async (url: string) => (url === '/offers/batches/b-1' ? { data: JSON.parse(JSON.stringify(batch)) } : { data: { items: [] } }));
  toasts = [];
  document.addEventListener('toast', onToast);
});
afterEach(() => document.removeEventListener('toast', onToast));

async function mount() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <BatchOfferDrawer />
    </QueryClientProvider>,
  );
  act(() => { document.dispatchEvent(new CustomEvent('open-offer-batch', { detail: { batchId: 'b-1' } })); });
  await screen.findByText('Amelia Mine');
}
const card = (name: string) => screen.getByText(name).parentElement!.parentElement as HTMLElement;

it('Confirm / Reject only where the server still allows it; deadline shown; withdrawals labelled, never the raw code', async () => {
  await mount();
  const mineCard = card('Amelia Mine');
  expect(within(mineCard).getByRole('button', { name: 'Confirm Amelia Mine' })).toBeInTheDocument();
  expect(within(mineCard).getByText(`Confirm by ${formatApprovalDeadline(DEADLINE)}`)).toBeInTheDocument();

  for (const name of ['Chen Late', 'Dara Withdrawn']) {
    const c = card(name);
    expect(within(c).queryByRole('button', { name: `Confirm ${name}` })).toBeNull();
    expect(within(c).queryByRole('button', { name: `Reject ${name}` })).toBeNull();
    expect(within(c).getByText('Not confirmed in time')).toBeInTheDocument();
    expect(within(c).getByText('Withdrawn — not confirmed before the approval deadline')).toBeInTheDocument();
    expect(within(c).queryByText('confirmation_deadline_passed')).toBeNull();
    expect(within(c).queryByText(/^Confirm by/)).toBeNull();
  }
  // Older API (no fields): unchanged.
  expect(within(card('Eve Legacy')).getByRole('button', { name: 'Confirm Eve Legacy' })).toBeInTheDocument();

  // Chips: the two withdrawals have their own count, and Confirm All counts only what can still be confirmed.
  expect(screen.getByText('Awaiting Confirmation: 2')).toBeInTheDocument();
  expect(screen.getByText('Not confirmed in time: 2')).toBeInTheDocument();
  expect(screen.queryByText(/^Rejected:/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Confirm All Accepted (2)' })).toBeInTheDocument();
});

it('a confirm refused at the deadline shows the server message and refreshes the batch', async () => {
  post.mockRejectedValue({ response: { status: 409, data: { statusCode: 409, code: 'CONFIRMATION_DEADLINE_PASSED', message: CONFIRMATION_DEADLINE_MESSAGES.CONFIRM } } });
  await mount();
  await userEvent.click(screen.getByRole('button', { name: 'Confirm Amelia Mine' }));
  await waitFor(() => expect(toasts).toEqual([expect.objectContaining({ variant: 'error', message: CONFIRMATION_DEADLINE_MESSAGES.CONFIRM })]));
  await waitFor(() => expect(get.mock.calls.filter(([u]) => u === '/offers/batches/b-1').length).toBeGreaterThanOrEqual(2));
});

describe('batchStatusCounts', () => {
  it('moves deadline withdrawals out of their status into their own chip, keeping every other server count', () => {
    expect(batchStatusCounts({ pending: 2, staff_accepted: 3, manager_rejected: 1 }, recipients as never)).toEqual([
      ['pending', 2], ['staff_accepted', 2], ['not_confirmed_in_time', 2],
    ]);
  });
  it('is the server counts unchanged when nothing was withdrawn (or the API is older)', () => {
    expect(batchStatusCounts({ pending: 0, staff_accepted: 1 }, [recipient({ status: 'staff_accepted' })] as never)).toEqual([
      ['pending', 0], ['staff_accepted', 1],
    ]);
  });
});

it('the Worker\'s withdrawal in an offer\'s activity reads "Withdrawn by the system", never "rejected by worker"', async () => {
  get.mockImplementation(async (url: string) => (url === '/offers/batches/b-1'
    ? { data: JSON.parse(JSON.stringify(batch)) }
    : { data: { items: [{ id: 'a1', action: 'offer.rejected_by_worker', actor: null, createdAt: DEADLINE }] } }));
  await mount();
  await userEvent.click(within(card('Dara Withdrawn')).getByTitle('View activity'));
  expect(await screen.findByText(/Withdrawn by the system/)).toBeInTheDocument();
  expect(screen.queryByText(/rejected by worker/)).toBeNull();
});
