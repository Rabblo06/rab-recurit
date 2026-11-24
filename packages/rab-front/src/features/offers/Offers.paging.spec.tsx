import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import { api } from '../../shared/api';
import Offers from './Offers';

jest.mock('../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn() } }));
const get = api.get as jest.Mock;

beforeEach(() => {
  get.mockReset();
  get.mockImplementation(async (url: string) => {
    if (url === '/auth/me') return { data: { roles: ['manager'] } };
    if (url === '/job-roles') return { data: [] };
    return { data: { data: [], total: url === '/offers' ? 120 : 0 } };
  });
});

const lastOffersParams = () => get.mock.calls.filter(([u]: [string]) => u === '/offers').at(-1)?.[1]?.params;

it('Phase C1: the Staff Offers table requests an explicit page of 50 and its pager reaches page 2', async () => {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><Offers /></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByText('Page 1 of 3')).toBeInTheDocument();
  expect(lastOffersParams()).toMatchObject({ page: 1, limit: 50 });
  await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
  await waitFor(() => expect(lastOffersParams()).toMatchObject({ page: 2, limit: 50 }));
});

it('decision 60: page 1 shows the exact total; a later page answers total null, so the footer says "N of many" and Next follows hasMore', async () => {
  get.mockImplementation(async (url: string, config?: { params?: Record<string, unknown> }) => {
    if (url === '/auth/me') return { data: { roles: ['manager'] } };
    if (url === '/job-roles') return { data: [] };
    if (url !== '/offers') return { data: { data: [], total: 0 } };
    const page = Number(config?.params?.page ?? 1);
    const rows = Array.from({ length: page < 3 ? 50 : 7 }, (_, i) => ({ id: `o${page}-${i}`, status: 'pending', staffName: 'Casey', shiftId: 's', sentAt: new Date().toISOString(), expiresAt: new Date().toISOString() }));
    return { data: { data: rows, total: page === 1 ? 107 : null, hasMore: page < 3 } };
  });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><Offers /></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByText('107 records')).toBeInTheDocument();
  expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
  expect(await screen.findByText('100 of many')).toBeInTheDocument();
  expect(screen.getByText('Page 2')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Next page' })).toBeEnabled();
  await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
  expect(await screen.findByText('107 of many')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
});
