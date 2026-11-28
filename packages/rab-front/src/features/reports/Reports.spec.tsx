import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { api } from '../../shared/api';
import { toast } from '../../shared/lib/toast';
import Reports from './Reports';

jest.mock('../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn() } }));
jest.mock('../../shared/lib/toast', () => ({ toast: { error: jest.fn(), success: jest.fn(), info: jest.fn(), warning: jest.fn() } }));
const mockApi = api as unknown as { get: jest.Mock; post: jest.Mock };

let capabilities: Record<string, boolean>;
let exportsList: unknown[];

const ready = {
  id: 'e-1', reportKey: 'hours_and_pay_by_venue', periodFrom: '2026-11-01', periodTo: '2026-11-30', venueId: null, payrollRunId: null,
  includePay: true, status: 'ready', errorCode: null, rowCount: 3, createdAt: '2026-11-21T09:00:00Z', readyAt: '2026-11-21T09:00:20Z', fileExpiresAt: '2026-11-22T09:00:20Z',
};

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Reports /></QueryClientProvider>);
}

beforeEach(() => {
  jest.clearAllMocks();
  capabilities = { 'report.view': true, 'report.export': true, 'payroll.view': true };
  exportsList = [];
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/auth/capabilities') return { data: capabilities };
    if (url === '/venues') return { data: { data: [{ id: 'v-1', name: 'Pier Hall' }], total: 1 } };
    if (url === '/payroll/runs') return { data: { periods: [{ period: { id: 'p-1', start: '2026-10-12', end: '2026-10-25' }, run: { id: 'run-1', status: 'finalised' } }, { period: { id: 'p-2', start: '2026-10-26', end: '2026-11-08' }, run: null }] } };
    if (url === '/reports/exports') return { data: { data: exportsList } };
    throw new Error(`unexpected GET ${url}`);
  });
});

it('starts an export naming only the report and its filter (never organisation, scope, pay or status)', async () => {
  mockApi.post.mockResolvedValue({ data: { ...ready, id: 'e-2', status: 'pending' } });
  mount();
  const user = userEvent.setup();
  await screen.findByRole('form', { name: 'New export' });
  await user.selectOptions(await screen.findByLabelText('Venue'), 'v-1');
  const from = screen.getByLabelText('From');
  await user.clear(from);
  await user.type(from, '2026-11-01');
  const to = screen.getByLabelText('To');
  await user.clear(to);
  await user.type(to, '2026-11-30');
  await user.click(screen.getByRole('button', { name: 'Export' }));
  await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
  expect(mockApi.post).toHaveBeenCalledWith('/reports/exports', { reportKey: 'hours_and_pay_by_venue', periodFrom: '2026-11-01', periodTo: '2026-11-30', venueId: 'v-1' });
  const body = mockApi.post.mock.calls[0][1];
  for (const forbidden of ['organisationId', 'workspaceId', 'includePay', 'status', 'scopeKind']) expect(body).not.toHaveProperty(forbidden);
  expect(toast.success).toHaveBeenCalled();
});

it('refuses a period that ends before it starts, without calling the server', async () => {
  mount();
  const user = userEvent.setup();
  await screen.findByRole('form', { name: 'New export' });
  const from = screen.getByLabelText('From');
  await user.clear(from);
  await user.type(from, '2026-12-01');
  const to = screen.getByLabelText('To');
  await user.clear(to);
  await user.type(to, '2026-11-01');
  await user.click(screen.getByRole('button', { name: 'Export' }));
  expect(toast.error).toHaveBeenCalledWith('Choose a period that ends on or after its start.');
  expect(mockApi.post).not.toHaveBeenCalled();
});

