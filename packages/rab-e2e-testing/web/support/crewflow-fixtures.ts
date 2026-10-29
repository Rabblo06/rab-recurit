import type { Page } from '@playwright/test';

/** Deterministic API fixtures for the Crewflow new-UI screenshots (obviously-test data, no live API). */
export const NOW = new Date('2026-10-19T09:30:00Z');
export const day = (offset: number, h = 18, m = 0) => { const d = new Date(NOW); d.setUTCDate(d.getUTCDate() + offset); d.setUTCHours(h, m, 0, 0); return d.toISOString(); };

const identity = {
  id: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222',
  organisationId: '33333333-3333-4333-8333-333333333333', firstName: 'Test', lastName: 'Manager',
  email: 'manager@example.test', roles: ['manager'], isPlatformAdmin: false, mustResetPassword: false,
  applicationTarget: 'manager_web', sessionExpiresAt: '2099-01-01T00:00:00Z',
};
const NAMES = ['Staff Test 1', 'Staff Test 2', 'Staff Test 3', 'Staff Test 4', 'Staff Test 5'];
const staff = (n: number) => ({
  id: `staff-${n}`, staffRef: `STAFF-00${n}`, email: `staff${n}@example.test`, firstName: 'Staff', lastName: `Test ${n}`, phone: null,
  dateOfBirth: null, avatarKey: null, employmentStatus: 'active', startDate: null, defaultPayRatePence: 1450, createdAt: day(-3 + n),
  createdByName: null, accountStatus: 'active', invitationStatus: null, mustResetPassword: false, pendingInvite: null, emergencyContactName: null,
  emergencyContactRelationship: null, emergencyContactPhone: null, jobRoleId: 'jr-1', preferredName: null, employmentType: null, address: null,
  city: null, postcode: null,
});
const manager = (n: number) => ({ id: `mgr-${n}`, email: `manager${n}@example.test`, firstName: 'Manager', lastName: `Test ${n}`, phone: null,
  type: n === 3 ? 'venue' : 'internal', jobTitle: null, createdAt: day(-5), accountStatus: n === 4 ? 'pending' : 'active',
  invitationStatus: n === 4 ? 'pending' : null, mustResetPassword: false, pendingInvite: null });
const VENUES = ['Venue Test 1', 'Venue Test 2', 'Venue Test 3', 'Venue Test 4'];
const venues = VENUES.map((name, i) => ({ id: `v-${i + 1}`, name, clientName: `Client ${i + 1}`, type: i % 2 ? 'hotel' : 'event', status: i === 3 ? 'archived' : 'active',
  address: { line1: `${i + 1} Test Street`, city: 'London', postcode: 'W1 1AA' }, instructions: null, breakPaid: false, createdAt: day(-20) }));
const SHIFT_STATUSES = ['partially_filled', 'fully_filled', 'offered', 'open', 'pending_approval', 'completed'];
const shifts = SHIFT_STATUSES.map((status, i) => ({ id: `shift-${i + 1}`, venueId: `v-${(i % 3) + 1}`, jobRoleId: 'jr-1', startsAt: day(i - 1, 17 + (i % 3)), endsAt: day(i - 1, 23),
  breakMinutes: 30, requiredCount: 4 + (i % 3), filledCount: Math.min(4 + (i % 3), i + 1), payRatePence: 1450, status, notes: null,
  venueName: VENUES[i % 3], roleName: 'Test Role' }));
const OFFER_STATUSES = ['pending', 'staff_accepted', 'manager_confirmed', 'declined', 'expired'];
const offers = OFFER_STATUSES.map((status, i) => ({ id: `offer-${i + 1}`, status, sentAt: day(-2, 9 + i), expiresAt: day(1), respondedAt: null, declineReason: null,
  staffAcceptedAt: null, managerConfirmedAt: null, managerRejectedAt: null, rejectionReason: null, estimatedPayPence: 10875, offerBatchId: null,
  shiftId: `shift-${i + 1}`, startsAt: day(i, 18), endsAt: day(i + 1, 2), venueName: VENUES[i % 3], roleName: 'Test Role', staffProfileId: `p-${i + 1}`, staffName: NAMES[i] }));
const attendance = [0, 1, 2, 3].map((i) => ({ id: `att-${i + 1}`, status: i === 2 ? 'clocked_in' : 'completed', clockInAt: day(-i - 1, 17, 58), clockOutAt: i === 2 ? null : day(-i, 2, 4),
  workedMinutes: i === 2 ? null : 480 - i * 15, earnedPence: i === 2 ? null : 11600 - i * 360, shiftId: `shift-${i + 1}`, startsAt: day(-i - 1, 18), endsAt: day(-i, 2),
  venueName: VENUES[i % 3], roleName: 'Test Role', staffProfileId: `p-${i + 1}`, staffName: NAMES[i] }));
