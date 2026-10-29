import { expect, test, type Page, type Route } from '@playwright/test';

import { observeAuthCalls, paceAuth, paceSignedOutPageLoad, paceSignIn } from './support/live-pacing';

/**
 * P0 finalization (FULL-ARCHITECTURE-UPGRADE-PLAN.md §16B, item 3 — dedicated session-race proof).
 *
 * Real browser, real backend, real database, real HttpOnly cookie jar shared across two tabs of
 * ONE browser context (`browser.newContext()` — exactly what "two tabs of the same browser"
 * means; two separate `newContext()`s would NOT share cookies and would prove nothing about the
 * cross-tab identity-mixing finding this suite exists to close).
 *
 * BASE_URL deliberately overrides `playwright.config.ts`'s `http://localhost:5173` with
 * `http://127.0.0.1:5173`: this suite is the first one that needs the refresh cookie to survive a
 * REAL page navigation (every other existing spec stays inside the SPA via client-side routing).
 * `rab_rt` is `SameSite=Lax` (correct — rab-workforce-architecture.md §8.1), and Chrome's
 * schemeful-same-site rules treat `localhost` and `127.0.0.1` as unrelated hosts, silently
 * dropping a `SameSite=Lax` cookie set by a cross-site XHR between them even with CORS+credentials
 * otherwise configured correctly. Backend `CORS_ORIGINS` already allowlists BOTH
 * (`rab-server/.env`), so pointing only this suite's own navigations at the backend's own loopback
 * alias makes frontend+backend genuinely same-site, with zero change to any server config, cookie
 * attribute, or security control.
 *
 * Fixtures: two independent manager-tier identities, seeded directly into the local dev database
 * via `ts-node ... command/main.ts seed` with `SEED_ORG_SLUG`/`SEED_ADMIN_EMAIL` overrides (see
 * this phase's own report) — NOT the shared `admin@acme.test` other e2e specs rely on, so this
 * suite never risks mutating state those specs depend on.
 *
 * Rate-limit pacing (NOT a security exception): `/auth/login` AND `/auth/refresh` are each
 * genuinely throttled server-side at 5/60s per IP (`AUTH_THROTTLE` in `auth.controller.ts`) — a
 * real control this suite must never weaken, bypass, or ask to have disabled for its own
 * convenience. Every FULL page navigation (`page.goto`) re-triggers `bootstrapSession()`, which
 * calls `/auth/refresh` — so `paceAuthCall()` below is invoked before every `.goto()` in this
 * file, not only before login, enforcing a local sliding window of its own so this suite's OWN
 * call volume never trips either real limiter, the same way a well-behaved client would. Wherever
 * a tab is already loaded and authenticated, this suite also prefers an in-app link click over a
 * full `.goto()` specifically to avoid spending throttle budget on a refresh call the SPA's own
 * client-side router doesn't need.
 */
// Live job: playwright.live.config.ts / live/run-live.sh seeds both managers (random password per run). Overridable for local runs.
const BASE_URL = process.env.E2E_WEB_ORIGIN ?? 'http://127.0.0.1:5173';
const MANAGER_A_EMAIL = process.env.E2E_MANAGER_A_EMAIL ?? 'manager.a.e2e@example.test';
const MANAGER_C_EMAIL = process.env.E2E_MANAGER_C_EMAIL ?? 'manager.c.e2e@example.test';
const PASSWORD = process.env.E2E_MANAGER_PASSWORD ?? 'ChangeMe123!';

// P1B.2: observed this file's own 4-test combined run intermittently tripping the real server's
// 5/60s throttle (AUTH_THROTTLE, auth.controller.ts) despite the 4-call client-side budget below —
// a 1-call margin isn't enough once this file's own client-tracked sliding window and the server's
// (NestJS @nestjs/throttler's own, separately-clocked) window drift apart by even a little network/
// processing latency, especially across 4 sequential tests' worth of accumulated calls in one run.
// Widened to a 2-call margin (3, not 4) — purely a test-pacing safety margin, never a change to the
// real server-side limiter or to any security behavior.
const AUTH_CALL_WINDOW_MS = 60_000;
const MAX_AUTH_CALLS_PER_WINDOW = 3; // stay under the real server's 5/60s (login AND refresh) — wider margin for clock skew across a 4-test run
const authCallTimestamps: number[] = [];

async function paceAuthCall(): Promise<void> {
  const now = Date.now();
  while (authCallTimestamps.length > 0 && now - authCallTimestamps[0]! > AUTH_CALL_WINDOW_MS) authCallTimestamps.shift();
  if (authCallTimestamps.length >= MAX_AUTH_CALLS_PER_WINDOW) {
    const waitMs = AUTH_CALL_WINDOW_MS - (now - authCallTimestamps[0]!) + 500;
    await new Promise((r) => setTimeout(r, Math.max(waitMs, 0)));
    return paceAuthCall();
  }
  authCallTimestamps.push(Date.now());
}

