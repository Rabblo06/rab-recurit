import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { api } from '../../shared/api';
import { toast } from '../../shared/lib/toast';
import PayrollRunsView, { parseCalendarLines, parsePounds, type RunView } from './PayrollRunsView';

jest.mock('../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn(), put: jest.fn() } }));
jest.mock('../../shared/lib/toast', () => ({ toast: { error: jest.fn(), success: jest.fn(), info: jest.fn(), warning: jest.fn() } }));
const mockApi = api as unknown as { get: jest.Mock; post: jest.Mock; put: jest.Mock };

const period = { id: 'p-1', start: '2026-10-12', end: '2026-10-25', payday: '2026-11-04', note: null, needsConfirmation: false };
const period2 = { id: 'p-2', start: '2026-10-26', end: '2026-11-08', payday: '2026-11-18', note: null, needsConfirmation: false };
let runs: Array<{ period: typeof period; run: { id: string; status: 'prepared' | 'finalised'; records: number; grossPence: number } | null }>;
let runDetail: RunView;
let calendars: unknown[];
let canManage = true;

const ALL = { 'payroll.view': true, 'payroll.calculate': true, 'payroll.approve': true, 'payroll.mark_paid': true };

function mount(capabilities: Record<string, boolean> = ALL) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><PayrollRunsView capabilities={capabilities} /></QueryClientProvider>);
}

beforeEach(() => {
  jest.clearAllMocks();
  canManage = true;
  calendars = [{ id: 'c-1', year: 2026, version: 1, source: 'Adolphus Recruitment Calendar of Payment 2026', notes: 'Guidance only.', periods: [{ ...period, days: 14 }] }];
  runs = [{ period, run: { id: 'run-1', status: 'finalised', records: 2, grossPence: 9000 } }, { period: period2, run: null }];
  runDetail = {
    id: 'run-1', status: 'finalised', period, preparedAt: 'x', preparedByName: 'Manager Test', finalisedAt: 'y', finalisedByName: 'Manager Test',
    totals: { records: 2, staff: 2, minutes: 600, grossPence: 9000, lateCount: 1 },
    staff: [
      { staffProfileId: 'sp-1', staffName: 'Ava Stone', staffRef: 'STF-1', records: 1, minutes: 300, grossPence: 4500, lateCount: 0,
        payslip: { id: 'ps-1', status: 'processing', version: 0, document: null, netPence: null, netSource: null, paidAt: null, paymentReference: null } },
      { staffProfileId: 'sp-2', staffName: 'Ben Hall', staffRef: null, records: 1, minutes: 300, grossPence: 4500, lateCount: 1,
        payslip: { id: 'ps-2', status: 'available', version: 1, document: { fileId: 'f-2', filename: 'p.pdf', version: 1, uploadedAt: 'z' }, netPence: null, netSource: null, paidAt: null, paymentReference: null } },
    ],
  };
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/payroll/calendar') return { data: { calendars, canManage } };
    if (url === '/payroll/runs') return { data: { periods: runs } };
    if (url === '/payroll/runs/run-1') return { data: runDetail };
    throw new Error(`unexpected GET ${url}`);
  });
});

it('money and calendar parsing never use floating point', () => {
  expect(parsePounds('412.5')).toBe(41250);
  expect(parsePounds('£0.07')).toBe(7);
  expect(parsePounds('12.345')).toBeNull();
  expect(parsePounds('-1')).toBeNull();
  expect(parseCalendarLines('2026-02-02,2026-02-16,2026-02-25,Published, irregular\n\n2026-02-17,2026-03-01,2026-03-11'))
    .toEqual([{ start: '2026-02-02', end: '2026-02-16', payday: '2026-02-25', note: 'Published, irregular' }, { start: '2026-02-17', end: '2026-03-01', payday: '2026-03-11' }]);
});

it('lists calendar periods with payday and run status; prepare calls the named action', async () => {
  mockApi.post.mockResolvedValue({ data: { ...runDetail, id: 'run-2', status: 'prepared', totals: { ...runDetail.totals, records: 1, lateCount: 1 } } });
  mount();
  expect(await screen.findByText(/Adolphus Recruitment Calendar of Payment 2026/)).toBeInTheDocument();
  const rows = screen.getAllByRole('row');
  expect(within(rows[1]!).getByText('Finalised')).toBeInTheDocument();
  expect(within(rows[1]!).getByText('4 Nov 2026')).toBeInTheDocument();
  expect(within(rows[2]!).getByText('Not prepared')).toBeInTheDocument();
  expect(within(rows[1]!).queryByRole('button', { name: /Prepare run/ })).not.toBeInTheDocument(); // finalised runs never change
  await userEvent.click(within(rows[2]!).getByRole('button', { name: /Prepare run/ }));
  await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/payroll/runs/prepare', { periodId: 'p-2' }));
  expect(toast.success).toHaveBeenCalledWith('Payroll run prepared: 1 record, 1 late approval.');
});

