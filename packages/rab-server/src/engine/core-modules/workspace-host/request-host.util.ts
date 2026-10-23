import { classifyWorkspaceHost, formatHostAuthority, HostAuthority, parseHostAuthority } from '@rab/shared';

import { isTrustedProxyPeer } from '../../utils/trusted-proxy.util';

/** Structural (like `client-ip.util.ts`), so unit tests can pass a plain object. */
export interface MinimalHostRequest {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}

/** The outcome of classifying ONE request input (the request host or the browser Origin) against the base domain. */
export type HostCandidate =
  /** Not a workspace host: absent, a configured platform host, the apex, a reserved Host label, or outside the base. */
  | { kind: 'none' }
  /** A single non-reserved label under the base domain — still to be looked up in the registry. */
  | { kind: 'label'; label: string }
  /** Addresses the base domain but can never be a workspace (malformed, nested, wrong port, reserved Origin label). */
  | { kind: 'invalid'; label: string | null };

const IPV6_LITERAL_HOST = /^\[[0-9a-f:.]+\](?::[0-9]{1,5})?$/i;

function singleHeader(value: string | string[] | undefined): string | undefined | null {
  if (value === undefined) return undefined;
  // A repeated header, or a comma-joined list (a proxy that APPENDS instead of overwriting), is ambiguous: refuse it.
  if (Array.isArray(value)) return value.length === 1 && !value[0]!.includes(',') ? value[0] : null;
  return value.includes(',') ? null : value;
}

/**
 * The host this request was addressed to, from VALIDATED sources only:
 *   - `X-Forwarded-Host`, only when the immediate socket peer is in TRUSTED_PROXY_CIDRS (the same predicate as
 *     `trust proxy` and `resolveClientIp`); a multi-valued value is refused (null), never "first wins";
 *   - otherwise the `Host` header itself. An untrusted peer's `X-Forwarded-Host` is ignored entirely.
 * Returns undefined when there is no host information, null when the chosen header is ambiguous.
 */
export function requestHostHeader(req: MinimalHostRequest, trustedProxyCidrs: readonly string[]): string | undefined | null {
  if (isTrustedProxyPeer(req.socket?.remoteAddress, trustedProxyCidrs)) {
    const forwarded = singleHeader(req.headers['x-forwarded-host']);
    if (forwarded !== undefined) return forwarded;
  }
  return singleHeader(req.headers.host);
}

/** The browser Origin, or undefined when absent or the opaque `null` origin (sandboxed iframe, file://, privacy redirect). */
export function requestOriginHeader(req: MinimalHostRequest): string | undefined | null {
  const origin = singleHeader(req.headers.origin);
  if (origin === undefined || origin === 'null') return undefined;
  return origin;
}

export interface HostClassificationConfig {
  baseDomain: string;
  /** `host[:port]` authorities of configured platform hosts (APP_URL, ACCOUNTS_URL, CORS_ORIGINS): never workspaces. */
  platformAuthorities: ReadonlySet<string>;
}

/**
 * Classifies the request-host input. A reserved label on the HOST side is a platform host (`api.<base>` may be this
 * API itself), so it is `none`, not an error. An IPv6 literal (direct-IP access) is `none`. Anything else that does not
 * parse is `invalid` — fail closed.
 */
export function classifyRequestHost(raw: string | undefined | null, config: HostClassificationConfig): HostCandidate {
  if (raw === undefined) return { kind: 'none' };
  if (raw === null) return { kind: 'invalid', label: null };
  if (IPV6_LITERAL_HOST.test(raw.trim())) return { kind: 'none' };
  const authority = parseHostAuthority(raw);
  if (!authority) return { kind: 'invalid', label: null };
  return classifyAuthority(authority, config, 'host');
}

/**
 * Classifies the browser Origin input. It must be the exact serialised origin (`scheme://host[:port]`, http/https).
 * A reserved label on the ORIGIN side is `invalid`: no Crewflow page is served from `admin.<base>`.
 */
export function classifyRequestOrigin(raw: string | undefined | null, config: HostClassificationConfig): HostCandidate {
  if (raw === undefined) return { kind: 'none' };
  if (raw === null) return { kind: 'invalid', label: null };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: 'invalid', label: null };
  }
  if (url.origin !== raw || (url.protocol !== 'http:' && url.protocol !== 'https:')) return { kind: 'invalid', label: null };
  const authority = parseHostAuthority(url.host);
  if (!authority) return { kind: 'invalid', label: null };
  return classifyAuthority(authority, config, 'origin');
}

function classifyAuthority(authority: HostAuthority, config: HostClassificationConfig, side: 'host' | 'origin'): HostCandidate {
  if (config.platformAuthorities.has(formatHostAuthority(authority))) return { kind: 'none' };
  const classified = classifyWorkspaceHost(authority, config.baseDomain);
  switch (classified.kind) {
    case 'outside':
    case 'apex':
      return { kind: 'none' };
    case 'invalid':
      return { kind: 'invalid', label: null };
    case 'label':
      if (classified.reserved) return side === 'host' ? { kind: 'none' } : { kind: 'invalid', label: classified.label };
      return { kind: 'label', label: classified.label };
  }
}

/** `host[:port]` of each configured URL/origin, skipping anything that does not parse. */
export function platformAuthoritiesFrom(urls: readonly (string | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const value of urls) {
    if (!value) continue;
    try {
      const authority = parseHostAuthority(new URL(value).host);
      if (authority) out.add(formatHostAuthority(authority));
    } catch {
      // not a URL — ignored
    }
  }
  return out;
}
