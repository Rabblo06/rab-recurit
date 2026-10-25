import { api } from '../../../shared/api';
import type { SsoProvider } from '../../auth/mfa/mfaApi';

/**
 * Microsoft re-authentication for an account with no password (rab-server `OidcReauthService`, STEP1 P6) is a full page
 * round trip: a top-level form POST, the provider's forced sign-in, then a redirect to one of the server's FIXED return
 * paths with `?reauth=ok|failed`; `/settings/security` is on that allowlist (SSO_REAUTH_RETURN_PATHS). The dialog leaves
 * itself a note of WHICH action to resume. (The Account page still forwards a `?reauth=` return carrying that note to
 * `/settings/security`, for a return that was started before this page existed.)
 *
 * The note is only the action name and a timestamp — no secret, code, token or personal data — in sessionStorage
 * (this tab only), read once. It grants nothing: the server checks the re-auth grant on the next request.
 */
export type ReauthIntent = 'enrol' | 'regenerate' | 'disable';

const KEY = 'cf-security-reauth-intent';
const MAX_AGE_MS = 15 * 60 * 1000;
export const REAUTH_RETURN_PATH = '/settings/security';

export function rememberReauthIntent(intent: ReauthIntent): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ intent, at: Date.now() }));
  } catch {
    // Storage blocked: the user lands on Account and reopens the dialog themselves.
  }
}

function read(): ReauthIntent | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { intent?: unknown; at?: unknown };
    const fresh =
      typeof parsed.at === 'number' && Date.now() - parsed.at < MAX_AGE_MS;
    return fresh &&
      (parsed.intent === 'enrol' ||
        parsed.intent === 'regenerate' ||
        parsed.intent === 'disable')
      ? parsed.intent
      : null;
  } catch {
    return null;
  }
}

/** True when a pending note exists (the Account page uses it to forward the return). */
export function hasReauthIntent(): boolean {
  return read() !== null;
}

/** Reads AND clears the note. */
export function takeReauthIntent(): ReauthIntent | null {
  const intent = read();
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
  return intent;
}

const FORM_MARKER = 'data-acs-reauth';
/** If the browser has not left after this long (e.g. the POST was blocked), a new attempt is allowed again. */
const LEAVING_WINDOW_MS = 30_000;

/**
 * Starts the provider re-authentication: a top-level form POST (the server authenticates the session cookie, checks the
 * Origin, and redirects to the provider). Built outside the dialog's own <form> (forms can't nest). At most ONE such POST
 * per page: while the browser is leaving, a second call does nothing and returns false.
 */
export function startProviderReauth(
  provider: SsoProvider,
  intent: ReauthIntent,
): boolean {
  const pending = document.querySelector<HTMLFormElement>(`form[${FORM_MARKER}]`);
  if (pending) {
    if (Date.now() - Number(pending.dataset.startedAt ?? 0) < LEAVING_WINDOW_MS) return false;
    pending.remove();
  }
  rememberReauthIntent(intent);
  const form = document.createElement('form');
  form.setAttribute(FORM_MARKER, provider);
  form.dataset.startedAt = String(Date.now());
  form.method = 'post';
  form.action = `${api.defaults?.baseURL ?? ''}/auth/${provider}/reauthenticate`;
  const returnTo = document.createElement('input');
  returnTo.type = 'hidden';
  returnTo.name = 'returnTo';
  returnTo.value = REAUTH_RETURN_PATH;
  form.appendChild(returnTo);
  document.body.appendChild(form);
  form.submit();
  return true;
}