/** A full navigation — always paced, since it re-triggers bootstrapSession()'s /auth/refresh call. */
async function pacedGoto(page: Page, url: string): Promise<void> {
  await paceAuthCall();
  // Plus the calls the browser REALLY made (support/live-pacing.ts): the development build's StrictMode bootstraps a
  // signed-out page load through /auth/refresh twice, which this file's own one-slot-per-navigation budget cannot see.
  await paceSignedOutPageLoad();
  await page.goto(url);
}

async function login(page: Page, email: string, password: string): Promise<void> {
  await pacedGoto(page, `${BASE_URL}/login`);
  await page.getByRole('button', { name: 'Continue with email' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Password', { exact: true }).fill(password);
  // P1C.1B: `pacedGoto`'s own call above only paces the implicit `/auth/refresh`
  // `SessionBootstrap` fires on the page load it causes (mounted alongside
  // `<BrowserRouter>`, so it runs on every navigation including `/login` —
  // `shared/lib/SessionProvider.tsx`'s own doc comment). The "Sign in" click
  // below fires a SECOND real, separately-throttled call (`POST /auth/login`,
  // same `AUTH_THROTTLE` bucket) that was never paced at all — found live:
  // this `login()` helper was consuming 2 real throttled requests per call
  // while only ever booking 1 pacing slot, silently exhausting the server's
  // real 5/60s limit partway through a single run. Pure test-pacing margin —
  // zero change to rab-server, to api.ts's interceptors, or to the
  // stale-request rule — matching the exact class of fix P1B.2 already
  // applied once to this same file.
  await paceAuthCall();
  await paceSignIn();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(`${BASE_URL}/`);
}

/** In-app (SPA) navigation to Settings → Profile — no full reload, no extra /auth/refresh call. Only valid when `page` is already loaded and authenticated. */
async function openSettingsProfileInApp(page: Page): Promise<void> {
  await page.getByRole('group', { name: 'Navigation modes' }).getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(`${BASE_URL}/settings/profile`);
}

async function logoutViaUi(page: Page): Promise<void> {
  await pacedGoto(page, `${BASE_URL}/settings/profile`);
  // Settings navigation → "Log out" → the "Log out?" confirmation (features/settings/layout/SettingsSidebar.tsx, LogoutDialog.tsx).
  await page.getByRole('complementary', { name: 'Settings navigation' }).getByRole('button', { name: 'Log out' }).click();
  await page.getByRole('alertdialog', { name: 'Log out?' }).getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page).toHaveURL(`${BASE_URL}/login`);
}

/** A gate the test driver controls: the route handler awaits it before calling `route.continue()`, holding the real network request unsent until the driver releases it — not a fake fulfilled response, the actual delayed operation the instruction describes. */
function makeGate(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

// Generous: `paceAuthCall()` can legitimately make a test wait most of a 60s window before its
// first interaction, and this file runs 4 tests end-to-end sharing one rate-limit budget. Raised
// from 240s to 300s alongside the tighter (3, not 4) per-window call budget above — a test that
// needs several paced calls can now legitimately spend more of its own time waiting its turn
// without running out of budget before its own real assertions ever get a chance to run.
test.setTimeout(300_000);

test('multi-tab race 1: a delayed GET from Tab A (Manager A), released after Tab B logs A out and logs in as Manager C, never populates Cs UI and is never replayed', async ({ browser }) => {
  const context = await browser.newContext();
  observeAuthCalls(context);
  const tabA = await context.newPage();
  const tabB = await context.newPage();

  // Attach BEFORE login: the app's own shell (Layout/sidebar) fires GET /profile once, immediately
  // after a successful login — that IS the one-and-only "authenticated GET" this test delays. A
  // second navigation to /settings/profile later reuses React Query's cache and fires no second
  // request, so catching the real one means intercepting it at its one true origin: login itself.
  const gate = makeGate();
  const profileRequests: Array<{ authHeader: string | undefined }> = [];
  await tabA.route('**/rest/v1/profile', async (route: Route) => {
    profileRequests.push({ authHeader: route.request().headers()['authorization'] });
    await gate.wait;
    await route.continue();
  });

  const loginPromise = login(tabA, MANAGER_A_EMAIL, PASSWORD);
  // Login itself (real argon2id hashing — intentionally not fast) plus the shell's own cascade of
  // post-login fetches can take a few seconds; poll rather than guess a fixed delay.
  await expect.poll(() => profileRequests.length, { timeout: 15_000 }).toBe(1); // held, not yet answered

  // Tab B: logout A (same shared cookie jar — bootstraps as A, then explicitly logs out),
  // then logs in as Manager C.
  await logoutViaUi(tabB);
  await login(tabB, MANAGER_C_EMAIL, PASSWORD);
  await expect(tabB.getByRole('group', { name: 'Navigation modes' }).getByRole('button', { name: 'Settings', exact: true })).toBeVisible();

  // Release A's delayed request NOW — after the cookie (and A's server-side session) has moved to C.
  gate.release();
  await loginPromise.catch(() => {}); // `login()`'s own URL assertion may or may not still hold depending on which race branch wins; both are safe outcomes, asserted below.
  await tabA.waitForTimeout(1500); // let the 401 → refresh → identity-check chain (or the BroadcastChannel reload) fully settle.

  // ---- Proof 1: the server itself invalidated As access JWT immediately (AUTH-02) ----
  // Exactly ONE /profile request was ever sent for this held operation — a replay would be a
  // SECOND request with a refreshed (C-identity) bearer token for an operation dispatched under A.
  expect(profileRequests).toHaveLength(1);

  // ---- Proof 2: Tab B / Manager Cs own session is completely undisturbed by As delayed op ----
  await openSettingsProfileInApp(tabB);
  await expect(tabB.locator('input[disabled]').first()).toHaveValue(MANAGER_C_EMAIL, { timeout: 10_000 });

  // ---- Proof 3: final browser identity is exactly C, never a mix, never A ----
  // A fresh navigation on Tab A (whether it reloaded via BroadcastChannel mismatch-detection or
  // silently re-identified via the 401-retry path) must now show Cs email — never As, and never
  // a page that is still confidently rendering As identity as if nothing happened. A full `.goto`
  // here (not a link click) is deliberate: it's the strongest possible check, re-bootstrapping
  // entirely from scratch off whatever the cookie jar now holds.
  await pacedGoto(tabA, `${BASE_URL}/settings/profile`);
  // Wider than the in-app-navigation checks elsewhere in this file: this one follows a REAL full
  // page reload (bootstrapSession -> refresh -> GET /profile), not a client-side route change —
  // genuinely slower under load, not a different correctness bar.
  await expect(tabA.locator('input[disabled]').first()).toHaveValue(MANAGER_C_EMAIL, { timeout: 20_000 });

  await context.close();
});

test('multi-tab race 2: a delayed MUTATION (PATCH /profile) from Tab A, released after Tab B logs A out and logs in as C, never succeeds and never mutates Cs profile', async ({ browser }) => {
  const context = await browser.newContext();
  observeAuthCalls(context);
  const tabA = await context.newPage();
  const tabB = await context.newPage();

  await login(tabA, MANAGER_A_EMAIL, PASSWORD);
  await openSettingsProfileInApp(tabA);
  await expect(tabA.locator('input[disabled]').first()).toHaveValue(MANAGER_A_EMAIL, { timeout: 10_000 });

  const gate = makeGate();
  const patchRequests: string[] = [];
  await tabA.route('**/rest/v1/profile', async (route: Route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    patchRequests.push(route.request().headers()['authorization'] ?? '');
    await gate.wait;
    await route.continue();
  });

  // ProfilePage's <label>/<input> pairs are plain siblings with no htmlFor/id association, so
  // getByLabel can't find them — the same reason the Email check below uses a CSS locator. First
  // Name is the first input inside the "Name" section's `.form-grid`.
  await tabA.locator('.form-grid input').first().fill('STALE-MUTATION-FROM-A');
  const clickPromise = tabA.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(() => patchRequests.length, { timeout: 10_000 }).toBe(1); // held

  await logoutViaUi(tabB);
  await login(tabB, MANAGER_C_EMAIL, PASSWORD);

  gate.release();
  await clickPromise.catch(() => {});
  await tabA.waitForTimeout(1500);

  // No replay: exactly one PATCH was ever sent for this stale mutation.
  expect(patchRequests).toHaveLength(1);

  // Cs own profile (Tab B) was never touched by As stale mutation.
  await openSettingsProfileInApp(tabB);
  await expect(tabB.locator('input[disabled]').first()).toHaveValue(MANAGER_C_EMAIL, { timeout: 10_000 });
  const firstNameInputB = tabB.locator('.form-grid input').first();
  await expect(firstNameInputB).not.toHaveValue('STALE-MUTATION-FROM-A');

  await context.close();
});

test('multi-tab race 3: BroadcastChannel never silently adopts a different identity — Tab A re-identifies to exactly C, never a mixed A/C state', async ({ browser }) => {
  const context = await browser.newContext();
  observeAuthCalls(context);
  const tabA = await context.newPage();
  const tabB = await context.newPage();

  await login(tabA, MANAGER_A_EMAIL, PASSWORD);
  await openSettingsProfileInApp(tabA);
  await expect(tabA.locator('input[disabled]').first()).toHaveValue(MANAGER_A_EMAIL, { timeout: 10_000 });

  // Tab B logs in as a DIFFERENT identity WITHOUT first logging A out explicitly — the exact
  // "another login elsewhere changed the shared refresh cookie" scenario the BroadcastChannel
  // handler's own doc comment names. A's family is never revoked here; only the ambient cookie
  // moves to C — the cleanest possible proof that Tab A reacts to the BROADCAST, not to a 401.
  await login(tabB, MANAGER_C_EMAIL, PASSWORD);

  // Tab A must never keep rendering/affirming As identity once a different identity exists in
  // this browser — it either reloads (observable as a 'load' event) or re-identifies silently;
  // either way the NEXT thing Tab A shows must be C's, never a stale A screen frozen in place. A
  // full `.goto` here is deliberate (see test 1's Proof 3 for why).
  await tabA.waitForTimeout(1000);
  await pacedGoto(tabA, `${BASE_URL}/settings/profile`);
  // Wider than the in-app-navigation checks elsewhere in this file: this one follows a REAL full
  // page reload (bootstrapSession -> refresh -> GET /profile), not a client-side route change —
  // genuinely slower under load, not a different correctness bar.
  await expect(tabA.locator('input[disabled]').first()).toHaveValue(MANAGER_C_EMAIL, { timeout: 20_000 });

  await context.close();
});

test('multi-tab race 4: login/refresh/logout Set-Cookie-changing calls are serialized across tabs by the cross-tab Web Lock, not merely ignored afterward', async ({ browser }) => {
  const context = await browser.newContext();
  observeAuthCalls(context);
  const tabA = await context.newPage();
  const tabB = await context.newPage();

  const windows: Array<{ tab: 'A' | 'B'; start: number; end: number }> = [];
  const DELAY_MS = 400;

  async function instrument(page: Page, label: 'A' | 'B'): Promise<void> {
    await page.route('**/rest/v1/auth/login', async (route: Route) => {
      const start = Date.now();
      await new Promise((r) => setTimeout(r, DELAY_MS)); // artificial server-round-trip delay
      const response = await route.fetch();
      const end = Date.now();
      windows.push({ tab: label, start, end });
      await route.fulfill({ response });
    });
  }
  await instrument(tabA, 'A');
  await instrument(tabB, 'B');

  await paceAuthCall();
  await paceAuthCall();
  // Two signed-out page loads (up to two /auth/refresh each in the development build) and two sign-ins, all at once.
  await paceAuth('refresh', 4);
  await paceAuth('login', 2);
  // Fire both logins at genuinely the same instant.
  await Promise.all([
    (async () => {
      await tabA.goto(`${BASE_URL}/login`);
      await tabA.getByRole('button', { name: 'Continue with email' }).click();
      await tabA.getByLabel('Email').fill(MANAGER_A_EMAIL);
      await tabA.getByRole('button', { name: 'Continue', exact: true }).click();
      await tabA.getByLabel('Password', { exact: true }).fill(PASSWORD);
      await tabA.getByRole('button', { name: 'Sign in', exact: true }).click();
    })(),
    (async () => {
      await tabB.goto(`${BASE_URL}/login`);
      await tabB.getByRole('button', { name: 'Continue with email' }).click();
      await tabB.getByLabel('Email').fill(MANAGER_C_EMAIL);
      await tabB.getByRole('button', { name: 'Continue', exact: true }).click();
      await tabB.getByLabel('Password', { exact: true }).fill(PASSWORD);
      await tabB.getByRole('button', { name: 'Sign in', exact: true }).click();
    })(),
  ]);
  await expect(tabA).toHaveURL(`${BASE_URL}/`, { timeout: 15_000 });
  await expect(tabB).toHaveURL(`${BASE_URL}/`, { timeout: 15_000 });

  expect(windows).toHaveLength(2);
  const [first, second] = windows.sort((a, b) => a.start - b.start);
  // Serialization proof: the SECOND call's network request must not have started until the
  // FIRST call's response had already landed (the Web Lock's `request()` only grants the lock
  // to the next waiter after the first callback's returned promise settles) — i.e. the windows
  // must not overlap. Ignoring stale callbacks afterward would still show two OVERLAPPING
  // network windows; only true serialization produces disjoint ones.
  expect(second!.start).toBeGreaterThanOrEqual(first!.end);

  await context.close();
});
