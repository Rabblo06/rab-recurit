#!/usr/bin/env node
/*
 * Crewflow mobile fixture server — SYNTHETIC DEMO DATA ONLY.
 *
 * A dependency-free Node HTTP server that answers the REST endpoints the
 * Flutter staff / venue-manager app (packages/rab-mobile) calls, with
 * fictional data shaped exactly like the app's Dart models
 * (lib/core/models/*.dart, lib/features/venue_manager/*.dart). It exists only
 * so documentation screenshots and screen recordings can be captured from the
 * REAL app without touching the real backend, database or any real person's
 * data. It performs no authentication: any password is accepted.
 *
 *   node mobile-fixture-server.cjs            # port 4010
 *   PORT=4011 node mobile-fixture-server.cjs
 *
 * App build:  --dart-define=API_URL=http://10.0.2.2:4010/rest/v1
 *
 * Personas (picked by login email, any password):
 *   alex.morgan@example.test  -> roles ['staff']          (Alex Morgan)
 *   riley.chen@example.test   -> roles ['venue_manager']  (Riley Chen)
 *
 * Every shift time is RELATIVE TO WHEN THE SERVER STARTED (or was last reset),
 * in Europe/London local time, so Home always shows a "Today's Shift", a
 * populated Upcoming deck, etc. A confirmed staff shift starts 10 minutes after
 * start-up, so the 15-minute early clock-in window is already open.
 *
 * Fixture-control endpoints (NOT part of the real API):
 *   POST /__fixture/confirm/:offerId  staff_accepted -> manager_confirmed
 *                                     (also pushes an `offer.confirmed` SSE event
 *                                     to any connected staff app so the change
 *                                     appears live, exactly like the real server)
 *   POST /__fixture/reset             rebuild all state relative to "now"
 *   GET  /__fixture/state             dump current state (debugging)
 */
'use strict';

const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 4010);
const PREFIX = '/rest/v1';
const TZ = 'Europe/London';

