import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import {
  CONFIRMATION_DEADLINE_LABELS,
  CONFIRMATION_DEADLINE_MESSAGES,
  CONFIRMATION_DEADLINE_PASSED,
  OFFER_CLOSED_REASON,
} from '@rab/shared';

/**
 * No automatic confirmation (owner rule 2026-11-06), web console. Real React app, router, CSS and Chromium; every
 * /rest/v1 response is a deterministic fixture shaped like the frozen contract (@rab/shared offer-confirmation.ts):
 * approvalDeadlineAt, awaitingManagerConfirmation, closedReason, canConfirm (manager reads) and the 409
 * CONFIRMATION_DEADLINE_PASSED body. The server's enforcement itself is proven by the server integration suites.
 * Run with playwright.isolated.config.ts.
 */
const SHOTS = path.resolve(__dirname, '.qa-shots/no-autoconfirm-2026-11-06');
const identity = {
  id: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222',
  organisationId: '33333333-3333-4333-8333-333333333333', firstName: 'Test', lastName: 'Manager',
  email: 'manager@example.test', roles: ['manager'], isPlatformAdmin: false, mustResetPassword: false,
  applicationTarget: 'manager_web', sessionExpiresAt: '2099-01-01T00:00:00Z',
};
// Deadlines are the SERVER's instants; the browser runs in Europe/London so the rendered local time is deterministic.
const DEADLINE = '2030-03-01T17:30:00.000Z'; // Fri 1 Mar 2030, 17:30 GMT (start 18:00 − 30 min)
// Chromium's ICU writes winter London time as "GMT" or "GMT+0" depending on its version; both name the zone.
const SHOWN = /Fri 1 Mar, 17:30 GMT(\+0)?$/;
const SUMMER_DEADLINE = '2030-07-01T16:30:00.000Z'; // the same rule in summer time: 17:30 BST
const SUMMER_SHOWN = /Mon 1 Jul, 17:30 BST$/;

const base = {
  sentAt: '2030-02-27T09:00:00.000Z', expiresAt: '2030-03-01T09:00:00.000Z', respondedAt: '2030-02-27T10:00:00.000Z',
  declineReason: null, staffAcceptedAt: '2030-02-27T10:00:00.000Z', managerConfirmedAt: null, managerRejectedAt: null,
  rejectionReason: null, estimatedPayPence: 6000, shiftId: 'shift-1', startsAt: '2030-03-01T18:00:00.000Z',
  endsAt: '2030-03-01T23:00:00.000Z', venueName: 'Venue Test 1', roleName: 'Test Role', staffProfileId: 'sp',
};
const open = { approvalDeadlineAt: DEADLINE, awaitingManagerConfirmation: true, closedReason: null, canConfirm: true };
const closed = { approvalDeadlineAt: DEADLINE, awaitingManagerConfirmation: false, closedReason: OFFER_CLOSED_REASON.CONFIRMATION_DEADLINE_PASSED, canConfirm: false };
const mine = { ...base, ...open, id: 'o-mine', status: 'staff_accepted', staffName: 'Staff Test Mine', offerBatchId: 'b-mine' };
const summer = { ...base, ...open, id: 'o-summer', status: 'staff_accepted', staffName: 'Staff Test Summer', offerBatchId: 'b-summer', approvalDeadlineAt: SUMMER_DEADLINE, startsAt: '2030-07-01T17:00:00.000Z', endsAt: '2030-07-01T22:00:00.000Z' };
const other = { ...base, ...open, canConfirm: false, id: 'o-other', status: 'staff_accepted', staffName: 'Staff Test Other', offerBatchId: 'b-other' };
const late = { ...base, ...closed, id: 'o-late', status: 'staff_accepted', staffName: 'Staff Test Late', offerBatchId: 'b-late' };
const gone = { ...base, ...closed, id: 'o-gone', status: 'manager_rejected', staffName: 'Staff Test Withdrawn', offerBatchId: 'b-gone', rejectionReason: OFFER_CLOSED_REASON.CONFIRMATION_DEADLINE_PASSED, managerRejectedAt: DEADLINE };
// An older API (fields not deployed yet): nothing about the deadline is sent.
const legacy = { ...base, id: 'o-legacy', status: 'staff_accepted', staffName: 'Staff Test Legacy', offerBatchId: 'b-legacy' };

