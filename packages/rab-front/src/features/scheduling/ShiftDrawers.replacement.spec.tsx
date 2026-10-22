import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../../shared/api';
import { toast } from '../../shared/lib/toast';
import ShiftDrawers, { positionsLine } from './ShiftDrawers';

/**
 * "+ Send offer" on a shift's pipeline opens the EXISTING Send offers drawer in replacement mode
 * (`open-send-offer` `{ shiftId, mode: 'replacement', shift? }`): the original shift's details come from
 * `GET /shifts/:id/replacement-context`, read-only; only the staff selection is editable; Send calls the existing-shift
 * endpoint (`POST /shifts/:id/offers/bulk`, `mode: 'replacement'`), never shift creation.
 */
jest.mock('../../shared/api', () => ({ api: { get: jest.fn(), put: jest.fn(), post: jest.fn(), delete: jest.fn() } }));
jest.mock('../../shared/lib/toast', () => ({ toast: { error: jest.fn(), success: jest.fn(), info: jest.fn(), warning: jest.fn() } }));
const mock = api as unknown as Record<'get' | 'put' | 'post' | 'delete', jest.Mock>;

const staffRow = (id: string) => ({
  id, firstName: id, lastName: 'Staff', email: `${id.toLowerCase()}@example.test`, staffRef: `REF-${id}`, phone: null,
  defaultPayRatePence: null, accountStatus: 'active', employmentStatus: 'active', createdAt: '2026-09-01T00:00:00Z',
});
const STAFF = ['Alpha', 'Bravo'].map(staffRow);

const CONTEXT = {
  shift: {
    id: 'shift-7', venueId: 'venue-1', jobRoleId: 'role-1', venueName: 'The Grand Hall', roleName: 'Bartender',
    address: '1 Original Street, London', startsAt: '2026-10-21T17:00:00Z', endsAt: '2026-10-21T23:30:00Z',
    breakMinutes: 30, payRatePence: 1450, notes: 'Black tie', status: 'in_progress',
  },
  vacancy: { requiredCount: 4, occupied: 3, confirmedNoShows: 1, provisionalNoShows: 0, vacancy: 1 },
  offerKind: 'replacement',
  canSend: true,
  blockedReason: null,
};

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><main className="main-content"><div>Existing workspace</div></main><ShiftDrawers /></QueryClientProvider>);
}

const openReplacement = (detail: object = { shiftId: 'shift-7', mode: 'replacement' }) =>
  act(() => { document.dispatchEvent(new CustomEvent('open-send-offer', { detail })); });

async function pickAlpha() {
  await userEvent.click(await screen.findByRole('button', { name: /Select staff/ }));
  await userEvent.click(await screen.findByRole('checkbox', { name: 'Select Alpha Staff' }));
  await userEvent.click(within(screen.getByRole('region', { name: 'Select staff for this shift' })).getByRole('button', { name: 'Confirm' }));
}

beforeEach(() => {
  Object.values(mock).forEach((m) => m.mockReset());
  (Object.values(toast) as jest.Mock[]).forEach((m) => m.mockReset?.());
  mock.get.mockImplementation(async (url: string) => {
    if (url === '/shifts/shift-7/replacement-context') return { data: CONTEXT };
    if (url === '/staff') return { data: { data: STAFF, total: STAFF.length } };
    return { data: [] };
  });
});

it('opens as "Send replacement offer", prefilled read-only from the ORIGINAL shift, with real context lines', async () => {
  mount();
  openReplacement();
  expect(await screen.findByText('Replacement for The Grand Hall')).toBeInTheDocument();
  expect(screen.getByText('Send replacement offer')).toBeInTheDocument();
  expect(mock.get).toHaveBeenCalledWith('/shifts/shift-7/replacement-context');
  expect(screen.getByText('1 position requires replacement')).toBeInTheDocument();
  const original = screen.getByText(/^Original shift:/);
  expect(original.textContent).toMatch(/21 October · \d\d:\d\d–\d\d:\d\d/);

  const fields: Array<[string, string]> = [
    ['Venue', 'The Grand Hall'], ['Role', 'Bartender'], ['Address', '1 Original Street, London'],
    ['Break (minutes)', '30'], ['Pay rate (£/hr)', '£14.50'], ['Notes', 'Black tie'],
  ];
  for (const [label, value] of fields) {
    const input = screen.getByLabelText(label);
    expect(input).toHaveValue(value);
    expect(input).toHaveAttribute('readonly');
  }
  for (const label of ['Date', 'Start time', 'End time']) expect(screen.getByLabelText(label)).toHaveAttribute('readonly');
  expect(screen.getByText('0 staff selected')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Send offer/ })).toBeDisabled();
});