const venueOffers = ['pending', 'confirmed', 'declined'].map((status, i) => ({ id: `shift-${i + 1}`, status, displayStatus: status === 'pending' ? 'Pending approval' : status === 'confirmed' ? 'Fully filled' : 'Declined',
  startsAt: day(i, 18), endsAt: day(i, 23), requiredCount: 4, selectedCount: 4 - i, payRatePence: 1450, notes: null, submittedAt: day(-1, 10 + i), venueName: VENUES[i], roleName: 'Test Role', venueManagerName: 'Manager Test 3' }));
const venueManagers = [['vm-1', 'Venue Manager', 'Test 1', 'active'], ['vm-2', 'Venue Manager', 'Test 2', 'invite_expired']].map(([id, firstName, lastName, accountStatus]) => ({
  id, email: `${id}@example.test`, firstName, lastName, accountStatus, invitationStatus: accountStatus === 'invite_expired' ? 'expired' : null, pendingInvite: null,
  createdAt: day(-3), venues: [{ id: 'v-3', name: 'Venue Test 3' }] }));
const audit = ['shift.confirmed', 'staff.invited', 'offer.sent', 'venue.updated', 'note.updated'].map((action, i) => ({ id: `a-${i}`, action, actor: { fullName: 'Manager Test 1' },
  metadata: {}, targetType: action.split('.')[0], targetId: `t-${i}`, createdAt: day(-i, 10 + i) }));

const PIPELINE_STAGES = ['OFFERED', 'WAITING', 'STAFF ACCEPTED', 'CONFIRMED', 'LATE STAFF', 'CLOCKED IN', 'PENDING REVIEW', 'CLOCKED OUT', 'NO SHOW', 'REJECTED', 'CANCELLED', 'DELETED OFFER'];
const PIPELINE_STAFF = ['OFFERED', 'STAFF ACCEPTED', 'CONFIRMED', 'CONFIRMED', 'CONFIRMED'].map((stage, i) => ({
  staffProfileId: `p-${i + 1}`, name: NAMES[i], avatarFileId: null, offerId: `offer-${i + 1}`, stage, offerStatus: stage === 'CONFIRMED' ? 'manager_confirmed' : stage === 'OFFERED' ? 'pending' : 'staff_accepted',
  assignmentStatus: stage === 'CONFIRMED' ? 'confirmed' : 'offered', attendanceStatus: null, sentAt: day(-1, 9), acceptedAt: stage === 'OFFERED' ? null : day(-1, 10), respondedAt: null,
  cancelledAt: null, terminalSource: null, clockInAt: null, clockOutAt: null, breakMinutes: null, workedMinutes: null, declineReason: null, withdrawnReason: null, rejectionReason: null,
  canManagerCancel: true, attendanceReviewed: false, earlierOffers: 0 }));

export interface FixtureOptions {
  sparse?: boolean;
  /**
   * Test-only populated dashboard (nonzero counts, 6.6 h average, several venues) for motion proof. Its shifts are venue
   * requests this manager created, so the readiness card loads the detailed checklist (dcddb901 serves the pipeline only
   * for the caller's own venue-requested shift; any other shift gets the basic, percentage-free view).
   */
  populated?: boolean;
  /** The shape of the owner's real dashboard: Staff 5, Venue managers unavailable, 0 h, no upcoming shift, 100% confirmed. */
  realShape?: boolean;
  /** Delay (ms) before /dashboard/summary answers (cold load with slow data). */
  summaryDelayMs?: number;
  /** Serve the realtime stream: each `state.push(type)` delivers one server-sent event (the app's real refresh path). */
  realtime?: boolean;
}

/** Mutable state a test can change between requests (e.g. a genuine dashboard update). */
export interface FixtureState { summary: Record<string, number | null>; summaryCalls: number; summaryStatus: number; realtimeRequests: number; push: (type: string) => void }

