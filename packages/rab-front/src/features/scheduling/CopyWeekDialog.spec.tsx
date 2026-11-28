import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CopyWeekDialog from './CopyWeekDialog';
import { api } from '../../shared/api';

jest.mock('../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn() } }));
const get = api.get as jest.Mock;
const post = api.post as jest.Mock;

const row = (key: string, day: number, outcome: 'create' | 'skip', reason?: string) => ({
  key,
  venueId: 'venue',
  jobRoleId: 'role',
  startsAt: new Date(2026, 11, day, 9).toISOString(),
  endsAt: new Date(2026, 11, day, 17).toISOString(),
  requiredCount: 2,
  outcome,
  ...(reason ? { reason } : {}),
});
const previewRows = [row('a', 7, 'create'), row('b', 8, 'create'), row('c', 9, 'skip', 'already_exists')];

function mount(onClose = jest.fn()) {
  get.mockImplementation((url: string) => {
    if (url === '/venues') return Promise.resolve({ data: { data: [{ id: 'venue', name: 'Example hall' }], total: 1 } });
    if (url === '/job-roles') return Promise.resolve({ data: [{ id: 'role', name: 'Waiting staff' }] });
    throw new Error(url);
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CopyWeekDialog open weekStart="2026-12-07" onClose={onClose} />
    </QueryClientProvider>,
  );
  return onClose;
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
});

it('previews the copy, explains skipped rows, and confirms only the rows left ticked', async () => {
  post.mockImplementation((url: string, body: { sourceShiftIds?: string[] }) => {
    if (url === '/shifts/copy-previous-week/preview') return Promise.resolve({ data: { timezone: 'Europe/London', rows: previewRows, createCount: 2, skipCount: 1 } });
    if (url === '/shifts/copy-previous-week') {
      return Promise.resolve({
        data: {
          timezone: 'Europe/London',
          rows: [row('a', 7, 'create'), row('b', 8, 'skip', 'not_selected'), row('c', 9, 'skip', 'already_exists')],
          createCount: 1,
          skipCount: 2,
          created: body.sourceShiftIds!.map((key) => ({ key, shiftId: `new-${key}` })),
        },
      });
    }
    throw new Error(url);
  });
  mount();
  const table = await screen.findByRole('table', { name: 'Shifts to copy' });
  expect(post).toHaveBeenCalledWith('/shifts/copy-previous-week/preview', { weekStart: '2026-12-07' });
  expect(within(table).getByText('Already scheduled')).toBeInTheDocument();
  expect(within(table).getAllByRole('checkbox')).toHaveLength(2); // a skipped row cannot be ticked
  expect(screen.getByRole('button', { name: 'Create 2 draft shifts' })).toBeEnabled();

  fireEvent.click(within(table).getAllByRole('checkbox')[1]!);
  fireEvent.click(screen.getByRole('button', { name: 'Create 1 draft shift' }));
  await waitFor(() => expect(post).toHaveBeenCalledWith('/shifts/copy-previous-week', { weekStart: '2026-12-07', sourceShiftIds: ['a'] }));
  const result = await screen.findByRole('table', { name: 'Copy result' });
  expect(within(result).getByText('Created as draft')).toBeInTheDocument();
  expect(within(result).getByText('Not selected')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
});

it('choosing a venue re-previews that venue only; a 403 is shown as a permission message, never as an empty week', async () => {
  post.mockImplementation((_url: string, body: { venueId?: string }) =>
    body.venueId ? Promise.reject({ response: { status: 403, data: { message: 'Creating shifts is not permitted.' } } }) : Promise.resolve({ data: { timezone: 'Europe/London', rows: [], createCount: 0, skipCount: 0 } }),
  );
  mount();
  expect(await screen.findByText('There are no shifts to copy from last week.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Create 0 draft shifts' })).toBeDisabled();
  await screen.findByRole('option', { name: 'Example hall' });
  fireEvent.change(screen.getByRole('combobox', { name: 'Venue' }), { target: { value: 'venue' } });
  expect(await screen.findByRole('alert')).toHaveTextContent('You don’t have permission to create shifts.');
  expect(post).toHaveBeenLastCalledWith('/shifts/copy-previous-week/preview', { weekStart: '2026-12-07', venueId: 'venue' });
});
