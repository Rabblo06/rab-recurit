import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';

/**
 * Master fix 2026-10-18 — Venue Offers pipeline (12 lanes, stable header), compact detail-panel tabs, Staff Reviews.
 * Real React app, router, CSS and Chromium layout; every /rest/v1 response is a deterministic fixture shaped exactly like
 * the server contract (venue-offer-pipeline.service.ts, staff-review-insights.service.ts). Not an end-to-end run:
 * the data contract itself is proven by the server integration suites. Run with playwright.isolated.config.ts.
 */
const SHOTS = path.resolve(__dirname, '.qa-shots/master-fix-2026-10-18');
const identity = {
  id: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222',
  organisationId: '33333333-3333-4333-8333-333333333333', firstName: 'Issac', lastName: 'Nepolean',
  email: 'manager@example.test', roles: ['manager'], isPlatformAdmin: false, mustResetPassword: false,
  applicationTarget: 'manager_web', sessionExpiresAt: '2099-01-01T00:00:00Z',
};
const STAGES = ['OFFERED', 'WAITING', 'STAFF ACCEPTED', 'CONFIRMED', 'LATE STAFF', 'CLOCKED IN', 'PENDING REVIEW', 'CLOCKED OUT', 'NO SHOW', 'REJECTED', 'CANCELLED', 'DELETED OFFER'];
const KEY: Record<string, string> = {
  OFFERED: 'offered', WAITING: 'waiting', 'STAFF ACCEPTED': 'accepted', CONFIRMED: 'confirmed', 'LATE STAFF': 'late', 'CLOCKED IN': 'clockedIn',
  'PENDING REVIEW': 'pendingReview', 'CLOCKED OUT': 'clockedOut', 'NO SHOW': 'noShow', REJECTED: 'rejected', CANCELLED: 'cancelled', 'DELETED OFFER': 'deleted',
};
const START = '2026-10-16T15:15:00Z', END = '2026-10-16T22:15:00Z';

function card(i: number, stage: string) {
  const working = ['CLOCKED IN', 'PENDING REVIEW', 'CLOCKED OUT'].includes(stage);
  const out = ['CLOCKED OUT'].includes(stage) || (stage === 'PENDING REVIEW' && i % 2 === 0);
  return {
    staffProfileId: `staff-${i}`, name: `Staff Test ${i}`, avatarFileId: null, offerId: `offer-${i}`, stage,
    offerStatus: stage === 'REJECTED' ? 'declined' : stage === 'DELETED OFFER' ? 'expired' : ['OFFERED', 'WAITING'].includes(stage) ? 'pending' : 'manager_confirmed',
    assignmentStatus: stage === 'NO SHOW' ? 'no_show' : stage === 'CANCELLED' ? 'cancelled' : stage === 'STAFF ACCEPTED' ? 'staff_accepted' : ['OFFERED', 'WAITING'].includes(stage) ? 'offered' : 'confirmed',
    attendanceStatus: stage === 'PENDING REVIEW' ? (out ? 'under_review' : 'missing_clock_out') : stage === 'CLOCKED IN' ? 'clocked_in' : stage === 'CLOCKED OUT' ? 'clocked_out' : null,
    sentAt: '2026-10-15T09:00:00Z', acceptedAt: '2026-10-15T10:00:00Z', respondedAt: '2026-10-15T11:00:00Z', cancelledAt: null,
    terminalSource: stage === 'REJECTED' ? 'Declined by staff' : stage === 'CANCELLED' ? 'Booking cancelled' : stage === 'DELETED OFFER' ? 'Offer expired' : null,
    clockInAt: working ? '2026-10-16T15:03:00Z' : null, clockOutAt: out ? '2026-10-16T22:15:00Z' : null,
    breakMinutes: out ? 30 : null, workedMinutes: out ? 402 : null, declineReason: stage === 'REJECTED' ? 'Unavailable that evening' : null,
    withdrawnReason: null, rejectionReason: null, canManagerCancel: false, attendanceReviewed: stage === 'CLOCKED OUT' && i % 2 === 0, earlierOffers: 0,
  };
}
function board(extraClockedIn = 0) {
  const plan: Array<[string, number]> = [['OFFERED', 2], ['WAITING', 1], ['STAFF ACCEPTED', 1], ['CONFIRMED', 2], ['LATE STAFF', 1], ['CLOCKED IN', 9 + extraClockedIn],
    ['PENDING REVIEW', 2], ['CLOCKED OUT', 3], ['NO SHOW', 1], ['REJECTED', 1], ['CANCELLED', 1], ['DELETED OFFER', 1]];
  let i = 0;
  const staff = plan.flatMap(([stage, n]) => Array.from({ length: n }, () => card(++i, stage)));
  const counts = Object.fromEntries(STAGES.map((s) => [s, staff.filter((c) => c.stage === s).length]));
  const filled = staff.filter((c) => ['confirmed', 'completed'].includes(c.assignmentStatus)).length;
  return {
    shift: { id: 'shift-1', venueName: 'Venue Test 3', roleName: 'Test Role 3', startsAt: START, endsAt: END, status: 'fully_filled', requiredCount: filled },
    serverNow: '2026-10-16T19:00:00Z', tableStatus: 'Fully filled',
    summary: { required: filled, filled, open: 0, ...Object.fromEntries(STAGES.map((s) => [KEY[s], counts[s]])) },
    stageCounts: counts, stages: STAGES, staff,
    report: { ready: false, originalFileId: null, signedFileId: null, reportStatus: 'pending', finalisedByName: null, finalisedAt: null, staff: [] },
    replacementPlaces: 0,
  };
}

