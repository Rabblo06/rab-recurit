import { api } from '../api';
import { getSessionStatus, subscribeToSession } from './auth-session';

export type Theme = 'light' | 'dark' | 'system';
type ResolvedTheme = 'light' | 'dark';

const KEY = 'theme';
let mediaQuery: MediaQueryList | null = null;
let syncTimer: number | undefined;
let syncedForCurrentSession = false;
// Snapshot of "did this device already have an explicit preference", taken
// once at `initTheme()` time — see that function's own comment for why this
// can't be re-derived from `localStorage.getItem(KEY)` later.
let hadExplicitPreferenceAtBoot = false;

function resolve(theme: Theme): ResolvedTheme {
  if (theme !== 'system') return theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function getTheme(): Theme {
  return (localStorage.getItem(KEY) as Theme) || 'system';
}

function onSystemChange() {
  if (getTheme() === 'system') {
    document.documentElement.setAttribute('data-theme', resolve('system'));
  }
}

/** Debounced round-trip so the preference is genuinely server-persisted, not just localStorage. */
function syncToServer(theme: Theme) {
  window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => {
    api.patch('/profile/preferences', { theme }).catch(() => {
      // Best-effort — the local/localStorage value is still authoritative for this device.
    });
  }, 400);
}

export function applyTheme(theme: Theme, opts: { persist?: boolean } = {}) {
  document.documentElement.setAttribute('data-theme', resolve(theme));
  localStorage.setItem(KEY, theme);

  if (mediaQuery) mediaQuery.removeEventListener('change', onSystemChange);
  if (theme === 'system') {
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQuery.addEventListener('change', onSystemChange);
  }

  if (opts.persist !== false) syncToServer(theme);
}

export function cycleTheme(): Theme {
  const order: Theme[] = ['light', 'dark', 'system'];
  const next = order[(order.indexOf(getTheme()) + 1) % order.length]!;
  applyTheme(next);
  return next;
}

/**
 * PHASE 12 / UI-03 — this used to gate on `localStorage.getItem('accessToken')`
 * to decide whether a session exists before fetching the server default.
 * That check was already dead the moment Phase 10 moved the access token to
 * an in-memory-only value (`auth-session.ts`): `initTheme()` runs
 * synchronously in `main.tsx`, before `SessionBootstrap` has even started
 * resolving whether the refresh cookie is valid, and `localStorage` never
 * holds an access token at all anymore — so this branch always took the
 * early return, for every user, on every device, permanently. Reacting to
 * the real session store instead of guessing from storage is what actually
 * makes "sync the server default down on first load" work again.
 *
 * `syncedForCurrentSession` bounds it to once per continuous authenticated
 * session, not once per `markAuthenticated()` emit — the session store also
 * re-emits on ordinary background token refreshes (tab-visibility
 * revalidation, cross-tab broadcast), which must not each re-fetch
 * preferences. It resets on `markUnauthenticated()` so a genuine logout ->
 * login cycle in the same tab syncs again for the new session.
 */
function syncFromServerOnceAuthenticated() {
  if (getSessionStatus() !== 'authenticated') {
    syncedForCurrentSession = false;
    return;
  }
  if (syncedForCurrentSession) return;
  syncedForCurrentSession = true;

  api
    .get<{ theme: Theme }>('/profile/preferences')
    .then(({ data }) => {
      if (!hadExplicitPreferenceAtBoot && data.theme) {
        applyTheme(data.theme, { persist: false });
      }
    })
    .catch(() => {
      // Session present but the request failed — localStorage value stands.
    });
}

/**
 * Zero-flicker: applies the localStorage value immediately, then quietly
 * syncs the server default down (without re-triggering a write) once a real
 * session is confirmed authenticated.
 *
 * `hadExplicitPreferenceAtBoot` must be captured BEFORE the `applyTheme`
 * call below, not read back from `localStorage` afterwards — `applyTheme`
 * unconditionally calls `localStorage.setItem(KEY, theme)` as part of the
 * zero-flicker apply itself (so `getTheme()` stays consistent across
 * reloads even for the resolved 'system' default), which would otherwise
 * make `localStorage.getItem(KEY)` look non-empty on every single boot,
 * including a genuinely brand-new device that never had a real preference —
 * permanently defeating the "sync the server default on first load" check
 * this same value gates, regardless of the session-store fix above.
 */
export function initTheme() {
  hadExplicitPreferenceAtBoot = localStorage.getItem(KEY) !== null;
  applyTheme(getTheme(), { persist: false });
  subscribeToSession(syncFromServerOnceAuthenticated);
  syncFromServerOnceAuthenticated();
}
