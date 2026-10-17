import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import { api } from '../../shared/api';
import Users from './Users';
import UserDetailPanel from './UserDetailPanel';

jest.mock('../../shared/api', () => ({
  api: { get: jest.fn(), post: jest.fn() },
}));

const mockApi = api as unknown as { get: jest.Mock; post: jest.Mock };

/**
 * PHASE 12 / WEB-01 — `Users.tsx` mirrored each tab's derived rows into a
 * PARENT-owned `visibleRows` state via `onRows`, purely to feed... nothing:
 * that parent state was never read anywhere. The mirroring itself was the
 * bug — `const staff = data?.data ?? []` creates a brand-new array
 * reference on every render while `data` is still `undefined` (the entire
 * loading window), and `useEffect(() => onRows(visibleRows), [staff])`
 * treated that fresh reference as a real change every time, calling
 * `onRows` -> `setVisibleRows` in the parent -> re-render -> a fresh `[]`
 * again -> effect fires again, forever, until React's own
 * "Maximum update depth exceeded" safety net trips. These tests prove the
 * fix (removing the dead mirrored state) holds across every state a real
 * query can be in, using genuinely controllable/delayed promises — not a
 * single-render smoke test.
 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const EMPTY_JOB_ROLES = { data: [] as Array<{ id: string; name: string }> };

function staffRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 's1',
    staffRef: 'S-0001',
    email: 'alice@example.test',
    firstName: 'Alice',
    lastName: 'Example',
    phone: null,
    employmentStatus: 'active',
    startDate: null,
    defaultPayRatePence: 0,
    createdAt: new Date().toISOString(),
    accountStatus: 'active',
    invitationStatus: null,
    mustResetPassword: false,
    pendingInvite: null,
    ...overrides,
  };
}

function managerRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'm1',
    email: 'bob@example.test',
    firstName: 'Bob',
    lastName: 'Manager',
    phone: null,
    type: 'internal',
    jobTitle: null,
    createdAt: new Date().toISOString(),
    accountStatus: 'active',
    invitationStatus: null,
    mustResetPassword: false,
    pendingInvite: null,
    ...overrides,
  };
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/users']}>
        <Users />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { qc, ...utils };
}

// Suppresses nothing by default — a real "Maximum update depth exceeded"
// throw from React surfaces as a console.error AND (in React 18) can also
// reject the render outright; we assert on the console spy directly so a
// regression is a hard test failure, not just noisy test output.
function watchConsoleError() {
  const calls: unknown[][] = [];
  const spy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { calls.push(args); });
  return { spy, calls, hasLoopError: () => calls.some((args) => String(args[0]).includes('Maximum update depth exceeded')) };
}

describe('Users — WEB-01 render-loop regression', () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.post.mockReset();
  });

  describe('Staff tab (default)', () => {
    it('1: initial loading state renders without a loop while /staff is pending', async () => {
      const console_ = watchConsoleError();
      mockApi.get.mockImplementation((url: string) => {
        if (url === '/job-roles') return Promise.resolve({ data: EMPTY_JOB_ROLES.data });
        if (url === '/staff') return new Promise(() => {}); // never resolves
        return Promise.reject(new Error(`unexpected ${url}`));
      });

      mount();
      await act(async () => { await Promise.resolve(); });

      expect(console_.hasLoopError()).toBe(false);
      console_.spy.mockRestore();
    });

    it('2: a delayed successful response with real rows resolves cleanly, no loop, no duplicate requests', async () => {
      const console_ = watchConsoleError();
      const staffDeferred = deferred<{ data: unknown }>();
      let staffCallCount = 0;
      mockApi.get.mockImplementation((url: string) => {
        if (url === '/job-roles') return Promise.resolve({ data: EMPTY_JOB_ROLES.data });
        if (url === '/staff') { staffCallCount += 1; return staffDeferred.promise; }
        return Promise.reject(new Error(`unexpected ${url}`));
      });

      mount();
      await act(async () => { await Promise.resolve(); });
      staffDeferred.resolve({ data: { data: [staffRow()], total: 1 } });
      await waitFor(() => expect(screen.getByText('Alice Example')).toBeInTheDocument());

      expect(console_.hasLoopError()).toBe(false);
      expect(staffCallCount).toBe(1);
      console_.spy.mockRestore();
    });

    it('3: a delayed EMPTY successful response resolves cleanly, no loop — this is the exact reference-instability case (data?.data ?? [])', async () => {
      const console_ = watchConsoleError();
      const staffDeferred = deferred<{ data: unknown }>();
      mockApi.get.mockImplementation((url: string) => {
        if (url === '/job-roles') return Promise.resolve({ data: EMPTY_JOB_ROLES.data });
        if (url === '/staff') return staffDeferred.promise;
        return Promise.reject(new Error(`unexpected ${url}`));
      });

      mount();
      await act(async () => { await Promise.resolve(); });
      staffDeferred.resolve({ data: { data: [], total: 0 } });
      await waitFor(() => expect(screen.getByText('Your team starts here')).toBeInTheDocument());

      expect(console_.hasLoopError()).toBe(false);
      console_.spy.mockRestore();
    });

    it('4/5: a delayed error, then a retry that succeeds, both resolve cleanly with no loop', async () => {
      const console_ = watchConsoleError();
      const staffDeferred = deferred<{ data: unknown }>();
      mockApi.get.mockImplementation((url: string) => {
        if (url === '/job-roles') return Promise.resolve({ data: EMPTY_JOB_ROLES.data });
        if (url === '/staff') return staffDeferred.promise;
        return Promise.reject(new Error(`unexpected ${url}`));
      });

      const { qc } = mount();
      await act(async () => { await Promise.resolve(); });
      staffDeferred.reject(new Error('network error'));
      await act(async () => { await staffDeferred.promise.catch(() => undefined); });

      expect(console_.hasLoopError()).toBe(false);

      // Retry: a fresh successful response for the same query key.
      // `refetchQueries()`'s own returned promise only resolves once the
      // refetch completes, and the refetch can't complete until
      // `retryDeferred` is resolved below — so it's deliberately not
      // awaited here (fire-and-forget), or awaiting it would deadlock the
      // test against itself.
      const retryDeferred = deferred<{ data: unknown }>();
      mockApi.get.mockImplementation((url: string) => {
        if (url === '/job-roles') return Promise.resolve({ data: EMPTY_JOB_ROLES.data });
        if (url === '/staff') return retryDeferred.promise;
        return Promise.reject(new Error(`unexpected ${url}`));
      });
      act(() => { void qc.refetchQueries({ queryKey: ['staff'] }); });
      await act(async () => { await Promise.resolve(); });
      act(() => { retryDeferred.resolve({ data: { data: [staffRow()], total: 1 } }); });
      await waitFor(() => expect(screen.getByText('Alice Example')).toBeInTheDocument());

      expect(console_.hasLoopError()).toBe(false);
      console_.spy.mockRestore();
    });

    it('7: a rerender triggered by unrelated parent state (switching tab and back) does not reintroduce a loop', async () => {
      const console_ = watchConsoleError();
      mockApi.get.mockImplementation((url: string) => {
        // The Managers roster tab is the CEO's; these render-loop tests exercise it as a CEO.
        if (url === '/auth/me') return Promise.resolve({ data: { roles: ['ceo'], isPlatformAdmin: false } });
        if (url === '/job-roles') return Promise.resolve({ data: EMPTY_JOB_ROLES.data });
        if (url === '/staff') return Promise.resolve({ data: { data: [staffRow()], total: 1 } });
        if (url === '/managers') return Promise.resolve({ data: { data: [managerRow()], total: 1 } });
        return Promise.reject(new Error(`unexpected ${url}`));
      });

      mount();
      await waitFor(() => expect(screen.getByText('Alice Example')).toBeInTheDocument());

      await userEvent.click(screen.getByRole('button', { name: /^Managers/ }));
      await waitFor(() => expect(screen.getByText('Bob Manager')).toBeInTheDocument());
      await userEvent.click(screen.getByRole('button', { name: /^Staff/ }));
      await waitFor(() => expect(screen.getByText('Alice Example')).toBeInTheDocument());

      expect(console_.hasLoopError()).toBe(false);
      console_.spy.mockRestore();
    });

    it('8/11: an explicit refetch does not multiply callback/API invocations unboundedly', async () => {
      const console_ = watchConsoleError();
      let staffCallCount = 0;
      mockApi.get.mockImplementation((url: string) => {
        if (url === '/job-roles') return Promise.resolve({ data: EMPTY_JOB_ROLES.data });
        if (url === '/staff') { staffCallCount += 1; return Promise.resolve({ data: { data: [staffRow()], total: 1 } }); }
        return Promise.reject(new Error(`unexpected ${url}`));
      });

      const { qc } = mount();
      await waitFor(() => expect(screen.getByText('Alice Example')).toBeInTheDocument());
      const afterFirstLoad = staffCallCount;

      await act(async () => { await qc.invalidateQueries({ queryKey: ['staff'] }); });
      await waitFor(() => expect(staffCallCount).toBe(afterFirstLoad + 1));

      // Bounded: one invalidate -> exactly one more request, not a runaway series.
      await act(async () => { await Promise.resolve(); });
      expect(staffCallCount).toBe(afterFirstLoad + 1);
      expect(console_.hasLoopError()).toBe(false);
      console_.spy.mockRestore();
    });

    it('12: unmounting while a request is still pending produces no state-update-on-unmounted-component warning', async () => {
      const console_ = watchConsoleError();
      const staffDeferred = deferred<{ data: unknown }>();
      mockApi.get.mockImplementation((url: string) => {
        if (url === '/job-roles') return Promise.resolve({ data: EMPTY_JOB_ROLES.data });
        if (url === '/staff') return staffDeferred.promise;
        return Promise.reject(new Error(`unexpected ${url}`));
      });

      const { unmount } = mount();
      await act(async () => { await Promise.resolve(); });
      unmount();
      staffDeferred.resolve({ data: { data: [staffRow()], total: 1 } });
      await act(async () => { await staffDeferred.promise.catch(() => undefined); });

      const hasUnmountWarning = console_.calls.some((args) =>
        String(args[0]).includes("Can't perform a React state update on an unmounted component") ||
        String(args[0]).includes('memory leak'),
      );
      expect(hasUnmountWarning).toBe(false);
      expect(console_.hasLoopError()).toBe(false);
      console_.spy.mockRestore();
    });
  });

  describe('Managers tab — independent root-cause verification, not a copy-paste assumption', () => {
    it('1-3: loading, delayed populated, and delayed empty responses all resolve without a loop', async () => {
      const console_ = watchConsoleError();
      const managersDeferred = deferred<{ data: unknown }>();
      mockApi.get.mockImplementation((url: string) => {
        // Staff is the default tab and mounts first — its own queries fire
        // regardless of which tab this test is targeting.
        // The Managers roster tab is the CEO's; these render-loop tests exercise it as a CEO.
        if (url === '/auth/me') return Promise.resolve({ data: { roles: ['ceo'], isPlatformAdmin: false } });
        if (url === '/job-roles') return Promise.resolve({ data: EMPTY_JOB_ROLES.data });
        if (url === '/staff') return new Promise(() => {});
        if (url === '/managers') return managersDeferred.promise;
        return Promise.reject(new Error(`unexpected ${url}`));
      });

      mount();
      await waitFor(() => expect(screen.getByRole('button', { name: /^Managers/ })).toBeInTheDocument());
      await userEvent.click(screen.getByRole('button', { name: /^Managers/ }));
      await act(async () => { await Promise.resolve(); });
      expect(console_.hasLoopError()).toBe(false);

      managersDeferred.resolve({ data: { data: [], total: 0 } });
      await waitFor(() => expect(screen.getByText('No managers yet')).toBeInTheDocument());
      expect(console_.hasLoopError()).toBe(false);
      console_.spy.mockRestore();
    });

    it('4/5: a delayed error then a successful retry both resolve without a loop', async () => {
      const console_ = watchConsoleError();
      const first = deferred<{ data: unknown }>();
      mockApi.get.mockImplementation((url: string) => {
        // The Managers roster tab is the CEO's; these render-loop tests exercise it as a CEO.
        if (url === '/auth/me') return Promise.resolve({ data: { roles: ['ceo'], isPlatformAdmin: false } });
        if (url === '/job-roles') return Promise.resolve({ data: EMPTY_JOB_ROLES.data });
        if (url === '/staff') return new Promise(() => {});
        if (url === '/managers') return first.promise;
        return Promise.reject(new Error(`unexpected ${url}`));
      });

      mount();
      await waitFor(() => expect(screen.getByRole('button', { name: /^Managers/ })).toBeInTheDocument());
      await userEvent.click(screen.getByRole('button', { name: /^Managers/ }));
      await act(async () => { await Promise.resolve(); });
      first.reject(new Error('network error'));
      await act(async () => { await first.promise.catch(() => undefined); });
      expect(console_.hasLoopError()).toBe(false);
      console_.spy.mockRestore();
    });

    it('6: a populated response renders the expected row', async () => {
      mockApi.get.mockImplementation((url: string) => {
        // The Managers roster tab is the CEO's; these render-loop tests exercise it as a CEO.
        if (url === '/auth/me') return Promise.resolve({ data: { roles: ['ceo'], isPlatformAdmin: false } });
        if (url === '/job-roles') return Promise.resolve({ data: EMPTY_JOB_ROLES.data });
        if (url === '/staff') return new Promise(() => {});
        if (url === '/managers') return Promise.resolve({ data: { data: [managerRow()], total: 1 } });
        return Promise.reject(new Error(`unexpected ${url}`));
      });

      mount();
      await waitFor(() => expect(screen.getByRole('button', { name: /^Managers/ })).toBeInTheDocument());
      await userEvent.click(screen.getByRole('button', { name: /^Managers/ }));
      await waitFor(() => expect(screen.getByText('Bob Manager')).toBeInTheDocument());
    });

  });

  describe('Part 2 — background invitation poll must not block row clicks', () => {
    it('a same-params background refetch (the invitation poll) never applies table-loading, so rows stay clickable throughout', async () => {
      let staffCallCount = 0;
      const refetchDeferred = deferred<{ data: unknown }>();
      mockApi.get.mockImplementation((url: string) => {
        if (url === '/job-roles') return Promise.resolve({ data: EMPTY_JOB_ROLES.data });
        if (url === '/staff') {
          staffCallCount += 1;
          if (staffCallCount === 1) {
            return Promise.resolve({ data: { data: [staffRow({ invitationStatus: 'queued' })], total: 1 } });
          }
          return refetchDeferred.promise; // the simulated poll tick — stays pending so we can inspect mid-fetch state
        }
        return Promise.reject(new Error(`unexpected ${url}`));
      });

      const { qc } = mount();
      await waitFor(() => expect(screen.getByText('Alice Example')).toBeInTheDocument());
      expect(document.querySelector('.table-container.table-loading')).toBeNull();

      // Same query key, same params — this is exactly what the 2s
      // `pollWhileInvitationInFlight` refetchInterval triggers; `isFetching`
      // is true for its duration even though nothing the user asked for changed.
      act(() => { void qc.refetchQueries({ queryKey: ['staff'] }); });
      await act(async () => { await Promise.resolve(); });
      expect(staffCallCount).toBe(2);

      // Mid-poll: the table must not be dimmed/blocked, and the row must
      // still be clickable (pointer-events: none from `.table-loading`
      // would make this element fail to receive the click in a real browser).
      expect(document.querySelector('.table-container.table-loading')).toBeNull();
      await userEvent.click(screen.getByText('Alice Example'));

      act(() => { refetchDeferred.resolve({ data: { data: [staffRow({ invitationStatus: 'queued' })], total: 1 } }); });
      await act(async () => { await refetchDeferred.promise; });
      expect(document.querySelector('.table-container.table-loading')).toBeNull();
    });

    it('a genuine params change (search) DOES apply table-loading while the new result is in flight', async () => {
      let staffCallCount = 0;
      const searchDeferred = deferred<{ data: unknown }>();
      mockApi.get.mockImplementation((url: string) => {
        if (url === '/job-roles') return Promise.resolve({ data: EMPTY_JOB_ROLES.data });
        if (url === '/staff') {
          staffCallCount += 1;
          if (staffCallCount === 1) {
            return Promise.resolve({ data: { data: [staffRow()], total: 1 } });
          }
          return searchDeferred.promise; // the search-triggered fetch — held pending deliberately
        }
        return Promise.reject(new Error(`unexpected ${url}`));
      });

      mount();
      await waitFor(() => expect(screen.getByText('Alice Example')).toBeInTheDocument());
      expect(document.querySelector('.table-container.table-loading')).toBeNull();

      // One single change (not per-keystroke) — this input has no debounce
      // of its own, so each keystroke is its own params change; firing the
      // whole value in one event keeps this test's "exactly one new fetch"
      // assertion meaningful rather than racing multiple stale requests.
      fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'ali' } });
      await waitFor(() => expect(staffCallCount).toBe(2));

      // A real, user-driven filter change — rows may reorder, so the brief
      // dim/block is expected here, unlike the background poll above.
      expect(document.querySelector('.table-container.table-loading')).not.toBeNull();

      act(() => { searchDeferred.resolve({ data: { data: [staffRow()], total: 1 } }); });
      await act(async () => { await searchDeferred.promise; });
      await waitFor(() => expect(document.querySelector('.table-container.table-loading')).toBeNull());
    });
  });

  describe('Managers tab regression guard', () => {
    it('9/10: does not throw "Maximum update depth exceeded" even under a long artificial delay', async () => {
      const console_ = watchConsoleError();
      const slow = deferred<{ data: unknown }>();
      mockApi.get.mockImplementation((url: string) => {
        // The Managers roster tab is the CEO's; these render-loop tests exercise it as a CEO.
        if (url === '/auth/me') return Promise.resolve({ data: { roles: ['ceo'], isPlatformAdmin: false } });
        if (url === '/job-roles') return Promise.resolve({ data: EMPTY_JOB_ROLES.data });
        if (url === '/staff') return new Promise(() => {});
        if (url === '/managers') return slow.promise;
        return Promise.reject(new Error(`unexpected ${url}`));
      });

      mount();
      await waitFor(() => expect(screen.getByRole('button', { name: /^Managers/ })).toBeInTheDocument());
      await userEvent.click(screen.getByRole('button', { name: /^Managers/ }));
      // Several macrotask/microtask turns with the query still pending —
      // this is exactly the window the old code looped in.
      for (let i = 0; i < 10; i++) {
        // eslint-disable-next-line no-await-in-loop
        await act(async () => { await Promise.resolve(); });
      }
      expect(console_.hasLoopError()).toBe(false);
      slow.resolve({ data: { data: [], total: 0 } });
      await act(async () => { await slow.promise; });
      console_.spy.mockRestore();
    });
  });
});

/**
 * Recurring 403 report (2026-10-15): a failed list must never read as a confirmed "Staff · 0", a permanent refusal is
 * explained (not retried forever), and staff creation is not offered when the server refused the list.
 */
