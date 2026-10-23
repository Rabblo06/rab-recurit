import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import axios from 'axios';

import { api, observeIdentityErrors } from '../../shared/api';
import { isSafeWorkspaceUrl, useWorkspaceHost, workspaceUrlFor, type WorkspaceHostState } from '../../shared/lib/workspace-host';
import WorkspaceHostGate, { type GateLocation } from './WorkspaceHostGate';
import { installHostMismatchWatcher, isHostMismatchError, WORKSPACE_HOST_MISMATCH } from './host-mismatch';

jest.mock('../../shared/api', () => ({
  api: { get: jest.fn(), post: jest.fn() },
  withAuthLock: jest.fn((run: () => unknown) => run()),
  broadcastLogout: jest.fn(),
  observeIdentityErrors: jest.fn(() => () => undefined),
}));
jest.mock('../../shared/lib/auth-session', () => ({ markUnauthenticated: jest.fn() }));

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;

const BASE = 'workspaces.example.com';
const DEFAULT_URL = 'https://app.example.com';

function fakeLocation(pathname = '/shifts', search = '?week=2'): GateLocation & { replace: jest.Mock } {
  return { pathname, search, replace: jest.fn() };
}

function Probe() {
  const host = useWorkspaceHost();
  return <div>APP state={host.state}{host.state === 'workspace' ? ` name=${host.workspace.subdomain}` : ''}</div>;
}

function mount(response: WorkspaceHostState | Error, location = fakeLocation()) {
  get.mockImplementation((url: string) => {
    if (url !== '/public/workspace-host') throw new Error(`unexpected GET ${url}`);
    return response instanceof Error ? Promise.reject(response) : Promise.resolve({ data: response });
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <WorkspaceHostGate location={location}>
        <Probe />
      </WorkspaceHostGate>
    </QueryClientProvider>,
  );
  return { location };
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
});