const pipelineCard = (over: Record<string, unknown>) => ({
  staffProfileId: 'p', name: 'Staff Test', avatarFileId: null, offerId: 'po', stage: 'rejected', offerStatus: 'manager_rejected',
  assignmentStatus: 'rejected', attendanceStatus: null, sentAt: '2030-02-27T09:00:00.000Z', acceptedAt: '2030-02-27T10:00:00.000Z',
  respondedAt: DEADLINE, cancelledAt: null, terminalSource: null, clockInAt: null, clockOutAt: null, breakMinutes: null, workedMinutes: null,
  declineReason: null, withdrawnReason: null, rejectionReason: null, canManagerCancel: false, attendanceReviewed: false, earlierOffers: 0, ...over,
});
function pipeline(withFields = true) {
  const staff = [
    pipelineCard({ staffProfileId: 'p1', offerId: 'po1', name: 'Staff Test Accepted', stage: 'staff_accepted', offerStatus: 'staff_accepted', assignmentStatus: 'staff_accepted', respondedAt: null,
      ...(withFields ? { approvalDeadlineAt: DEADLINE, awaitingManagerConfirmation: true, closedReason: null } : {}) }),
    pipelineCard({ staffProfileId: 'p2', offerId: 'po2', name: 'Staff Test Withdrawn', terminalSource: CONFIRMATION_DEADLINE_LABELS.PIPELINE_TERMINAL_SOURCE,
      rejectionReason: OFFER_CLOSED_REASON.CONFIRMATION_DEADLINE_PASSED, ...(withFields ? closed : {}) }),
    pipelineCard({ staffProfileId: 'p3', offerId: 'po3', name: 'Staff Test Declined', offerStatus: 'declined', terminalSource: 'Declined by staff', declineReason: 'Unavailable that evening' }),
  ];
  return {
    shift: { id: 'shift-1', venueName: 'Venue Test 1', roleName: 'Test Role', startsAt: base.startsAt, endsAt: base.endsAt, status: 'partially_filled', requiredCount: 2 },
    serverNow: '2030-03-01T17:45:00.000Z', tableStatus: '1 not confirmed in time',
    summary: { required: 2, filled: 0, open: 2, accepted: 1, rejected: 2, ...(withFields ? { withdrawnAtDeadline: 1 } : {}) },
    stageCounts: { staff_accepted: 1, rejected: 2 },
    stages: ['offered', 'waiting', 'staff_accepted', 'confirmed', 'late', 'checked_in', 'clocked_in', 'pending_review', 'clocked_out', 'attendance_missing', 'no_show', 'rejected', 'cancelled', 'deleted'],
    staff,
    report: { ready: false, originalFileId: null, signedFileId: null, reportStatus: 'pending', finalisedByName: null, finalisedAt: null, staff: [] },
    replacementPlaces: 2,
    replacement: { vacancy: 2, confirmedNoShows: 0, provisionalNoShows: 0, nextOfferKind: 'replacement', canSend: true },
  };
}

interface State { offers: unknown[]; confirm: { status: number; body: unknown }; confirmCalls: string[]; offerLists: number; pipeline: unknown }

async function fixtures(page: Page, offers: unknown[]): Promise<State> {
  const state: State = { offers, confirm: { status: 200, body: {} }, confirmCalls: [], offerLists: 0, pipeline: pipeline() };
  await page.route('**/rest/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname.replace('/rest/v1', '');
    const send = (data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (p.includes('realtime')) return route.abort();
    if (p === '/auth/me') return send(identity);
    if (p === '/auth/config') return send({ authProviders: { password: true } });
    if (p === '/auth/capabilities') return send({ 'offer.send': true, 'offer.confirm': true });
    if (p === '/manager-workspaces/me') return send({ id: 'w-1', name: 'Test', status: 'active', subdomain: 'test', schemaStatus: 'READY', onboardingCompletedAt: '2026-10-01T00:00:00Z' });
    if (p === '/leadership/capabilities') return send({ 'staff.view': true, leadership: { canCreateOrganisation: false, initialManagerScope: 'own' } });
    if (p === '/profile') return send({ ...identity, avatarKey: null });
    if (p === '/profile/preferences') return send({ theme: 'light' });
    if (p === '/notifications/unread-count') return send({ count: 0 });
    if (p === '/offers') {
      state.offerLists += 1;
      const status = url.searchParams.get('status');
      const rows = (state.offers as Array<{ status: string }>).filter((o) => !status || o.status === status);
      return send({ data: rows, total: rows.length });
    }
    const confirm = p.match(/^\/offers\/([^/]+)\/confirm$/);
    if (confirm && route.request().method() === 'POST') {
      state.confirmCalls.push(confirm[1]!);
      return send(state.confirm.body, state.confirm.status);
    }
    if (p === '/shifts/shift-1/pipeline') return send(state.pipeline);
    return send({ data: [], total: 0 });
  });
  return state;
}

