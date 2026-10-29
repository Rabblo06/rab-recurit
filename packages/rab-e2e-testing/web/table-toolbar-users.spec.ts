import { expect, test } from '@playwright/test';

import { listTotal } from './support/live-list';

/**
 * Global Filter/Sort/Options system — Users page. Exercises the real
 * server-backed toolbar (never client-side-only filtering) added on top of
 * the previously-dead Filter/Sort/Options buttons.
 *
 * One continuous test, `test.step()`-organized, sharing a single page/login
 * for its whole duration — not one `test()` per scenario. Two real reasons,
 * both discovered empirically while writing this file, not assumed upfront:
 *  1. `/auth/login` is intentionally rate-limited to 5/60s per IP
 *     (AUTH_THROTTLE); several independent tests each logging in would
 *     exhaust that budget on their own.
 *  2. More subtly: even a *shared* login snapshot (`storageState`, restored
 *     into a fresh context per test — Playwright's normal per-test
 *     isolation) breaks here, because this app's refresh token rotates on
 *     every use (`bootstrapSession()` calls `/auth/refresh` on page load).
 *     A second fresh context restoring the SAME static snapshot presents an
 *     already-rotated-away token, which trips the app's real reuse-detection
 *     defense and revokes the whole token family — correct security
 *     behavior on the app's part, but it means this walkthrough must stay
 *     on one continuous page/session, never spawn a second context from a
 *     stale snapshot.
 */
const SEED_EMAIL = process.env.E2E_SEED_EMAIL ?? 'admin@acme.test';
const SEED_PASSWORD = process.env.E2E_SEED_PASSWORD ?? 'ChangeMe123!';
// `localhost` and `127.0.0.1` are different *sites* for SameSite=Lax cookie
// purposes even though they're the same machine — the refresh cookie is
// scoped to whichever host actually issued it (`127.0.0.1:3000`, this
// docker-compose setup's `VITE_API_URL`), so staying on `127.0.0.1` for the
// page too keeps `bootstrapSession()`'s refresh fetch same-site.
const BASE_URL = process.env.E2E_WEB_ORIGIN ?? 'http://127.0.0.1:5173';
// The toolbar's Filter toggle ("Filter" / "Filter 2"), never the open popover's "Remove Status filter" buttons.
const FILTER_BUTTON = /^Filter(\s*\d+)?$/;
// Filter values are picked from the popover's <select> (role combobox): the Options popover's column checkboxes carry the
// same names ("Status", "Type", ...) and can still be in the DOM while it closes.
const API_ORIGIN = process.env.E2E_API_ORIGIN ?? 'http://127.0.0.1:3000';

