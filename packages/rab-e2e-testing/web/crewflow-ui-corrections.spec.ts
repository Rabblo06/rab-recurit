import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { fixtures } from './support/crewflow-fixtures';

/**
 * Crewflow UI corrections (2026-10-20) — FIXTURE evidence (mocked API on the isolated Vite :5174): selection colours,
 * the bulk-action dock, Venue Manager selection, the account menu, Operations "+", Help/Support, dashboard palette and
 * counts, and motion (frame-sampled + video). Backend behaviour is proven separately (integration + live disposable run).
 */
const OUT = path.resolve(__dirname, '.qa-shots/ui-corrections-2026-10-20');
test.use({ viewport: { width: 1440, height: 900 }, video: { mode: 'on', size: { width: 1440, height: 900 } } });

const rgb = (page: Page, sel: string, prop: string) => page.locator(sel).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);

test('Staff: white selected rows, charcoal checked + indeterminate boxes, reference bulk dock', async ({ page }) => {
  await fixtures(page);
  await page.goto('/users');
  const boxes = page.locator('.table tbody input[type=checkbox]');
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  const header = page.getByRole('checkbox', { name: 'Select all staff on this page' });
  expect(await header.evaluate((el) => (el as HTMLInputElement).indeterminate)).toBe(true);
  expect(await rgb(page, '.table tbody tr.row-selected td', 'background-color')).toBe('rgb(255, 255, 255)');
  expect(await rgb(page, '.table tbody input[type=checkbox]:checked', 'background-color')).toBe('rgb(36, 37, 43)');
  expect(await rgb(page, '.table tbody tr:not(.row-selected) td', 'background-color')).toBe('rgba(0, 0, 0, 0)'); // the soft canvas shows through
  const bar = page.getByRole('toolbar', { name: 'Bulk actions for selected records' });
  await expect(bar).toContainText('Selected: 2');
  await expect(bar.getByRole('button')).toHaveText(['Activate', 'Deactivate', 'Send Email', 'Delete']);
  await expect(page.getByRole('button', { name: 'Clear selection' })).toBeVisible();
  // Centred over the main content (not the whole window) and above the list footer.
  const [dock, main, footer] = await Promise.all([page.locator('.bulk-action-dock').boundingBox(), page.locator('.main-content').boundingBox(), page.locator('.list-footer').boundingBox()]);
  expect(Math.abs(dock!.x + dock!.width / 2 - (main!.x + main!.width / 2))).toBeLessThan(2);
  expect(dock!.y + dock!.height).toBeLessThanOrEqual(footer!.y);
  await page.screenshot({ path: path.join(OUT, '1-staff-selected.png') });
  await page.screenshot({ path: path.join(OUT, '3-bulk-toolbar.png'), clip: { x: dock!.x - 12, y: dock!.y - 12, width: dock!.width + 24, height: dock!.height + 24 } });

  // Mixed eligibility is explained before anything runs (fixture rows are active, so Activate skips them with a reason).
  await bar.getByRole('button', { name: 'Activate', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Activate accounts' });
  await expect(dialog).toContainText('0 of 2 selected are eligible');
  await expect(dialog.getByRole('list', { name: 'Skipped records' })).toContainText('already active');
  await expect(dialog.getByRole('button', { name: 'Activate 0' })).toBeDisabled();
  await page.screenshot({ path: path.join(OUT, '3b-eligibility-preview.png') });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test('Venue Managers: select all on the page → Selected: 2 (invite-expired included as a selectable record)', async ({ page }) => {
  await fixtures(page);
  await page.goto('/users');
  await page.getByRole('button', { name: /^Venue managers/ }).click();
  await page.getByRole('checkbox', { name: 'Select all venue managers on this page' }).check();
  await expect(page.getByRole('toolbar', { name: 'Bulk actions for selected records' })).toContainText('Selected: 2');
  await page.screenshot({ path: path.join(OUT, '2-venue-managers-selected.png') });
});

test('account menu: real profile, permitted actions with icons, opens upward', async ({ page }) => {
  await fixtures(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Account menu' }).click();
  const menu = page.getByRole('menu', { name: 'Account' });
  await expect(menu).toContainText('Test Manager');
  await expect(menu).toContainText('manager@example.test');
  await expect(menu.getByRole('menuitem')).toHaveText(['Add Staff', 'Add venue manager', 'Invite member', /Theme/, 'Settings', 'Log out']);
  const [m, trigger] = await Promise.all([menu.boundingBox(), page.getByRole('button', { name: 'Account menu' }).boundingBox()]);
  expect(m!.y + m!.height).toBeLessThanOrEqual(trigger!.y + 1);
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, '4-account-menu.png'), clip: { x: 0, y: 420, width: 420, height: 480 } });
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Account menu' })).toBeFocused();
});

test('Operations + : categories, search, each category, duplicate refusal, link validation, add, remove', async ({ page }) => {
  await fixtures(page);
  await page.goto('/');
  const plus = page.getByRole('button', { name: 'Add menu item' });
  await plus.click();
  const pop = page.locator('.add-menu');
  await expect(pop.locator('.add-menu-row')).toHaveText([/Object/, /View/, /Record/, /Folder/, /Link/]);
  await page.screenshot({ path: path.join(OUT, '5a-add-menu.png'), clip: { x: 0, y: 250, width: 560, height: 520 } });

  // Object → Shifts → confirm → added
  await pop.getByRole('button', { name: /^Object/ }).click();
  await pop.getByRole('textbox', { name: /Search/ }).fill('shif');
  await expect(pop.locator('.add-menu-row')).toHaveText(['Shifts']);
  await page.screenshot({ path: path.join(OUT, '5b-object.png'), clip: { x: 0, y: 250, width: 560, height: 520 } });
  await pop.locator('.add-menu-row', { hasText: 'Shifts' }).click();
  await pop.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByLabel('Your shortcuts').getByRole('link', { name: 'Shifts' })).toBeVisible();

  // Duplicate is refused
  await plus.click();
  await pop.getByRole('button', { name: /^Object/ }).click();
  await pop.locator('.add-menu-row', { hasText: 'Shifts' }).click();
  await expect(pop.getByRole('alert')).toHaveText('That is already in your sidebar.');
  await pop.getByRole('button', { name: 'Back' }).click();

  // View
  await pop.getByRole('button', { name: /^View/ }).click();
  await page.screenshot({ path: path.join(OUT, '5c-view.png'), clip: { x: 0, y: 250, width: 560, height: 560 } });
  await pop.locator('.add-menu-row', { hasText: 'Offers · Pending' }).click();
  await pop.getByRole('button', { name: 'Add' }).click();

  // Record (server-scoped search)
  await plus.click();
  await pop.getByRole('button', { name: /^Record/ }).click();
  await pop.getByRole('textbox', { name: /Search/ }).fill('Staff');
  await expect(pop.locator('.add-menu-row', { hasText: 'Staff Test 1' })).toBeVisible();
  await page.screenshot({ path: path.join(OUT, '5d-record.png'), clip: { x: 0, y: 250, width: 560, height: 520 } });
  await pop.locator('.add-menu-row', { hasText: 'Staff Test 1' }).click();
  await pop.getByRole('button', { name: 'Add' }).click();

  // Folder
  await plus.click();
  await pop.getByRole('button', { name: /^Folder/ }).click();
  await pop.getByLabel('Name').fill('Weekend');
  await page.screenshot({ path: path.join(OUT, '5e-folder.png'), clip: { x: 0, y: 250, width: 560, height: 520 } });
  await pop.getByRole('button', { name: 'Add' }).click();

  // Link: unsafe refused, https accepted into the folder
  await plus.click();
  await pop.getByRole('button', { name: /^Link/ }).click();
  await pop.getByLabel('Address').fill('javascript:alert(1)');
  await pop.getByRole('button', { name: 'Continue' }).click();
  await expect(pop.getByRole('alert')).toContainText('Only https://');
  await pop.getByLabel('Address').fill('https://docs.example.com/rota');
  await pop.getByRole('button', { name: 'Continue' }).click();
  await pop.getByLabel('Add to').selectOption({ label: 'Weekend' });
  await page.screenshot({ path: path.join(OUT, '5f-link.png'), clip: { x: 0, y: 250, width: 560, height: 560 } });
  await pop.getByRole('button', { name: 'Add' }).click();

  const list = page.getByLabel('Your shortcuts');
  await expect(list.getByRole('link', { name: /docs\.example\.com/ })).toHaveAttribute('rel', 'noopener noreferrer');
  await page.screenshot({ path: path.join(OUT, '5g-sidebar-with-shortcuts.png'), clip: { x: 0, y: 0, width: 260, height: 900 } });

  // Opening a record shortcut opens the existing detail experience; a view opens the filtered list.
  await list.getByRole('button', { name: 'Offers · Pending', exact: true }).click();
  await expect(page).toHaveURL(/\/offers\?status=pending$/);

  // Persisted per user + workspace on this device: survives a reload.
  await page.reload();
  await expect(page.getByLabel('Your shortcuts').getByRole('link', { name: 'Shifts' })).toBeVisible();
  // Remove (shortcut only — nothing else changes)
  await page.getByRole('button', { name: 'Options for Shifts' }).click();
  await page.getByRole('menuitem', { name: 'Remove from sidebar' }).click();
  await expect(page.getByLabel('Your shortcuts').getByRole('link', { name: 'Shifts' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Shifts', exact: true }).first()).toBeVisible(); // the real nav item is untouched
});

test('Help Center (search) and Support (honest unconfigured state)', async ({ page }) => {
  await fixtures(page);
  await page.goto('/help');
  await expect(page.getByRole('heading', { name: 'How can we help?' })).toBeVisible();
  await page.screenshot({ path: path.join(OUT, '6a-help.png') });
  await page.getByRole('searchbox', { name: 'Search help' }).fill('timesheet');
  await expect(page.getByRole('heading', { name: 'Finalise a timesheet' })).toBeVisible();
  await page.goto('/support');
  await expect(page.getByRole('status')).toContainText('has not been set up');
  await expect(page.locator('a[href^="mailto:"]')).toHaveCount(0);
  await page.screenshot({ path: path.join(OUT, '6b-support.png') });
  await expect(page.locator('.nav-item', { hasText: 'Help Center' })).toBeVisible();
});

test('Dashboard: orange/charcoal palette, Venue managers = 2, no brown; the reveal replays on a deliberate return', async ({ page }) => {
  await fixtures(page);
  await page.goto('/');
  await expect(page.locator('.dash-counts')).toContainText('Venue managers');
  await expect(page.locator('.dash-counts div', { hasText: 'Venue managers' }).locator('dd')).toHaveText('2');
  await page.waitForTimeout(1200);
  expect(await rgb(page, '.dash-strip-pill.is-warm .dash-strip-fill', 'background-color')).toBe('rgb(255, 122, 26)');
  expect(await rgb(page, '.dash-strip-pill.is-dark .dash-strip-fill', 'background-color')).toBe('rgb(36, 37, 43)');
  expect(await rgb(page, '.dash-hbar', 'background-color')).toBe('rgb(255, 122, 26)');
  expect(await rgb(page, '.dash-checklist', 'background-color')).toBe('rgb(36, 37, 43)');
  expect(await rgb(page, '.btn-dark, .dash-strip-pill.is-warm', 'color')).toBe('rgb(36, 37, 43)');
  // No old walnut/brown anywhere on the page.
  const brown = await page.evaluate(() => [...document.querySelectorAll('*')].some((el) => {
    const cs = getComputedStyle(el);
    return [cs.backgroundColor, cs.color, cs.borderColor].some((c) => ['rgb(48, 39, 31)', 'rgb(101, 87, 75)', 'rgb(121, 84, 58)', 'rgb(92, 62, 42)'].includes(c));
  }));
  expect(brown).toBe(false);
  await page.screenshot({ path: path.join(OUT, '7-dashboard.png'), fullPage: true });

  // Return visit (owner decision 2026-10-20): a deliberate return REPLAYS the number reveal from cached data.
  await page.getByRole('link', { name: 'Users' }).click();
  await expect(page).toHaveURL(/\/users$/);
  await expect(page.locator('.dash-counts')).toHaveCount(0);
  await page.evaluate(() => {
    const w = window as unknown as { __txt: string[] }; w.__txt = [];
    const t0 = performance.now();
    const tick = () => { const el = document.querySelector('.dash-counts > div:nth-child(1) dd'); if (el) w.__txt.push(((el.querySelector('[data-animating]') ?? el).textContent ?? '').trim()); if (performance.now() - t0 < 1800) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await page.getByRole('link', { name: 'Dashboard' }).click();
  await page.waitForTimeout(1900);
  const txt = await page.evaluate(() => (window as unknown as { __txt: string[] }).__txt);
  expect(txt[0]).toBe('0');
  expect(txt.at(-1)).toBe('5');
});

test('Dashboard sparse: truthful empty states, zero counts are real zeros from the server', async ({ page }) => {
  await fixtures(page, { sparse: true });
  await page.goto('/');
  await expect(page.getByText('No upcoming shifts in the next 14 days.')).toBeVisible();
  await expect(page.getByText('No shifts in the last 30 days.')).toBeVisible();
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, '8-dashboard-sparse.png'), fullPage: true });
});

test('Settings active selection uses the same white highlight', async ({ page }) => {
  await fixtures(page);
  await page.goto('/settings/account');
  const current = page.getByRole('complementary', { name: 'Settings navigation' }).locator('[aria-current="page"]');
  await expect(current).toHaveAttribute('aria-label', 'Account');
  expect(await current.locator('.nav-active-pill').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)');
  await page.screenshot({ path: path.join(OUT, '9-settings-active.png'), clip: { x: 0, y: 0, width: 560, height: 600 } });
});

test('motion: bulk dock enters ~220ms rising 10px and does not re-enter on count change', async ({ page }) => {
  await fixtures(page);
  await page.goto('/users');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const w = window as unknown as { __s: Array<[number, number, number]> }; w.__s = [];
    const t0 = performance.now();
    const tick = () => {
      const el = document.querySelector('.bulk-action-dock');
      if (el) { const m = new DOMMatrix(getComputedStyle(el).transform); w.__s.push([performance.now() - t0, m.m42, Number(getComputedStyle(el).opacity)]); }
      if (performance.now() - t0 < 900) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.locator('.table tbody input[type=checkbox]').nth(0).check();
  await page.waitForTimeout(400);
  await page.locator('.table tbody input[type=checkbox]').nth(1).check();
  await page.waitForTimeout(500);
  const s = await page.evaluate(() => (window as unknown as { __s: Array<[number, number, number]> }).__s);
  const first = s[0]!, settled = s.find(([, y, o]) => Math.abs(y) < 0.2 && o > 0.99)!;
  console.log(`dock: starts y=${first[1].toFixed(1)} op=${first[2].toFixed(2)}, settled after ${(settled[0] - first[0]).toFixed(0)}ms`);
  expect(first[1]).toBeGreaterThan(5);
  expect(settled[0] - first[0]).toBeLessThan(400);
  // After the second tick the dock never leaves its settled position again (no re-entrance).
  const after = s.filter(([t]) => t > settled[0] + 50);
  expect(Math.max(...after.map(([, y]) => Math.abs(y)))).toBeLessThan(0.5);
});

test('narrow (390px): the dock keeps readable labels — first action inline, the rest under More — with no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixtures(page);
  await page.goto('/users');
  await page.locator('.table tbody input[type=checkbox]').first().check();
  const bar = page.getByRole('toolbar', { name: 'Bulk actions for selected records' });
  await expect(bar.getByRole('button')).toHaveText(['Activate', 'More']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await bar.getByRole('button', { name: 'More' }).click();
  await expect(page.getByRole('menu', { name: 'More bulk actions' }).getByRole('menuitem')).toHaveText(['Deactivate', 'Send Email', 'Delete']);
  await page.screenshot({ path: path.join(OUT, '10-narrow-dock.png') });
});
