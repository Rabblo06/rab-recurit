import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';

/**
 * Crewflow motion system (2026-10-18): measures real animations in the real app (Chromium, isolated Vite :5174,
 * deterministic API fixtures — no live data). Each scenario samples the rendered value every animation frame, so
 * timings are measured, not assumed, and records a video for inspection. Run with playwright.isolated.config.ts.
 */
const OUT = path.resolve(__dirname, '.qa-shots/motion-2026-10-18');
test.use({ viewport: { width: 1440, height: 900 }, video: { mode: 'on', size: { width: 1440, height: 900 } } });

const identity = {
  id: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222',
  organisationId: '33333333-3333-4333-8333-333333333333', firstName: 'Issac', lastName: 'Nepolean',
  email: 'manager@example.test', roles: ['manager'], isPlatformAdmin: false, mustResetPassword: false,
  applicationTarget: 'manager_web', sessionExpiresAt: '2099-01-01T00:00:00Z',
};
const staff = (n: number) => ({
  id: `staff-${n}`, staffRef: `STAFF ${n}`, email: `staff${n}@example.test`, firstName: 'Staff', lastName: `Test ${n}`, phone: null,
  dateOfBirth: null, avatarKey: null, employmentStatus: 'active', startDate: null, defaultPayRatePence: 0, createdAt: '2026-10-01T00:00:00Z',
  createdByName: null, accountStatus: 'active', invitationStatus: null, mustResetPassword: false, pendingInvite: null, emergencyContactName: null,
  emergencyContactRelationship: null, emergencyContactPhone: null, jobRoleId: 'jr-1', preferredName: null, employmentType: null, address: null,
  city: null, postcode: null,
});
const STAGES = ['OFFERED', 'WAITING', 'STAFF ACCEPTED', 'CONFIRMED', 'LATE STAFF', 'CLOCKED IN', 'PENDING REVIEW', 'CLOCKED OUT', 'NO SHOW', 'REJECTED', 'CANCELLED', 'DELETED OFFER'];
const KEY: Record<string, string> = { OFFERED: 'offered', WAITING: 'waiting', 'STAFF ACCEPTED': 'accepted', CONFIRMED: 'confirmed', 'LATE STAFF': 'late', 'CLOCKED IN': 'clockedIn', 'PENDING REVIEW': 'pendingReview', 'CLOCKED OUT': 'clockedOut', 'NO SHOW': 'noShow', REJECTED: 'rejected', CANCELLED: 'cancelled', 'DELETED OFFER': 'deleted' };
function board(stageOf: (i: number) => string) {
  const staffCards = Array.from({ length: 6 }, (_, k) => {
    const i = k + 1, stage = stageOf(i);
    return { staffProfileId: `p-${i}`, name: `Staff Test ${i}`, avatarFileId: null, offerId: `offer-${i}`, stage, offerStatus: 'manager_confirmed', assignmentStatus: 'confirmed',
      attendanceStatus: stage === 'CLOCKED IN' ? 'clocked_in' : null, sentAt: '2026-10-15T09:00:00Z', acceptedAt: '2026-10-15T10:00:00Z', respondedAt: null, cancelledAt: null, terminalSource: null,
      clockInAt: stage === 'CLOCKED IN' ? '2026-10-16T15:03:00Z' : null, clockOutAt: null, breakMinutes: null, workedMinutes: null, declineReason: null, withdrawnReason: null, rejectionReason: null,
      canManagerCancel: false, attendanceReviewed: false, earlierOffers: 0 };
  });
  const counts = Object.fromEntries(STAGES.map((s) => [s, staffCards.filter((c) => c.stage === s).length]));
  return { shift: { id: 'shift-1', venueName: 'Venue Test 3', roleName: 'Test Role 3', startsAt: '2026-10-16T15:15:00Z', endsAt: '2026-10-16T22:15:00Z', status: 'fully_filled', requiredCount: 6 },
    serverNow: '2026-10-16T15:00:00Z', tableStatus: 'Fully filled', summary: { required: 6, filled: 6, open: 0, ...Object.fromEntries(STAGES.map((s) => [KEY[s], counts[s]])) },
    stageCounts: counts, stages: STAGES, staff: staffCards,
    report: { ready: false, originalFileId: null, signedFileId: null, reportStatus: 'pending', finalisedByName: null, finalisedAt: null, staff: [] }, replacementPlaces: 0 };
}

