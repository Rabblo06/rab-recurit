import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MultiShiftOfferDialog, { readBulkOfferRejection, type OfferableShift } from './MultiShiftOfferDialog';
import { api } from '../../shared/api';

jest.mock('../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn() } }));
const get = api.get as jest.Mock;
const post = api.post as jest.Mock;

const shifts: OfferableShift[] = [
  { id: 's1', startsAt: '2030-01-07T09:00:00Z', endsAt: '2030-01-07T15:00:00Z', status: 'open', venueName: 'Example hall', roleName: 'Waiting staff' },
  { id: 's2', startsAt: '2030-01-08T09:00:00Z', endsAt: '2030-01-08T15:00:00Z', status: 'offered', venueName: 'Example hall', roleName: 'Waiting staff' },
  { id: 's3', startsAt: '2030-01-09T09:00:00Z', endsAt: '2030-01-09T15:00:00Z', status: 'draft', venueName: 'Example hall', roleName: 'Waiting staff' },
];

function mount(onSent = jest.fn()) {
  get.mockResolvedValue({ data: { total: 2, data: [
    { id: 'p1', firstName: 'Casey', lastName: 'Example', accountStatus: 'active', employmentStatus: 'active' },
    { id: 'p2', firstName: 'Robin', lastName: 'Sample', accountStatus: 'active', employmentStatus: 'active' },
  ] } });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MultiShiftOfferDialog open shifts={shifts} onClose={jest.fn()} onSent={onSent} /></QueryClientProvider>);
  return onSent;
}

beforeEach(() => { get.mockReset(); post.mockReset(); });

it('offers every open shift to every picked person in one call; a draft shift is left out and says so', async () => {
  post.mockResolvedValue({ data: { batches: {}, results: [] } });
  const onSent = mount();
  expect(screen.getByRole('heading', { name: 'Offer 2 shifts to staff' })).toBeInTheDocument();
  expect(within(screen.getByRole('list', { name: 'Shifts' })).getByText(/not open for offers \(draft\), left out/)).toBeInTheDocument();
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Casey Example' }));
  const people = within(screen.getByRole('group', { name: 'Staff' }));
  fireEvent.click(people.getByRole('checkbox', { name: 'Robin Sample' }));
  fireEvent.click(screen.getByRole('button', { name: 'Send 4 offers' }));
  await waitFor(() => expect(post).toHaveBeenCalledWith('/offers/send-to-shifts', { items: [{ shiftId: 's1', staffProfileIds: ['p1', 'p2'] }, { shiftId: 's2', staffProfileIds: ['p1', 'p2'] }] }));
  await waitFor(() => expect(onSent).toHaveBeenCalled());
});

it('a refused batch shows that nothing was sent and the reason for every row', async () => {
  post.mockRejectedValue({ response: { status: 409, data: { code: 'BULK_OFFER_REJECTED', message: 'Nothing was sent: 1 of 2 offers could not be sent.', results: [
    { shiftId: 's1', staffProfileId: 'p1', ok: false, message: 'This staff member is not actively employed.' },
    { shiftId: 's2', staffProfileId: 'p1', ok: false, message: 'Not sent: another offer in this batch failed.' },
  ] } } });
  const onSent = mount();
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Casey Example' }));
  fireEvent.click(screen.getByRole('button', { name: 'Send 2 offers' }));
  const table = await screen.findByRole('table', { name: 'Why nothing was sent' });
  expect(screen.getByText('Nothing was sent: 1 of 2 offers could not be sent.')).toBeInTheDocument();
  expect(within(table).getByText('This staff member is not actively employed.')).toBeInTheDocument();
  expect(within(table).getAllByText('Casey Example')).toHaveLength(2);
  expect(onSent).not.toHaveBeenCalled();
});

it('readBulkOfferRejection only reads the multi-shift 409', () => {
  expect(readBulkOfferRejection({ response: { status: 409, data: { code: 'STAFF_AVAILABILITY_CONFLICT', conflicts: [] } } })).toBeNull();
  expect(readBulkOfferRejection({ response: { status: 403, data: {} } })).toBeNull();
});
