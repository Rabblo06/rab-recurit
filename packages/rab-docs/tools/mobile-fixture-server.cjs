#!/usr/bin/env node
/*
 * Crewflow mobile fixture server — SYNTHETIC DEMO DATA ONLY.
 *
 * A dependency-free Node HTTP server (PDF rendering aside, see mobile-fixture-documents.cjs) that answers the
 * REST endpoints the Flutter staff / venue-manager app (packages/rab-mobile) calls, with fictional data shaped
 * exactly like the app's Dart models and mirroring rab-server's rules (attendance, shift report, scheduling, offer
 * services). It exists only so documentation screenshots and screen recordings can be captured from the REAL app
 * without touching the real backend, database or any real person's data. Any password is accepted.
 *
 *   node mobile-fixture-server.cjs                        # port 4010, legacy dataset, real clock
 *   FIXTURE_SCENE=review node mobile-fixture-server.cjs   # start straight into a story scene
 *   PORT=4011 node mobile-fixture-server.cjs
 *
 * App build:  --dart-define=API_URL=http://10.0.2.2:4010/rest/v1
 *
 * Personas (picked by login email, any password; any other email -> 401):
 *   alex.morgan@example.test  -> staff          (Alex Morgan)
 *   priya.shah@example.test   -> staff          (Priya Shah — the story's staff member)
 *   riley.chen@example.test   -> venue_manager  (Riley Chen — Riverside House)
 *
 * FAIL CLOSED: unknown routes 404; missing/unknown/forged bearer tokens 401 (tokens are HMAC-signed so they survive
 * a fixture restart, FIXTURE_TOKEN_SECRET overrides the local default); a route of the other persona 404; malformed
 * JSON or undeclared body properties 400 (the server's forbidNonWhitelisted); non-UUID ids where the server uses
 * ParseUUIDPipe 400.
 *
 * ── DEMO CLOCK ───────────────────────────────────────────────────────────────────────────────────────────────
 * Every business rule and every `serverNow` uses the fixture's VIRTUAL clock (`clock.now()`), never Date.now()
 * directly. By default the virtual clock equals the real clock. Setting it (scene or clock control) anchors virtual
 * "now" to the given instant; from then on it advances in real time. The app anchors its timers to `serverNow`
 * (attendance `trustedNow`, offer `presentation.serverNow`), so the live timer follows the virtual clock. A few app
 * screens still read the DEVICE clock (e.g. Sent Shifts "Sent 5m ago", VenueManagerProvider.upcoming): set the
 * emulator's date/time near the scene's time if those must agree.
 *
 * ── STORY (fictional; identities match tools/web/fixtures.cjs) ───────────────────────────────────────────────
 * Northwind Staffing · Riverside House (22 Quay Example Road, Bristol BS1 9XX) · Venue manager Riley Chen ·
 * Waiting staff, Friday 23 October 2026 12:00–18:00 Europe/London, 30-minute break, 4 staff, £13.50/h (the web
 * fixture's Riverside House "Waiting staff" venue role rate). Staff: Priya Shah, Grace Kim, Leah Fischer, Isla Moore.
 * Leah Fischer's declared availability excludes Friday, so the request raises the real STAFF_AVAILABILITY_CONFLICT
 * warning (409) and "Submit anyway" acknowledges her date. Maya Lindqvist is confirmed elsewhere on Friday
 * (Harbour Kitchen, 11:00–17:00) so the staff picker shows a real "Not Available" badge for her.
 *
 *   POST /__fixture/scene {"scene":"<name>","now":"<ISO, optional>"}   reset state to the scene, set virtual now
 *   request   Tue 20 Oct 10:15  Riley can submit the request (select all FOUR: requiredCount = number selected).
 *   offer     Tue 20 Oct 11:40  approved by Jordan Hale 11:05, offers out; Grace + Isla accepted; Priya pending.
 *   shiftday  Fri 23 Oct 11:47  all four confirmed; clock-in window open (opens 11:45).
 *   clockout  Fri 23 Oct 18:02  Priya clocked in since 11:52; Grace out 18:00; Leah + Isla still in.
 *   review    Fri 23 Oct 18:40  Priya 11:52–18:02, Grace 11:55–18:00, Leah 11:58–18:05, Isla in 11:56 with NO
 *                               clock-out (flagged missing_clock_out at 18:30 = scheduled end + 30 min, the real
 *                               missing-clock-out policy; before 18:30 she is still "clocked in").
 *   history   Sat 24 Oct 09:10  finalised by Riley 18:52 Fri, typed sign-off, final timesheet delivered.
 *   legacy    (real clock)      the original relative-time dataset (Alex Morgan / Bristol venues).
 * Other people's actions in a scene are SCRIPTED at fixed virtual times (Grace/Isla/Leah clock in 11:55/11:56/11:58,
 * Grace out 18:00, Leah out 18:05, Leah accepts her offer Tue 13:10). The persona being filmed always acts through
 * the app. The worker jobs are simulated against the virtual clock: offer expiry, pre-shift attendance sheet
 * (start − 180 min), no-show (start + 30 min, no clock-in), missing clock-out (end + 30 min), original + final
 * timesheet PDFs and their delivery.
 *
 *   POST /__fixture/clock {"now":"<ISO>"} | {"advanceMinutes":n} | {"real":true}  move time WITHOUT resetting state
 *   GET  /__fixture/clock                              virtual now
 *   GET  /__fixture/scenes                             scene names + default times
 *   POST /__fixture/reset                              legacy dataset on the REAL clock (original behaviour)
 *   POST /__fixture/confirm/:offerId|latest            staff_accepted -> manager_confirmed (two-step shifts only)
 *   GET  /__fixture/state                              dump state (debugging)
 *
 * ── HONESTY NOTES ────────────────────────────────────────────────────────────────────────────────────────────
 *  - QR: clock-in/out REQUIRE a non-empty `qrToken` (as the DTO does) but the fixture does NOT validate it — any
 *    string is accepted. The printed pre-shift sheet's QR encodes a plainly synthetic "fixture-demo-shift-qr:<id>".
 *  - GPS: lat/lng are accepted and ignored. Riverside House has geofencing off (web fixture), so locationVerified is
 *    false, exactly as the server reports when no check ran. Geofence-exit is never evaluated (always 409).
 *  - PDFs are rendered locally from rab-server's REAL templates with fictional data (mobile-fixture-documents.cjs).
 *  - No email is ever sent. After finalise the delivery state progresses with the real state names: generating
 *    (until the PDF exists, at least FIXTURE_PDF_MIN_SECONDS, default 8) -> queued (outbox pending) -> sent after
 *    FIXTURE_DELIVERY_SECONDS (default 15). FIXTURE_DELIVERY=queued|failed|no_recipients stops/fails it instead.
 *  - Shift notes: the real Venue Manager request flow stores NO notes (SchedulingService.submitRequest sets
 *    `notes: undefined`; there is no edit endpoint), so the story shift has none. FIXTURE_STORY_NOTES=1 adds the web
 *    fixture's wedding note anyway (NOT reachable through the real product).
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const docs = require('./mobile-fixture-documents.cjs');

const PORT = Number(process.env.PORT || 4010);
const PREFIX = '/rest/v1';
const TZ = 'Europe/London';
const TOKEN_SECRET = process.env.FIXTURE_TOKEN_SECRET || 'rab-docs-mobile-fixture-local-only';
const PDF_MIN_SECONDS = Number(process.env.FIXTURE_PDF_MIN_SECONDS || 8);
const DELIVERY_SECONDS = Number(process.env.FIXTURE_DELIVERY_SECONDS || 15);
const DELIVERY_MODE = process.env.FIXTURE_DELIVERY || 'sent';
const STORY_NOTES = process.env.FIXTURE_STORY_NOTES === '1';

// rab-server environment defaults (environment-variables.ts) and policy constants.
const CLOCK_IN_EARLY_MINUTES = 15;
const QR_POST_SHIFT_GRACE_MINUTES = 120;
const REPORT_AVAILABLE_BEFORE_MINUTES = 180;
const ACTION_WINDOW_HOURS = 5; // SHIFT_ACTION_WINDOW_HOURS
const SENT_VISIBLE_HOURS = 5;
const MISSING_CLOCK_OUT_GRACE_MINUTES = 30;
const NO_SHOW_GRACE_MINUTES = 30;
const OFFER_EXPIRY_HOURS = 48;
const POST_SHIFT_COMPLETE_MS = 3600000;
const POST_SHIFT_EXPIRED_MS = 2 * 3600000;
const HOUR = 3600000;
const MIN = 60000;

// ---------------------------------------------------------------- ids ----
// Deterministic UUID-shaped ids (realtime envelope parser and ParseUUIDPipe both require UUIDs).
const uid = (group, n) => `${group}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

// ------------------------------------------------------------- clock -----
const clock = {
  offsetMs: 0,
  now() {
    return new Date(Date.now() + this.offsetMs);
  },
  set(date) {
    this.offsetMs = date.getTime() - Date.now();
  },
  real() {
    this.offsetMs = 0;
  },
  virtual() {
    return this.offsetMs !== 0;
  },
};

// ------------------------------------------------------------- time ------
const londonParts = (date) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute'), s: get('second') };
};
/** Offset (ms) of London local time from UTC at `date`. */
const londonOffset = (date) => {
  const p = londonParts(date);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(date.getTime() / 1000) * 1000;
};
/** London wall-clock time -> instant. */
const london = (y, mo, d, h, mi = 0, s = 0) => {
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = naive - londonOffset(new Date(naive));
  t = naive - londonOffset(new Date(t));
  return new Date(t);
};
/** A Date for London-local `hh:mm` on (base's London day + dayOffset). */
const at = (base, dayOffset, hh, mm = 0) => {
  const p = londonParts(base);
  return london(p.y, p.m, p.d + dayOffset, hh, mm);
};
const addMin = (date, minutes) => new Date(date.getTime() + minutes * MIN);
const iso = (d) => (d == null ? null : new Date(d).toISOString());
const dayKey = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
const roundUp5 = (date) => new Date(Math.ceil(date.getTime() / 300000) * 300000);
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
/** @rab/shared londonCalendarDays: every London civil day [start, end) touches. */
function londonCalendarDays(startsAt, endsAt) {
  const s = londonParts(startsAt);
  const e = londonParts(new Date(Math.max(startsAt.getTime(), endsAt.getTime() - 1)));
  const days = [];
  for (let t = Date.UTC(s.y, s.m - 1, s.d); t <= Date.UTC(e.y, e.m - 1, e.d) && days.length < 31; t += 24 * HOUR) {
    const d = new Date(t);
    days.push({ date: d.toISOString().slice(0, 10), weekday: WEEKDAYS[(d.getUTCDay() + 6) % 7] });
  }
  return days;
}
/** @rab/shared computeWorkedMinutes (no recorded breaks): gross minutes minus the scheduled unpaid break. */
const workedMinutes = (clockInAt, clockOutAt, breakMinutes) =>
  Math.max(0, Math.max(0, Math.round((clockOutAt.getTime() - clockInAt.getTime()) / MIN)) - breakMinutes);
/** @rab/shared payForMinutes. */
const payForMinutes = (ratePence, minutes) => Math.round((ratePence * minutes) / 60);

// --------------------------------------------------------- identities ---
const USERS = {
  alex: uid('0b000000', 1),
  riley: uid('0b000000', 2),
  priya: uid('0b000000', 3),
  jordan: uid('0b000000', 4),
};
const PERSONAS = {
  staff: { key: 'staff', role: 'staff', id: USERS.alex, email: 'alex.morgan@example.test', firstName: 'Alex', lastName: 'Morgan' },
  priya: { key: 'priya', role: 'staff', id: USERS.priya, email: 'priya.shah@example.test', firstName: 'Priya', lastName: 'Shah' },
  vm: { key: 'vm', role: 'venue_manager', id: USERS.riley, email: 'riley.chen@example.test', firstName: 'Riley', lastName: 'Chen' },
};
const personaByEmail = (email) => Object.values(PERSONAS).find((p) => p.email === email);
const meJson = (persona) => {
  const p = PERSONAS[persona];
  return {
    id: p.id, email: p.email, firstName: p.firstName, lastName: p.lastName, organisationId: state.orgId,
    roles: [p.role], mustResetPassword: false, isPlatformAdmin: false,
  };
};

// /auth/capabilities flag set (AuthController.capabilities); venue_manager defaults from
// PermissionCatalogueAndSystemRoleDefaults1786718000000. offer.send is NOT a Venue Manager default.
const CAPABILITY_FLAGS = ['staff.view', 'schedule.view', 'venue.view', 'offer.send', 'report.view', 'staffing_request.create', 'attendance.view',
  'venue_manager.create', 'report.export', 'attendance.edit', 'review.create', 'staff.create', 'staff.deactivate'];
const VM_GRANTS = new Set(['staff.view', 'venue.view', 'schedule.view', 'attendance.view', 'review.create', 'staffing_request.create', 'report.view', 'attendance.edit', 'report.export']);
const capabilities = (persona) => Object.fromEntries(CAPABILITY_FLAGS.map((f) => [f, PERSONAS[persona].role === 'venue_manager' && VM_GRANTS.has(f)]));

// --------------------------------------------------------- state ---------
let state;
const newId = () => crypto.randomUUID();

function emptyState(dataset) {
  return {
    dataset, scene: null, builtAt: null, orgId: uid('0a000000', 1), workspaceName: 'Northwind Staffing',
    venues: [], roles: [], people: [], users: {
      [USERS.alex]: { firstName: 'Alex', lastName: 'Morgan' }, [USERS.riley]: { firstName: 'Riley', lastName: 'Chen' },
      [USERS.priya]: { firstName: 'Priya', lastName: 'Shah' }, [USERS.jordan]: { firstName: 'Jordan', lastName: 'Hale' },
    },
    personaProfile: {}, vm: { userId: USERS.riley, venueIds: [], team: new Map() },
    shifts: [], assignments: [], offers: [], attendance: [], corrections: [], requestStaff: [],
    reports: {}, reviews: {}, files: {}, notifications: { staff: [], priya: [], vm: [] }, scripted: [],
  };
}

const venueById = (id) => state.venues.find((v) => v.id === id);
const roleById = (id) => state.roles.find((r) => r.id === id);
const personById = (id) => state.people.find((p) => p.id === id);
const shiftById = (id) => state.shifts.find((s) => s.id === id);
const assignmentById = (id) => state.assignments.find((a) => a.id === id);
const attendanceFor = (assignmentId) => state.attendance.find((a) => a.assignmentId === assignmentId) || null;
const fullName = (p) => `${p.firstName} ${p.lastName}`;
const userName = (userId) => (state.users[userId] ? `${state.users[userId].firstName} ${state.users[userId].lastName}` : null);
const timeOf = (a) => {
  const sh = shiftById(a.shiftId);
  return { startsAt: a.startsAt || sh.startsAt, endsAt: a.endsAt || sh.endsAt };
};
const breakOf = (a) => (a.breakMinutes != null ? a.breakMinutes : shiftById(a.shiftId).breakMinutes);
const notify = (persona, n) => state.notifications[persona].unshift({ id: newId(), readAt: null, ...n });
const personaForProfile = (profileId) => Object.keys(state.personaProfile).find((k) => state.personaProfile[k] === profileId) || null;