async function fixtures(page: Page) {
  const state = { pipeline: board(() => 'CONFIRMED'), calls: 0 };
  await page.route('**/rest/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname.replace('/rest/v1', '');
    const send = (data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (p.includes('realtime')) return route.abort();
    if (p === '/auth/me') return send(identity);
    if (p === '/auth/config') return send({ authProviders: { password: true } });
    if (p === '/manager-workspaces/me') return send({ id: 'w-1', name: 'Issac', status: 'active', subdomain: 'issac', schemaStatus: 'READY', onboardingCompletedAt: '2026-10-01T00:00:00Z' });
    if (p === '/leadership/capabilities') return send({ 'staff.view': true, leadership: { canCreateOrganisation: false, initialManagerScope: 'own' } });
    if (p === '/profile') return send({ ...identity, avatarKey: null });
    if (p === '/profile/preferences') return send({ theme: 'light' });
    if (p === '/notifications/unread-count') return send({ count: 0 });
    if (p === '/dashboard/summary') return send({ staffCount: 5, managerCount: 2, activeOfferCount: 3, venueCount: 1 });
    if (p === '/staff') return send({ data: [1, 2, 3, 4, 5].map(staff), total: 5 });
    if (/^\/staff\/staff-\d+$/.test(p)) return send(staff(Number(p.split('-').pop())));
    if (p === '/job-roles') return send([{ id: 'jr-1', name: 'Waiter', defaultRatePence: 1250 }]);
    if (p === '/shifts/shift-1/pipeline') { state.calls++; return send(state.pipeline); }
    return send({ data: [], total: 0 });
  });
  return state;
}

