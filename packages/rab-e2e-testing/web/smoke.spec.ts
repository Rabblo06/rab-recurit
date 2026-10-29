import { expect, test } from '@playwright/test';

import { observeAuthCalls, paceSignedOutPageLoad, paceSignIn } from './support/live-pacing';

/**
 * Console regression smoke test — replaces the old M0-scaffold placeholder
 * (that page hasn't existed since early scaffolding). Logs in as the local
 * dev seed admin (`yarn seed` / `SeedCommand` — `admin@acme.test` by
 * default) and walks the core nav to prove the console still boots and
 * renders after backend/shared-package changes. Not a substitute for the
 * backend's own abuse-case integration tests — this only proves the UI
 * shell renders, not authorization behaviour.
 */
const SEED_EMAIL = process.env.E2E_SEED_EMAIL ?? 'admin@acme.test';
const SEED_PASSWORD = process.env.E2E_SEED_PASSWORD ?? 'ChangeMe123!';
// The sign-in screen opens on a provider choice ("Continue with email", 2026-10-13); the password field has a "Show password" toggle next to it, hence exact names.
// Since 48ff7b29 (2026-10-13) Settings is a sidebar navigation MODE (shell/NavigationModes.tsx: Home / AI / Settings buttons),
// no longer a link inside the sidebar's nav list.
const settingsMode = (page: import('@playwright/test').Page) => page.getByRole('group', { name: 'Navigation modes' }).getByRole('button', { name: 'Settings', exact: true });

// Three sign-ins in one file: pace them under the real 5-per-minute login/refresh limits (support/live-pacing.ts).
test.beforeEach(({ context }) => observeAuthCalls(context));

async function login(page: import('@playwright/test').Page) {
  await paceSignedOutPageLoad();
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with email' }).click();
  await page.getByLabel('Email').fill(SEED_EMAIL);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Password', { exact: true }).fill(SEED_PASSWORD);
  await paceSignIn();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL('/');
}

test('login redirects into the console and the sidebar renders', async ({ page }) => {
  await login(page);
  // The sidebar is grouped into several labelled `.sidebar-nav` sections (shell/Layout.tsx), and "Venue Offers" contains
  // "Offers": assert exactly one visible sidebar link per entry, by its exact accessible name.
  for (const label of ['Dashboard', 'Users', 'Shifts', 'Offers', 'Calendar', 'Payroll', 'Venues', 'Audit Log']) {
    await expect(page.locator('.sidebar-nav').getByRole('link', { name: label, exact: true })).toBeVisible();
  }
  await expect(settingsMode(page)).toBeVisible();
});

test('Users page loads the staff list without a console error', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await login(page);
  await page.getByRole('link', { name: 'Users', exact: true }).click();
  await expect(page).toHaveURL('/users');
  await expect(page.locator('.page-header-title')).toContainText('Users');

  expect(errors).toEqual([]);
});

test('Settings loads without a console error', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await login(page);
  await settingsMode(page).click();
  // /settings has no own page — its index route immediately redirects to
  // /settings/profile (App.tsx's <Navigate to="profile" replace/>).
  await expect(page).toHaveURL('/settings/profile');

  expect(errors).toEqual([]);
});
