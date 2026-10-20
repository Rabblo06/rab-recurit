import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api } from '../../shared/api';
import { PageSlotsProvider } from '../../shared/page-slots';
import VenueOfferPipeline, { Pipeline } from './VenueOfferPipeline';
jest.mock('../../shared/api', () => ({
  api: { get: jest.fn(), post: jest.fn() },
}));
jest.mock('../../shared/lib/toast', () => ({ toast: { error: jest.fn(), success: jest.fn(), info: jest.fn() } }));
import { toast } from '../../shared/lib/toast';
const mock = api as unknown as { get: jest.Mock; post: jest.Mock };
let board: Pipeline;
const STAGES = [
  'OFFERED',
  'WAITING',
  'STAFF ACCEPTED',
  'CONFIRMED',
  'LATE STAFF',
  'CLOCKED IN',
  'PENDING REVIEW',
  'CLOCKED OUT',
  'NO SHOW',
  'REJECTED',
  'CANCELLED',
  'DELETED OFFER',
];
function mount(wrap: (page: ReactNode) => ReactNode = (page) => page) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/venue-offers/shift']}>
        {wrap(
          <Routes>
            <Route
              path="/venue-offers/:shiftId"
              element={<VenueOfferPipeline />}
            />
          </Routes>,
        )}
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return qc;
}