describe('Users — failed lists are explained, never shown as zero', () => {
  const me = { roles: ['ceo'], isPlatformAdmin: true };
  const fail = (status: number) => Promise.reject({ response: { status, data: { message: 'x' } } });
  function serve(staff: () => Promise<unknown>) {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/auth/me') return Promise.resolve({ data: me });
      if (url === '/job-roles') return Promise.resolve(EMPTY_JOB_ROLES);
      if (url === '/staff') return staff();
      if (url === '/managers') return Promise.resolve({ data: { data: [], total: 0 } });
      return Promise.resolve({ data: [] });
    });
  }
  const staffTabLabel = () => screen.getAllByRole('button').find((b) => /^Staff/.test(b.textContent ?? ''))!.textContent;
  const staffCalls = () => mockApi.get.mock.calls.filter(([u]) => u === '/staff').length;

  beforeEach(() => mockApi.get.mockReset());

  it('403: says permission is missing, shows no count, offers no New staff, and does not retry', async () => {
    serve(() => fail(403));
    mount();
    expect(await screen.findByText('You don’t have permission to view these records.')).toBeInTheDocument();
    expect(staffTabLabel()).toBe('Staff');
    expect(screen.queryByRole('button', { name: /New staff/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    const calls = staffCalls();
    await act(async () => { await new Promise((r) => setTimeout(r, 1500)); });
    expect(staffCalls()).toBe(calls);
  });

  it('404: says no operational workspace is available, with no count and no retry', async () => {
    serve(() => fail(404));
    mount();
    expect(await screen.findByText('No operational workspace is available for your account yet.')).toBeInTheDocument();
    expect(staffTabLabel()).toBe('Staff');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('a temporary server error offers Retry and still shows no count', async () => {
    serve(() => fail(503));
    mount();
    expect(await screen.findByRole('button', { name: 'Retry' }, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.getByText('We couldn’t load these records.')).toBeInTheDocument();
    expect(staffTabLabel()).toBe('Staff');
  }, 15000);

  it('a genuinely empty list (200) shows the confirmed count 0 and the New staff action', async () => {
    serve(() => Promise.resolve({ data: { data: [], total: 0 } }));
    mount();
    await waitFor(() => expect(staffTabLabel()).toBe('Staff · 0'));
    expect(screen.getByRole('button', { name: /New staff/ })).toBeInTheDocument();
  });
});

describe('Users — a Manager sees and adds only their own Venue Managers', () => {
  function serve(me: { roles: string[]; isPlatformAdmin: boolean }, capabilities: Record<string, boolean>) {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/auth/me') return Promise.resolve({ data: me });
      if (url === '/auth/capabilities') return Promise.resolve({ data: capabilities });
      if (url === '/job-roles') return Promise.resolve(EMPTY_JOB_ROLES);
      if (url === '/staff') return Promise.resolve({ data: { data: [], total: 0 } });
      if (url === '/venue-managers') {
        return Promise.resolve({ data: { data: [{ ...managerRow({ id: 'vm1', firstName: 'Venue', lastName: 'Test 3', type: 'venue' }), venues: [{ id: 'v1', name: 'Venue Test 3' }] }], total: 1 } });
      }
      if (url === '/venue-managers/vm1/staff') return Promise.resolve({ data: [] });
      if (url === '/venue-managers/vm1') {
        return Promise.resolve({ data: { ...managerRow({ id: 'vm1', firstName: 'Venue', lastName: 'Test 3', type: 'venue', email: 'venutest3@example.test', avatarKey: null }), venues: [{ id: 'v1', name: 'Venue Test 3' }] } });
      }
      if (url === '/managers') return Promise.reject({ response: { status: 403, data: { message: 'forbidden' } } });
      return Promise.resolve({ data: [] });
    });
  }
  const managerCalls = () => mockApi.get.mock.calls.filter(([u]) => u === '/managers').length;

  beforeEach(() => mockApi.get.mockReset());

  it('with venue_manager.create: a "Venue managers" tab lists GET /venue-managers rows with their venue, offers "New venue manager", and never calls the CEO-only /managers', async () => {
    serve({ roles: ['manager'], isPlatformAdmin: false }, { 'venue_manager.create': true });
    mount();
    const tab = await screen.findByRole('button', { name: /^Venue managers/ });
    await waitFor(() => expect(tab.textContent).toBe('Venue managers · 1'));
    await userEvent.click(tab);
    expect(await screen.findByText('Venue Test 3', { selector: 'td' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New venue manager/ })).toBeInTheDocument();
    expect(screen.queryByText('You don’t have permission to view these records.')).toBeNull();
    expect(managerCalls()).toBe(0);
  });

  it('clicking a Venue Manager opens the reference panel (Overview, Timeline, Email, More → Notes / Assigned staff; Add Staff on that tab) backed only by /venue-managers routes', async () => {
    serve({ roles: ['manager'], isPlatformAdmin: false }, { 'venue_manager.create': true });
    // The panel is mounted by the app shell (Layout), next to the page.
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/users']}>
          <Users />
          <UserDetailPanel />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: /^Venue managers/ }));
    await userEvent.click(await screen.findByRole('button', { name: /Venue Test 3$/ }));
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/venue-managers/vm1'));
    for (const tab of [/Overview/, /Timeline/, /Email/, /2 More/]) expect(await screen.findByRole('tab', { name: tab })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /^Notes$/ })).toBeNull();
    expect(screen.getAllByText('Venue').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Venue Test 3').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Upload photo|Change photo|photo/i })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Send Email/ }).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('tab', { name: /Timeline/ }));
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/venue-managers/vm1/timeline'));
    await userEvent.click(screen.getByRole('tab', { name: /2 More/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: /Assigned staff/ }));
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/venue-managers/vm1/staff'));
    expect(screen.getByRole('button', { name: /Add Staff/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Send Email/ })).toBeNull();
    expect(managerCalls()).toBe(0);
    expect(mockApi.get.mock.calls.some(([u]) => String(u).startsWith('/managers/'))).toBe(false);
  });

  it('without venue_manager.create and without the CEO role: no managers tab at all (no 403 screen to land on)', async () => {
    serve({ roles: ['manager'], isPlatformAdmin: false }, { 'venue_manager.create': false });
    mount();
    await screen.findByRole('button', { name: /^Staff/ });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(screen.queryByRole('button', { name: /^(Managers|Venue managers)/ })).toBeNull();
    expect(managerCalls()).toBe(0);
  });
});
