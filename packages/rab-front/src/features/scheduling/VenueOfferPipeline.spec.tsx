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
jest.mock('../../shared/lib/toast', () => ({ toast: { error: jest.fn(), success: jest.fn(), info: jest.fn(), warning: jest.fn() } }));
import { toast } from '../../shared/lib/toast';
const mock = api as unknown as { get: jest.Mock; post: jest.Mock };
let board: Pipeline;
let capabilities: Record<string, boolean>;
let roles: string[];
/** The agreed server contract (agent A): snake_case keys, three tabs. */
const CONTRACT = [
  'offered', 'waiting', 'staff_accepted', 'confirmed',
  'late', 'checked_in', 'clocked_in', 'pending_review', 'clocked_out', 'attendance_missing', 'no_show',
  'rejected', 'cancelled', 'deleted',
];
const LANES = {
  staffing: ['Offered', 'Waiting', 'Staff accepted', 'Confirmed'],
  attendance: ['Late staff', 'Checked in', 'Clocked in', 'Pending review', 'Clocked out', 'Attendance missing', 'No show'],
  closed: ['Rejected', 'Cancelled', 'Deleted'],
};
function mount(wrap: (page: ReactNode) => ReactNode = (page) => page, path = '/venue-offers/shift') {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
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
  capabilities = { 'offer.send': true };
  roles = ['manager'];
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
    stages: [...CONTRACT],
    summary: { required: 2, filled: 0, open: 2 },
    stageCounts: { offered: 1 },
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
        stage: 'offered',
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
  mock.get.mockImplementation(async (url: string) => {
    if (url === '/auth/capabilities') return { data: capabilities };
    if (url === '/auth/me') return { data: { roles } };
    if (url === '/shifts/shift') return { data: { id: 'shift', venueId: 'v', jobRoleId: 'r', startsAt: board.shift.startsAt, endsAt: board.shift.endsAt, requiredCount: 2, filledCount: 0, status: 'offered', breakMinutes: 0, payRatePence: 1200 } };
    return { data: JSON.parse(JSON.stringify(board)) };
  });
  mock.post.mockResolvedValue({ data: {} });
});
function card(over: Partial<Pipeline['staff'][number]>): Pipeline['staff'][number] {
  return { ...board.staff[0], ...over };
}
/** One person per contract stage, with matching server counts. */
function everyStage() {
  board.staff = CONTRACT.map((stage, i) =>
    card({ staffProfileId: `s${i}`, offerId: `o${i}`, name: `Person ${stage}`, stage, assignmentStatus: ['late', 'checked_in', 'clocked_in', 'pending_review', 'clocked_out', 'attendance_missing', 'confirmed'].includes(stage) ? 'confirmed' : stage === 'no_show' ? 'no_show' : 'offered', attendanceReviewed: stage === 'no_show' ? true : undefined, clockInAt: ['clocked_in', 'pending_review', 'clocked_out'].includes(stage) ? '2030-01-01T18:02:00Z' : null, clockOutAt: stage === 'clocked_out' ? '2030-01-01T23:00:00Z' : null }),
  );
  board.stageCounts = Object.fromEntries(CONTRACT.map((s) => [s, 1]));
}
const tab = (name: RegExp) => screen.getByRole('tab', { name });
const lane = (name: string) => screen.getByRole('region', { name });

