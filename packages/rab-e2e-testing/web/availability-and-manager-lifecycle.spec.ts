import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';

/**
 * Staff availability warning + Manager lifecycle panel, in the real React app and router with deterministic,
 * browser-local API fixtures (no live accounts, no database). Run with playwright.isolated.config.ts against an isolated
 * Vite instance on 127.0.0.1:5174.
 */
const SHOTS = path.resolve(__dirname, '../../../docs/qa/staff-availability-manager-activation');
const VIEWPORTS = [
  { name: '1920', width: 1920, height: 1080 },
  { name: '1366', width: 1366, height: 768 },
  { name: '390', width: 390, height: 844 },
];
const identity = {
  id: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222',
  organisationId: '33333333-3333-4333-8333-333333333333', firstName: 'Issac', lastName: 'Nepolean',
  email: 'ceo@example.test', roles: ['ceo'], isPlatformAdmin: false, mustResetPassword: false,
  applicationTarget: 'manager_web', sessionExpiresAt: '2099-01-01T00:00:00Z',
};
const staff = [
  { id: 's-john', firstName: 'John', lastName: 'Smith', email: 'john@example.test', employmentStatus: 'active' },
  { id: 's-amy', firstName: 'Amy', lastName: 'Lee', email: 'amy@example.test', employmentStatus: 'active' },
  { id: 's-bo', firstName: 'Bo', lastName: 'Chan', email: 'bo@example.test', employmentStatus: 'active' },
  { id: 's-xan', firstName: 'Xan', lastName: 'Unknown', email: 'xan@example.test', employmentStatus: 'active' },
];
const shift = {
  id: 'shift-1', venueId: 'v-1', jobRoleId: 'jr-1', startsAt: '2026-10-19T09:00:00Z', endsAt: '2026-10-19T17:00:00Z',
  breakMinutes: 30, requiredCount: 4, filledCount: 0, payRatePence: 1250, status: 'open',
};
const conflictFor = (s: (typeof staff)[number], days: string[]) => ({
  staffProfileId: s.id, staffName: `${s.firstName} ${s.lastName}`, availableDays: days, conflictDates: [{ date: '2026-10-19', weekday: 'Monday' }],
});
const SINGLE = { code: 'STAFF_AVAILABILITY_CONFLICT', message: 'x', totalRecipients: 1, conflicts: [conflictFor(staff[0], ['Tuesday', 'Sunday'])], unknownAvailability: [] };
const BULK = {
  code: 'STAFF_AVAILABILITY_CONFLICT', message: 'x', totalRecipients: 4,
  conflicts: [conflictFor(staff[0], ['Tuesday', 'Sunday']), conflictFor(staff[1], ['Saturday']), conflictFor(staff[2], ['Wednesday', 'Friday'])],
  unknownAvailability: [{ staffProfileId: 's-xan', staffName: 'Xan Unknown' }],
};
const acceptedVenueManager = {
  id: 'm-1', email: 'issacn90474@example.test', firstName: 'issac', lastName: 'n', phone: null, avatarKey: null, type: 'venue',
  isInitialManager: false, jobTitle: null, createdAt: '2026-10-15T11:02:29Z', accountStatus: 'invited', invitationStatus: 'accepted',
  mustResetPassword: false, pendingInvite: { sendNumber: 1, maxSendAttempts: 3, expiresAt: '2026-10-16T11:02:00Z', cleanupAt: null },
};

