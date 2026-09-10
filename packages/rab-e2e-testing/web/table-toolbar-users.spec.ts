import { expect, test } from '@playwright/test';

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
const BASE_URL = 'http://127.0.0.1:5173';

test('Users: Filter, Sort, Options, and Clear all work against real server-backed data', async ({ page }) => {
  await test.step('login', async () => {
    await page.goto(`${BASE_URL}/login`);
    await page.getByLabel('Email').fill(SEED_EMAIL);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Password').fill(SEED_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(`${BASE_URL}/`);
    await page.goto(`${BASE_URL}/users`);
    await expect(page.locator('.page-header-title')).toContainText('Users');
  });

  await test.step('Filter: Status = Active — every returned row actually has employmentStatus active', async () => {
    await page.getByRole('button', { name: 'Filter' }).click();
    await page.getByLabel('Add filter').selectOption('status');
    await page.getByLabel('Status', { exact: true }).selectOption('active');
    await expect(page.getByRole('button', { name: /Filter\s*\d/ })).toBeVisible();

    const response = await page.waitForResponse((r) => r.url().includes('/rest/v1/staff') && r.url().includes('status=active'));
    // Verify against the actual response body, not DOM text — `employmentStatus`
    // (what's filtered) and `accountStatus` (what the Status *column* often
    // displays instead, e.g. "Invitation queued" for a still-pending invite)
    // are independent dimensions, so a cell's visible text is not a reliable
    // proxy for which field the server actually filtered on.
    const body = await response.json();
    expect(body.data.length).toBeGreaterThan(0);
    for (const row of body.data) expect(row.employmentStatus).toBe('active');
    await page.keyboard.press('Escape');
  });

  await test.step('Filter + Filter compose: a second filter narrows further, does not replace the first', async () => {
    const activeCountText = await page.locator('.list-footer strong').textContent();

    await page.getByRole('button', { name: /Filter/ }).click();
    await page.getByLabel('Add filter').selectOption('employmentType');
    await page.getByLabel('Employment type', { exact: true }).selectOption('Full-time');
    const response = await page.waitForResponse(
      (r) => r.url().includes('/rest/v1/staff') && r.url().includes('employmentType=Full-time') && r.url().includes('status=active'),
    );
    await page.keyboard.press('Escape');

    const body = await response.json();
    for (const row of body.data) {
      expect(row.employmentStatus).toBe('active');
      expect(row.employmentType).toBe('Full-time');
    }
    const narrowedCountText = await page.locator('.list-footer strong').textContent();
    expect(Number(narrowedCountText)).toBeLessThanOrEqual(Number(activeCountText));
  });

  await test.step('Sort: Date added newest vs oldest actually reorders rows by createdAt', async () => {
    await page.getByRole('button', { name: 'Filter' }).click();
    await page.getByRole('button', { name: 'Clear all' }).click();
    await page.waitForResponse((r) => r.url().includes('/rest/v1/staff') && !r.url().includes('status='));
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Sort' }).click();
    await page.getByRole('button', { name: 'Date added', exact: true }).click();
    await page.getByRole('button', { name: 'Oldest first' }).click();
    const oldestRes = await page.waitForResponse(
      (r) => r.url().includes('/rest/v1/staff') && r.url().includes('sort=createdAt') && r.url().includes('direction=asc'),
    );
    await page.keyboard.press('Escape');
    const oldestBody = await oldestRes.json();

    await page.getByRole('button', { name: /Sort/ }).click();
    await page.getByRole('button', { name: 'Newest first' }).click();
    const newestRes = await page.waitForResponse((r) => r.url().includes('/rest/v1/staff') && r.url().includes('direction=desc'));
    const newestBody = await newestRes.json();

    expect(oldestBody.data[0]?.id).not.toBe(newestBody.data[0]?.id);
    const oldestTimestamps = oldestBody.data.map((r: { createdAt: string }) => new Date(r.createdAt).getTime());
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
    const totalBefore = await page.locator('.list-footer strong').textContent();

    await page.getByRole('button', { name: 'Filter' }).click();
    await page.getByLabel('Add filter').selectOption('status');
    await page.getByLabel('Status', { exact: true }).selectOption('suspended');
    await page.waitForResponse((r) => r.url().includes('/rest/v1/staff') && r.url().includes('status=suspended'));

    await page.getByRole('button', { name: 'Clear all' }).click();
    await page.waitForResponse((r) => r.url().includes('/rest/v1/staff') && !r.url().includes('status='));

    const totalAfter = await page.locator('.list-footer strong').textContent();
    expect(totalAfter).toBe(totalBefore);
  });
});

test('direct API abuse: invalid sort field and injection attempts are rejected, never a 500', async ({ request }) => {
  const loginRes = await request.post('http://127.0.0.1:3000/rest/v1/auth/login', {
    data: { email: SEED_EMAIL, password: SEED_PASSWORD },
  });
  const { accessToken } = await loginRes.json();

  for (const badSort of ['DROP TABLE', 'passwordHash', 'name); --']) {
    const res = await request.get(`http://127.0.0.1:3000/rest/v1/staff?sort=${encodeURIComponent(badSort)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status()).toBe(400);
  }

  const invalidStatus = await request.get('http://127.0.0.1:3000/rest/v1/staff?status=INVALID', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  expect(invalidStatus.status()).toBe(400);

  const hugePage = await request.get('http://127.0.0.1:3000/rest/v1/staff?limit=999999', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  expect(hugePage.status()).toBe(400);
});
