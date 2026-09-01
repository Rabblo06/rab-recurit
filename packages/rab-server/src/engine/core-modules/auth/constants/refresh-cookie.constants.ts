import { CookieOptions } from 'express';

/**
 * Web's long-lived refresh credential moved out of JS-readable storage
 * (localStorage) into this HttpOnly cookie — see rab-workforce-architecture.md
 * §8.1 and the security remediation history. Mobile is unaffected: it
 * continues to receive the refresh token in the JSON body and store it in
 * `flutter_secure_storage` (already OS-secured, no browser XSS surface to
 * defend against) — see `PLATFORM_HEADER` below for how a request opts into
 * that legacy body-based shape.
 *
 * `rab-front` (Vercel) and `rab-server` (Render) are genuinely different
 * origins in production — this is a real cross-site cookie, not same-site,
 * so `SameSite=None; Secure` is the only configuration the browser will
 * honour there at all. Local dev's two localhost ports ARE same-site (the
 * host component matches; only the port differs, which SameSite ignores),
 * so `Lax` + no `Secure` works there without needing HTTPS locally — using
 * `None` in dev would just make the cookie silently rejected (browsers
 * refuse `SameSite=None` without `Secure`, and `Secure` cookies require
 * HTTPS), not more secure.
 */
export const REFRESH_COOKIE_NAME = 'rab_rt';

/**
 * Every route that legitimately reads this cookie or issues it lives under
 * this prefix — scoping `Path` here means the browser never attaches it to
 * an ordinary API call (`/rest/v1/staff`, etc.), shrinking both the
 * transmission surface and the CSRF-relevant endpoint set to exactly the
 * three routes reasoned about in `AuthController`'s own comments.
 */
export const REFRESH_COOKIE_PATH = '/rest/v1/auth';

/** Mobile sends this to opt into the legacy body-based refresh-token shape; its absence is treated as "this is a browser," matching CLAUDE.md's fail-closed default (never assume a client can hold a long-lived secret safely unless it proves otherwise). */
export const CLIENT_PLATFORM_HEADER = 'x-client-platform';
export const MOBILE_PLATFORM_VALUE = 'mobile';

export function buildRefreshCookieOptions(isProduction: boolean, maxAgeMs: number): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: REFRESH_COOKIE_PATH,
    maxAge: maxAgeMs,
    // No `domain` set — omitting it scopes the cookie to the exact host
    // that issued it (the API's own origin), the narrowest possible
    // option. A wildcard like `.rab.example.com` would leak this cookie to
    // every future Workspace subdomain the moment hostname-based routing
    // ships — deliberately not done, see the architecture doc's own
    // deferred-Increment-2 note on that feature.
  };
}

export function clearRefreshCookieOptions(isProduction: boolean): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: REFRESH_COOKIE_PATH,
  };
}
