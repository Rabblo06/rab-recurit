import { expect, test } from '@playwright/test';

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

async function login(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(SEED_EMAIL);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/');
}

test('login redirects into the console and the sidebar renders', async ({ page }) => {
  await login(page);
  for (const label of ['Dashboard', 'Users', 'Shifts', 'Offers', 'Calendar', 'Payroll', 'Venues', 'Audit Log', 'Settings']) {
    await expect(page.locator('.sidebar-nav', { hasText: label })).toBeVisible();
  }
});

test('Users page loads the staff list without a console error', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await login(page);
  await page.getByRole('link', { name: 'Users' }).click();
  await expect(page).toHaveURL('/users');
  await expect(page.locator('.page-header-title')).toContainText('Users');

  expect(errors).toEqual([]);
});

test('Settings loads without a console error', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await login(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  // /settings has no own page — its index route immediately redirects to
  // /settings/profile (App.tsx's <Navigate to="profile" replace/>).
  await expect(page).toHaveURL('/settings/profile');

  expect(errors).toEqual([]);
});
