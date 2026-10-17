import { isIP } from 'node:net';

import ipaddr from 'ipaddr.js';

import { isTrustedProxyPeer } from './trusted-proxy.util';

/**
 * Structural, not `express.Request` — Nest's `ThrottlerGetTrackerFunction`
 * types its parameter as a bare `Record<string, any>` (it's shared across
 * HTTP/WS/RPC transports), so a real `Request` argument doesn't satisfy it
 * even though an actual Express request is what's passed at runtime. Only
 * the fields this function reads are declared here.
 */
interface MinimalClientIpRequest {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
}

/**
 * A real IPv4/IPv6 literal check (`node:net` `isIP`). The previous character-class test accepted strings such as `::::` or
 * `1.2` that are not addresses at all — and a non-address then made the `inet` insert for sessions/login history throw (CF-45).
 */
function looksLikeIp(value: string): boolean {
  return value.length > 0 && value.length <= 45 && isIP(value) !== 0;
}

/** How a stored client address should be presented. Display only — the stored, forensic value is never rewritten. */
export interface ClientIpDescription {
  /** IPv4-mapped IPv6 (`::ffff:172.18.0.1`) shown as its IPv4 form; otherwise the canonical address. */
  display: string;
  /**
   * `public`: a routable address. `private`: loopback, link-local or a private/unique-local range — e.g. a Docker bridge
   * gateway when no trusted proxy is configured, so the real client address could not be verified.
   */
  scope: 'public' | 'private';
}

export function describeClientIp(raw: string | null | undefined): ClientIpDescription | null {
  if (!raw || !ipaddr.isValid(raw)) return null;
  const address = ipaddr.process(raw);
  const range = address.range();
  const scope = range === 'unicast' ? 'public' : 'private';
  return { display: address.toString(), scope };
}

/**
 * Resolves the real client IP for rate-limiting and audit trails
 * (`login_history`) — see SEC-03 and PHASE 11 / EDGE-01.
 *
 * A forwarded-IP header is honoured ONLY when the request's immediate
 * socket peer (`req.socket.remoteAddress`) is itself a proxy this
 * deployment has explicitly configured as trusted, via
 * `TRUSTED_PROXY_CIDRS` (`isTrustedProxyPeer` — the SAME check `main.ts`'s
 * `trust proxy` predicate uses, so both mechanisms agree). Header PRESENCE
 * is never proof by itself: an earlier version of this function trusted
 * `CF-Connecting-IP` unconditionally whenever it was present and
 * syntactically looked like an IP, on the assumption that the origin is
 * only ever reachable through Cloudflare — an assumption this code has no
 * way to verify, and one that does not hold for a Render-hosted service
 * unless its default `*.onrender.com` subdomain has been explicitly
 * disabled (Render docs: that subdomain remains publicly reachable,
 * bypassing any custom-domain Cloudflare proxy in front of it, until an
 * operator disables it). An untrusted direct caller could therefore set
 * `CF-Connecting-IP` to anything and have it accepted as the caller's own
 * rate-limit/audit identity.
 *
 * For a TRUSTED immediate peer, `CF-Connecting-IP` is still preferred over
 * Express's own `req.ip` when present: Cloudflare sets it at their edge
 * from the real TCP connection, unconditionally overwriting any value
 * already on the request rather than appending to it the way
 * `X-Forwarded-For` does — so it sidesteps any uncertainty about exactly
 * how many additional hops sit between Cloudflare and the trusted peer.
 * `req.ip` (proxy-aware via the SAME trusted-peer predicate set as
 * `trust proxy` in main.ts) is the fallback when `CF-Connecting-IP` is
 * absent.
 *
 * For an UNTRUSTED immediate peer (the default — `TRUSTED_PROXY_CIDRS`
 * unset — and always true for a direct client regardless of configuration),
 * every forwarded-IP header is ignored outright and the raw socket address
 * is used. This is always safe: it can never let a client choose its own
 * bucket, even though it means every real caller behind an actual,
 * still-unconfigured proxy collapses into one shared address until that
 * proxy is added to `TRUSTED_PROXY_CIDRS`.
 */
export function resolveClientIp(req: MinimalClientIpRequest, trustedProxyCidrs: readonly string[]): string {
  const immediatePeer = req.socket?.remoteAddress;

  if (!isTrustedProxyPeer(immediatePeer, trustedProxyCidrs)) {
    return immediatePeer ?? req.ip ?? 'unknown';
  }

  const cfConnectingIp = req.headers['cf-connecting-ip'];
  const cfValue = Array.isArray(cfConnectingIp) ? cfConnectingIp[0] : cfConnectingIp;
  if (cfValue && looksLikeIp(cfValue)) return cfValue;
  return req.ip ?? immediatePeer ?? 'unknown';
}
