import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { api } from '../../shared/api';
import { toast } from '../../shared/lib/toast';
import Payroll from './Payroll';
import { addMonths, bulkMessage, calendarWeeks, progress, totals, type PayrollPeriodRow } from './payrollModel';

jest.mock('../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn() } }));
jest.mock('../../shared/lib/toast', () => ({ toast: { error: jest.fn(), success: jest.fn(), info: jest.fn(), warning: jest.fn() } }));

const mockApi = api as unknown as { get: jest.Mock; post: jest.Mock };

const base: PayrollPeriodRow = {
  attendanceId: 'att-1', payrollRecordId: 'rec-1', payrollStatus: 'pending_approval', stage: 'ready', attendanceStatus: 'approved',
  staffProfileId: 'sp-1', staffName: 'Ava Stone', staffRef: 'STF-1', staffEmail: 'ava@example.test', staffStatus: 'active', defaultRatePence: 1337,
  roleName: 'Waiter', venueName: 'The Grand', startsAt: '2026-10-05T09:00:00.000Z', endsAt: '2026-10-05T17:00:00.000Z',
  workedMinutes: 247, payRatePence: 1337, amountPence: 5504, ownHours: false,
  statement: null,
  allocation: { status: 'allocated', payrollPeriod: { id: 'p-1', start: '2026-10-12', end: '2026-10-25' }, payday: '2026-11-04', originalPeriod: null, runId: null, runStatus: null },
};
const row = (over: Partial<PayrollPeriodRow>): PayrollPeriodRow => ({ ...base, ...over });
const noRecord = { payrollRecordId: null, payrollStatus: null, stage: 'in_progress' as const, workedMinutes: null, payRatePence: null, amountPence: null, statement: null, attendanceStatus: 'clocked_out' };

let rows: PayrollPeriodRow[];
let capabilities: Record<string, boolean>;
let periodError: unknown = null;

function fixture(): PayrollPeriodRow[] {
  return [
    row({}),
    row({ attendanceId: 'att-2', ...noRecord, startsAt: '2026-10-06T09:00:00.000Z' }),
    row({ attendanceId: 'att-3', payrollRecordId: 'rec-3', payrollStatus: 'approved', stage: 'completed', staffProfileId: 'sp-2', staffName: 'Ben Hall', startsAt: '2026-10-07T09:00:00.000Z', amountPence: 2400, workedMinutes: 120,
      statement: { state: 'available', fileId: 'file-3', filename: 'approved-shift-statement-ASS-20261007-ABCDEF12.pdf', generatedAt: '2026-10-08T10:00:00.000Z', notifiedAt: '2026-10-08T10:00:00.000Z' } }),
    row({ attendanceId: 'att-4', payrollRecordId: 'rec-4', payrollStatus: 'rejected', stage: 'rejected', staffProfileId: 'sp-2', staffName: 'Ben Hall', startsAt: '2026-10-10T09:00:00.000Z' }),
    row({ attendanceId: 'att-5', ...noRecord, staffProfileId: 'sp-3', staffName: 'Cara Doe', venueName: 'Harbour Hotel', startsAt: '2026-10-12T09:00:00.000Z' }),
  ];
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Payroll initialMonth="2026-10" /></QueryClientProvider>);
}

beforeEach(() => {
  jest.clearAllMocks();
  rows = fixture();
  capabilities = { 'payroll.view': true, 'payroll.approve': true };
  periodError = null;
  mockApi.get.mockImplementation(async (url: string, config?: { params?: Record<string, unknown> }) => {
    if (url === '/auth/capabilities') return { data: capabilities };
    if (url === '/payroll/period') {
      if (periodError) throw periodError;
      return { data: { month: config?.params?.month, timezone: 'Europe/London', rows: config?.params?.month === '2026-10' ? rows : [] } };
    }
    throw new Error(`unexpected GET ${url}`);
  });
});

const recordCards = () => screen.queryAllByRole('article');

