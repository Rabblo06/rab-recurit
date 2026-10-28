import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * UI corrections against a REAL API + REAL PostgreSQL/Redis — the DISPOSABLE ones only (API from source on 127.0.0.1:3999
 * against crewflow-test-db / crewflow-test-redis; console on the isolated Vite :5174). A throwaway workspace seeded via
 * TestIdentityFactory: one owner Manager, two Venue Managers (one active, one invite-expired) and three Staff.
 * Required env: QA_UI (JSON written by the seed). Mutations (deactivate/activate/delete) touch only these records.
 */
const API = 'http://127.0.0.1:3999/rest/v1';
const ORIGIN = 'http://127.0.0.1:5174';
const OUT = path.resolve(__dirname, '.qa-shots/ui-corrections-2026-10-20/live');
// Loaded in beforeAll, not at module level: a module-level read of a missing file is a LOAD error, which aborts
// the whole Playwright run (every other spec included). Missing QA_UI now fails only this spec, immediately and by name.
type Seed = { manager: { email: string; password: string }; venueManagers: string[]; staff: string[] };
let seed: Seed;
test.beforeAll(() => {
  if (!process.env.QA_UI) throw new Error('QA_UI is not set: this spec needs the disposable API on 127.0.0.1:3999, the TestIdentityFactory seed and the isolated Vite on :5174 (see the header).');
  seed = JSON.parse(readFileSync(process.env.QA_UI, 'utf8')) as Seed;
});

test.use({ viewport: { width: 1440, height: 900 } });
test.setTimeout(6 * 60_000);

async function login(page: Page) {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with email' }).click();
  await page.getByLabel('Email').fill(seed.manager.email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Password', { exact: true }).fill(seed.manager.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}
const bar = (page: Page) => page.getByRole('toolbar', { name: 'Bulk actions for selected records' });

test('real backend: Venue managers total, selection, eligibility-gated deactivate/activate, email recipients, step-up delete', async ({ page }) => {
  await login(page);
  // Dashboard figure = the server's Venue Managers list total (2: one active, one invite-expired).
  await expect(page.locator('.dash-counts div', { hasText: 'Venue managers' }).locator('dd')).toHaveText('2', { timeout: 15_000 });
  const list = await page.request.get(`${API}/venue-managers`, { headers: { Origin: ORIGIN }, params: { limit: 1 } });
  expect((await list.json()).total).toBe(2);
  await page.screenshot({ path: path.join(OUT, '1-dashboard.png') });

  // Venue Managers: select all on the page.
  await page.getByRole('link', { name: 'Users', exact: true }).click();
  await page.getByRole('button', { name: /^Venue managers/ }).click();
  await page.getByRole('checkbox', { name: 'Select all venue managers on this page' }).check();
  await expect(bar(page)).toContainText('Selected: 2');
  await page.screenshot({ path: path.join(OUT, '2-venue-managers-selected.png') });

  // Deactivate: the invite-expired one is skipped with its reason; the server deactivates the active one.
  await bar(page).getByRole('button', { name: 'Deactivate' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Deactivate accounts' });
  await expect(dialog).toContainText('1 of 2 selected is eligible');
  await expect(dialog.getByRole('list', { name: 'Skipped records' })).toContainText('invitation not accepted yet');
  await page.screenshot({ path: path.join(OUT, '3-deactivate-preview.png') });
  await dialog.getByRole('button', { name: 'Deactivate 1' }).click();
  await expect(dialog).toContainText('1 of 1 deactivated', { timeout: 15_000 });
  await page.screenshot({ path: path.join(OUT, '4-deactivate-result.png') });
  await dialog.getByRole('button', { name: 'Done' }).click();
  const after = await (await page.request.get(`${API}/venue-managers`, { headers: { Origin: ORIGIN } })).json() as { data: Array<{ email: string; accountStatus: string }> };
  expect(after.data.find((m) => m.email === seed.venueManagers[0])?.accountStatus).not.toBe('active');
  expect(after.data.find((m) => m.email === seed.venueManagers[1])?.accountStatus).toBe('invite_expired');
  // The succeeded record left the selection; the skipped one stays selected.
  await expect(bar(page)).toContainText('Selected: 1');

  // Re-select the deactivated one and Activate it back (real reactivation, same lifecycle rules).
  await page.getByRole('checkbox', { name: 'Select all venue managers on this page' }).check();
  await bar(page).getByRole('button', { name: 'Activate', exact: true }).click();
  const act = page.getByRole('alertdialog', { name: 'Activate accounts' });
  await expect(act).toContainText('1 of 2 selected is eligible');
  await act.getByRole('button', { name: 'Activate 1' }).click();
  await expect(act).toContainText('1 of 1 activated', { timeout: 15_000 });
  await act.getByRole('button', { name: 'Done' }).click();
  const back = await (await page.request.get(`${API}/venue-managers`, { headers: { Origin: ORIGIN } })).json() as { data: Array<{ email: string; accountStatus: string }> };
  expect(back.data.find((m) => m.email === seed.venueManagers[0])?.accountStatus).toBe('active');

  // Send Email opens the existing composer with exactly these Venue Managers (not sent: no real mail in this run).
  await bar(page).getByRole('button', { name: 'Send Email' }).click();
  const composer = page.locator('.side-panel', { hasText: 'Send email' });
  await expect(composer).toBeVisible();
  await expect(composer).toContainText('1 recipient');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, '5-email-composer.png') });
  await page.keyboard.press('Escape');
  await expect(composer).toHaveCount(0);

  // Staff: delete one disposable staff member with step-up (current password) — server-confirmed, per-record result.
  await page.getByRole('button', { name: /^Staff/ }).click();
  await expect(bar(page)).toHaveCount(0); // switching roster cleared the selection
  const before = (await (await page.request.get(`${API}/staff`, { headers: { Origin: ORIGIN } })).json()).total as number;
  await page.locator('.table tbody input[type=checkbox]').first().check();
  await bar(page).getByRole('button', { name: 'Delete' }).click();
  const del = page.getByRole('alertdialog', { name: 'Delete accounts' });
  await del.getByLabel('Your current password').fill(seed.manager.password);
  await del.getByRole('button', { name: 'Delete 1' }).click();
  await expect(del).toContainText(/1 of 1 deleted|0 of 1 deleted/, { timeout: 15_000 });
  await page.screenshot({ path: path.join(OUT, '6-delete-result.png') });
  const result = await del.getByRole('status').textContent();
  const afterTotal = (await (await page.request.get(`${API}/staff`, { headers: { Origin: ORIGIN } })).json()).total as number;
  // Whatever the server decided is what the UI says: deleted → one fewer; refused (deletion safety gate) → unchanged.
  expect(afterTotal).toBe(result?.startsWith('1 of 1') ? before - 1 : before);
  await del.getByRole('button', { name: 'Done' }).click();
});
