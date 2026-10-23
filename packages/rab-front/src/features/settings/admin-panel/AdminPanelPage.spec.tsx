import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AdminPanelPage from './AdminPanelPage';
import { api } from '../../../shared/api';

jest.mock('../../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn(), patch: jest.fn() } }));
const get = api.get as jest.Mock;

beforeEach(() => {
  get.mockReset().mockImplementation(() => Promise.resolve({ data: {} }));
});

/** Owner correction 2026-10-23 (brief tests 1 and 2): no organisation creation inside the Admin Panel. */
it('the Admin Panel is General | Config | Health — no Organisations tab, no "+ New Organisation", no creation form', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><AdminPanelPage /></QueryClientProvider>);
  expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['General', 'Config', 'Health']);
  expect(screen.queryByText(/Organisations/)).toBeNull();
  expect(screen.queryByRole('button', { name: /new organisation/i })).toBeNull();
  for (const tab of ['Config', 'Health', 'General']) fireEvent.click(screen.getByRole('button', { name: tab }));
  expect(screen.queryByLabelText('Organisation name')).toBeNull();
  expect(get.mock.calls.some(([url]) => String(url).startsWith('/admin/organisations'))).toBe(false);
});
