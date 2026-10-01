import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useNavigate } from 'react-router-dom';

import { api } from '../../shared/api';
import VenueOffers from './VenueOffers';

jest.mock('../../shared/api', () => ({
  api: { get: jest.fn(), post: jest.fn() },
}));

const mockApi = api as unknown as { get: jest.Mock; post: jest.Mock };

/**
 * PHASE 12 / WEB-02 — `VenueOffers.tsx`'s status tabs wrote `?status=` to
 * the URL correctly, but `VENUE_OFFERS_TABLE_CONFIG.filters` was `[]`, so
 * `useTableQueryState`'s read-side `filters` object never reflected that
 * param back (see `useTableQueryState.ts`'s `filterParamKeys` — it only
 * ever reads keys declared in `config.filters`). The tab, the URL, the API
 * request, and the rendered results could all disagree. These tests prove
 * the fix (declaring `status` in `config.filters`) holds across every state
 * a real query/URL/history combination can be in.
 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function offerRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'o1',
    status: 'pending_manager_approval',
    displayStatus: 'Pending',
    startsAt: new Date().toISOString(),
    endsAt: new Date(Date.now() + 3600_000).toISOString(),
    requiredCount: 2,
    selectedCount: 1,
    payRatePence: 1500,
    notes: null,
    submittedAt: new Date().toISOString(),
    venueName: 'The Grand Venue',
    roleName: 'Bartender',
    venueManagerName: 'Vera Manager',
    ...overrides,
  };
}

function lastRequestsCall(): { params?: { q?: string; status?: string } } | undefined {
  const calls = mockApi.get.mock.calls.filter(([url]: [string]) => url === '/shifts/requests');
  const last = calls[calls.length - 1];
  return last ? last[1] : undefined;
}

function requestsCallCount(): number {
  return mockApi.get.mock.calls.filter(([url]: [string]) => url === '/shifts/requests').length;
}

function NavHarness() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate(-1)}>__test-back</button>
      <button onClick={() => navigate(1)}>__test-forward</button>
      <VenueOffers />
    </>
  );
}

function mount(initialEntries: string[] = ['/venue-offers']) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>
        <NavHarness />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { qc, ...utils };
}

describe('VenueOffers — WEB-02 status filter regression', () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.post.mockReset();
  });

  it('11: no status in the URL defaults to the "All" tab active and no status sent to the API', async () => {
    mockApi.get.mockResolvedValue({ data: { data: [offerRow()], total: 1 } });
    mount();
    await waitFor(() => expect(screen.getByText('The Grand Venue')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: 'All' })).toHaveClass('active');
    expect(lastRequestsCall()?.params?.status).toBeUndefined();
  });

  it.each([
    ['Pending', 'pending'],
    ['Approved', 'approved'],
    ['Declined', 'declined'],
  ])('1-5: clicking the %s tab updates the URL, activates the tab, and requests exactly that status', async (label, value) => {
    mockApi.get.mockResolvedValue({ data: { data: [offerRow({ status: value })], total: 1 } });
    mount();
    await waitFor(() => expect(requestsCallCount()).toBeGreaterThan(0));

    await userEvent.click(screen.getByRole('button', { name: label }));

    await waitFor(() => expect(lastRequestsCall()?.params?.status).toBe(value));
    expect(screen.getByRole('button', { name: label })).toHaveClass('active');
    expect(screen.getByRole('button', { name: 'All' })).not.toHaveClass('active');
  });

  it('6: a direct URL load with ?status=approved starts on the Approved tab and requests approved', async () => {
    mockApi.get.mockResolvedValue({ data: { data: [offerRow({ status: 'approved' })], total: 1 } });
    mount(['/venue-offers?status=approved']);

    await waitFor(() => expect(lastRequestsCall()?.params?.status).toBe('approved'));
    expect(screen.getByRole('button', { name: 'Approved' })).toHaveClass('active');
  });

  it('7: remounting on the same URL (simulating a refresh) preserves the active status filter', async () => {
    mockApi.get.mockResolvedValue({ data: { data: [offerRow({ status: 'declined' })], total: 1 } });
    const { unmount } = mount(['/venue-offers?status=declined']);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Declined' })).toHaveClass('active'));
    unmount();

    mockApi.get.mockClear();
    mockApi.get.mockResolvedValue({ data: { data: [offerRow({ status: 'declined' })], total: 1 } });
    mount(['/venue-offers?status=declined']);
    await waitFor(() => expect(lastRequestsCall()?.params?.status).toBe('declined'));
    expect(screen.getByRole('button', { name: 'Declined' })).toHaveClass('active');
  });

  it('8: browser back returns to the previously active status tab', async () => {
    mockApi.get.mockResolvedValue({ data: { data: [offerRow()], total: 1 } });
    mount();
    await waitFor(() => expect(requestsCallCount()).toBeGreaterThan(0));

    await userEvent.click(screen.getByRole('button', { name: 'Approved' }));
    await waitFor(() => expect(lastRequestsCall()?.params?.status).toBe('approved'));

    await userEvent.click(screen.getByRole('button', { name: '__test-back' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'All' })).toHaveClass('active'));
    expect(lastRequestsCall()?.params?.status).toBeUndefined();
  });

  it('9: browser forward re-applies a status tab that was navigated away from via back', async () => {
    mockApi.get.mockResolvedValue({ data: { data: [offerRow()], total: 1 } });
    mount();
    await waitFor(() => expect(requestsCallCount()).toBeGreaterThan(0));

    await userEvent.click(screen.getByRole('button', { name: 'Approved' }));
    await waitFor(() => expect(lastRequestsCall()?.params?.status).toBe('approved'));

    await userEvent.click(screen.getByRole('button', { name: '__test-back' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'All' })).toHaveClass('active'));

    await userEvent.click(screen.getByRole('button', { name: '__test-forward' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approved' })).toHaveClass('active'));
    expect(lastRequestsCall()?.params?.status).toBe('approved');
  });

  it('10: an unrecognised ?status= value falls back to "All" (no phantom active tab, no invalid value forwarded to the API)', async () => {
    mockApi.get.mockResolvedValue({ data: { data: [offerRow()], total: 1 } });
    mount(['/venue-offers?status=garbage']);

    await waitFor(() => expect(requestsCallCount()).toBeGreaterThan(0));
    expect(screen.getByRole('button', { name: 'All' })).toHaveClass('active');
    expect(lastRequestsCall()?.params?.status).toBeUndefined();
  });

  it('12: rapid tab switching settles on the last-clicked status, with no stray console error', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockApi.get.mockResolvedValue({ data: { data: [offerRow()], total: 1 } });
    mount();
    await waitFor(() => expect(requestsCallCount()).toBeGreaterThan(0));

    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Pending' }));
      await userEvent.click(screen.getByRole('button', { name: 'Approved' }));
      await userEvent.click(screen.getByRole('button', { name: 'Declined' }));
      await userEvent.click(screen.getByRole('button', { name: 'Approved' }));
    });

    await waitFor(() => expect(lastRequestsCall()?.params?.status).toBe('approved'));
    expect(screen.getByRole('button', { name: 'Approved' })).toHaveClass('active');
    spy.mockRestore();
  });

  it('13: loading state renders a skeleton while the request is pending, for the selected status', async () => {
    const pending = deferred<{ data: unknown }>();
    mockApi.get.mockReturnValue(pending.promise);
    mount(['/venue-offers?status=pending']);

    expect(document.querySelector('.table-container')).toBeTruthy();
    pending.resolve({ data: { data: [offerRow()], total: 1 } });
    await waitFor(() => expect(screen.getByText('The Grand Venue')).toBeInTheDocument());
  });

  it('14: an API error shows the retry empty-state and retry re-requests the same active status', async () => {
    mockApi.get.mockRejectedValue(new Error('network error'));
    mount(['/venue-offers?status=declined']);

    await waitFor(() => expect(screen.getByText('Could not load Venue Offers.')).toBeInTheDocument());
    expect(lastRequestsCall()?.params?.status).toBe('declined');

    mockApi.get.mockClear();
    mockApi.get.mockResolvedValue({ data: { data: [offerRow({ status: 'declined' })], total: 1 } });
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(lastRequestsCall()?.params?.status).toBe('declined'));
  });

  it('15: an empty result set for a status shows the filtered empty-state, not the generic inbox empty-state', async () => {
    mockApi.get.mockResolvedValue({ data: { data: [], total: 0 } });
    mount(['/venue-offers?status=approved']);

    await waitFor(() => expect(screen.getByText('No results match these filters.')).toBeInTheDocument());
  });

  it('genuinely empty (no filter, no search, zero rows) shows the unfiltered inbox empty-state, not the filtered one', async () => {
    mockApi.get.mockResolvedValue({ data: { data: [], total: 0 } });
    mount();

    await waitFor(() => expect(screen.getByText('No Venue Offer requests yet')).toBeInTheDocument());
  });
});
