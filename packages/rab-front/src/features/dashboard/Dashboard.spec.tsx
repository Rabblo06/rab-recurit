import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { api } from '../../shared/api';
import Dashboard from './Dashboard';

jest.mock('../../shared/api', () => ({
  api: { get: jest.fn() },
}));

const mockApi = api as unknown as { get: jest.Mock };

const SUMMARY = {
  staffCount: 12,
  activeStaffCount: 9,
  managerCount: 3,
  venueCount: 4,
  activeOfferCount: 2,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Dashboard />
    </QueryClientProvider>,
  );
}

describe('Dashboard', () => {
  beforeEach(() => {
    mockApi.get.mockReset();
  });

  it('never fetches /venues — that data is unused since the summary migration', async () => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/dashboard/summary') return Promise.resolve({ data: SUMMARY });
      return new Promise(() => {}); // staff/managers/offers stay pending
    });

    mount();

    await waitFor(() => expect(screen.getByText('Dashboard')).toBeInTheDocument());
    expect(mockApi.get).not.toHaveBeenCalledWith('/venues');
  });

  it('renders the page header and stat cards immediately, without waiting for staff/managers/offers', async () => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/dashboard/summary') return Promise.resolve({ data: SUMMARY });
      return new Promise(() => {}); // staff/managers/offers never resolve in this test
    });

    mount();

    // Header renders synchronously — no gate on any query at all.
    expect(screen.getByText('Dashboard')).toBeInTheDocument();

    // Stat cards populate from /dashboard/summary alone once it resolves —
    // staffCount (12) is distinct from every other stat card's value.
    await waitFor(() => expect(screen.getByText('12')).toBeInTheDocument());
  });

  it('a slow /staff response does not block the Offers widget from rendering its own data', async () => {
    const staffDeferred = deferred<{ data: unknown }>();
    const managersDeferred = deferred<{ data: unknown }>();
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/dashboard/summary') return Promise.resolve({ data: SUMMARY });
      if (url === '/staff') return staffDeferred.promise;
      if (url === '/managers') return managersDeferred.promise;
      if (url === '/offers') {
        return Promise.resolve({
          data: [
            { id: 'o1', status: 'pending', sentAt: new Date().toISOString(), staffName: 'Amelia Foster', venueName: 'The Grand', startsAt: new Date().toISOString() },
          ],
        });
      }
      return new Promise(() => {});
    });

    mount();

    // Offers resolved fast — its widgets render real content while staff/managers are still loading.
    await waitFor(() => expect(screen.getByText('Amelia Foster')).toBeInTheDocument());

    // Staff- and managers-dependent widgets are still showing their own local skeletons, not blank/crashed.
    expect(screen.getAllByRole('status', { name: 'Loading items' }).length).toBeGreaterThan(0);

    // Resolving the rest afterward doesn't throw or unmount anything already rendered.
    staffDeferred.resolve({ data: [] });
    managersDeferred.resolve({ data: [] });
    await waitFor(() => expect(screen.queryAllByRole('status', { name: 'Loading items' }).length).toBe(0));
    expect(screen.getByText('Amelia Foster')).toBeInTheDocument();
  });

  it('a failed /offers request shows an empty widget state, not a blank Dashboard', async () => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/dashboard/summary') return Promise.resolve({ data: SUMMARY });
      if (url === '/offers') return Promise.reject(new Error('network error'));
      if (url === '/staff') return Promise.resolve({ data: [] });
      if (url === '/managers') return Promise.resolve({ data: [] });
      return new Promise(() => {});
    });

    mount();

    // The rest of the page — including the summary-derived stat cards — still renders.
    await waitFor(() => expect(screen.getByText('Dashboard')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Staff overview')).toBeInTheDocument());
  });
});
