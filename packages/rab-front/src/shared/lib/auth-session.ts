/**
 * The single source of truth for Web's client-side session state — an
 * external store (not React state) so both plain modules (`api.ts`'s 401
 * handler, which isn't a component) and React components (`SessionProvider`,
 * via `useSyncExternalStore`) can read and update it consistently.
 *
 * The access token itself lives here too, as a plain in-memory value,
 * deliberately never persisted anywhere (localStorage/sessionStorage/
 * IndexedDB). It's gone on every hard reload, by design — `bootstrapSession()`
 * (see `api.ts`) re-derives a fresh one from the HttpOnly `rab_rt` refresh
 * cookie on boot instead. That cookie is the only long-lived credential Web
 * holds now, and JavaScript can never read it — see
 * rab-workforce-architecture.md §8.1 and the security remediation history
 * for why this replaced the old localStorage-based pair.
 */
export type SessionStatus = 'loading' | 'authenticated' | 'unauthenticated';

let accessToken: string | null = null;
let status: SessionStatus = 'loading';
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function getSessionStatus(): SessionStatus {
  return status;
}

export function subscribeToSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function markAuthenticated(token: string): void {
  accessToken = token;
  status = 'authenticated';
  emit();
}

export function markUnauthenticated(): void {
  accessToken = null;
  status = 'unauthenticated';
  emit();
}
