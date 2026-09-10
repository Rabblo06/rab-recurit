/**
 * Structural, not `express.Request` — Nest's `ThrottlerGetTrackerFunction`
 * types its parameter as a bare `Record<string, any>` (it's shared across
 * HTTP/WS/RPC transports), so a real `Request` argument doesn't satisfy it
 * even though an actual Express request is what's passed at runtime. Only
 * the two fields this function reads are declared here.
 */
interface MinimalClientIpRequest {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
}

/**
 * A minimal, dependency-free IPv4/IPv6 literal check — just enough to reject
 * a header value that clearly isn't an IP at all (an attacker sending
 * `CF-Connecting-IP: <script>` or an empty string), not full RFC validation.
 */
function looksLikeIp(value: string): boolean {
  return /^[0-9a-fA-F:.]+$/.test(value) && value.length <= 45 && value.length > 0;
}

/**
 * Resolves the real client IP for rate-limiting and audit trails
 * (`login_history`) — see SEC-03. Production (`rab-server-stfz.onrender.com`)
 * is verified (live response headers: `Server: cloudflare`, `CF-RAY`) to sit
 * behind Cloudflare in front of Render's own edge, an exact hop count this
 * codebase cannot independently confirm (Render doesn't document how many
 * additional hops its own internal load balancer adds on top of Cloudflare's).
 * `CF-Connecting-IP` sidesteps that uncertainty entirely: Cloudflare sets it
 * at their edge from the real TCP connection, unconditionally overwriting
 * any value already on the request rather than appending to it the way
 * `X-Forwarded-For` does — so, as long as the origin is only reachable
 * through Cloudflare (true for both `*.onrender.com` and any custom domain
 * proxied through Cloudflare), a client cannot spoof this header no matter
 * how many hops sit between Cloudflare and this process.
 *
 * Falls back to Express's own `req.ip` (proxy-aware via `trust proxy` in
 * main.ts) when `CF-Connecting-IP` is absent — local dev, or any future
 * deployment target that isn't Cloudflare-fronted. That fallback path is
 * genuinely a single trusted hop today (`trust proxy = 1`), which is why
 * main.ts still sets it rather than relying on this header alone.
 */
export function resolveClientIp(req: MinimalClientIpRequest): string {
  const cfConnectingIp = req.headers['cf-connecting-ip'];
  const cfValue = Array.isArray(cfConnectingIp) ? cfConnectingIp[0] : cfConnectingIp;
  if (cfValue && looksLikeIp(cfValue)) return cfValue;
  return req.ip ?? 'unknown';
}
