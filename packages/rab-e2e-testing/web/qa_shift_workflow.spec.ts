import { expect, test } from '@playwright/test';

const BASE_URL = 'http://127.0.0.1:5173';

test.use({ viewport: { width: 1600, height: 1000 } });

test('visual QA: venue Note/Break/Pay, venue-manager select, shift approval workflow', async ({ page }) => {
  await test.step('login', async () => {
    await page.goto(`${BASE_URL}/login`);
    await page.getByLabel('Email').fill('admin@acme.test');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Password').fill('ChangeMe123!');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(`${BASE_URL}/`);
  });

  await test.step('Venue: Note/Break Settings/Pay Details', async () => {
    await page.getByRole('link', { name: 'Venues' }).click();
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
    await page.getByRole('link', { name: 'Users' }).click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Managers' }).click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: '+ New Manager' }).click();
    await page.getByRole('combobox').first().selectOption('venue');
    await expect(page.getByText('Select Venue')).toBeVisible();
    await page.waitForTimeout(400); // let the drawer's slide-in transition finish before capturing
    await page.screenshot({ path: 'web/.qa-shots/02-create-manager-venue.png', fullPage: true });
    await page.keyboard.press('Escape');
  });

  await test.step('Shifts page: Pending Approval badge + click opens Shift Approval', async () => {
    await page.getByRole('link', { name: 'Shifts' }).click();
    await expect(page.locator('.page-header-title')).toContainText('Shifts');
    await page.getByRole('button', { name: 'Filter' }).click();
    await page.getByLabel('Add filter').selectOption('status');
    await page.getByLabel('Status', { exact: true }).selectOption('pending_manager_approval');
    await page.waitForResponse((r) => r.url().includes('/rest/v1/shifts') && r.url().includes('status=pending_manager_approval'));
    await page.keyboard.press('Escape');
    await page.screenshot({ path: 'web/.qa-shots/03-shifts-pending.png', fullPage: true });

    const pendingRow = page.locator('tr', { hasText: 'Pending approval' }).first();
    await pendingRow.click();
    await expect(page.getByText('Shift Approval')).toBeVisible();
    await expect(page.getByRole('status', { name: 'Loading details' })).toHaveCount(0, { timeout: 15000 });
    await expect(page.getByText('Send offers to')).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(400); // let the drawer's slide-in transition finish before capturing
    await page.screenshot({ path: 'web/.qa-shots/04-shift-approval-drawer.png', fullPage: true });
  });
});
