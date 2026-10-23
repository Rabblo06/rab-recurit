import { api } from '../../shared/api';
import { isSafeWorkspaceUrl, WorkspaceHostState } from '../../shared/lib/workspace-host';

/**
 * Wave 4 lane MFA × wave 3 lane H — after a sign-in on the DEFAULT host, move the user to their own workspace host.
 *
 * The server decides everything (target = the session's own workspace, address = registry-confirmed DB label + env) and
 * answers `{ redirectUrl: null }` when there is nowhere to go (no workspace, platform admin, feature off). This only
 * re-validates the answer as defence in depth — origin must be a valid workspace host of the reported base domain, path
 * exactly `/auth/handoff`, no query; the single-use token travels in the fragment — and then leaves with
 * `location.replace` (no history entry on the default host). Returns true when the browser is leaving.
 */
export async function continueOnWorkspaceHost(host: WorkspaceHostState): Promise<boolean> {
  if (host.state !== 'default' || !host.workspaceBaseDomain) return false;
  let redirectUrl: unknown;
  try {
    ({ redirectUrl } = (await api.post<{ redirectUrl: string | null }>('/auth/login-handoff', {})).data);
  } catch {
    return false; // stay signed in here; the default host keeps working
  }
  if (typeof redirectUrl !== 'string' || !isSafeHandoffUrl(redirectUrl, host)) return false;
  window.location.replace(redirectUrl);
  return true;
}

export function isSafeHandoffUrl(candidate: string, host: Pick<WorkspaceHostState, 'defaultUrl' | 'workspaceBaseDomain'>): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.pathname !== '/auth/handoff' || url.search !== '' || url.username || url.password) return false;
  if (!/^#t=lho_[A-Za-z0-9_-]{43}$/.test(url.hash)) return false;
  if (typeof window !== 'undefined' && url.origin === window.location.origin) return false;
  return isSafeWorkspaceUrl(url.origin, host);
}