const staffRecord = {
  id: 'staff-15', staffRef: 'STAFF 5', email: 'stafftest15@example.test', firstName: 'Issac', lastName: 'Nepolean', phone: null,
  dateOfBirth: null, avatarKey: null, employmentStatus: 'active', startDate: null, defaultPayRatePence: 0, createdAt: '2026-10-01T00:00:00Z',
  createdByName: null, accountStatus: 'active', invitationStatus: null, mustResetPassword: false, pendingInvite: null, emergencyContactName: null,
  emergencyContactRelationship: null, emergencyContactPhone: null, jobRoleId: 'jr-1', preferredName: null, employmentType: null, address: null,
  city: null, postcode: null,
};
const venueManager = {
  id: 'vm-1', email: 'sarah@example.test', firstName: 'Sarah', lastName: 'Mitchell', phone: null, type: 'venue', jobTitle: null, avatarKey: null,
  createdAt: '2026-10-01T00:00:00Z', accountStatus: 'active', invitationStatus: null, mustResetPassword: false, pendingInvite: null,
  venues: [{ id: 'v-1', name: 'The Savoy' }],
};
const review = (id: string, who: 'sarah' | 'james', day: string, score: number, feedback: string | null) => ({
  id, shiftId: `s-${id}`, reviewerUserId: who, reviewerName: who === 'sarah' ? 'Sarah Mitchell' : 'James Wilson',
  venueName: who === 'sarah' ? 'The Savoy' : "Claridge's", roleName: 'Waiter', startsAt: `${day}T17:00:00Z`, endsAt: `${day}T22:30:00Z`,
  score, feedback, submittedAt: `${day}T23:10:00Z`, updatedAt: `${day}T23:10:00Z`,
});
const reviewers = [
  { userId: 'sarah', name: 'Sarah Mitchell', venues: ['The Savoy'], reviews: 6 },
  { userId: 'james', name: 'James Wilson', venues: ["Claridge's"], reviews: 4 },
  { userId: 'alex', name: 'Alex Morgan', venues: ['The Dorchester'], reviews: 0 },
];
const dist = (c: number[]) => {
  const total = c.reduce((a, b) => a + b, 0);
  return [5, 4, 3, 2, 1].map((stars, i) => ({ stars, count: c[i], percent: total ? Math.round((c[i] / total) * 100) : 0 }));
};
const allReviews = {
  staff: { id: 'staff-15', name: 'Issac Nepolean', roleName: 'Waiter' }, filters: { reviewer: null, range: 'all', from: null, to: null }, reviewers,
  total: 10, reviewerCount: 2, average: 4.5, distribution: dist([6, 3, 1, 0, 0]),
  categories: { grooming: 4.6, attitude: 4.5, skills: 4.4, attendance: 4.8, timeKeeping: 4.2 },
  history: [
    review('r1', 'sarah', '2026-10-17', 4.6, 'Professional and helpful with the team. Ready for service on arrival.'),
    review('r2', 'james', '2026-10-15', 4.4, 'Professional and helpful with the team. Ready for service on arrival.'),
    review('r3', 'sarah', '2026-10-11', 4.8, null),
  ],
};
const sarahReviews = {
  ...allReviews, filters: { ...allReviews.filters, reviewer: 'sarah' }, total: 6, reviewerCount: 1, average: 4.7, distribution: dist([4, 2, 0, 0, 0]),
  categories: { grooming: 4.8, attitude: 4.7, skills: 4.5, attendance: 4.8, timeKeeping: 4.5 }, history: [allReviews.history[0], allReviews.history[2]],
};
const reviewDetail = {
  id: 'r1', staff: { id: 'staff-15', name: 'Issac Nepolean' }, shiftId: 's-r1', venueName: 'The Savoy', roleName: 'Waiter',
  startsAt: '2026-10-17T17:00:00Z', endsAt: '2026-10-17T22:30:00Z', reviewer: { userId: 'sarah', name: 'Sarah Mitchell', role: 'Venue manager' },
  submittedAt: '2026-10-17T23:10:00Z', updatedAt: '2026-10-17T23:10:00Z', score: 4.6,
  ratings: { grooming: 5, attitude: 5, skills: 4, attendance: 5, timeKeeping: 4 },
  feedback: 'Professional and helpful with the team. Ready for service on arrival. Continue building confidence with silver service.',
};

