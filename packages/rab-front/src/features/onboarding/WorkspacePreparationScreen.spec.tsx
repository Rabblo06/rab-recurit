import { StrictMode } from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import WorkspacePreparationScreen, { MIN_ANIMATION_MS, READY_BEAT_MS, SLOW_THRESHOLD_MS } from './WorkspacePreparationScreen';
import { api } from '../../shared/api';
import { markUnauthenticated } from '../../shared/lib/auth-session';
import {
  markPendingManagerWelcome,
  markSelfServiceWorkspace,
  PENDING_MANAGER_WELCOME_KEY,
  SELF_SERVICE_WORKSPACE_KEY,
} from './onboardingMotion';

jest.mock('../../shared/api', () => ({
  api: { get: jest.fn(), post: jest.fn() },
  broadcastLogout: jest.fn(),
  withAuthLock: jest.fn((fn: () => Promise<unknown>) => fn()),
}));
jest.mock('../../shared/lib/auth-session', () => ({ markUnauthenticated: jest.fn() }));

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
let currentStatus: string | null = 'READY';

function workspaceResponse(schemaStatus: string | null) {
  return {
    id: 'ws-1', name: 'Northside Staffing', subdomain: 'northside', logoKey: null,
    status: 'active', schemaStatus, onboardingCompletedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
}

function mockServer(initial: string | null) {
  currentStatus = initial;
  get.mockImplementation((url: string) => {
    if (url.startsWith('/manager-workspaces/me')) return Promise.resolve({ data: workspaceResponse(currentStatus) });
    if (url === '/profile') {
      return Promise.resolve({ data: { id: 'u-1', email: 'jamie@example.com', firstName: 'Jamie', lastName: 'Rivers', jobTitle: null, avatarKey: null } });
    }
    throw new Error(`unexpected GET ${url}`);
  });
}

function tree(qc: QueryClient) {
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/onboarding/preparing']}>
        <Routes>
          <Route path="/onboarding/preparing" element={<WorkspacePreparationScreen />} />
          <Route path="/" element={<div>DASHBOARD</div>} />
          <Route path="/login" element={<div>LOGIN</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function mount({ strict = false } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(strict ? <StrictMode>{tree(qc)}</StrictMode> : tree(qc));
  // React Query notifies through chained zero-delay timers; settle them before the clock starts.
  for (let i = 0; i < 3; i++) await advance(0);
  return { ...utils, qc };
}

/**
 * Advances the fake clock in 100ms slices, each in its own `act()`: one big `act()` would defer
 * every intermediate render (and the effects that arm follow-up timers) to its very end, which a
 * real browser never does. Each slice also settles React/React Query's zero-delay hops.
 */
async function advance(ms: number) {
  let remaining = ms;
  do {
    const slice = Math.min(remaining, 250);
    await act(async () => { await jest.advanceTimersByTimeAsync(slice); });
    await act(async () => { await jest.advanceTimersByTimeAsync(0); });
    remaining -= slice;
  } while (remaining > 0);
}

jest.setTimeout(30_000);

function stepStates() {
  return Array.from(document.querySelectorAll('.preparation-step')).map((el) => el.getAttribute('data-state'));
}

/** The welcome heading is split word-by-word into spans; match on the combined text. */
function headingText(text: string) {
  return (_content: string, element: Element | null) => {
    if (!element) return false;
    const normalize = (el: Element) => el.textContent?.replace(/\s+/g, ' ').trim();
    if (normalize(element) !== text) return false;
    return Array.from(element.children).every((child) => normalize(child) !== text);
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  get.mockReset();
  post.mockReset();
  post.mockResolvedValue({ data: undefined });
  sessionStorage.clear();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('staged checklist choreography', () => {
  it('starts with only the first step active — nothing is shown complete at the beginning', async () => {
    markPendingManagerWelcome('ws-1');
    mockServer('READY');
    await mount();
    expect(screen.getByText('Preparing your workspace')).toBeInTheDocument();
    expect(stepStates()).toEqual(['current', 'pending', 'pending']);
  });

  it('advances one step every 2s, and the final checkmark appears only because READY is real', async () => {
    markPendingManagerWelcome('ws-1');
    mockServer('READY');
    await mount();
    await advance(2_000);
    expect(stepStates()).toEqual(['complete', 'current', 'pending']);
    await advance(2_000);
    expect(stepStates()).toEqual(['complete', 'complete', 'current']);
    await advance(2_000);
    expect(stepStates()).toEqual(['complete', 'complete', 'complete']);
  });

  it('never ticks the final step while the backend is still CREATING', async () => {
    markPendingManagerWelcome('ws-1');
    mockServer('CREATING');
    await mount();
    await advance(MIN_ANIMATION_MS + 500);
    expect(stepStates()).toEqual(['complete', 'complete', 'current']);
    expect(screen.getByText('Almost there — just finishing up.')).toBeInTheDocument();
    expect(screen.queryByText('DASHBOARD')).toBeNull();
  });
});

describe('eight-second minimum', () => {
  it('READY before 8s: plays the remainder of the animation, then the welcome appears at 8s', async () => {
    markPendingManagerWelcome('ws-1');
    mockServer('READY');
    await mount();
    await advance(MIN_ANIMATION_MS - 100);
    expect(screen.queryByText(headingText('Northside Staffing is ready'))).toBeNull();
    await advance(100);
    expect(screen.getByText(headingText('Northside Staffing is ready'))).toBeInTheDocument();
  });

  it('READY after 8s: calm waiting state, then the real checkmark, then the welcome — no reload needed', async () => {
    markPendingManagerWelcome('ws-1');
    mockServer('CREATING');
    await mount();
    await advance(12_000);
    expect(screen.queryByText(headingText('Northside Staffing is ready'))).toBeNull();
    expect(screen.getByText('Preparing your workspace')).toBeInTheDocument();

    currentStatus = 'READY';
    // Watch the next automatic poll land: the real checkmark must appear before the welcome does.
    let waited = 0;
    while (stepStates().join() !== 'complete,complete,complete' && waited < 3_000) {
      await advance(250);
      waited += 250;
    }
    expect(stepStates()).toEqual(['complete', 'complete', 'complete']);
    expect(screen.queryByText(headingText('Northside Staffing is ready'))).toBeNull();
    await advance(READY_BEAT_MS);
    expect(screen.getByText(headingText('Northside Staffing is ready'))).toBeInTheDocument();
  });

  it('runs exactly one clock under StrictMode — the welcome arrives at 8s, not later', async () => {
    markPendingManagerWelcome('ws-1');
    mockServer('READY');
    await mount({ strict: true });
    await advance(MIN_ANIMATION_MS);
    expect(screen.getByText(headingText('Northside Staffing is ready'))).toBeInTheDocument();
  });
});

describe('welcome hand-off', () => {
  it('shows the real user and workspace on the welcome overlay', async () => {
    markPendingManagerWelcome('ws-1');
    mockServer('READY');
    await mount();
    await advance(MIN_ANIMATION_MS);
    expect(screen.getByText(headingText('Northside Staffing is ready'))).toBeInTheDocument();
    expect(screen.getByText('Welcome, Jamie')).toBeInTheDocument();
  });

  it('keeps the one-time trigger until the overlay actually mounts, then consumes it', async () => {
    markPendingManagerWelcome('ws-1');
    mockServer('READY');
    await mount();
    await advance(MIN_ANIMATION_MS - 500);
    expect(sessionStorage.getItem(PENDING_MANAGER_WELCOME_KEY)).toBe('ws-1');
    await advance(500);
    expect(screen.getByText(headingText('Northside Staffing is ready'))).toBeInTheDocument();
    expect(sessionStorage.getItem(PENDING_MANAGER_WELCOME_KEY)).toBeNull();
  });

  it('leaves to the dashboard automatically and unmounts the overlay completely', async () => {
    markPendingManagerWelcome('ws-1');
    mockServer('READY');
    await mount();
    await advance(MIN_ANIMATION_MS);
    await advance(5_000);
    expect(screen.getByText('DASHBOARD')).toBeInTheDocument();
    expect(document.querySelector('.welcome-overlay')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open workspace' })).toBeNull();
  });

  it('does not replay on reload: no pending trigger + READY goes straight to the dashboard', async () => {
    mockServer('READY');
    await mount();
    expect(screen.getByText('DASHBOARD')).toBeInTheDocument();
    expect(document.querySelector('.welcome-overlay')).toBeNull();
  });

  it('a trigger for a different workspace never shows this workspace a welcome', async () => {
    markPendingManagerWelcome('someone-elses-ws');
    mockServer('READY');
    await mount();
    expect(screen.getByText('DASHBOARD')).toBeInTheDocument();
  });

  it('a missing trigger never bypasses provisioning: CREATING still waits', async () => {
    mockServer('CREATING');
    await mount();
    await advance(MIN_ANIMATION_MS);
    expect(screen.queryByText('DASHBOARD')).toBeNull();
  });

  it('leaves no timers running after unmount', async () => {
    markPendingManagerWelcome('ws-1');
    mockServer('CREATING');
    const { unmount, qc } = await mount();
    await advance(3_000);
    unmount();
    qc.clear();
    await advance(0);
    expect(jest.getTimerCount()).toBe(0);
  });
});

it('a workspace with no authoritative schema status cannot continue', async () => {
  markPendingManagerWelcome('ws-1');
  mockServer(null);
  await mount();
  expect(screen.getByText('Workspace status unavailable')).toBeInTheDocument();
  await advance(MIN_ANIMATION_MS * 2);
  expect(screen.queryByText('DASHBOARD')).toBeNull();
});

it('a CREATING workspace keeps polling automatically', async () => {
  mockServer('CREATING');
  await mount();
  const callsBefore = get.mock.calls.filter(([u]) => u.startsWith('/manager-workspaces/me')).length;
  await advance(2_500);
  expect(get.mock.calls.filter(([u]) => u.startsWith('/manager-workspaces/me')).length).toBeGreaterThan(callsBefore);
});

describe('a SUPERSEDED workspace — terminal, never a success or a bypass', () => {
  it('shows an honest "no longer valid" state, never the dashboard or a welcome', async () => {
    markPendingManagerWelcome('ws-1');
    mockServer('SUPERSEDED');
    await mount();
    await advance(MIN_ANIMATION_MS * 2);
    expect(screen.getByText('This invitation is no longer valid')).toBeInTheDocument();
    expect(screen.queryByText('DASHBOARD')).toBeNull();
    expect(screen.queryByText(headingText('Northside Staffing is ready'))).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
  });

  it('offers only Sign out, which actually runs the real logout flow', async () => {
    mockServer('SUPERSEDED');
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await advance(0);
    expect(screen.getByText('LOGIN')).toBeInTheDocument();
    expect(sessionStorage.getItem(PENDING_MANAGER_WELCOME_KEY)).toBeNull();
  });
});

describe('a FAILED workspace', () => {
  it('never shows a dashboard bypass — only a manual re-check and sign-out', async () => {
    markPendingManagerWelcome('ws-1');
    mockServer('FAILED');
    await mount();
    await advance(MIN_ANIMATION_MS * 2);
    expect(screen.getByText('We hit a snag preparing your workspace')).toBeInTheDocument();
    expect(screen.queryByText('DASHBOARD')).toBeNull();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('"Check again" re-reads real status instead of faking success', async () => {
    mockServer('FAILED');
    await mount();
    const callsBefore = get.mock.calls.filter(([u]) => u.startsWith('/manager-workspaces/me')).length;
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await advance(0);
    expect(get.mock.calls.filter(([u]) => u.startsWith('/manager-workspaces/me')).length).toBeGreaterThan(callsBefore);
    expect(screen.getByText('We hit a snag preparing your workspace')).toBeInTheDocument();
  });

  it('"Sign out" runs the real logout flow and never lands on the dashboard', async () => {
    mockServer('FAILED');
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await advance(0);
    expect(screen.getByText('LOGIN')).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith('/auth/logout');
    expect(markUnauthenticated).toHaveBeenCalled();
  });
});

describe('prolonged CREATING', () => {
  it('after the slow threshold, changes only the message — no bypass — and keeps polling', async () => {
    markPendingManagerWelcome('ws-1');
    mockServer('CREATING');
    await mount();
    await advance(SLOW_THRESHOLD_MS);
    expect(screen.getByText('Still preparing your workspace')).toBeInTheDocument();
    expect(screen.queryByText('DASHBOARD')).toBeNull();
    const callsBefore = get.mock.calls.filter(([u]) => u.startsWith('/manager-workspaces/me')).length;
    await advance(2_500);
    expect(get.mock.calls.filter(([u]) => u.startsWith('/manager-workspaces/me')).length).toBeGreaterThan(callsBefore);
  });

  it('still recovers to the welcome automatically once READY arrives', async () => {
    markPendingManagerWelcome('ws-1');
    mockServer('CREATING');
    await mount();
    await advance(SLOW_THRESHOLD_MS);
    currentStatus = 'READY';
    await advance(2_500 + READY_BEAT_MS);
    await waitFor(() => expect(screen.getByText(headingText('Northside Staffing is ready'))).toBeInTheDocument());
  });
});

it('consumes the self-service flag on mount so it never leaks into a later attempt', async () => {
  markSelfServiceWorkspace();
  mockServer('CREATING');
  await mount();
  expect(sessionStorage.getItem(SELF_SERVICE_WORKSPACE_KEY)).toBeNull();
});
