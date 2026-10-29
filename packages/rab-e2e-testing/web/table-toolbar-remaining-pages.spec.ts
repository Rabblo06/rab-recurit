import { expect, test } from '@playwright/test';

import { listTotal, nextListResponse } from './support/live-list';

/**
 * Global Filter/Sort/Options system — Shifts, Offers, Venues, Payroll,
 * Audit Log. One continuous test, `test.step()`-organized per page, sharing
 * a single page/login for its whole duration — same reasoning as
 * `table-toolbar-users.spec.ts`'s own doc comment: AUTH_THROTTLE's 5/60s
 * limit, and more subtly, this app's refresh-token-rotation-on-use design
 * means even a *shared* login snapshot breaks across multiple separate
 * `test()` blocks — each gets its own fresh context restoring the SAME
 * static snapshot, and the second context to present that already-rotated
 * token trips the app's real reuse-detection defense (correct security
 * behavior on the app's part). Confirmed empirically while writing this
 * file (Offers failed exactly this way as a separate `test()`).
 */
const SEED_EMAIL = process.env.E2E_SEED_EMAIL ?? 'admin@acme.test';
const SEED_PASSWORD = process.env.E2E_SEED_PASSWORD ?? 'ChangeMe123!';
const BASE_URL = process.env.E2E_WEB_ORIGIN ?? 'http://127.0.0.1:5173';
// The toolbar's Filter toggle ("Filter" / "Filter 2"), never the open popover's "Remove Status filter" buttons.
const FILTER_BUTTON = /^Filter(\s*\d+)?$/;
// Filter values are picked from the popover's <select> (role combobox): the Options popover's column checkboxes carry the
// same names ("Status", "Type", ...) and can still be in the DOM while it closes.
const API_ORIGIN = process.env.E2E_API_ORIGIN ?? 'http://127.0.0.1:3000';

