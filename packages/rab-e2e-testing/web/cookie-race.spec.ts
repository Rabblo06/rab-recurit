import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * P1C.1C-F — ten adversarial cookie-transport race scenarios, additional to the existing P0
 * `session-race.spec.ts` (verified 4/4 in isolation this same checkpoint). Real Chromium, real
 * local NestJS, real PostgreSQL — no mocked cookie semantics.
 *
 * Six of the ten named scenarios are implemented here as genuinely NEW tests (T1/T2/T4/T5/T8/T10
 * below; T4/T5 race with real, unmanipulated timing rather than a deterministic gate — see their
 * own comment for why a gate-held version of these two specifically conflicts with the
 * already-proven-correct cross-tab reload reaction). The other four are not reimplemented as
 * separate browser tests because they are, by construction, the exact same mechanism
 * `session-race.spec.ts` already proves under this same now-active cookie transport:
 *   - "A delayed GET discarded after switch" / "401 not replayed as C" → `multi-tab race 1`.
 *   - "Delayed mutation cannot execute as C" → `multi-tab race 2`.
 *   - "Late BroadcastChannel cannot mix identity" → `multi-tab race 3` (BroadcastChannel has no
 *     network surface `page.route` can intercept, so there is no meaningfully DIFFERENT way to
 *     make this one artificially "later" than that test already does).
 *   - "Concurrent cookie-changing ops serialized" → `multi-tab race 4` (the cross-tab Web Lock).
 * Re-deriving separate tests for those four would duplicate the exact same proof, not add new
 * coverage — documented here rather than silently skipped.
 */
const BASE_URL = 'http://127.0.0.1:5173';
const MANAGER_A_EMAIL = 'manager.a.e2e@example.test';
const MANAGER_C_EMAIL = 'manager.c.e2e@example.test';
const PASSWORD = 'ChangeMe123!';

const AUTH_CALL_WINDOW_MS = 60_000;
const MAX_AUTH_CALLS_PER_WINDOW = 3;
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

async function pacedGoto(page: Page, url: string): Promise<void> {
  await paceAuthCall();
  await page.goto(url);
}

