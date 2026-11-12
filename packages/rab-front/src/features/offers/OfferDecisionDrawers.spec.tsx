import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { api } from '../../shared/api';
import OfferDecisionDrawers from './OfferDecisionDrawers';

jest.mock('../../shared/api', () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const mockApi = api as unknown as { get: jest.Mock; post: jest.Mock; patch: jest.Mock; delete: jest.Mock };

const offer = {
  id: 'offer-1',
  staffName: 'Amelia Foster',
  venueName: 'The Grand Hotel',
  startsAt: '2026-01-10T18:00:00.000Z',
  endsAt: '2026-01-10T23:00:00.000Z',
};

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <OfferDecisionDrawers />
    </QueryClientProvider>,
  );
}

const openConfirm = () => act(() => {
  document.dispatchEvent(new CustomEvent('open-offer-confirm', { detail: { offer } }));
});

beforeEach(() => {
  Object.values(mockApi).forEach((m) => m.mockReset());
});

// TEST 4 / TEST 16 (Part 2): the fix was moving this drawer out of
// `Offers.tsx`'s own `.page` div (a `flex-direction: column` container,
// which broke `RightSidePanel`'s right-edge docking) into this globally
// mounted component — the same structural shape `BatchOfferDrawer` already
// used. Asserting it renders through the shared `.side-panel`/`.side-panel-dock`
// markup (not a bespoke modal) is what proves it uses the standard,
// correctly-docked component rather than a one-off replacement.
describe('OfferDecisionDrawers — Confirm shift? (Part 2, TEST 4)', () => {
  it('opens using the shared side-panel drawer, not a bespoke modal', async () => {
    mount();
    openConfirm();

    await screen.findByText('Confirm shift?');
    expect(document.querySelector('.side-panel-dock')).toBeTruthy();
    expect(document.querySelector('.side-panel')).toBeTruthy();
    expect(screen.getByText(/Amelia Foster/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Confirm shift/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('confirms the offer and closes', async () => {
    mockApi.post.mockResolvedValue({ data: {} });
    mount();
    openConfirm();
    await screen.findByText('Confirm shift?');

    await userEvent.click(screen.getByRole('button', { name: /Confirm shift/ }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/offers/offer-1/confirm'));
    await waitFor(() => expect(screen.queryByText('Confirm shift?')).not.toBeInTheDocument());
  });
});

describe('OfferDecisionDrawers — manager-confirmation deadline', () => {
  const DEADLINE = '2026-01-10T17:30:00.000Z';
  const deadlineOffer = { ...offer, status: 'staff_accepted', approvalDeadlineAt: DEADLINE, awaitingManagerConfirmation: true, closedReason: null, canConfirm: true };
  const open = (o: object, event = 'open-offer-confirm') => act(() => {
    document.dispatchEvent(new CustomEvent(event, { detail: { offer: o } }));
  });
  const deadline409 = {
    response: { status: 409, data: { statusCode: 409, code: 'CONFIRMATION_DEADLINE_PASSED', message: 'The manager-confirmation deadline has passed, so this acceptance can no longer be confirmed.' } },
  };
  let toasts: Array<{ message: string; variant: string; persistent?: boolean }>;
  const onToast = (e: Event) => toasts.push((e as CustomEvent).detail);
  beforeEach(() => { toasts = []; document.addEventListener('toast', onToast); });
  afterEach(() => document.removeEventListener('toast', onToast));

  it('shows the server deadline in local time with its zone, and says it is never confirmed automatically', async () => {
    const { formatApprovalDeadline } = await import('../../shared/lib/offerConfirmation');
    mount();
    open(deadlineOffer);
    await screen.findByText('Confirm shift?');
    const line = document.querySelector('.offer-confirm-deadline') as HTMLElement;
    expect(line).toHaveTextContent(`Confirm by ${formatApprovalDeadline(DEADLINE)}`);
    expect(line).toHaveTextContent('never confirmed automatically');
    expect(screen.queryByText(/will be confirmed automatically/i)).toBeNull();
  });

  it('a 409 CONFIRMATION_DEADLINE_PASSED closes the drawer, shows the server message and refreshes the lists', async () => {
    mockApi.post.mockRejectedValue(deadline409);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const invalidate = jest.spyOn(qc, 'invalidateQueries');
    render(<QueryClientProvider client={qc}><OfferDecisionDrawers /></QueryClientProvider>);
    open(deadlineOffer);
    await screen.findByText('Confirm shift?');
    await userEvent.click(screen.getByRole('button', { name: /Confirm shift/ }));
    await waitFor(() => expect(screen.queryByText('Confirm shift?')).not.toBeInTheDocument());
    expect(toasts).toEqual([expect.objectContaining({ variant: 'error', persistent: true, message: deadline409.response.data.message })]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['offers'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['shifts'] });
    expect(mockApi.post).toHaveBeenCalledTimes(1);
  });

  it('any other refusal stays inline in the open drawer, as before', async () => {
    mockApi.post.mockRejectedValue({ response: { status: 409, data: { statusCode: 409, message: 'This shift is already full.' } } });
    mount();
    open(deadlineOffer);
    await screen.findByText('Confirm shift?');
    await userEvent.click(screen.getByRole('button', { name: /Confirm shift/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This shift is already full.');
    expect(screen.getByText('Confirm shift?')).toBeInTheDocument();
    expect(toasts).toEqual([]);
  });

  it('never sends a confirm for an offer the server says can no longer be confirmed', async () => {
    mount();
    open({ ...deadlineOffer, awaitingManagerConfirmation: false, closedReason: 'confirmation_deadline_passed', canConfirm: false });
    await screen.findByText('Confirm shift?');
    const button = screen.getByRole('button', { name: /Confirm shift/ });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('a reject refused at the deadline closes the reject drawer with the server message', async () => {
    mockApi.post.mockRejectedValue(deadline409);
    mount();
    open(deadlineOffer, 'open-offer-reject');
    await screen.findByText('Reject accepted offer?');
    await userEvent.click(screen.getByRole('button', { name: 'Reject offer' }));
    await waitFor(() => expect(screen.queryByText('Reject accepted offer?')).not.toBeInTheDocument());
    expect(toasts).toEqual([expect.objectContaining({ variant: 'error', message: deadline409.response.data.message })]);
  });
});