async function fixtures(page: Page, conflict: object) {
  const calls: Array<{ path: string; method: string; body: any }> = [];
  await page.route('**/rest/v1/**', async (route) => {
    const request = route.request();
    const p = new URL(request.url()).pathname.replace('/rest/v1', '');
    const method = request.method();
    const body = request.postData() ? request.postDataJSON() : null;
    calls.push({ path: p, method, body });
    const send = (data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (p.includes('realtime')) return route.abort();
    if (p === '/auth/me') return send(identity);
    if (p === '/auth/config') return send({ authProviders: { password: true } });
    if (p === '/manager-workspaces/me') return send({ id: 'w-1', name: 'Issac', status: 'active', subdomain: 'issac', schemaStatus: 'READY', onboardingCompletedAt: '2026-10-01T00:00:00Z' });
    if (p === '/leadership/capabilities') return send({ 'staff.view': true, leadership: { canCreateOrganisation: false, initialManagerScope: 'own' } });
    if (p === '/profile') return send({ ...identity, avatarKey: null });
    if (p === '/profile/preferences') return send({ theme: 'light' });
    if (p === '/notifications/unread-count') return send({ count: 0 });
    if (p === '/venues') return send([{ id: 'v-1', name: 'The Grand Hall', status: 'active' }]);
    if (p === '/job-roles') return send([{ id: 'jr-1', name: 'Bartender', defaultRatePence: 1250 }]);
    if (p === '/staff') return send({ data: staff, total: staff.length });
    if (p === '/managers/m-1') return send(acceptedVenueManager);
    if (p === '/shifts/shift-1/offers/bulk' && method === 'POST') {
      if (!body.acknowledgedAvailabilityConflicts) return send(conflict, 409);
      return send({ batchId: 'b-1', results: body.staffProfileIds.map((id: string) => ({ staffProfileId: id, ok: true, offerId: `o-${id}` })) }, 201);
    }
    return send({ data: [], total: 0 });
  });
  return calls;
}

async function openSendOffer(page: Page, names: string[]) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.evaluate((s) => document.dispatchEvent(new CustomEvent('open-send-offer', { detail: { shift: s } })), shift);
  for (const name of names) await page.getByRole('button', { name: new RegExp(name) }).first().click();
  await page.getByRole('button', { name: /^Send offer/ }).click();
}

for (const vp of VIEWPORTS) {
  test.describe(`viewport ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('single recipient: warning before dispatch; Cancel sends nothing, Send anyway sends once with the acknowledgement', async ({ page }) => {
      const calls = await fixtures(page, SINGLE);
      await openSendOffer(page, ['John Smith']);
      const dialog = page.getByRole('alertdialog', { name: 'Staff availability warning' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('John Smith has marked themselves as unavailable on Monday.');
      await expect(dialog).toContainText('Available days: Tuesday and Sunday.');
      await expect(dialog).toContainText('You can cancel or choose to send the offer anyway.');
      await page.screenshot({ path: path.join(SHOTS, `availability-single-${vp.name}.png`) });
      const box = await dialog.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();
      expect(calls.filter((c) => c.path.endsWith('/offers/bulk'))).toHaveLength(1);

      await page.getByRole('button', { name: /^Send offer/ }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Send anyway' }).click();
      // Every offer sent → the existing drawer behaviour closes it (results are only listed when some fail).
      await expect(page.getByRole('alertdialog')).toBeHidden();
      await expect(page.getByRole('button', { name: /^Send offer/ })).toBeHidden();
      const sends = calls.filter((c) => c.path.endsWith('/offers/bulk'));
      expect(sends).toHaveLength(3);
      expect(sends[2].body.acknowledgedAvailabilityConflicts).toEqual([{ staffProfileId: 's-john', dates: ['2026-10-19'] }]);
    });

    test('bulk: "3 of 4" summary, every affected person listed, unknown availability not treated as unavailable', async ({ page }) => {
      await fixtures(page, BULK);
      await openSendOffer(page, ['John Smith', 'Amy Lee', 'Bo Chan', 'Xan Unknown']);
      const dialog = page.getByRole('alertdialog', { name: 'Staff availability warning' });
      await expect(dialog).toContainText('3 of 4 selected Staff have availability conflicts.');
      await expect(dialog.getByRole('listitem')).toHaveCount(3);
      await expect(dialog).toContainText('1 selected person has not provided availability');
      await page.screenshot({ path: path.join(SHOTS, `availability-bulk-${vp.name}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });

    test('Venue Manager who used the activation link: real type and state, only permitted actions', async ({ page }) => {
      await fixtures(page, SINGLE);
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await page.evaluate(() => document.dispatchEvent(new CustomEvent('open-user-detail', { detail: { id: 'm-1', type: 'manager' } })));
      await expect(page.getByText('Manager • Venue').first()).toBeVisible();
      await expect(page.getByText('Awaiting first sign-in').first()).toBeVisible();
      await expect(page.getByText('Pending — invite not sent')).toHaveCount(0);
      await expect(page.getByText(/becomes active the first time they sign in to the ADOLPHUS mobile app/)).toBeVisible();
      await page.getByRole('button', { name: 'More actions' }).click();
      await expect(page.getByRole('button', { name: /Send a new setup link/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /Reset password/ })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /Reactivate/ })).toHaveCount(0);
      await page.screenshot({ path: path.join(SHOTS, `manager-accepted-${vp.name}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  });
}
