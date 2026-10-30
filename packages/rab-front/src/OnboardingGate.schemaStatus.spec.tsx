import { render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { api, bootstrapSession, resolveIdentityViaCookie } from './shared/api';
import { applyIdentityFromServer, markUnauthenticated } from './shared/lib/auth-session';

/**
 * Phase B P8 — `OnboardingGate`'s preparation redirect (owner-approved conditions):
 *  - after the existing `onboardingCompletedAt` check, redirect to /onboarding/preparing ONLY when the server-derived
 *    `workspace.schemaRequired === true` AND `schemaStatus` is CREATING or FAILED;
 *  - SUPERSEDED, null / missing status and READY never redirect; `schemaRequired` false or missing never redirects
 *    (HWS off: console access unchanged);
 *  - no redirect loop: /onboarding/preparing is outside the gate and goes back to '/' on READY;
 *  - every account that is not a workspace owner (Staff, Venue Manager, members, platform-admin-only) is unaffected, and so
 *    is a CEO whose personal workspace the server reports as not routed (`schemaRequired: false`).
 * The real gate, routes and preparation screen; only the network and the console chrome (`Layout`) are stubbed.
 */
jest.mock('./shared/api', () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn() },
  bootstrapSession: jest.fn().mockResolvedValue(false),
  observeIdentityErrors: jest.fn(() => () => undefined),
  registerStepUpHandler: jest.fn(() => () => undefined),
  withAuthLock: jest.fn((run: () => unknown) => run()),
  broadcastLogout: jest.fn(),
  broadcastLogin: jest.fn(),
  resolveIdentityViaCookie: jest.fn().mockResolvedValue(false),
  getLastMeSnapshot: jest.fn().mockReturnValue(null),
  getLastIdentityFailure: jest.fn().mockReturnValue('rejected'),
}));

// The console chrome is not under test: a marker proves the gate let the session through to it.
jest.mock('./shell/Layout', () => ({ __esModule: true, default: () => <div>CONSOLE HOME</div> }));

// App keeps one module-level QueryClient for the life of the tab. Record it so each test starts with an empty cache
// (`['me']` has a 5-minute staleTime, so a previous test's roles would otherwise leak into the next).
// Kept on globalThis: App constructs its client while the imports are evaluated, before this file's own consts exist.
jest.mock('@tanstack/react-query', () => {
  const actual = jest.requireActual('@tanstack/react-query');
  class RecordingQueryClient extends actual.QueryClient {
    constructor(...args: unknown[]) {
      super(...(args as [unknown]));
      const g = globalThis as unknown as { __a6QueryClients?: Array<{ clear(): void }> };
      (g.__a6QueryClients ??= []).push(this as unknown as { clear(): void });
    }
  }
  return { ...actual, QueryClient: RecordingQueryClient };
});
const recordedQueryClients = (): Array<{ clear(): void }> =>
  (globalThis as unknown as { __a6QueryClients?: Array<{ clear(): void }> }).__a6QueryClients ?? [];

const mockApi = api as unknown as { get: jest.Mock; post: jest.Mock; patch: jest.Mock };
const mockBootstrapSession = bootstrapSession as jest.Mock;
const mockResolveIdentityViaCookie = resolveIdentityViaCookie as jest.Mock;

type Status = 'CREATING' | 'FAILED' | 'SUPERSEDED' | 'READY' | null;

function workspace(schemaStatus: Status, schemaRequired: boolean | undefined, onboardingCompletedAt: string | null = '2026-10-29T10:00:00.000Z') {
  return {
    id: 'ws-1', name: 'Northside Staffing', subdomain: 'northside', logoKey: null, status: 'active',
    schemaStatus, onboardingCompletedAt, createdAt: '2026-10-29T09:00:00.000Z',
    ...(schemaRequired === undefined ? {} : { schemaRequired }),
  };
}

/**
 * Network stub. `ws` is the server's current answer for GET /manager-workspaces/me (any query string: the preparation
 * screen polls with `?fresh=1`); `resumeTo` is what the owner's resume re-POST turns it into (the server's new state).
 */
function serve(opts: { roles: string[]; isPlatformAdmin?: boolean; ws?: ReturnType<typeof workspace> | 'none'; resumeTo?: ReturnType<typeof workspace> }) {
  let current = opts.ws ?? 'none';
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/auth/me') return Promise.resolve({ data: { id: '1', firstName: 'Ida', roles: opts.roles, isPlatformAdmin: opts.isPlatformAdmin ?? false } });
    if (url === '/profile') return Promise.resolve({ data: { id: '1', email: 'i@example.com', firstName: 'Ida', lastName: 'M', jobTitle: null, avatarKey: null } });
    if (url.startsWith('/manager-workspaces/me')) {
      if (current === 'none') return Promise.reject(Object.assign(new Error('not found'), { response: { status: 404 } }));
      return Promise.resolve({ data: current });
    }
    return Promise.reject(new Error(`unmocked GET ${url}`));
  });
  mockApi.post.mockImplementation((url: string) => {
    if (url === '/manager-workspaces') {
      if (opts.resumeTo) current = opts.resumeTo;
      return Promise.resolve({ data: current === 'none' ? null : current });
    }
    if (url === '/auth/logout') return Promise.resolve({ data: {} });
    return Promise.reject(new Error(`unmocked POST ${url}`));
  });
}

function mountAt(path: string) {
  applyIdentityFromServer({ userId: '1', sessionId: 'session-1' });
  mockBootstrapSession.mockResolvedValue(true);
  window.history.pushState({}, '', path);
  return render(<App />);
}

const workspaceGets = () => mockApi.get.mock.calls.filter(([url]) => String(url).startsWith('/manager-workspaces/me')).length;

