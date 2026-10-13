import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

export interface DomainConfig {
  scheme: 'http' | 'https';
  /** `host[:port]` a workspace subdomain previews against, or `null` if `WORKSPACE_BASE_DOMAIN`
   * isn't configured — callers must show the current browser origin honestly in that case, never
   * fabricate a subdomain preview (see that env var's own doc comment on the backend). */
  workspaceBaseDomain: string | null;
}

/**
 * Dynamic-domain-display checkpoint (docs/HANDOFF.md) — `CreateWorkspaceScreen.tsx`/Settings →
 * Domains both need this before they can render a workspace URL preview instead of a hardcoded
 * `.rab.app` suffix. Same `['auth-config']` query key `Login.tsx`'s own `/auth/config` fetch
 * already uses — React Query dedupes them into one shared cache entry, never a second request for
 * the same public, pre-auth config payload.
 */
export function useDomainConfig() {
  const { data } = useQuery({
    queryKey: ['auth-config'],
    queryFn: async () => (await api.get<{ domain: DomainConfig }>('/auth/config')).data,
    staleTime: 60_000,
  });
  return data?.domain;
}

/**
 * Builds the full preview URL for a candidate subdomain, or `null` when there's nothing valid to
 * show yet (config not loaded, or no `workspaceBaseDomain` configured) — callers fall back to
 * showing the current browser origin plainly in that case, never an invented address like
 * `issac.127.0.0.1` (not a valid DNS subdomain of an IPv4 literal).
 */
export function buildWorkspacePreviewUrl(domain: DomainConfig | undefined, subdomain: string): string | null {
  if (!domain?.workspaceBaseDomain || !subdomain) return null;
  return `${domain.scheme}://${subdomain}.${domain.workspaceBaseDomain}`;
}

/** The subset of `window.location` this module needs — accepted as plain data, never read from
 * the global directly, so the resolution logic below is a pure function and testable without
 * mocking `window`. */
export interface BrowserLocation {
  hostname: string;
  host: string;
  protocol: string;
}

const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function isIpLiteral(hostname: string): boolean {
  return IPV4_RE.test(hostname) || hostname === '[::1]' || hostname.startsWith('[');
}

export interface WorkspaceDomainDisplay {
  /** The browser's own current address, always honest, never used to construct a subdomain —
   * context only ("you're using the app at ..."), per the owner's own requirement that this stay
   * separate from the authoritative workspace URL. */
  currentAppAddress: string;
  /** A `DomainConfig`-shaped value with `workspaceBaseDomain` resolved for DISPLAY purposes —
   * feed straight into `buildWorkspacePreviewUrl`, unchanged. `null` base means nothing valid to
   * preview (caller falls back to `currentAppAddress`). */
  effectiveDomain: DomainConfig | undefined;
}

/**
 * Dynamic-domain-display refinement (docs/HANDOFF.md) — reconciles the browser's OWN current
 * address with the backend-configured `workspaceBaseDomain`, so the displayed subdomain suffix
 * matches what the user is actually looking at instead of always echoing server config verbatim
 * (e.g. showing `.localhost:5173` while the browser is plainly on `127.0.0.1:5173`).
 *
 * Three cases, in order:
 *  1. The browser hostname is an IP literal (`127.0.0.1`, `[::1]`, ...) — `issac.127.0.0.1` is not
 *     a valid DNS subdomain of an IPv4 literal, so the browser's own host is never used as the
 *     suffix base. Falls back to the backend's configured `workspaceBaseDomain` (if any).
 *  2. The browser is already ON the configured base domain, or a subdomain of it (e.g. the app is
 *     being served from `app.rab.com` or `issac.rab.com` and the backend says the base is
 *     `rab.com`) — use the CONFIGURED base, never the browser's own host, so a second subdomain is
 *     never appended on top of an existing one.
 *  3. Otherwise — a normal DNS hostname the backend hasn't told us about — trust the browser's own
 *     current host directly as the suffix base (matches the owner's own examples: browsing
 *     `rab.com` or `crewflow.co.uk` previews `.rab.com`/`.crewflow.co.uk` without needing
 *     WORKSPACE_BASE_DOMAIN to already know about every possible domain this app might be served
 *     from). Display only — the backend's own validated config remains authoritative for any
 *     actual navigation/redirect destination, never this inferred value.
 */
export function resolveWorkspaceDomainDisplay(loc: BrowserLocation, domain: DomainConfig | undefined): WorkspaceDomainDisplay {
  const scheme: 'http' | 'https' = loc.protocol === 'https:' ? 'https' : 'http';
  const currentAppAddress = `${scheme}://${loc.host}`;

  if (isIpLiteral(loc.hostname)) {
    return {
      currentAppAddress,
      effectiveDomain: domain?.workspaceBaseDomain ? { scheme: domain.scheme, workspaceBaseDomain: domain.workspaceBaseDomain } : undefined,
    };
  }

  if (domain?.workspaceBaseDomain) {
    const configuredHost = domain.workspaceBaseDomain.split(':')[0]!.toLowerCase();
    const currentHost = loc.hostname.toLowerCase();
    if (currentHost === configuredHost || currentHost.endsWith(`.${configuredHost}`)) {
      return { currentAppAddress, effectiveDomain: { scheme: domain.scheme, workspaceBaseDomain: domain.workspaceBaseDomain } };
    }
  }

  return { currentAppAddress, effectiveDomain: { scheme, workspaceBaseDomain: loc.host } };
}