it('the payroll run summary takes a run (finalised or prepared runs only), not a period', async () => {
  mockApi.post.mockResolvedValue({ data: { ...ready, id: 'e-3', status: 'pending' } });
  mount();
  const user = userEvent.setup();
  await user.selectOptions(await screen.findByLabelText('Report'), 'payroll_run_summary');
  expect(screen.queryByLabelText('From')).toBeNull();
  const run = await screen.findByLabelText('Payroll run');
  expect(within(run).getAllByRole('option').map((o) => o.textContent)).toEqual(['Choose a run', '2026-10-12 to 2026-10-25 (finalised)']);
  await user.selectOptions(run, 'run-1');
  await user.click(screen.getByRole('button', { name: 'Export' }));
  await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/reports/exports', { reportKey: 'payroll_run_summary', payrollRunId: 'run-1' }));
});

it('without payroll.view the payroll run summary is not offered and runs are never fetched', async () => {
  capabilities = { 'report.view': true, 'report.export': true };
  mount();
  const select = await screen.findByLabelText('Report');
  await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(4));
  expect(within(select).queryByRole('option', { name: 'Payroll run summary' })).toBeNull();
  expect(mockApi.get.mock.calls.map((c) => c[0])).not.toContain('/payroll/runs');
});

it('without report.export there is no export form and no download button (the list still shows)', async () => {
  capabilities = { 'report.view': true };
  exportsList = [ready];
  mount();
  await screen.findByText('Hours and gross pay by venue');
  expect(screen.queryByRole('form', { name: 'New export' })).toBeNull();
  expect(screen.queryByRole('button', { name: /Download/ })).toBeNull();
});

it('download asks for a single-use link, then sends the token in the POST body (never the URL)', async () => {
  exportsList = [ready];
  const createObjectURL = jest.fn(() => 'blob:x');
  Object.assign(URL, { createObjectURL, revokeObjectURL: jest.fn() });
  const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  mockApi.post.mockImplementation(async (url: string) => {
    if (url === '/reports/exports/e-1/link') return { data: { token: 'T'.repeat(43), expiresInSeconds: 60 } };
    if (url === '/reports/exports/e-1/download') return { data: new Blob(['a,b']), headers: { 'content-disposition': 'attachment; filename="hours.csv"' } };
    throw new Error(`unexpected POST ${url}`);
  });
  mount();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Download Hours and gross pay by venue' }));
  await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(2));
  expect(mockApi.post.mock.calls[0][0]).toBe('/reports/exports/e-1/link');
  expect(mockApi.post.mock.calls[1]).toEqual(['/reports/exports/e-1/download', { token: 'T'.repeat(43) }, { responseType: 'blob' }]);
  expect(createObjectURL).toHaveBeenCalled();
  expect(click).toHaveBeenCalled();
  click.mockRestore();
});

it('shows building, failed and deleted exports in plain words; only a ready one can be downloaded', async () => {
  exportsList = [
    { ...ready, id: 'e-p', status: 'pending', readyAt: null, fileExpiresAt: null },
    { ...ready, id: 'e-f', status: 'failed', errorCode: 'too_large', readyAt: null, fileExpiresAt: null },
    { ...ready, id: 'e-x', status: 'expired' },
  ];
  mount();
  expect(await screen.findByText('Building…')).toBeInTheDocument();
  expect(screen.getByText('Failed: Too large. Choose a shorter period or one venue.')).toBeInTheDocument();
  expect(screen.getByText('File deleted')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Download/ })).toBeNull();
});

it('an expired or used link surfaces the server message and reloads the list', async () => {
  exportsList = [ready];
  mockApi.post.mockImplementation(async (url: string) => {
    if (url === '/reports/exports/e-1/link') return { data: { token: 'T'.repeat(43), expiresInSeconds: 60 } };
    throw Object.assign(new Error('Not found'), { isAxiosError: true, response: { status: 404, data: { message: 'This download link has expired or was already used. Ask for a new one.' } } });
  });
  mount();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Download Hours and gross pay by venue' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('This file is no longer available, or its download link expired. Try Download again.'));
  await waitFor(() => expect(mockApi.get.mock.calls.filter((c) => c[0] === '/reports/exports').length).toBeGreaterThanOrEqual(2));
});
