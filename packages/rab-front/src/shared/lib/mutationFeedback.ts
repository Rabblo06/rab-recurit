import axios from 'axios';
import { normalizeApiError, type ApiErrorOptions, type NormalizedApiError } from './apiError';
import { toast } from './toast';

export interface NotifyApiErrorOptions extends ApiErrorOptions {
  /** What failed, in the user's words ("Could not save your profile."): used whenever the server gives nothing safer. */
  fallback: string;
  /**
   * Re-runs the same operation. Offered as "Try again" only when a retry can plausibly succeed (connection lost,
   * timeout, 5xx). Never for validation, permission, conflict or rate limiting, where repeating cannot help.
   */
  retry?: () => void;
  /** Keep the toast until dismissed (e.g. a partial failure the user must read). Session expiry is always persistent. */
  persistent?: boolean;
  /** Text placed before the message, e.g. "Venue saved, but the photo could not be uploaded." */
  prefix?: string;
}

/** Errors that are not a failure the user caused or can act on: a cancelled request, or a response from a previous identity. */
export function isSilentError(error: unknown): boolean {
  if (axios.isCancel(error)) return true;
  if (axios.isAxiosError(error) && error.code === 'ERR_CANCELED') return true;
  // shared/api.ts rejects a response that arrived after the browser's identity changed; the page is being rebuilt.
  return error instanceof Error && error.message.startsWith('Stale response:');
}

const RETRY_KINDS = new Set(['offline', 'timeout', 'server']);

/** Where "Sign in again" goes. Kept here so a test can observe it; a full navigation rebuilds every piece of state. */
export const signInAgain = { go: () => window.location.assign('/login') };

/**
 * The ONE way a failed user action becomes an error toast. Builds the safe text with `normalizeApiError` (never raw
 * server, SQL, stack or path text), then adds the next step the user can take:
 *  - 401 → persistent, "Sign in again" (normally `shared/api.ts` has already redirected; this covers the case where it
 *    could not, e.g. identity resolution failed mid-flight);
 *  - offline / timeout / 5xx with `retry` → "Try again";
 *  - everything else → the message alone (it already says what to do: "Choose a smaller file", "Refresh and try again").
 * Returns the normalized error (or null when nothing was shown) so callers can still branch on `kind` / `code`.
 */
export function notifyApiError(error: unknown, options: NotifyApiErrorOptions): NormalizedApiError | null {
  if (isSilentError(error)) return null;
  // A 5xx carries nothing safe to show, so "what failed" (the caller's fallback, e.g. "Could not remove your photo.")
  // says more than the generic "Something went wrong"; an explicit `messages.server` still wins.
  const normalized = normalizeApiError(error, { ...options, messages: { server: options.fallback, ...options.messages } });
  const text = options.prefix ? `${options.prefix.trim()} ${normalized.message}` : normalized.message;
  if (normalized.kind === 'unauthorized') {
    toast.error(text, { persistent: true, action: { label: 'Sign in again', onClick: () => signInAgain.go() } });
  } else if (options.retry && RETRY_KINDS.has(normalized.kind)) {
    toast.error(text, { persistent: options.persistent, action: { label: 'Try again', onClick: options.retry } });
  } else {
    toast.error(text, { persistent: options.persistent });
  }
  return normalized;
}
