import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../../shared/api';
import ShiftTimelinePanel from './ShiftTimelinePanel';

jest.mock('../../shared/api', () => ({ api: { get: jest.fn() } }));
const mock = api as unknown as Record<'get', jest.Mock>;

const item = (id: string, step: string | null, action: string, extra: Record<string, unknown> = {}) => ({
  id, step, action, actor: { fullName: 'Manager Test' }, metadata: {}, createdAt: new Date().toISOString(), ...extra,
});

function mount(shiftId: string | null = 'shift-1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ShiftTimelinePanel shiftId={shiftId} title="Venue · 1 Nov" onClose={() => {}} /></QueryClientProvider>);
}

beforeEach(() => mock.get.mockReset());

it('renders the server lifecycle steps (newest first) and pages older activity with the opaque cursor', async () => {
  mock.get.mockImplementation(async (_url: string, opts: { params: Record<string, unknown> }) =>
    opts.params.cursor
      ? { data: { items: [item('3', 'offer_sent', 'offer.sent'), item('4', 'shift_created', 'shift.created')], nextCursor: null } }
      : { data: { items: [item('1', 'payroll_approved', 'payroll_record.approved'), item('2', 'clock_out', 'attendance.clocked_out', { metadata: { reason: 'Left early' } })], nextCursor: 'CURSOR1' } },
  );
  mount();
  expect(await screen.findByText('Payroll approved')).toBeInTheDocument();
  expect(screen.getByText('Clocked out')).toBeInTheDocument();
  expect(screen.getByText('Left early')).toBeInTheDocument();
  expect(mock.get).toHaveBeenCalledWith('/timeline/shifts/shift-1', { params: { limit: 50 } });
  await userEvent.click(screen.getByRole('button', { name: 'Load older activity' }));
  expect(await screen.findByText('Shift created')).toBeInTheDocument();
  expect(mock.get).toHaveBeenLastCalledWith('/timeline/shifts/shift-1', { params: { limit: 50, cursor: 'CURSOR1' } });
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Load older activity' })).not.toBeInTheDocument());
});

it('an unknown step falls back to the raw action (never an invented label); a closed panel fetches nothing', async () => {
  mock.get.mockResolvedValue({ data: { items: [item('1', null, 'shift.request_staff_added')], nextCursor: null } });
  mount();
  expect(await screen.findByText('shift request staff added')).toBeInTheDocument();
  mock.get.mockClear();
  mount(null);
  expect(mock.get).not.toHaveBeenCalled();
});

it('a refused or failed load shows an unavailable state, not a fake empty lifecycle', async () => {
  mock.get.mockRejectedValue(Object.assign(new Error('Not Found'), { response: { status: 404 } }));
  mount();
  expect(await screen.findByText('Timeline unavailable')).toBeInTheDocument();
});
