import { test, expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Settings → Profile → Devices against a REAL API and REAL PostgreSQL/Redis — but only the disposable ones: the API runs from
 * source on 127.0.0.1:3999 against crewflow-test-db (127.0.0.1:15436, `crewflow.disposable_test_database=true`) and
 * crewflow-test-redis; the console is the isolated Vite on :5174. Never the dev stack, never a real account.
 *
 * Required env: QA_IDENTITIES (JSON file with two disposable QA managers). Optional SHOT_TAG=before|after.
 * Auth endpoints are limited to 5/min each, so every login and every full page load (which refreshes) is paced.
 */
const API = 'http://127.0.0.1:3999/rest/v1';
const ORIGIN = 'http://127.0.0.1:5174';
const OUT = path.resolve(__dirname, '.qa-shots/devices-2026-10-19');
const TAG = process.env.SHOT_TAG ?? 'after';
const ids = JSON.parse(readFileSync(process.env.QA_IDENTITIES ?? '', 'utf8')) as Record<'a' | 'b', { email: string; password: string }>;

test.use({ viewport: { width: 1440, height: 900 } });
test.setTimeout(8 * 60_000);

const stamps: Record<string, number[]> = { login: [], refresh: [] };
async function pace(kind: 'login' | 'refresh') {
  const now = () => Date.now();
  stamps[kind] = stamps[kind]!.filter((t) => now() - t < 61_000);
  if (stamps[kind]!.length >= 4) await new Promise((r) => setTimeout(r, 61_500 - (now() - stamps[kind]![0]!)));
  stamps[kind]!.push(now());
}

/** Usable sessions for a QA user, straight from the disposable DB with the server's own rule (read-only). */
function dbUsableCount(email: string): number {
  const sql = `BEGIN READ ONLY; SELECT count(*) FROM core.user_session us JOIN core."user" u ON u.id = us.user_id WHERE u.email = '${email.replace(/'/g, "''")}'
    AND us.revoked_at IS NULL AND us.absolute_expires_at > now() AND (us.idle_expires_at IS NULL OR us.idle_expires_at > now())
    AND EXISTS (SELECT 1 FROM core.refresh_token rt WHERE rt.family_id = us.id AND rt.user_id = us.user_id AND rt.organisation_id = us.organisation_id
                AND rt.revoked_at IS NULL AND rt.family_expires_at > now()); ROLLBACK;`;
  const out = execFileSync('docker', ['exec', 'crewflow-test-db', 'psql', '-U', 'rab', '-d', 'rab', '-XAt', '-c', sql], { encoding: 'utf8' });
  return Number(out.split('\n').map((l) => l.trim()).find((l) => /^\d+$/.test(l)));
}

async function apiLogin(req: APIRequestContext, who: 'a' | 'b') {
  await pace('login');
  const res = await req.post(`${API}/auth/login`, { headers: { Origin: ORIGIN }, data: { email: ids[who].email, password: ids[who].password, applicationTarget: 'manager_web' } });
  expect(res.status()).toBe(200);
}
const me = async (ctx: BrowserContext) => (await ctx.request.get(`${API}/auth/me`, { headers: { Origin: ORIGIN } })).status();

async function uiLogin(page: Page, who: 'a' | 'b') {
  await pace('refresh');
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with email' }).click();
  await page.getByLabel('Email').fill(ids[who].email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Password', { exact: true }).fill(ids[who].password);
  await pace('login');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}
async function openDevices(page: Page) {
  await pace('refresh');
  await page.goto('/settings/profile');
  await expect(page.getByRole('heading', { name: 'Devices' })).toBeVisible();
  await expect(page.locator('.devices-list')).toBeVisible();
}
const rows = (page: Page) => page.getByRole('list', { name: 'Active sessions' }).getByRole('listitem');

test('real API: list = authoritative usable sessions; reload, per-session logout, log out others, normal logout', async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const c = await browser.newContext();
  const page = await a.newPage();
  try {
    await uiLogin(page, 'a');
    // Clean slate for this disposable QA account: end anything an earlier (failed) run left behind.
    expect((await a.request.delete(`${API}/profile/sessions`, { headers: { Origin: ORIGIN } })).status()).toBe(200);
    expect(dbUsableCount(ids.a.email)).toBe(1);
    await apiLogin(b.request, 'a'); // a second device for the same account
    await openDevices(page);
    await expect(rows(page)).toHaveCount(2);
    expect(dbUsableCount(ids.a.email)).toBe(2);
    await expect(page.getByText('This device')).toHaveCount(1);
    await page.locator('.devices-card').screenshot({ path: path.join(OUT, TAG, '1-two-devices.png') });
    if (TAG === 'before') {
      await page.locator('.password-access-card').screenshot({ path: path.join(OUT, TAG, '0-password-access.png') });
      return;
    }

    // Password & access no longer offers "Sign out everywhere"; nothing on the page does.
    await expect(page.getByText(/sign out everywhere|log out everywhere/i)).toHaveCount(0);
    await page.locator('.password-access-card').screenshot({ path: path.join(OUT, TAG, '0-password-access.png') });
    // (Current Playwright Chromium runs "new headless", whose User-Agent is ordinary Chrome — so these rows truthfully read
    // "Chrome on Windows". Old-headless "HeadlessChrome" and script User-Agents are labelled as automation: device-label.spec.ts.)

    // Reload twice: no new sessions.
    await pace('refresh'); await page.reload();
    await pace('refresh'); await page.reload();
    await expect(rows(page)).toHaveCount(2);
    expect(dbUsableCount(ids.a.email)).toBe(2);

    // Same-browser re-login supersedes only this browser's previous session.
    await apiLogin(a.request, 'a');
    await openDevices(page);
    await expect(rows(page)).toHaveCount(2);
    expect(dbUsableCount(ids.a.email)).toBe(2);
    expect(await me(b)).toBe(200);

    // Individual logout of the other device.
    await page.getByRole('button', { name: /^More options for / }).click();
    await page.getByRole('menuitem', { name: 'Log out' }).click();
    await expect(rows(page)).toHaveCount(1);
    expect(await me(b)).toBe(401);
    await expect(page.getByRole('button', { name: 'Log out all other devices' })).toHaveCount(0);
    expect(dbUsableCount(ids.a.email)).toBe(1);

    // Log out all other devices keeps this one.
    await apiLogin(b.request, 'a');
    await apiLogin(c.request, 'a');
    await openDevices(page);
    await expect(rows(page)).toHaveCount(3);
    await page.locator('.devices-card').screenshot({ path: path.join(OUT, TAG, '2-three-devices.png') });
    await page.getByRole('button', { name: 'Log out all other devices' }).click();
    await page.getByRole('button', { name: 'Log out other devices' }).click();
    await expect(rows(page)).toHaveCount(1);
    expect(await me(a)).toBe(200);
    expect(await me(b)).toBe(401);
    expect(await me(c)).toBe(401);
    expect(dbUsableCount(ids.a.email)).toBe(1);
    await page.locator('.devices-card').screenshot({ path: path.join(OUT, TAG, '3-after-log-out-others.png') });

    // The other account never appears in this list (account isolation in the browser).
    await apiLogin(b.request, 'b');
    await openDevices(page);
    await expect(rows(page)).toHaveCount(1);

    // Normal logout from the Settings navigation still works.
    await page.getByRole('complementary', { name: 'Settings navigation' }).getByRole('button', { name: 'Log out' }).click();
    await page.getByRole('alertdialog', { name: 'Log out?' }).getByRole('button', { name: 'Log out', exact: true }).click();
    await page.waitForURL(/\/login/);
    expect(await me(a)).toBe(401);
    expect(dbUsableCount(ids.a.email)).toBe(0);
    await page.screenshot({ path: path.join(OUT, TAG, '4-logged-out.png') });
  } finally {
    // Leave nothing behind in the disposable DB for the next run: end every QA session that is still live.
    for (const ctx of [a, b, c]) await ctx.request.post(`${API}/auth/logout`, { headers: { Origin: ORIGIN } }).catch(() => undefined);
    await Promise.all([a.close(), b.close(), c.close()]);
  }
});