const row = (page: Page, name: string) => page.locator('tr', { hasText: name });

test.use({ viewport: { width: 1440, height: 900 }, timezoneId: 'Europe/London', locale: 'en-GB' });

test.describe('Staff Offers: manager-confirmation deadline', () => {
  test('the server deadline is shown in local time with its zone (GMT and BST), and Confirm opens with it', async ({ page }) => {
    await fixtures(page, [mine, summer, legacy]);
    await page.goto('/offers');
    await expect(row(page, 'Staff Test Mine').locator('.offer-confirm-by')).toHaveText(new RegExp(`^Confirm by ${SHOWN.source}`));
    await expect(row(page, 'Staff Test Summer').locator('.offer-confirm-by')).toHaveText(new RegExp(`^Confirm by ${SUMMER_SHOWN.source}`));
    await page.screenshot({ path: path.join(SHOTS, 'offers-deadline.png') });
    await row(page, 'Staff Test Mine').getByTitle('Confirm shift').click();
    await expect(page.getByText('Confirm shift?')).toBeVisible();
    await expect(page.locator('.offer-confirm-deadline strong')).toHaveText(SHOWN);
    await expect(page.locator('.offer-confirm-deadline')).toContainText('never confirmed automatically');
    await expect(page.getByText(/will be confirmed automatically/i)).toHaveCount(0);
    await page.waitForTimeout(500); // the drawer's slide-in, for the screenshot only
    await page.screenshot({ path: path.join(SHOTS, 'confirm-drawer-deadline.png') });
  });

  test('Confirm is not offered past the deadline or for another manager\'s offer; withdrawals read "Not confirmed in time"', async ({ page }) => {
    await fixtures(page, [mine, other, late, gone]);
    await page.goto('/offers');
    await expect(row(page, 'Staff Test Mine').getByTitle('Confirm shift')).toBeVisible();
    for (const name of ['Staff Test Other', 'Staff Test Late', 'Staff Test Withdrawn']) {
      await expect(row(page, name).getByTitle('Confirm shift')).toHaveCount(0);
      await expect(row(page, name).getByTitle('Reject')).toHaveCount(0);
    }
    for (const name of ['Staff Test Late', 'Staff Test Withdrawn']) {
      await expect(row(page, name).getByText(CONFIRMATION_DEADLINE_LABELS.MANAGER_STATE)).toBeVisible();
      await expect(row(page, name).getByText(CONFIRMATION_DEADLINE_LABELS.CONSOLE_DETAIL)).toBeVisible();
      await expect(row(page, name).getByText(/^Confirm by/)).toHaveCount(0);
    }
    await expect(page.getByText(OFFER_CLOSED_REASON.CONFIRMATION_DEADLINE_PASSED)).toHaveCount(0);
    await page.screenshot({ path: path.join(SHOTS, 'offers-withdrawn.png') });

    // Confirm All on the accepted view counts only what can still be confirmed.
    await page.goto('/offers?status=staff_accepted');
    await expect(page.getByRole('button', { name: 'Confirm All Accepted (1)' })).toBeVisible();
  });

  test('a 409 CONFIRMATION_DEADLINE_PASSED from the server closes the drawer, shows its message and refreshes to the withdrawal', async ({ page }) => {
    const state = await fixtures(page, [mine]);
    state.confirm = { status: 409, body: { statusCode: 409, code: CONFIRMATION_DEADLINE_PASSED, message: CONFIRMATION_DEADLINE_MESSAGES.CONFIRM } };
    await page.goto('/offers');
    await row(page, 'Staff Test Mine').getByTitle('Confirm shift').click();
    await expect(page.getByText('Confirm shift?')).toBeVisible();
    const listsBefore = state.offerLists;
    // The server has withdrawn it lazily on the refused confirm; the next list read says so.
    state.offers = [{ ...mine, ...closed, status: 'manager_rejected', rejectionReason: OFFER_CLOSED_REASON.CONFIRMATION_DEADLINE_PASSED }];
    await page.locator('.side-panel').getByRole('button', { name: 'Confirm shift', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: CONFIRMATION_DEADLINE_MESSAGES.CONFIRM })).toBeVisible();
    await expect(page.getByText('Confirm shift?')).toBeHidden();
    await expect(row(page, 'Staff Test Mine').getByText(CONFIRMATION_DEADLINE_LABELS.MANAGER_STATE)).toBeVisible();
    await expect(row(page, 'Staff Test Mine').getByTitle('Confirm shift')).toHaveCount(0);
    expect(state.confirmCalls).toEqual(['o-mine']);
    expect(state.offerLists).toBeGreaterThan(listsBefore);
    await page.screenshot({ path: path.join(SHOTS, 'confirm-409-handled.png') });
  });

  test('missing fields (backend not deployed yet) are tolerated: today\'s Confirm, no invented deadline', async ({ page }) => {
    const state = await fixtures(page, [legacy]);
    await page.goto('/offers');
    await expect(row(page, 'Staff Test Legacy').getByTitle('Confirm shift')).toBeVisible();
    await expect(row(page, 'Staff Test Legacy').getByText(/^Confirm by/)).toHaveCount(0);
    await row(page, 'Staff Test Legacy').getByTitle('Confirm shift').click();
    await expect(page.getByText('Confirm shift?')).toBeVisible();
    await expect(page.locator('.offer-confirm-deadline')).toHaveCount(0);
    await page.locator('.side-panel').getByRole('button', { name: 'Confirm shift', exact: true }).click();
    await expect.poll(() => state.confirmCalls).toEqual(['o-legacy']);
  });
});

