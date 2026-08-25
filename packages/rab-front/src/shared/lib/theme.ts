import { api } from '../api';

export type Theme = 'light' | 'dark' | 'system';
type ResolvedTheme = 'light' | 'dark';

const KEY = 'theme';
let mediaQuery: MediaQueryList | null = null;
let syncTimer: number | undefined;

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

/** Zero-flicker: applies the localStorage value immediately, then quietly syncs the server default down (without re-triggering a write) on first load on a new device. */
export function initTheme() {
  applyTheme(getTheme(), { persist: false });

  // No session yet (e.g. the login screen) — skip the request entirely.
  // A doomed 401 here previously fed api.ts's clearSessionAndRedirect,
  // which reassigns location.href to '/login' unconditionally; on a page
  // already at '/login' that reassignment still reloads it, re-running this
  // same code on boot and looping.
  if (!localStorage.getItem('accessToken')) return;

  api
    .get<{ theme: Theme }>('/profile/preferences')
    .then(({ data }) => {
      if (!localStorage.getItem(KEY) && data.theme) {
        applyTheme(data.theme, { persist: false });
      }
    })
    .catch(() => {
      // Token present but rejected (expired/invalid) — localStorage value stands.
    });
}
