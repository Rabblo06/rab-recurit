import { expect, test } from '@playwright/test';

// Live job: playwright.live.config.ts / live/run-live.sh (seeded console organisation). Origins and identity overridable for local runs.
const BASE_URL = process.env.E2E_WEB_ORIGIN ?? 'http://127.0.0.1:5173';
// The toolbar's Filter toggle ("Filter" / "Filter 2"), never the open popover's "Remove Status filter" buttons.
const FILTER_BUTTON = /^Filter(\s*\d+)?$/;
// Filter values are picked from the popover's <select> (role combobox): the Options popover's column checkboxes carry the
// same names ("Status", "Type", ...) and can still be in the DOM while it closes.
const SEED_EMAIL = process.env.E2E_SEED_EMAIL ?? 'admin@acme.test';
const SEED_PASSWORD = process.env.E2E_SEED_PASSWORD ?? 'ChangeMe123!';

test.use({ viewport: { width: 1600, height: 1000 } });

test('visual QA: venue Note/Break/Pay, venue-manager select, shift approval workflow', async ({ page }) => {
  await test.step('login', async () => {
    await page.goto(`${BASE_URL}/login`);
    await page.getByRole('button', { name: 'Continue with email' }).click();
    await page.getByLabel('Email').fill(SEED_EMAIL);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByLabel('Password', { exact: true }).fill(SEED_PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(`${BASE_URL}/`);
  });

  await test.step('Venue: Note/Break Settings/Pay Details', async () => {
    await page.getByRole('link', { name: 'Venues', exact: true }).click();
    await page.getByRole('button', { name: 'New venue' }).click();
    await expect(page.getByText('Note', { exact: true })).toBeVisible();
    await expect(page.getByText('Break Settings')).toBeVisible();
    await expect(page.getByText('Pay Details')).toBeVisible();
    await expect(page.getByText('Default break minutes')).toBeVisible();
    await page.waitForTimeout(400); // let the drawer's slide-in transition finish before capturing
    await page.screenshot({ path: 'web/.qa-shots/01-venue-drawer.png', fullPage: true });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  });

  await test.step('Create Manager: Venue Manager reveals Select Venue', async () => {
    await page.getByRole('link', { name: 'Users', exact: true }).click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Managers' }).click();
    await page.waitForTimeout(300);
    // "+ New Manager" became an icon + "New manager" (2b683f6e, 2026-10-20); the type select is labelled "Manager type".
    await page.getByRole('button', { name: 'New manager', exact: true }).click();
    await page.getByLabel('Manager type').selectOption('venue');
    await expect(page.getByText('Select Venue')).toBeVisible();
    await page.waitForTimeout(400); // let the drawer's slide-in transition finish before capturing
    await page.screenshot({ path: 'web/.qa-shots/02-create-manager-venue.png', fullPage: true });
    await page.keyboard.press('Escape');
  });

  await test.step('Shifts page: Pending Approval badge + click opens Shift Approval', async () => {
    await page.getByRole('link', { name: 'Shifts', exact: true }).click();
    await expect(page.locator('.page-header-title')).toContainText('Shifts');
    await page.getByRole('button', { name: FILTER_BUTTON }).click();
    await page.getByLabel('Add filter').selectOption('status');
    await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('pending_manager_approval');
    await page.waitForResponse((r) => r.url().includes('/rest/v1/shifts') && r.url().includes('status=pending_manager_approval'));
    await page.keyboard.press('Escape');
    await page.screenshot({ path: 'web/.qa-shots/03-shifts-pending.png', fullPage: true });

    const pendingRow = page.locator('tr', { hasText: 'Pending approval' }).first();
    await pendingRow.click();
    await expect(page.getByText('Shift Approval')).toBeVisible();
    await expect(page.getByRole('status', { name: 'Loading details' })).toHaveCount(0, { timeout: 15000 });
    // The footer action was "Approve & send offers to N" (N = selected requested staff) until 0a0ec8b6 (2026-10-01) renamed
    // it "Approve"; it is enabled only while 1..required requested staff are selected, which is what "to N" proved.
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled({ timeout: 15000 });
    await page.waitForTimeout(400); // let the drawer's slide-in transition finish before capturing
    await page.screenshot({ path: 'web/.qa-shots/04-shift-approval-drawer.png', fullPage: true });
  });
});