/** A minimal stand-in for the shell top bar: live slot elements published through callback refs, as Layout does. */
let rebuildTopBar: () => void = () => {};
function ShellTopBar({ children }: { children: ReactNode }) {
  const [generation, setGeneration] = useState(0);
  rebuildTopBar = () => setGeneration((g) => g + 1);
  const [title, setTitle] = useState<HTMLElement | null>(null);
  const [actions, setActions] = useState<HTMLElement | null>(null);
  const [crumb, setCrumb] = useState<HTMLElement | null>(null);
  return (
    <PageSlotsProvider value={{ tabs: null, title, actions, breadcrumbSuffix: crumb }}>
      {/* A new key re-creates every slot node, like a shell re-render/HMR replacing the top bar. */}
      <header key={generation} data-testid="topbar" data-generation={generation}>
        <span ref={setCrumb} data-testid="crumb-slot" />
        <div ref={setTitle} data-testid="title-slot" />
        <div ref={setActions} data-testid="actions-slot" />
      </header>
      <main data-testid="page-content">{children}</main>
    </PageSlotsProvider>
  );
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
    stages: [...STAGES],
    summary: {
      required: 2,
      filled: 0,
      open: 2,
      offered: 1,
      waiting: 0,
      accepted: 0,
      confirmed: 0,
      late: 0,
      clockedIn: 0,
      pendingReview: 0,
      clockedOut: 0,
      noShow: 0,
      rejected: 0,
      cancelled: 0,
      deleted: 0,
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
function card(over: Partial<Pipeline['staff'][number]>): Pipeline['staff'][number] {
  return { ...board.staff[0], ...over };
}
it('shows all twelve lifecycle lanes (non-draggable) and every lane counter equals its cards', async () => {
  board.staff = [
    card({ staffProfileId: 'a', offerId: 'a', name: 'Ann Offered', stage: 'OFFERED' }),
    card({ staffProfileId: 'b', offerId: 'b', name: 'Ben Confirmed', stage: 'CONFIRMED', assignmentStatus: 'confirmed', offerStatus: 'manager_confirmed' }),
    card({ staffProfileId: 'c', offerId: 'c', name: 'Cat Missing', stage: 'PENDING REVIEW', attendanceStatus: 'missing_clock_out', clockInAt: '2030-01-01T18:02:00Z' }),
    card({ staffProfileId: 'd', offerId: 'd', name: 'Dan Out', stage: 'CLOCKED OUT', attendanceStatus: 'clocked_out', clockInAt: '2030-01-01T18:00:00Z', clockOutAt: '2030-01-01T23:00:00Z', attendanceReviewed: true }),
    card({ staffProfileId: 'e', offerId: 'e', name: 'Eve Absent', stage: 'NO SHOW', assignmentStatus: 'no_show' }),
    card({ staffProfileId: 'f', offerId: 'f', name: 'Fay Declined', stage: 'REJECTED', offerStatus: 'declined', terminalSource: 'Declined by staff', declineReason: 'Unavailable' }),
  ];
  board.summary = { ...board.summary, offered: 1, confirmed: 1, pendingReview: 1, clockedOut: 1, noShow: 1, rejected: 1, filled: 3, open: 0 };
  mount();
  await screen.findByRole('heading', { name: 'Example venue' });
  expect(document.querySelectorAll('.pipeline-column')).toHaveLength(12);
  for (const stage of STAGES) {
    const lane = screen.getByRole('region', { name: stage });
    const cards = lane.querySelectorAll('.pipeline-card').length;
    expect(within(lane).getByRole('heading')).toHaveTextContent(`${stage}${cards}`);
  }
  expect(document.querySelector('[draggable="true"]')).toBeNull();
  // Summary: seats first, then one counter per lane with exactly that lane's card count.
  const stages = screen.getByLabelText('Staff by stage');
  for (const [label, value] of [['Offered', '1'], ['Confirmed', '1'], ['Pending Review', '1'], ['Clocked out', '1'], ['No Show', '1'], ['Rejected', '1'], ['Clocked in', '0'], ['Deleted', '0']])
    expect(within(stages).getByText(label).parentElement).toHaveTextContent(`${label}${value}`);
  const seats = screen.getByLabelText('Seats');
  expect(within(seats).getByText('Filled').parentElement).toHaveTextContent('Filled3');
  // Precise copy for the new lanes.
  expect(within(screen.getByRole('region', { name: 'PENDING REVIEW' })).getByText(/Clock-out missing/)).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'CLOCKED OUT' })).getByText('Reviewed')).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'REJECTED' })).getByText('Declined by staff')).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'REJECTED' })).getByText('Unavailable')).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'NO SHOW' })).getByText(/no-show/)).toBeTruthy();
});
it('a lane counter jumps the board to that lane', async () => {
  const scrollIntoView = jest.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  mount();
  await screen.findByRole('heading', { name: 'Example venue' });
  await userEvent.click(within(screen.getByLabelText('Staff by stage')).getByRole('button', { name: /No Show/ }));
  expect(scrollIntoView).toHaveBeenCalledTimes(1);
  expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByRole('region', { name: 'NO SHOW' }));
});
it('inside the shell: title, status and Timesheet report live in the top bar, never inline in the page', async () => {
  mount((page) => <ShellTopBar>{page}</ShellTopBar>);
  const title = await screen.findByRole('heading', { name: 'Example venue' });
  expect(screen.getByTestId('title-slot')).toContainElement(title);
  expect(screen.getByTestId('actions-slot')).toContainElement(screen.getByRole('button', { name: 'Timesheet report' }));
  expect(screen.getByTestId('crumb-slot')).toHaveTextContent('/Example venue');
  expect(screen.getByTestId('page-content').querySelector('.pipeline-inline-actions')).toBeNull();
  expect(within(screen.getByTestId('page-content')).queryByRole('heading', { name: 'Example venue' })).toBeNull();
});
it('regression: when the top bar is re-created the header follows the NEW slots and is never displaced into the page', async () => {
  mount((page) => <ShellTopBar>{page}</ShellTopBar>);
  await screen.findByRole('heading', { name: 'Example venue' });
  const before = screen.getByTestId('title-slot');
  await act(async () => rebuildTopBar());
  const after = screen.getByTestId('title-slot');
  expect(after).not.toBe(before);
  expect(after).toContainElement(screen.getByRole('heading', { name: 'Example venue' }));
  expect(screen.getByTestId('actions-slot')).toContainElement(screen.getByRole('button', { name: 'Timesheet report' }));
  expect(screen.getAllByRole('button', { name: 'Timesheet report' })).toHaveLength(1);
  expect(screen.getByTestId('page-content').querySelector('.pipeline-inline-actions')).toBeNull();
});
it('with no shell at all (standalone) the header renders inline exactly once', async () => {
  mount();
  await screen.findByRole('heading', { name: 'Example venue' });
  expect(screen.getAllByRole('button', { name: 'Timesheet report' })).toHaveLength(1);
  expect(document.querySelector('.pipeline-inline-actions')).not.toBeNull();
});
it('Timesheet report before everyone has clocked out explains why with an error toast and opens nothing', async () => {
  mount();
  const button = await screen.findByRole('button', { name: 'Timesheet report' });
  expect(button).toBeEnabled();
  await userEvent.click(button);
  expect(toast.error).toHaveBeenCalledWith('Timesheet is not ready yet! Wait for all staff to clock out');
  expect(screen.queryByRole('heading', { name: 'Original Timesheet' })).toBeNull();
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
    await screen.findByRole('button', { name: 'Timesheet report' }),
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
