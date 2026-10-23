import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { api } from '../../shared/api';
import Venues from './Venues';

jest.mock('../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn() } }));
jest.mock('../../shared/lib/toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
const mock = api as unknown as Record<'get' | 'post', jest.Mock>;

const venue = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: `Venue ${id}`, clientName: null, type: 'hotel', address: {}, instructions: null, breakPaid: false, status: 'active', archivedAt: null, ...extra,
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><Venues /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  Object.values(mock).forEach((m) => m.mockReset());
  try { localStorage.clear(); } catch { /* ignore */ }
  mock.get.mockImplementation(async (_url: string, opts?: { params?: Record<string, unknown> }) => {
    const p = opts?.params ?? {};
    if (p.status === 'archived') return { data: { data: [venue('B', { status: 'archived', archivedAt: '2026-10-23T00:00:00Z' })], total: 1 } };
    if (p.includeArchived) return { data: { data: [venue('A'), venue('B', { status: 'archived', archivedAt: '2026-10-23T00:00:00Z' })], total: 2 } };
    return { data: { data: [venue('A')], total: 1 } };
  });
  mock.post.mockResolvedValue({ data: {} });
});

it('the landing view is Active: the server default (no status, no includeArchived) is requested', async () => {
  mount();
  expect(await screen.findByText('Venue A')).toBeInTheDocument();
  const params = mock.get.mock.calls[0]![1].params;
  expect(params.status).toBeUndefined();
  expect(params.includeArchived).toBeUndefined();
});

it('"All venues" asks the server to include archived venues (never sends status=all) and marks them', async () => {
  mount();
  await screen.findByText('Venue A');
  await userEvent.click(screen.getAllByRole('button', { name: /All venues/ })[0]!);
  expect(await screen.findByText('Venue B')).toBeInTheDocument();
  const last = mock.get.mock.calls.at(-1)![1].params;
  expect(last).toMatchObject({ includeArchived: true });
  expect(last.status).toBeUndefined();
  const row = screen.getByText('Venue B').closest('tr')!;
  expect(within(row).getByText('Archived')).toBeInTheDocument();
  expect(within(row).getByRole('button', { name: 'Restore Venue B' })).toBeInTheDocument();
});

it('archive asks for confirmation first, then calls the NAMED action (never a status write); cancel sends nothing', async () => {
  mount();
  await screen.findByText('Venue A');
  await userEvent.click(screen.getByRole('button', { name: 'Archive Venue A' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(within(dialog).getByText('Archive venue?')).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(mock.post).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole('button', { name: 'Archive Venue A' }));
  await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Archive' }));
  await waitFor(() => expect(mock.post).toHaveBeenCalledWith('/venues/A/archive'));
  expect(mock.post).toHaveBeenCalledTimes(1);
});