// ---------------------------------------------------------------- ids ----
// Deterministic UUID-shaped ids (the realtime envelope parser requires UUIDs).
const uid = (group, n) =>
  `${group}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG_ID = uid('0a000000', 1);
const STAFF_USER_ID = uid('0b000000', 1);
const VM_USER_ID = uid('0b000000', 2);
const STAFF_PROFILE_ID = uid('0c000000', 1);

const PERSONAS = {
  staff: {
    id: STAFF_USER_ID,
    email: 'alex.morgan@example.test',
    firstName: 'Alex',
    lastName: 'Morgan',
    organisationId: ORG_ID,
    roles: ['staff'],
    mustResetPassword: false,
    isPlatformAdmin: false,
  },
  vm: {
    id: VM_USER_ID,
    email: 'riley.chen@example.test',
    firstName: 'Riley',
    lastName: 'Chen',
    organisationId: ORG_ID,
    roles: ['venue_manager'],
    mustResetPassword: false,
    isPlatformAdmin: false,
  },
};

// ------------------------------------------------------------- time ------
const londonParts = (date) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return {
    y: get('year'),
    m: get('month'),
    d: get('day'),
    h: get('hour'),
    min: get('minute'),
    s: get('second'),
  };
};
/** Offset (ms) of London local time from UTC at `date`. */
const londonOffset = (date) => {
  const p = londonParts(date);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(date.getTime() / 1000) * 1000;
};
/** A Date for London-local `hh:mm` on (today + dayOffset). */
const at = (base, dayOffset, hh, mm = 0) => {
  const p = londonParts(base);
  const naive = Date.UTC(p.y, p.m - 1, p.d + dayOffset, hh, mm);
  const guess = new Date(naive);
  return new Date(naive - londonOffset(guess));
};
const addMin = (date, minutes) => new Date(date.getTime() + minutes * 60000);
const iso = (d) => (d == null ? null : d.toISOString());
const dayKey = (date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
/** Round up to the next 5 minutes for tidy on-screen times. */
const roundUp5 = (date) => new Date(Math.ceil(date.getTime() / 300000) * 300000);

// ------------------------------------------------------ catalogue --------
const VENUES = [
  { id: uid('0d000000', 1), name: 'The Grand Hall', address: '12 Market Square, Bristol BS1 4XY', defaultBreakMinutes: 30 },
  { id: uid('0d000000', 2), name: 'Riverside Pavilion', address: '3 Quayside Walk, Bristol BS1 5LT', defaultBreakMinutes: 30 },
  { id: uid('0d000000', 3), name: 'Harbour Exhibition Centre', address: 'Harbour Road, Bristol BS1 6QA', defaultBreakMinutes: 45 },
  { id: uid('0d000000', 4), name: 'Kingsway Rooms', address: '88 Kingsway, Bristol BS2 9HD', defaultBreakMinutes: 30 },
];
const venueById = (id) => VENUES.find((v) => v.id === id);
const ROLES = [
  { id: uid('0e000000', 1), name: 'Bartender' },
  { id: uid('0e000000', 2), name: 'Waiting Staff' },
  { id: uid('0e000000', 3), name: 'Event Steward' },
  { id: uid('0e000000', 4), name: 'Cloakroom Attendant' },
  { id: uid('0e000000', 5), name: 'Banquet Server' },
];
const roleByName = (name) => ROLES.find((r) => r.name === name);
const roleById = (id) => ROLES.find((r) => r.id === id);

const STAFF_POOL = [
  ['Alex', 'Morgan', 'active', true],
  ['Jordan', 'Patel', 'active', true],
  ['Sam', 'Okafor', 'active', true],
  ['Priya', 'Shah', 'active', true],
  ['Casey', 'Williams', 'active', true],
  ['Morgan', 'Lee', 'pending_compliance', true],
  ['Taylor', 'Brooks', 'active', true],
  ['Jamie', 'Nguyen', 'active', false],
  ['Charlie', 'Evans', 'active', false],
  ['Robin', 'Hughes', 'active', false],
].map(([firstName, lastName, employmentStatus, added], i) => ({
  id: i === 0 ? STAFF_PROFILE_ID : uid('0c000000', i + 1),
  firstName,
  lastName,
  employmentStatus,
  added,
  email: `${firstName}.${lastName}`.toLowerCase() + '@example.test',
  staffRef: `CF-${String(1041 + i)}`,
  createdAtDaysAgo: i === 6 ? 2 : 30 + i * 11,
}));
const staffById = (id) => STAFF_POOL.find((s) => s.id === id);
const staffName = (s) => `${s.firstName} ${s.lastName}`;

// --------------------------------------------------------- state ---------
let state;

function buildState() {
  const now = new Date();
  const soon = roundUp5(addMin(now, 10)); // clock-in window (start - 15 min) already open
  const s = { builtAt: now, staffOffers: [], history: [], notifications: [], shifts: [], vmOffers: [], reports: {}, activeAttendance: null };

  // ---------------------------------------------------------- staff ------
  let n = 0;
  const offer = (o) => {
    n += 1;
    const venue = venueById(o.venueId);
    const minutes = (o.endsAt - o.startsAt) / 60000 - (o.breakMinutes ?? 30);
    s.staffOffers.push({
      id: uid('0f000000', n),
      shiftId: uid('1a000000', n),
      status: o.status,
      assignmentStatus: o.assignmentStatus ?? (o.status === 'manager_confirmed' ? 'confirmed' : 'offered'),
      shiftStatus: o.shiftStatus ?? 'partially_filled',
      sentAt: addMin(o.startsAt, -60 * 24 * 3),
      expiresAt: o.expiresAt ?? addMin(o.startsAt, -60 * 6),
      respondedAt: o.status === 'pending' ? null : addMin(o.startsAt, -60 * 24 * 2),
      staffAcceptedAt: ['staff_accepted', 'manager_confirmed'].includes(o.status) ? addMin(o.startsAt, -60 * 24 * 2) : null,
      managerConfirmedAt: o.status === 'manager_confirmed' ? addMin(o.startsAt, -60 * 24 * 2 + 45) : null,
      payRatePence: o.payRatePence,
      estimatedPayPence: Math.round((o.payRatePence * Math.max(0, minutes)) / 60),
      startsAt: o.startsAt,
      endsAt: o.endsAt,
      venueName: venue.name,
      venueAddress: venue.address,
      roleName: o.roleName,
      shiftNotes: o.shiftNotes ?? null,
      clockInAt: o.clockInAt ?? null,
      clockOutAt: o.clockOutAt ?? null,
      attendanceStatus: o.attendanceStatus ?? null,
      completedAt: o.completedAt ?? null,
      expiredAt: o.expiredAt ?? null,
    });
    return s.staffOffers[s.staffOffers.length - 1];
  };

  // Pending invitations (Offers list).
  offer({ status: 'pending', venueId: VENUES[0].id, roleName: 'Bartender', startsAt: at(now, 1, 18), endsAt: at(now, 1, 23, 30), payRatePence: 1450,
    shiftNotes: 'Black shirt and trousers. Cocktail service for a 180-guest gala dinner. Report to the bar manager at the staff entrance on Market Lane.' });
  offer({ status: 'pending', venueId: VENUES[1].id, roleName: 'Waiting Staff', startsAt: at(now, 3, 11), endsAt: at(now, 3, 17), payRatePence: 1275,
    shiftNotes: 'Wedding lunch, silver service. Smart black uniform; aprons provided.' });
  offer({ status: 'pending', venueId: VENUES[0].id, roleName: 'Cloakroom Attendant', startsAt: at(now, 5, 17, 30), endsAt: at(now, 5, 23), payRatePence: 1200 });

  // Confirmed shifts — the first starts in ~10 minutes (Today's Shift, clock-in open).
  offer({ status: 'manager_confirmed', venueId: VENUES[2].id, roleName: 'Event Steward', startsAt: soon, endsAt: addMin(soon, 6 * 60), payRatePence: 1380,
    shiftNotes: 'Trade show doors open at the start of shift. Hi-vis provided at the security office. Scan the shift QR code at the staff entrance to clock in.' });
  offer({ status: 'manager_confirmed', venueId: VENUES[0].id, roleName: 'Bartender', startsAt: at(now, 2, 17), endsAt: at(now, 2, 23), payRatePence: 1450,
    shiftNotes: 'Corporate awards night. Bar opens 18:00.' });
  offer({ status: 'manager_confirmed', venueId: VENUES[3].id, roleName: 'Banquet Server', startsAt: at(now, 4, 12), endsAt: at(now, 4, 18), payRatePence: 1300 });
  offer({ status: 'manager_confirmed', venueId: VENUES[1].id, roleName: 'Waiting Staff', startsAt: at(now, 6, 10), endsAt: at(now, 6, 16), payRatePence: 1275 });

  // Completed shifts (History).
  // The first ended ~80 minutes ago, so it shows the "Complete" post-shift
  // state (clock-out + 1h..2h); older ones have rolled on to "Expired".
  const earlyEnd = new Date(Math.floor(addMin(now, -80).getTime() / 300000) * 300000);
  const past = [
    { startsAt: addMin(earlyEnd, -5 * 60), endsAt: earlyEnd, venue: VENUES[3], role: 'Banquet Server', rate: 1300, inOff: -6, outOff: 2, brk: 30 },
    { days: -1, venue: VENUES[0], role: 'Bartender', start: [18, 0], end: [23, 30], rate: 1450, inOff: -4, outOff: 6, brk: 30 },
    { days: -3, venue: VENUES[3], role: 'Banquet Server', start: [12, 0], end: [18, 0], rate: 1300, inOff: -9, outOff: 0, brk: 30 },
    { days: -6, venue: VENUES[2], role: 'Event Steward', start: [8, 0], end: [16, 0], rate: 1380, inOff: -12, outOff: 4, brk: 45 },
    { days: -9, venue: VENUES[1], role: 'Waiting Staff', start: [11, 0], end: [17, 0], rate: 1275, inOff: -6, outOff: -2, brk: 30 },
  ];
  past.forEach((p, i) => {
    const startsAt = p.startsAt ?? at(now, p.days, ...p.start);
    const endsAt = p.endsAt ?? at(now, p.days, ...p.end);
    const clockInAt = addMin(startsAt, p.inOff);
    const clockOutAt = addMin(endsAt, p.outOff);
    const worked = Math.round((clockOutAt - Math.max(clockInAt, startsAt)) / 60000) - p.brk;
    const o = offer({
      status: 'manager_confirmed', assignmentStatus: 'completed', shiftStatus: 'completed', venueId: p.venue.id, roleName: p.role,
      startsAt, endsAt, payRatePence: p.rate, clockInAt, clockOutAt, attendanceStatus: i === 0 ? 'clocked_out' : 'approved',
      completedAt: addMin(clockOutAt, 60), expiredAt: addMin(clockOutAt, 120), breakMinutes: p.brk,
    });
    s.history.push({
      id: uid('1b000000', i + 1),
      status: i === 0 ? 'clocked_out' : 'approved',
      clockInAt, clockOutAt,
      workedMinutes: worked,
      earnedPence: Math.round((worked * p.rate) / 60),
      breakMinutes: p.brk,
      locationVerified: true,
      clockOutMethod: 'qr',
      shiftId: o.shiftId,
      startsAt, endsAt,
      venueName: p.venue.name,
      roleName: p.role,
      staffProfileId: STAFF_PROFILE_ID,
      staffName: 'Alex Morgan',
    });
  });

  s.notifications = [
    { id: uid('1c000000', 1), type: 'offer.sent', title: 'New shift offer', message: 'Bartender at The Grand Hall — tomorrow, 18:00–23:30. Tap to review and respond.', readAt: null, createdAt: addMin(now, -12) },
    { id: uid('1c000000', 2), type: 'offer.confirmed', title: 'Shift confirmed', message: 'Your Event Steward shift at Harbour Exhibition Centre has been confirmed by the manager.', readAt: null, createdAt: addMin(now, -95) },
    { id: uid('1c000000', 3), type: 'shift.reminder', title: 'Shift starts soon', message: 'Event Steward at Harbour Exhibition Centre starts today. Remember to scan the shift QR code when you arrive.', readAt: null, createdAt: addMin(now, -180) },
    { id: uid('1c000000', 4), type: 'attendance.approved', title: 'Timesheet approved', message: 'Your Banquet Server shift at Kingsway Rooms has been approved.', readAt: addMin(now, -60 * 24), createdAt: addMin(now, -60 * 26) },
  ];

  // ----------------------------------------------------- venue manager ---
  let sn = 0;
  const shift = (o) => {
    sn += 1;
    const role = roleByName(o.role);
    const venue = venueById(o.venueId);
    const sh = {
      id: uid('2a000000', sn),
      organisationId: ORG_ID,
      venueId: venue.id,
      jobRoleId: role.id,
      startsAt: iso(o.startsAt),
      endsAt: iso(o.endsAt),
      status: o.status,
      requiredCount: o.required,
      filledCount: o.filled,
      breakMinutes: o.breakMinutes ?? 30,
      address: venue.address,
      notes: o.notes ?? '',
      createdBy: VM_USER_ID,
      createdAt: iso(addMin(o.startsAt, -60 * 24 * 7)),
    };
    s.shifts.push(sh);
    // Offers for this shift.
    (o.offers || []).forEach(([staffIdx, status]) => {
      const st = STAFF_POOL[staffIdx];
      const minutes = (o.endsAt - o.startsAt) / 60000 - sh.breakMinutes;
      s.vmOffers.push({
        id: uid('2b000000', s.vmOffers.length + 1),
        status,
        sentAt: iso(addMin(o.startsAt, -60 * 24 * 3)),
        expiresAt: iso(addMin(o.startsAt, -60 * 6)),
        respondedAt: status === 'pending' ? null : iso(addMin(o.startsAt, -60 * 24 * 2)),
        declineReason: null,
        staffAcceptedAt: ['staff_accepted', 'manager_confirmed'].includes(status) ? iso(addMin(o.startsAt, -60 * 24 * 2)) : null,
        managerConfirmedAt: status === 'manager_confirmed' ? iso(addMin(o.startsAt, -60 * 24 * 2 + 30)) : null,
        managerRejectedAt: null,
        rejectionReason: null,
        estimatedPayPence: Math.round((o.rate * minutes) / 60),
        shiftId: sh.id,
        startsAt: sh.startsAt,
        endsAt: sh.endsAt,
        venueName: venue.name,
        roleName: role.name,
        staffProfileId: st.id,
        staffName: staffName(st),
        payRatePence: o.rate,
        venueAddress: venue.address,
        shiftNotes: sh.notes || null,
      });
    });
    return sh;
  };

  const eToday = shift({ venueId: VENUES[0].id, role: 'Event Steward', startsAt: at(now, 0, 18), endsAt: at(now, 0, 23, 30), status: 'partially_filled', required: 6, filled: 4, rate: 1380,
    notes: 'Charity gala. Stewards to brief with security at 17:45 at the main entrance.',
    offers: [[0, 'manager_confirmed'], [1, 'manager_confirmed'], [2, 'manager_confirmed'], [3, 'manager_confirmed'], [4, 'staff_accepted'], [6, 'pending']] });
  shift({ venueId: VENUES[1].id, role: 'Bartender', startsAt: at(now, 1, 17), endsAt: at(now, 1, 23), status: 'offered', required: 4, filled: 2, rate: 1450,
    offers: [[1, 'manager_confirmed'], [3, 'manager_confirmed'], [2, 'pending'], [4, 'pending'], [6, 'declined']] });
  shift({ venueId: VENUES[0].id, role: 'Waiting Staff', startsAt: at(now, 3, 11), endsAt: at(now, 3, 17), status: 'fully_filled', required: 5, filled: 5, rate: 1275,
    offers: [[0, 'manager_confirmed'], [1, 'manager_confirmed'], [2, 'manager_confirmed'], [3, 'manager_confirmed'], [4, 'manager_confirmed']] });
  shift({ venueId: VENUES[1].id, role: 'Cloakroom Attendant', startsAt: at(now, 5, 17, 30), endsAt: at(now, 5, 23), status: 'pending_manager_approval', required: 2, filled: 0, rate: 1200 });
  const ePast = shift({ venueId: VENUES[0].id, role: 'Banquet Server', startsAt: at(now, -1, 12), endsAt: at(now, -1, 18), status: 'completed', required: 4, filled: 4, rate: 1300,
    offers: [[0, 'manager_confirmed'], [1, 'manager_confirmed'], [2, 'manager_confirmed'], [3, 'manager_confirmed']] });
  const ePast2 = shift({ venueId: VENUES[1].id, role: 'Bartender', startsAt: at(now, -4, 18), endsAt: at(now, -4, 23, 30), status: 'completed', required: 3, filled: 3, rate: 1450,
    offers: [[1, 'manager_confirmed'], [4, 'manager_confirmed'], [6, 'manager_confirmed']] });

  const reportRow = (staffIdx, sh, opts) => {
    const st = STAFF_POOL[staffIdx];
    const startsAt = new Date(sh.startsAt);
    const endsAt = new Date(sh.endsAt);
    const clockInAt = opts.inOff == null ? null : addMin(startsAt, opts.inOff);
    const clockOutAt = opts.outOff == null ? null : addMin(endsAt, opts.outOff);
    const brk = opts.breakMinutes ?? null;
    const worked = clockInAt && clockOutAt ? Math.round((clockOutAt - Math.max(clockInAt, startsAt)) / 60000) - (brk ?? sh.breakMinutes) : null;
    return {
      staffProfileId: st.id,
      staffName: staffName(st),
      roleName: roleById(sh.jobRoleId).name,
      scheduledStart: sh.startsAt,
      scheduledEnd: sh.endsAt,
      assignmentStatus: opts.assignmentStatus ?? 'completed',
      attendanceId: clockInAt ? uid('2c000000', staffIdx + 1 + (sh === ePast ? 0 : 50)) : null,
      attendanceStatus: opts.attendanceStatus,
      clockInAt: iso(clockInAt),
      clockOutAt: iso(clockOutAt),
      breakMinutes: brk,
      scheduledBreakMinutes: sh.breakMinutes,
      workedMinutes: worked,
      // Postgres bigint arrives as a decimal string from the real report API.
      earnedPence: worked == null ? null : String(Math.round((worked * 1300) / 60)),
      locationVerified: !!clockInAt,
      clockOutMethod: clockOutAt ? 'qr' : null,
      corrected: !!opts.corrected,
    };
  };
  s.reports[ePast.id] = {
    shiftId: ePast.id, venueName: VENUES[0].name, roleName: 'Banquet Server', startsAt: ePast.startsAt, endsAt: ePast.endsAt,
    reportStatus: 'awaiting_review', finalisedAt: null,
    staff: [
      reportRow(0, ePast, { inOff: -7, outOff: 3, attendanceStatus: 'clocked_out', breakMinutes: 30 }),
      reportRow(1, ePast, { inOff: -2, outOff: 0, attendanceStatus: 'clocked_out', breakMinutes: 30 }),
      reportRow(2, ePast, { inOff: 12, outOff: 0, attendanceStatus: 'late', breakMinutes: 30 }),
      reportRow(3, ePast, { inOff: -5, outOff: null, attendanceStatus: 'missing_clock_out' }),
    ],
  };
  s.reports[ePast2.id] = {
    shiftId: ePast2.id, venueName: VENUES[1].name, roleName: 'Bartender', startsAt: ePast2.startsAt, endsAt: ePast2.endsAt,
    reportStatus: 'finalised', finalisedAt: iso(addMin(new Date(ePast2.endsAt), 60 * 14)),
    staff: [
      reportRow(1, ePast2, { inOff: -5, outOff: 4, attendanceStatus: 'approved', breakMinutes: 30 }),
      reportRow(4, ePast2, { inOff: -10, outOff: 0, attendanceStatus: 'approved', breakMinutes: 30 }),
      reportRow(6, ePast2, { inOff: -3, outOff: 6, attendanceStatus: 'approved', breakMinutes: 30, corrected: true }),
    ],
  };
  // Today's shift report (in progress — nobody clocked in yet).
  s.reports[eToday.id] = {
    shiftId: eToday.id, venueName: VENUES[0].name, roleName: 'Event Steward', startsAt: eToday.startsAt, endsAt: eToday.endsAt,
    reportStatus: 'awaiting_review', finalisedAt: null,
    staff: [0, 1, 2, 3].map((i) => reportRow(i, eToday, { inOff: null, outOff: null, attendanceStatus: null, assignmentStatus: 'confirmed' })),
  };
  return s;
}
state = buildState();

// ------------------------------------------------------ projections ------
/** Port of rab-server resolveStaffShiftPresentation (read-only). */
function presentation(o, serverNow) {
  const now = serverNow.getTime();
  const clockInAt = o.clockInAt;
  const clockOutAt = o.clockOutAt;
  let st;
  let nextTransitionAt = null;
  if (clockOutAt && now >= clockOutAt.getTime()) {
    st = o.expiredAt && now >= o.expiredAt.getTime() ? 'expired' : o.completedAt && now >= o.completedAt.getTime() ? 'complete' : 'clockedOut';
    nextTransitionAt = st === 'expired' ? null : st === 'complete' ? addMin(clockOutAt, 120) : addMin(clockOutAt, 60);
  } else if (clockInAt && (clockOutAt || ['clocked_in', 'on_break'].includes(o.attendanceStatus || ''))) {
    st = 'live';
    nextTransitionAt = clockOutAt ?? null;
  } else if (o.shiftStatus === 'cancelled' || ['cancelled', 'withdrawn'].includes(o.assignmentStatus)) {
    st = 'cancelled';
  } else if (['expired', 'declined', 'withdrawn', 'manager_rejected'].includes(o.status)) {
    st = o.status === 'withdrawn' ? 'cancelled' : o.status === 'manager_rejected' ? 'rejected' : o.status;
  } else if (o.assignmentStatus === 'confirmed' && o.status === 'manager_confirmed') {
    st = now >= o.endsAt.getTime() ? 'ended' : 'confirmed';
  } else if (['no_show', 'completed'].includes(o.assignmentStatus)) {
    st = 'ended';
  } else {
    st = 'pending';
  }
  const isToday = dayKey(o.startsAt) === dayKey(serverNow) || (now >= o.startsAt.getTime() && now < o.endsAt.getTime());
  const homeLabel = st === 'live' ? 'Live Shift'
    : ['clockedOut', 'complete', 'expired'].includes(st) ? { clockedOut: 'Clocked Out', complete: 'Complete', expired: 'Expired' }[st]
    : isToday ? "Today's Shift" : 'Next Shift';
  return { state: st, homeLabel, isToday, serverNow: iso(serverNow), nextTransitionAt: iso(nextTransitionAt), clockInAt: iso(clockInAt), clockOutAt: iso(clockOutAt), timezone: TZ };
}

function staffOfferJson(o, serverNow) {
  return {
    id: o.id,
    status: o.status,
    sentAt: iso(o.sentAt),
    expiresAt: iso(o.expiresAt),
    respondedAt: iso(o.respondedAt),
    declineReason: null,
    staffAcceptedAt: iso(o.staffAcceptedAt),
    managerConfirmedAt: iso(o.managerConfirmedAt),
    managerRejectedAt: null,
    rejectionReason: null,
    estimatedPayPence: o.estimatedPayPence,
    shiftId: o.shiftId,
    startsAt: iso(o.startsAt),
    endsAt: iso(o.endsAt),
    venueName: o.venueName,
    roleName: o.roleName,
    staffProfileId: STAFF_PROFILE_ID,
    staffName: 'Alex Morgan',
    payRatePence: o.payRatePence,
    venueAddress: o.venueAddress,
    shiftNotes: o.shiftNotes,
    presentation: presentation(o, serverNow),
  };
}

function attendanceJson(a) {
  return {
    ...a,
    clockInAt: iso(a.clockInAt),
    clockOutAt: iso(a.clockOutAt),
    startsAt: iso(a.startsAt),
    endsAt: iso(a.endsAt),
  };
}

/** Port of rab-server sentShiftPresentation. */
function sentShiftPresentation(status, required, counts) {
  const terminal = ['cancelled', 'completed', 'declined'].includes(status);
  const accepted = !terminal && counts.accepted + counts.confirmed > 0;
  const confirmed = !terminal && required > 0 && counts.confirmed >= required;
  const pending = !terminal && (status === 'pending_manager_approval' || counts.pending > 0);
  const filters = [
    ...(pending ? ['pending'] : []), ...(accepted ? ['staff_accepted'] : []),
    ...(confirmed ? ['manager_confirmed'] : []),
    ...(status === 'declined' || (!terminal && counts.declined > 0) ? ['declined'] : []),
    ...(status === 'cancelled' || (!terminal && counts.cancelled > 0) ? ['cancelled'] : []),
    ...(status === 'completed' ? ['completed'] : []),
    ...(!terminal && counts.expired > 0 ? ['expired'] : []),
    ...(!terminal && counts.withdrawn > 0 ? ['withdrawn'] : []),
    ...(!terminal && counts.rejected > 0 ? ['manager_rejected'] : []),
  ];
  const statusLabel = status === 'pending_manager_approval' ? 'Waiting for manager approval'
    : status === 'declined' ? 'Request declined' : status === 'cancelled' ? 'Cancelled'
    : status === 'completed' ? 'Completed' : confirmed ? 'Confirmed'
    : accepted ? 'Staff responses received' : counts.pending > 0 ? 'Offers sent'
    : counts.declined > 0 ? 'Staff declined' : counts.cancelled > 0 ? 'Staff cancelled' : counts.sent > 0 ? 'No active offers'
    : 'Approved — awaiting offers';
  return { statusLabel, filters, counters: { sent: counts.sent > 0, accepted, confirmed } };
}

function sentShiftJson(sh) {
  const counts = { sent: 0, pending: 0, accepted: 0, confirmed: 0, cancelled: 0, declined: 0, expired: 0, withdrawn: 0, rejected: 0 };
  for (const o of state.vmOffers.filter((x) => x.shiftId === sh.id)) {
    counts.sent += 1;
    const key = { pending: 'pending', staff_accepted: 'accepted', manager_confirmed: 'confirmed', declined: 'declined', expired: 'expired', withdrawn: 'withdrawn', manager_rejected: 'rejected' }[o.status];
    if (key) counts[key] += 1;
  }
  return {
    ...sh,
    venueName: venueById(sh.venueId).name,
    roleName: roleById(sh.jobRoleId).name,
    offerCounts: counts,
    ...sentShiftPresentation(sh.status, sh.requiredCount, counts),
  };
}

function directoryRow(st, startAt, endAt) {
  const row = {
    id: st.id,
    firstName: st.firstName,
    lastName: st.lastName,
    employmentStatus: st.employmentStatus,
    added: st.added,
    email: st.email,
    staffRef: st.staffRef,
    createdAt: iso(addMin(state.builtAt, -st.createdAtDaysAgo * 24 * 60)),
  };
  if (startAt && endAt) {
    // Busy if a confirmed VM offer overlaps the requested window.
    const busy = state.vmOffers.some(
      (o) => o.staffProfileId === st.id && o.status === 'manager_confirmed' &&
        new Date(o.startsAt) < endAt && new Date(o.endsAt) > startAt,
    );
    row.available = !busy && st.employmentStatus === 'active';
  }
  return row;
}

const CAPABILITIES = {
  vm: {
    'schedule.view': true,
    'venue.view': true,
    'offer.send': true,
    'staff.view': true,
    'report.view': true,
    'staffing_request.create': true,
    'attendance.correct': true,
  },
  staff: { 'schedule.view': false, 'venue.view': false },
};

// -------------------------------------------------------- realtime -------
const sseClients = new Set(); // { res, persona }
function pushEvent(persona, type, entityId) {
  const envelope = {
    version: 1,
    eventId: crypto.randomUUID(),
    type,
    organisationId: ORG_ID,
    workspaceId: null,
    targetUserId: PERSONAS[persona].id,
    entityId,
    occurredAt: new Date().toISOString(),
  };
  for (const c of sseClients) {
    if (c.persona === persona) c.res.write(`id: ${envelope.eventId}\ndata: ${JSON.stringify(envelope)}\n\n`);
  }
  return envelope;
}
setInterval(() => {
  for (const c of sseClients) c.res.write(': keep-alive\n\n');
}, 15000).unref();

// --------------------------------------------------------- http ----------
const tokens = new Map(); // token -> persona

function issueTokens(persona) {
  const accessToken = `fx-access-${persona}-${crypto.randomBytes(8).toString('hex')}`;
  const refreshToken = `fx-refresh-${persona}-${crypto.randomBytes(8).toString('hex')}`;
  tokens.set(accessToken, persona);
  tokens.set(refreshToken, persona);
  return { accessToken, refreshToken };
}

function send(res, status, body) {
  if (body === undefined || status === 204) {
    res.writeHead(status);
    return res.end();
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}
const notFound = (res) => send(res, 404, { statusCode: 404, message: 'Not found', error: 'Not Found' });

function paginate(rows, query) {
  const page = Math.max(1, Number(query.get('page') || 1));
  const limit = Math.max(1, Math.min(100, Number(query.get('limit') || 100)));
  return { data: rows.slice((page - 1) * limit, page * limit), total: rows.length, page, limit };
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function log(req, status, persona) {
  const t = new Date().toISOString().slice(11, 19);
  process.stdout.write(`${t} ${req.method} ${req.url} -> ${status}${persona ? ' [' + persona + ']' : ''}\n`);
}

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

  // --- fixture control --------------------------------------------------
  if (path.startsWith('/__fixture/')) {
    if (req.method === 'POST' && path === '/__fixture/reset') {
      state = buildState();
      return send(res, 200, { ok: true, builtAt: state.builtAt });
    }
    if (req.method === 'GET' && path === '/__fixture/state') return send(res, 200, state);
    const m = path.match(/^\/__fixture\/confirm\/([^/]+)$/);
    if (req.method === 'POST' && m) {
      const target = m[1] === 'latest'
        ? state.staffOffers.find((o) => o.status === 'staff_accepted')
        : state.staffOffers.find((o) => o.id === m[1]);
      if (!target) return notFound(res);
      if (target.status !== 'staff_accepted') return send(res, 409, { message: `Offer is ${target.status}, not staff_accepted` });
      target.status = 'manager_confirmed';
      target.assignmentStatus = 'confirmed';
      target.managerConfirmedAt = new Date();
      state.notifications.unshift({
        id: crypto.randomUUID(), type: 'offer.confirmed', title: 'Shift confirmed',
        message: `Your ${target.roleName} shift at ${target.venueName} has been confirmed by the manager.`,
        readAt: null, createdAt: new Date(),
      });
      const event = pushEvent('staff', 'offer.confirmed', target.id);
      return send(res, 200, { ok: true, offerId: target.id, pushedTo: [...sseClients].filter((c) => c.persona === 'staff').length, event });
    }
    return notFound(res);
  }

  if (!path.startsWith(PREFIX)) return notFound(res);
  const p = path.slice(PREFIX.length);
  const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};

  // --- unauthenticated auth routes ----------------------------------------
  if (req.method === 'POST' && p === '/auth/login') {
    const email = String(body.email || '').trim().toLowerCase();
    persona = email === PERSONAS.vm.email ? 'vm' : email === PERSONAS.staff.email ? 'staff' : null;
    if (!persona) return send(res, 401, { statusCode: 401, message: 'Invalid email or password.', error: 'Unauthorized' });
    return send(res, 200, issueTokens(persona));
  }
  if (req.method === 'POST' && p === '/auth/refresh') {
    persona = tokens.get(body.refreshToken);
    if (!persona) return send(res, 401, { statusCode: 401, message: 'Session expired', error: 'Unauthorized' });
    return send(res, 200, issueTokens(persona));
  }
  if (req.method === 'POST' && p === '/auth/forgot-password') {
    return send(res, 200, { message: 'If an account exists for that email, a reset link has been sent.' });
  }

  // --- authenticated ------------------------------------------------------
  const auth = req.headers.authorization || '';
  persona = tokens.get(auth.replace(/^Bearer\s+/i, ''));
  if (!persona) {
    // Tokens are in-memory: after a fixture restart a stored token is unknown.
    // Accept a well-formed fixture token so a restart never logs the app out.
    const m = auth.match(/^Bearer fx-access-(staff|vm)-/);
    if (m) persona = m[1];
  }
  if (!persona) return send(res, 401, { statusCode: 401, message: 'Unauthorized', error: 'Unauthorized' });
  const now = new Date();

  if (req.method === 'GET' && p === '/auth/me') return send(res, 200, PERSONAS[persona]);
  if (req.method === 'POST' && p === '/auth/logout') return send(res, 204);
  if (req.method === 'GET' && p === '/auth/capabilities') return send(res, 200, CAPABILITIES[persona]);
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

  // notifications (both personas share the same synthetic inbox)
  if (req.method === 'GET' && p === '/notifications') {
    return send(res, 200, state.notifications.map((n) => ({ ...n, readAt: iso(n.readAt), createdAt: iso(n.createdAt) })));
  }
  if (req.method === 'GET' && p === '/notifications/unread-count') {
    return send(res, 200, { count: state.notifications.filter((n) => !n.readAt).length });
  }
  if (req.method === 'POST' && p === '/notifications/read-all') {
    state.notifications.forEach((n) => (n.readAt = n.readAt || now));
    return send(res, 204);
  }
  let m = p.match(/^\/notifications\/([^/]+)\/read$/);
  if (req.method === 'POST' && m) {
    const n = state.notifications.find((x) => x.id === m[1]);
    if (n) n.readAt = n.readAt || now;
    return send(res, 204);
  }

  // ------------------------------------------------------------- staff ----
  if (persona === 'staff') {
    if (req.method === 'GET' && p === '/offers/mine') {
      return send(res, 200, state.staffOffers.map((o) => staffOfferJson(o, now)));
    }
    m = p.match(/^\/offers\/([^/]+)\/(accept|decline)$/);
    if (req.method === 'POST' && m) {
      const o = state.staffOffers.find((x) => x.id === m[1]);
      if (!o) return notFound(res);
      if (o.status !== 'pending') return send(res, 409, { statusCode: 409, message: 'This offer can no longer be changed.', error: 'Conflict' });
      o.status = m[2] === 'accept' ? 'staff_accepted' : 'declined';
      o.respondedAt = now;
      if (m[2] === 'accept') o.staffAcceptedAt = now;
      return send(res, 200, staffOfferJson(o, now));
    }
    if (req.method === 'GET' && p === '/attendance/me/active') {
      return send(res, 200, { attendance: state.activeAttendance ? attendanceJson(state.activeAttendance) : null, serverNow: iso(now) });
    }
    if (req.method === 'GET' && p === '/attendance/me/history') {
      return send(res, 200, state.history.map(attendanceJson));
    }
    if (req.method === 'POST' && p === '/attendance/clock-in') {
      const o = state.staffOffers.find((x) => x.shiftId === body.shiftId && x.status === 'manager_confirmed');
      if (!o) return notFound(res);
      if (now < addMin(o.startsAt, -15)) {
        return send(res, 409, { statusCode: 409, code: 'CLOCK_IN_TOO_EARLY', message: 'Clock-in is not available yet.', shiftStart: iso(o.startsAt), availableAt: iso(addMin(o.startsAt, -15)) });
      }
      o.clockInAt = now;
      o.attendanceStatus = 'clocked_in';
      state.activeAttendance = {
        id: crypto.randomUUID(), status: 'clocked_in', clockInAt: now, clockOutAt: null, workedMinutes: null, earnedPence: null, breakMinutes: null,
        locationVerified: true, clockOutMethod: null, shiftId: o.shiftId, startsAt: o.startsAt, endsAt: o.endsAt,
        venueName: o.venueName, roleName: o.roleName, staffProfileId: STAFF_PROFILE_ID, staffName: 'Alex Morgan',
      };
      return send(res, 200, attendanceJson(state.activeAttendance));
    }
    if (req.method === 'POST' && p === '/attendance/clock-out') {
      const a = state.activeAttendance;
      if (!a) return send(res, 409, { statusCode: 409, message: 'You are not clocked in.' });
      const o = state.staffOffers.find((x) => x.shiftId === a.shiftId);
      a.clockOutAt = now;
      a.status = 'clocked_out';
      a.workedMinutes = Math.max(0, Math.round((now - a.clockInAt) / 60000));
      a.earnedPence = Math.round((a.workedMinutes * o.payRatePence) / 60);
      a.clockOutMethod = 'qr';
      o.clockOutAt = now;
      o.attendanceStatus = 'clocked_out';
      o.completedAt = addMin(now, 60);
      o.expiredAt = addMin(now, 120);
      state.history.unshift(a);
      state.activeAttendance = null;
      return send(res, 200, attendanceJson(a));
    }
    if (req.method === 'POST' && p === '/attendance/geofence-exit') {
      return send(res, 409, { statusCode: 409, message: 'Still inside the venue geofence.' });
    }
  }

  // ----------------------------------------------------- venue manager ----
  if (persona === 'vm') {
    if (req.method === 'GET' && p === '/shifts') return send(res, 200, paginate(state.shifts, q));
    if (req.method === 'GET' && p === '/shifts/sent') {
      const rows = state.shifts
        .filter((s) => s.createdBy === VM_USER_ID)
        .slice()
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
        .map(sentShiftJson);
      return send(res, 200, paginate(rows, q));
    }
    if (req.method === 'GET' && p === '/venues') return send(res, 200, paginate(VENUES, q));
    if (req.method === 'GET' && p === '/job-roles') return send(res, 200, paginate(ROLES, q));
    if (req.method === 'GET' && p === '/offers') return send(res, 200, paginate(state.vmOffers, q));
    m = p.match(/^\/shifts\/([0-9a-f-]{36})$/);
    if (req.method === 'GET' && m) {
      const sh = state.shifts.find((s) => s.id === m[1]);
      return sh ? send(res, 200, sh) : notFound(res);
    }
    if (req.method === 'GET' && (p === '/staff/venue-directory' || p === '/staff/venue-directory/pool')) {
      const pool = p.endsWith('/pool');
      const term = (q.get('q') || '').toLowerCase();
      const status = q.get('status');
      const startAt = q.get('startAt') ? new Date(q.get('startAt')) : null;
      const endAt = q.get('endAt') ? new Date(q.get('endAt')) : null;
      const rows = STAFF_POOL
        .filter((s) => pool || s.added)
        .filter((s) => !term || staffName(s).toLowerCase().includes(term))
        .filter((s) => !status || s.employmentStatus === status)
        .map((s) => directoryRow(s, startAt, endAt));
      const limit = Math.max(1, Number(q.get('limit') || 30));
      const page = Math.max(1, Number(q.get('page') || 1));
      return send(res, 200, { data: rows.slice((page - 1) * limit, page * limit), total: rows.length });
    }
    m = p.match(/^\/staff\/venue-directory\/team\/([^/]+)$/);
    if (req.method === 'POST' && m) {
      const st = staffById(m[1]);
      if (!st) return notFound(res);
      st.added = true;
      return send(res, 201, { ok: true });
    }
    if (req.method === 'POST' && p === '/shifts/request') {
      const venue = venueById(body.venueId);
      const role = roleById(body.jobRoleId);
      if (!venue || !role || !body.startsAt || !body.endsAt) return send(res, 400, { statusCode: 400, message: 'Invalid shift request', error: 'Bad Request' });
      const sh = {
        id: crypto.randomUUID(), organisationId: ORG_ID, venueId: venue.id, jobRoleId: role.id,
        startsAt: body.startsAt, endsAt: body.endsAt, status: 'pending_manager_approval',
        requiredCount: Number(body.staffRequired || (body.staffProfileIds || []).length || 1), filledCount: 0,
        breakMinutes: body.breakMinutes ?? venue.defaultBreakMinutes, address: venue.address, notes: '',
        createdBy: VM_USER_ID, createdAt: now.toISOString(),
      };
      state.shifts.push(sh);
      return send(res, 201, sh);
    }
    m = p.match(/^\/shifts\/([^/]+)\/offers\/bulk$/);
    if (req.method === 'POST' && m) {
      const sh = state.shifts.find((s) => s.id === m[1]);
      if (!sh) return notFound(res);
      const results = (body.staffProfileIds || []).map((id) => {
        const st = staffById(id);
        if (!st) return { staffProfileId: id, ok: false, message: 'Staff member not found.' };
        state.vmOffers.push({
          id: crypto.randomUUID(), status: 'pending', sentAt: now.toISOString(), expiresAt: iso(addMin(new Date(sh.startsAt), -360)),
          respondedAt: null, declineReason: null, staffAcceptedAt: null, managerConfirmedAt: null, managerRejectedAt: null, rejectionReason: null,
          estimatedPayPence: 0, shiftId: sh.id, startsAt: sh.startsAt, endsAt: sh.endsAt, venueName: venueById(sh.venueId).name,
          roleName: roleById(sh.jobRoleId).name, staffProfileId: st.id, staffName: staffName(st), payRatePence: 1300,
          venueAddress: sh.address, shiftNotes: null,
        });
        return { staffProfileId: id, ok: true };
      });
      return send(res, 201, { results });
    }
    m = p.match(/^\/attendance\/report\/shift\/([^/]+)$/);
    if (req.method === 'GET' && m) {
      let r = state.reports[m[1]];
      if (!r) {
        const sh = state.shifts.find((s) => s.id === m[1]);
        if (!sh) return notFound(res);
        r = { shiftId: sh.id, venueName: venueById(sh.venueId).name, roleName: roleById(sh.jobRoleId).name, startsAt: sh.startsAt, endsAt: sh.endsAt, reportStatus: 'awaiting_review', finalisedAt: null, staff: [] };
      }
      return send(res, 200, r);
    }
    m = p.match(/^\/attendance\/report\/shift\/([^/]+)\/finalise$/);
    if (req.method === 'PATCH' && m) {
      const r = state.reports[m[1]];
      if (!r) return notFound(res);
      if (r.staff.some((s) => ['clocked_in', 'on_break'].includes(s.attendanceStatus))) return send(res, 409, { statusCode: 409, message: 'Someone is still clocked in.' });
      r.reportStatus = 'finalised';
      r.finalisedAt = now.toISOString();
      r.staff.forEach((s) => s.attendanceId && (s.attendanceStatus = 'approved'));
      return send(res, 200, r);
    }
    m = p.match(/^\/attendance\/([^/]+)\/correct$/);
    if (req.method === 'POST' && m) {
      for (const r of Object.values(state.reports)) {
        const row = r.staff.find((s) => s.attendanceId === m[1]);
        if (!row) continue;
        if (!body.reason || String(body.reason).length < 10) return send(res, 400, { statusCode: 400, message: ['reason must be longer than or equal to 10 characters'], error: 'Bad Request' });
        if (body.field === 'breakMinutes') row.breakMinutes = Number(body.newValue);
        else if (body.field === 'clockInAt' || body.field === 'clockOutAt') row[body.field] = body.newValue;
        if (row.clockInAt && row.clockOutAt) {
          row.workedMinutes = Math.round((new Date(row.clockOutAt) - Math.max(new Date(row.clockInAt), new Date(row.scheduledStart))) / 60000) - (row.breakMinutes ?? row.scheduledBreakMinutes);
          row.earnedPence = String(Math.round((row.workedMinutes * 1300) / 60));
          if (row.attendanceStatus === 'missing_clock_out') row.attendanceStatus = 'clocked_out';
        }
        row.corrected = true;
        return send(res, 200, row);
      }
      return notFound(res);
    }
  }

  return notFound(res);
});

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`Crewflow mobile fixture server on http://0.0.0.0:${PORT}${PREFIX} (synthetic data, built ${state.builtAt.toISOString()})\n`);
});
const shutdown = () => {
  for (const c of sseClients) c.res.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