describe('WorkspaceHostGate — the five host states', () => {
  it('default host → the app, as before', async () => {
    mount({ state: 'default', defaultUrl: DEFAULT_URL, workspaceBaseDomain: null });
    expect(await screen.findByText('APP state=default')).toBeInTheDocument();
  });

  it('workspace host → the app, with the public workspace label in context', async () => {
    mount({ state: 'workspace', defaultUrl: DEFAULT_URL, workspaceBaseDomain: BASE, canonicalUrl: `https://acme.${BASE}`, workspace: { subdomain: 'acme', displayName: null } });
    expect(await screen.findByText('APP state=workspace name=acme')).toBeInTheDocument();
  });

  it('unknown host → "Workspace not found", no app rendered, link to the default sign-in only', async () => {
    mount({ state: 'not-found', defaultUrl: DEFAULT_URL, workspaceBaseDomain: BASE });
    expect(await screen.findByText('Workspace not found')).toBeInTheDocument();
    expect(screen.queryByText(/APP state/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute('href', `${DEFAULT_URL}/login`);
  });

  it('renamed host → replaces the location with the canonical host, keeping path and query', async () => {
    const { location } = mount({ state: 'renamed', defaultUrl: DEFAULT_URL, workspaceBaseDomain: BASE, canonicalUrl: `https://acme.${BASE}` });
    await waitFor(() => expect(location.replace).toHaveBeenCalledWith(`https://acme.${BASE}/shifts?week=2`));
    expect(screen.queryByText(/APP state/)).toBeNull();
  });

  it('ABUSE: renamed host with a canonical URL outside the base domain → no redirect (no open redirect)', async () => {
    for (const canonicalUrl of ['https://evil.test', `https://acme.${BASE}.evil.test`, `https://acme.${BASE}/phish`, `https://admin.${BASE}`, `http://acme.${BASE}`, 'javascript:alert(1)']) {
      get.mockReset();
      const location = fakeLocation();
      const { unmount } = render(<div />);
      unmount();
      mount({ state: 'renamed', defaultUrl: DEFAULT_URL, workspaceBaseDomain: BASE, canonicalUrl }, location);
      expect(await screen.findAllByText('Workspace not found')).not.toHaveLength(0);
      expect(location.replace).not.toHaveBeenCalled();
      document.body.innerHTML = '';
    }
  });

  it('ABUSE: renamed-host redirect never carries a protocol-relative path', async () => {
    const location = fakeLocation('//evil.test/x', '');
    mount({ state: 'renamed', defaultUrl: DEFAULT_URL, workspaceBaseDomain: BASE, canonicalUrl: `https://acme.${BASE}` }, location);
    await waitFor(() => expect(location.replace).toHaveBeenCalledWith(`https://acme.${BASE}/`));
  });

  it('resolver unreachable → the app renders as the default host (the host is never an authority)', async () => {
    mount(new Error('network'));
    expect(await screen.findByText('APP state=default', undefined, { timeout: 3000 })).toBeInTheDocument();
  });

  it('an unexpected response shape is treated as the default host, never a guessed workspace', async () => {
    mount({ state: 'something-else' } as unknown as WorkspaceHostState);
    expect(await screen.findByText('APP state=default')).toBeInTheDocument();
  });
});

describe('wrong host for the signed-in user', () => {
  it('a WORKSPACE_HOST_MISMATCH 404 from any API call replaces the app (no data) and offers the own workspace + sign-out', async () => {
    // A real axios instance, so the watcher runs through the actual interceptor chain.
    const client = axios.create();
    client.defaults.adapter = async (config) => {
      const error: any = new Error('Request failed with status code 404');
      error.config = config;
      error.response = { status: 404, data: { code: WORKSPACE_HOST_MISMATCH, message: 'Not found.', canonicalUrl: `https://bravo.${BASE}` }, headers: {}, config };
      throw error;
    };
    installHostMismatchWatcher(client);
    const { location } = mount({ state: 'workspace', defaultUrl: DEFAULT_URL, workspaceBaseDomain: BASE, canonicalUrl: `https://acme.${BASE}`, workspace: { subdomain: 'acme', displayName: null } });
    expect(await screen.findByText('APP state=workspace name=acme')).toBeInTheDocument();

    await client.get('/auth/me').catch(() => undefined);

    expect(await screen.findByText("This workspace isn't available to your account")).toBeInTheDocument();
    expect(screen.queryByText(/APP state/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Go to your workspace' })).toHaveAttribute('href', `https://bravo.${BASE}`);

    post.mockResolvedValue({ data: {} });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/auth/logout'));
    await waitFor(() => expect(location.replace).toHaveBeenCalledWith('/login'));
  });

  it('W6-E2E-02: a WORKSPACE_HOST_MISMATCH answered to the session bootstrap\'s raw /auth/me read also shows the wrong-host screen', async () => {
    mount({ state: 'workspace', defaultUrl: DEFAULT_URL, workspaceBaseDomain: BASE, canonicalUrl: `https://acme.${BASE}`, workspace: { subdomain: 'acme', displayName: null } });
    await screen.findByText('APP state=workspace name=acme');
    const observers = (observeIdentityErrors as jest.Mock).mock.calls.map(([observer]) => observer as (error: unknown) => void);
    expect(observers.length).toBeGreaterThan(0);
    // What shared/api's resolveCookieIdentity reports for a 404 it read outside the watched client.
    const error = { response: { status: 404, data: { code: WORKSPACE_HOST_MISMATCH, message: 'Not found.', canonicalUrl: DEFAULT_URL } } };
    for (const observer of observers) observer(error);
    expect(await screen.findByText("This workspace isn't available to your account")).toBeInTheDocument();
    expect(screen.queryByText(/APP state/)).toBeNull();
  });

  it('ABUSE: a mismatch body naming a foreign URL offers no "Go to your workspace" link', async () => {
    const client = axios.create();
    client.defaults.adapter = async (config) => {
      const error: any = new Error('404');
      error.config = config;
      error.response = { status: 404, data: { code: WORKSPACE_HOST_MISMATCH, canonicalUrl: 'https://evil.test' }, headers: {}, config };
      throw error;
    };
    installHostMismatchWatcher(client);
    mount({ state: 'workspace', defaultUrl: DEFAULT_URL, workspaceBaseDomain: BASE, canonicalUrl: `https://acme.${BASE}`, workspace: { subdomain: 'acme', displayName: null } });
    await screen.findByText('APP state=workspace name=acme');
    await client.get('/staff').catch(() => undefined);
    expect(await screen.findByText("This workspace isn't available to your account")).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Go to your workspace' })).toBeNull();
  });

  it('only the wrong-host code counts; an ordinary 404 is not a host mismatch', () => {
    expect(isHostMismatchError({ response: { status: 404, data: { code: 'NOT_FOUND' } } })).toBeNull();
    expect(isHostMismatchError({ response: { status: 403, data: { code: WORKSPACE_HOST_MISMATCH } } })).toBeNull();
    expect(isHostMismatchError({ response: { status: 404, data: { code: WORKSPACE_HOST_MISMATCH, canonicalUrl: 'x' } } })).toEqual({ canonicalUrl: 'x' });
  });
});

describe('isSafeWorkspaceUrl / workspaceUrlFor (shared)', () => {
  const host: WorkspaceHostState = { state: 'default', defaultUrl: DEFAULT_URL, workspaceBaseDomain: BASE };

  it('accepts only the default origin or a canonical non-reserved workspace origin with the default scheme', () => {
    expect(isSafeWorkspaceUrl(DEFAULT_URL, host)).toBe(true);
    expect(isSafeWorkspaceUrl(`https://acme.${BASE}`, host)).toBe(true);
    for (const bad of [`http://acme.${BASE}`, `https://acme.${BASE}/x`, `https://u@acme.${BASE}`, `https://api.${BASE}`, `https://a.b.${BASE}`, 'https://evil.test', 42, null]) {
      expect(isSafeWorkspaceUrl(bad, host)).toBe(false);
    }
  });

  it('builds the preview only when the server reports a routed base domain', () => {
    expect(workspaceUrlFor(host, 'acme')).toBe(`https://acme.${BASE}`);
    expect(workspaceUrlFor({ ...host, workspaceBaseDomain: null }, 'acme')).toBeNull();
    expect(workspaceUrlFor(host, 'admin')).toBeNull();
    expect(workspaceUrlFor({ state: 'default', defaultUrl: 'http://localhost:5173', workspaceBaseDomain: 'localhost:5173' }, 'acme')).toBe('http://acme.localhost:5173');
  });
});