describe('payroll model', () => {
  it('progress never reports 100% when nothing is completed', () => {
    expect(progress([row({ ...noRecord }), row({})])).toEqual({ completed: 0, total: 2, percent: 0 });
    expect(progress([])).toEqual({ completed: 0, total: 0, percent: 0 });
    expect(progress([row({ stage: 'completed' }), row({})]).percent).toBe(50);
  });
  it('totals use verified figures only and flag pending ones', () => {
    expect(totals([row({ ...noRecord })])).toEqual({ minutes: null, pence: null, pending: true });
    expect(totals([row({}), row({ ...noRecord })])).toEqual({ minutes: 247, pence: 5504, pending: true });
  });
  it('calendar weeks start on Monday and months roll over years', () => {
    expect(calendarWeeks('2026-10')[0]!.slice(0, 3)).toEqual([null, null, null]); // 1 Oct 2026 is a Thursday
    expect(calendarWeeks('2026-10')[0]![5]).toMatchObject({ day: 3, weekend: true });
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
  });
  it('bulk wording', () => {
    expect(bulkMessage(8, 2)).toBe('8 records approved. 2 require attention.');
    expect(bulkMessage(1, 1)).toBe('1 record approved. 1 requires attention.');
  });
});

describe('Payroll page — calendar view', () => {
  it('shows the loading state, then the header, team and the first staff member', async () => {
    mount();
    expect(screen.getByRole('heading', { name: 'Payroll' })).toBeInTheDocument();
    expect(screen.queryByRole('option')).not.toBeInTheDocument(); // still loading
    expect(await screen.findByRole('option', { name: /Ava Stone/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('5 records')).toBeInTheDocument();
    expect(screen.getAllByText('October 2026').length).toBeGreaterThan(0);
    expect(screen.getByText('3 staff')).toBeInTheDocument();
    expect(mockApi.get).toHaveBeenCalledWith('/payroll/period', { params: { month: '2026-10' } });
  });

  it('shows a neutral error with Retry when the period cannot load', async () => {
    periodError = { isAxiosError: true, response: { status: 500, data: {} } };
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent("Payroll couldn't be loaded. Please try again.");
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('a 404 (e.g. an API without this route yet) never shows the no-workspace copy', async () => {
    periodError = { isAxiosError: true, response: { status: 404, data: { statusCode: 404, message: 'Cannot GET /rest/v1/payroll/period?month=2026-10' } } };
    mount();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Payroll couldn't be loaded. Please try again.");
    expect(alert).not.toHaveTextContent(/workspace/i);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('shows the no-workspace state only when the workspace guard says so', async () => {
    periodError = { isAxiosError: true, response: { status: 403, data: { statusCode: 403, message: 'Complete your Workspace setup before creating this — your account has no private Workspace yet.' } } };
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('No operational workspace is available for your account yet.');
  });

  it('month navigation requests the next month and shows its empty state', async () => {
    mount();
    await screen.findByRole('option', { name: /Ava Stone/ });
    await userEvent.click(screen.getByRole('button', { name: 'Next month' }));
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/payroll/period', { params: { month: '2026-11' } }));
    expect(await screen.findByText('No payroll records for November 2026')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(await screen.findByRole('option', { name: /Ava Stone/ })).toBeInTheDocument();
  });

  it('progress shows the real completed share (0 of 2 = 0%, never 100%)', async () => {
    mount();
    await screen.findByRole('option', { name: /Ava Stone/ });
    const bar = screen.getByRole('progressbar', { name: 'Completed records' });
    expect(bar).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByText('0 of 2 completed (0%)')).toBeInTheDocument();
  });

  it('selecting a staff member updates the summary, calendar and detail panels', async () => {
    mount();
    await userEvent.click(await screen.findByRole('option', { name: /Ben Hall/ }));
    expect(screen.getByRole('option', { name: /Ben Hall/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('1 of 2 completed (50%)')).toBeInTheDocument();
    const details = screen.getByRole('region', { name: 'Staff details' });
    expect(within(details).getByRole('heading', { name: 'Ben Hall' })).toBeInTheDocument();
    expect(within(details).getByRole('button', { name: /Approved Shift Statement/ })).toBeInTheDocument();
    // Cara has no verified figures: em dash and the amber warning.
    await userEvent.click(screen.getByRole('option', { name: /Cara Doe/ }));
    expect(screen.getByText('—', { selector: '.payroll-total-figure' })).toBeInTheDocument();
    expect(screen.getByText('Cara Doe · Hours and amount pending')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Staff details' })).getByRole('note')).toHaveTextContent('Hours and amounts are not yet available for these records.');
    expect(within(screen.getByRole('region', { name: 'Staff details' })).getByText(/October Approved Shift Statement — Not available yet/)).toBeInTheDocument();
  });

  it('staff search filters the team list', async () => {
    mount();
    await screen.findByRole('option', { name: /Ava Stone/ });
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search staff' }), 'car');
    expect(screen.queryByRole('option', { name: /Ava Stone/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Cara Doe/ })).toBeInTheDocument();
  });

  it('"Approve shift payroll" only on a ready record; approval and the generated statement are reported separately', async () => {
    mockApi.post.mockResolvedValue({ data: { id: 'rec-1', statement: { state: 'processing' } } });
    mount();
    await screen.findByRole('option', { name: /Ava Stone/ });
    expect(recordCards()).toHaveLength(1); // 5 Oct
    expect(screen.getByText('Approval releases an Approved Shift Statement to the staff member.')).toBeInTheDocument();
    await userEvent.click(within(recordCards()[0]!).getByRole('button', { name: 'Approve shift payroll' }));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/payroll/records/rec-1/approve'));
    expect(toast.success).toHaveBeenCalledWith('Payroll approved successfully.');
    expect(toast.success).not.toHaveBeenCalledWith('Approved Shift Statement generated.');
    // The refetch after approval shows the document really exists → only now is it announced.
    rows = rows.map((r) => (r.payrollRecordId === 'rec-1' ? { ...r, stage: 'completed', payrollStatus: 'approved', statement: { state: 'available', fileId: 'file-1', filename: 'x.pdf', generatedAt: 'now', notifiedAt: 'now' } } : r));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Approved Shift Statement generated.'), { timeout: 8000 });
    // A day without a payroll record never offers approval.
    await userEvent.click(screen.getByRole('button', { name: /^6 October 2026/ }));
    expect(within(recordCards()[0]!).queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
    expect(within(recordCards()[0]!).getByText('In progress')).toBeInTheDocument();
  }, 15000);

  it('hides approval without payroll.approve', async () => {
    capabilities = { 'payroll.view': true, 'payroll.approve': false };
    mount();
    await screen.findByRole('option', { name: /Ava Stone/ });
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/auth/capabilities'));
    expect(screen.queryByRole('button', { name: 'Approve shift payroll' })).not.toBeInTheDocument();
  });
});

describe('Payroll page — records view', () => {
  async function openRecords() {
    mount();
    await screen.findByRole('option', { name: /Ava Stone/ });
    await userEvent.click(screen.getByRole('tab', { name: 'Records' }));
  }

  it('tab counts, search, sort and the header filter', async () => {
    await openRecords();
    expect(screen.getByRole('tab', { name: 'All records · 5' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'In progress · 3' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Completed · 1' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Completed · 1' }));
    expect(screen.getAllByRole('row')).toHaveLength(2); // header + Ben
    await userEvent.click(screen.getByRole('tab', { name: 'All records · 5' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Search records' }), 'harbour');
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(screen.getByText('1 record · 1 staff')).toBeInTheDocument();
    await userEvent.clear(screen.getByRole('textbox', { name: 'Search records' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Sort records' }), 'date_asc');
    const firstDataRow = screen.getAllByRole('row')[1]!;
    expect(within(firstDataRow).getByText('Ava Stone')).toBeInTheDocument();
    expect(within(firstDataRow).getByText('Mon, 5 Oct 2026')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Filter by status' }), 'rejected');
    await waitFor(() => expect(screen.getByText('1 record · 1 staff')).toBeInTheDocument());
    expect(screen.getByText('Rejected', { selector: 'td .payroll-pill' })).toBeInTheDocument();
  });

  it('bulk approve submits only eligible record ids and reports the rest honestly', async () => {
    mockApi.post.mockResolvedValue({ data: { approved: [{ id: 'rec-1', staffName: 'Ava Stone', statement: { state: 'processing' } }], blocked: [] } });
    await openRecords();
    await userEvent.click(screen.getByLabelText('Select all visible records'));
    const dock = screen.getByRole('toolbar', { name: 'Bulk actions for selected records' });
    expect(within(dock).getByText(/Selected:/)).toBeInTheDocument();
    await userEvent.click(within(dock).getByRole('button', { name: 'Approve shift payroll' }));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/payroll/records/bulk-approve', { ids: ['rec-1'] }));
    expect(toast.warning).toHaveBeenCalledWith('1 record approved. 4 require attention.');
  });

  it('a selection with nothing approvable sends nothing and explains why', async () => {
    await openRecords();
    await userEvent.click(screen.getByLabelText(/Select Cara Doe/));
    await userEvent.click(within(screen.getByRole('toolbar', { name: 'Bulk actions for selected records' })).getByRole('button', { name: 'Approve shift payroll' }));
    expect(mockApi.post).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith("Payroll can't be approved until verified hours and pay are available.");
  });

  it('server-blocked ids are counted in the message', async () => {
    mockApi.post.mockResolvedValue({ data: { approved: [], blocked: [{ id: 'rec-1', reason: 'not_ready', message: 'This payroll record is not ready for approval.' }] } });
    await openRecords();
    await userEvent.click(screen.getByLabelText(/Select Ava Stone 2026-10-05/));
    await userEvent.click(within(screen.getByRole('toolbar', { name: 'Bulk actions for selected records' })).getByRole('button', { name: 'Approve shift payroll' }));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('This payroll record is not ready for approval.'));
  });
});

describe('Payroll page — payroll calendar allocation and statement retry', () => {
  it('records show the payroll period and scheduled payday; unallocated and late approvals are labelled', async () => {
    rows = [
      row({}),
      row({ attendanceId: 'att-9', payrollRecordId: 'rec-9', staffName: 'Dan Late', staffProfileId: 'sp-9', startsAt: '2026-10-08T09:00:00.000Z',
        allocation: { status: 'carried_forward', payrollPeriod: { id: 'p-2', start: '2026-10-26', end: '2026-11-08' }, payday: '2026-11-18', originalPeriod: { id: 'p-0', start: '2026-09-28', end: '2026-10-11' }, runId: null, runStatus: null } }),
      row({ attendanceId: 'att-8', ...noRecord, staffName: 'Eve None', staffProfileId: 'sp-8',
        allocation: { status: 'unallocated', payrollPeriod: null, payday: null, originalPeriod: null, runId: null, runStatus: null } }),
    ];
    mount();
    await screen.findByRole('option', { name: /Ava Stone/ });
    await userEvent.click(screen.getByRole('tab', { name: 'Records' }));
    const ava = screen.getByText('Ava Stone').closest('tr')!;
    expect(within(ava).getByText('4 Nov 2026')).toBeInTheDocument();
    expect(within(ava).getByText('12 Oct 2026 – 25 Oct 2026')).toBeInTheDocument();
    const dan = screen.getByText('Dan Late').closest('tr')!;
    expect(within(dan).getByText('18 Nov 2026')).toBeInTheDocument();
    expect(within(dan).getByText(/· late/)).toBeInTheDocument();
    const eve = screen.getByText('Eve None').closest('tr')!;
    expect(within(eve).getByText('Unallocated — no payroll calendar period')).toBeInTheDocument();
  });

  it('a failed Approved Shift Statement can be retried by an approver (named action, refresh)', async () => {
    rows = [row({ stage: 'completed', payrollStatus: 'approved', statement: { state: 'failed', fileId: null, filename: null, generatedAt: null, notifiedAt: null } })];
    mockApi.post.mockResolvedValue({ data: { id: 'rec-1', statement: { state: 'processing' } } });
    mount();
    await screen.findByRole('option', { name: /Ava Stone/ });
    expect(within(recordCards()[0]!).getByText('The Approved Shift Statement could not be generated.')).toBeInTheDocument();
    await userEvent.click(within(recordCards()[0]!).getByRole('button', { name: 'Retry statement' }));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/payroll/records/rec-1/statement/retry'));
    expect(toast.success).toHaveBeenCalledWith('Approved Shift Statement re-queued.');
  });

  it('the Runs view is reachable from the header', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === '/auth/capabilities') return { data: capabilities };
      if (url === '/payroll/period') return { data: { month: '2026-10', timezone: 'Europe/London', rows } };
      if (url === '/payroll/calendar') return { data: { calendars: [] } };
      if (url === '/payroll/runs') return { data: { periods: [] } };
      throw new Error(`unexpected GET ${url}`);
    });
    mount();
    await screen.findByRole('option', { name: /Ava Stone/ });
    await userEvent.click(screen.getByRole('tab', { name: 'Runs' }));
    expect(await screen.findByText(/No agency payment calendar is configured/)).toBeInTheDocument();
  });
});