describe('tabs and lanes', () => {
  it('renders a proper tablist with Staffing / Attendance / Closed, each holding exactly its contract lanes', async () => {
    everyStage();
    mount();
    await screen.findByRole('heading', { name: 'Example venue' });
    const tablist = screen.getByRole('tablist', { name: 'Pipeline stages' });
    expect(within(tablist).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Staffing4', 'Attendance7', 'Closed3']);
    for (const [key, labels] of Object.entries(LANES)) {
      await userEvent.click(tab(new RegExp(`^${key}`, 'i')));
      expect(tab(new RegExp(`^${key}`, 'i'))).toHaveAttribute('aria-selected', 'true');
      const panel = screen.getByRole('tabpanel');
      expect(panel).toHaveAttribute('aria-labelledby', `pipeline-tab-${key}`);
      expect([...panel.querySelectorAll('.pipeline-column')].map((c) => c.getAttribute('aria-label'))).toEqual(labels);
      for (const label of labels) {
        const region = lane(label);
        expect(region.querySelectorAll('.pipeline-card')).toHaveLength(1);
        expect(within(region).getByRole('heading')).toHaveTextContent(`${label}1`);
      }
    }
    expect(screen.getByText('14 stages across Staffing, Attendance and Closed')).toBeTruthy();
    expect(screen.getByText('Current shift · 14 staff')).toBeTruthy();
  });

  it('places checked_in, attendance_missing and no_show in Attendance with honest copy', async () => {
    everyStage();
    mount(undefined, '/venue-offers/shift?tab=attendance');
    await screen.findByRole('heading', { name: 'Example venue' });
    expect(within(lane('Checked in')).getByText('Person checked_in')).toBeTruthy();
    expect(within(lane('Checked in')).getByText('Arrived · not yet clocked in')).toBeTruthy();
    expect(within(lane('Attendance missing')).getByText('Person attendance_missing')).toBeTruthy();
    expect(within(lane('Attendance missing')).getByText('No clock-in recorded · needs review')).toBeTruthy();
    expect(within(lane('No show')).getByText('Person no_show')).toBeTruthy();
    expect(within(lane('No show')).getByText('No-show confirmed by manager')).toBeTruthy();
    expect(within(lane('Clocked out')).getByText('Awaiting review')).toBeTruthy();
  });

  it('lane and tab counts come from the server stageCounts, never recounted from cards', async () => {
    board.stageCounts = { offered: 3, waiting: 2, rejected: 4 };
    mount();
    await screen.findByRole('heading', { name: 'Example venue' });
    expect(within(lane('Offered')).getByRole('heading')).toHaveTextContent('Offered3');
    expect(tab(/^Staffing/)).toHaveTextContent('Staffing5');
    expect(tab(/^Closed/)).toHaveTextContent('Closed4');
    expect(tab(/^Attendance/)).toHaveTextContent('Attendance0');
  });

  it('still works with the current API: uppercase stage labels and legacy summary counters', async () => {
    board.stages = ['OFFERED', 'WAITING', 'STAFF ACCEPTED', 'CONFIRMED', 'LATE STAFF', 'CLOCKED IN', 'PENDING REVIEW', 'CLOCKED OUT', 'NO SHOW', 'REJECTED', 'CANCELLED', 'DELETED OFFER'];
    delete board.stageCounts;
    board.summary = { required: 2, filled: 1, open: 1, offered: 0, accepted: 1, clockedIn: 0, pendingReview: 1, noShow: 1, deleted: 1 };
    board.staff = [
      card({ staffProfileId: 'a', offerId: 'a', name: 'Ann Accepted', stage: 'STAFF ACCEPTED', acceptedAt: '2030-01-01T13:00:00Z' }),
      card({ staffProfileId: 'b', offerId: 'b', name: 'Ben Review', stage: 'PENDING REVIEW', attendanceStatus: 'missing_clock_out', clockInAt: '2030-01-01T18:02:00Z' }),
      card({ staffProfileId: 'c', offerId: 'c', name: 'Cat Absent', stage: 'NO SHOW', assignmentStatus: 'no_show', attendanceReviewed: false }),
      card({ staffProfileId: 'd', offerId: 'd', name: 'Dan Expired', stage: 'DELETED OFFER', terminalSource: 'Offer expired' }),
    ];
    mount();
    await screen.findByRole('heading', { name: 'Example venue' });
    expect(within(lane('Staff accepted')).getByText('Ann Accepted')).toBeTruthy();
    expect(tab(/^Staffing/)).toHaveTextContent('Staffing1');
    await userEvent.click(tab(/^Attendance/));
    expect(within(lane('Pending review')).getByText(/Clock-out missing/)).toBeTruthy();
    // A worker mark the manager has not confirmed is never presented as a final no-show.
    expect(within(lane('No show')).getByText('No clock-in recorded · needs review')).toBeTruthy();
    expect(within(lane('Checked in')).getByRole('heading')).toHaveTextContent('Checked in0');
    await userEvent.click(tab(/^Closed/));
    expect(within(lane('Deleted')).getByText('Offer expired')).toBeTruthy();
  });

  it('tolerates stage keys it does not know: contract lanes missing on the server read 0, unknown stages get a lane', async () => {
    board.stages = ['offered', 'waiting', 'clocked_in', 'on_break', 'clocked_out'];
    board.stageCounts = { offered: 0, on_break: 1 };
    board.staff = [card({ stage: 'on_break', name: 'Bea Break', assignmentStatus: 'confirmed' })];
    mount(undefined, '/venue-offers/shift?tab=attendance');
    await screen.findByRole('heading', { name: 'Example venue' });
    const columns = [...screen.getByRole('tabpanel').querySelectorAll('.pipeline-column')].map((c) => c.getAttribute('aria-label'));
    expect(columns.indexOf('On break')).toBe(columns.indexOf('Clocked in') + 1);
    expect(within(lane('On break')).getByText('Bea Break')).toBeTruthy();
    expect(within(lane('Attendance missing')).getByRole('heading')).toHaveTextContent('Attendance missing0');
    expect(tab(/^Attendance/)).toHaveTextContent('Attendance1');
  });

  it('tabs are keyboard operable (arrows, Home, End) with a roving tabindex', async () => {
    mount();
    await screen.findByRole('heading', { name: 'Example venue' });
    tab(/^Staffing/).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(tab(/^Attendance/)).toHaveAttribute('aria-selected', 'true');
    expect(tab(/^Attendance/)).toHaveFocus();
    expect(tab(/^Staffing/)).toHaveAttribute('tabindex', '-1');
    await userEvent.keyboard('{End}');
    expect(tab(/^Closed/)).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(tab(/^Staffing/)).toHaveAttribute('aria-selected', 'true');
  });
});

describe('search, filter and sort', () => {
  beforeEach(() => {
    board.staff = [
      card({ staffProfileId: 'a', offerId: 'a', name: 'Ann Able', stage: 'offered' }),
      card({ staffProfileId: 'z', offerId: 'z', name: 'Zed Zulu', stage: 'offered' }),
      card({ staffProfileId: 'm', offerId: 'm', name: 'Mia Missing', stage: 'attendance_missing', assignmentStatus: 'confirmed' }),
      card({ staffProfileId: 'r', offerId: 'r', name: 'Rob Reviewed', stage: 'clocked_out', attendanceReviewed: true, clockInAt: '2030-01-01T18:00:00Z', clockOutAt: '2030-01-01T23:00:00Z' }),
    ];
    board.stageCounts = { offered: 2, attendance_missing: 1, clocked_out: 1 };
  });

  it('search applies across tabs and the counts show matches of the server total', async () => {
    mount();
    await screen.findByText('Ann Able');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search staff' }), 'zed');
    await waitFor(() => expect(screen.queryByText('Ann Able')).toBeNull());
    expect(screen.getByText('Zed Zulu')).toBeTruthy();
    expect(within(lane('Offered')).getByLabelText('1 shown of 2')).toBeTruthy();
    expect(tab(/^Attendance/)).toHaveTextContent('0/2');
    await userEvent.click(tab(/^Attendance/));
    expect(within(lane('Attendance missing')).getByText('No matching staff')).toBeTruthy();
  });

  it('sorts by name either way and filters to staff needing attention or already reviewed', async () => {
    mount();
    await screen.findByText('Ann Able');
    const names = () => [...lane('Offered').querySelectorAll('.pipeline-card strong')].map((n) => n.textContent);
    expect(names()).toEqual(['Ann Able', 'Zed Zulu']);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Sort staff' }), 'name-desc');
    expect(names()).toEqual(['Zed Zulu', 'Ann Able']);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Filter staff' }), 'attention');
    await waitFor(() => expect(screen.queryByText('Zed Zulu')).toBeNull());
    await userEvent.click(tab(/^Attendance/));
    expect(screen.getByText('Mia Missing')).toBeTruthy();
    expect(screen.queryByText('Rob Reviewed')).toBeNull();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Filter staff' }), 'reviewed');
    expect(screen.getByText('Rob Reviewed')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Mia Missing')).toBeNull());
  });
});

describe('Send offer', () => {
  it('opens the existing Send offers drawer in replacement mode for this shift (header and Offered lane)', async () => {
    const listener = jest.fn();
    document.addEventListener('open-send-offer', listener);
    mount();
    await screen.findByRole('heading', { name: 'Example venue' });
    const buttons = await screen.findAllByRole('button', { name: 'Send offer' });
    expect(buttons).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Add users|Select replacement/ })).toBeNull();
    await userEvent.click(buttons[0]!);
    await waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    expect(listener.mock.calls[0][0].detail).toMatchObject({ shiftId: 'shift', mode: 'replacement', shift: { id: 'shift', venueId: 'v' } });
    await userEvent.click(within(lane('Offered')).getByRole('button', { name: 'Send offer' }));
    await waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
    expect(listener.mock.calls[1][0].detail).toMatchObject({ shiftId: 'shift', mode: 'replacement' });
    document.removeEventListener('open-send-offer', listener);
  });

  it('is hidden without the offer-send capability', async () => {
    capabilities = { 'offer.send': false };
    mount();
    await screen.findByRole('heading', { name: 'Example venue' });
    await waitFor(() => expect(mock.get).toHaveBeenCalledWith('/auth/capabilities'));
    expect(screen.queryByRole('button', { name: 'Send offer' })).toBeNull();
  });

  it('is never shown to a Venue Manager', async () => {
    roles = ['venue_manager'];
    mount();
    await screen.findByRole('heading', { name: 'Example venue' });
    await waitFor(() => expect(mock.get).toHaveBeenCalledWith('/auth/me'));
    expect(screen.queryByRole('button', { name: 'Send offer' })).toBeNull();
  });

  it('without the replacement block (older API) it falls back to replacementPlaces: disabled at 0', async () => {
    board.replacementPlaces = 0;
    mount();
    const buttons = await screen.findAllByRole('button', { name: 'Send offer' });
    for (const b of buttons) expect(b).toBeDisabled();
  });

  it('refreshes the board as soon as offers are sent for this shift', async () => {
    const qc = mount();
    await screen.findByRole('heading', { name: 'Example venue' });
    const pipelineCalls = () => mock.get.mock.calls.filter(([u]) => u === '/shifts/shift/pipeline').length;
    const before = pipelineCalls();
    await act(async () => {
      await qc.getMutationCache().build(qc, { mutationFn: async () => ({}) }).execute({ shiftId: 'shift', staffProfileIds: ['x'] });
    });
    await waitFor(() => expect(pipelineCalls()).toBe(before + 1));
    await act(async () => {
      await qc.getMutationCache().build(qc, { mutationFn: async () => ({}) }).execute({ shiftId: 'other-shift' });
    });
    await act(async () => {
      document.dispatchEvent(new CustomEvent('offers-sent', { detail: { shiftId: 'shift' } }));
    });
    await waitFor(() => expect(pipelineCalls()).toBe(before + 2));
  });

  it('tags Replacement / Standby cards only from the server offerKind', async () => {
    board.staff = [
      card({ offerKind: 'replacement' }),
      card({ staffProfileId: 's', offerId: 's', name: 'Sky Standby', offerKind: 'standby' }),
      card({ staffProfileId: 'b', offerId: 'b', name: 'Plain Person', offerKind: 'standard' }),
      card({ staffProfileId: 'n', offerId: 'n', name: 'No Kind' }),
    ];
    board.stageCounts = { offered: 4 };
    mount();
    await screen.findByText('Plain Person');
    expect(screen.getAllByText('Replacement')).toHaveLength(1);
    expect(screen.getAllByText('Standby')).toHaveLength(1);
    expect(screen.getByText('Sky Standby').closest('article')).toHaveTextContent('Standby');
  });

  it('after a no-show (replacementPlaces 0) the server replacement block enables it, with the vacancy as tooltip', async () => {
    board.replacementPlaces = 0;
    board.replacement = { vacancy: 1, confirmedNoShows: 1, provisionalNoShows: 0, nextOfferKind: 'replacement', canSend: true };
    const listener = jest.fn();
    document.addEventListener('open-send-offer', listener);
    mount();
    const buttons = await screen.findAllByRole('button', { name: 'Send offer' });
    for (const b of buttons) {
      expect(b).toBeEnabled();
      expect(b).toHaveAttribute('title', '1 place to fill');
    }
    await userEvent.click(buttons[0]!);
    await waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    expect(listener.mock.calls[0][0].detail).toMatchObject({ shiftId: 'shift', mode: 'replacement' });
    document.removeEventListener('open-send-offer', listener);
  });

  it('says offers will go out as standby when the server says so', async () => {
    board.replacement = { vacancy: 0, confirmedNoShows: 0, provisionalNoShows: 2, nextOfferKind: 'standby', canSend: true };
    mount();
    const buttons = await screen.findAllByRole('button', { name: 'Send offer' });
    for (const b of buttons) expect(b).toHaveAttribute('title', 'Offers will be sent as standby');
  });

  it('replacement.canSend false disables it even when replacementPlaces is positive', async () => {
    board.replacementPlaces = 3;
    board.replacement = { vacancy: 0, confirmedNoShows: 0, provisionalNoShows: 0, nextOfferKind: 'standard', canSend: false };
    mount();
    const buttons = await screen.findAllByRole('button', { name: 'Send offer' });
    for (const b of buttons) expect(b).toBeDisabled();
  });
});