async function expectConsoleAt(path: string) {
  expect(await screen.findByText('CONSOLE HOME')).toBeInTheDocument();
  expect(window.location.pathname).toBe(path);
}

async function expectPreparation(status: 'CREATING' | 'FAILED') {
  const title = status === 'CREATING' ? 'Preparing your workspace' : 'We hit a snag preparing your workspace';
  expect(await screen.findByText(title)).toBeInTheDocument();
  expect(window.location.pathname).toBe('/onboarding/preparing');
  expect(screen.queryByText('CONSOLE HOME')).toBeNull();
}

beforeEach(() => {
  for (const client of recordedQueryClients()) client.clear();
  window.localStorage.clear();
  mockApi.get.mockReset();
  mockApi.post.mockReset();
  mockApi.patch.mockReset();
  mockBootstrapSession.mockReset().mockResolvedValue(false);
  mockResolveIdentityViaCookie.mockReset().mockResolvedValue(false);
  markUnauthenticated();
});

describe('OnboardingGate — schemaStatus × schemaRequired matrix (workspace owner, onboarding completed)', () => {
  const REDIRECTS: Array<[Status, boolean]> = [
    ['CREATING', true],
    ['FAILED', true],
  ];
  const PASSES: Array<[Status, boolean | undefined]> = [
    [null, true],
    [null, false],
    ['CREATING', false],
    ['FAILED', false],
    ['SUPERSEDED', true],
    ['SUPERSEDED', false],
    ['READY', true],
    ['READY', false],
    // An older server / a cached create result without the field: never a redirect.
    ['CREATING', undefined],
    ['FAILED', undefined],
  ];

  it.each(REDIRECTS)('%s + schemaRequired=%s → /onboarding/preparing', async (status, required) => {
    serve({ roles: ['manager'], ws: workspace(status, required) });
    mountAt('/');
    await expectPreparation(status as 'CREATING' | 'FAILED');
  });

  it.each(PASSES)('%s + schemaRequired=%s → console (no redirect)', async (status, required) => {
    serve({ roles: ['manager'], ws: workspace(status, required) });
    mountAt('/');
    await expectConsoleAt('/');
  });

  it('the redirect applies to every console route, not only the dashboard', async () => {
    serve({ roles: ['manager'], ws: workspace('FAILED', true) });
    mountAt('/settings/profile');
    await expectPreparation('FAILED');
  });

  it('the earlier onboarding steps keep precedence: no workspace → Create Workspace; profile not completed → Create Profile', async () => {
    serve({ roles: ['manager'], ws: 'none' });
    const first = mountAt('/');
    expect(await screen.findByText('Create your workspace')).toBeInTheDocument();
    first.unmount();

    for (const client of recordedQueryClients()) client.clear();
    serve({ roles: ['manager'], ws: workspace('CREATING', true, null) });
    mountAt('/');
    expect(await screen.findByText('Create your profile')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/onboarding/profile');
  });
});

describe('OnboardingGate — no redirect loop', () => {
  it('CREATING (routed) → preparation auto-resumes as the owner → READY → back to "/" and stays there', async () => {
    serve({ roles: ['manager'], ws: workspace('CREATING', true), resumeTo: workspace('READY', true) });
    mountAt('/');

    await expectConsoleAt('/');
    // Exactly one resume request, made by the preparation screen (the owner's own request), and no bounce afterwards.
    expect(mockApi.post.mock.calls.filter(([url]) => url === '/manager-workspaces')).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(window.location.pathname).toBe('/');
    expect(screen.getByText('CONSOLE HOME')).toBeInTheDocument();
  });

  it('/onboarding/preparing itself is outside the gate: a CREATING (routed) workspace renders the screen, never redirects to itself', async () => {
    serve({ roles: ['manager'], ws: workspace('CREATING', true) });
    mountAt('/onboarding/preparing');
    await expectPreparation('CREATING');
    await new Promise((r) => setTimeout(r, 300));
    expect(window.location.pathname).toBe('/onboarding/preparing');
  });

  it('FAILED (routed) stays on the preparation screen with Try again — never retried automatically by the gate', async () => {
    serve({ roles: ['manager'], ws: workspace('FAILED', true) });
    mountAt('/');
    await expectPreparation('FAILED');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(mockApi.post).not.toHaveBeenCalledWith('/manager-workspaces', expect.anything());
  });
});

describe('OnboardingGate — accounts that are not the routed workspace owner are unaffected', () => {
  it.each([
    ['Staff', ['staff']],
    ['Venue Manager', ['venue_manager']],
    ['a member with another role', ['staffing']],
  ])('%s: console as before, and no workspace lookup at all', async (_label, roles) => {
    serve({ roles, ws: workspace('CREATING', true) });
    mountAt('/');
    await expectConsoleAt('/');
    expect(workspaceGets()).toBe(0);
  });

  it('CEO whose personal workspace is not routed (operational home elsewhere: schemaRequired=false) keeps the console while it is CREATING / FAILED', async () => {
    serve({ roles: ['ceo'], ws: workspace('FAILED', false) });
    mountAt('/');
    await expectConsoleAt('/');
  });

  it('platform-admin-only account: still sent to the Admin Panel, never to the preparation screen, no workspace lookup', async () => {
    serve({ roles: [], isPlatformAdmin: true, ws: workspace('CREATING', true) });
    mountAt('/');
    await waitFor(() => expect(window.location.pathname).toBe('/settings/admin'));
    expect(workspaceGets()).toBe(0);
  });

  it('HWS off (server reports schemaRequired=false): an owner with a CREATING or FAILED workspace keeps full console access', async () => {
    serve({ roles: ['manager'], ws: workspace('CREATING', false) });
    mountAt('/shifts');
    await expectConsoleAt('/shifts');
  });
});
