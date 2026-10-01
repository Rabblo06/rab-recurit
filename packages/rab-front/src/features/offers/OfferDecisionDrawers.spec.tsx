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