describe('attention banner and analytics', () => {
  function missingFive(stage: string, reviewed?: boolean) {
    board.staff = [11, 12, 13, 14, 15].map((n) =>
      card({ staffProfileId: `s${n}`, offerId: `o${n}`, name: `Staff Test ${n}`, stage, assignmentStatus: stage === 'confirmed' ? 'confirmed' : stage.toLowerCase().includes('no') ? 'no_show' : 'confirmed', attendanceReviewed: reviewed }),
    );
    board.shift.requiredCount = 5;
    board.summary = { required: 5, filled: 0, open: 5 };
  }

  it('five confirmed staff with no punches are 5 filled seats', async () => {
    missingFive('confirmed');
    board.stageCounts = { confirmed: 5 };
    mount(undefined, '/venue-offers/shift?view=analytics');
    expect(await screen.findByTestId('coverage-foot')).toHaveTextContent('5 of 5 positions filled · 0 still open');
    expect(screen.queryByRole('status', { name: /review/ })).toBeNull();
  });

  it('attendance missing: banner asks for review, coverage stays filled, nothing claims a final no-show', async () => {
    missingFive('attendance_missing');
    board.stageCounts = { attendance_missing: 5 };
    mount();
    const banner = await screen.findByText('5 staff need attendance review');
    expect(banner.parentElement).toHaveTextContent('No clock-in recorded');
    expect(banner.parentElement).not.toHaveTextContent(/marked no.show|are no.shows?/i);
    await userEvent.click(screen.getByRole('button', { name: /View analytics/ }));
    expect(screen.getByTestId('coverage-foot')).toHaveTextContent('5 of 5 positions filled · 0 still open');
    const legend = screen.getByRole('list', { name: 'Attendance breakdown' });
    expect(within(legend).getByText('Attendance missing').closest('li')).toHaveTextContent('5');
    expect(within(legend).getByText('No-show (confirmed)').closest('li')).toHaveTextContent('0');
    expect(screen.getByTestId('attendance-foot')).toHaveTextContent('not a confirmed no-show');
    const table = screen.getByRole('table');
    expect(within(table).getAllByText('Attendance missing')).toHaveLength(5);
    expect(within(table).queryByText(/No-show/)).toBeNull();
  });

  it('legacy API: an unreviewed NO SHOW mark is reported as missing attendance and keeps its seat filled', async () => {
    missingFive('NO SHOW', false);
    board.stageCounts = { 'NO SHOW': 5 };
    mount(undefined, '/venue-offers/shift?view=analytics');
    expect(await screen.findByText('5 staff need attendance review')).toBeTruthy();
    expect(screen.getByTestId('coverage-foot')).toHaveTextContent('5 of 5 positions filled');
    expect(within(screen.getByRole('list', { name: 'Attendance breakdown' })).getByText('Attendance missing').closest('li')).toHaveTextContent('5');
  });

  it('a manager-confirmed no-show is reported as such and frees the seat', async () => {
    missingFive('no_show', true);
    board.stageCounts = { no_show: 5 };
    mount(undefined, '/venue-offers/shift?view=analytics');
    expect(await screen.findByTestId('coverage-foot')).toHaveTextContent('0 of 5 positions filled · 5 still open');
    expect(screen.getByTestId('attendance-foot')).toHaveTextContent('5 confirmed no-show');
    expect(screen.queryByText(/need attendance review/)).toBeNull();
  });

  it('checked in is arrival, not worked time; staff-by-stage bars use the server stage counts', async () => {
    board.shift.requiredCount = 3;
    board.staff = [
      card({ staffProfileId: 'a', offerId: 'a', name: 'Ari Arrived', stage: 'checked_in', assignmentStatus: 'confirmed' }),
      card({ staffProfileId: 'b', offerId: 'b', name: 'Bo Working', stage: 'clocked_in', assignmentStatus: 'confirmed', clockInAt: '2030-01-01T18:01:00Z' }),
      card({ staffProfileId: 'c', offerId: 'c', name: 'Cy Done', stage: 'clocked_out', assignmentStatus: 'completed', clockInAt: '2030-01-01T18:00:00Z', clockOutAt: '2030-01-01T23:00:00Z' }),
    ];
    board.stageCounts = { checked_in: 1, clocked_in: 1, clocked_out: 1 };
    mount(undefined, '/venue-offers/shift?view=analytics');
    const legend = await screen.findByRole('list', { name: 'Attendance breakdown' });
    expect(within(legend).getByText('Checked in').closest('li')).toHaveTextContent('Checked in · arrived, not working1');
    expect(within(legend).getByText('Clocked in').closest('li')).toHaveTextContent(/Clocked in · working1/);
    expect(screen.getByTestId('attendance-foot')).toHaveTextContent('1 working now · 1 checked in, not yet clocked in');
    expect(screen.getByTestId('coverage-foot')).toHaveTextContent('3 of 3 positions filled');
    const bars = screen.getByRole('list', { name: 'Staff by pipeline stage' });
    expect(bars.querySelectorAll('li')).toHaveLength(14);
    expect(bars.querySelector('[data-stage="checked_in"]')).toHaveTextContent('Checked in1');
    expect(bars.querySelector('[data-stage="no_show"]')).toHaveTextContent('No show0');
    const row = within(screen.getByRole('table')).getByText('Bo Working').closest('tr')!;
    expect(row).toHaveTextContent('18:01');
    const listener = jest.fn();
    document.addEventListener('open-user-detail', listener);
    await userEvent.click(within(row).getByRole('button', { name: /Review attendance/ }));
    expect(screen.getByText('Bo Working · attendance')).toBeTruthy();
    document.removeEventListener('open-user-detail', listener);
  });
});