function person(o) {
  const p = {
    id: o.id, userId: o.userId || newId(), firstName: o.firstName, lastName: o.lastName,
    email: `${o.firstName}.${o.lastName}`.toLowerCase() + '@example.test',
    employmentStatus: o.employmentStatus || 'active', jobRoleName: o.jobRoleName || null, employmentType: o.employmentType || null,
    preferredShiftTimes: o.preferredShiftTimes || null, maxHoursPerWeek: o.maxHoursPerWeek ?? null, availableDays: o.availableDays || null,
    yearsExperience: o.yearsExperience ?? null, skills: o.skills || null, staffRef: o.staffRef || null, phone: o.phone || null,
  };
  state.people.push(p);
  if (!state.users[p.userId]) state.users[p.userId] = { firstName: p.firstName, lastName: p.lastName };
  return p;
}

/**
 * One shift with its seats. `staff`: [{ person, offer, assignment, sentAt, respondedAt, confirmedAt, att }] where
 * `offer` is the job_offer status and `assignment` the shift_assignment status; `att` = { in, out, status, method,
 * verified } for an attendance row. filledCount is derived from confirmed/completed/no_show seats.
 */
function addShift(o) {
  const venue = venueById(o.venueId);
  const sh = {
    id: o.id || newId(), venueId: o.venueId, jobRoleId: o.jobRoleId, startsAt: o.startsAt, endsAt: o.endsAt,
    defaultStartsAt: o.startsAt, defaultEndsAt: o.endsAt, status: o.status, requiredCount: o.required, filledCount: 0,
    breakMinutes: o.breakMinutes ?? venue.defaultBreakMinutes, payRatePence: o.rate, address: venue.address, notes: o.notes ?? null,
    createdBy: o.createdBy || USERS.jordan, requestedBy: o.requestedBy || null, createdAt: o.createdAt || addMin(o.startsAt, -7 * 24 * 60),
    approvedAt: o.approvedAt || null, approvedBy: o.approvedBy || null,
  };
  state.shifts.push(sh);
  for (const s of o.staff || []) {
    const a = {
      id: s.assignmentId || newId(), shiftId: sh.id, staffProfileId: s.person.id, status: s.assignment, startsAt: null, endsAt: null,
      breakMinutes: null, payRatePence: sh.payRatePence, assignedBy: sh.createdBy, attendanceReviewedAt: s.reviewedAt || null,
      attendanceReviewedBy: s.reviewedAt ? state.vm.userId : null,
    };
    state.assignments.push(a);
    // Legacy pending offers default to "sent 3 hours ago" so they are still open whenever the dataset is built.
    const sentAt = s.sentAt || (state.dataset === 'legacy' && s.offer === 'pending' ? addMin(state.builtAt, -180) : addMin(sh.startsAt, -3 * 24 * 60));
    const minutes = Math.max(0, (sh.endsAt - sh.startsAt) / MIN - sh.breakMinutes);
    state.offers.push({
      id: s.offerId || newId(), assignmentId: a.id, shiftId: sh.id, staffProfileId: s.person.id, status: s.offer, sentAt,
      expiresAt: s.expiresAt || new Date(sentAt.getTime() + OFFER_EXPIRY_HOURS * HOUR),
      respondedAt: s.offer === 'pending' ? null : s.respondedAt || addMin(sentAt, 120),
      staffAcceptedAt: ['staff_accepted', 'manager_confirmed'].includes(s.offer) ? s.respondedAt || addMin(sentAt, 120) : null,
      managerConfirmedAt: s.offer === 'manager_confirmed' ? s.confirmedAt || s.respondedAt || addMin(sentAt, 150) : null,
      declineReason: null, estimatedPayPence: payForMinutes(sh.payRatePence, minutes),
    });
    if (s.att) {
      const att = {
        id: s.attendanceId || newId(), assignmentId: a.id, shiftId: sh.id, staffProfileId: s.person.id, status: s.att.status,
        clockInAt: s.att.in, clockOutAt: s.att.out || null, breakMinutes: null, workedMinutes: null, earnedPence: null,
        locationVerified: !!s.att.verified, clockOutMethod: s.att.out ? s.att.method || 'manual' : null,
      };
      if (att.clockOutAt) {
        att.workedMinutes = workedMinutes(att.clockInAt, att.clockOutAt, breakOf(a));
        att.earnedPence = payForMinutes(a.payRatePence, att.workedMinutes);
      }
      state.attendance.push(att);
      if (s.att.correction) {
        state.corrections.push({ attendanceId: att.id, ...s.att.correction });
      }
    }
  }
  sh.filledCount = state.assignments.filter((a) => a.shiftId === sh.id && ['confirmed', 'completed', 'no_show'].includes(a.status)).length;
  return sh;
}

function addFile(shiftId, kind, generatedAt) {
  const filename = { pre_shift: 'shift-attendance-sheet.pdf', original: 'original-timesheet.pdf', final: 'final-timesheet.pdf' }[kind];
  const f = { id: newId(), shiftId, kind, filename, generatedAt, bytes: null, promise: null, doneAt: null, error: null };
  state.files[f.id] = f;
  return f;
}

// ------------------------------------------------------ legacy dataset ---
/** The original relative-time dataset (Alex Morgan, Bristol venues), on the canonical model. */
function buildLegacy() {
  const now = clock.now();
  const s = (state = emptyState('legacy'));
  s.builtAt = now;
  s.scene = 'legacy';
  s.venues = [
    { id: uid('0d000000', 1), name: 'The Grand Hall', address: '12 Market Square, Bristol BS1 4XY', defaultBreakMinutes: 30, enforceGeofence: false },
    { id: uid('0d000000', 2), name: 'Riverside Pavilion', address: '3 Quayside Walk, Bristol BS1 5LT', defaultBreakMinutes: 30, enforceGeofence: false },
    { id: uid('0d000000', 3), name: 'Harbour Exhibition Centre', address: 'Harbour Road, Bristol BS1 6QA', defaultBreakMinutes: 45, enforceGeofence: false },
    { id: uid('0d000000', 4), name: 'Kingsway Rooms', address: '88 Kingsway, Bristol BS2 9HD', defaultBreakMinutes: 30, enforceGeofence: false },
  ];
  const V = s.venues;
  s.roles = ['Bartender', 'Waiting Staff', 'Event Steward', 'Cloakroom Attendant', 'Banquet Server'].map((name, i) => ({ id: uid('0e000000', i + 1), name }));
  const R = (name) => s.roles.find((r) => r.name === name).id;
  const pool = [
    ['Alex', 'Morgan', 'active', USERS.alex], ['Jordan', 'Patel', 'active'], ['Sam', 'Okafor', 'active'], ['Priya', 'Shah', 'active', USERS.priya],
    ['Casey', 'Williams', 'active'], ['Morgan', 'Lee', 'pending_compliance'], ['Taylor', 'Brooks', 'active'], ['Jamie', 'Nguyen', 'active'],
    ['Charlie', 'Evans', 'active'], ['Robin', 'Hughes', 'active'],
  ].map(([firstName, lastName, employmentStatus, userId], i) =>
    person({ id: uid('0c000000', i + 1), userId, firstName, lastName, employmentStatus, staffRef: `CF-${1041 + i}`, jobRoleName: 'Event Steward' }));
  s.personaProfile = { staff: pool[0].id, priya: pool[3].id };
  s.vm.venueIds = V.map((v) => v.id);
  pool.slice(0, 7).forEach((p) => s.vm.team.set(p.id, { isFavourite: false, isEmergency: false }));
  const alex = pool[0];

  // Alex's own shifts (directly created by a manager: two-step accept -> /__fixture/confirm).
  const soon = roundUp5(addMin(now, 10)); // clock-in window (start - 15 min) already open
  const alexShift = (venue, role, startsAt, endsAt, rate, offer, notes, att) => addShift({
    venueId: venue.id, jobRoleId: R(role), startsAt, endsAt, rate, required: 3, notes,
    status: att ? 'completed' : offer === 'manager_confirmed' ? 'partially_filled' : 'offered',
    staff: [{ person: alex, offer, assignment: att ? 'completed' : offer === 'manager_confirmed' ? 'confirmed' : 'offered', sentAt: addMin(startsAt, -3 * 24 * 60), expiresAt: offer === 'pending' ? addMin(startsAt, -360) : undefined, att }],
  });
  alexShift(V[0], 'Bartender', at(now, 1, 18), at(now, 1, 23, 30), 1450, 'pending', 'Black shirt and trousers. Cocktail service for a 180-guest gala dinner. Report to the bar manager at the staff entrance on Market Lane.');
  alexShift(V[1], 'Waiting Staff', at(now, 3, 11), at(now, 3, 17), 1275, 'pending', 'Wedding lunch, silver service. Smart black uniform; aprons provided.');
  alexShift(V[0], 'Cloakroom Attendant', at(now, 5, 17, 30), at(now, 5, 23), 1200, 'pending');
  alexShift(V[2], 'Event Steward', soon, addMin(soon, 360), 1380, 'manager_confirmed', 'Trade show doors open at the start of shift. Hi-vis provided at the security office. Scan the shift QR code at the staff entrance to clock in.');
  alexShift(V[0], 'Bartender', at(now, 2, 17), at(now, 2, 23), 1450, 'manager_confirmed', 'Corporate awards night. Bar opens 18:00.');
  alexShift(V[3], 'Banquet Server', at(now, 4, 12), at(now, 4, 18), 1300, 'manager_confirmed');
  alexShift(V[1], 'Waiting Staff', at(now, 6, 10), at(now, 6, 16), 1275, 'manager_confirmed');
  const earlyEnd = new Date(Math.floor(addMin(now, -80).getTime() / 300000) * 300000);
  [
    { startsAt: addMin(earlyEnd, -300), endsAt: earlyEnd, venue: V[3], role: 'Banquet Server', rate: 1300, inOff: -6, outOff: 2 },
    { days: -1, venue: V[0], role: 'Bartender', start: [18, 0], end: [23, 30], rate: 1450, inOff: -4, outOff: 6 },
    { days: -3, venue: V[3], role: 'Banquet Server', start: [12, 0], end: [18, 0], rate: 1300, inOff: -9, outOff: 0 },
    { days: -6, venue: V[2], role: 'Event Steward', start: [8, 0], end: [16, 0], rate: 1380, inOff: -12, outOff: 4 },
    { days: -9, venue: V[1], role: 'Waiting Staff', start: [11, 0], end: [17, 0], rate: 1275, inOff: -6, outOff: -2 },
  ].forEach((p, i) => {
    const startsAt = p.startsAt || at(now, p.days, ...p.start);
    const endsAt = p.endsAt || at(now, p.days, ...p.end);
    const out = addMin(endsAt, p.outOff);
    const sh = alexShift(p.venue, p.role, startsAt, endsAt, p.rate, 'manager_confirmed', null,
      { in: addMin(startsAt, p.inOff), out, status: i === 0 ? 'clocked_out' : 'approved', method: 'manual' });
    if (i > 0) finalisedReport(sh, addMin(out, 50), true);
    else s.reports[sh.id] = { shiftId: sh.id, status: 'ready', preShiftFileId: addFile(sh.id, 'pre_shift', addMin(startsAt, -REPORT_AVAILABLE_BEFORE_MINUTES)).id };
  });

  // Venue-manager side (Riley). Pool index 9 (Robin) stands in where Alex used to be so Alex's Home is unchanged.
  const vmShift = (venue, role, startsAt, endsAt, required, rate, people, extra = {}) => addShift({
    venueId: venue.id, jobRoleId: R(role), startsAt, endsAt, required, rate, ...extra,
    staff: people.map(([idx, offer, att]) => ({
      person: pool[idx], offer,
      assignment: att ? (att.out ? 'completed' : 'confirmed') : { pending: 'offered', staff_accepted: 'staff_accepted', manager_confirmed: 'confirmed', declined: 'declined' }[offer],
      att,
    })),
  });
  const fill = (sh) => {
    if (!['pending_manager_approval', 'completed', 'in_progress'].includes(sh.status)) {
      sh.status = sh.filledCount >= sh.requiredCount ? 'fully_filled' : sh.filledCount > 0 ? 'partially_filled' : 'offered';
    }
    return sh;
  };
  fill(vmShift(V[0], 'Event Steward', at(now, 0, 18), at(now, 0, 23, 30), 6, 1380,
    [[9, 'manager_confirmed'], [1, 'manager_confirmed'], [2, 'manager_confirmed'], [3, 'manager_confirmed'], [4, 'staff_accepted'], [6, 'pending']],
    { status: 'offered', notes: 'Charity gala. Stewards to brief with security at 17:45 at the main entrance.' }));
  fill(vmShift(V[1], 'Bartender', at(now, 1, 17), at(now, 1, 23), 4, 1450,
    [[1, 'manager_confirmed'], [3, 'manager_confirmed'], [2, 'pending'], [4, 'pending'], [6, 'declined']], { status: 'offered' }));
  fill(vmShift(V[0], 'Waiting Staff', at(now, 3, 11), at(now, 3, 17), 5, 1275,
    [[9, 'manager_confirmed'], [1, 'manager_confirmed'], [2, 'manager_confirmed'], [3, 'manager_confirmed'], [4, 'manager_confirmed']], { status: 'offered' }));
  const req = vmShift(V[1], 'Cloakroom Attendant', at(now, 5, 17, 30), at(now, 5, 23), 2, 1200, [],
    { status: 'pending_manager_approval', requestedBy: USERS.riley, createdBy: USERS.riley, createdAt: addMin(now, -50) });
  s.requestStaff.push({ shiftId: req.id, staffProfileId: pool[1].id }, { shiftId: req.id, staffProfileId: pool[2].id });
  const yStart = at(now, -1, 12);
  const yEnd = at(now, -1, 18);
  const ePast = vmShift(V[0], 'Banquet Server', yStart, yEnd, 4, 1300, [
    [9, 'manager_confirmed', { in: addMin(yStart, -7), out: addMin(yEnd, 3), status: 'clocked_out' }],
    [1, 'manager_confirmed', { in: addMin(yStart, -2), out: yEnd, status: 'clocked_out' }],
    [2, 'manager_confirmed', { in: addMin(yStart, 12), out: yEnd, status: 'clocked_out' }],
    [3, 'manager_confirmed', { in: addMin(yStart, -5), out: null, status: 'missing_clock_out' }],
  ], { status: 'in_progress' });
  s.reports[ePast.id] = { shiftId: ePast.id, status: 'ready', preShiftFileId: addFile(ePast.id, 'pre_shift', addMin(yStart, -REPORT_AVAILABLE_BEFORE_MINUTES)).id };
  const s2 = at(now, -4, 18);
  const e2 = at(now, -4, 23, 30);
  const ePast2 = vmShift(V[1], 'Bartender', s2, e2, 3, 1450, [
    [1, 'manager_confirmed', { in: addMin(s2, -5), out: addMin(e2, 4), status: 'approved' }],
    [4, 'manager_confirmed', { in: addMin(s2, -10), out: e2, status: 'approved' }],
    [6, 'manager_confirmed', { in: addMin(s2, -3), out: addMin(e2, 6), status: 'approved',
      correction: { field: 'clockOutAt', oldValue: '', newValue: iso(addMin(e2, 6)), reason: 'Forgot to scan out; confirmed by bar supervisor.', correctedBy: USERS.riley, at: addMin(e2, 40) } }],
  ], { status: 'completed' });
  finalisedReport(ePast2, addMin(e2, 14 * 60), true);

  s.notifications.staff = [
    { id: uid('1c000000', 1), type: 'offer_sent', title: 'New shift offer', message: 'The Grand Hall · Bartender', readAt: null, createdAt: addMin(now, -12) },
    { id: uid('1c000000', 2), type: 'offer_confirmed', title: 'Shift confirmed', message: 'Your shift offer has been confirmed.', readAt: null, createdAt: addMin(now, -95) },
    { id: uid('1c000000', 3), type: 'shift_reminder_2h', title: 'Shift starts soon', message: 'Event Steward at Harbour Exhibition Centre starts today. Remember to scan the shift QR code when you arrive.', readAt: null, createdAt: addMin(now, -180) },
  ];
  s.notifications.vm = [
    { id: uid('1c000000', 4), type: 'shift_request_submitted', title: 'Shift request submitted', message: 'Riverside Pavilion · Cloakroom Attendant — 2 staff needed.', readAt: addMin(now, -40), createdAt: addMin(now, -50) },
  ];
}

