import { RESERVED_SUBDOMAIN_PREFIXES, RESERVED_SUBDOMAINS } from '../constants/reserved-subdomains';
import { isValidSubdomainShape } from './subdomain';

/**
 * Wave 3 lane H — strict host parsing for workspace-subdomain routing. One implementation for the server's host resolver,
 * its origin-trust check and the web app's own URL checks, so the three can never disagree about what a host is.
 *
 * A host is ROUTING CONTEXT, never authorisation: nothing here decides what anyone may do. It only decides which
 * workspace (if any) a browser is addressing, and everything that matters is re-checked server-side against the session.
 */

/** A parsed `host[:port]` authority. `hostname` is lowercase ASCII; `port` is the literal decimal port or null. */
export interface HostAuthority {
  hostname: string;
  port: string | null;
}

const MAX_HOSTNAME_LENGTH = 253;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PORT = /^[1-9][0-9]{0,4}$/;

/**
 * Parses a raw `Host` / `X-Forwarded-Host` value (or the authority part of an Origin) STRICTLY. Returns null for
 * anything that is not a plain DNS name with an optional decimal port:
 *   - no userinfo, path, query, whitespace, comma (multi-valued header), IPv6 literal or non-ASCII (raw IDN);
 *   - no trailing dot, empty label, label over 63 characters or name over 253 characters;
 *   - the port is 1-65535 with no leading zero (`:080`, `:0`, `:99999` and a bare `:` are rejected).
 * Upper case is folded to lower case (DNS is case-insensitive; browsers already send lower case).
 */
export function parseHostAuthority(raw: string | null | undefined): HostAuthority | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (value.length === 0 || value.length > MAX_HOSTNAME_LENGTH + 6) return null;
  // Only DNS characters, dots and at most one colon. Rejects `[::1]`, `a@b`, `a/b`, `a b`, `a,b`, `ü`, `%2e` at once.
  if (!/^[a-z0-9.-]+(?::[0-9]+)?$/.test(value)) return null;

  const colon = value.indexOf(':');
  const hostname = colon === -1 ? value : value.slice(0, colon);
  const port = colon === -1 ? null : value.slice(colon + 1);
  if (port !== null && (!PORT.test(port) || Number(port) > 65535)) return null;
  if (hostname.length === 0 || hostname.length > MAX_HOSTNAME_LENGTH) return null;
  const labels = hostname.split('.');
  if (labels.some((label) => !DNS_LABEL.test(label))) return null;
  return { hostname, port };
}

export function formatHostAuthority(authority: HostAuthority): string {
  return authority.port === null ? authority.hostname : `${authority.hostname}:${authority.port}`;
}

/**
 * A reserved label can never be a workspace: the fixed list, plus the reserved PREFIXES (`..--` incl. `xn--` punycode/IDN
 * — homograph risk —, `api-`, `www-`, `crewflow-`). Applied to availability checks, host resolution and origin trust alike.
 */
export function isReservedSubdomainLabel(label: string): boolean {
  const normalised = label.toLowerCase();
  if (RESERVED_SUBDOMAINS.has(normalised)) return true;
  // RFC 5891 section 4.2.3.1: hyphens in positions 3 and 4 are reserved for IDNA (`xn--` is one case).
  if (normalised.length >= 4 && normalised[2] === '-' && normalised[3] === '-') return true;
  return RESERVED_SUBDOMAIN_PREFIXES.some((prefix) => normalised.startsWith(prefix));
}

/** Where a host sits relative to the configured workspace base domain. */
export type WorkspaceHostClassification =
  /** Exactly the base domain (`<base>`): the apex is never a workspace. */
  | { kind: 'apex' }
  /** Exactly one label under the base domain, with a valid subdomain shape. Says nothing about whether it is registered. */
  | { kind: 'label'; label: string; reserved: boolean }
  /** Under the base domain but not a usable label: more than one label (`a.b.<base>`), bad shape, or a label on the wrong port. */
  | { kind: 'invalid' }
  /** Not under the base domain at all (a platform host such as the API's own, or a foreign host). */
  | { kind: 'outside' };

/**
 * Classifies `authority` against `baseDomain` (`host[:port]`, e.g. `workspaces.example.com` or `localhost:5173`).
 * The port must match EXACTLY: a base without a port only matches hosts without one, so `acme.<base>:8443` is never
 * accepted as `acme`. Returns `outside` when the base domain itself does not parse (fail closed: no workspace host).
 */
export function classifyWorkspaceHost(authority: HostAuthority, baseDomain: string | null | undefined): WorkspaceHostClassification {
  const base = parseHostAuthority(baseDomain ?? '');
  if (!base) return { kind: 'outside' };
  if (authority.hostname === base.hostname) {
    // The base hostname on ANOTHER port is another service on the same name (e.g. the API at localhost:3000 next to a
    // localhost:5173 base in local dev) — outside the workspace namespace, not an attempt to address a workspace.
    return authority.port === base.port ? { kind: 'apex' } : { kind: 'outside' };
  }
  const suffix = `.${base.hostname}`;
  if (!authority.hostname.endsWith(suffix)) return { kind: 'outside' };
  if (authority.port !== base.port) return { kind: 'invalid' };
  const label = authority.hostname.slice(0, authority.hostname.length - suffix.length);
  if (label.includes('.') || !isValidSubdomainShape(label)) return { kind: 'invalid' };
  return { kind: 'label', label, reserved: isReservedSubdomainLabel(label) };
}

/**
 * Builds the canonical origin for a workspace label: `<scheme>://<label>.<base>`. Returns null for an invalid or reserved
 * label, or a base domain that does not parse — callers fall back to the default application URL, never to a guess.
 * The label always comes from the database (never from a request), so the result can never be an open redirect.
 */
export function buildWorkspaceOrigin(scheme: 'http' | 'https', label: string, baseDomain: string | null | undefined): string | null {
  const base = parseHostAuthority(baseDomain ?? '');
  if (!base || !isValidSubdomainShape(label) || isReservedSubdomainLabel(label)) return null;
  return `${scheme}://${label}.${formatHostAuthority(base)}`;
}