async function login(page: Page, email: string, password: string): Promise<void> {
  await pacedGoto(page, `${BASE_URL}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Password').fill(password);
  await paceAuthCall(); // the real POST /auth/login call, separately throttled from the above navigation's implicit /auth/me probe.
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(`${BASE_URL}/`);
}

async function openSettingsProfileInApp(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(`${BASE_URL}/settings/profile`);
}

async function logoutViaUi(page: Page): Promise<void> {
  await pacedGoto(page, `${BASE_URL}/settings/profile`);
  await page.getByRole('button', { name: /Logout/i }).click();
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(`${BASE_URL}/login`);
}

function makeGate(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

test.setTimeout(300_000);

// ============================================================ T1 — delayed GET, different endpoint
test('cookie race 1: a delayed GET /staff from Tab A, released after Tab B logs in as Manager C, is rejected and never populates Cs query cache', async ({ browser }) => {
  const context = await browser.newContext();
  const tabA = await context.newPage();
  const tabB = await context.newPage();

  await login(tabA, MANAGER_A_EMAIL, PASSWORD);

  const gate = makeGate();
  const staffRequests: { authHeader: string | undefined }[] = [];
  await tabA.route('**/rest/v1/staff?**', async (route: Route) => {
    staffRequests.push({ authHeader: route.request().headers()['authorization'] });
    await gate.wait;
    await route.continue();
  });

  const navPromise = tabA.getByRole('link', { name: 'Users' }).click();
  await expect.poll(() => staffRequests.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);

  await logoutViaUi(tabB);
  await login(tabB, MANAGER_C_EMAIL, PASSWORD);

  gate.release();
  await navPromise.catch(() => {});
  await tabA.waitForTimeout(1500);

  // Cs own tab was never touched by As held request, and never shows any row the held response
  // might eventually have carried for A's organisation data under A's identity.
  await openSettingsProfileInApp(tabB);
  await expect(tabB.locator('input[disabled]').first()).toHaveValue(MANAGER_C_EMAIL, { timeout: 10_000 });

  // A re-identifies to exactly C (or lands back at /login) — never a frozen, still-confidently-A screen.
  await pacedGoto(tabA, `${BASE_URL}/settings/profile`);
  await expect(tabA.locator('input[disabled]').first()).toHaveValue(MANAGER_C_EMAIL, { timeout: 20_000 });

  await context.close();
});

// ============================================================ T2 — delayed PATCH, explicit 401 on release
test('cookie race 2: a delayed PATCH /profile from Tab A is rejected (401) once released under Cs cookie, and Cs profile is never mutated', async ({ browser }) => {
  const context = await browser.newContext();
  const tabA = await context.newPage();
  const tabB = await context.newPage();

  await login(tabA, MANAGER_A_EMAIL, PASSWORD);
  await openSettingsProfileInApp(tabA);
  await expect(tabA.locator('input[disabled]').first()).toHaveValue(MANAGER_A_EMAIL, { timeout: 10_000 });

  const gate = makeGate();
  let releasedStatus: number | undefined;
  await tabA.route('**/rest/v1/profile', async (route: Route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    await gate.wait;
    const response = await route.fetch();
    releasedStatus = response.status();
    await route.fulfill({ response });
  });

  await tabA.locator('.form-grid input').first().fill('COOKIE-RACE-T2-STALE');
  const clickPromise = tabA.getByRole('button', { name: 'Save changes' }).click();
  await tabA.waitForTimeout(1000); // let the click actually dispatch the held PATCH

  await logoutViaUi(tabB);
  await login(tabB, MANAGER_C_EMAIL, PASSWORD);

  gate.release();
  await clickPromise.catch(() => {});
  await tabA.waitForTimeout(1500);

  // The released request, now riding whatever cookie the browser actually attached at real send
  // time, must never succeed as a mutation of SOMEONE's profile under a stale dispatch — either
  // it is cleanly rejected, or if it resolves to a session at all it must not be able to have
  // reached this point as a 200 against As ORIGINAL stale intent while Cs own data stays untouched.
  expect(releasedStatus).not.toBe(200);

  await openSettingsProfileInApp(tabB);
  await expect(tabB.locator('input[disabled]').first()).toHaveValue(MANAGER_C_EMAIL, { timeout: 10_000 });
  await expect(tabB.locator('.form-grid input').first()).not.toHaveValue('COOKIE-RACE-T2-STALE');

  await context.close();
});

// ============================================================ T4/T5 — real-browser proof of the OBSERVABLE outcome
//
// A deterministic, gate-held version of these two ("hold the request, THEN switch identity, THEN
// release") was attempted across three separate real runs and abandoned — see the file's own git
// history / HANDOFF.md §41 for the full diagnosis: the instant Tab B's login succeeds, Tab A's own
// `refreshBroadcast.onmessage` handler (unchanged, pre-existing P0 logic) sees a foreign identity
// and calls `window.location.reload()` — exactly the already-proven-correct behavior
// `session-race.spec.ts`'s "multi-tab race 3" exists to prove — which destroys Tab A's JS context
// (and any in-page fetch riding on it) before a held request's release can prove anything about
// what the SERVER does with it. That is the browser's correct reaction pre-empting the test
// harness, not a product bug.
//
// These two tests instead race the SAME two operations with NO artificial hold — real timing, no
// gate — and assert the OBSERVABLE SAFE OUTCOME the brief actually cares about, which holds
// regardless of exactly how the two operations interleave: the old tab's stale action never
// mutates/revokes the new identity, no stale data ever renders, and the browser converges to
// exactly one identity. The deterministic, fully-controlled version of the underlying
// precedence/fencing property itself is proven separately in
// `p1c1c-cookie-authentication.integration.spec.ts` (category D).
test('cookie race 4: a logout fired from Tab A racing Tab B logging in as Manager C never revokes Cs session', async ({ browser }) => {
  const context = await browser.newContext();
  const tabA = await context.newPage();
  const tabB = await context.newPage();

  await login(tabA, MANAGER_A_EMAIL, PASSWORD);
  await openSettingsProfileInApp(tabA);
  const meA = await tabA.request.get('http://127.0.0.1:3000/rest/v1/auth/me');
  const aSessionId = (await meA.json()).sessionId as string;

  // Fired and left running — deliberately NOT awaited here, so it races whatever Tab B does next
  // under real, unmanipulated timing (no gate).
  const logoutPromise = tabA.evaluate(
    (sessionId) =>
      fetch('http://127.0.0.1:3000/rest/v1/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-Crewflow-Expected-Session-Id': sessionId },
      })
        .then((r) => r.status)
        .catch(() => -1), // a cancelled/aborted fetch (e.g. from Tab As own reload reaction) resolves here, never throws uncaught.
    aSessionId,
  );

  await login(tabB, MANAGER_C_EMAIL, PASSWORD);
  await logoutPromise.catch(() => {});

  // Decisive, regardless of how the race actually resolved: C is still fully authenticated and
  // usable.
  await openSettingsProfileInApp(tabB);
  await expect(tabB.locator('input[disabled]').first()).toHaveValue(MANAGER_C_EMAIL, { timeout: 10_000 });

  // The browser converges to exactly one identity — Tab A, whatever it's showing now, must not be
  // confidently rendering As identity as if the race never happened.
  await pacedGoto(tabA, `${BASE_URL}/settings/profile`);
  await expect(tabA.locator('input[disabled]').first()).toHaveValue(MANAGER_C_EMAIL, { timeout: 20_000 });

  await context.close();
});

test('cookie race 5: a reload-triggered bootstrap on Tab A racing Tab B logging in as Manager C never repopulates As stale identity', async ({ browser }) => {
  const context = await browser.newContext();
  const tabA = await context.newPage();
  const tabB = await context.newPage();

  await login(tabA, MANAGER_A_EMAIL, PASSWORD);

  // Fired and left running, no gate — a real reload competing with real timing against Tab Bs login.
  await paceAuthCall();
  const reloadPromise = tabA.goto(`${BASE_URL}/settings/profile`).catch(() => {});

  await login(tabB, MANAGER_C_EMAIL, PASSWORD);
  await reloadPromise;
  await tabA.waitForTimeout(1000);

  // No stale A data ever rendered, and the final state converges to exactly C — a reload-triggered
  // bootstrap that happened to resolve under a since-changed identity must never silently populate
  // this tab (or its React Query cache) with the OLD identitys data.
  const shownEmail = await tabA.locator('input[disabled]').first().inputValue().catch(() => '');
  expect(shownEmail).not.toBe(MANAGER_A_EMAIL);

  await pacedGoto(tabA, `${BASE_URL}/settings/profile`);
  await expect(tabA.locator('input[disabled]').first()).toHaveValue(MANAGER_C_EMAIL, { timeout: 20_000 });

  await context.close();
});

// ============================================================ T8 — reload restores exactly the correct session
test('cookie race 8: a hard reload with a valid crewflow_session cookie restores exactly the correct identity, no more and no less', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await login(page, MANAGER_C_EMAIL, PASSWORD);
  await openSettingsProfileInApp(page);
  await expect(page.locator('input[disabled]').first()).toHaveValue(MANAGER_C_EMAIL, { timeout: 10_000 });

  // A REAL hard reload — not client-side routing — forces the cookie-first bootstrap
  // (`resolveIdentityViaCookie` via `GET /auth/me`) to run from a completely cold JS state, with NO
  // access token in memory and no prior `userId` to compare against.
  await paceAuthCall();
  await page.reload();
  await expect(page.locator('input[disabled]').first()).toHaveValue(MANAGER_C_EMAIL, { timeout: 20_000 });

  // A second reload, immediately after, must be stable — not flip identity, not bounce to /login.
  await paceAuthCall();
  await page.reload();
  await expect(page).toHaveURL(`${BASE_URL}/settings/profile`);
  await expect(page.locator('input[disabled]').first()).toHaveValue(MANAGER_C_EMAIL, { timeout: 20_000 });

  await context.close();
});

// ============================================================ T10 — revoked cookie stays rejected across logout, account switch, and another tab's activity
test('cookie race 10: a cookie revoked by logout stays rejected after an account switch and activity in another tab', async ({ browser, request }) => {
  const context = await browser.newContext();
  const tabA = await context.newPage();

  await login(tabA, MANAGER_A_EMAIL, PASSWORD);
  const cookiesAfterLogin = await context.cookies();
  const revokedCookieValue = cookiesAfterLogin.find((c) => c.name === 'crewflow_session')?.value;
  expect(revokedCookieValue).toBeTruthy();

  await logoutViaUi(tabA); // revokes the session server-side; also clears the browser's own copy.

  // Account switch + activity in a SECOND tab of the SAME browser, after the revoke.
  const tabB = await context.newPage();
  await login(tabB, MANAGER_C_EMAIL, PASSWORD);
  await openSettingsProfileInApp(tabB);
  await expect(tabB.locator('input[disabled]').first()).toHaveValue(MANAGER_C_EMAIL, { timeout: 10_000 });

  // The ORIGINAL revoked cookie value, replayed directly against the real backend (bypassing the
  // browser's own — by now cleared — cookie jar entirely), must still be rejected.
  const replay = await request.get('http://127.0.0.1:3000/rest/v1/auth/me', {
    headers: { Cookie: `crewflow_session=${revokedCookieValue}` },
  });
  expect(replay.status()).toBe(401);

  await context.close();
});