it('Send offer calls the EXISTING-shift endpoint with mode replacement (never shift creation) and toasts only on server success', async () => {
  const sent = jest.fn();
  document.addEventListener('offers-sent', sent);
  mock.post.mockResolvedValue({ data: { batchId: 'b1', shiftId: 'shift-7', offerKind: 'replacement', results: [{ staffProfileId: 'Alpha', ok: true, offerId: 'o1' }] } });
  mount();
  openReplacement({ shiftId: 'shift-7', mode: 'replacement', shift: { id: 'shift-7' } });
  await screen.findByText('Replacement for The Grand Hall');
  await pickAlpha();
  expect(screen.getByText('1 staff selected')).toBeInTheDocument();
  expect(toast.success).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: /Send offer/ }));
  await waitFor(() => expect(mock.post).toHaveBeenCalledTimes(1));
  const [url, body] = mock.post.mock.calls[0]!;
  expect(url).toBe('/shifts/shift-7/offers/bulk');
  expect(url).not.toBe('/shifts/with-offers');
  expect(body).toEqual({ staffProfileIds: ['Alpha'], mode: 'replacement', acknowledgedAvailabilityConflicts: undefined });
  // No inherited field is ever sent: the shift cannot be modified from this form.
  expect(Object.keys(body)).not.toEqual(expect.arrayContaining(['venueId', 'startsAt', 'payRatePence', 'notes']));
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Replacement offer sent successfully.'));
  expect(sent).toHaveBeenCalledTimes(1);
  expect((sent.mock.calls[0]![0] as CustomEvent).detail).toEqual({ shiftId: 'shift-7' });
  await waitFor(() => expect(screen.queryByText('Replacement for The Grand Hall')).toBeNull());
  document.removeEventListener('offers-sent', sent);
});

it('a server failure shows the server message as an error toast and never a success toast', async () => {
  mock.post.mockRejectedValue({ isAxiosError: true, response: { status: 409, data: { message: 'This shift has ended, so no replacement offers can be sent.' } } });
  mount();
  openReplacement();
  await screen.findByText('Replacement for The Grand Hall');
  await pickAlpha();
  await userEvent.click(screen.getByRole('button', { name: /Send offer/ }));
  await waitFor(() => expect(toast.error).toHaveBeenCalled());
  expect(toast.success).not.toHaveBeenCalled();
  expect(screen.getByText('Replacement for The Grand Hall')).toBeInTheDocument();
});

it('every recipient refused by the server (e.g. already offered) → no success toast, the per-staff reason is shown', async () => {
  mock.post.mockResolvedValue({ data: { batchId: 'b1', shiftId: 'shift-7', offerKind: 'replacement', results: [{ staffProfileId: 'Alpha', ok: false, message: 'This staff member has already been offered this shift.' }] } });
  mount();
  openReplacement();
  await screen.findByText('Replacement for The Grand Hall');
  await pickAlpha();
  await userEvent.click(screen.getByRole('button', { name: /Send offer/ }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('This staff member has already been offered this shift.'));
  expect(toast.success).not.toHaveBeenCalled();
  expect(screen.getByRole('alert', { name: '' })).toHaveTextContent(/already been offered/);
});

it('no vacant seat → standby wording; a blocked shift disables Send and shows the server reason', async () => {
  expect(positionsLine(0)).toBe('No position is vacant — offers will be sent as standby');
  expect(positionsLine(2)).toBe('2 positions require replacement');
  mock.get.mockImplementation(async (url: string) => {
    if (url === '/shifts/shift-7/replacement-context') return { data: { ...CONTEXT, canSend: false, blockedReason: 'This shift has ended, so no replacement offers can be sent.', vacancy: { ...CONTEXT.vacancy, vacancy: 0 }, offerKind: 'standby' } };
    if (url === '/staff') return { data: { data: STAFF, total: STAFF.length } };
    return { data: [] };
  });
  mount();
  openReplacement();
  expect(await screen.findByText('No position is vacant — offers will be sent as standby')).toBeInTheDocument();
  expect(screen.getByText('This shift has ended, so no replacement offers can be sent.')).toBeInTheDocument();
  await pickAlpha();
  expect(screen.getByRole('button', { name: /Send offer/ })).toBeDisabled();
});

it('normal mode is unchanged: open-send-offer with { shift } is still the plain "Send offer" drawer and never loads replacement context', async () => {
  mock.post.mockResolvedValue({ data: { batchId: 'b1', results: [{ staffProfileId: 'Alpha', ok: true }] } });
  mount();
  const shift = { id: 'shift-9', venueId: 'venue-1', jobRoleId: 'role-1', startsAt: '2026-10-20T10:00:00Z', endsAt: '2026-10-20T18:00:00Z', requiredCount: 3, filledCount: 0, status: 'open' };
  act(() => { document.dispatchEvent(new CustomEvent('open-send-offer', { detail: { shift } })); });
  await pickAlpha();
  expect(screen.queryByText('Send replacement offer')).toBeNull();
  await userEvent.click(await screen.findByRole('button', { name: /^Send offer$/ }));
  await waitFor(() => expect(mock.post).toHaveBeenCalled());
  const [url, body] = mock.post.mock.calls[0]!;
  expect(url).toBe('/shifts/shift-9/offers/bulk');
  expect(body).not.toHaveProperty('mode');
  expect(mock.get).not.toHaveBeenCalledWith(expect.stringContaining('replacement-context'));
  expect(toast.success).not.toHaveBeenCalledWith('Replacement offer sent successfully.');
});