/** A report finalised (and, when `delivered`, emailed) at `finalisedAt`, attendance approved, every seat reviewed. */
function finalisedReport(sh, finalisedAt, delivered, signOff = null) {
  for (const a of state.assignments.filter((x) => x.shiftId === sh.id && ['confirmed', 'completed', 'no_show'].includes(x.status))) {
    a.attendanceReviewedAt = a.attendanceReviewedAt || addMin(finalisedAt, -5);
    a.attendanceReviewedBy = state.vm.userId;
    const att = attendanceFor(a.id);
    if (att) att.status = 'approved';
  }
  const finalFile = addFile(sh.id, 'final', addMin(finalisedAt, 0.5));
  state.reports[sh.id] = {
    shiftId: sh.id, status: 'finalised', finalisedAt, finalisedBy: state.vm.userId,
    signedOffName: signOff ? signOff.name : null, breakConfirmed: signOff ? true : null,
    preShiftFileId: addFile(sh.id, 'pre_shift', addMin(sh.startsAt, -REPORT_AVAILABLE_BEFORE_MINUTES)).id,
    originalFileId: addFile(sh.id, 'original', addMin(sh.endsAt, 10)).id,
    finalFileId: finalFile.id, finalQueuedAt: addMin(finalisedAt, 0.5),
    outbox: [{ status: delivered ? 'SENT' : 'PENDING', sentAt: delivered ? addMin(finalisedAt, 1) : null, dueAt: addMin(finalisedAt, 1) }],
  };
  return state.reports[sh.id];
}

// ------------------------------------------------------- story dataset ---
const STORY = {
  orgId: '7a0c2f5e-3b1d-4c8e-9f60-000000000001', // tools/web/fixtures.cjs ORG_ID
  venue: uid('5a100000', 1), // web 'v-river'
  harbour: uid('5a100000', 2), // web 'v-harbour'
  roleWait: uid('5a200000', 5), // web 'r-wait'
  roleBar: uid('5a200000', 1),
  shift: uid('5a300000', 1),
  mayaShift: uid('5a300000', 2),
  staff: {
    // web fixtures.cjs `st-<first>` ids, as UUIDs (the mobile API requires UUIDs). Names, emails, staff refs, job
    // roles, employment types, preferred times and max hours follow the web fixture's seed formulas.
    alex: uid('5a400000', 1), priya: uid('5a400000', 2), sam: uid('5a400000', 5), maya: uid('5a400000', 6),
    leah: uid('5a400000', 8), grace: uid('5a400000', 10), isla: uid('5a400000', 13),
  },
  offer: (k) => uid('5a500000', { priya: 1, grace: 2, leah: 3, isla: 4, maya: 5 }[k]),
  assignment: (k) => uid('5a600000', { priya: 1, grace: 2, leah: 3, isla: 4, maya: 5 }[k]),
  attendance: (k) => uid('5a700000', { priya: 1, grace: 2, leah: 3, isla: 4 }[k]),
};
const T = (d, h, mi = 0, s = 0) => london(2026, 10, d, h, mi, s);
const SCENES = {
  request: T(20, 10, 15),
  offer: T(20, 11, 40),
  shiftday: T(23, 11, 47),
  clockout: T(23, 18, 2),
  review: T(23, 18, 40),
  history: T(24, 9, 10),
};
const SCENE_ORDER = ['request', 'offer', 'shiftday', 'clockout', 'review', 'history'];
const after = (scene, target) => SCENE_ORDER.indexOf(scene) >= SCENE_ORDER.indexOf(target);

function buildStory(scene) {
  const s = (state = emptyState('story'));
  s.scene = scene;
  s.builtAt = clock.now();
  s.orgId = STORY.orgId;
  // tools/web/fixtures.cjs venueSeed: Riverside House (geofence off, 30-min break) and Harbour Kitchen.
  s.venues = [
    { id: STORY.venue, name: 'Riverside House', address: '22 Quay Example Road, Bristol BS1 9XX', defaultBreakMinutes: 30, enforceGeofence: false, lat: 51.4507, lng: -2.5967 },
    { id: STORY.harbour, name: 'Harbour Kitchen', address: '8 Example Wharf, Bristol BS1 8XX', defaultBreakMinutes: 20, enforceGeofence: true, lat: 51.4486, lng: -2.5986 },
  ];
  s.roles = [
    { id: STORY.roleBar, name: 'Bartender' }, { id: uid('5a200000', 2), name: 'Event staff' }, { id: uid('5a200000', 3), name: 'Chef de partie' },
    { id: uid('5a200000', 4), name: 'Warehouse operative' }, { id: STORY.roleWait, name: 'Waiting staff' },
  ];
  const W = ['Monday', 'Tuesday', 'Thursday', 'Friday', 'Saturday'];
  const P = {
    alex: person({ id: STORY.staff.alex, userId: USERS.alex, firstName: 'Alex', lastName: 'Morgan', staffRef: 'STAFF 1', jobRoleName: 'Bartender', employmentType: 'Full-time', preferredShiftTimes: 'Evening', maxHoursPerWeek: 40, availableDays: W.slice(0, 3), phone: '+44 7700 900101' }),
    priya: person({ id: STORY.staff.priya, userId: USERS.priya, firstName: 'Priya', lastName: 'Shah', staffRef: 'STAFF 2', jobRoleName: 'Event staff', employmentType: 'Part-time', preferredShiftTimes: 'Flexible', maxHoursPerWeek: 24, availableDays: W.slice(0, 4), phone: '+44 7700 900108' }),
    sam: person({ id: STORY.staff.sam, firstName: 'Sam', lastName: 'Reed', staffRef: 'STAFF 5', jobRoleName: 'Warehouse operative', employmentType: 'Temporary', preferredShiftTimes: 'Evening', maxHoursPerWeek: 32, availableDays: W.slice(0, 5), phone: '+44 7700 900129' }),
    maya: person({ id: STORY.staff.maya, firstName: 'Maya', lastName: 'Lindqvist', staffRef: 'STAFF 6', jobRoleName: 'Waiting staff', employmentType: 'Part-time', preferredShiftTimes: 'Flexible', maxHoursPerWeek: 40, availableDays: W.slice(0, 3), phone: '+44 7700 900136' }),
    // Story override: Leah's declared days exclude Friday (the one availability warning in the request scene).
    leah: person({ id: STORY.staff.leah, firstName: 'Leah', lastName: 'Fischer', staffRef: 'STAFF 8', jobRoleName: 'Event staff', employmentType: 'Casual', preferredShiftTimes: 'Morning', maxHoursPerWeek: 40, availableDays: ['Monday', 'Tuesday', 'Thursday', 'Saturday'], phone: '+44 7700 900150' }),
    // Story override: Grace and Isla include Friday (the web seed formula would not), so only Leah warns.
    grace: person({ id: STORY.staff.grace, firstName: 'Grace', lastName: 'Kim', staffRef: 'STAFF 10', jobRoleName: 'Waiting staff', employmentType: 'Casual', preferredShiftTimes: 'Flexible', maxHoursPerWeek: 32, availableDays: ['Monday', 'Tuesday', 'Thursday', 'Friday'], phone: '+44 7700 900164' }),
    isla: person({ id: STORY.staff.isla, firstName: 'Isla', lastName: 'Moore', staffRef: 'STAFF 13', jobRoleName: 'Waiting staff', employmentType: 'Part-time', preferredShiftTimes: 'Evening', maxHoursPerWeek: 40, availableDays: ['Monday', 'Tuesday', 'Thursday', 'Friday', 'Saturday'], phone: '+44 7700 900185' }),
  };
  s.personaProfile = { staff: P.alex.id, priya: P.priya.id };
  s.vm.venueIds = [STORY.venue];
  // web vmTeams['mg-riley'] (alex, priya, sam, maya, grace) + leah, isla for the story.
  for (const k of ['alex', 'priya', 'sam', 'maya', 'grace', 'leah', 'isla']) s.vm.team.set(P[k].id, { isFavourite: k === 'priya', isEmergency: k === 'grace' });

  // Background: Maya is confirmed at Harbour Kitchen on the Friday (outside Riley's venues), so she is busy.
  addShift({
    id: STORY.mayaShift, venueId: STORY.harbour, jobRoleId: STORY.roleBar, startsAt: T(23, 11), endsAt: T(23, 17), required: 2, rate: 1500,
    status: 'partially_filled', createdAt: T(16, 9),
    staff: [{ person: P.maya, offer: 'manager_confirmed', assignment: 'confirmed', offerId: STORY.offer('maya'), assignmentId: STORY.assignment('maya'), sentAt: T(16, 9, 30), respondedAt: T(16, 12) }],
  });

  if (scene === 'request') {
    s.notifications.vm = [];
    return;
  }

  // Submitted Tue 10:16 by Riley (Leah's Friday acknowledged), approved by Jordan Hale 11:05 (offers sent).
  const sent = T(20, 11, 5);
  const seat = (k, offer, assignment, respondedAt, att, reviewedAt) => ({
    person: P[k], offer, assignment, sentAt: sent, respondedAt, confirmedAt: respondedAt,
    offerId: STORY.offer(k), assignmentId: STORY.assignment(k), attendanceId: STORY.attendance(k), att, reviewedAt,
  });
  const inAt = { priya: T(23, 11, 52), grace: T(23, 11, 55), isla: T(23, 11, 56), leah: T(23, 11, 58) };
  const outAt = { priya: T(23, 18, 2), grace: T(23, 18, 0), leah: T(23, 18, 5) };
  const isla = { correctedOut: T(23, 18, 0), correctedAt: T(23, 18, 44) };
  const accepted = { grace: T(20, 11, 21), isla: T(20, 11, 33), priya: T(20, 11, 41), leah: T(20, 13, 10) };
  const finalisedAt = T(23, 18, 52);
  const history = scene === 'history';
  const attFor = (k) => {
    if (!after(scene, 'clockout')) return undefined;
    if (k === 'priya') return after(scene, 'review') ? { in: inAt.priya, out: outAt.priya, status: history ? 'approved' : 'clocked_out', method: 'manual' } : { in: inAt.priya, status: 'clocked_in' };
    if (k === 'grace') return { in: inAt.grace, out: outAt.grace, status: history ? 'approved' : 'clocked_out', method: 'manual' };
    if (k === 'leah') return after(scene, 'review') ? { in: inAt.leah, out: outAt.leah, status: history ? 'approved' : 'clocked_out', method: 'manual' } : { in: inAt.leah, status: 'clocked_in' };
    if (history) {
      return { in: inAt.isla, out: isla.correctedOut, status: 'approved', method: 'manager_correction',
        correction: { field: 'clockOutAt', oldValue: '', newValue: iso(isla.correctedOut), reason: 'Isla left with the rest of the team at 18:00 but did not scan out.', correctedBy: USERS.riley, at: isla.correctedAt } };
    }
    return { in: inAt.isla, status: scene === 'review' ? 'missing_clock_out' : 'clocked_in' };
  };
  const assignmentFor = (k) => {
    const att = attFor(k);
    if (att && att.out && att.method !== 'manager_correction') return 'completed';
    return 'confirmed';
  };
  const offerScene = scene === 'offer';
  const staffSeats = [
    seat('priya', offerScene ? 'pending' : 'manager_confirmed', offerScene ? 'offered' : assignmentFor('priya'), offerScene ? null : accepted.priya, attFor('priya'), history ? T(23, 18, 45) : null),
    seat('grace', 'manager_confirmed', assignmentFor('grace'), accepted.grace, attFor('grace'), history ? T(23, 18, 46) : null),
    seat('leah', offerScene ? 'pending' : 'manager_confirmed', offerScene ? 'offered' : assignmentFor('leah'), offerScene ? null : accepted.leah, attFor('leah'), history ? T(23, 18, 47) : null),
    seat('isla', 'manager_confirmed', assignmentFor('isla'), accepted.isla, attFor('isla'), history ? T(23, 18, 48) : null),
  ];
  const sh = addShift({
    id: STORY.shift, venueId: STORY.venue, jobRoleId: STORY.roleWait, startsAt: T(23, 12), endsAt: T(23, 18), required: 4, rate: 1350, breakMinutes: 30,
    notes: STORY_NOTES ? 'Wedding reception for 120 guests. Smart black uniform, arrive 15 minutes early.' : null,
    status: 'offered', createdBy: USERS.jordan, requestedBy: USERS.riley, createdAt: T(20, 10, 16, 20), approvedAt: sent, approvedBy: USERS.jordan,
    staff: staffSeats,
  });
  sh.status = after(scene, 'clockout') ? 'in_progress' : sh.filledCount >= sh.requiredCount ? 'fully_filled' : sh.filledCount > 0 ? 'partially_filled' : 'offered';
  for (const k of ['priya', 'grace', 'leah', 'isla']) s.requestStaff.push({ shiftId: sh.id, staffProfileId: P[k].id });

  // Notifications (real NotificationType values and server wording).
  const label = 'Riverside House · Waiting staff';
  s.notifications.vm = [{ id: newId(), type: 'shift_request_approved', title: 'Shift request approved', message: `Your request for ${label} was approved and offers are being sent.`, readAt: offerScene ? null : T(20, 11, 20), createdAt: sent }];
  s.notifications.priya = [{ id: newId(), type: 'offer_sent', title: 'New shift offer', message: label, readAt: offerScene ? null : accepted.priya, createdAt: sent }];
  if (!offerScene) {
    notify('priya', { type: 'offer_confirmed', title: 'Shift confirmed', message: 'Your shift offer has been confirmed.', createdAt: accepted.priya, readAt: T(20, 11, 42) });
    notify('priya', { type: 'shift_reminder_24h', title: 'Shift tomorrow', message: `${label} starts tomorrow at 12:00.`, createdAt: T(22, 12), readAt: T(22, 18) });
    notify('priya', { type: 'shift_reminder_2h', title: 'Shift starts soon', message: `${label} starts at 12:00. Scan the shift QR code when you arrive.`, createdAt: T(23, 10), readAt: null });
  }

  if (history) {
    finalisedReport(sh, finalisedAt, true, { name: 'Riley Chen' });
    state.reports[sh.id].originalFileId = addFile(sh.id, 'original', T(23, 18, 44, 30)).id;
    state.reports[sh.id].outbox = [{ status: 'SENT', sentAt: T(23, 18, 53, 5), dueAt: T(23, 18, 53, 5) }];
    state.reports[sh.id].finalQueuedAt = T(23, 18, 52, 40);
    state.files[state.reports[sh.id].finalFileId].generatedAt = T(23, 18, 52, 40);
    sh.status = 'in_progress'; // Isla's seat stays `confirmed` (correction does not complete it), as on the server.
  }

  // Scripted actions of the OTHER people (never the filmed persona), applied when virtual time passes them.
  if (offerScene) {
    s.scripted.push({ at: accepted.leah, label: 'Leah accepts her offer', run: () => acceptOffer(STORY.offer('leah'), accepted.leah) });
  }
  if (scene === 'shiftday') {
    s.scripted.push(
      { at: inAt.grace, label: 'Grace clocks in', run: () => scriptedClockIn('grace', inAt.grace) },
      { at: inAt.isla, label: 'Isla clocks in', run: () => scriptedClockIn('isla', inAt.isla) },
      { at: inAt.leah, label: 'Leah clocks in', run: () => scriptedClockIn('leah', inAt.leah) },
    );
  }
  if (scene === 'shiftday' || scene === 'clockout') {
    if (scene === 'shiftday') s.scripted.push({ at: outAt.grace, label: 'Grace clocks out', run: () => scriptedClockOut('grace', outAt.grace) });
    s.scripted.push({ at: outAt.leah, label: 'Leah clocks out', run: () => scriptedClockOut('leah', outAt.leah) });
  }
}

