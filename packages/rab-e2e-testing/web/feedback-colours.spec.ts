import { test, expect, type Page, type Locator } from '@playwright/test';

// Render the real frontend with browser-local HTTP fixtures. No database writes,
// live credentials, email delivery, or backend availability are needed.
const identity = {
  id: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222',
  organisationId: '33333333-3333-4333-8333-333333333333', firstName: 'Test', lastName: 'User',
  email: 'feedback@example.test', roles: ['ceo'], isPlatformAdmin: true,
  mustResetPassword: false, applicationTarget: 'manager_web', sessionExpiresAt: '2099-01-01T00:00:00Z',
};
async function fixtures(page: Page, { authenticated = false, preparing = false } = {}) {
  const workspace = {
    id: '44444444-4444-4444-8444-444444444444', name: 'Test workspace', subdomain: 'test',
    status: 'active', schemaStatus: preparing ? 'CREATING' : 'READY', onboardingCompletedAt: '2026-10-01T00:00:00Z',
  };
  await page.route('**/rest/v1/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/rest/v1', '');
    const responses: Record<string, unknown> = {
      '/auth/me': authenticated ? identity : { message: 'Invalid session.' },
      '/auth/config': { authProviders: { password: true, google: false, microsoft: false } },
      '/auth/capabilities': { permissions: [], roles: identity.roles, isPlatformAdmin: true },
      '/profile': { ...identity, avatarKey: null },
      '/profile/preferences': { theme: 'light' },
      '/manager-workspaces/me': workspace,
      // WorkspacePreparationScreen resumes a CREATING workspace once per mount by repeating the idempotent create
      // (8cf5986a); the server answers with the same, still-provisioning workspace.
      '/manager-workspaces': workspace,
      '/auth/forgot-password': {},
      '/auth/reset-password': { applicationTarget: 'manager_web', managerLoginUrl: '/login' },
      '/notifications/unread-count': { count: 0 }, '/notifications': [], '/roles': [], '/job-roles': [],
    };
    if (path.includes('realtime')) return route.abort();
    await route.fulfill({ status: path === '/auth/me' && !authenticated ? 401 : 200,
      contentType: 'application/json', body: JSON.stringify(responses[path] ?? { data: [], total: 0 }) });
  });
}

function appearance(locator: Locator, pseudo?: string) {
  return locator.evaluate((element, pseudo) => {
    const style = getComputedStyle(element, pseudo);
    return Object.fromEntries(['color', 'backgroundColor', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'borderRadius'].map(key => [key, style[key as any]]));
  }, pseudo);
}
async function setTheme(page: Page, theme: string) {
  await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
}