/** Sample `fn(el)` for every animation frame for `ms`, starting now; read back with `readSamples`. */
async function startSampling(page: Page, selector: string, expr: string, ms = 900) {
  await page.evaluate(([sel, ex, dur]) => {
    const w = window as unknown as { __samples: Array<[number, number | null]> };
    w.__samples = [];
    const fn = new Function('el', `return (${ex});`) as (el: Element) => number;
    const t0 = performance.now();
    const tick = () => {
      const el = document.querySelector(sel as string);
      w.__samples.push([performance.now() - t0, el ? fn(el) : null]);
      if (performance.now() - t0 < (dur as number)) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [selector, expr, ms] as const);
}
const readSamples = (page: Page) => page.evaluate(() => (window as unknown as { __samples: Array<[number, number | null]> }).__samples);
/** Time from the first change until the value stops changing (within eps), in ms. */
function settleTime(samples: Array<[number, number | null]>, eps = 0.5) {
  const vals = samples.filter((s) => s[1] != null) as Array<[number, number]>;
  const start = vals.find((s) => Math.abs(s[1] - vals[0][1]) > eps);
  const final = vals[vals.length - 1][1];
  const end = [...vals].reverse().find((s) => Math.abs(s[1] - final) > eps);
  return { start: start?.[0] ?? null, end: end?.[0] ?? null, duration: start && end ? end[0] - start[0] : 0, distinct: new Set(vals.map((v) => Math.round(v[1]))).size, final };
}

test('sidebar: the selected highlight slides from Dashboard to Users while the route changes immediately', async ({ page }) => {
  await fixtures(page);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const pill = '.nav-active-pill';
  await expect(page.locator(pill)).toHaveCount(1);
  const before = await page.locator(pill).boundingBox();
  await startSampling(page, pill, 'el.getBoundingClientRect().top', 900);
  await page.getByRole('link', { name: 'Users' }).click();
  await expect(page).toHaveURL(/\/users$/, { timeout: 300 }); // navigation is not delayed by the animation
  await page.waitForTimeout(950);
  const t = settleTime(await readSamples(page));
  const after = await page.locator(pill).boundingBox();
  console.log('sidebar pill', JSON.stringify({ from: before?.y, to: after?.y, ...t }));
  expect(after!.y).toBeGreaterThan(before!.y); // moved down to Users
  expect(t.distinct).toBeGreaterThan(5); // travelled through intermediate positions (not a jump)
  expect(t.duration).toBeGreaterThan(120);
  expect(t.duration).toBeLessThan(700);
  await page.screenshot({ path: path.join(OUT, 'sidebar-users.png'), clip: { x: 0, y: 0, width: 240, height: 420 } });
});

test('dashboard: cards enter with a short stagger; widgets follow; nothing replays on re-render', async ({ page }) => {
  await fixtures(page);
  await page.goto('/users');
  await page.waitForLoadState('networkidle');
  await startSampling(page, '.dash-grid > .dash-card:nth-child(4)', 'Number(getComputedStyle(el).opacity)', 900);
  const t0 = Date.now();
  await page.getByRole('link', { name: 'Dashboard' }).click();
  await page.waitForTimeout(950);
  const s = (await readSamples(page)).filter((x) => x[1] != null) as Array<[number, number]>;
  const firstVisible = s.find((x) => x[1] > 0.05)?.[0];
  const full = s.find((x) => x[1] > 0.99)?.[0];
  console.log('card #4 opacity', JSON.stringify({ firstVisible, full, sinceClick: Date.now() - t0 }));
  expect(full! - firstVisible!).toBeGreaterThan(150); // a real fade, not a pop
  expect(full!).toBeLessThan(900);
  await expect(page.locator('.dash-counts')).toContainText('5'); // staffCount from /dashboard/summary (real fixture value)
  await page.screenshot({ path: path.join(OUT, 'dashboard.png') });
});

test('drawer: opens ~300ms, switching staff keeps it open and cross-fades the content, closes ~220ms', async ({ page }) => {
  await fixtures(page);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await startSampling(page, '.side-panel-dock', 'el.getBoundingClientRect().width', 900);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('open-user-detail', { detail: { id: 'staff-1', type: 'staff' } })));
  await page.waitForTimeout(950);
  const open = settleTime(await readSamples(page));
  console.log('drawer open', JSON.stringify(open));
  expect(open.final).toBeGreaterThan(400);
  expect(open.end! - 0).toBeGreaterThan(220);
  expect(open.end!).toBeLessThan(450);
  await expect(page.getByText('Staff Test 1').first()).toBeVisible();
  await page.screenshot({ path: path.join(OUT, 'drawer-open.png') });

  // Another staff member while open: the dock never closes (width stays put), the record changes.
  await startSampling(page, '.side-panel-dock', 'el.getBoundingClientRect().width', 600);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('open-user-detail', { detail: { id: 'staff-2', type: 'staff' } })));
  await page.waitForTimeout(650);
  const widths = (await readSamples(page)).map((s) => s[1]).filter((v): v is number => v != null);
  console.log('drawer switch width range', Math.min(...widths), Math.max(...widths));
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(1);
  await expect(page.locator('.drawer-title')).toHaveText('Staff Test 2');

  // Tabs: the underline travels between tabs.
  await startSampling(page, '.detail-tabs-compact .tab-underline', 'el.getBoundingClientRect().left', 700);
  await page.getByRole('tab', { name: /Email/ }).click();
  await page.waitForTimeout(750);
  const tab = settleTime(await readSamples(page));
  console.log('tab underline', JSON.stringify(tab));
  expect(tab.distinct).toBeGreaterThan(4);
  expect(tab.duration).toBeLessThan(600);

  // "+2 More" menu: fades in from its trigger.
  await page.getByRole('button', { name: /2 More/ }).click();
  await startSampling(page, '.detail-tab-more-menu', 'Number(getComputedStyle(el).opacity)', 400);
  await page.waitForTimeout(450);
  const menu = (await readSamples(page)).filter((x) => x[1] != null) as Array<[number, number]>;
  console.log('menu opacity first/last', menu[0]?.[1], menu[menu.length - 1]?.[1]);
  expect(menu[menu.length - 1][1]).toBeGreaterThan(0.99);
  await page.screenshot({ path: path.join(OUT, 'drawer-more-menu.png') });
  await page.keyboard.press('Escape');

  // Close.
  await startSampling(page, '.side-panel-dock', 'el.getBoundingClientRect().width', 700);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.waitForTimeout(750);
  const close = (await readSamples(page)) as Array<[number, number | null]>;
  const gone = close.find((s) => s[1] == null || s[1] < 2)?.[0];
  console.log('drawer close ms', gone);
  expect(gone!).toBeGreaterThan(120);
  expect(gone!).toBeLessThan(400);
});

