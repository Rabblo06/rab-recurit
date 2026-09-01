import { promises as dns } from 'node:dns';
import { isIPv4 } from 'node:net';

/**
 * Blocks the well-known private/loopback/link-local/metadata ranges before
 * `testSmtp` opens a real socket to an admin-supplied host:port — without
 * this, the endpoint is a straightforward SSRF: point it at 127.0.0.1,
 * 169.254.169.254 (cloud metadata), or an internal service's port and read
 * the connect-succeeded/failed signal back as an oracle.
 *
 * Resolves the hostname and checks every returned address, not just the
 * string itself — a hostname that *looks* external can still resolve to an
 * internal address. This does not fully close DNS rebinding (an attacker
 * controlling DNS could serve a public address for this check and a private
 * one moments later, at the connection nodemailer makes independently) —
 * closing that would require forcing the SMTP connection onto this exact
 * resolved IP while still presenting the original hostname for TLS SNI,
 * which nodemailer's `createTransport` has no option for. Documented
 * residual risk, not silently ignored: this endpoint is platform-admin-only
 * and rate-limited (5/60s), which meaningfully narrows who could attempt it
 * and how fast, but does not eliminate a determined attacker who already
 * controls both the admin session and a DNS zone.
 */
export async function assertPublicHost(host: string): Promise<void> {
  let addresses: string[];
  try {
    const resolved = await dns.lookup(host, { all: true, verbatim: true });
    addresses = resolved.map((entry) => entry.address);
  } catch {
    throw new Error(`Could not resolve host "${host}".`);
  }

  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new Error(`Host "${host}" resolves to a non-routable or internal address.`);
    }
  }
}

function isBlockedAddress(address: string): boolean {
  return isIPv4(address) ? isBlockedIpv4(address) : isBlockedIpv6(address);
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

// CIDR ranges an SMTP-test target must never resolve to. Covers loopback,
// RFC 1918 private space, link-local (incl. the 169.254.169.254 cloud
// metadata endpoint), CGNAT, documentation/test ranges, and multicast/
// reserved space — not just the minimum set the brief named.
const BLOCKED_IPV4_RANGES: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function isBlockedIpv4(ip: string): boolean {
  const ipInt = ipv4ToInt(ip);
  return BLOCKED_IPV4_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ipInt & mask) === (ipv4ToInt(base) & mask);
  });
}

function isBlockedIpv6(rawIp: string): boolean {
  const ip = rawIp.toLowerCase();
  if (ip === '::1' || ip === '::') return true;

  // IPv4-mapped (::ffff:a.b.c.d) — check the embedded IPv4 address too.
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);

  const firstGroup = ip.split(':')[0];
  // fc00::/7 (unique local) — first 7 bits are 1111110x, i.e. the first
  // hextet's leading byte is 0xfc or 0xfd.
  if (/^f[cd]/.test(firstGroup)) return true;
  // fe80::/10 (link-local) — leading 10 bits 1111111010, i.e. first hextet
  // in fe80..febf.
  if (/^fe[89ab]/.test(firstGroup)) return true;

  return false;
}