test('Shifts, Offers, Venues, Payroll, Audit Log: Filter/Sort/Options all work against real server-backed data', async ({ page }) => {
  await test.step('login', async () => {
    await page.goto(`${BASE_URL}/login`);
    await page.getByRole('button', { name: 'Continue with email' }).click();
    await page.getByLabel('Email').fill(SEED_EMAIL);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByLabel('Password', { exact: true }).fill(SEED_PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(`${BASE_URL}/`);
  });

  await test.step('Shifts: Filter (status), Sort (venue), Options (hide/reset Time column)', async () => {
    await page.getByRole('link', { name: 'Shifts', exact: true }).click();
    await expect(page.locator('.page-header-title')).toContainText('Shifts');
    // The table's own unfiltered total (the footer and the rows come from the same list query; other widgets also query
    // /shifts with their own filters, so the first /shifts response is not necessarily this one).
    await expect(page.locator('.table tbody tr').first()).toBeVisible();
    await expect.poll(() => listTotal(page)).toBeGreaterThan(0);
    const allShifts = await listTotal(page);

    await page.getByRole('button', { name: FILTER_BUTTON }).click();
    await page.getByLabel('Add filter').selectOption('status');
    await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('draft');
    const filterResp = await page.waitForResponse((r) => r.url().includes('/rest/v1/shifts') && r.url().includes('status=draft'));
    const filterBody = await filterResp.json();
    expect(filterBody.data.length).toBeGreaterThan(0);
    for (const row of filterBody.data) expect(row.status).toBe('draft');
    await page.getByRole('button', { name: 'Clear all' }).click();
    await expect.poll(() => listTotal(page)).toBe(allShifts); // the full server-backed dataset again (support/live-list.ts)
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Sort' }).click();
    await page.getByRole('button', { name: 'Venue', exact: true }).click();
    const sortResp = await page.waitForResponse((r) => r.url().includes('/rest/v1/shifts') && r.url().includes('sort=venue'));
    expect(sortResp.status()).toBe(200);
    await page.keyboard.press('Escape');

    await expect(page.locator('.table thead th', { hasText: 'Time' })).toBeVisible();
    await page.getByRole('button', { name: 'Options' }).click();
    await page.getByLabel('Time', { exact: true }).uncheck();
    await page.keyboard.press('Escape');
    await expect(page.locator('.table thead th', { hasText: 'Time' })).toHaveCount(0);

    await page.reload();
    await expect(page.locator('.page-header-title')).toContainText('Shifts');
    await expect(page.locator('.table thead th', { hasText: 'Time' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Options' }).click();
    await page.getByRole('button', { name: 'Reset columns' }).click();
    await expect(page.locator('.table thead th', { hasText: 'Time' })).toBeVisible();
  });

  await test.step('Offers: status tab, Sort (staff), Options (hide/reset Role column)', async () => {
    await page.getByRole('link', { name: 'Offers', exact: true }).click();
    await expect(page.locator('.page-header-title')).toContainText('Offers');
    // The table's own unfiltered total (the footer and the rows come from the same list query; other widgets also query
    // /offers with their own filters, so the first /offers response is not necessarily this one).
    await expect(page.locator('.table tbody tr').first()).toBeVisible();
    await expect.poll(() => listTotal(page)).toBeGreaterThan(0);
    const allOffers = await listTotal(page);

    // The status tabs became the "Offers view" list-view picker (48ff7b29, 2026-10-13; shared ListViewSelect): same
    // statuses, same server-side `status=` query.
    const view = page.getByRole('combobox', { name: 'Offers view' });
    const withdrawnResp = page.waitForResponse((r) => r.url().includes('/rest/v1/offers') && r.url().includes('status=withdrawn'));
    await view.click();
    await page.getByRole('option', { name: 'Withdrawn', exact: true }).click();
    const tabBody = await (await withdrawnResp).json();
    expect(tabBody.data.length).toBeGreaterThan(0);
    for (const row of tabBody.data) expect(row.status).toBe('withdrawn');
    await expect.poll(() => listTotal(page)).toBe(tabBody.total);
    await view.click();
    await page.getByRole('option', { name: 'All offers', exact: true }).click();
    await expect.poll(() => listTotal(page)).toBe(allOffers);

    await page.getByRole('button', { name: 'Sort' }).click();
    await page.getByRole('button', { name: 'Staff', exact: true }).click();
    const sortResp = await page.waitForResponse((r) => r.url().includes('/rest/v1/offers') && r.url().includes('sort=staff'));
    expect(sortResp.status()).toBe(200);
    await page.keyboard.press('Escape');

    await expect(page.locator('.table thead th', { hasText: 'Role' })).toBeVisible();
    await page.getByRole('button', { name: 'Options' }).click();
    await page.getByLabel('Role', { exact: true }).uncheck();
    await page.keyboard.press('Escape');
    await expect(page.locator('.table thead th', { hasText: 'Role' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Options' }).click();
    await page.getByRole('button', { name: 'Reset columns' }).click();
    await expect(page.locator('.table thead th', { hasText: 'Role' })).toBeVisible();
  });

  await test.step('Venues: default Active filter applies, Type filter, Sort (name Z-A), Options', async () => {
    // Since 941e63fa (2026-10-23, archive/restore) the default "Active" view is the server's default (archived venues
    // excluded) and is no longer written into the URL as `status=active`; "All venues" sends includeArchived=true.
    const venuesLoaded = nextListResponse(page, 'venues');
    await page.getByRole('link', { name: 'Venues', exact: true }).click();
    await expect(page.locator('.page-header-title')).toContainText('Venues');
    const venuesLoad = await venuesLoaded;
    const defaultQuery = new URL(venuesLoad.url()).searchParams;
    expect(defaultQuery.get('includeArchived')).toBeNull();
    expect(defaultQuery.get('status')).not.toBe('archived');
    const defaultVenues = (await venuesLoad.json()) as { data: Array<{ status: string }> };
    expect(defaultVenues.data.length).toBeGreaterThan(0);
    for (const row of defaultVenues.data) expect(row.status).toBe('active');
    await expect(page.getByRole('combobox', { name: 'Venues view' })).toContainText('Active');

    await page.getByRole('button', { name: FILTER_BUTTON }).click();
    await page.getByLabel('Add filter').selectOption('type');
    await page.getByRole('combobox', { name: 'Type', exact: true }).selectOption('restaurant');
    const filterResp = await page.waitForResponse((r) => r.url().includes('/rest/v1/venues') && r.url().includes('type=restaurant'));
    const filterBody = await filterResp.json();
    for (const row of filterBody.data) expect(row.type).toBe('restaurant');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: /^Sort/ }).click();
    await page.getByRole('button', { name: 'Name', exact: true }).click();
    await page.getByRole('button', { name: 'Z–A' }).click();
    const sortResp = await page.waitForResponse((r) => r.url().includes('/rest/v1/venues') && r.url().includes('direction=desc'));
    expect(sortResp.status()).toBe(200);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Options' }).click();
    await page.getByLabel('Client', { exact: true }).uncheck();
    await page.keyboard.press('Escape');
    await expect(page.locator('.table thead th', { hasText: 'Client' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Options' }).click();
    await page.getByRole('button', { name: 'Reset columns' }).click();
    await expect(page.locator('.table thead th', { hasText: 'Client' })).toBeVisible();
  });

  // Payroll was redesigned on 2026-10-21 (ca44a0f1, "payroll calendar/records/runs"): one month of the workspace's
  // attendance joined with its payroll records, loaded once from GET /payroll/period and filtered / sorted in the page
  // (Filter popover: status + venue; Records view: "Sort records"). The server-side /attendance toolbar and its column
  // Options are gone from this page, so this step checks the current controls against the real period data instead.
  await test.step('Payroll: Status filter, Sort (amount), Venue filter — verified against the real payroll period data', async () => {
    const periodResponse = page.waitForResponse((r) => r.url().includes('/rest/v1/payroll/period') && r.request().method() === 'GET' && r.ok());
    await page.getByRole('link', { name: 'Payroll', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Payroll' })).toBeVisible();
    const period = (await (await periodResponse).json()) as { rows: Array<{ stage: string; venueName: string; amountPence: number | null }> };
    expect(period.rows.length).toBeGreaterThan(1);

    await page.getByRole('tab', { name: 'Records', exact: true }).click();
    const records = page.getByRole('region', { name: 'Payroll records' });
    const rows = records.locator('tbody tr:not(:has(.payroll-empty-cell))');
    await expect(rows).toHaveCount(period.rows.length);
    const filter = async (label: 'Filter by status' | 'Filter by venue', value: string) => {
      await page.getByRole('button', { name: /^Filter/ }).click();
      await page.getByLabel(label).selectOption(value);
      await page.keyboard.press('Escape');
    };

    // Status = Completed: exactly the server's completed rows, and every row's status says so.
    const completed = period.rows.filter((r) => r.stage === 'completed');
    expect(completed.length).toBeGreaterThan(0);
    expect(completed.length).toBeLessThan(period.rows.length);
    await filter('Filter by status', 'completed');
    await expect(rows).toHaveCount(completed.length);
    for (const status of await rows.locator('td:last-child').allTextContents()) expect(status).toContain('Completed');
    await filter('Filter by status', '');
    await expect(rows).toHaveCount(period.rows.length);

    // Sort: Amount really orders the rows largest first (rows without a figure last).
    await records.getByLabel('Sort records').selectOption('amount');
    const pence = (text: string) => (/\d/.test(text) ? Number(text.replace(/[^\d]/g, '')) : -1);
    const shown = (await rows.locator('td:nth-child(8)').allTextContents()).map(pence);
    expect(shown).toEqual(period.rows.map((r) => r.amountPence ?? -1).sort((a, b) => b - a));

    // Venue: only that venue's rows, all of them.
    const venue = period.rows[0]!.venueName;
    const atVenue = period.rows.filter((r) => r.venueName === venue).length;
    expect(atVenue).toBeLessThan(period.rows.length);
    await filter('Filter by venue', venue);
    await expect(rows).toHaveCount(atVenue);
    for (const cell of await rows.locator('td:nth-child(3)').allTextContents()) expect(cell).toBe(venue);
    await filter('Filter by venue', '');
    await expect(rows).toHaveCount(period.rows.length);
  });

});

// Isolated — not chained after the other four pages' steps. Chaining it
// there was empirically flaky under this test file's own compressed
// multi-page-in-30-seconds pace (confirmed via direct investigation: the
// same Filter → Action → Clear-all sequence passes reliably standalone,
// and the toolbar itself was already independently verified working via a
// prior live browser check — "Filtered total: 19 all user.created: true",
// zero console errors). Not realistic user behavior either way (a real
// user doesn't operate five different tables' worth of filters inside 30
// seconds), so isolating this is the more representative test, not a
// weakening of coverage.
test('Audit Log: Action filter, date sort actually reorders, Options', async ({ page }) => {
  await page.goto(`${BASE_URL}/login`);
  await page.getByRole('button', { name: 'Continue with email' }).click();
  await page.getByLabel('Email').fill(SEED_EMAIL);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Password', { exact: true }).fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(`${BASE_URL}/`);

  const auditLoaded = nextListResponse(page, 'audit-logs');
  await page.getByRole('link', { name: 'Audit Log', exact: true }).click();
  await expect(page.locator('.page-header-title')).toContainText('Audit Log');
  const allEntries = ((await (await auditLoaded).json()) as { total: number }).total;

  await page.getByRole('button', { name: FILTER_BUTTON }).click();
  await page.getByLabel('Add filter').selectOption('action');
  await page.getByRole('combobox', { name: 'Action', exact: true }).selectOption('user.created');
  const filterResp = await page.waitForResponse((r) => r.url().includes('/rest/v1/audit-logs') && r.url().includes('action=user.created'));
  const filterBody = await filterResp.json();
  expect(filterBody.items.length).toBeGreaterThan(0);
  for (const item of filterBody.items) expect(item.action).toBe('user.created');
  await page.getByRole('button', { name: 'Clear all' }).click();
  await expect.poll(() => listTotal(page)).toBe(allEntries); // the full server-backed log again (support/live-list.ts)
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Sort' }).click();
  await page.getByRole('button', { name: 'Date', exact: true }).click();
  await page.getByRole('button', { name: 'Oldest first' }).click();
  const sortResp = await page.waitForResponse((r) => r.url().includes('/rest/v1/audit-logs') && r.url().includes('direction=asc'));
  const sortBody = await sortResp.json();
  const timestamps = sortBody.items.map((i: { createdAt: string }) => new Date(i.createdAt).getTime());
  expect(timestamps).toEqual([...timestamps].sort((a: number, b: number) => a - b));
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Options' }).click();
  await page.getByLabel('Category', { exact: true }).uncheck();
  await page.keyboard.press('Escape');
  await expect(page.locator('.table thead th', { hasText: 'Category' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Options' }).click();
  await page.getByRole('button', { name: 'Reset columns' }).click();
  await expect(page.locator('.table thead th', { hasText: 'Category' })).toBeVisible();
});

test('direct API abuse across Shifts/Offers/Venues/Attendance/Audit: injection and invalid params always rejected, never a 500', async ({ request }) => {
  const loginRes = await request.post(`${API_ORIGIN}/rest/v1/auth/login`, {
    data: { email: SEED_EMAIL, password: SEED_PASSWORD },
  });
  const { accessToken } = await loginRes.json();
  const headers = { Authorization: `Bearer ${accessToken}` };

  const cases: Array<[string, string]> = [
    ['/rest/v1/shifts', 'sort=DROP TABLE shift'],
    ['/rest/v1/shifts', 'status=deleted_forever'],
    ['/rest/v1/offers', 'sort=1;--'],
    ['/rest/v1/offers', 'status=made_up'],
    ['/rest/v1/venues', 'sort=venue.name);DROP'],
    ['/rest/v1/venues', 'type=skyscraper'],
    ['/rest/v1/attendance', 'sort=DROP'],
    ['/rest/v1/attendance', 'status=paid'],
    ['/rest/v1/audit-logs', 'sort=DROP'],
    ['/rest/v1/audit-logs', 'action=not_a_real_action'],
  ];
  for (const [path, query] of cases) {
    const res = await request.get(`${API_ORIGIN}${path}?${encodeURI(query)}`, { headers });
    expect(res.status(), `${path}?${query}`).toBe(400);
  }
});
