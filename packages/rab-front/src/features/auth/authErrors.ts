export function retryAfterSeconds(value: unknown, now = Date.now()): number {
  const numeric = Number(value);
  if (value != null && Number.isFinite(numeric) && numeric >= 0) return Math.ceil(numeric);
  const date = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - now) / 1000)) : 60;
}

/** Server code (rab-server `WORKSPACE_HOST_SIGN_IN_REFUSED`): a sign-in attempted on a workspace host that is not the account's own. No session was created. */
export const WORKSPACE_HOST_SIGN_IN_REFUSED = 'WORKSPACE_HOST_SIGN_IN_REFUSED';
export const WRONG_WORKSPACE_SIGN_IN_MESSAGE = 'This account belongs to a different workspace. Sign in from your own workspace address, or from the main sign-in page.';
export const SESSION_NOT_ESTABLISHED_MESSAGE = 'We couldn\u2019t finish signing you in. Please try again.';

/** Thrown by the sign-in flow when the server accepted the credentials but the new session could not be read back. */
export class SessionNotEstablishedError extends Error {
  constructor() {
    super(SESSION_NOT_ESTABLISHED_MESSAGE);
    this.name = 'SessionNotEstablishedError';
  }
}

/** The one message for a wrong email AND a wrong password (server `UnauthorizedException('Invalid email or password.')`). */
export const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password.';

/**
 * rab-server `AuthService.login` code `AMBIGUOUS_ACCOUNTS` (401): the password matched TWO accounts in different
 * organisations. Thrown only AFTER the password was verified for both, so it never says whether an email exists: a wrong
 * email or a wrong password still gets the uniform `INVALID_CREDENTIALS_MESSAGE`.
 */
export const AMBIGUOUS_ACCOUNTS = 'AMBIGUOUS_ACCOUNTS';
export const AMBIGUOUS_ACCOUNTS_MESSAGE = 'This email address belongs to more than one Crewflow account. Ask your administrator to resolve it before signing in.';

export function loginError(error: any): { message: string; cooldown: number; signInUrl?: string } {
  // W6-E2E-02: never "Unable to reach the server" for a server that answered. Neither case is a network failure.
  if (error instanceof SessionNotEstablishedError) return { message: SESSION_NOT_ESTABLISHED_MESSAGE, cooldown: 0 };
  const status = error?.response?.status;
  if (status === 404 && error.response?.data?.code === WORKSPACE_HOST_SIGN_IN_REFUSED) {
    const url = error.response.data.canonicalUrl;
    return { message: WRONG_WORKSPACE_SIGN_IN_MESSAGE, cooldown: 0, ...(typeof url === 'string' ? { signInUrl: url } : {}) };
  }
  // Branch on the server's machine-readable code only (never on its message text). Every other 401, including a
  // suspended organisation (which the server sends without a code), stays the uniform credentials message.
  if (status === 401 && error.response?.data?.code === AMBIGUOUS_ACCOUNTS) return { message: AMBIGUOUS_ACCOUNTS_MESSAGE, cooldown: 0 };
  if (status === 401) return { message: INVALID_CREDENTIALS_MESSAGE, cooldown: 0 };
  if (status === 403) return { message: 'This account does not have access to the Manager system.', cooldown: 0 };
  if (status === 429) {
    const cooldown = retryAfterSeconds(error.response.headers?.['retry-after'] ?? error.response.data?.retryAfter);
    const minutes = Math.max(1, Math.ceil(cooldown / 60));
    return { message: `Too many sign-in attempts. Please try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`, cooldown };
  }
  return { message: status ? 'Unable to sign in right now. Please try again.' : 'Unable to reach the server. Check your connection and try again.', cooldown: 0 };
}

export type ApplicationTarget = 'manager_web' | 'venue_manager_app' | 'staff_app';
export function safeApplicationTarget(value: unknown): ApplicationTarget | null {
  return value === 'manager_web' || value === 'venue_manager_app' || value === 'staff_app' ? value : null;
}
/**
 * `managerLoginUrl` is the backend-supplied ABSOLUTE URL to the Manager app's
 * own domain (`APP_URL`/login) — required once activation/reset pages are
 * served from the separate accounts domain, where a relative `/login` would
 * open the accounts site's own (nonexistent) login page instead of the
 * Manager app. Falls back to the old relative `/login` for callers that
 * don't have one yet (e.g. `SetPassword.tsx`'s own hardcoded success link,
 * which is same-origin by construction and unaffected by this).
 */
export function loginDestination(target: ApplicationTarget, managerLoginUrl?: string): string {
  return target === 'manager_web' ? (managerLoginUrl ?? '/login') : 'rab://login';
}

/**
 * The single source of truth for post-activation/post-reset success copy —
 * shared by `ActivateAccount.tsx` and `ResetPassword.tsx` so the two stay in
 * sync rather than re-deriving this branch twice. Manager/CEO gets sent back
 * into the Manager Portal; Staff and Venue Manager are told to use the
 * mobile app and are never routed into the Manager web app (the `rab://login`
 * target is a plain return-to-app link, not re-authentication).
 */
export function postAuthSuccessCopy(target: ApplicationTarget, managerLoginUrl?: string): { description?: string; actionLabel: string; loginHref: string } {
  const loginHref = loginDestination(target, managerLoginUrl);
  if (target === 'manager_web') return { actionLabel: 'Continue to Manager Portal', loginHref };
  return { description: 'You can now sign in using the ADOLPHUS mobile app.', actionLabel: 'Open the app', loginHref };
}
