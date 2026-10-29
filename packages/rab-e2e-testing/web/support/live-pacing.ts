import type { BrowserContext } from '@playwright/test';

/**
 * Client-side pacing for the live-backend specs: POST /auth/login and POST /auth/refresh are REALLY rate limited, 5 per 60 s
 * per client IP each (`AUTH_THROTTLE`, rab-server auth.controller.ts). The limit is a security control and is never relaxed
 * for tests — the specs wait their turn instead, like a well-behaved client.
 *
 * Counts the calls the browser actually makes (a signed-out page load bootstraps through /auth/refresh, twice under the
 * development build's React StrictMode), so a spec never has to guess. Module state: one budget per spec file (the live
 * runner runs one file per process and waits out the window between files).
 */
type Kind = 'login' | 'refresh';
const WINDOW_MS = 61_000;
const BUDGET = 4; // of the server's 5 per window: one in reserve for the two clocks drifting apart
const calls: Record<Kind, number[]> = { login: [], refresh: [] };

/** Records every login / refresh request this browser context sends. Call once per context, before it navigates. */
export function observeAuthCalls(context: BrowserContext): void {
  context.on('request', (request) => {
    if (request.method() !== 'POST') return;
    const match = /\/rest\/v1\/auth\/(login|refresh)$/.exec(new URL(request.url()).pathname);
    if (match) calls[match[1] as Kind].push(Date.now());
  });
}

/** Waits until `upcoming` more calls of `kind` fit in the current window. */
export async function paceAuth(kind: Kind, upcoming: number): Promise<void> {
  for (;;) {
    const now = Date.now();
    calls[kind] = calls[kind].filter((t) => now - t < WINDOW_MS);
    if (calls[kind].length + upcoming <= BUDGET) return;
    await new Promise((resolve) => setTimeout(resolve, WINDOW_MS - (now - calls[kind][0]!) + 250));
  }
}

/** A signed-out full page load (bootstraps through /auth/refresh up to twice in the development build). */
export const paceSignedOutPageLoad = (): Promise<void> => paceAuth('refresh', 2);
/** One "Sign in" (one POST /auth/login). */
export const paceSignIn = (): Promise<void> => paceAuth('login', 1);