export async function fixtures(page: Page, opts: FixtureOptions = {}): Promise<FixtureState> {
  const queued: string[] = [];
  const waiters: Array<() => void> = [];
  let eventNo = 0;
  const state: FixtureState = {
    summary: opts.sparse ? { staffCount: 0, managerCount: null, venueManagerCount: 0, activeOfferCount: 0, venueCount: 0 }
      : opts.populated ? { staffCount: 64, managerCount: null, venueManagerCount: 15, activeOfferCount: 9, venueCount: 12 }
      : opts.realShape ? { staffCount: 5, managerCount: null, venueManagerCount: null, activeOfferCount: 0, venueCount: 1 }
      : { staffCount: 5, managerCount: null, venueManagerCount: 2, activeOfferCount: 3, venueCount: 3 },
    summaryCalls: 0,
    summaryStatus: 200,
    realtimeRequests: 0,
    push: (type: string) => { queued.push(type); waiters.splice(0).forEach((w) => w()); },
  };
  const populatedAttendance = [0, 1, 2, 3, 4].map((i) => ({ id: `att-p${i}`, status: 'completed', clockInAt: day(-i - 1, 9), clockOutAt: day(-i - 1, 16), workedMinutes: 396, earnedPence: 9000, shiftId: `shift-${i + 1}`,
    startsAt: day(-i - 1, 9), endsAt: day(-i - 1, 16), venueName: VENUES[i % 3], roleName: 'Test Role', staffProfileId: `p-${i + 1}`, staffName: NAMES[i] }));
  await page.clock.setFixedTime(NOW);
  await page.route('**/rest/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname.replace('/rest/v1', '');
    const send = (data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    const list = <T,>(rows: T[]) => send({ data: rows, total: rows.length, page: 1, limit: 25 });
    if (p.includes('realtime')) {
      if (!opts.realtime) return route.abort();
      const mine = ++state.realtimeRequests;
      // Held open until the test pushes an event, then delivered as one SSE frame (the client reconnects for the next).
      // Only the newest stream request is live: older ones were abandoned by page loads / identity reconnects.
      while (!queued.length || mine !== state.realtimeRequests) {
        await new Promise<void>((r) => waiters.push(r));
        if (mine !== state.realtimeRequests) return route.abort().catch(() => undefined);
      }
      const body = queued.splice(0).map((type) => `data: ${JSON.stringify({ eventId: `fx-${++eventNo}`, type, occurredAt: new Date().toISOString() })}

`).join('');
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body }).catch(() => undefined);
    }
    if (p === '/auth/me') return send(identity);
    if (p === '/auth/config') return send({ authProviders: { password: true } });
    if (p === '/auth/capabilities') return send({ 'staff.view': true, 'staff.create': true, 'staff.deactivate': true, 'venue_manager.create': true });
    if (p === '/manager-workspaces/me') return send({ id: 'w-1', name: 'Crewflow', status: 'active', subdomain: 'test', schemaStatus: 'READY', onboardingCompletedAt: '2026-10-01T00:00:00Z' });
    if (p === '/leadership/capabilities') return send({ leadership: { canCreateOrganisation: false, initialManagerScope: 'own' } });
    if (p === '/profile') return send({ ...identity, avatarKey: null });
    if (p === '/profile/preferences') return send({ theme: 'light' });
    if (p === '/notifications/unread-count') return send({ count: 2 });
    if (p === '/dashboard/summary') {
      state.summaryCalls += 1;
      if (opts.summaryDelayMs) await new Promise((r) => setTimeout(r, opts.summaryDelayMs));
      return state.summaryStatus === 200 ? send(state.summary) : send({ statusCode: state.summaryStatus, message: 'x' }, state.summaryStatus);
    }
    if (opts.populated && p === '/attendance') return list(populatedAttendance);
    if (opts.realShape && ['/shifts', '/attendance'].includes(p)) return list([]);
    if (opts.realShape && p === '/offers' && url.searchParams.get('limit') === '1') return send({ data: [], total: url.searchParams.get('status') === 'manager_confirmed' ? 15 : 0 });
    if (p === '/venue-managers') return list(venueManagers);
    if (p === '/search') return send([{ id: 'staff-1', name: 'Staff Test 1', type: 'Staff', group: 'People', to: '/users' }, { id: 'v-1', name: 'Venue Test 1', type: 'Venue', group: 'Venues', to: '/venues' }]);
    if (opts.sparse && ['/shifts', '/offers', '/attendance', '/venues', '/staff'].includes(p)) return list([]);
    if (p === '/staff') return list([1, 2, 3, 4, 5].map(staff));
    if (/^\/staff\/staff-\d+$/.test(p)) return send(staff(Number(p.split('-').pop())));
    if (p === '/managers') return list([1, 2, 3, 4].map(manager));
    if (p === '/job-roles') return send([{ id: 'jr-1', name: 'Test Role', defaultRatePence: 1450 }]);
    if (p === '/venues') return list(venues);
    if (p === '/shifts') return list(opts.populated ? shifts.map((s) => ({ ...s, createdBy: identity.id, requestedBy: 'vm-1' })) : shifts);
    if (p === '/shifts/requests') return list(venueOffers);
    if (p === '/offers') return list(offers);
    if (p === '/attendance') return list(attendance);
    if (p === '/profile/sessions') return send([]);
    if (/^\/shifts\/[^/]+\/pipeline$/.test(p)) return send({ shift: { id: p.split('/')[2], venueName: 'Venue Test 2', roleName: 'Test Role', startsAt: day(0, 18), endsAt: day(0, 23), status: 'fully_filled', requiredCount: 5 },
      serverNow: NOW.toISOString(), summary: { required: 5, filled: 5, open: 0, offered: 0, waiting: 0, accepted: 1, confirmed: 4, late: 0, clockedIn: 0, pendingReview: 0, clockedOut: 0, noShow: 0, rejected: 0, cancelled: 0, deleted: 0 },
      stageCounts: { OFFERED: 1, CONFIRMED: 3, 'STAFF ACCEPTED': 1 }, stages: PIPELINE_STAGES, staff: PIPELINE_STAFF, report: { ready: false, originalFileId: null, signedFileId: null, reportStatus: 'pending', finalisedByName: null, finalisedAt: null, staff: [] }, replacementPlaces: 0 });
    if (p === '/audit-logs') return send({ items: audit, page: 1, limit: 25, total: audit.length });
    return list([]);
  });
  return state;
}

