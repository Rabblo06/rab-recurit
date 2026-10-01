import ipaddr from 'ipaddr.js';

/**
 * PHASE 11 / EDGE-01 — the ONE canonical trust decision every forwarded-IP
 * consumer in this codebase shares: `main.ts`'s `app.set('trust proxy', ...)`
 * (drives Express's own `req.ip`/`req.ips` for X-Forwarded-For) and
 * `resolveClientIp`'s `CF-Connecting-IP` preference (`client-ip.util.ts`)
 * both call this against the SAME configured `TRUSTED_PROXY_CIDRS` list —
 * one trust boundary, not two independently-maintained ones.
 *
 * A forwarded-IP header (`CF-Connecting-IP`, `X-Forwarded-For`, `X-Real-IP`)
 * is trustworthy ONLY when the request's IMMEDIATE socket peer is itself a
 * proxy this deployment has explicitly configured as trusted. Header
 * PRESENCE is never proof — an untrusted direct client can set any of these
 * headers to anything, and this function's whole job is to make sure that
 * never matters.
 *
 * Uses `ipaddr.js` (already resolved in this workspace via Express's own
 * `proxy-addr`/`forwarded` chain) rather than hand-rolling CIDR matching —
 * it already correctly normalises IPv4-mapped IPv6 (`::ffff:127.0.0.1`) and
 * handles both address families' CIDR notation.
 */
export function isTrustedProxyPeer(remoteAddress: string | undefined, trustedCidrs: readonly string[]): boolean {
  if (!remoteAddress || trustedCidrs.length === 0) return false;

  let peer: ReturnType<typeof ipaddr.process>;
  try {
    peer = ipaddr.process(remoteAddress);
  } catch {
    // Not a parseable IP at all (shouldn't happen for a real socket peer,
    // but never let a malformed value throw past this boundary) — fail closed.
    return false;
  }

  return trustedCidrs.some((cidr) => {
    try {
      const range = ipaddr.parseCIDR(cidr);
      // A v4 peer can never match a v6 range and vice versa — `ipaddr.js`'s
      // own `match()` throws on a kind mismatch rather than returning false,
      // so this has to be checked explicitly first. TypeScript can't narrow
      // the union from the runtime `kind()` check alone, so each branch
      // asserts the pairing it just verified.
      if (peer.kind() === 'ipv4' && range[0].kind() === 'ipv4') {
        return (peer as ipaddr.IPv4).match(range as [ipaddr.IPv4, number]);
      }
      if (peer.kind() === 'ipv6' && range[0].kind() === 'ipv6') {
        return (peer as ipaddr.IPv6).match(range as [ipaddr.IPv6, number]);
      }
      return false;
    } catch {
      // A malformed entry in the configured CIDR list must not crash the
      // whole check — it simply never matches, same as any other mismatch.
      return false;
    }
  });
}

/**
 * Express's function-form `trust proxy` setting: called once per hop while
 * walking backward through X-Forwarded-For, starting at the immediate
 * socket peer. Returning `true` means "trust this address as a proxy, keep
 * walking"; the first address for which this returns `false` becomes
 * `req.ip`. Built once from the same configured CIDR list `resolveClientIp`
 * uses, so both mechanisms agree on exactly who is trusted.
 */
export function buildTrustProxyPredicate(trustedCidrs: readonly string[]): (addr: string) => boolean {
  return (addr: string) => isTrustedProxyPeer(addr, trustedCidrs);
}
