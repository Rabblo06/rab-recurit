import { expect, test } from '@playwright/test';

/**
 * P1C.1B (FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.7.6/§33.7.8, P1C.1B brief §27) — the Login
 * screen's provider buttons are driven entirely by the server's `GET /rest/v1/auth/config`
 * response, never a compiled-in Vite env var. `/rest/v1/auth/config` is intercepted here (not
 * the real backend) specifically so this suite is deterministic and needs no real Google/
 * Microsoft credentials or backend env toggling — the backend-truthfulness of that endpoint
 * itself is covered by the server-side integration suite
 * (`p1c1b-auth-providers.integration.spec.ts`), not re-proven here.
 */
async function mockAuthConfig(page: import('@playwright/test').Page, authProviders: { password: boolean; google: boolean; microsoft: boolean }) {
  await page.route('**/rest/v1/auth/config**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authProviders }) }),
  );
}

test('Google enabled, Microsoft disabled: Google button appears, Microsoft does not', async ({ page }) => {
  await mockAuthConfig(page, { password: true, google: true, microsoft: false });
  await page.goto('/login');
  await expect(page.getByText('Continue with Google')).toBeVisible();
  await expect(page.getByText('Continue with Microsoft')).toHaveCount(0);
  await expect(page.getByLabel('Email')).toBeVisible();
});

test('Microsoft enabled, Google disabled: Microsoft button appears, Google does not', async ({ page }) => {
  await mockAuthConfig(page, { password: true, google: false, microsoft: true });
  await page.goto('/login');
  await expect(page.getByText('Continue with Microsoft')).toBeVisible();
  await expect(page.getByText('Continue with Google')).toHaveCount(0);
});

test('both providers disabled: neither button appears, password form still works', async ({ page }) => {
  await mockAuthConfig(page, { password: true, google: false, microsoft: false });
  await page.goto('/login');
  await expect(page.getByText('Continue with Google')).toHaveCount(0);
  await expect(page.getByText('Continue with Microsoft')).toHaveCount(0);
  await expect(page.getByLabel('Email')).toBeVisible();
});

test('password disabled: the email/password form is hidden, only provider buttons remain', async ({ page }) => {
  await mockAuthConfig(page, { password: false, google: true, microsoft: true });
  await page.goto('/login');
  await expect(page.getByLabel('Email')).toHaveCount(0);
  await expect(page.getByText('Continue with Google')).toBeVisible();
  await expect(page.getByText('Continue with Microsoft')).toBeVisible();
});

test('an oauthError query param shows the generic failure banner, never a specific reason', async ({ page }) => {
  await mockAuthConfig(page, { password: true, google: true, microsoft: false });
  await page.goto('/login?oauthError=1');
  await expect(page.getByRole('alert')).toContainText("We couldn't sign you in");
});
