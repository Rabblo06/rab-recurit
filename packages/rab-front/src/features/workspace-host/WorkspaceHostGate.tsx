import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, broadcastLogout, withAuthLock } from '../../shared/api';
import { markUnauthenticated } from '../../shared/lib/auth-session';
import { DEFAULT_WORKSPACE_HOST, isSafeWorkspaceUrl, WorkspaceHostContext, type WorkspaceHostState } from '../../shared/lib/workspace-host';
import { installHostMismatchWatcher, onHostMismatch } from './host-mismatch';
import { WorkspaceNotFoundScreen, WrongHostScreen } from './WorkspaceHostScreens';

installHostMismatchWatcher(api);

/** `GET /public/workspace-host` — the server resolves the host from the request itself; nothing is sent to name it. */
export async function fetchWorkspaceHost(): Promise<WorkspaceHostState> {
  const body = (await api.get<WorkspaceHostState>('/public/workspace-host'))?.data as Partial<WorkspaceHostState> | undefined;
  const known = body && typeof body === 'object' && ['default', 'workspace', 'renamed', 'not-found'].includes(body.state as string);
  // An unexpected answer (older server, proxy error page) is treated as the default host: never a guessed workspace.
  return known ? (body as WorkspaceHostState) : DEFAULT_WORKSPACE_HOST;
}

/** The location bits the gate needs, injectable for tests (jsdom's `location.replace` cannot be spied on). */
export interface GateLocation {
  pathname: string;
  search: string;
  replace: (url: string) => void;
}

const browserLocation: GateLocation = {
  get pathname() {
    return window.location.pathname;
  },
  get search() {
    return window.location.search;
  },
  replace: (url: string) => window.location.replace(url),
};

/** Same-origin path + query to carry across a renamed-host redirect; anything odd collapses to `/`. */
function safeRelativePath(location: GateLocation): string {
  const path = location.pathname.startsWith('/') && !location.pathname.startsWith('//') ? location.pathname : '/';
  return `${path}${location.search.startsWith('?') ? location.search : ''}`;
}

/**
 * Wave 3 lane H — resolves which workspace (if any) this host is, BEFORE the session bootstraps, and renders one of the
 * explicit states (never an open-ended spinner, never a fallback to some other workspace):
 *   - default host  → the app as before;
 *   - workspace host → the app, with the workspace's public name for the sign-in page (`useWorkspaceHost()`);
 *   - unknown host  → "Workspace not found" (no data, link to the default sign-in);
 *   - renamed host  → immediate redirect to the canonical host (validated; path kept, never an open redirect);
 *   - wrong host for the signed-in account (any API call answered 404 WORKSPACE_HOST_MISMATCH) → the wrong-host screen,
 *     which replaces everything (no data shown) and offers the account's own workspace or sign-out.
 * If the resolver itself is unreachable the app renders as the default host: the host is never an authority, and the
 * server still refuses a wrong-host session on every request.
 */
export default function WorkspaceHostGate({ children, location = browserLocation }: { children: ReactNode; location?: GateLocation }) {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['workspace-host'],
    queryFn: fetchWorkspaceHost,
    staleTime: Infinity,
    // One quick retry, then render as the default host: the first paint must never wait long on branding.
    retry: 1,
    retryDelay: 400,
  });
  const [mismatch, setMismatch] = useState<{ ownUrl: string | null } | null>(null);
  const host = data ?? DEFAULT_WORKSPACE_HOST;

  useEffect(
    () =>
      onHostMismatch(({ canonicalUrl }) => {
        setMismatch({ ownUrl: isSafeWorkspaceUrl(canonicalUrl, host) ? canonicalUrl : null });
      }),
    [host],
  );

  const renamedTarget = data?.state === 'renamed' && isSafeWorkspaceUrl(data.canonicalUrl, data) ? data.canonicalUrl.replace(/\/+$/, '') : null;
  useEffect(() => {
    if (renamedTarget) location.replace(`${renamedTarget}${safeRelativePath(location)}`);
  }, [renamedTarget, location]);

  async function signOut(): Promise<void> {
    try {
      await withAuthLock(() => api.post('/auth/logout'));
    } catch {
      // Best-effort, like every other sign-out path: local state is cleared either way.
    }
    markUnauthenticated();
    broadcastLogout();
    qc.clear();
    setMismatch(null);
    location.replace('/login');
  }

  if (isLoading) return null;
  if (mismatch) return <WrongHostScreen ownUrl={mismatch.ownUrl} onSignOut={signOut} />;
  if (!isError && data?.state === 'not-found') return <WorkspaceNotFoundScreen defaultUrl={isSafeWorkspaceUrl(data.defaultUrl, data) ? data.defaultUrl.replace(/\/+$/, '') : null} />;
  if (data?.state === 'renamed') return renamedTarget ? null : <WorkspaceNotFoundScreen defaultUrl={null} />;
  return <WorkspaceHostContext.Provider value={host}>{children}</WorkspaceHostContext.Provider>;
}
