import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ShiftPatternDialog, { patternBody } from './ShiftPatternDialog';
import { api } from '../../shared/api';

jest.mock('../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn() } }));
const get = api.get as jest.Mock;
const post = api.post as jest.Mock;

const row = (key: string, outcome: 'create' | 'skip', reason?: string) => ({
  key,
  venueId: 'venue',
  jobRoleId: 'role',
  startsAt: `${key}T18:00:00.000Z`,
  endsAt: `${key}T23:00:00.000Z`,
  requiredCount: 2,
  outcome,
  ...(reason ? { reason } : {}),
});

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  get.mockImplementation((url: string) => {
    if (url === '/venues') return Promise.resolve({ data: { data: [{ id: 'venue', name: 'Example hall' }], total: 1 } });
    if (url === '/job-roles') return Promise.resolve({ data: [{ id: 'role', name: 'Waiting staff' }, { id: 'old', name: 'Old role', archivedAt: '2026-01-01' }] });
    throw new Error(url);
  });
});

it('the request body carries only the declared fields, weekdays in week order, empty notes left out', () => {
  expect(
    patternBody({ venueId: 'v', jobRoleId: 'r', startDate: '2026-12-01', endDate: '2026-12-31', weekdays: ['Friday', 'Monday'], startTime: '18:00', endTime: '23:00', intervalWeeks: 2, requiredCount: 3, breakMinutes: 15, notes: '  ' }),
  ).toEqual({ venueId: 'v', jobRoleId: 'r', startDate: '2026-12-01', endDate: '2026-12-31', weekdays: ['Monday', 'Friday'], startTime: '18:00', endTime: '23:00', intervalWeeks: 2, requiredCount: 3, breakMinutes: 15 });
});

it('previews the pattern, then creates only the ticked occurrences', async () => {
  post.mockImplementation((url: string, body: { dates?: string[] }) => {
    if (url === '/shifts/pattern/preview') return Promise.resolve({ data: { timezone: 'Europe/London', rows: [row('2026-12-07', 'create'), row('2026-12-11', 'create'), row('2026-12-14', 'skip', 'already_exists')], createCount: 2, skipCount: 1 } });
    if (url === '/shifts/pattern') return Promise.resolve({ data: { timezone: 'Europe/London', rows: [row('2026-12-07', 'create'), row('2026-12-11', 'skip', 'not_selected'), row('2026-12-14', 'skip', 'already_exists')], createCount: 1, skipCount: 2, created: body.dates!.map((key) => ({ key, shiftId: `new-${key}` })), recurrenceGroupId: 'group' } });
    throw new Error(url);
  });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ShiftPatternDialog open defaultStartDate="2026-12-07" onClose={jest.fn()} /></QueryClientProvider>);
  await screen.findByRole('option', { name: 'Example hall' });
  expect(screen.queryByRole('option', { name: 'Old role' })).toBeNull(); // archived roles cannot be chosen
  fireEvent.change(screen.getByRole('combobox', { name: 'Venue' }), { target: { value: 'venue' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Job role' }), { target: { value: 'role' } });
  expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled(); // no weekday yet
  const days = within(screen.getByRole('group', { name: 'Days' }));
  fireEvent.click(days.getByRole('checkbox', { name: 'Fri' }));
  fireEvent.click(days.getByRole('checkbox', { name: 'Mon' }));
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  const table = await screen.findByRole('table', { name: 'Shifts to create' });
  expect(post).toHaveBeenCalledWith('/shifts/pattern/preview', expect.objectContaining({ venueId: 'venue', jobRoleId: 'role', weekdays: ['Monday', 'Friday'] }));
  expect(within(table).getByText('Already scheduled')).toBeInTheDocument();
  fireEvent.click(within(table).getAllByRole('checkbox')[1]!);
  fireEvent.click(screen.getByRole('button', { name: 'Create 1 draft shift' }));
  await waitFor(() => expect(post).toHaveBeenLastCalledWith('/shifts/pattern', expect.objectContaining({ dates: ['2026-12-07'] })));
  expect(await screen.findByRole('table', { name: 'Pattern result' })).toBeInTheDocument();
  expect(screen.getByText('Created as draft')).toBeInTheDocument();
});

it('a server refusal is shown as the server’s message', async () => {
  post.mockRejectedValue({ response: { status: 400, data: { message: 'A pattern can cover at most 92 days.' } } });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ShiftPatternDialog open defaultStartDate="2026-12-07" onClose={jest.fn()} /></QueryClientProvider>);
  await screen.findByRole('option', { name: 'Example hall' });
  fireEvent.change(screen.getByRole('combobox', { name: 'Venue' }), { target: { value: 'venue' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Job role' }), { target: { value: 'role' } });
  fireEvent.click(within(screen.getByRole('group', { name: 'Days' })).getByRole('checkbox', { name: 'Tue' }));
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('A pattern can cover at most 92 days.');
});
