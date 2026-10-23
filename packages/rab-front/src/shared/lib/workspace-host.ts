import { createContext, useContext } from 'react';
import { buildWorkspaceOrigin, classifyWorkspaceHost, parseHostAuthority } from '@rab/shared';

/**
 * Wave 3 lane H — what the server says this page is being served as (`GET /public/workspace-host`). Shared because three
 * features read it (auth: login branding; onboarding + settings: the workspace URL preview). The resolution itself and
 * the screens for the non-default states live in `features/workspace-host/`.
 *
 * Routing context only: nothing here is a credential or a permission. The server re-checks every request against the
 * session (a session from another workspace gets a 404 on this host), so a tampered value here can only break the UI for
 * whoever tampered with it.
 */
export type WorkspaceHostState =
  | { state: 'default'; defaultUrl: string; workspaceBaseDomain: string | null }
  | { state: 'workspace'; defaultUrl: string; workspaceBaseDomain: string; canonicalUrl: string; workspace: { subdomain: string; displayName: string | null } }
  | { state: 'renamed'; defaultUrl: string; workspaceBaseDomain: string; canonicalUrl: string }
  | { state: 'not-found'; defaultUrl: string; workspaceBaseDomain: string };

/** Before (or without) a server answer: behave exactly like the default host, with no workspace address claimed. */
export const DEFAULT_WORKSPACE_HOST: WorkspaceHostState = { state: 'default', defaultUrl: '', workspaceBaseDomain: null };

export const WorkspaceHostContext = createContext<WorkspaceHostState>(DEFAULT_WORKSPACE_HOST);

export function useWorkspaceHost(): WorkspaceHostState {
  return useContext(WorkspaceHostContext);
}

function schemeOf(url: string): 'http' | 'https' | null {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'https:' ? 'https' : protocol === 'http:' ? 'http' : null;
  } catch {
    return null;
  }
}

/**
 * True only for a URL this app may navigate to on the server's say-so: exactly the default app origin, or exactly
 * `<scheme>://<label>.<base>` for a valid, non-reserved label under the base domain the server reported — origin only (no
 * path, query, userinfo), the default app's scheme. Defence in depth: the server already builds these from the database
 * label + its own env, never from a request; this makes a corrupted or injected value inert (no open redirect).
 */
export function isSafeWorkspaceUrl(candidate: unknown, host: Pick<WorkspaceHostState, 'defaultUrl' | 'workspaceBaseDomain'>): candidate is string {
  if (typeof candidate !== 'string') return false;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  const normalised = candidate.replace(/\/+$/, '');
  if (url.origin !== normalised) return false; // a path, query, fragment or userinfo is never a workspace address
  let defaultOrigin: string | null = null;
  try {
    defaultOrigin = host.defaultUrl ? new URL(host.defaultUrl).origin : null;
  } catch {
    defaultOrigin = null;
  }
  if (defaultOrigin && url.origin === defaultOrigin) return true;
  const scheme = schemeOf(host.defaultUrl);
  if (!scheme || url.protocol !== `${scheme}:` || !host.workspaceBaseDomain) return false;
  const authority = parseHostAuthority(url.host);
  if (!authority) return false;
  const classified = classifyWorkspaceHost(authority, host.workspaceBaseDomain);
  return classified.kind === 'label' && !classified.reserved;
}

/**
 * The accurate workspace address for `label`, or null when this deployment does not route workspace hosts (the server
 * reports no base domain while routing is off) — callers then say so honestly instead of showing an address that would
 * not resolve. Never derived from the browser's own hostname.
 */
export function workspaceUrlFor(host: WorkspaceHostState, label: string): string | null {
  const scheme = schemeOf(host.defaultUrl);
  if (!scheme || !host.workspaceBaseDomain || !label) return null;
  return buildWorkspaceOrigin(scheme, label, host.workspaceBaseDomain);
}