function scriptedClockIn(k, when) {
  const a = assignmentById(STORY.assignment(k));
  if (!a || a.status !== 'confirmed' || attendanceFor(a.id)) return;
  createAttendance(a, when, false);
}
function scriptedClockOut(k, when) {
  const att = state.attendance.find((x) => x.assignmentId === STORY.assignment(k) && ['clocked_in', 'on_break'].includes(x.status));
  if (att) performClockOut(att, when, 'manual');
}

function applyScene(scene, now) {
  if (scene === 'legacy') {
    if (now) clock.set(now);
    else clock.real();
    buildLegacy();
    return;
  }
  clock.set(now || SCENES[scene]);
  buildStory(scene);
}

// ------------------------------------------------- domain operations ----
function createAttendance(a, when, verified) {
  const att = {
    id: a.shiftId === STORY.shift && ['priya', 'grace', 'leah', 'isla'].includes(personKey(a.staffProfileId)) ? STORY.attendance(personKey(a.staffProfileId)) : newId(),
    assignmentId: a.id, shiftId: a.shiftId, staffProfileId: a.staffProfileId, status: 'clocked_in', clockInAt: when, clockOutAt: null,
    breakMinutes: null, workedMinutes: null, earnedPence: null, locationVerified: verified, clockOutMethod: null,
  };
  state.attendance.push(att);
  const sh = shiftById(a.shiftId);
  if (sh.status !== 'in_progress') sh.status = 'in_progress';
  return att;
}
const personKey = (profileId) => Object.keys(STORY.staff).find((k) => STORY.staff[k] === profileId);

/** AttendanceService.performClockOut: worked/earned from @rab/shared rules, assignment completed, shift roll-up. */
function performClockOut(att, when, method) {
  const a = assignmentById(att.assignmentId);
  att.clockOutAt = when;
  att.status = 'clocked_out';
  att.workedMinutes = workedMinutes(att.clockInAt, when, att.breakMinutes ?? breakOf(a));
  att.earnedPence = payForMinutes(a.payRatePence, att.workedMinutes);
  att.clockOutMethod = method;
  a.status = 'completed';
  const sh = shiftById(a.shiftId);
  const open = state.assignments.filter((x) => x.shiftId === sh.id && ['offered', 'staff_accepted', 'confirmed'].includes(x.status)).length;
  if (open === 0 && sh.status === 'in_progress') sh.status = 'completed';
  return att;
}

/** applyOfferConfirmation: offer manager_confirmed, seat confirmed, filled_count claimed, shift status rolled. */
function confirmOffer(o, when) {
  const sh = shiftById(o.shiftId);
  if (sh.filledCount >= sh.requiredCount) throw httpError(409, 'SHIFT_FULL: This shift is now full. Another offer may already be confirmed.');
  o.status = 'manager_confirmed';
  o.managerConfirmedAt = when;
  assignmentById(o.assignmentId).status = 'confirmed';
  sh.filledCount += 1;
  sh.status = sh.filledCount >= sh.requiredCount ? 'fully_filled' : 'partially_filled';
  const persona = personaForProfile(o.staffProfileId);
  if (persona) {
    notify(persona, { type: 'offer_confirmed', title: 'Shift confirmed', message: 'Your shift offer has been confirmed.', createdAt: when });
    pushEvent(persona, 'offer.confirmed', o.id);
  }
}

/** OfferService.staffAccept. A shift from an approved Venue Manager request (requestedBy set) auto-confirms. */
function acceptOffer(offerId, when) {
  const o = state.offers.find((x) => x.id === offerId);
  const sh = shiftById(o.shiftId);
  if (o.status !== 'pending') throw httpError(409, `Invalid transition from ${o.status} to staff_accepted.`);
  if (sh.status === 'cancelled') throw httpError(409, 'This shift has been cancelled and can no longer be accepted.');
  if (when.getTime() >= sh.endsAt.getTime() + ACTION_WINDOW_HOURS * HOUR) throw httpError(409, 'This shift ended more than 5 hours ago, so this offer can no longer be accepted.');
  if (o.expiresAt.getTime() <= when.getTime()) {
    o.status = 'expired';
    o.respondedAt = when;
    throw httpError(409, 'This offer has expired.');
  }
  o.status = 'staff_accepted';
  o.respondedAt = when;
  o.staffAcceptedAt = when;
  assignmentById(o.assignmentId).status = 'staff_accepted';
  if (sh.requestedBy != null) confirmOffer(o, when);
  return o;
}

// ------------------------------------------- simulated worker jobs -------
function tick() {
  const now = clock.now();
  for (const ev of state.scripted.filter((e) => !e.done && e.at <= now).sort((a, b) => a.at - b.at)) {
    ev.done = true;
    try { ev.run(); } catch (e) { process.stdout.write(`scripted "${ev.label}" skipped: ${e.message}\n`); }
  }
  for (const o of state.offers) {
    if (o.status === 'pending' && o.expiresAt <= now) {
      o.status = 'expired';
      o.respondedAt = o.expiresAt;
    }
  }
  for (const sh of state.shifts) {
    if (['draft', 'pending_manager_approval', 'declined', 'cancelled'].includes(sh.status)) continue;
    const seats = state.assignments.filter((a) => a.shiftId === sh.id);
    // Pre-shift attendance sheet (shift-report-scheduler.job.ts): REPORT_AVAILABLE_BEFORE_MINUTES before start.
    const sheetAt = addMin(sh.startsAt, -REPORT_AVAILABLE_BEFORE_MINUTES);
    if (now >= sheetAt && seats.some((a) => a.status === 'confirmed') && !(state.reports[sh.id] && state.reports[sh.id].preShiftFileId)) {
      const r = state.reports[sh.id] || (state.reports[sh.id] = { shiftId: sh.id, status: 'ready' });
      r.preShiftFileId = addFile(sh.id, 'pre_shift', sheetAt).id;
    }
    for (const a of seats) {
      const t = timeOf(a);
      const att = attendanceFor(a.id);
      // shift-monitor.job.ts: confirmed seat, no attendance, 30 minutes after its start -> no_show.
      if (a.status === 'confirmed' && !att && now >= addMin(t.startsAt, NO_SHOW_GRACE_MINUTES)) a.status = 'no_show';
      // attendance monitor: still open 30 minutes after the seat's scheduled end -> missing_clock_out.
      if (att && ['clocked_in', 'on_break'].includes(att.status) && now >= addMin(t.endsAt, MISSING_CLOCK_OUT_GRACE_MINUTES)) att.status = 'missing_clock_out';
    }
    const r = state.reports[sh.id];
    if (!r) continue;
    const rows = reportRows(sh);
    // final-timesheet.job.ts: the unsigned original once attendance is resolved.
    if (!r.originalFileId && isReportReady(rows)) r.originalFileId = addFile(sh.id, 'original', now).id;
    // Final PDF: rendered after finalise; the delivery marker and outbox rows are written when it is stored.
    if (r.status === 'finalised' && !r.finalFileId && r.pendingFinal) {
      const f = state.files[r.pendingFinal];
      const readyAt = new Date(Math.max(r.finalisedAt.getTime() + PDF_MIN_SECONDS * 1000, f.doneAt ? f.doneAt.getTime() : Infinity));
      if (f.bytes && now >= readyAt) {
        r.finalFileId = f.id;
        f.generatedAt = f.generatedAt || readyAt;
        r.finalQueuedAt = readyAt;
        r.outbox = DELIVERY_MODE === 'no_recipients' ? [] : [{ status: 'PENDING', sentAt: null, dueAt: new Date(readyAt.getTime() + DELIVERY_SECONDS * 1000) }];
      }
    }
    for (const row of r.outbox || []) {
      if (row.status === 'PENDING' && DELIVERY_MODE !== 'queued' && now >= row.dueAt) {
        if (DELIVERY_MODE === 'failed') row.status = 'FAILED';
        else {
          row.status = 'SENT';
          row.sentAt = row.dueAt;
        }
      }
    }
  }
}

// ------------------------------------------------------ projections ------
/** Port of rab-server resolveStaffShiftPresentation (read-only). Post-shift milestones as the worker writes them. */
function presentation(o, serverNow) {
  const sh = shiftById(o.shiftId);
  const a = assignmentById(o.assignmentId);
  const att = attendanceFor(a.id);
  const t = timeOf(a);
  const now = serverNow.getTime();
  const clockInAt = att ? att.clockInAt : null;
  const clockOutAt = att ? att.clockOutAt : null;
  let st;
  let nextTransitionAt = null;
  if (clockOutAt && now >= clockOutAt.getTime()) {
    const complete = clockOutAt.getTime() + POST_SHIFT_COMPLETE_MS;
    const expired = clockOutAt.getTime() + POST_SHIFT_EXPIRED_MS;
    st = now >= expired ? 'expired' : now >= complete ? 'complete' : 'clockedOut';
    nextTransitionAt = st === 'expired' ? null : st === 'complete' ? new Date(expired) : new Date(complete);
  } else if (clockInAt && (clockOutAt || ['clocked_in', 'on_break'].includes(att.status))) {
    st = 'live';
    nextTransitionAt = clockOutAt;
  } else if (sh.status === 'cancelled' || ['cancelled', 'withdrawn'].includes(a.status)) {
    st = 'cancelled';
  } else if (['expired', 'declined', 'withdrawn', 'manager_rejected'].includes(o.status)) {
    st = o.status === 'withdrawn' ? 'cancelled' : o.status === 'manager_rejected' ? 'rejected' : o.status;
  } else if (a.status === 'confirmed' && o.status === 'manager_confirmed') {
    st = now >= t.endsAt.getTime() ? 'ended' : 'confirmed';
  } else if (['no_show', 'completed'].includes(a.status)) {
    st = 'ended';
  } else {
    st = 'pending';
  }
  const isToday = dayKey(t.startsAt) === dayKey(serverNow) || (now >= t.startsAt.getTime() && now < t.endsAt.getTime());
  const homeLabel = st === 'live' ? 'Live Shift'
    : ['clockedOut', 'complete', 'expired'].includes(st) ? { clockedOut: 'Clocked Out', complete: 'Complete', expired: 'Expired' }[st]
      : isToday ? "Today's Shift" : 'Next Shift';
  return { state: st, homeLabel, isToday, serverNow: iso(serverNow), nextTransitionAt: iso(nextTransitionAt), clockInAt: iso(clockInAt), clockOutAt: iso(clockOutAt), timezone: TZ };
}

function offerJson(o, withPresentation) {
  const sh = shiftById(o.shiftId);
  const a = assignmentById(o.assignmentId);
  const t = timeOf(a);
  const p = personById(o.staffProfileId);
  const venue = venueById(sh.venueId);
  return {
    id: o.id, status: o.status, sentAt: iso(o.sentAt), expiresAt: iso(o.expiresAt), respondedAt: iso(o.respondedAt),
    declineReason: o.declineReason, staffAcceptedAt: iso(o.staffAcceptedAt), managerConfirmedAt: iso(o.managerConfirmedAt),
    managerRejectedAt: null, rejectionReason: null, estimatedPayPence: o.estimatedPayPence, shiftId: sh.id,
    startsAt: iso(t.startsAt), endsAt: iso(t.endsAt), venueName: venue.name, roleName: roleById(sh.jobRoleId).name,
    staffProfileId: p.id, staffName: fullName(p), payRatePence: a.payRatePence, venueAddress: venue.address, shiftNotes: sh.notes || null,
    ...(withPresentation ? { presentation: presentation(o, clock.now()) } : {}),
  };
}

/** AttendanceSummary (attendance.service.ts toAttendanceSummary). */
function attendanceJson(att) {
  const a = assignmentById(att.assignmentId);
  const sh = shiftById(att.shiftId);
  const t = timeOf(a);
  const p = personById(att.staffProfileId);
  return {
    id: att.id, status: att.status, clockInAt: iso(att.clockInAt), clockOutAt: iso(att.clockOutAt), workedMinutes: att.workedMinutes,
    earnedPence: att.earnedPence, breakMinutes: att.breakMinutes, locationVerified: att.locationVerified, clockOutMethod: att.clockOutMethod,
    shiftId: sh.id, startsAt: iso(t.startsAt), endsAt: iso(t.endsAt), venueName: venueById(sh.venueId).name, roleName: roleById(sh.jobRoleId).name,
    staffProfileId: p.id, staffName: fullName(p),
  };
}

function shiftJson(sh) {
  return {
    id: sh.id, organisationId: state.orgId, venueId: sh.venueId, jobRoleId: sh.jobRoleId, startsAt: iso(sh.startsAt), endsAt: iso(sh.endsAt),
    defaultStartsAt: iso(sh.defaultStartsAt), defaultEndsAt: iso(sh.defaultEndsAt), status: sh.status, requiredCount: sh.requiredCount,
    filledCount: sh.filledCount, breakMinutes: sh.breakMinutes, payRatePence: sh.payRatePence, address: sh.address, notes: sh.notes,
    createdBy: sh.createdBy, requestedBy: sh.requestedBy, createdAt: iso(sh.createdAt), approvedAt: iso(sh.approvedAt),
  };
}

/** Port of rab-server sentShiftPresentation (current version, with actionExpired + noShow). */
function sentShiftPresentation(status, required, counts, actionExpired) {
  const terminal = ['cancelled', 'completed', 'declined'].includes(status);
  const expired = !terminal && actionExpired;
  const accepted = !terminal && !expired && counts.accepted + counts.confirmed > 0;
  const confirmed = !terminal && required > 0 && counts.confirmed >= required;
  const pending = !terminal && !expired && (status === 'pending_manager_approval' || counts.pending > 0);
  const filters = [
    ...(pending ? ['pending'] : []), ...(accepted ? ['staff_accepted'] : []), ...(confirmed ? ['manager_confirmed'] : []),
    ...(status === 'declined' || (!terminal && counts.declined > 0) ? ['declined'] : []),
    ...(status === 'cancelled' || (!terminal && counts.cancelled > 0) ? ['cancelled'] : []),
    ...(status === 'completed' ? ['completed'] : []),
    ...(!terminal && counts.withdrawn > 0 ? ['withdrawn'] : []),
    ...(!terminal && counts.rejected > 0 ? ['manager_rejected'] : []),
    ...(expired ? ['expired'] : []),
  ];
  const noShowOnly = !terminal && !expired && !accepted && (counts.noShow || 0) > 0;
  const statusLabel = expired ? 'Expired' : noShowOnly ? 'Staff no-show' : status === 'pending_manager_approval' ? 'Waiting for manager approval'
    : status === 'declined' ? 'Request declined' : status === 'cancelled' ? 'Cancelled'
      : status === 'completed' ? 'Completed' : confirmed ? 'Confirmed'
        : accepted ? 'Staff responses received' : counts.pending > 0 ? 'Offers sent'
          : counts.declined > 0 ? 'Staff declined' : counts.cancelled > 0 ? 'Staff cancelled'
            : counts.sent > 0 && counts.withdrawn === counts.sent ? 'Offers withdrawn'
              : counts.sent > 0 && counts.rejected === counts.sent ? 'Offers rejected'
                : counts.sent > 0 ? 'No active offers' : 'Approved — awaiting offers';
  return { statusLabel, filters, actionExpired: expired, counters: { sent: counts.sent > 0, accepted, confirmed } };
}