/** The detail drawer slides in (a finite transition; the app also has endless spinners, so don't wait on all). */
async function settled(page: Page) {
  await page.waitForTimeout(700);
}

async function fixtures(page: Page, opts: { theme?: 'light' | 'dark' } = {}) {
  const state = { pipeline: board(), calls: [] as string[] };
  await page.route('**/rest/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname.replace('/rest/v1', '');
    state.calls.push(`${p}${url.search}`);
    const send = (data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (p.includes('realtime')) return route.abort();
    if (p === '/auth/me') return send(identity);
    if (p === '/auth/config') return send({ authProviders: { password: true } });
    if (p === '/manager-workspaces/me') return send({ id: 'w-1', name: 'Issac', status: 'active', subdomain: 'issac', schemaStatus: 'READY', onboardingCompletedAt: '2026-10-01T00:00:00Z' });
    if (p === '/leadership/capabilities') return send({ 'staff.view': true, leadership: { canCreateOrganisation: false, initialManagerScope: 'own' } });
    if (p === '/profile') return send({ ...identity, avatarKey: null });
    if (p === '/profile/preferences') return send({ theme: opts.theme ?? 'light' });
    if (p === '/notifications/unread-count') return send({ count: 0 });
    if (p === '/job-roles') return send([{ id: 'jr-1', name: 'Waiter', defaultRatePence: 1250 }]);
    if (p === '/shifts/shift-1/pipeline') return send(state.pipeline);
    if (p === '/staff/staff-15') return send(staffRecord);
    if (p === '/staff/staff-15/reviews/r1') return send(reviewDetail);
    if (p === '/staff/staff-15/reviews') return send(url.searchParams.get('reviewer') === 'sarah' ? sarahReviews : allReviews);
    if (p === '/venue-managers/vm-1') return send(venueManager);
    if (p === '/venue-managers/vm-1/staff') return send({ data: [], total: 0 });
    return send({ data: [], total: 0 });
  });
  return state;
}