for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
  test.describe(`${width}px ${theme} feedback`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 960 }, reducedMotion: 'reduce' });
    const error = theme === 'light' ? 'rgb(198, 40, 40)' : 'rgb(255, 138, 128)';
    const success = theme === 'light' ? 'rgb(24, 113, 59)' : 'rgb(129, 201, 149)';
    // Crewflow neutral palette (2b683f6e, 2026-10-20): headings are --font-primary, and the --walnut primary-action
    // token now resolves to --color-accent (reference-ui.css). The feedback colours above did not change.
    const heading = theme === 'light' ? 'rgb(36, 37, 43)' : 'rgb(236, 236, 238)';
    const walnut = theme === 'light' ? 'rgb(185, 82, 10)' : 'rgb(255, 154, 77)';
    const neutralDescription = theme === 'light' ? 'rgb(129, 135, 148)' : 'rgb(133, 139, 151)';

    test('network failure colours only the feedback, preserving form and heading styles', async ({ page }, info) => {
      await fixtures(page);
      await page.route('**/rest/v1/auth/login', route => route.abort('connectionrefused'));
      await page.goto('/login');
      await page.getByRole('button', { name: 'Continue with email' }).click();
      await page.getByLabel('Work email', { exact: true }).fill('feedback@example.test');
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByLabel('Password', { exact: true }).fill('VisualFixture123!');
      await setTheme(page, theme);
      const title = page.getByRole('heading', { level: 1 });
      const button = page.locator('button[type=submit]');
      const labels = page.locator('form label');
      const back = page.getByRole('button', { name: 'Back to sign in' });
      const password = page.getByLabel('Password', { exact: true });
      // The existing button background transition must settle after theme changes.
      await expect(button).toHaveCSS('background-color', walnut);
      const before = await Promise.all([appearance(title), appearance(button), appearance(labels.nth(0)), appearance(labels.nth(1)), appearance(back), appearance(password, '::placeholder'), appearance(password)]);
      await expect(title).toHaveCSS('color', heading);
      await button.click();
      await expect(page.getByRole('alert')).toHaveText('Unable to reach the server. Check your connection and try again.');
      await expect(page.getByRole('alert')).toHaveCSS('color', error);
      await expect(title).toHaveText('Try signing in again');
      await expect(button).toBeEnabled();
      expect(await Promise.all([appearance(title), appearance(button), appearance(labels.nth(0)), appearance(labels.nth(1)), appearance(back), appearance(password, '::placeholder'), appearance(password)])).toEqual(before);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath('login-error.png') });
    });

    test('expired link and password success keep the same heading typography', async ({ page }, info) => {
      await fixtures(page);
      await page.goto('/reset-password?token=browser-fixture');
      await page.getByLabel('New password', { exact: true }).fill('VisualFixture123!');
      await page.getByLabel('Confirm password', { exact: true }).fill('VisualFixture123!');
      await setTheme(page, theme);
      // Like the button below, the heading colour runs through the (reduced-motion, near-instant) transition first.
      await expect(page.getByRole('heading', { level: 1 })).toHaveCSS('color', heading);
      const before = await appearance(page.getByRole('heading', { level: 1 }));
      await expect(page.getByRole('button', { name: 'Reset password', exact: true })).toHaveCSS('background-color', walnut);
      const buttonBefore = await appearance(page.getByRole('button', { name: 'Reset password', exact: true }));
      await page.getByRole('button', { name: 'Reset password', exact: true }).click();
      const status = page.getByRole('status');
      await expect(status).toBeVisible();
      await expect(status.locator('h1')).toHaveCSS('color', heading);
      expect(await appearance(status.locator('h1'))).toEqual(before);
      await expect(status.locator('p').first()).toHaveCSS('color', success);
      await expect(status).toHaveAttribute('aria-live', 'polite');
      expect(await appearance(status.locator('a'))).toEqual(buttonBefore);
      await expect(status.locator('h1')).toHaveCSS('opacity', '1');
      await expect(status.locator('p').first()).toHaveCSS('opacity', '1');
      await expect(status.locator('a').locator('..')).toHaveCSS('opacity', '1');
      await page.screenshot({ path: info.outputPath('password-success.png') });
      await page.goto('/reset-password');
      await setTheme(page, theme);
      await expect(page.getByRole('heading', { name: 'This link has expired' })).toHaveCSS('color', heading);
      await expect(page.getByRole('alert')).toHaveCSS('color', error);
      expect(await appearance(page.getByRole('heading', { level: 1 }))).toEqual(before);
    });

    test('reset request confirmation is green but its title is neutral', async ({ page }, info) => {
      await fixtures(page);
      await page.goto('/forgot-password');
      await page.getByLabel('Email', { exact: true }).fill('feedback@example.test');
      await setTheme(page, theme);
      await page.getByRole('button', { name: 'Send reset link' }).click();
      await expect(page.getByRole('heading', { name: 'Check your inbox' })).toHaveCSS('color', heading);
      await expect(page.getByRole('status')).toHaveCSS('color', success);
      await expect(page.getByRole('status')).toContainText('If there’s an account');
      await expect(page.getByRole('status').locator('..')).toHaveCSS('opacity', '1');
      await page.screenshot({ path: info.outputPath('reset-request.png') });
    });

    test('illustrated errors and calendar failures do not tint titles or controls', async ({ page }, info) => {
      await fixtures(page, { authenticated: true });
      await page.route(/\/rest\/v1\/shifts\/requests(?:\?|$)/, route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"Unavailable"}' }));
      await page.goto('/venue-offers');
      await expect(page.locator('.empty-state-error')).toBeVisible();
      await setTheme(page, theme);
      await expect(page.locator('.empty-state-title')).toHaveCSS('color', heading);
      await expect(page.locator('.empty-state-description')).toHaveCSS('color', error);
      await expect(page.locator('.empty-state-error')).toHaveAttribute('role', 'alert');
      await page.screenshot({ path: info.outputPath('illustrated-error.png') });
      await page.route('**/rest/v1/shifts?*', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"Unavailable"}' }));
      await page.goto('/calendar');
      await expect(page.locator('.calendar-detail-subtitle')).toHaveText('Schedule could not be loaded');
      await setTheme(page, theme);
      await expect(page.locator('.calendar-day-empty strong')).toHaveCSS('color', heading);
      await expect(page.locator('.calendar-detail-subtitle')).toHaveCSS('color', error);
      await expect(page.locator('.calendar-day-empty p')).toHaveCSS('color', error);
      expect(await page.locator('.list-error button').evaluate(el => getComputedStyle(el).color)).not.toBe(error);
      await page.screenshot({ path: info.outputPath('calendar-error.png') });
    });

    // e31bf934 removed the separate "Still preparing" warning page on purpose: a slow CREATING keeps this same preparing
    // view (polling) and goes straight to the welcome on READY (WorkspacePreparationScreen's header comment).
    test('slow provisioning keeps the same neutral preparing view, heading and readiness gate', async ({ page }, info) => {
      await fixtures(page, { authenticated: true, preparing: true });
      await page.clock.install();
      await page.goto('/onboarding/preparing');
      await expect(page.getByText('Preparing your workspace', { exact: true })).toBeVisible();
      await setTheme(page, theme);
      await expect(page.getByText('Preparing your workspace', { exact: true })).toHaveCSS('color', heading);
      const before = await appearance(page.getByText('Preparing your workspace', { exact: true }));
      await page.clock.fastForward(16_000);
      const title = page.getByText('Preparing your workspace', { exact: true });
      await expect(title).toBeVisible();
      expect(await appearance(title)).toEqual(before);
      await expect(title).toHaveCSS('color', heading);
      await expect(page.getByText('Still preparing your workspace', { exact: true })).toHaveCount(0);
      await expect(page.locator('.preparation-description')).toHaveCSS('color', neutralDescription);
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.getByRole('status')).toHaveText('Preparing your workspace.');
      await expect(page.getByRole('status')).toHaveAttribute('aria-live', 'polite');
      await expect(page).toHaveURL(/\/onboarding\/preparing/);
      await page.screenshot({ path: info.outputPath('preparation-warning.png') });
    });

    test('list feedback and toasts preserve surrounding content and announce outcomes', async ({ page }, info) => {
      await fixtures(page, { authenticated: true });
      await page.route('**/rest/v1/staff?*', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"Unavailable"}' }));
      await page.goto('/users');
      await expect(page.locator('.list-error')).toBeVisible();
      await setTheme(page, theme);
      await expect(page.locator('.list-error .feedback-error')).toHaveCSS('color', error);
      expect(await page.getByText('Your data has not been changed.').evaluate(el => getComputedStyle(el).color)).not.toBe(error);
      await page.evaluate(() => {
        document.dispatchEvent(new CustomEvent('toast', { detail: { id: 'feedback-error', variant: 'error', message: 'Could not save your changes.' } }));
        document.dispatchEvent(new CustomEvent('toast', { detail: { id: 'feedback-success', variant: 'success', message: 'Profile updated.' } }));
      });
      // Draining-countdown toasts (e31bf934): a neutral card whose variant ink colours the icon, never the message.
      await expect(page.locator('.toast-error .toast-icon')).toHaveCSS('color', error);
      await expect(page.locator('.toast-error .toast-message')).toHaveCSS('color', heading);
      await expect(page.locator('.toast-error')).toHaveAttribute('role', 'alert');
      await expect(page.locator('.toast-success .toast-icon')).toHaveCSS('color', success);
      await expect(page.locator('.toast-success .toast-message')).toHaveCSS('color', heading);
      await expect(page.locator('.toast-success')).toHaveAttribute('role', 'status');
      await page.screenshot({ path: info.outputPath('list-and-toasts.png') });
    });
  });
}