test('pipeline: a real stage change moves the card (never two copies); header and Timesheet button stay put', async ({ page }) => {
  const state = await fixtures(page);
  await page.goto('/venue-offers/shift-1');
  const button = page.getByRole('button', { name: 'Timesheet report' });
  await expect(button).toBeVisible();
  await expect(page.locator('.pipeline-column[data-stage="CONFIRMED"] .pipeline-card')).toHaveCount(6);
  const headerBefore = await button.boundingBox();
  state.pipeline = board((i) => (i <= 2 ? 'CLOCKED IN' : 'CONFIRMED'));
  await expect(page.locator('.pipeline-column[data-stage="CLOCKED IN"] .pipeline-card')).toHaveCount(2, { timeout: 12_000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'pipeline-after-stage-change.png') });
  for (const id of ['offer-1', 'offer-2']) await expect(page.locator(`[data-offer-id="${id}"]`)).toHaveCount(1);
  await expect(page.locator('.pipeline-column[data-stage="CONFIRMED"] .pipeline-card')).toHaveCount(4);
  await expect(page.locator('.pipeline-column[data-stage="CLOCKED IN"] h2 .pipeline-count')).toHaveText('2');
  expect(await button.boundingBox()).toEqual(headerBefore);
});

test('calendar: next month slides in from the right, previous from the left', async ({ page }) => {
  await fixtures(page);
  await page.goto('/calendar');
  await page.locator('.calendar-grid').waitFor();
  await startSampling(page, '.calendar-grid', 'new DOMMatrixReadOnly(getComputedStyle(el).transform).m41', 700);
  await page.getByRole('button', { name: 'Next month' }).click();
  await page.waitForTimeout(750);
  const next = (await readSamples(page)).map((s) => s[1]).filter((v): v is number => v != null);
  await startSampling(page, '.calendar-grid', 'new DOMMatrixReadOnly(getComputedStyle(el).transform).m41', 700);
  await page.getByRole('button', { name: 'Previous month' }).click();
  await page.waitForTimeout(750);
  const prev = (await readSamples(page)).map((s) => s[1]).filter((v): v is number => v != null);
  console.log('calendar x next max/min', Math.max(...next), Math.min(...next), 'prev', Math.max(...prev), Math.min(...prev));
  expect(Math.max(...next)).toBeGreaterThan(4); // new month entered from +x
  expect(Math.min(...prev)).toBeLessThan(-4); // previous month entered from -x
  await page.screenshot({ path: path.join(OUT, 'calendar.png') });
});

test.describe('reduced motion', () => {
  test('drawer opens without sliding, tabs/menus work, and toasts stay for their full time', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' }); // the OS "reduce motion" setting
    await fixtures(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    console.log('reduced matchMedia =', await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), 'docks =', await page.locator('.side-panel-dock').count());
    await startSampling(page, '.side-panel-dock', 'el.getBoundingClientRect().width', 500);
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('open-user-detail', { detail: { id: 'staff-1', type: 'staff' } })));
    await page.waitForTimeout(550);
    const widths = (await readSamples(page)).map((s) => s[1]).filter((v): v is number => v != null);
    console.log('reduced drawer distinct widths', new Set(widths.map(Math.round)).size, JSON.stringify((await readSamples(page)).slice(0, 14).map((s) => [Math.round(s[0]), s[1] == null ? null : Math.round(s[1])])));
    expect(new Set(widths.map(Math.round)).size).toBeLessThanOrEqual(2); // appears at full width, no slide
    await page.getByRole('tab', { name: /Timeline/ }).click();
    await expect(page.getByRole('tab', { name: /Timeline/ })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: /2 More/ }).click();
    await page.getByRole('menuitem', { name: /Staff reviews/ }).click();
    await expect(page.getByRole('tab', { name: /Staff reviews/ })).toHaveAttribute('aria-selected', 'true');
    // Toast: dismissed by its (held) progress timer, not instantly.
    await page.goto('/venue-offers/shift-1');
    await page.getByRole('button', { name: 'Timesheet report' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Timesheet is not ready yet' })).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(page.getByRole('alert').filter({ hasText: 'Timesheet is not ready yet' })).toBeVisible();
  });
});
