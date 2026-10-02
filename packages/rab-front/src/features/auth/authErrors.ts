export function retryAfterSeconds(value: unknown, now = Date.now()): number {
  const numeric = Number(value);
  if (value != null && Number.isFinite(numeric) && numeric >= 0) return Math.ceil(numeric);
  const date = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - now) / 1000)) : 60;
}

export function loginError(error: any): { message: string; cooldown: number } {
  const status = error.response?.status;
  if (status === 401) return { message: 'Invalid email or password.', cooldown: 0 };
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