/** SchedulingService.listSentShifts row + classification (latest offer per recipient). */
function sentShiftRow(sh, now) {
  const latest = new Map();
  for (const o of state.offers.filter((x) => x.shiftId === sh.id).sort((a, b) => b.sentAt - a.sentAt)) {
    if (!latest.has(o.staffProfileId)) latest.set(o.staffProfileId, o);
  }
  const c = { sent: 0, pending: 0, accepted: 0, confirmed: 0, noShow: 0, cancelled: 0, declined: 0, expired: 0, withdrawn: 0, rejected: 0 };
  for (const o of latest.values()) {
    const as = assignmentById(o.assignmentId).status;
    c.sent += 1;
    if (o.status === 'pending' && as === 'offered') c.pending += 1;
    if (as === 'staff_accepted') c.accepted += 1;
    if (['confirmed', 'completed'].includes(as)) c.confirmed += 1;
    if (as === 'no_show') c.noShow += 1;
    if (as === 'cancelled') c.cancelled += 1;
    if (o.status === 'declined') c.declined += 1;
    if (o.status === 'expired') c.expired += 1;
    if (o.status === 'withdrawn') c.withdrawn += 1;
    if (o.status === 'manager_rejected') c.rejected += 1;
  }
  const terminal = ['cancelled', 'completed', 'declined'].includes(sh.status);
  const actionExpiresAt = new Date(sh.endsAt.getTime() + ACTION_WINDOW_HOURS * HOUR);
  const actionExpired = now >= actionExpiresAt;
  const isExpired = !terminal && (actionExpired || (c.sent > 0 && c.expired === c.sent));
  return {
    row: {
      id: sh.id, status: sh.status, requiredCount: sh.requiredCount, filledCount: sh.filledCount,
      startsAt: iso(sh.defaultStartsAt), endsAt: iso(sh.defaultEndsAt), submittedAt: iso(sh.createdAt),
      venueName: venueById(sh.venueId).name, roleName: roleById(sh.jobRoleId).name, actionExpiresAt: iso(actionExpiresAt),
      offerCounts: c, ...sentShiftPresentation(sh.status, sh.requiredCount, c, isExpired),
    },
    c, terminal, isExpired,
  };
}
const SENT_VIEWS = {
  all: (r) => !r.isExpired,
  pending: (r) => !r.isExpired && !r.terminal && (r.row.status === 'pending_manager_approval' || r.c.pending > 0),
  accepted: (r) => !r.isExpired && !r.terminal && r.c.accepted + r.c.confirmed > 0,
  confirmed: (r) => r.row.requiredCount > 0 && r.c.confirmed >= r.row.requiredCount && !r.terminal && !r.isExpired,
  declined: (r) => (r.row.status === 'declined' || (!r.terminal && r.c.declined > 0)) && !r.isExpired,
  expired: (r) => r.isExpired,
};

// --------------------------------------------------- report projection ---
const REPORT_SEAT = ['confirmed', 'completed', 'no_show'];
function reportRows(sh) {
  const role = roleById(sh.jobRoleId).name;
  return state.assignments
    .filter((a) => a.shiftId === sh.id && REPORT_SEAT.includes(a.status))
    .map((a) => ({ a, p: personById(a.staffProfileId), att: attendanceFor(a.id) }))
    .sort((x, y) => x.p.firstName.localeCompare(y.p.firstName) || x.p.lastName.localeCompare(y.p.lastName) || x.a.id.localeCompare(y.a.id))
    .map(({ a, p, att }) => {
      const t = timeOf(a);
      return {
        staffProfileId: p.id, avatarFileId: null, staffName: fullName(p), roleName: role, scheduledStart: iso(t.startsAt), scheduledEnd: iso(t.endsAt),
        assignmentStatus: a.status, attendanceId: att ? att.id : null, attendanceStatus: att ? att.status : null,
        clockInAt: att ? iso(att.clockInAt) : null, clockOutAt: att ? iso(att.clockOutAt) : null, breakMinutes: att ? att.breakMinutes : null,
        scheduledBreakMinutes: breakOf(a), workedMinutes: att ? att.workedMinutes : null, earnedPence: att ? att.earnedPence : null,
        locationVerified: att ? !!att.locationVerified : false, clockOutMethod: att ? att.clockOutMethod : null,
        corrected: !!att && state.corrections.some((c) => c.attendanceId === att.id),
        performanceReviewed: !!state.reviews[`${sh.id}:${p.id}`],
        attendanceReviewed: !!a.attendanceReviewedAt, attendanceReviewedAt: iso(a.attendanceReviewedAt),
        attendanceReviewedByName: a.attendanceReviewedBy ? userName(a.attendanceReviewedBy) : null,
      };
    });
}
/** report-readiness.ts */
const isReportReady = (rows) => rows.length > 0 && rows.every((r) => !['clocked_in', 'on_break'].includes(r.attendanceStatus || '') && (r.assignmentStatus === 'no_show' || !!r.clockOutAt));
const isReportFinalisable = (rows) => isReportReady(rows) && rows.every((r) => r.attendanceReviewed);

function deliveryCounts(r) {
  const rows = r && r.finalFileId ? r.outbox || [] : [];
  const sentRows = rows.filter((x) => x.status === 'SENT');
  return {
    pending: rows.filter((x) => x.status === 'PENDING').length, sent: sentRows.length, failed: rows.filter((x) => x.status === 'FAILED').length,
    lastSentAt: sentRows.length ? new Date(Math.max(...sentRows.map((x) => x.sentAt.getTime()))) : null,
  };
}
const REPORT_DISPLAY_LABEL = {
  cancelled: 'Cancelled', upcoming: 'Upcoming', waiting_clock_in: 'Waiting for clock-in', in_progress: 'In progress',
  waiting_clock_out: 'Waiting for clock-out', needs_review: 'Needs review', ready_to_finalise: 'Ready to finalise',
  generating: 'Generating PDF', queued: 'Queued for delivery', sent: 'Sent', delivery_failed: 'Delivery failed', action_expired: 'Action expired',
};
/** report-lifecycle.ts reportLifecycle + deliveryState. */
function lifecycle(sh, rows, r, now) {
  const reportStatus = r ? r.status : 'pending';
  const d = deliveryCounts(r);
  const delivery = reportStatus !== 'finalised' ? 'not_finalised' : !r.finalQueuedAt ? 'generating' : d.pending > 0 ? 'queued' : d.failed > 0 ? 'failed' : d.sent > 0 ? 'sent' : 'no_recipients';
  const t = now.getTime();
  const expiresAt = sh.endsAt.getTime() + ACTION_WINDOW_HOURS * HOUR;
  const actionExpired = t >= expiresAt;
  const delivered = delivery === 'sent';
  const ended = t >= sh.endsAt.getTime();
  const openAttendance = rows.filter((x) => ['clocked_in', 'on_break'].includes(x.attendanceStatus)).length;
  const unresolved = rows.filter((x) => x.assignmentStatus !== 'no_show' && !x.clockOutAt).length;
  const unreviewed = rows.filter((x) => !x.attendanceReviewed).length;
  const anyClockIn = rows.some((x) => x.attendanceId !== null);
  const needsAttendanceReview = ended && !delivered && reportStatus !== 'finalised' && openAttendance + unresolved + unreviewed > 0;
  let status;
  if (sh.status === 'cancelled') status = 'cancelled';
  else if (delivery === 'sent') status = 'sent';
  else if (delivery === 'failed' || delivery === 'no_recipients') status = 'delivery_failed';
  else if (delivery === 'queued') status = 'queued';
  else if (delivery === 'generating') status = 'generating';
  else if (actionExpired) status = 'action_expired';
  else if (t < sh.startsAt.getTime()) status = rows.length > 0 ? 'waiting_clock_in' : 'upcoming';
  else if (!ended) status = openAttendance > 0 || anyClockIn ? 'in_progress' : 'waiting_clock_in';
  else if (openAttendance > 0) status = 'waiting_clock_out';
  else if (unresolved > 0 || unreviewed > 0) status = 'needs_review';
  else status = 'ready_to_finalise';
  const historyAtMs = delivered && d.lastSentAt ? d.lastSentAt.getTime() + SENT_VISIBLE_HOURS * HOUR : delivered ? null : expiresAt;
  const inHistory = historyAtMs !== null && t >= historyAtMs;
  const needsAttention = sh.status !== 'cancelled' && !delivered && (actionExpired || delivery === 'failed' || delivery === 'no_recipients');
  return {
    displayStatus: status, displayLabel: REPORT_DISPLAY_LABEL[status], actionExpiresAt: new Date(expiresAt).toISOString(), actionExpired,
    needsAttendanceReview, needsAttention, deliveryState: delivery, sentAt: delivered && d.lastSentAt ? d.lastSentAt.toISOString() : null,
    historyAt: historyAtMs === null ? null : new Date(historyAtMs).toISOString(), inCurrent: !inHistory || needsAttention, inHistory,
  };
}
const fileRef = (id) => (id && state.files[id] ? { fileId: id, filename: state.files[id].filename } : null);
/** report-actions.ts */
function reportActions(sh, reportStatus, ready, preShift, final, now) {
  const availableAt = sh.startsAt.getTime() - REPORT_AVAILABLE_BEFORE_MINUTES * MIN;
  const pre = preShift ? { kind: 'pre_shift', ...preShift } : null;
  const fin = final ? { kind: 'final', ...final } : null;
  const base = { timesheetAvailableAt: new Date(availableAt).toISOString(), preShiftDocument: pre };
  if (reportStatus === 'finalised') {
    return { ...base, stage: 'finalised', timesheet: fin || pre ? 'available' : 'preparing', finalise: 'hidden', document: fin || pre, finalDocumentPending: !fin };
  }
  if (now.getTime() < availableAt) return { ...base, stage: 'scheduled', timesheet: 'hidden', finalise: 'hidden', document: null, finalDocumentPending: false };
  const timesheet = pre ? 'available' : 'preparing';
  if (now.getTime() < sh.startsAt.getTime()) return { ...base, stage: 'pre_shift', timesheet, finalise: 'hidden', document: pre, finalDocumentPending: false };
  return { ...base, stage: 'started', timesheet, finalise: sh.status === 'cancelled' ? 'hidden' : ready ? 'enabled' : 'disabled', document: pre, finalDocumentPending: false };
}
/** ShiftReportService.getReportWithManager */
function reportDetail(sh) {
  const now = clock.now();
  const r = state.reports[sh.id] || null;
  const staff = reportRows(sh);
  const reportStatus = r ? r.status : 'pending';
  const pre = fileRef(r && r.preShiftFileId);
  const fin = fileRef(r && r.finalFileId);
  const opens = sh.startsAt.getTime() - CLOCK_IN_EARLY_MINUTES * MIN;
  const closes = sh.endsAt.getTime() + QR_POST_SHIFT_GRACE_MINUTES * MIN;
  const finaliser = r && r.finalisedBy ? userName(r.finalisedBy) : null;
  return {
    shiftId: sh.id, venueName: venueById(sh.venueId).name, roleName: roleById(sh.jobRoleId).name, startsAt: iso(sh.startsAt), endsAt: iso(sh.endsAt),
    reportStatus, finalisedAt: iso(r && r.finalisedAt), finalisedBy: (r && r.finalisedBy) || null, finalisedByName: finaliser,
    originalFileId: (r && r.originalFileId) || null, signedFileId: (r && r.finalFileId) || null,
    ready: isReportReady(staff), staff, finalisable: reportStatus !== 'finalised' && isReportFinalisable(staff),
    reviewsRemaining: staff.filter((x) => !x.attendanceReviewed).length, lifecycle: lifecycle(sh, staff, r, now), serverNow: iso(now),
    qrWindow: { opensAt: new Date(opens).toISOString(), closesAt: new Date(closes).toISOString(), state: now.getTime() < opens ? 'not_open' : now.getTime() < closes ? 'open' : 'closed' },
    actions: reportActions(sh, reportStatus, isReportFinalisable(staff), pre, fin, now),
    preShiftFile: pre, finalFile: fin,
    signOff: r && r.signedOffName ? { name: r.signedOffName, breakConfirmed: !!r.breakConfirmed, signedBy: finaliser, signedAt: iso(r.finalisedAt) } : null,
  };
}
function reportSummary(sh, now) {
  const r = state.reports[sh.id] || null;
  const rows = reportRows(sh);
  return {
    shiftId: sh.id, venueName: venueById(sh.venueId).name, roleName: roleById(sh.jobRoleId).name, startsAt: iso(sh.startsAt), endsAt: iso(sh.endsAt),
    shiftStatus: sh.status, requiredCount: sh.requiredCount, filledCount: sh.filledCount, staffCount: rows.length,
    clockedOut: rows.filter((x) => x.clockOutAt).length, noShows: rows.filter((x) => x.assignmentStatus === 'no_show').length,
    reportStatus: r ? r.status : 'pending', lifecycle: lifecycle(sh, rows, r, now),
  };
}

// ------------------------------------------------------------ files ------
function documentInfo(sh, generatedAt) {
  return {
    venueName: venueById(sh.venueId).name, venueAddress: sh.address, roleName: roleById(sh.jobRoleId).name, department: null,
    startsAt: iso(sh.startsAt), endsAt: iso(sh.endsAt), contactName: null, contactPhone: null,
    shiftReference: docs.shiftReference(sh.id, sh.startsAt, TZ), workspaceName: state.workspaceName, notes: sh.notes || null,
    timezone: TZ, generatedAt: iso(generatedAt || clock.now()),
  };
}
/** Data the worker jobs pass to the real templates (final-timesheet.job.ts / shift-report-scheduler.job.ts). */
function renderFile(f) {
  const sh = shiftById(f.shiftId);
  const role = roleById(sh.jobRoleId).name;
  const seats = state.assignments.filter((a) => a.shiftId === sh.id).map((a) => ({ a, p: personById(a.staffProfileId) }))
    .sort((x, y) => x.p.firstName.localeCompare(y.p.firstName) || x.p.lastName.localeCompare(y.p.lastName));
  if (f.kind === 'pre_shift') {
    const staff = seats.filter(({ a }) => ['confirmed', 'completed', 'no_show'].includes(a.status)).map(({ a, p }) => ({
      name: fullName(p), staffRef: p.staffRef, roleName: role, scheduledStart: iso(timeOf(a).startsAt), scheduledEnd: iso(timeOf(a).endsAt), breakMinutes: breakOf(a),
    }));
    return docs.renderPreShiftPdf(documentInfo(sh, f.generatedAt), staff, `fixture-demo-shift-qr:${sh.id}`);
  }
  const r = state.reports[sh.id] || {};
  const staff = seats.filter(({ a }) => REPORT_SEAT.includes(a.status)).map(({ a, p }) => {
    const att = attendanceFor(a.id);
    const rv = state.reviews[`${sh.id}:${p.id}`];
    return {
      name: fullName(p), staffRef: p.staffRef, roleName: role, assignmentStatus: a.status,
      review: rv ? { grooming: rv.grooming, attitude: rv.attitude, skills: rv.skills, attendance: rv.attendance, timeKeeping: rv.timeKeeping } : null,
      scheduledStart: iso(timeOf(a).startsAt), scheduledEnd: iso(timeOf(a).endsAt), clockInAt: att ? iso(att.clockInAt) : null,
      clockOutAt: att ? iso(att.clockOutAt) : null, breakMinutes: att && att.breakMinutes != null ? att.breakMinutes : breakOf(a),
      workedMinutes: att ? att.workedMinutes : null, status: att ? att.status : 'absent', corrected: !!att && state.corrections.some((c) => c.attendanceId === att.id),
    };
  });
  return docs.renderFinalTimesheetPdf(documentInfo(sh, f.generatedAt), {
    staff, unsigned: f.kind === 'original', finalisedByName: r.finalisedBy ? userName(r.finalisedBy) : 'Venue Manager',
    finalisedAt: iso(r.finalisedAt || clock.now()), signedOffName: r.signedOffName || null, breakConfirmed: r.breakConfirmed ?? null,
  });
}
function ensureBytes(f) {
  if (f.bytes) return Promise.resolve(f.bytes);
  if (!f.promise) {
    const gen = state;
    f.promise = renderFile(f).then((b) => {
      f.bytes = b;
      if (gen === state) f.doneAt = clock.now();
      return b;
    }, (e) => {
      f.promise = null;
      f.error = e.message;
      throw e;
    });
  }
  return f.promise;
}

