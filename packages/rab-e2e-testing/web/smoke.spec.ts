import { expect, test } from '@playwright/test';

/**
 * Proves the E2E toolchain boots the console against a real dev server.
 * The two headline journeys (manager schedule→payroll, staff offer→payslip)
 * land as the modules they exercise are built (M3–M5).
 */
test('console loads and renders the M0 scaffold', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('rab')).toBeVisible();
  await expect(page.getByText(/M0 scaffold/)).toBeVisible();
});