test.describe('Venue Offers pipeline: manager-confirmation deadline', () => {
  test('accepted card shows the deadline; a withdrawal stays in Rejected as "Not confirmed in time"; replacement stays available', async ({ page }) => {
    await fixtures(page, []);
    await page.goto('/venue-offers/shift-1?tab=staffing');
    const accepted = page.locator('.pipeline-column[data-stage="staff_accepted"] .pipeline-card');
    await expect(accepted).toHaveCount(1);
    await expect(accepted.locator('.pipeline-card-state')).toHaveText(new RegExp(`· confirm by ${SHOWN.source}`));
    await expect(page.locator('[data-page-actions-slot]').getByRole('button', { name: /Send offer/ })).toBeEnabled();
    await page.screenshot({ path: path.join(SHOTS, 'pipeline-staffing-deadline.png') });

    await page.getByRole('tab', { name: /^Closed/ }).click();
    const rejected = page.locator('.pipeline-column[data-stage="rejected"]');
    const withdrawn = rejected.locator('.pipeline-card', { hasText: 'Staff Test Withdrawn' });
    await expect(withdrawn.getByText(CONFIRMATION_DEADLINE_LABELS.PIPELINE_TERMINAL_SOURCE)).toBeVisible();
    await expect(withdrawn.locator('.pipeline-tag.is-deadline')).toHaveText(CONFIRMATION_DEADLINE_LABELS.MANAGER_STATE);
    await expect(rejected.getByText(OFFER_CLOSED_REASON.CONFIRMATION_DEADLINE_PASSED)).toHaveCount(0);
    await expect(rejected.locator('.pipeline-lane-note')).toHaveText('1 not confirmed in time');
    await expect(rejected.locator('h2 .pipeline-count')).toHaveText('2');
    await expect(rejected.locator('.pipeline-card', { hasText: 'Staff Test Declined' }).getByText('Unavailable that evening')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: path.join(SHOTS, 'pipeline-closed-withdrawn.png') });
  });

  test('missing fields are tolerated on the board: "awaiting confirmation", no deadline, no lane note', async ({ page }) => {
    const state = await fixtures(page, []);
    state.pipeline = pipeline(false);
    await page.goto('/venue-offers/shift-1?tab=staffing');
    const accepted = page.locator('.pipeline-column[data-stage="staff_accepted"] .pipeline-card');
    await expect(accepted.locator('.pipeline-card-state')).toContainText('awaiting confirmation');
    await expect(accepted.locator('.pipeline-card-state')).not.toContainText('confirm by');
    await page.getByRole('tab', { name: /^Closed/ }).click();
    await expect(page.locator('.pipeline-lane-note')).toHaveCount(0);
    await expect(page.locator('.pipeline-column[data-stage="rejected"]').getByText(CONFIRMATION_DEADLINE_LABELS.PIPELINE_TERMINAL_SOURCE)).toBeVisible();
  });
});