// -------------------------------------------------------- realtime -------
const sseClients = new Set(); // { res, persona }
function pushEvent(persona, type, entityId) {
  const envelope = {
    version: 1, eventId: crypto.randomUUID(), type, organisationId: state.orgId, workspaceId: null,
    targetUserId: PERSONAS[persona].id, entityId, occurredAt: clock.now().toISOString(),
  };
  for (const c of sseClients) if (c.persona === persona) c.res.write(`id: ${envelope.eventId}\ndata: ${JSON.stringify(envelope)}\n\n`);
  return envelope;
}
setInterval(() => {
  for (const c of sseClients) c.res.write(': keep-alive\n\n');
}, 15000).unref();

// --------------------------------------------------------- http ----------
function sign(kind, persona) {
  const body = `fx-${kind}-${persona}-${crypto.randomBytes(8).toString('hex')}`;
  return `${body}.${crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('hex').slice(0, 32)}`;
}
/** Persona for a token of `kind`, or null. HMAC-checked, so a restart keeps sessions but forged tokens fail. */
function verify(kind, token) {
  const m = /^fx-(access|refresh)-(staff|priya|vm)-[0-9a-f]{16}\.([0-9a-f]{32})$/.exec(token || '');
  if (!m || m[1] !== kind) return null;
  const body = token.slice(0, token.lastIndexOf('.'));
  const mac = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('hex').slice(0, 32);
  return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(m[3])) ? m[2] : null;
}
const issueTokens = (persona) => ({ accessToken: sign('access', persona), refreshToken: sign('refresh', persona) });

class HttpError extends Error {
  constructor(status, body) {
    super(typeof body === 'string' ? body : body.message);
    this.status = status;
    this.body = typeof body === 'string' ? { statusCode: status, message: body, error: { 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict' }[status] } : body;
  }
}
const httpError = (status, body) => new HttpError(status, body);
const badRequest = (messages) => httpError(400, { statusCode: 400, message: [].concat(messages), error: 'Bad Request' });

function send(res, status, body, headers = {}) {
  if (body === undefined || status === 204) {
    res.writeHead(status, headers);
    return res.end();
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...headers });
  res.end(text);
}
const notFound = (res, message = 'Not found') => send(res, 404, { statusCode: 404, message, error: 'Not Found' });

function paginate(rows, query, defLimit = 100) {
  const page = Math.max(1, Number(query.get('page') || 1));
  const limit = Math.max(1, Math.min(100, Number(query.get('limit') || defLimit)));
  return { data: rows.slice((page - 1) * limit, page * limit), total: rows.length, page, limit };
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        const v = JSON.parse(raw);
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : { __invalid: true });
      } catch {
        resolve({ __invalid: true });
      }
    });
  });
}
/** forbidNonWhitelisted. */
function onlyKeys(body, allowed) {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) throw badRequest(extra.map((k) => `property ${k} should not exist`));
}
const uuidParam = (v) => {
  if (!isUuid(v)) throw httpError(400, { statusCode: 400, message: 'Validation failed (uuid is expected)', error: 'Bad Request' });
  return v;
};
const isIsoDate = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}/.test(v);
const isInt = (v) => Number.isInteger(v);

function log(req, status, persona) {
  const t = new Date().toISOString().slice(11, 19);
  const v = clock.virtual() ? ` @${clock.now().toISOString().slice(0, 19)}Z` : '';
  process.stdout.write(`${t}${v} ${req.method} ${req.url} -> ${status}${persona ? ' [' + persona + ']' : ''}\n`);
}

// ----------------------------------------------------- route handlers ----
function staffRoutes(req, p, q, body, persona) {
  const now = clock.now();
  const profileId = state.personaProfile[persona];
  const me = profileId ? personById(profileId) : null;
  let m;
  if (req.method === 'GET' && p === '/offers/mine') {
    const rows = me ? state.offers.filter((o) => o.staffProfileId === me.id).sort((a, b) => b.sentAt - a.sentAt) : [];
    return [200, rows.map((o) => offerJson(o, true))];
  }
  if (req.method === 'POST' && (m = p.match(/^\/offers\/([^/]+)\/(accept|decline)$/))) {
    const o = me && state.offers.find((x) => x.id === m[1] && x.staffProfileId === me.id);
    if (!o) throw httpError(404, 'Offer not found.');
    if (m[2] === 'accept') {
      onlyKeys(body, []);
      acceptOffer(o.id, now);
      return [201, offerJson(o, false)];
    }
    onlyKeys(body, ['reason']);
    if (body.reason !== undefined && typeof body.reason !== 'string') throw badRequest('reason must be a string');
    if (o.status !== 'pending') throw httpError(409, `Invalid transition from ${o.status} to declined.`);
    o.status = 'declined';
    o.respondedAt = now;
    o.declineReason = body.reason || null;
    assignmentById(o.assignmentId).status = 'declined';
    return [201, offerJson(o, false)];
  }
  if (req.method === 'GET' && p === '/attendance/me/active') {
    const att = me && state.attendance.find((a) => a.staffProfileId === me.id && ['clocked_in', 'on_break'].includes(a.status));
    return [200, { attendance: att ? attendanceJson(att) : null, serverNow: iso(now), clockInEarlyMinutes: CLOCK_IN_EARLY_MINUTES }];
  }
  if (req.method === 'GET' && p === '/attendance/me/history') {
    const rows = me ? state.attendance.filter((a) => a.staffProfileId === me.id && ['clocked_out', 'under_review', 'approved', 'disputed', 'missing_clock_out'].includes(a.status)) : [];
    return [200, rows.sort((a, b) => b.clockInAt - a.clockInAt).map(attendanceJson)];
  }
  if (req.method === 'GET' && (m = p.match(/^\/attendance\/me\/shift\/([^/]+)\/team$/))) {
    const shiftId = uuidParam(m[1]);
    const sh = shiftById(shiftId);
    const mine = me && sh && state.assignments.find((a) => a.shiftId === shiftId && a.staffProfileId === me.id && a.status === 'confirmed');
    if (!sh || ['cancelled', 'completed'].includes(sh.status) || !mine) throw httpError(404, 'Shift not found.');
    const rows = state.assignments.filter((a) => a.shiftId === shiftId && a.status === 'confirmed').map((a) => ({ a, pp: personById(a.staffProfileId), t: timeOf(a) }))
      .sort((x, y) => x.t.startsAt - y.t.startsAt || x.pp.firstName.localeCompare(y.pp.firstName) || x.a.id.localeCompare(y.a.id));
    return [200, rows.map(({ a, pp, t }) => ({ displayName: pp.firstName.trim() || 'Team member', startsAt: iso(t.startsAt), endsAt: iso(t.endsAt), isYou: a.staffProfileId === me.id }))];
  }
  if (req.method === 'GET' && (m = p.match(/^\/attendance\/me\/shift\/([^/]+)$/))) {
    const att = me && state.attendance.find((a) => a.staffProfileId === me.id && a.shiftId === m[1]);
    return [200, att ? attendanceJson(att) : null];
  }
  if (req.method === 'POST' && (p === '/attendance/clock-in' || p === '/attendance/clock-out')) {
    const isIn = p.endsWith('clock-in');
    onlyKeys(body, isIn ? ['shiftId', 'qrToken', 'lat', 'lng', 'accuracyM'] : ['qrToken', 'lat', 'lng', 'accuracyM']);
    const errors = [];
    if (isIn && !isUuid(body.shiftId)) errors.push('shiftId must be a UUID');
    if (typeof body.qrToken !== 'string') errors.push('qrToken must be a string');
    if (typeof body.qrToken !== 'string' || !body.qrToken.trim()) errors.push('qrToken should not be empty');
    for (const [k, lo, hi] of [['lat', -90, 90], ['lng', -180, 180], ['accuracyM', 0, Infinity]]) {
      if (body[k] !== undefined && (typeof body[k] !== 'number' || !Number.isFinite(body[k]) || body[k] < lo || body[k] > hi)) errors.push(`${k} must be a valid number`);
    }
    if (errors.length) throw badRequest(errors);
    if (!me) throw httpError(404, 'Staff profile not found.');
    if (isIn) {
      const a = state.assignments.find((x) => x.shiftId === body.shiftId && x.staffProfileId === me.id);
      if (!a) throw httpError(404, 'Shift not found.');
      if (a.status !== 'confirmed') throw httpError(409, 'This shift is not confirmed for you.');
      const sh = shiftById(a.shiftId);
      if (['cancelled', 'completed'].includes(sh.status)) throw httpError(409, 'This shift is not open for attendance.');
      const t = timeOf(a);
      const earliest = addMin(t.startsAt, -CLOCK_IN_EARLY_MINUTES);
      if (now < earliest) throw httpError(409, { statusCode: 409, code: 'CLOCK_IN_TOO_EARLY', message: `Too early to clock in — this shift starts at ${iso(t.startsAt)}.`, shiftStart: iso(t.startsAt), availableAt: iso(earliest) });
      if (now > addMin(t.endsAt, QR_POST_SHIFT_GRACE_MINUTES)) throw httpError(409, { statusCode: 409, code: 'CLOCK_WINDOW_CLOSED', message: "This shift's clock-in/out window has closed." });
      // QR: required (non-empty, checked above) but NOT validated by the fixture. GPS: not evaluated (verified=false).
      if (state.attendance.some((x) => x.staffProfileId === me.id && ['clocked_in', 'on_break'].includes(x.status))) throw httpError(409, 'You already have an active clock-in — clock out first.');
      if (attendanceFor(a.id)) throw httpError(409, 'You already have an attendance record for this shift.');
      return [201, attendanceJson(createAttendance(a, now, false))];
    }
    const att = state.attendance.find((x) => x.staffProfileId === me.id && ['clocked_in', 'on_break'].includes(x.status));
    if (!att) throw httpError(404, 'No active clock-in found.');
    return [201, attendanceJson(performClockOut(att, now, 'manual'))];
  }
  if (req.method === 'POST' && p === '/attendance/geofence-exit') {
    throw httpError(409, 'Geofence exit is not evaluated by the documentation fixture.');
  }
  return null;
}

function vmTeamRow(st, q) {
  const tag = state.vm.team.get(st.id);
  const row = { id: st.id, firstName: st.firstName, lastName: st.lastName, employmentStatus: st.employmentStatus, jobRoleName: st.jobRoleName, isFavourite: tag.isFavourite, isEmergency: tag.isEmergency };
  if (q.get('startAt') && q.get('endAt')) row.available = !busyStaff([st.id], new Date(q.get('startAt')), new Date(q.get('endAt')), q.get('excludeShiftId')).has(st.id);
  return row;
}
/** AvailabilityService.findBusyStaffIds: a CONFIRMED seat overlapping [startsAt, endsAt). */
function busyStaff(ids, startsAt, endsAt, excludeShiftId) {
  const busy = new Set();
  for (const a of state.assignments) {
    if (!ids.includes(a.staffProfileId) || a.status !== 'confirmed' || (excludeShiftId && a.shiftId === excludeShiftId)) continue;
    const t = timeOf(a);
    if (t.startsAt < endsAt && t.endsAt > startsAt) busy.add(a.staffProfileId);
  }
  return busy;
}
const inScope = (sh) => sh && state.vm.venueIds.includes(sh.venueId);
const scopedShift = (id) => {
  const sh = shiftById(id);
  if (!inScope(sh)) throw httpError(404, 'Shift not found.');
  return sh;
};

