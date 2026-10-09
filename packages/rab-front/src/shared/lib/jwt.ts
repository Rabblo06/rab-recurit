/**
 * Client-side JWT PAYLOAD decode — never a verification. The access token is
 * signed server-side and this module never checks that signature (it can't:
 * no key is ever shipped to the browser); nothing here is, or may become, an
 * authorization decision. Its one purpose is identity *bookkeeping* for the
 * P0.1 session-mixing fix (FULL-ARCHITECTURE-UPGRADE-PLAN.md §8.1/§16B): the
 * frontend needs to know "is this still the same user/session I had a moment
 * ago" without a server round trip, and the JWT already carries `sub` (user
 * id) and `sid` (session/family id) in its own payload — reading them here
 * avoids a new backend endpoint or response-shape change for something that's
 * already present. The server remains the sole security authority regardless
 * of whether this decode ever runs, fails, or is fed a tampered token.
 */
export interface DecodedAccessTokenPayload {
  sub: string | null;
  sid: string | null;
}

const EMPTY: DecodedAccessTokenPayload = { sub: null, sid: null };

function base64UrlDecode(segment: string): string {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/').padEnd(segment.length + ((4 - (segment.length % 4)) % 4), '=');
  // atob is available in every browser target this app ships to; Node's test
  // environment (jsdom) also provides it.
  return atob(padded);
}

/** Never throws — a malformed/non-JWT string (e.g. a test fixture's plain `'access-token-1'`) decodes to `{sub: null, sid: null}`, never an exception. */
export function decodeAccessToken(token: string | null | undefined): DecodedAccessTokenPayload {
  if (!token) return EMPTY;
  const parts = token.split('.');
  if (parts.length !== 3) return EMPTY;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1]!)) as { sub?: unknown; sid?: unknown };
    return {
      sub: typeof payload.sub === 'string' ? payload.sub : null,
      sid: typeof payload.sid === 'string' ? payload.sid : null,
    };
  } catch {
    return EMPTY;
  }
}
