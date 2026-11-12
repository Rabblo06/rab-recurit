import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/**
 * `React.lazy` with two additions (fast first navigation, 2026-11-11):
 *
 * - `preload()`: starts the same import the route will use, so the shell can fetch a page's code when the browser is idle
 *   or when a nav link is hovered/focused. Calling it repeatedly (or rendering the component afterwards) reuses ONE
 *   in-flight promise; nothing is downloaded twice.
 * - Retry: a failed chunk import is retried once after a short delay (a network blip). If it fails again with a chunk-load
 *   error — typically an old tab asking for a chunk a newer deploy removed — the page reloads ONCE to pick up the new
 *   build. A reload marker in sessionStorage stops a reload loop: a second failure within the window is thrown to the
 *   nearest error boundary instead.
 *
 * Only the page's own code is affected: auth, data and permissions are unchanged (every route stays enforced server-side).
 */

export type PreloadableComponent<T extends ComponentType<any>> = LazyExoticComponent<T> & {
  preload: () => Promise<{ default: T }>;
};

type Importer<T> = () => Promise<{ default: T }>;

const RELOAD_KEY = 'crewflow.chunk-reload-at';
/** A reload already happened within this window: do not reload again (no loop). */
const RELOAD_WINDOW_MS = 30_000;
const RETRY_DELAY_MS = 400;

/** The messages browsers and bundlers use when a dynamically imported module cannot be fetched or evaluated. */
export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === 'ChunkLoadError') return true;
  return typeof message === 'string'
    && /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|Loading (CSS )?chunk [\w-]+ failed/i.test(message);
}

function readReloadAt(): number | null {
  try {
    const raw = window.sessionStorage.getItem(RELOAD_KEY);
    const at = raw === null ? NaN : Number(raw);
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

/**
 * Reloads the page once per window to recover from a missing chunk. Returns false (and does nothing) when a reload already
 * happened recently or sessionStorage is unavailable — the caller then surfaces the error instead of looping.
 */
export function reloadOnceForNewBuild(now: () => number = Date.now, reload: () => void = () => window.location.reload()): boolean {
  const last = readReloadAt();
  if (last !== null && now() - last < RELOAD_WINDOW_MS) return false;
  try {
    window.sessionStorage.setItem(RELOAD_KEY, String(now()));
  } catch {
    // Without a marker a reload could loop: never reload blind.
    return false;
  }
  reload();
  return true;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs `factory`, retrying once on any failure; a second chunk-load failure triggers the one guarded reload. */
export async function importWithRetry<T>(
  factory: Importer<T>,
  options: { retryDelayMs?: number; onReload?: () => boolean } = {},
): Promise<{ default: T }> {
  try {
    return await factory();
  } catch (first) {
    await delay(options.retryDelayMs ?? RETRY_DELAY_MS);
    try {
      return await factory();
    } catch (second) {
      if (isChunkLoadError(second) && (options.onReload ?? reloadOnceForNewBuild)()) {
        // The page is reloading; keep React suspended (no error flash) until it does.
        return new Promise<never>(() => {});
      }
      throw second ?? first;
    }
  }
}

export function lazyWithPreload<T extends ComponentType<any>>(factory: Importer<T>): PreloadableComponent<T> {
  let pending: Promise<{ default: T }> | undefined;
  // `allowReload`: only rendering the route may reload the page. A background preload (idle, hover) that fails just
  // forgets its attempt, so the real navigation later tries again (and may then recover with the guarded reload).
  const load = (allowReload: boolean) => {
    if (!pending) {
      pending = importWithRetry(factory, allowReload ? {} : { onReload: () => false }).catch((error: unknown) => {
        pending = undefined;
        throw error;
      });
    }
    return pending;
  };
  const Component = lazy(() => load(true)) as PreloadableComponent<T>;
  Component.preload = () => load(false);
  return Component;
}

/** Fire-and-forget preload: a failure here is never surfaced (the route retries when it is actually opened). */
export function preloadQuietly(component: { preload: () => Promise<unknown> }): void {
  component.preload().catch(() => {});
}

/**
 * Vite fires `vite:preloadError` when it cannot preload a dynamic import's dependencies (CSS or shared chunks) — the same
 * "deploy removed the old chunk" case. Reload once (guarded) instead of letting the import throw.
 */
export function installChunkPreloadErrorReload(): void {
  window.addEventListener('vite:preloadError', (event) => {
    if (reloadOnceForNewBuild()) event.preventDefault();
  });
}