function vmRoutes(req, p, q, body) {
  const now = clock.now();
  let m;
  if (req.method === 'GET' && p === '/shifts') {
    return [200, paginate(state.shifts.filter(inScope).sort((a, b) => a.startsAt - b.startsAt).map(shiftJson), q)];
  }
  if (req.method === 'GET' && (p === '/shifts/sent' || (m = p.match(/^\/shifts\/sent\/([^/]+)$/)))) {
    const view = q.get('view') || 'all';
    if (!m && !SENT_VIEWS[view]) throw badRequest('view must be one of the following values: all, pending, accepted, confirmed, declined, expired');
    const rows = state.shifts.filter((sh) => sh.requestedBy === state.vm.userId && inScope(sh)).map((sh) => sentShiftRow(sh, now))
      .sort((a, b) => b.row.submittedAt.localeCompare(a.row.submittedAt) || b.row.id.localeCompare(a.row.id));
    if (m) {
      const one = rows.find((r) => r.row.id === m[1]);
      if (!one) throw httpError(404, 'Shift not found.');
      return [200, one.row];
    }
    const counts = Object.fromEntries(Object.entries(SENT_VIEWS).map(([k, f]) => [k, rows.filter(f).length]));
    counts.submitted = rows.length;
    const pg = paginate(rows.filter(SENT_VIEWS[view]).map((r) => r.row), q);
    return [200, { data: pg.data, total: pg.total, view, counts }];
  }
  if (req.method === 'GET' && (m = p.match(/^\/shifts\/([^/]+)$/))) {
    if (!isUuid(m[1])) throw httpError(404, 'Shift not found.');
    return [200, shiftJson(scopedShift(m[1]))];
  }
  if (req.method === 'GET' && p === '/venues') return [200, paginate(state.venues.filter((v) => state.vm.venueIds.includes(v.id)).map((v) => ({ id: v.id, name: v.name, address: v.address, defaultBreakMinutes: v.defaultBreakMinutes })), q)];
  if (req.method === 'GET' && p === '/job-roles') return [200, paginate(state.roles, q)];
  if (req.method === 'GET' && p === '/offers') {
    return [200, paginate(state.offers.filter((o) => inScope(shiftById(o.shiftId))).sort((a, b) => b.sentAt - a.sentAt).map((o) => offerJson(o, false)), q)];
  }
  if (req.method === 'GET' && p === '/staff/venue-directory') {
    const tag = q.get('tag');
    if (tag && !['favourite', 'emergency'].includes(tag)) throw badRequest('tag must be one of the following values: favourite, emergency');
    for (const k of ['startAt', 'endAt']) if (q.get(k) && !isIsoDate(q.get(k))) throw badRequest(`${k} must be a valid ISO 8601 date string`);
    if (q.get('excludeShiftId') && !isUuid(q.get('excludeShiftId'))) throw badRequest('excludeShiftId must be a UUID');
    const term = (q.get('q') || '').trim().toLowerCase();
    const status = q.get('status');
    const rows = state.people
      .filter((s) => state.vm.team.has(s.id))
      .filter((s) => !tag || (tag === 'favourite' ? state.vm.team.get(s.id).isFavourite : state.vm.team.get(s.id).isEmergency))
      .filter((s) => !term || s.firstName.toLowerCase().includes(term) || s.lastName.toLowerCase().includes(term) || fullName(s).toLowerCase().includes(term))
      .filter((s) => !status || s.employmentStatus === status)
      .sort((a, b) => a.firstName.localeCompare(b.firstName) || a.id.localeCompare(b.id));
    const pg = paginate(rows, q, 50);
    return [200, { data: pg.data.map((s) => vmTeamRow(s, q)), total: pg.total }];
  }
  if ((m = p.match(/^\/staff\/venue-directory\/([^/]+)(\/tags)?$/)) && ((req.method === 'GET' && !m[2]) || (req.method === 'PATCH' && m[2]))) {
    const id = uuidParam(m[1]);
    const st = personById(id);
    const tag = state.vm.team.get(id);
    if (req.method === 'PATCH') {
      onlyKeys(body, ['favourite', 'emergency']);
      for (const k of ['favourite', 'emergency']) if (body[k] !== undefined && typeof body[k] !== 'boolean') throw badRequest(`${k} must be a boolean value`);
      if (body.favourite === undefined && body.emergency === undefined) throw httpError(400, 'Nothing to update.');
      if (!st || !tag) throw httpError(404, 'Staff member not found.');
      if (body.favourite !== undefined) tag.isFavourite = body.favourite;
      if (body.emergency !== undefined) tag.isEmergency = body.emergency;
      return [200, { isFavourite: tag.isFavourite, isEmergency: tag.isEmergency }];
    }
    if (!st || !tag) throw httpError(404, 'Staff member not found.');
    // StaffService.venueTeamMember: operational fields only (no contact details, pay or emergency contacts).
    return [200, {
      id: st.id, firstName: st.firstName, lastName: st.lastName, jobRoleName: st.jobRoleName, employmentType: st.employmentType,
      yearsExperience: st.yearsExperience, preferredShiftTimes: st.preferredShiftTimes, maxHoursPerWeek: st.maxHoursPerWeek,
      isFavourite: tag.isFavourite, isEmergency: tag.isEmergency, skills: st.skills || [], availableDays: st.availableDays || [],
    }];
  }
  if (req.method === 'POST' && p === '/shifts/request') return [201, submitRequest(body, now)];
  if (req.method === 'POST' && /^\/shifts\/[^/]+\/offers(\/bulk)?$/.test(p)) {
    // OfferController: @ManagerApplication() — a venue_manager_app session is refused.
    throw httpError(403, { code: 'APPLICATION_ACCESS_DENIED', message: 'This account does not have access to the Manager system.' });
  }
  if (req.method === 'GET' && p === '/attendance/report/shifts') {
    const bucket = q.get('bucket');
    if (!['current', 'history'].includes(bucket)) throw badRequest('bucket must be one of the following values: current, history');
    const rows = state.shifts.filter((sh) => inScope(sh) && !['draft', 'pending_manager_approval', 'declined'].includes(sh.status)).map((sh) => reportSummary(sh, now));
    const picked = bucket === 'history'
      ? rows.filter((r) => r.lifecycle.inHistory).sort((a, b) => b.endsAt.localeCompare(a.endsAt) || a.shiftId.localeCompare(b.shiftId))
      : rows.filter((r) => !r.lifecycle.inHistory || r.lifecycle.needsAttention)
        .sort((a, b) => Number(b.lifecycle.needsAttention) - Number(a.lifecycle.needsAttention) || a.startsAt.localeCompare(b.startsAt) || a.shiftId.localeCompare(b.shiftId));
    const pg = paginate(picked, q, 50);
    return [200, { data: pg.data, total: pg.total, serverNow: iso(now) }];
  }
  if (req.method === 'GET' && (m = p.match(/^\/attendance\/report\/shift\/([^/]+)$/))) {
    return [200, reportDetail(scopedShift(m[1]))];
  }
  if (req.method === 'PATCH' && (m = p.match(/^\/attendance\/report\/shift\/([^/]+)\/finalise$/))) {
    finalise(m[1], body, now);
    return [200, reportDetail(scopedShift(m[1]))];
  }
  if (req.method === 'POST' && (m = p.match(/^\/attendance\/report\/shift\/([^/]+)\/staff\/([^/]+)\/attendance-review$/))) {
    onlyKeys(body, []);
    return [200, reviewAttendance(uuidParam(m[1]), uuidParam(m[2]), now)];
  }
  if ((m = p.match(/^\/attendance\/report\/shift\/([^/]+)\/reviews\/([^/]+)$/)) && ['GET', 'PUT'].includes(req.method)) {
    const sh = scopedShift(uuidParam(m[1]));
    const staffId = uuidParam(m[2]);
    if (!state.assignments.some((a) => a.shiftId === sh.id && a.staffProfileId === staffId && REPORT_SEAT.includes(a.status))) throw httpError(404, 'Staff member not found on this shift.');
    const finalised = state.reports[sh.id] && state.reports[sh.id].status === 'finalised';
    const key = `${sh.id}:${staffId}`;
    if (req.method === 'GET') return [200, { review: state.reviews[key] ? reviewJson(state.reviews[key]) : null, editable: !finalised }];
    const cats = ['grooming', 'attitude', 'skills', 'attendance', 'timeKeeping'];
    onlyKeys(body, [...cats, 'feedback']);
    const errors = [];
    for (const k of cats) {
      const n = typeof body[k] === 'string' ? Number(body[k]) : body[k];
      if (!isInt(n) || n < 1 || n > 5) errors.push(`${k} must be an integer between 1 and 5`);
    }
    if (body.feedback !== undefined && (typeof body.feedback !== 'string' || body.feedback.length > 2000)) errors.push('feedback must be a string of at most 2000 characters');
    if (errors.length) throw badRequest(errors);
    if (finalised) throw httpError(409, 'This shift report has been finalised; its staff reviews can no longer be changed.');
    const prev = state.reviews[key];
    state.reviews[key] = {
      shiftId: sh.id, staffProfileId: staffId, ...Object.fromEntries(cats.map((k) => [k, Number(body[k])])),
      feedback: body.feedback && body.feedback.trim() ? body.feedback.trim() : null, reviewerUserId: state.vm.userId,
      createdAt: prev ? prev.createdAt : now, updatedAt: now,
    };
    return [200, reviewJson(state.reviews[key])];
  }
  if (req.method === 'POST' && (m = p.match(/^\/attendance\/([^/]+)\/correct$/))) return [201, correctAttendance(m[1], body, now)];
  if (req.method === 'GET' && (m = p.match(/^\/files\/([^/]+)\/download$/))) return ['file', m[1]];
  return null;
}
const reviewJson = (r) => ({ ...r, reviewerName: userName(r.reviewerUserId), createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt) });

/** SchedulingService.submitRequest */
function submitRequest(body, now) {
  const allowed = ['venueId', 'jobRoleId', 'startsAt', 'endsAt', 'staffRequired', 'staffProfileIds', 'breakMinutes', 'staffAssignments', 'note', 'acknowledgedAvailabilityConflicts'];
  onlyKeys(body, allowed);
  const errors = [];
  if (!isUuid(body.venueId)) errors.push('venueId must be a UUID');
  if (!isUuid(body.jobRoleId)) errors.push('jobRoleId must be a UUID');
  if (!isIsoDate(body.startsAt)) errors.push('startsAt must be a valid ISO 8601 date string');
  if (!isIsoDate(body.endsAt)) errors.push('endsAt must be a valid ISO 8601 date string');
  const required = typeof body.staffRequired === 'string' ? Number(body.staffRequired) : body.staffRequired;
  if (!isInt(required) || required < 1 || required > 500) errors.push('staffRequired must be an integer between 1 and 500');
  const ids = body.staffProfileIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 500 || !ids.every(isUuid) || new Set(ids).size !== ids.length) errors.push('staffProfileIds must be 1-500 unique UUIDs');
  if (body.breakMinutes !== undefined && (!isInt(body.breakMinutes) || body.breakMinutes < 0)) errors.push('breakMinutes must not be less than 0');
  if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 2000)) errors.push('note must be a string of at most 2000 characters');
  const assignments = body.staffAssignments === undefined ? [] : body.staffAssignments;
  if (!Array.isArray(assignments) || assignments.some((a) => !a || !isUuid(a.staffProfileId) || !isIsoDate(a.startsAt) || !isIsoDate(a.endsAt) || (a.breakMinutes != null && (!isInt(a.breakMinutes) || a.breakMinutes < 0)) || Object.keys(a).some((k) => !['staffProfileId', 'breakMinutes', 'startsAt', 'endsAt'].includes(k)))) errors.push('staffAssignments must be valid assignment times');
  const acks = body.acknowledgedAvailabilityConflicts === undefined ? [] : body.acknowledgedAvailabilityConflicts;
  if (!Array.isArray(acks) || acks.some((a) => !a || !isUuid(a.staffProfileId) || !Array.isArray(a.dates) || !a.dates.length || !a.dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))) errors.push('acknowledgedAvailabilityConflicts must be valid acknowledgements');
  if (errors.length) throw badRequest(errors);
  const venue = venueById(body.venueId);
  if (!venue || !state.vm.venueIds.includes(venue.id)) throw httpError(404, 'Venue not found.');
  const role = roleById(body.jobRoleId);
  if (!role) throw httpError(404, 'Job role not found.');
  if (ids.some((id) => !state.vm.team.has(id))) throw httpError(404, 'Staff member not found.');
  if (ids.length > required) throw httpError(400, 'Invalid staff selection.');
  const overrides = new Map(assignments.map((a) => [a.staffProfileId, a]));
  if (overrides.size !== assignments.length || [...overrides.keys()].some((id) => !ids.includes(id))) throw httpError(400, 'Invalid assignment selection.');
  const parent = { startsAt: new Date(body.startsAt), endsAt: new Date(body.endsAt) };
  const breakMinutes = body.breakMinutes ?? venue.defaultBreakMinutes ?? 30;
  const checkTime = (t, brk) => {
    if (!(t.endsAt > t.startsAt)) throw httpError(400, 'The shift must end after it starts.');
    if (brk >= (t.endsAt - t.startsAt) / MIN) throw httpError(400, 'Break must be shorter than the shift.');
  };
  checkTime(parent, breakMinutes);
  const windows = new Map(ids.map((id) => {
    const o = overrides.get(id);
    const t = o ? { startsAt: new Date(o.startsAt), endsAt: new Date(o.endsAt) } : parent;
    checkTime(t, o && o.breakMinutes != null ? o.breakMinutes : breakMinutes);
    return [id, t];
  }));
  for (const [id, t] of windows) {
    if (busyStaff([id], t.startsAt, t.endsAt).size) {
      const st = personById(id);
      throw httpError(409, `${fullName(st)} is no longer available for this time — they may already be confirmed on another shift.`);
    }
  }
  // assertStaffAvailabilityAcknowledged: declared weekday availability, date-specific acknowledgement.
  const conflicts = [];
  const unknown = [];
  for (const [id, t] of windows) {
    const st = personById(id);
    if (!st.availableDays || !st.availableDays.length) {
      unknown.push({ staffProfileId: id, staffName: fullName(st) });
      continue;
    }
    const conflictDates = londonCalendarDays(t.startsAt, t.endsAt).filter((d) => !st.availableDays.includes(d.weekday));
    if (conflictDates.length) conflicts.push({ staffProfileId: id, staffName: fullName(st), availableDays: WEEKDAYS.filter((d) => st.availableDays.includes(d)), conflictDates });
  }
  const acked = (c) => {
    const dates = new Set(acks.filter((a) => a.staffProfileId === c.staffProfileId).flatMap((a) => a.dates));
    return c.conflictDates.every((d) => dates.has(d.date));
  };
  if (conflicts.some((c) => !acked(c))) {
    const fmt = (days) => {
      const o = WEEKDAYS.filter((d) => days.includes(d));
      return o.length <= 1 ? o.join('') : `${o.slice(0, -1).join(', ')} and ${o[o.length - 1]}`;
    };
    const total = windows.size;
    const message = total === 1 && conflicts.length === 1
      ? `${conflicts[0].staffName} has marked themselves as unavailable on ${fmt([...new Set(conflicts[0].conflictDates.map((d) => d.weekday))])}. Available days: ${fmt(conflicts[0].availableDays)}.`
      : `${conflicts.length} of ${total} selected Staff have availability conflicts.`;
    throw httpError(409, { statusCode: 409, code: 'STAFF_AVAILABILITY_CONFLICT', message, totalRecipients: total, conflicts, unknownAvailability: unknown });
  }
  const sh = addShift({
    id: state.dataset === 'story' && !shiftById(STORY.shift) ? STORY.shift : undefined,
    venueId: venue.id, jobRoleId: role.id, startsAt: new Date(Math.min(...[...windows.values()].map((t) => t.startsAt.getTime()), parent.startsAt.getTime())),
    endsAt: new Date(Math.max(...[...windows.values()].map((t) => t.endsAt.getTime()), parent.endsAt.getTime())),
    required, rate: state.dataset === 'story' && venue.id === STORY.venue && role.id === STORY.roleWait ? 1350 : 1300, breakMinutes,
    notes: null, status: 'pending_manager_approval', createdBy: state.vm.userId, requestedBy: state.vm.userId, createdAt: now,
  });
  sh.defaultStartsAt = parent.startsAt;
  sh.defaultEndsAt = parent.endsAt;
  for (const id of ids) state.requestStaff.push({ shiftId: sh.id, staffProfileId: id, ...windows.get(id), breakMinutes: overrides.get(id) ? overrides.get(id).breakMinutes ?? null : null });
  return shiftJson(sh);
}

/** ShiftReportService.reviewAttendance */
function reviewAttendance(shiftId, staffId, now) {
  const sh = scopedShift(shiftId);
  const r = state.reports[sh.id];
  if (r && r.status === 'finalised') throw httpError(409, 'This shift report has been finalised; attendance can no longer be reviewed.');
  if (now < sh.startsAt) throw httpError(409, 'Attendance can be reviewed once the shift has started.');
  const a = state.assignments.find((x) => x.shiftId === sh.id && x.staffProfileId === staffId && REPORT_SEAT.includes(x.status));
  if (!a) throw httpError(404, 'Staff member not found on this shift.');
  if (!a.attendanceReviewedAt) {
    const att = attendanceFor(a.id);
    if (att && ['clocked_in', 'on_break'].includes(att.status)) throw httpError(409, 'This staff member is still clocked in. Their attendance can be reviewed after they clock out.');
    if (a.status !== 'no_show' && !(att && att.clockOutAt)) {
      throw httpError(409, att ? 'The clock-out time is missing. Add it as a correction before marking attendance as reviewed.'
        : 'No attendance has been recorded yet. A no-show is recorded automatically 30 minutes after the start.');
    }
    a.attendanceReviewedAt = now;
    a.attendanceReviewedBy = state.vm.userId;
  }
  return reportDetail(sh);
}

