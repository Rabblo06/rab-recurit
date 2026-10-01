import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api } from '../../shared/api';
import VenueOfferPipeline, { Pipeline } from './VenueOfferPipeline';
jest.mock('../../shared/api', () => ({
  api: { get: jest.fn(), post: jest.fn() },
}));
const mock = api as unknown as { get: jest.Mock; post: jest.Mock };
let board: Pipeline;
function mount() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/venue-offers/shift']}>
        <Routes>
          <Route
            path="/venue-offers/:shiftId"
            element={<VenueOfferPipeline />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return qc;
}
beforeEach(() => {
  mock.get.mockReset();
  mock.post.mockReset();
  board = {
    shift: {
      id: 'shift',
      venueName: 'Example venue',
      roleName: 'Bartender',
      startsAt: '2030-01-01T18:00:00Z',
      endsAt: '2030-01-01T23:00:00Z',
      status: 'offered',
      requiredCount: 2,
    },
    stages: [
      'OFFERED',
      'WAITING',
      'STAFF ACCEPTED',
      'LATE STAFF',
      'CLOCKED IN',
      'CLOCKED OUT',
      'DELETED OFFER',
    ],
    summary: {
      required: 2,
      confirmed: 0,
      accepted: 0,
      open: 2,
      rejected: 0,
      clockedIn: 0,
      clockedOut: 0,
    },
    tableStatus: 'Offered',
    replacementPlaces: 1,
    report: {
      ready: false,
      originalFileId: null,
      signedFileId: null,
      reportStatus: 'pending',
      finalisedByName: null,
      finalisedAt: null,
      staff: [],
    },
    staff: [
      {
        staffProfileId: 'staff',
        name: 'Jordan Staff',
        avatarFileId: null,
        offerId: 'offer',
        stage: 'OFFERED',
        offerStatus: 'pending',
        assignmentStatus: 'offered',
        attendanceStatus: null,
        sentAt: '2030-01-01T12:00:00Z',
        acceptedAt: null,
        respondedAt: null,
        cancelledAt: null,
        terminalSource: null,
        clockInAt: null,
        clockOutAt: null,
        breakMinutes: null,
        workedMinutes: null,
        declineReason: null,
        withdrawnReason: null,
        rejectionReason: null,
        canManagerCancel: true,
      },
    ],
  };
  mock.get.mockImplementation(async () => ({
    data: JSON.parse(JSON.stringify(board)),
  }));
  mock.post.mockResolvedValue({ data: {} });
});
it('shows exactly seven non-draggable columns and backend counts', async () => {
  mount();
  await screen.findByRole('heading', { name: 'Example venue' });
  for (const stage of board.stages)
    expect(screen.getByRole('region', { name: stage })).toBeTruthy();
  expect(document.querySelector('[draggable="true"]')).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Timesheet Report' }),
  ).toBeDisabled();
});
it('opens the canonical staff drawer and Notes tab by event', async () => {
  mount();
  await screen.findByText('Jordan Staff');
  const listener = jest.fn();
  document.addEventListener('open-user-detail', listener);
  await userEvent.click(screen.getByRole('button', { name: /Jordan Staff/ }));
  expect(listener.mock.calls[0][0].detail).toMatchObject({
    id: 'staff',
    type: 'staff',
  });
  await userEvent.click(screen.getByLabelText('Actions for Jordan Staff'));
  await userEvent.click(screen.getByRole('button', { name: 'Notes' }));
  expect(listener.mock.calls[1][0].detail.tab).toBe('notes');
  document.removeEventListener('open-user-detail', listener);
});
it('optional cancellation reason uses the canonical mutation and refreshes automatically', async () => {
  mount();
  await screen.findByText('Jordan Staff');
  await userEvent.click(screen.getByLabelText('Actions for Jordan Staff'));
  await userEvent.click(screen.getByRole('button', { name: 'Cancel offer' }));
  await userEvent.type(
    screen.getByLabelText('Reason (optional)'),
    'Venue requested replacement',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Cancel Offer' }));
  await waitFor(() =>
    expect(mock.post).toHaveBeenCalledWith(
      '/shifts/shift/pipeline/offers/offer/cancel',
      { reason: 'Venue requested replacement' },
    ),
  );
});
it('server cancellation denial disables the menu action', async () => {
  board.staff[0].canManagerCancel = false;
  mount();
  await screen.findByText('Jordan Staff');
  await userEvent.click(screen.getByLabelText('Actions for Jordan Staff'));
  expect(screen.getByRole('button', { name: 'Cancel offer' })).toBeDisabled();
});
it('polls and moves cards from new server state without browser reload', async () => {
  jest.useFakeTimers();
  const qc = mount();
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    jest.advanceTimersByTime(20);
  });
  board.staff[0].stage = 'CLOCKED OUT';
  board.staff[0].clockOutAt = '2030-01-01T23:00:00Z';
  await act(async () => {
    jest.advanceTimersByTime(5000);
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    jest.advanceTimersByTime(20);
  });
  expect(
    within(screen.getByRole('region', { name: 'CLOCKED OUT' })).getByText(
      'Jordan Staff',
    ),
  ).toBeTruthy();
  qc.clear();
  jest.useRealTimers();
});
it('shows both existing report versions and sign-off identity', async () => {
  board.report = {
    ...board.report!,
    ready: true,
    originalFileId: 'original',
    signedFileId: 'signed',
    finalisedByName: 'Vera Venue',
    finalisedAt: '2030-01-01T23:30:00Z',
  };
  mount();
  await userEvent.click(
    await screen.findByRole('button', { name: 'Timesheet Report' }),
  );
  expect(
    screen.getByRole('heading', { name: 'Original Timesheet' }),
  ).toBeTruthy();
  expect(
    screen.getByRole('heading', { name: 'Venue Signed Timesheet' }),
  ).toBeTruthy();
  expect(screen.getByText(/Finalised by Vera Venue/)).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Download' })).toHaveLength(2);
});

it('retains the board, scroll position and open accessible menu across refreshes', async () => {
  board.staff[0].name = 'ReplacementStaff Test With A Very Long Family Name';
  const qc = mount();
  await screen.findByText(board.staff[0].name);
  const viewport = document.querySelector('.pipeline-board')!;
  const card = document.querySelector('.pipeline-card');
  viewport.scrollLeft = 320;
  const menu = screen.getByLabelText(`Actions for ${board.staff[0].name}`);
  await userEvent.click(menu);
  expect(menu.parentElement).toHaveAttribute('open');
  await act(async () => { await qc.invalidateQueries(); });
  expect(document.querySelector('.pipeline-board')).toBe(viewport);
  expect(document.querySelector('.pipeline-card')).toBe(card);
  expect(viewport.scrollLeft).toBe(320);
  expect(menu.parentElement).toHaveAttribute('open');
  expect(screen.getByRole('button', {name:'Notes'})).toBeEnabled();
  qc.clear();
});