/**
 * b57c5180 (2026-10-22) split the single 12-lane board into Staffing | Attendance | Closed tabs over the agreed stage
 * contract (VenueOfferPipelineStages.ts): the server's stage spellings are normalised to snake_case lane keys, and the
 * contract adds two lanes this fixture leaves empty (Checked in, Attendance missing). The "Staff by stage" lane counter
 * strip was replaced by the tab counters; the tab strip is the sticky header row the old summary used to be.
 */
const LANE: Record<string, string> = {
  OFFERED: 'offered', WAITING: 'waiting', 'STAFF ACCEPTED': 'staff_accepted', CONFIRMED: 'confirmed', 'LATE STAFF': 'late',
  'CLOCKED IN': 'clocked_in', 'PENDING REVIEW': 'pending_review', 'CLOCKED OUT': 'clocked_out', 'NO SHOW': 'no_show',
  REJECTED: 'rejected', CANCELLED: 'cancelled', 'DELETED OFFER': 'deleted',
};
const TAB_LANES: Record<'Staffing' | 'Attendance' | 'Closed', string[]> = {
  Staffing: ['offered', 'waiting', 'staff_accepted', 'confirmed'],
  Attendance: ['late', 'checked_in', 'clocked_in', 'pending_review', 'clocked_out', 'attendance_missing', 'no_show'],
  Closed: ['rejected', 'cancelled', 'deleted'],
};

