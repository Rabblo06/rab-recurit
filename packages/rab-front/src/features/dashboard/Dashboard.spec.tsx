import { act, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import { api } from '../../shared/api';
import { applyIdentityFromServer, markUnauthenticated } from '../../shared/lib/auth-session';
import Dashboard from './Dashboard';

jest.mock('../../shared/api', () => ({
  api: { get: jest.fn() },
}));

const mockApi = api as unknown as { get: jest.Mock };

const SUMMARY = { staffCount: 12, managerCount: 3, venueCount: 4, activeOfferCount: 2 };
const PROFILE = { id: 'u1', firstName: 'Avery', lastName: 'Quinn', email: 'a@example.test', jobTitle: null, avatarKey: null };
const OFFER_TOTALS: Record<string, number> = { pending: 7, staff_accepted: 2, manager_confirmed: 11, declined: 1, expired: 0 };

type Handler = (url: string, params: Record<string, unknown>) => Promise<{ data: unknown }> | undefined;

/** Default: every endpoint answers with real-looking shapes; `override` replaces specific URLs. */
function serve(override?: Handler) {
  mockApi.get.mockImplementation((url: string, config?: { params?: Record<string, unknown> }) => {
    const params = config?.params ?? {};
    const custom = override?.(url, params);
    if (custom) return custom;
    if (url === '/dashboard/summary') return Promise.resolve({ data: SUMMARY });
    if (url === '/profile') return Promise.resolve({ data: PROFILE });
    if (url === '/offers' && params.limit === 1) return Promise.resolve({ data: { data: [], total: OFFER_TOTALS[String(params.status)] ?? 0 } });
    return Promise.resolve({ data: { data: [], total: 0 } });
  });
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <Dashboard />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('Dashboard', () => {
  beforeEach(() => mockApi.get.mockReset());

  it('greets the authenticated user by name (no hardcoded name) with a time-aware greeting', async () => {
    serve();
    mount();
    expect(await screen.findByText(/^Good (morning|afternoon|evening), Avery$/)).toBeInTheDocument();
  });

  it('renders the summary counts without waiting for any other widget', async () => {
    serve((url) => (url === '/dashboard/summary' || url === '/profile' ? undefined : new Promise(() => {})));
    mount();
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('12')).toBeInTheDocument());
    expect(screen.getByText('Managers')).toBeInTheDocument();
  });

  it('offer stages use the server COUNT (`total` of a status-filtered list), not a downloaded page', async () => {
    serve();
    mount();
    const card = (await screen.findByText('Offer pipeline')).closest('.dash-card') as HTMLElement;
    await waitFor(() => expect(within(card).getByText('21')).toBeInTheDocument()); // 7 + 2 + 11 + 1
    expect(mockApi.get).toHaveBeenCalledWith('/offers', { params: { status: 'pending', limit: 1 } });
    expect(mockApi.get).toHaveBeenCalledWith('/offers', { params: { status: 'manager_confirmed', limit: 1 } });
  });

  it('a failed /offers request shows that card’s error with Retry, never fake zeros; the rest still renders', async () => {
    serve((url) => (url === '/offers' ? Promise.reject(new Error('network error')) : undefined));
    mount();
    expect((await screen.findAllByText('We couldn’t load these records.')).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Retry' }).length).toBeGreaterThan(0);
    expect(screen.queryByText('No offers yet.')).toBeNull();
    expect(screen.getByText('Shifts by venue')).toBeInTheDocument();
  });

  it('hours worked averages real worked minutes and ignores still-open attendance', async () => {
    const today = new Date();
    serve((url) => (url === '/attendance' ? Promise.resolve({ data: { total: 3, data: [
      { id: 'a1', clockInAt: today.toISOString(), workedMinutes: 360 },
      { id: 'a2', clockInAt: new Date(today.getTime() - 86_400_000).toISOString(), workedMinutes: 480 },
      { id: 'a3', clockInAt: today.toISOString(), workedMinutes: null },
    ] } }) : undefined));
    mount();
    const card = (await screen.findByText('Hours worked')).closest('.dash-card') as HTMLElement;
    // (6 h + 8 h) over the two days actually worked = 7.0 h; the open record adds nothing.
    await waitFor(() => expect(within(card).getByText('7.0')).toBeInTheDocument());
  });

  it('shows initials when the manager has no photo — never a stock portrait', async () => {
    serve();
    mount();
    expect(await screen.findByText('AQ')).toBeInTheDocument();
    expect(document.querySelector('.dash-profile img')).toBeNull();
  });

  it('a genuinely empty workspace shows honest empty states', async () => {
    serve();
    mount();
    expect(await screen.findByText('No offers yet.')).toBeInTheDocument();
    expect(await screen.findByText('No upcoming shifts in the next 14 days.')).toBeInTheDocument();
    expect(await screen.findByText('No shifts in the last 30 days.')).toBeInTheDocument();
    expect(screen.queryByText('We couldn’t load these records.')).toBeNull();
  });

  it('readiness checklist reflects the next shift’s real pipeline counts', async () => {
    act(() => applyIdentityFromServer({ userId: 'u1', sessionId: 's1' }));
    const start = new Date(Date.now() + 3_600_000);
    const end = new Date(Date.now() + 6 * 3_600_000);
    serve((url) => {
      if (url === '/shifts') return Promise.resolve({ data: { total: 1, data: [{ id: 'sh1', venueId: 'v1', startsAt: start.toISOString(), endsAt: end.toISOString(), requiredCount: 4, filledCount: 4, status: 'fully_filled', createdBy: 'u1', requestedBy: 'vm1' }] } });
      if (url === '/shifts/sh1/pipeline') return Promise.resolve({ data: {
        shift: { id: 'sh1', venueName: 'Venue One', roleName: 'Role', startsAt: start.toISOString(), endsAt: end.toISOString() },
        summary: { required: 4, filled: 4, offered: 0, waiting: 0, accepted: 0, confirmed: 4, clockedIn: 0, pendingReview: 0, clockedOut: 0 },
        report: { ready: false, finalisedAt: null },
      } });
      return undefined;
    });
    mount();
    const list = (await screen.findByText('Shift checklist')).closest('.dash-checklist') as HTMLElement;
    expect(within(list).getByText('Staff assigned').parentElement).toHaveTextContent('(done)');
    expect(within(list).getByText('Staff clocked in').parentElement).toHaveTextContent('(to do)');
    expect(within(list).getByText(/^3$/)).toBeInTheDocument(); // 3 of 7 tasks done
  });

  describe('shift readiness: which details the caller may see, and why a load failed', () => {
    const start = new Date(Date.now() + 3_600_000);
    const end = new Date(Date.now() + 6 * 3_600_000);
    const row = (over: Record<string, unknown> = {}) => ({
      id: 'sh1', venueId: 'v1', startsAt: start.toISOString(), endsAt: end.toISOString(), requiredCount: 3, filledCount: 1, status: 'partially_filled', ...over,
    });
    const refusal = (status: number, message: string) => Promise.reject({ response: { status, data: { message } } });
    const card = async () => (await screen.findByText('Shift readiness')).closest('.dash-readiness') as HTMLElement;
    const pipelineCalls = () => mockApi.get.mock.calls.filter(([url]) => String(url).endsWith('/pipeline')).length;

    beforeEach(() => act(() => applyIdentityFromServer({ userId: 'u1', sessionId: 's1' })));

    it('a shift requested by ANOTHER manager: basic staffing only, the restricted pipeline is never requested', async () => {
      serve((url) => (url === '/shifts' ? Promise.resolve({ data: { total: 1, data: [row({ createdBy: 'u-other', requestedBy: 'vm1' })] } }) : undefined));
      mount();
      const c = await card();
      expect(await within(c).findByText('1 / 3 places filled')).toBeInTheDocument();
      expect(within(c).getByText('The detailed checklist is shown for shifts you requested from a venue.')).toBeInTheDocument();
      // The checklist card is still shown, with only the staffing check known and every other check "not available".
      const list = within(c).getByText('Shift checklist').closest('.dash-checklist') as HTMLElement;
      expect(within(list).getByText('Staffing only')).toBeInTheDocument();
      expect(within(list).getByText('Staff assigned').parentElement).toHaveTextContent('(to do)');
      expect(within(list).getAllByText('Not available for this shift')).toHaveLength(6);
      expect(within(list).getByText('Timesheet finalised').parentElement).toHaveTextContent('(not available)');
      expect(within(c).queryByText(/\(done\)/)).toBeNull(); // nothing unavailable is presented as complete
      expect(within(c).queryByText(/No operational workspace/)).toBeNull();
      expect(within(c).queryByText('Open staffing pipeline')).toBeNull();
      expect(pipelineCalls()).toBe(0);
    });

    it('basic view: a fully staffed shift ticks only "Staff assigned", nothing else', async () => {
      serve((url) => (url === '/shifts' ? Promise.resolve({ data: { total: 1, data: [row({ createdBy: 'u-other', requestedBy: 'vm1', filledCount: 3 })] } }) : undefined));
      mount();
      const c = await card();
      const list = (await within(c).findByText('Shift checklist')).closest('.dash-checklist') as HTMLElement;
      expect(within(list).getByText('Staff assigned').parentElement).toHaveTextContent('(done)');
      expect(within(list).getAllByText(/\(done\)/)).toHaveLength(1);
    });

    it('the caller’s own shift with no venue request is not a pipeline shift: basic staffing, no request', async () => {
      serve((url) => (url === '/shifts' ? Promise.resolve({ data: { total: 1, data: [row({ createdBy: 'u1', requestedBy: null })] } }) : undefined));
      mount();
      const c = await card();
      expect(await within(c).findByText('1 / 3 places filled')).toBeInTheDocument();
      expect(pipelineCalls()).toBe(0);
    });

    it('the caller’s requested shift whose details are genuinely missing (404): basic staffing and a neutral note, never "no workspace"', async () => {
      serve((url) => {
        if (url === '/shifts') return Promise.resolve({ data: { total: 1, data: [row({ createdBy: 'u1', requestedBy: 'vm1' })] } });
        if (url === '/shifts/sh1/pipeline') return refusal(404, 'Shift not found.');
        return undefined;
      });
      mount();
      const c = await card();
      expect(await within(c).findByText('The detailed checklist for this shift isn’t available.')).toBeInTheDocument();
      expect(within(c).getByText('1 / 3 places filled')).toBeInTheDocument();
      expect(within(c).queryByText(/No operational workspace/)).toBeNull();
      expect(within(c).getAllByText('Not available for this shift')).toHaveLength(6);
      expect(within(c).queryByText('Open staffing pipeline')).toBeNull();
      expect(pipelineCalls()).toBe(1); // a permanent 404 is not retried
    });

    it('a user without a workspace: the server’s own refusal is shown as "no operational workspace", with no Retry', async () => {
      serve((url) => (url === '/shifts' ? refusal(403, 'Complete your Workspace setup before creating this — your account has no private Workspace yet.') : undefined));
      mount();
      const c = await card();
      expect(await within(c).findByText('No operational workspace is available for your account yet.')).toBeInTheDocument();
      expect(within(c).queryByRole('button', { name: 'Retry' })).toBeNull();
    });

    it('insufficient permission is not reported as a missing workspace', async () => {
      serve((url) => (url === '/shifts' ? refusal(403, 'Permission required.') : undefined));
      mount();
      const c = await card();
      expect(await within(c).findByText('You don’t have permission to view shift readiness.')).toBeInTheDocument();
      expect(within(c).queryByText(/No operational workspace/)).toBeNull();
    });

    it('a refused pipeline (403) on the caller’s own shift shows the permission message, not basic staffing', async () => {
      serve((url) => {
        if (url === '/shifts') return Promise.resolve({ data: { total: 1, data: [row({ createdBy: 'u1', requestedBy: 'vm1' })] } });
        if (url === '/shifts/sh1/pipeline') return refusal(403, 'Permission required.');
        return undefined;
      });
      mount();
      const c = await card();
      expect(await within(c).findByText('You don’t have permission to view shift readiness.')).toBeInTheDocument();
      expect(within(c).queryByText('1 / 3 places filled')).toBeNull();
    });

    it('a genuine API failure offers Retry and is never described as a workspace or permission problem', async () => {
      serve((url) => (url === '/shifts' ? Promise.reject({ response: { status: 500, data: {} } }) : undefined));
      mount();
      const c = await card();
      expect(await within(c).findByText('We couldn’t load shift readiness.')).toBeInTheDocument();
      expect(within(c).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
      expect(within(c).queryByText(/No operational workspace|permission/)).toBeNull();
    });
  });

  it('a Manager sees their workspace’s Venue managers total (invited ones included, from the server count) — never a dash when it is available', async () => {
    serve((url) => (url === '/dashboard/summary' ? Promise.resolve({ data: { ...SUMMARY, managerCount: null, venueManagerCount: 2 } }) : undefined));
    mount();
    const counts = (await screen.findByText('Venue managers')).closest('dl') as HTMLElement;
    await waitFor(() => expect(within(counts).getByText('Venue managers').parentElement).toHaveTextContent('2'));
    expect(within(counts).queryByText('Managers')).toBeNull();
  });

  it('a count the caller may not see is shown as –, never 0', async () => {
    serve((url) => (url === '/dashboard/summary' ? Promise.resolve({ data: { ...SUMMARY, managerCount: null, venueManagerCount: null } }) : undefined));
    mount();
    const label = await screen.findByText('Venue managers');
    expect(label.parentElement).toHaveTextContent('–');
  });

  it('an account switch never paints or animates the previous account’s figures into the new account', async () => {
    let who = 'u1';
    serve((url) => (url === '/dashboard/summary' ? Promise.resolve({ data: { ...SUMMARY, staffCount: who === 'u1' ? 12 : 3 } }) : undefined));
    act(() => applyIdentityFromServer({ userId: 'u1', sessionId: 's1' }));
    mount();
    const staff = () => (screen.getByText('Staff').parentElement as HTMLElement);
    await waitFor(() => expect(staff().querySelector('dd [data-value]')).toHaveAttribute('data-value', '12'));
    who = 'u2';
    act(() => applyIdentityFromServer({ userId: 'u2', sessionId: 's2' }));
    // The very next paint after the switch shows nothing of u1 …
    expect(screen.queryByText('12')).toBeNull();
    // … and u2's own figure loads fresh (requested again, counted up from 0, never from 12).
    await waitFor(() => expect(staff().querySelector('dd [data-value]')).toHaveAttribute('data-value', '3'));
    expect(mockApi.get.mock.calls.filter(([u]) => u === '/dashboard/summary').length).toBeGreaterThanOrEqual(2);
    act(() => markUnauthenticated());
  });
});


describe('Dashboard — Phase C1 paging (limit ≤ 200; nothing in range is truncated)', () => {
  beforeEach(() => mockApi.get.mockReset());
  /** A paged endpoint honouring `page`/`limit` like the server (`limit > 200` is a 400). */
  function paged<T>(rows: T[]) {
    return (params: Record<string, unknown>) => {
      const limit = Number(params.limit ?? 50);
      if (limit > 200) return Promise.reject({ response: { status: 400, data: { message: 'limit must not be greater than 200' } } });
      const page = Number(params.page ?? 1);
      return Promise.resolve({ data: { data: rows.slice((page - 1) * limit, page * limit), total: rows.length } });
    };
  }
  const listCalls = (url: string) => mockApi.get.mock.calls.filter(([u]: [string]) => u === url).map(([, c]: [string, { params?: Record<string, unknown> }]) => c?.params ?? {});

  it('hours worked walks every page of attendance (250 records → pages 1 and 2 of 200), counting all of them', async () => {
    const today = new Date();
    const rows = Array.from({ length: 250 }, (_, i) => ({ id: `a${i}`, clockInAt: today.toISOString(), workedMinutes: 60 }));
    const attendance = paged(rows);
    serve((url, params) => (url === '/attendance' ? attendance(params) : undefined));
    mount();
    const card = (await screen.findByText('Hours worked')).closest('.dash-card') as HTMLElement;
    // 250 one-hour records all on today: 250.0 h for the one day worked — the second page is included.
    await waitFor(() => expect(within(card).getByText('250.0')).toBeInTheDocument());
    expect(listCalls('/attendance').map((p) => [p.page, p.limit])).toEqual([[1, 200], [2, 200]]);
  });

  it('every list request names a limit of at most 200', async () => {
    serve();
    mount();
    await screen.findByText('Shifts by venue');
    await waitFor(() => expect(listCalls('/venues').length).toBeGreaterThan(0));
    for (const url of ['/attendance', '/shifts', '/venues', '/offers']) {
      for (const params of listCalls(url)) {
        expect(params.limit).toBeDefined();
        expect(Number(params.limit)).toBeLessThanOrEqual(200);
      }
    }
  });
});
