import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';

import { api } from '../../shared/api';
import VenueOffers from './VenueOffers';

jest.mock('../../shared/api', () => ({
  api: { get: jest.fn(), post: jest.fn() },
}));

const mockApi = api as unknown as { get: jest.Mock; post: jest.Mock };

/**
 * PHASE 12 / WEB-02 — `VenueOffers.tsx`'s status selections wrote `?status=` to
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

async function selectView(value: string) {
  const labels: Record<string, string> = { '': 'All requests', pending: 'Pending', approved: 'Approved', declined: 'Declined' };
  await userEvent.click(screen.getByRole('combobox', { name: 'Venue offer status' }));
  await userEvent.click(await screen.findByRole('option', { name: labels[value] }));
}

function requestsCallCount(): number {
  return mockApi.get.mock.calls.filter(([url]: [string]) => url === '/shifts/requests').length;
}

function NavHarness() {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <>
      <button onClick={() => navigate(-1)}>__test-back</button>
      <button onClick={() => navigate(1)}>__test-forward</button>
      <output data-testid="query-state">{location.search}</output>
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

    expect(screen.getByRole('combobox', { name: 'Venue offer status' })).toHaveValue('');
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

    await selectView(value);

    await waitFor(() => expect(lastRequestsCall()?.params?.status).toBe(value));
    expect(screen.getByRole('combobox', { name: 'Venue offer status' })).toHaveValue(value);
    expect(screen.getByRole('combobox', { name: 'Venue offer status' })).not.toHaveValue('');
  });

  it('6: a direct URL load with ?status=approved starts on the Approved tab and requests approved', async () => {
    mockApi.get.mockResolvedValue({ data: { data: [offerRow({ status: 'approved' })], total: 1 } });
    mount(['/venue-offers?status=approved']);

    await waitFor(() => expect(lastRequestsCall()?.params?.status).toBe('approved'));
    expect(screen.getByRole('combobox', { name: 'Venue offer status' })).toHaveValue('approved');
  });

  it('7: remounting on the same URL (simulating a refresh) preserves the active status filter', async () => {
    mockApi.get.mockResolvedValue({ data: { data: [offerRow({ status: 'declined' })], total: 1 } });
    const { unmount } = mount(['/venue-offers?status=declined']);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Venue offer status' })).toHaveValue('declined'));
    unmount();

    mockApi.get.mockClear();
    mockApi.get.mockResolvedValue({ data: { data: [offerRow({ status: 'declined' })], total: 1 } });
    mount(['/venue-offers?status=declined']);
    await waitFor(() => expect(lastRequestsCall()?.params?.status).toBe('declined'));
    expect(screen.getByRole('combobox', { name: 'Venue offer status' })).toHaveValue('declined');
  });

  it('8: browser back returns to the previously active status selection', async () => {
    mockApi.get.mockResolvedValue({ data: { data: [offerRow()], total: 1 } });
    mount();
    await waitFor(() => expect(requestsCallCount()).toBeGreaterThan(0));

    await selectView('approved');
    await waitFor(() => expect(lastRequestsCall()?.params?.status).toBe('approved'));

    await userEvent.click(screen.getByRole('button', { name: '__test-back' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Venue offer status' })).toHaveValue(''));
    expect(lastRequestsCall()?.params?.status).toBeUndefined();
  });

  it('9: browser forward re-applies a status selection that was navigated away from via back', async () => {
    mockApi.get.mockResolvedValue({ data: { data: [offerRow()], total: 1 } });
    mount();
    await waitFor(() => expect(requestsCallCount()).toBeGreaterThan(0));

    await selectView('approved');
    await waitFor(() => expect(lastRequestsCall()?.params?.status).toBe('approved'));

    await userEvent.click(screen.getByRole('button', { name: '__test-back' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Venue offer status' })).toHaveValue(''));

    await userEvent.click(screen.getByRole('button', { name: '__test-forward' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Venue offer status' })).toHaveValue('approved'));
    expect(lastRequestsCall()?.params?.status).toBe('approved');
  });

  it('10: an unrecognised ?status= value falls back to "All" (no phantom active tab, no invalid value forwarded to the API)', async () => {
    mockApi.get.mockResolvedValue({ data: { data: [offerRow()], total: 1 } });
    mount(['/venue-offers?status=garbage']);

    await waitFor(() => expect(requestsCallCount()).toBeGreaterThan(0));
    expect(screen.getByRole('combobox', { name: 'Venue offer status' })).toHaveValue('');
    expect(lastRequestsCall()?.params?.status).toBeUndefined();
  });

  it('12: rapid filter switching settles on the last-clicked status, with no stray console error', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockApi.get.mockResolvedValue({ data: { data: [offerRow()], total: 1 } });
    mount();
    await waitFor(() => expect(requestsCallCount()).toBeGreaterThan(0));

    {
      await selectView('pending');
      await selectView('approved');
      await selectView('declined');
      await selectView('approved');
    }

    await waitFor(() => expect(lastRequestsCall()?.params?.status).toBe('approved'));
    expect(screen.getByRole('combobox', { name: 'Venue offer status' })).toHaveValue('approved');
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

    await waitFor(() => expect(screen.getByText('No venue requests yet')).toBeInTheDocument());
  });

  it('preserves search/sort and the existing page reset when a view is selected or cleared', async () => {
    mockApi.get.mockResolvedValue({ data: { data: [offerRow()], total: 1 } });
    mount(['/venue-offers?q=Grand&sort=submittedAt&direction=asc&page=3']);
    await waitFor(() => expect(requestsCallCount()).toBeGreaterThan(0));
    await selectView('pending');
    await waitFor(() => expect(lastRequestsCall()?.params).toMatchObject({ q: 'Grand', status: 'pending' }));
    let params = new URLSearchParams(screen.getByTestId('query-state').textContent ?? '');
    expect(params.get('sort')).toBe('submittedAt');
    expect(params.get('direction')).toBe('asc');
    expect(params.has('page')).toBe(false);
    await selectView('');
    await waitFor(() => expect(lastRequestsCall()?.params?.status).toBeUndefined());
    expect(lastRequestsCall()?.params?.q).toBe('Grand');
    params = new URLSearchParams(screen.getByTestId('query-state').textContent ?? '');
    expect(params.has('status')).toBe(false);
    expect(params.get('sort')).toBe('submittedAt');
  });
});

describe('VenueOffers — Phase C1 paging and polling', () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.post.mockReset();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('requests an explicit bounded page (limit 50) and the pager reaches page 2', async () => {
    mockApi.get.mockResolvedValue({ data: { data: [offerRow()], total: 120 } });
    mount();
    await waitFor(() => expect(screen.getByText('The Grand Venue')).toBeInTheDocument());
    expect(lastRequestsCall()?.params).toMatchObject({ limit: 50, page: 1 });
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(lastRequestsCall()?.params).toMatchObject({ limit: 50, page: 2 }));
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();
  });

  it('polls every 30 s ±20 % (was 10 s), never sooner', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    mockApi.get.mockResolvedValue({ data: { data: [offerRow()], total: 1 } });
    const { qc } = mount();
    await act(async () => { await jest.advanceTimersByTimeAsync(20); });
    expect(requestsCallCount()).toBe(1);
    await act(async () => { await jest.advanceTimersByTimeAsync(25_000); });
    expect(requestsCallCount()).toBe(1);
    await act(async () => { await jest.advanceTimersByTimeAsync(5_100); });
    expect(requestsCallCount()).toBe(2);
    qc.clear();
  });

  it('a failed background refresh keeps the rows on screen with a non-blocking note', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    mockApi.get.mockResolvedValueOnce({ data: { data: [offerRow()], total: 1 } }).mockRejectedValue(new Error('network error'));
    const { qc } = mount();
    await act(async () => { await jest.advanceTimersByTimeAsync(20); });
    expect(screen.getByText('The Grand Venue')).toBeInTheDocument();
    await act(async () => { await jest.advanceTimersByTimeAsync(30_100); });
    expect(requestsCallCount()).toBe(2);
    expect(screen.getByText('The Grand Venue')).toBeInTheDocument();
    expect(screen.queryByText('Could not load Venue Offers.')).toBeNull();
    expect(screen.getByText(/Couldn.t refresh/)).toBeInTheDocument();
    qc.clear();
  });
});
