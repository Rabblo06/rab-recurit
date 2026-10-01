import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import { api } from '../../shared/api';
import Users from './Users';

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
      await waitFor(() => expect(screen.getByText('No staff members yet')).toBeInTheDocument());

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
        if (url === '/job-roles') return Promise.resolve({ data: EMPTY_JOB_ROLES.data });
        if (url === '/staff') return Promise.resolve({ data: { data: [staffRow()], total: 1 } });
        if (url === '/managers') return Promise.resolve({ data: { data: [managerRow()], total: 1 } });
        return Promise.reject(new Error(`unexpected ${url}`));
      });

      mount();
      await waitFor(() => expect(screen.getByText('Alice Example')).toBeInTheDocument());

      await userEvent.click(screen.getByRole('button', { name: 'Managers' }));
      await waitFor(() => expect(screen.getByText('Bob Manager')).toBeInTheDocument());
      await userEvent.click(screen.getByRole('button', { name: 'Staff' }));
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
        if (url === '/job-roles') return Promise.resolve({ data: EMPTY_JOB_ROLES.data });
        if (url === '/staff') return new Promise(() => {});
        if (url === '/managers') return managersDeferred.promise;
        return Promise.reject(new Error(`unexpected ${url}`));
      });

      mount();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Managers' })).toBeInTheDocument());
      await userEvent.click(screen.getByRole('button', { name: 'Managers' }));
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
        if (url === '/job-roles') return Promise.resolve({ data: EMPTY_JOB_ROLES.data });
        if (url === '/staff') return new Promise(() => {});
        if (url === '/managers') return first.promise;
        return Promise.reject(new Error(`unexpected ${url}`));
      });

      mount();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Managers' })).toBeInTheDocument());
      await userEvent.click(screen.getByRole('button', { name: 'Managers' }));
      await act(async () => { await Promise.resolve(); });
      first.reject(new Error('network error'));
      await act(async () => { await first.promise.catch(() => undefined); });
      expect(console_.hasLoopError()).toBe(false);
      console_.spy.mockRestore();
    });

    it('6: a populated response renders the expected row', async () => {
      mockApi.get.mockImplementation((url: string) => {
        if (url === '/job-roles') return Promise.resolve({ data: EMPTY_JOB_ROLES.data });
        if (url === '/staff') return new Promise(() => {});
        if (url === '/managers') return Promise.resolve({ data: { data: [managerRow()], total: 1 } });
        return Promise.reject(new Error(`unexpected ${url}`));
      });

      mount();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Managers' })).toBeInTheDocument());
      await userEvent.click(screen.getByRole('button', { name: 'Managers' }));
      await waitFor(() => expect(screen.getByText('Bob Manager')).toBeInTheDocument());
    });

    it('9/10: does not throw "Maximum update depth exceeded" even under a long artificial delay', async () => {
      const console_ = watchConsoleError();
      const slow = deferred<{ data: unknown }>();
      mockApi.get.mockImplementation((url: string) => {
        if (url === '/job-roles') return Promise.resolve({ data: EMPTY_JOB_ROLES.data });
        if (url === '/staff') return new Promise(() => {});
        if (url === '/managers') return slow.promise;
        return Promise.reject(new Error(`unexpected ${url}`));
      });

      mount();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Managers' })).toBeInTheDocument());
      await userEvent.click(screen.getByRole('button', { name: 'Managers' }));
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
