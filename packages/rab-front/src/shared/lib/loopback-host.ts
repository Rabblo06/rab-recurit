const LOOPBACK_ALIASES = new Set(['localhost', '127.0.0.1']);

/**
 * LOCAL DEVELOPMENT ONLY (called from main.tsx behind `import.meta.env.DEV`).
 *
 * `localhost` and `127.0.0.1` are different *sites* to a browser. With the console on http://localhost:5173 and the API on
 * http://127.0.0.1:3000, every API call is cross-site, so the `SameSite=Lax` session cookie set by sign-in is never stored
 * or sent: sign-in appears to work (from memory) and the first reload lands back on /login. Activation and invitation
 * emails link to APP_URL, so whichever alias APP_URL uses decides which one a freshly activated user lands on.
 *
 * Rather than weakening the cookie, the page moves onto the API's own loopback alias before the app boots. Returns the URL
 * to switch to, or null when nothing needs to change (same host already, a real hostname, or a non-loopback API).
 */
export function canonicalLoopbackUrl(pageHref: string, apiBaseUrl: string): string | null {
  let page: URL;
  let api: URL;
  try {
    page = new URL(pageHref);
    api = new URL(apiBaseUrl);
  } catch {
    return null;
  }
  if (!LOOPBACK_ALIASES.has(page.hostname) || !LOOPBACK_ALIASES.has(api.hostname) || page.hostname === api.hostname) return null;
  page.hostname = api.hostname;
  return page.toString();
}