test('Users: Filter, Sort, Options, and Clear all work against real server-backed data', async ({ page }) => {
  let activeCount = Number.NaN;
  let allStaff = Number.NaN;
  type StaffRow = { id: string; createdAt: string; firstName: string; lastName: string };
  let pageLoad: { url: string; body: { total: number; data: StaffRow[] } } | undefined;
  /** The table shows exactly these records, in this order (rendered names, not just the response). */
  const expectRenderedOrder = async (data: StaffRow[]) => {
    const rows = page.locator('.table tbody tr');
    await expect(rows).toHaveCount(data.length);
    for (const [i, r] of data.entries()) await expect(rows.nth(i)).toContainText(`${r.firstName} ${r.lastName}`);
  };
  await test.step('login', async () => {
    await page.goto(`${BASE_URL}/login`);
    await page.getByRole('button', { name: 'Continue with email' }).click();
    await page.getByLabel('Email').fill(SEED_EMAIL);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByLabel('Password', { exact: true }).fill(SEED_PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(`${BASE_URL}/`);
    // The table's own list query: the page also asks GET /staff?limit=1 for the "Staff · N" tab count (Users.tsx).
    const staffLoaded = page.waitForResponse((r) => {
      const url = new URL(r.url());
      return url.pathname.endsWith('/rest/v1/staff') && r.request().method() === 'GET' && r.ok() && url.searchParams.get('limit') !== '1';
    });
    await page.goto(`${BASE_URL}/users`);
    await expect(page.locator('.page-header-title')).toContainText('Users');
    const loaded = await staffLoaded;
    pageLoad = { url: loaded.url(), body: await loaded.json() };
    allStaff = pageLoad.body.total;
  });

  await test.step('Filter: Status = Active — every returned row actually has employmentStatus active', async () => {
    // Listen before choosing the filter: a fast server can answer before a listener added afterwards exists.
    const filtered = page.waitForResponse((r) => r.url().includes('/rest/v1/staff') && r.url().includes('status=active'));
    await page.getByRole('button', { name: FILTER_BUTTON }).click();
    await page.getByLabel('Add filter').selectOption('status');
    await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('active');
    await expect(page.getByRole('button', { name: /Filter\s*\d/ })).toBeVisible();

    const response = await filtered;
    // Verify against the actual response body, not DOM text — `employmentStatus`
    // (what's filtered) and `accountStatus` (what the Status *column* often
    // displays instead, e.g. "Invitation queued" for a still-pending invite)
    // are independent dimensions, so a cell's visible text is not a reliable
    // proxy for which field the server actually filtered on.
    const body = await response.json();
    expect(body.data.length).toBeGreaterThan(0);
    for (const row of body.data) expect(row.employmentStatus).toBe('active');
    await expect.poll(() => listTotal(page)).toBe(body.total);
    activeCount = body.total;
    await page.keyboard.press('Escape');
  });

  await test.step('Filter + Filter compose: a second filter narrows further, does not replace the first', async () => {
    const responseP = page.waitForResponse(
      (r) => r.url().includes('/rest/v1/staff') && r.url().includes('employmentType=Full-time') && r.url().includes('status=active'),
    ); // listen before the action that triggers it
    await page.getByRole('button', { name: FILTER_BUTTON }).click();
    await page.getByLabel('Add filter').selectOption('employmentType');
    await page.getByRole('combobox', { name: 'Employment type', exact: true }).selectOption('Full-time');
    const response = await responseP;
    await page.keyboard.press('Escape');

    const body = await response.json();
    for (const row of body.data) {
      expect(row.employmentStatus).toBe('active');
      expect(row.employmentType).toBe('Full-time');
    }
    // The footer shows the server's total for the composed query, and composing never widens the result.
    await expect.poll(() => listTotal(page)).toBe(body.total);
    expect(body.total).toBeLessThanOrEqual(activeCount);
  });

  await test.step('Sort: Date added newest vs oldest actually reorders rows by createdAt', async () => {
    await page.getByRole('button', { name: FILTER_BUTTON }).click();
    await page.getByRole('button', { name: 'Clear all' }).click();
    await expect.poll(() => listTotal(page)).toBe(allStaff); // the page's own unfiltered dataset again (support/live-list.ts)
    await page.keyboard.press('Escape');

    const oldestResP = page.waitForResponse(
      (r) => r.url().includes('/rest/v1/staff') && r.url().includes('sort=createdAt') && r.url().includes('direction=asc'),
    ); // listen before the action that triggers it
    await page.getByRole('button', { name: 'Sort' }).click();
    await page.getByRole('button', { name: 'Date added', exact: true }).click();
    await page.getByRole('button', { name: 'Oldest first' }).click();
    const oldestRes = await oldestResP;
    await page.keyboard.press('Escape');
    const oldestBody = (await oldestRes.json()) as { data: StaffRow[] };
    await expectRenderedOrder(oldestBody.data);

    // "Newest first" is the Users page's DEFAULT sort (Users.tsx `defaultSort: createdAt desc`), i.e. the very query the
    // page loaded with: inside React Query's 30 s staleTime (a74a2110) it is answered from that cached response with no
    // request. Use a fresh desc response when one comes, otherwise the page-load response of that identical query.
    const newestFresh = page
      .waitForResponse((r) => r.url().includes('/rest/v1/staff') && r.url().includes('direction=desc'), { timeout: 10_000 })
      .catch(() => null);
    await page.getByRole('button', { name: /Sort/ }).click();
    await page.getByRole('button', { name: 'Newest first' }).click();
    const fresh = await newestFresh;
    let newestBody: { data: StaffRow[] };
    if (fresh) newestBody = await fresh.json();
    else {
      const q = new URL(pageLoad!.url).searchParams;
      expect(q.get('status')).toBeNull();
      expect(q.get('employmentType')).toBeNull();
      expect(q.get('sort') === null || (q.get('sort') === 'createdAt' && q.get('direction') === 'desc')).toBe(true);
      newestBody = pageLoad!.body;
    }
    const newestTimestamps = newestBody.data.map((r) => new Date(r.createdAt).getTime());
    expect(newestTimestamps).toEqual([...newestTimestamps].sort((a, b) => b - a));
    // On either path the click must have re-rendered the table newest first (a no-op click would leave it oldest first).
    await expectRenderedOrder(newestBody.data);

    expect(oldestBody.data[0]?.id).not.toBe(newestBody.data[0]?.id);
    const oldestTimestamps = oldestBody.data.map((r) => new Date(r.createdAt).getTime());
    expect(oldestTimestamps).toEqual([...oldestTimestamps].sort((a, b) => a - b));
  });

  await test.step('Options: hiding a column removes it, reload preserves the choice, reset brings it back', async () => {
    await expect(page.locator('.table thead th', { hasText: 'Phone' })).toBeVisible();

    await page.getByRole('button', { name: 'Options' }).click();
    await page.getByLabel('Phone', { exact: true }).uncheck();
    await page.keyboard.press('Escape');
    await expect(page.locator('.table thead th', { hasText: 'Phone' })).toHaveCount(0);

    await page.reload();
    await expect(page.locator('.page-header-title')).toContainText('Users');
    await expect(page.locator('.table thead th', { hasText: 'Phone' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Options' }).click();
    await page.getByRole('button', { name: 'Reset columns' }).click();
    await expect(page.locator('.table thead th', { hasText: 'Phone' })).toBeVisible();
  });

  await test.step('Clear filters returns to the full authorized dataset', async () => {
    const totalBefore = await listTotal(page);

    await page.getByRole('button', { name: FILTER_BUTTON }).click();
    await page.getByLabel('Add filter').selectOption('status');
    await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('suspended');
    await page.waitForResponse((r) => r.url().includes('/rest/v1/staff') && r.url().includes('status=suspended'));

    await page.getByRole('button', { name: 'Clear all' }).click();
    await expect.poll(() => listTotal(page)).toBe(totalBefore);
  });
});

test('direct API abuse: invalid sort field and injection attempts are rejected, never a 500', async ({ request }) => {
  const loginRes = await request.post(`${API_ORIGIN}/rest/v1/auth/login`, {
    data: { email: SEED_EMAIL, password: SEED_PASSWORD },
  });
  const { accessToken } = await loginRes.json();

  for (const badSort of ['DROP TABLE', 'passwordHash', 'name); --']) {
    const res = await request.get(`${API_ORIGIN}/rest/v1/staff?sort=${encodeURIComponent(badSort)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status()).toBe(400);
  }

  const invalidStatus = await request.get(`${API_ORIGIN}/rest/v1/staff?status=INVALID`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  expect(invalidStatus.status()).toBe(400);

  const hugePage = await request.get(`${API_ORIGIN}/rest/v1/staff?limit=999999`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  expect(hugePage.status()).toBe(400);
});