it('run detail: upload PDF per staff, provider net, and Mark paid only with payroll.mark_paid after confirmation', async () => {
  mockApi.post.mockResolvedValue({ data: runDetail });
  mockApi.put.mockResolvedValue({ data: runDetail });
  mount();
  await userEvent.click(await screen.findByRole('button', { name: /Open run/ }));
  const runCard = await screen.findByRole('region', { name: 'Payroll run' });
  expect(within(runCard).getByText(/1 late approval/)).toBeInTheDocument();
  const file = new File(['%PDF-1.4 test'], 'payslip.pdf', { type: 'application/pdf' });
  await userEvent.upload(within(runCard).getByLabelText('Upload payslip PDF for Ava Stone'), file);
  await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/payroll/runs/run-1/payslips/sp-1/document', expect.any(FormData), expect.objectContaining({ onUploadProgress: expect.any(Function) })));
  // Net only for a payslip with a document (Ben), copied from the provider.
  expect(within(runCard).queryByRole('button', { name: 'Record net pay for Ava Stone' })).not.toBeInTheDocument();
  await userEvent.click(within(runCard).getByRole('button', { name: 'Record net pay for Ben Hall' }));
  await userEvent.type(screen.getByLabelText('Net pay (£, from the provider payslip)'), '412.50');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(mockApi.put).toHaveBeenCalledWith('/payroll/runs/run-1/payslips/sp-2/net', { netPence: 41250 }));
  await userEvent.click(within(runCard).getByRole('button', { name: 'Mark paid Ben Hall' }));
  expect(mockApi.post).not.toHaveBeenCalledWith('/payroll/runs/run-1/payslips/sp-2/mark-paid', {});
  await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Mark paid' }));
  await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/payroll/runs/run-1/payslips/sp-2/mark-paid', {}));
});

it('without payroll.mark_paid / payroll.calculate the actions are not offered', async () => {
  canManage = false;
  mount({ 'payroll.view': true });
  await userEvent.click(await screen.findByRole('button', { name: /Open run/ }));
  const runCard = await screen.findByRole('region', { name: 'Payroll run' });
  expect(within(runCard).queryByRole('button', { name: /Mark paid/ })).not.toBeInTheDocument();
  expect(within(runCard).queryByRole('button', { name: 'Upload PDF' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Import/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Prepare run/ })).not.toBeInTheDocument();
});

it('finalise asks for confirmation first', async () => {
  runDetail = { ...runDetail, status: 'prepared' };
  mockApi.post.mockResolvedValue({ data: { ...runDetail, status: 'finalised' } });
  mount();
  await userEvent.click(await screen.findByRole('button', { name: /Open run/ }));
  await userEvent.click(await screen.findByRole('button', { name: 'Finalise run' }));
  expect(mockApi.post).not.toHaveBeenCalled();
  await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Finalise run' }));
  await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/payroll/runs/run-1/finalise'));
  expect(toast.success).toHaveBeenCalledWith('Payroll run finalised.');
});

it('calendar import: validate shows the report (overlaps block import), then imports', async () => {
  calendars = [];
  mockApi.post.mockImplementation(async (_url: string, body: { dryRun: boolean }) => (body.dryRun
    ? { data: { applied: false, report: { periodCount: 2, errors: [], overlaps: [], gaps: [], nonStandardLengths: [{ start: '2026-02-02', end: '2026-02-16', days: 15 }] } } }
    : { data: { applied: true, report: { periodCount: 2, errors: [], overlaps: [], gaps: [], nonStandardLengths: [] } } }));
  mount();
  expect(await screen.findByText(/No agency payment calendar is configured/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Import calendar' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByRole('button', { name: 'Import' })).toBeDisabled();
  await userEvent.type(within(dialog).getByLabelText('Source'), 'Adolphus 2026');
  await userEvent.type(within(dialog).getByLabelText(/Periods/), '2026-02-02,2026-02-16,2026-02-25{enter}2026-02-17,2026-03-01,2026-03-11');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Validate' }));
  expect(await within(dialog).findByText('2026-02-02 – 2026-02-16: 15 days (not 14)')).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Payment calendar imported.'));
  expect(mockApi.post).toHaveBeenLastCalledWith('/payroll/calendar/import', expect.objectContaining({ dryRun: false, source: 'Adolphus 2026', periods: expect.arrayContaining([{ start: '2026-02-02', end: '2026-02-16', payday: '2026-02-25' }]) }));
});

it('an overlap report keeps Import disabled', async () => {
  calendars = [];
  mockApi.post.mockRejectedValue({ isAxiosError: true, response: { status: 409, data: { message: 'Calendar periods overlap; nothing was imported.', report: { periodCount: 2, errors: [], overlaps: [{ first: 'a', second: 'b' }], gaps: [], nonStandardLengths: [] } } } });
  mount();
  await userEvent.click(await screen.findByRole('button', { name: 'Import calendar' }));
  const dialog = screen.getByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText('Source'), 'X');
  await userEvent.type(within(dialog).getByLabelText(/Periods/), '2026-01-01,2026-01-14,2026-01-20');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Validate' }));
  expect(await within(dialog).findByText('Overlap: a and b')).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Import' })).toBeDisabled();
});

it('calendar import is offered only to the Initial Manager (server canManage), even with payroll.calculate', async () => {
  canManage = false;
  mount();
  expect(await screen.findByText(/Adolphus Recruitment Calendar of Payment 2026/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Import/ })).not.toBeInTheDocument();
  // Mark paid stays available to a manager holding payroll.mark_paid.
  await userEvent.click(screen.getByRole('button', { name: /Open run/ }));
  expect(await screen.findByRole('button', { name: 'Mark paid Ben Hall' })).toBeInTheDocument();
});