describe('preserved behaviour', () => {
  it('inside the shell: Timesheet report and Send offer live in the top bar; the title is in the page', async () => {
    mount((page) => <ShellTopBar>{page}</ShellTopBar>);
    const title = await screen.findByRole('heading', { name: 'Example venue' });
    expect(screen.getByTestId('page-content')).toContainElement(title);
    expect(screen.getByTestId('actions-slot')).toContainElement(screen.getByRole('button', { name: 'Timesheet report' }));
    await waitFor(() => expect(within(screen.getByTestId('actions-slot')).getByRole('button', { name: 'Send offer' })).toBeTruthy());
    expect(screen.getByTestId('crumb-slot')).toHaveTextContent('/Example venue');
    expect(screen.getByTestId('page-content').querySelector('.pipeline-inline-actions')).toBeNull();
  });
  it('regression: when the top bar is re-created the actions follow the NEW slots and are never displaced into the page', async () => {
    mount((page) => <ShellTopBar>{page}</ShellTopBar>);
    await screen.findByRole('heading', { name: 'Example venue' });
    const before = screen.getByTestId('actions-slot');
    await act(async () => rebuildTopBar());
    const after = screen.getByTestId('actions-slot');
    expect(after).not.toBe(before);
    expect(after).toContainElement(screen.getByRole('button', { name: 'Timesheet report' }));
    expect(screen.getAllByRole('button', { name: 'Timesheet report' })).toHaveLength(1);
    expect(screen.getByTestId('page-content').querySelector('.pipeline-inline-actions')).toBeNull();
  });
  it('with no shell at all (standalone) the actions render inline exactly once', async () => {
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
    expect(toast.error).toHaveBeenCalledWith("Timesheet isn't ready yet. Wait until all required staff have clocked out.");
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'Original Timesheet' })).toBeNull();
  });
  it('after a "not ready" answer, the board turning ready gives the ready toast exactly once', async () => {
    (toast.success as jest.Mock).mockClear();
    const qc = mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Timesheet report' }));
    board.report = { ...board.report!, ready: true };
    await act(async () => { await qc.invalidateQueries({ queryKey: ['venue-pipeline', 'shift'] }); });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Timesheet is ready. All required staff have clocked out.'));
    await act(async () => { await qc.invalidateQueries({ queryKey: ['venue-pipeline', 'shift'] }); }); // a later poll
    expect(toast.success).toHaveBeenCalledTimes(1);
  });
  it('a board that is already ready on load (or polls) never raises a readiness toast', async () => {
    (toast.success as jest.Mock).mockClear();
    (toast.error as jest.Mock).mockClear();
    board.report = { ...board.report!, ready: true };
    const qc = mount();
    await screen.findByRole('button', { name: 'Timesheet report' });
    await act(async () => { await qc.invalidateQueries({ queryKey: ['venue-pipeline', 'shift'] }); });
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
  it('opens the canonical staff drawer and Notes tab by event', async () => {
    mount();
    await screen.findByText('Jordan Staff');
    const listener = jest.fn();
    document.addEventListener('open-user-detail', listener);
    await userEvent.click(screen.getByRole('button', { name: /^Jordan Staff Bartender/ }));
    expect(listener.mock.calls[0][0].detail).toMatchObject({ id: 'staff', type: 'staff' });
    await userEvent.click(screen.getByLabelText('Actions for Jordan Staff'));
    await userEvent.click(screen.getByRole('button', { name: 'Notes' }));
    expect(listener.mock.calls[1][0].detail.tab).toBe('notes');
    document.removeEventListener('open-user-detail', listener);
  });
  it('Review ↗ on a card opens that person\'s attendance review', async () => {
    mount();
    await screen.findByText('Jordan Staff');
    await userEvent.click(screen.getByRole('button', { name: 'Review Jordan Staff' }));
    expect(screen.getByText('Jordan Staff · attendance')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'View staff profile' })).toBeTruthy();
  });
  it('optional cancellation reason uses the canonical mutation and refreshes automatically', async () => {
    mount();
    await screen.findByText('Jordan Staff');
    await userEvent.click(screen.getByLabelText('Actions for Jordan Staff'));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel offer' }));
    await userEvent.type(screen.getByLabelText('Reason (optional)'), 'Venue requested replacement');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel Offer' }));
    await waitFor(() =>
      expect(mock.post).toHaveBeenCalledWith('/shifts/shift/pipeline/offers/offer/cancel', { reason: 'Venue requested replacement' }),
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
    const qc = mount(undefined, '/venue-offers/shift?tab=attendance');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      jest.advanceTimersByTime(20);
    });
    board.staff[0].stage = 'clocked_out';
    board.staff[0].clockOutAt = '2030-01-01T23:00:00Z';
    board.stageCounts = { clocked_out: 1 };
    await act(async () => {
      jest.advanceTimersByTime(5000);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      jest.advanceTimersByTime(20);
    });
    expect(within(lane('Clocked out')).getByText('Jordan Staff')).toBeTruthy();
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
    await userEvent.click(await screen.findByRole('button', { name: 'Timesheet report' }));
    expect(screen.getByRole('heading', { name: 'Original Timesheet' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Venue Signed Timesheet' })).toBeTruthy();
    expect(screen.getByText(/Finalised by Vera Venue/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Download' })).toHaveLength(2);
  });
  it('retains the board, scroll position and open accessible menu across refreshes', async () => {
    board.staff[0].name = 'ReplacementStaff Test With A Very Long Family Name';
    const qc = mount();
    await screen.findByText(board.staff[0].name);
    const viewport = document.querySelector('.pipeline-board')!;
    const cardEl = document.querySelector('.pipeline-card');
    viewport.scrollLeft = 320;
    const menu = screen.getByLabelText(`Actions for ${board.staff[0].name}`);
    await userEvent.click(menu);
    expect(menu.parentElement).toHaveAttribute('open');
    await act(async () => { await qc.invalidateQueries(); });
    expect(document.querySelector('.pipeline-board')).toBe(viewport);
    expect(document.querySelector('.pipeline-card')).toBe(cardEl);
    expect(viewport.scrollLeft).toBe(320);
    expect(menu.parentElement).toHaveAttribute('open');
    expect(screen.getByRole('button', { name: 'Notes' })).toBeEnabled();
    qc.clear();
  });
  it('Export downloads the board as CSV with formula injection neutralised', async () => {
    board.staff = [card({ name: '=HYPERLINK("x")' })];
    const created: Blob[] = [];
    const createObjectURL = jest.fn((b: Blob) => { created.push(b); return 'blob:csv'; });
    Object.assign(URL, { createObjectURL, revokeObjectURL: jest.fn() });
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Export' }));
    expect(click).toHaveBeenCalled();
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(created[0]!);
    });
    expect(text.split('\r\n')[0]).toContain('"Staff","Role","Stage"');
    expect(text).toContain(`"'=HYPERLINK(""x"")","Bartender","Offered"`);
    click.mockRestore();
  });
});