test.describe('Venue Offers pipeline', () => {
  for (const vp of [{ w: 1690, h: 935 }, { w: 1366, h: 768 }]) {
    test(`twelve server stages across the Staffing/Attendance/Closed tabs; header + Timesheet report stay put through board, column and page scrolling and a poll (${vp.w})`, async ({ page }) => {
      test.setTimeout(60_000);
      await page.setViewportSize({ width: vp.w, height: vp.h });
      const state = await fixtures(page);
      await page.goto('/venue-offers/shift-1');
      const button = page.getByRole('button', { name: 'Timesheet report' });
      await expect(button).toBeVisible();
      // Actions live in the shell top bar, not the page; since b57c5180 the venue name is the page's own heading and the
      // top-bar breadcrumb suffix (the page no longer portals a title into the top bar).
      await expect(page.locator('[data-page-actions-slot]').getByRole('button', { name: 'Timesheet report' })).toBeVisible();
      await expect(page.locator('[data-breadcrumb-suffix-slot]')).toHaveText('/Venue Test 3');
      await expect(page.locator('.pipeline-head h1')).toHaveText('Venue Test 3');
      await expect(page.locator('[data-page-title-slot]')).toBeEmpty();
      await expect(page.locator('.pipeline .pipeline-inline-actions')).toHaveCount(0);
      const tabs = page.getByRole('tablist', { name: 'Pipeline stages' });
      // The shift has started and people are on site, so the board opens on Attendance.
      await expect(tabs.getByRole('tab', { name: /^Attendance/ })).toHaveAttribute('aria-selected', 'true');

      // Every one of the twelve server stages has its lane, in its tab, and every lane and tab counter equals its cards.
      const seen = new Set<string>();
      for (const [label, lanes] of Object.entries(TAB_LANES)) {
        await tabs.getByRole('tab', { name: new RegExp(`^${label}`) }).click();
        await expect(tabs.getByRole('tab', { name: new RegExp(`^${label}`) })).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('.pipeline-column')).toHaveCount(lanes.length);
        expect(await page.locator('.pipeline-column').evaluateAll((els) => els.map((el) => el.getAttribute('data-stage')))).toEqual(lanes);
        let inTab = 0;
        for (const lane of lanes) {
          const cards = await page.locator(`.pipeline-column[data-stage="${lane}"] .pipeline-card`).count();
          await expect(page.locator(`.pipeline-column[data-stage="${lane}"] h2 .pipeline-count`)).toHaveText(String(cards));
          inTab += cards;
          seen.add(lane);
        }
        await expect(tabs.getByRole('tab', { name: new RegExp(`^${label}`) }).locator('.pipeline-count')).toHaveText(String(inTab));
      }
      expect(STAGES.map((stage) => LANE[stage]).filter((lane) => !seen.has(lane))).toEqual([]);
      await tabs.getByRole('tab', { name: /^Attendance/ }).click();
      await expect(page.locator('.pipeline-column[data-stage="clocked_in"] .pipeline-card')).toHaveCount(9);
      await page.screenshot({ path: path.join(SHOTS, `pipeline-${vp.w}-initial.png`) });
      const before = await button.boundingBox();
      const headBefore = await page.locator('.pipeline-head').boundingBox();
      const toolbarBefore = await page.locator('.pipeline-toolbar').boundingBox();

      // 1. Long column scrolls internally; 2. board scrolls horizontally; 3. wheel over the page does not move the header.
      const clockedIn = page.locator('.pipeline-column[data-stage="clocked_in"] .pipeline-column-body');
      await clockedIn.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await page.locator('.pipeline-board').evaluate((el) => { el.scrollLeft = el.scrollWidth; });
      await page.mouse.move(vp.w / 2, vp.h / 2);
      await page.mouse.wheel(0, 3000);
      // 4. A poll adds cards to the long column (5 s interval).
      state.pipeline = board(8);
      await expect(page.locator('.pipeline-column[data-stage="clocked_in"] .pipeline-card')).toHaveCount(17, { timeout: 12_000 });
      await expect(page.locator('.pipeline-column[data-stage="clocked_in"] h2 .pipeline-count')).toHaveText('17');
      await page.screenshot({ path: path.join(SHOTS, `pipeline-${vp.w}-after-scroll-and-poll.png`) });

      expect(await button.boundingBox()).toEqual(before);
      expect(await page.locator('.pipeline-head').boundingBox()).toEqual(headBefore);
      expect(await page.locator('.pipeline-toolbar').boundingBox()).toEqual(toolbarBefore);
      expect(await page.evaluate(() => ({ doc: document.scrollingElement!.scrollTop, page: document.querySelector('.pipeline')!.scrollTop }))).toEqual({ doc: 0, page: 0 });
      expect(await clockedIn.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
      expect(await page.locator('.pipeline-board').evaluate((el) => el.scrollLeft > 0)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      // A tab counter takes the board to its lanes (keyboard, like the tablist it is), without moving the header.
      await tabs.getByRole('tab', { name: /^Attendance/ }).press('ArrowRight');
      await expect(tabs.getByRole('tab', { name: /^Closed/ })).toBeFocused();
      await expect(tabs.getByRole('tab', { name: /^Closed/ })).toHaveAttribute('aria-selected', 'true');
      await expect(page).toHaveURL(/[?&]tab=closed/);
      expect(await page.locator('.pipeline-column').evaluateAll((els) => els.map((el) => el.getAttribute('data-stage')))).toEqual(TAB_LANES.Closed);
      expect(await button.boundingBox()).toEqual(before);
    });
  }
});

test.describe('Detail panels', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('Venue Manager panel: Overview / Timeline / Email + "+2 More" → Notes, Assigned staff; keyboard and Escape', async ({ page }) => {
    await fixtures(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('open-user-detail', { detail: { id: 'vm-1', type: 'venueManager' } })));
    const more = page.getByRole('button', { name: /2 More/ });
    await expect(more).toBeVisible();
    await more.click();
    await expect(page.getByRole('menuitem', { name: /Notes/ })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /Assigned staff/ })).toBeVisible();
    await settled(page);
    await page.screenshot({ path: path.join(SHOTS, 'vm-panel-more-menu.png') });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toBeHidden();
    await expect(more).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('tab', { name: /Assigned staff/ })).toHaveAttribute('aria-selected', 'true');
    await page.screenshot({ path: path.join(SHOTS, 'vm-panel-assigned-staff.png') });
  });

  test('Staff panel: "+2 More" → Notes, Staff reviews; overview, Venue Manager filter, shift review', async ({ page }) => {
    const state = await fixtures(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('open-user-detail', { detail: { id: 'staff-15', type: 'staff' } })));
    const more = page.getByRole('button', { name: /2 More/ });
    await more.click();
    await expect(page.getByRole('menuitem', { name: /Notes/ })).toBeVisible();
    await settled(page);
    await page.screenshot({ path: path.join(SHOTS, 'staff-panel-more-menu.png') });
    await page.getByRole('menuitem', { name: /Staff reviews/ }).click();
    await expect(page.getByRole('tab', { name: /Staff reviews/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('10 reviews · 2 managers')).toBeVisible();
    // Narrow drawer: the strip must not overflow its container.
    expect(await page.locator('.detail-tabs-compact').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    const panel = page.locator('.detail-panel-body');
    await panel.screenshot({ path: path.join(SHOTS, 'staff-reviews-overview.png') });

    // Chart tooltip on hover of the 5-star segment.
    await page.getByRole('row', { name: /5 stars/ }).hover();
    await expect(page.getByRole('tooltip')).toContainText('5 stars: 6 reviews (60%)');
    await page.locator('.sr-donut-wrap').screenshot({ path: path.join(SHOTS, 'staff-reviews-donut-tooltip.png') });
    // Palette: navy for 5 stars, never the walnut brown.
    const fiveStar = await page.locator('.sr-arc.sr-star-5').evaluate((el) => getComputedStyle(el).stroke);
    expect(fiveStar).toBe('rgb(42, 85, 153)');

    // Date range menu: the app's view-menu style, not the browser's native list.
    await page.getByRole('combobox', { name: 'Date range' }).click();
    await expect(page.getByRole('option', { name: 'All time' })).toHaveAttribute('aria-selected', 'true');
    await page.waitForTimeout(250);
    await page.locator('.sr-range').screenshot({ path: path.join(SHOTS, 'staff-reviews-date-range-menu-trigger.png') });
    await page.screenshot({ path: path.join(SHOTS, 'staff-reviews-date-range-menu.png'), clip: { x: 1000, y: 120, width: 440, height: 340 } });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox', { name: 'Date range' })).toBeHidden();

    await page.getByRole('button', { name: /Venue manager: All venue managers/ }).click();
    await expect(page.getByRole('option', { name: /Alex Morgan/ })).toContainText('No reviews');
    await panel.screenshot({ path: path.join(SHOTS, 'staff-reviews-manager-dropdown.png') });
    await page.getByRole('option', { name: /Sarah Mitchell/ }).click();
    await expect(page.getByText('6 reviews · 1 manager')).toBeVisible();
    await expect(page.getByText("Sarah's average scores")).toBeVisible();
    expect(state.calls.some((c) => c === '/staff/staff-15/reviews?reviewer=sarah')).toBe(true);
    await panel.screenshot({ path: path.join(SHOTS, 'staff-reviews-filtered-sarah.png') });

    await page.getByRole('button', { name: /View review by Sarah Mitchell on/ }).first().click();
    await expect(page.getByRole('heading', { name: 'Shift review' })).toBeVisible();
    await expect(page.getByText('Reviewed by Sarah Mitchell')).toBeVisible();
    await panel.screenshot({ path: path.join(SHOTS, 'staff-reviews-shift-review.png') });
  });

  test('Staff reviews chart in dark mode uses the dark-validated palette', async ({ page }) => {
    await fixtures(page, { theme: 'dark' });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('open-user-detail', { detail: { id: 'staff-15', type: 'staff', tab: 'reviews' } })));
    await expect(page.getByText('10 reviews · 2 managers')).toBeVisible();
    expect(await page.locator('.sr-arc.sr-star-5').evaluate((el) => getComputedStyle(el).stroke)).toBe('rgb(89, 142, 209)');
    await settled(page);
    await page.screenshot({ path: path.join(SHOTS, 'staff-reviews-overview-dark-full.png') });
  });
});