/** AttendanceService.correct */
function correctAttendance(attendanceId, body, now) {
  onlyKeys(body, ['field', 'newValue', 'reason']);
  const errors = [];
  if (!['clockInAt', 'clockOutAt', 'breakMinutes'].includes(body.field)) errors.push('field must be one of the following values: clockInAt, clockOutAt, breakMinutes');
  if (typeof body.newValue !== 'string') errors.push('newValue must be a string');
  if (typeof body.reason !== 'string') errors.push('reason must be a string');
  if (typeof body.reason !== 'string' || body.reason.length < 10) errors.push('reason must be longer than or equal to 10 characters');
  if (errors.length) throw badRequest(errors);
  const att = state.attendance.find((x) => x.id === attendanceId);
  if (!att || !inScope(shiftById(att.shiftId))) throw httpError(404, 'Attendance not found.');
  const a = assignmentById(att.assignmentId);
  const r = state.reports[att.shiftId];
  if (r && r.status === 'finalised') throw httpError(409, 'This shift report has been finalised and can no longer be corrected.');
  let clockInAt = att.clockInAt;
  let clockOutAt = att.clockOutAt;
  let breakMinutes = att.breakMinutes;
  let oldValue;
  if (body.field === 'breakMinutes') {
    oldValue = att.breakMinutes != null ? String(att.breakMinutes) : '';
    const n = Number(body.newValue);
    if (!Number.isInteger(n) || n < 0) throw httpError(400, 'newValue must be a non-negative integer for breakMinutes.');
    breakMinutes = n;
  } else {
    const parsed = new Date(body.newValue);
    if (Number.isNaN(parsed.getTime())) throw httpError(400, `newValue must be a valid ISO-8601 timestamp for ${body.field}.`);
    if (parsed > now) throw httpError(400, `A ${body.field === 'clockInAt' ? 'clock-in' : 'clock-out'} time cannot be in the future.`);
    oldValue = iso(att[body.field]) || '';
    if (body.field === 'clockInAt') clockInAt = parsed;
    else clockOutAt = parsed;
  }
  if (clockOutAt && clockOutAt < clockInAt) throw httpError(400, 'clockOutAt cannot be before clockInAt.');
  const unchanged = (body.field === 'clockInAt' && clockInAt.getTime() === att.clockInAt.getTime())
    || (body.field === 'clockOutAt' && att.clockOutAt && clockOutAt.getTime() === att.clockOutAt.getTime())
    || (body.field === 'breakMinutes' && att.breakMinutes != null && breakMinutes === att.breakMinutes);
  if (unchanged) return attendanceJson(att);
  let status = att.status;
  let recovered = false;
  if (['clocked_out', 'approved'].includes(att.status)) status = 'under_review';
  else if (['under_review', 'disputed'].includes(att.status)) { /* stays in review */ } else if (['missing_clock_out', 'clocked_in', 'on_break'].includes(att.status)) {
    const flagAt = addMin(timeOf(a).endsAt, MISSING_CLOCK_OUT_GRACE_MINUTES);
    if (att.status !== 'missing_clock_out' && now < flagAt) throw httpError(409, 'This staff member is still on shift. A missing clock-out can be recovered once the shift has ended.');
    if (body.field !== 'clockOutAt') throw httpError(409, 'Add the missing clock-out time first.');
    status = 'under_review';
    recovered = true;
  } else throw httpError(409, 'This attendance cannot be corrected in its current state.');
  if (clockOutAt) {
    att.workedMinutes = workedMinutes(clockInAt, clockOutAt, breakMinutes ?? breakOf(a));
    att.earnedPence = payForMinutes(a.payRatePence, att.workedMinutes);
  }
  att.clockInAt = clockInAt;
  att.clockOutAt = clockOutAt;
  att.breakMinutes = breakMinutes;
  att.status = status;
  if (recovered) att.clockOutMethod = 'manager_correction';
  // Any change to the recorded times invalidates an earlier attendance review.
  a.attendanceReviewedAt = null;
  a.attendanceReviewedBy = null;
  state.corrections.push({ attendanceId: att.id, field: body.field, oldValue, newValue: body.newValue, reason: body.reason, correctedBy: state.vm.userId, at: now });
  return attendanceJson(att);
}

/** ShiftReportService.finalise */
function finalise(shiftId, body, now) {
  onlyKeys(body, ['signedOffName', 'breakConfirmed']);
  const errors = [];
  if (body.signedOffName !== undefined && (typeof body.signedOffName !== 'string' || body.signedOffName.length < 2 || body.signedOffName.length > 120)) errors.push('signedOffName must be longer than or equal to 2 characters');
  if (body.breakConfirmed !== undefined && body.breakConfirmed !== true) errors.push('breakConfirmed must be equal to true');
  if (errors.length) throw badRequest(errors);
  if ((body.signedOffName === undefined) !== (body.breakConfirmed === undefined)) throw httpError(400, 'Signing off needs both your full name and the break confirmation.');
  const name = body.signedOffName !== undefined ? body.signedOffName.trim() : undefined;
  if (body.signedOffName !== undefined && (!name || name.length < 2)) throw httpError(400, 'Enter your full name to sign off.');
  const sh = scopedShift(shiftId);
  if (now < sh.startsAt) throw httpError(409, 'This shift has not started yet, so its report cannot be finalised.');
  const rows = reportRows(sh);
  if (!rows.length) throw httpError(409, 'This shift has no staff to finalise a report for.');
  const r0 = state.reports[sh.id];
  if (r0 && r0.status === 'finalised') return; // idempotent
  if (!isReportReady(rows)) throw httpError(409, 'Wait for every confirmed staff member to clock out or receive a no-show outcome.');
  const remaining = rows.filter((x) => !x.attendanceReviewed).length;
  if (remaining > 0) throw httpError(409, `${remaining} attendance review${remaining === 1 ? '' : 's'} remaining. Review every staff member's attendance before finalising.`);
  for (const att of state.attendance.filter((x) => x.shiftId === sh.id)) att.status = 'approved';
  const r = state.reports[sh.id] || (state.reports[sh.id] = { shiftId: sh.id });
  Object.assign(r, { status: 'finalised', finalisedAt: now, finalisedBy: state.vm.userId, signedOffName: name || null, breakConfirmed: name ? true : null });
  // The worker renders the final PDF (from the real template) and only then writes the delivery marker + outbox.
  const f = addFile(sh.id, 'final', null);
  r.pendingFinal = f.id;
  ensureBytes(f).then(() => { f.generatedAt = clock.now(); }).catch((e) => process.stdout.write(`final timesheet render failed: ${e.message}\n`));
}

async function sendFile(res, fileId) {
  const f = isUuid(fileId) ? state.files[fileId] : null;
  const r = f && state.reports[f.shiftId];
  // ReportFilePolicy: only a file referenced by a report the caller can read.
  const referenced = r && [r.preShiftFileId, r.originalFileId, r.finalFileId].includes(f.id);
  if (!f || !referenced || !inScope(shiftById(f.shiftId))) return notFound(res, 'File not found.');
  try {
    const bytes = await ensureBytes(f);
    res.writeHead(200, {
      'Content-Type': 'application/pdf', 'Content-Length': bytes.length,
      'Content-Disposition': `attachment; filename="${f.filename}"; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
      'Cache-Control': 'private, no-store',
    });
    res.end(bytes);
  } catch (e) {
    send(res, 503, { statusCode: 503, message: 'The document could not be prepared. Please try again.', error: 'Service Unavailable' });
  }
}

// ------------------------------------------------------------- server ----
/** Every authenticated route the fixture serves (either persona). Anything else is 404. */
const ROUTES = [
  ['GET', /^\/auth\/(me|capabilities)$/], ['POST', /^\/auth\/(logout|set-password)$/], ['GET', /^\/realtime\/stream$/],
  ['POST', /^\/push\/devices(\/[^/]+\/deactivate)?$/], ['GET', /^\/notifications(\/unread-count)?$/], ['POST', /^\/notifications\/(read-all|[^/]+\/read)$/],
  ['GET', /^\/offers(\/mine)?$/], ['POST', /^\/offers\/[^/]+\/(accept|decline)$/],
  ['GET', /^\/attendance\/me\/(active|history|shift\/[^/]+(\/team)?)$/], ['POST', /^\/attendance\/(clock-in|clock-out|geofence-exit|[^/]+\/correct)$/],
  ['GET', /^\/shifts(\/sent(\/[^/]+)?|\/[^/]+)?$/], ['POST', /^\/shifts\/(request|[^/]+\/offers(\/bulk)?)$/],
  ['GET', /^\/(venues|job-roles)$/], ['GET', /^\/staff\/venue-directory(\/[^/]+)?$/], ['PATCH', /^\/staff\/venue-directory\/[^/]+\/tags$/],
  ['GET', /^\/attendance\/report\/(shifts|shift\/[^/]+(\/reviews\/[^/]+)?)$/], ['PATCH', /^\/attendance\/report\/shift\/[^/]+\/finalise$/],
  ['POST', /^\/attendance\/report\/shift\/[^/]+\/staff\/[^/]+\/attendance-review$/], ['PUT', /^\/attendance\/report\/shift\/[^/]+\/reviews\/[^/]+$/],
  ['GET', /^\/files\/[^/]+\/download$/],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  const path = url.pathname;
  const q = url.searchParams;
  const origEnd = res.end.bind(res);
  let persona = null;
  res.end = (...args) => {
    log(req, res.statusCode, persona);
    return origEnd(...args);
  };
  try {
    const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
    if (body.__invalid) return send(res, 400, { statusCode: 400, message: 'Unexpected token in JSON body', error: 'Bad Request' });

    // --- fixture control --------------------------------------------------
    if (path.startsWith('/__fixture/')) {
      if (req.method === 'POST' && path === '/__fixture/scene') {
        const scene = body.scene;
        if (scene !== 'legacy' && !SCENES[scene]) return send(res, 400, { message: `Unknown scene. One of: ${[...SCENE_ORDER, 'legacy'].join(', ')}` });
        if (body.now !== undefined && !isIsoDate(body.now)) return send(res, 400, { message: 'now must be an ISO-8601 timestamp' });
        applyScene(scene, body.now ? new Date(body.now) : null);
        tick();
        return send(res, 200, { ok: true, scene, dataset: state.dataset, now: iso(clock.now()), virtual: clock.virtual() });
      }
      if (req.method === 'POST' && path === '/__fixture/clock') {
        if (body.real) clock.real();
        else if (body.now !== undefined && isIsoDate(body.now)) clock.set(new Date(body.now));
        else if (typeof body.advanceMinutes === 'number') clock.set(addMin(clock.now(), body.advanceMinutes));
        else return send(res, 400, { message: 'Send {now: ISO} | {advanceMinutes: n} | {real: true}' });
        tick();
        return send(res, 200, { ok: true, now: iso(clock.now()), virtual: clock.virtual() });
      }
      if (req.method === 'GET' && path === '/__fixture/clock') return send(res, 200, { now: iso(clock.now()), virtual: clock.virtual(), scene: state.scene });
      if (req.method === 'GET' && path === '/__fixture/scenes') {
        return send(res, 200, { scenes: Object.fromEntries(SCENE_ORDER.map((k) => [k, iso(SCENES[k])])), legacy: 'real clock, relative dataset', current: state.scene });
      }
      if (req.method === 'POST' && path === '/__fixture/reset') {
        applyScene('legacy', null);
        return send(res, 200, { ok: true, builtAt: state.builtAt });
      }
      if (req.method === 'GET' && path === '/__fixture/state') {
        tick();
        return send(res, 200, { ...state, vm: { ...state.vm, team: Object.fromEntries(state.vm.team) }, scripted: state.scripted.map(({ at: t, label, done }) => ({ at: t, label, done: !!done })),
          files: Object.fromEntries(Object.entries(state.files).map(([k, f]) => [k, { ...f, bytes: f.bytes ? f.bytes.length : null, promise: undefined }])) });
      }
      const fm = path.match(/^\/__fixture\/confirm\/([^/]+)$/);
      if (req.method === 'POST' && fm) {
        tick();
        const target = fm[1] === 'latest' ? state.offers.find((o) => o.status === 'staff_accepted') : state.offers.find((o) => o.id === fm[1]);
        if (!target) return notFound(res);
        if (target.status !== 'staff_accepted') return send(res, 409, { message: `Offer is ${target.status}, not staff_accepted` });
        confirmOffer(target, clock.now());
        return send(res, 200, { ok: true, offerId: target.id, pushedTo: [...sseClients].filter((c) => c.persona === personaForProfile(target.staffProfileId)).length });
      }
      return notFound(res);
    }

    if (!path.startsWith(PREFIX)) return notFound(res);
    const p = path.slice(PREFIX.length);
    tick();

    // --- unauthenticated auth routes ----------------------------------------
    if (req.method === 'POST' && p === '/auth/login') {
      const found = personaByEmail(String(body.email || '').trim().toLowerCase());
      if (!found) return send(res, 401, { statusCode: 401, message: 'Invalid email or password.', error: 'Unauthorized' });
      persona = found.key;
      return send(res, 200, issueTokens(persona));
    }
    if (req.method === 'POST' && p === '/auth/refresh') {
      persona = verify('refresh', body.refreshToken);
      if (!persona) return send(res, 401, { statusCode: 401, message: 'Session expired', error: 'Unauthorized' });
      return send(res, 200, issueTokens(persona));
    }
    if (req.method === 'POST' && p === '/auth/forgot-password') {
      return send(res, 200, { message: 'If an account exists for that email, a reset link has been sent.' });
    }

    // --- authenticated ------------------------------------------------------
    // Like Nest, a path/method no controller declares is 404 before any guard runs.
    if (!ROUTES.some(([method, re]) => method === req.method && re.test(p))) return notFound(res);
    persona = verify('access', (req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!persona) return send(res, 401, { statusCode: 401, message: 'Unauthorized', error: 'Unauthorized' });

    if (req.method === 'GET' && p === '/auth/me') return send(res, 200, meJson(persona));
    if (req.method === 'POST' && p === '/auth/logout') return send(res, 204);
    if (req.method === 'GET' && p === '/auth/capabilities') return send(res, 200, capabilities(persona));
    if (req.method === 'POST' && p === '/auth/set-password') return send(res, 204);
    if (req.method === 'GET' && p === '/realtime/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      const client = { res, persona };
      sseClients.add(client);
      log(req, 200, persona);
      req.on('close', () => sseClients.delete(client));
      return;
    }
    if (req.method === 'POST' && /^\/push\/devices(\/[^/]+\/deactivate)?$/.test(p)) return send(res, 204);

    const inbox = state.notifications[persona];
    if (req.method === 'GET' && p === '/notifications') {
      return send(res, 200, inbox.slice().sort((a, b) => b.createdAt - a.createdAt).map((n) => ({ ...n, readAt: iso(n.readAt), createdAt: iso(n.createdAt) })));
    }
    if (req.method === 'GET' && p === '/notifications/unread-count') return send(res, 200, { count: inbox.filter((n) => !n.readAt).length });
    if (req.method === 'POST' && p === '/notifications/read-all') {
      inbox.forEach((n) => (n.readAt = n.readAt || clock.now()));
      return send(res, 204);
    }
    const nm = p.match(/^\/notifications\/([^/]+)\/read$/);
    if (req.method === 'POST' && nm) {
      const n = inbox.find((x) => x.id === nm[1]);
      if (!n) return notFound(res, 'Notification not found.');
      n.readAt = n.readAt || clock.now();
      return send(res, 204);
    }

    const result = PERSONAS[persona].role === 'staff' ? staffRoutes(req, p, q, body, persona) : vmRoutes(req, p, q, body);
    if (!result) return notFound(res);
    if (result[0] === 'file') return sendFile(res, result[1]);
    return send(res, result[0], result[1]);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, e.body);
    process.stdout.write(`ERROR ${e.stack}\n`);
    return send(res, 500, { statusCode: 500, message: 'Internal server error' });
  }
});

// Start-up: FIXTURE_SCENE (+ optional FIXTURE_NOW) or the legacy dataset on the real clock.
applyScene(process.env.FIXTURE_SCENE || 'legacy', process.env.FIXTURE_NOW ? new Date(process.env.FIXTURE_NOW) : null);
server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`Crewflow mobile fixture server on http://0.0.0.0:${PORT}${PREFIX} (synthetic data, scene ${state.scene}, now ${clock.now().toISOString()}${clock.virtual() ? ' virtual' : ''})\n`);
});
const shutdown = () => {
  for (const c of sseClients) c.res.end();
  docs.close().finally(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
