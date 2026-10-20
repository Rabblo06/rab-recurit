// Stateful, in-browser fixture backend for documentation captures of the Crewflow web console.
//
// What is REAL: the running Vite build of packages/rab-front (every page, drawer, label and
// interaction is the production UI code). What is SYNTHETIC: every response to a
// `**/rest/v1/**` request, which is intercepted inside the browser with `page.route` and
// answered from the in-memory state below. Nothing reaches a real API, database or queue.
//
// All people, venues, emails and phone numbers are fictional (`@example.test`,
// `+44 7700 900xxx`, documentation IP ranges). Every date is computed relative to "now" so
// lists always look current whenever the harness runs.
'use strict';

const fs = require('fs');
const path = require('path');

const APP_ORIGIN = process.env.CREWFLOW_WEB_ORIGIN || 'http://127.0.0.1:5173';
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

// ─── Time helpers (local time, relative to now) ─────────────────────────────────────────────
const MIN = 60_000;
const HOUR = 60 * MIN;
function at(dayOffset, hour, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const plus = (iso, ms) => new Date(new Date(iso).getTime() + ms).toISOString();
const roundDown = (ms, step) => Math.floor(ms / step) * step;

let seq = 1000;
const uid = (prefix) => `${prefix}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// ─── Personas ──────────────────────────────────────────────────────────────────────────────
const ORG_ID = '7a0c2f5e-3b1d-4c8e-9f60-000000000001';
const PERSONAS = {
  manager: { id: 'u-jordan', firstName: 'Jordan', lastName: 'Hale', email: 'jordan.hale@example.test', roles: ['manager'], isPlatformAdmin: false, jobTitle: 'Operations manager', workspace: 'ready' },
  ceo: { id: 'u-casey', firstName: 'Casey', lastName: 'Lane', email: 'casey.lane@example.test', roles: ['ceo'], isPlatformAdmin: false, jobTitle: 'Managing director', workspace: 'ready' },
  platformAdmin: { id: 'u-robin', firstName: 'Robin', lastName: 'Ashford', email: 'robin.ashford@example.test', roles: ['ceo'], isPlatformAdmin: true, jobTitle: 'Platform administrator', workspace: 'ready' },
  newManager: { id: 'u-jordan', firstName: 'Jordan', lastName: 'Hale', email: 'jordan.hale@example.test', roles: ['manager'], isPlatformAdmin: false, jobTitle: null, workspace: 'none' },
  anon: null,
};

const CAPABILITY_FLAGS = ['staff.view', 'schedule.view', 'venue.view', 'offer.send', 'report.view', 'staffing_request.create', 'attendance.view',
  'venue_manager.create', 'report.export', 'attendance.edit', 'review.create', 'staff.create', 'staff.deactivate'];

// ─── Seed data ─────────────────────────────────────────────────────────────────────────────
function buildState(personaKey, opts = {}) {
  const persona = PERSONAS[personaKey] === undefined ? PERSONAS.manager : PERSONAS[personaKey];
  const s = {
    persona: personaKey,
    me: persona ? { ...persona } : null,
    files: {},
    pollCount: 0,
  };

  s.profile = persona
    ? { id: persona.id, email: persona.email, firstName: persona.firstName, lastName: persona.lastName, jobTitle: persona.jobTitle, avatarKey: opts.avatars === false ? null : 'avatar-' + persona.firstName.toLowerCase() }
    : null;
  if (personaKey === 'newManager') s.profile.avatarKey = null;

  s.workspace = persona && persona.workspace === 'ready'
    ? { id: 'ws-northwind', name: 'Northwind Staffing', subdomain: 'northwind', logoKey: 'logo-northwind', status: 'active', schemaStatus: 'READY', onboardingCompletedAt: at(-120, 9), createdAt: at(-120, 9) }
    : null;

  s.preferences = { theme: opts.theme || 'light', navPreference: 'side_panel', timezone: 'Europe/London', dateFormat: 'DD/MM/YYYY', timeFormat: '24h', firstDayOfWeek: 'monday' };

  s.notificationPrefs = [
    ['offer_sent', true, false], ['offer_expired', true, true], ['offer_accepted', true, true],
    ['offer_declined', true, false], ['offer_confirmed', true, false], ['offer_rejected', false, false],
  ].map(([notificationType, inAppEnabled, emailEnabled]) => ({ notificationType, inAppEnabled, emailEnabled }));

  s.sessions = [
    { familyId: 'sess-current', deviceId: 'dev-1', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', ip: '203.0.113.24', createdAt: at(-6, 8, 12), lastActiveAt: ago(2 * MIN), isCurrentDevice: true },
    { familyId: 'sess-mac', deviceId: 'dev-2', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', ip: '198.51.100.17', createdAt: at(-14, 18, 40), lastActiveAt: ago(26 * HOUR), isCurrentDevice: false },
    { familyId: 'sess-edge', deviceId: 'dev-3', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0', ip: '192.0.2.61', createdAt: at(-30, 10, 5), lastActiveAt: ago(5 * 24 * HOUR), isCurrentDevice: false },
  ];

  s.jobRoles = [
    { id: 'r-bar', name: 'Bartender', defaultRatePence: 1500 },
    { id: 'r-event', name: 'Event staff', defaultRatePence: 1400 },
    { id: 'r-chef', name: 'Chef de partie', defaultRatePence: 1700 },
    { id: 'r-ware', name: 'Warehouse operative', defaultRatePence: 1350 },
    { id: 'r-wait', name: 'Waiting staff', defaultRatePence: 1300 },
  ];

  const venueSeed = [
    ['v-grand', 'The Grand Hall', 'Grand Events Ltd', 'event', '1 Example Square', 'London', 'EC1A 9XX', 51.5155, -0.0922, 150, true, 30, false, 'Staff entrance on Example Lane. Black trousers and black shirt.'],
    ['v-river', 'Riverside House', 'Riverside Hotels Ltd', 'hotel', '22 Quay Example Road', 'Bristol', 'BS1 9XX', 51.4507, -2.5967, 200, false, 30, true, 'Sign in at the concierge desk.'],
    ['v-harbour', 'Harbour Kitchen', 'Harbour Group', 'restaurant', '8 Example Wharf', 'Bristol', 'BS1 8XX', 51.4486, -2.5986, 100, true, 20, false, null],
    ['v-north', 'Northgate Depot', 'Northgate Logistics', 'warehouse', 'Unit 4, Example Industrial Estate', 'Leeds', 'LS9 9XX', 53.7997, -1.5160, 300, true, 45, false, 'Safety boots required. Report to Goods In.'],
  ];
  s.venues = venueSeed.map(([id, name, clientName, type, line1, city, postcode, lat, lng, r, enforce, brk, paid, instructions], i) => ({
    id, name, clientName, type, address: { line1, city, postcode }, instructions, breakPaid: paid, defaultBreakMinutes: brk,
    lat, lng, geofenceRadiusM: r, enforceGeofence: enforce, status: 'active', createdAt: at(-150 + i * 9, 10),
  }));
  s.roleRates = {
    'v-grand': [{ id: 'rr-1', jobRoleId: 'r-event', payRatePence: 1450 }, { id: 'rr-2', jobRoleId: 'r-bar', payRatePence: 1600 }],
    'v-river': [{ id: 'rr-3', jobRoleId: 'r-wait', payRatePence: 1350 }],
    'v-harbour': [{ id: 'rr-4', jobRoleId: 'r-chef', payRatePence: 1750 }],
    'v-north': [],
  };

  const staffSeed = [
    ['Alex', 'Morgan', 'active', 'active', 1650, 'r-bar', 'Full-time'],
    ['Priya', 'Shah', 'active', 'active', 1500, 'r-event', 'Part-time'],
    ['Daniel', 'Okafor', 'active', 'active', 1700, 'r-chef', 'Full-time'],
    ['Ella', 'Brooks', 'invited', 'pending_compliance', 1400, 'r-wait', 'Casual'],
    ['Sam', 'Reed', 'active', 'active', 1550, 'r-ware', 'Temporary'],
    ['Maya', 'Lindqvist', 'active', 'active', 1450, 'r-wait', 'Part-time'],
    ['Tom', 'Hart', 'active', 'inactive', 1400, 'r-event', 'Casual'],
    ['Leah', 'Fischer', 'active', 'active', 1450, 'r-event', 'Casual'],
    ['Omar', 'Haddad', 'active', 'active', 1500, 'r-bar', 'Part-time'],
    ['Grace', 'Kim', 'active', 'active', 1350, 'r-wait', 'Casual'],
    ['Ben', 'Carter', 'active', 'active', 1400, 'r-event', 'Temporary'],
    ['Nina', 'Rossi', 'invited', 'pending_compliance', 1400, 'r-event', 'Casual'],
    ['Isla', 'Moore', 'active', 'active', 1350, 'r-wait', 'Part-time'],
    ['Kai', 'Turner', 'active', 'active', 1500, 'r-bar', 'Casual'],
    ['Zara', 'Ali', 'active', 'active', 1450, 'r-event', 'Full-time'],
    ['Finn', 'Walsh', 'active', 'active', 1400, 'r-event', 'Casual'],
  ];
  const cities = ['London', 'Bristol', 'Bristol', 'London', 'Leeds', 'Bristol', 'London', 'London', 'Leeds', 'Bristol', 'Leeds', 'London', 'Bristol', 'Bristol', 'London', 'London'];
  s.staff = staffSeed.map(([firstName, lastName, accountStatus, employmentStatus, rate, jobRoleId, employmentType], i) => ({
    id: `st-${firstName.toLowerCase()}`,
    staffRef: `STAFF ${i + 1}`,
    email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.test`,
    firstName, lastName,
    phone: `+44 7700 900${String(101 + i * 7).padStart(3, '0')}`,
    employmentStatus, accountStatus,
    invitationStatus: accountStatus === 'invited' ? 'pending' : null,
    pendingInvite: accountStatus === 'invited' ? { sendNumber: i === 11 ? 2 : 1, maxSendAttempts: 3, expiresAt: plus(new Date().toISOString(), 20 * HOUR) } : null,
    mustResetPassword: false,
    avatarKey: null,
    defaultPayRatePence: rate,
    jobRoleId, employmentType,
    startDate: at(-200 + i * 11, 0).slice(0, 10),
    dateOfBirth: `${1988 + (i % 9)}-0${1 + (i % 9)}-1${i % 9}`,
    preferredName: null,
    address: `${10 + i} Example Road`, city: cities[i], postcode: ['EX1 1AA', 'EX2 2BB', 'EX3 3CC'][i % 3],
    emergencyContactName: ['Jamie Morgan', 'Ravi Shah', 'Ada Okafor', 'Chris Brooks', 'Pat Reed', 'Lars Lindqvist', 'Jo Hart', 'Mia Fischer', 'Sara Haddad', 'Min Kim', 'Kate Carter', 'Luca Rossi', 'Rory Moore', 'Tess Turner', 'Amir Ali', 'Orla Walsh'][i],
    emergencyContactRelationship: ['Partner', 'Brother', 'Mother', 'Father', 'Partner', 'Father', 'Sister', 'Mother', 'Partner', 'Sister', 'Mother', 'Father', 'Brother', 'Mother', 'Father', 'Sister'][i],
    emergencyContactPhone: `+44 7700 900${String(600 + i * 3).padStart(3, '0')}`,
    availableDays: ['Monday', 'Tuesday', 'Thursday', 'Friday', 'Saturday'].slice(0, 3 + (i % 3)),
    preferredShiftTimes: ['Evening', 'Flexible', 'Afternoon', 'Morning'][i % 4],
    maxHoursPerWeek: [40, 24, 40, 16, 32][i % 5],
    createdAt: at(-125 + i * 6, 10, 15),
  }));
  s.staffSeq = s.staff.length;
  // A venue manager's team is assigned by the workspace owner on the web (Users -> Venue managers -> Assigned staff).
  s.vmTeams = { 'mg-riley': [['st-alex', 30], ['st-priya', 30], ['st-sam', 21], ['st-maya', 14], ['st-grace', 6]], 'mg-avery': [] };
  // Post-shift staff reviews written by venue managers (fictional). Five categories scored 1-5, optional written feedback.
  {
    const notes = [
      'Arrived early, well presented and calm under pressure during the evening rush.',
      'Friendly with guests and quick to help the bar team. Needs to check the rota board on arrival.',
      null,
      'Excellent service at the wedding reception. Guests commented on the attentiveness.',
      'Good shift overall. Took a long first break without telling the supervisor.',
      'Reliable and tidy. Happy to have back on any event.',
    ];
    const rows = [
      ['st-alex', 'mg-riley', 2, [5, 5, 4, 5, 5]], ['st-alex', 'mg-riley', 9, [4, 5, 4, 5, 4]], ['st-alex', 'mg-riley', 16, [5, 4, 5, 5, 5]],
      ['st-alex', 'mg-riley', 23, [4, 4, 4, 5, 3]], ['st-alex', 'mg-riley', 37, [5, 5, 5, 5, 5]], ['st-alex', 'mg-riley', 44, [3, 4, 4, 4, 4]],
      ['st-priya', 'mg-riley', 5, [4, 4, 5, 5, 5]], ['st-priya', 'mg-riley', 19, [5, 5, 5, 4, 5]],
    ];
    s.reviews = rows.map(([staffProfileId, reviewer, daysAgo, r], i) => {
      const startsAt = at(-daysAgo, 17); const endsAt = at(-daysAgo, 23);
      return { id: `rv-${i + 1}`, staffProfileId, reviewerUserId: reviewer, venueName: 'Riverside House', roleName: i % 2 ? 'Bartender' : 'Waiting staff', startsAt, endsAt,
        ratings: { grooming: r[0], attitude: r[1], skills: r[2], attendance: r[3], timeKeeping: r[4] }, feedback: notes[i % notes.length], submittedAt: plus(endsAt, 50 * MIN) };
    });
  }

  s.managers = [
    { id: 'mg-jordan', firstName: 'Jordan', lastName: 'Hale', email: 'jordan.hale@example.test', phone: '+44 7700 900201', type: 'internal', jobTitle: 'Operations manager', accountStatus: 'active', invitationStatus: null, pendingInvite: null, mustResetPassword: false, avatarKey: null, createdAt: at(-120, 9) },
    { id: 'mg-riley', firstName: 'Riley', lastName: 'Chen', email: 'riley.chen@example.test', phone: '+44 7700 900214', type: 'venue', jobTitle: 'Venue manager', accountStatus: 'active', invitationStatus: null, pendingInvite: null, mustResetPassword: false, avatarKey: null, createdAt: at(-60, 11), venueIds: ['v-river'] },
    { id: 'mg-avery', firstName: 'Avery', lastName: 'Quinn', email: 'avery.quinn@example.test', phone: '+44 7700 900227', type: 'venue', jobTitle: 'Duty manager', accountStatus: 'invited', invitationStatus: 'pending', pendingInvite: { sendNumber: 1, maxSendAttempts: 3 }, mustResetPassword: false, avatarKey: null, createdAt: ago(3 * HOUR), venueIds: ['v-harbour'] },
  ];

  // Shifts. Columns: id, venue, role, startsAt, endsAt, required, status, extra
  const now = Date.now();
  const liveStart = new Date(roundDown(now - 45 * MIN, 15 * MIN)).toISOString();
  const mk = (id, venueId, jobRoleId, startsAt, endsAt, requiredCount, status, extra = {}) => {
    const rate = (s.roleRates[venueId] || []).find((r) => r.jobRoleId === jobRoleId)?.payRatePence ?? s.jobRoles.find((r) => r.id === jobRoleId).defaultRatePence;
    const v = s.venues.find((x) => x.id === venueId);
    return { id, venueId, jobRoleId, startsAt, endsAt, breakMinutes: v.defaultBreakMinutes ?? 30, requiredCount, filledCount: 0, payRatePence: rate, status, notes: null, title: null, address: `${v.address.line1}, ${v.address.city} ${v.address.postcode}`, createdAt: ago(3 * 24 * HOUR), requestedBy: null, submittedAt: null, declinedReason: null, ...extra };
  };
  s.shifts = [
    mk('sh-grand-today', 'v-grand', 'r-event', at(0, 9), at(0, 17), 6, 'partially_filled'),
    mk('sh-river-today', 'v-river', 'r-bar', at(0, 17), at(0, 23), 2, 'confirmed'),
    mk('sh-harbour-tmrw', 'v-harbour', 'r-chef', at(1, 11), at(1, 19), 3, 'offered', { notes: 'Lunch and dinner service. Whites provided.' }),
    mk('sh-north-tmrw', 'v-north', 'r-ware', at(1, 7), at(1, 15), 2, 'partially_filled'),
    mk('sh-north-2', 'v-north', 'r-ware', at(2, 6), at(2, 14), 5, 'fully_filled'),
    mk('sh-grand-3', 'v-grand', 'r-bar', at(3, 18), at(3, 23, 30), 4, 'offered'),
    mk('sh-river-4', 'v-river', 'r-wait', at(4, 12), at(4, 20), 3, 'partially_filled'),
    mk('sh-grand-draft', 'v-grand', 'r-event', at(6, 10), at(6, 16), 5, 'draft'),
    mk('sh-harbour-past', 'v-harbour', 'r-bar', at(-1, 16), at(-1, 23), 2, 'completed'),
    mk('sh-north-past', 'v-north', 'r-ware', at(-2, 6), at(-2, 14), 4, 'completed'),
    mk('sh-river-cancel', 'v-river', 'r-event', at(-3, 18), at(-3, 23), 3, 'cancelled'),
    // Venue Manager requests (Venue Offers)
    mk('vr-river-wedding', 'v-river', 'r-wait', at(3, 12), at(3, 18), 4, 'pending_manager_approval', { requestedBy: 'mg-riley', submittedAt: ago(50 * MIN), notes: 'Wedding reception for 120 guests. Smart black uniform, arrive 15 minutes early.' }),
    mk('vr-grand-live', 'v-grand', 'r-event', liveStart, plus(liveStart, 8 * HOUR), 8, 'in_progress', { requestedBy: 'mg-riley', submittedAt: at(-4, 14, 20), notes: 'Conference day. Registration desk and cloakroom.' }),
    mk('vr-harbour-done', 'v-harbour', 'r-bar', at(-1, 16), at(-1, 23), 3, 'completed', { requestedBy: 'mg-riley', submittedAt: at(-6, 10, 5), notes: 'Private dining event.' }),
    mk('vr-north-declined', 'v-north', 'r-ware', at(5, 6), at(5, 14), 3, 'declined', { requestedBy: 'mg-riley', submittedAt: at(-2, 9, 40), declinedReason: 'Covered by the internal team this week.', notes: 'Stock take support.' }),
    mk('vr-river-offered', 'v-river', 'r-event', at(7, 17), at(7, 23), 3, 'offered', { requestedBy: 'mg-riley', submittedAt: at(-1, 15, 10), notes: 'Gala dinner. Black tie.' }),
  ];

  // Offers. [shiftId, staffKey, status, batch, extra]
  s.offers = [];
  s.attendance = [];
  const staffBy = (k) => s.staff.find((x) => x.id === `st-${k}`);
  const addOffer = (shiftId, k, status, batch = null, extra = {}) => {
    const shift = s.shifts.find((x) => x.id === shiftId);
    const sentAt = extra.sentAt ?? plus(shift.createdAt, 30 * MIN);
    const o = {
      id: uid('of'), shiftId, staffProfileId: staffBy(k).id, status, offerBatchId: batch, sentAt,
      expiresAt: plus(sentAt, 48 * HOUR),
      respondedAt: status === 'pending' ? null : plus(sentAt, 2 * HOUR),
      staffAcceptedAt: ['staff_accepted', 'manager_confirmed'].includes(status) ? (extra.staffAcceptedAt ?? plus(sentAt, 2 * HOUR)) : null,
      managerConfirmedAt: status === 'manager_confirmed' ? plus(sentAt, 3 * HOUR) : null,
      managerRejectedAt: status === 'manager_rejected' ? plus(sentAt, 3 * HOUR) : null,
      rejectionReason: null, declineReason: status === 'declined' ? (extra.declineReason ?? 'Unavailable on this date.') : null,
      withdrawnReason: null, cancelledAt: null, notificationReadAt: extra.notificationReadAt ?? null,
    };
    s.offers.push(o);
    return o;
  };
  const addAttendance = (shiftId, k, inOffsetMin, outOffsetMin, breakMin) => {
    const shift = s.shifts.find((x) => x.id === shiftId);
    const clockInAt = plus(shift.startsAt, inOffsetMin * MIN);
    const clockOutAt = outOffsetMin == null ? null : plus(shift.endsAt, outOffsetMin * MIN);
    s.attendance.push({ id: uid('at'), shiftId, staffProfileId: staffBy(k).id, clockInAt, clockOutAt, breakMinutes: clockOutAt ? breakMin : null, status: clockOutAt ? 'completed' : 'active' });
  };

  // Today at The Grand Hall and Riverside House (direct)
  ['zara', 'finn'].forEach((k) => addOffer('sh-grand-today', k, 'manager_confirmed', 'b-grand-today', { sentAt: at(-3, 10) }));
  addOffer('sh-grand-today', 'kai', 'pending', 'b-grand-today', { sentAt: at(-3, 10) });
  addOffer('sh-river-today', 'isla', 'manager_confirmed', 'b-river-today', { sentAt: at(-2, 9) });
  addOffer('sh-river-today', 'grace', 'manager_confirmed', 'b-river-today', { sentAt: at(-2, 9) });
  // Tomorrow at Harbour Kitchen: three accepted and waiting for confirmation (batch)
  addOffer('sh-harbour-tmrw', 'priya', 'staff_accepted', 'b-harbour', { sentAt: ago(20 * HOUR), staffAcceptedAt: ago(42 * MIN) });
  addOffer('sh-harbour-tmrw', 'daniel', 'staff_accepted', 'b-harbour', { sentAt: ago(20 * HOUR), staffAcceptedAt: ago(3 * HOUR) });
  addOffer('sh-harbour-tmrw', 'grace', 'staff_accepted', 'b-harbour', { sentAt: ago(20 * HOUR), staffAcceptedAt: ago(5 * HOUR) });
  addOffer('sh-harbour-tmrw', 'leah', 'declined', 'b-harbour', { sentAt: ago(20 * HOUR) });
  // Tomorrow at Northgate: Sam confirmed (used to demonstrate the overlap rule)
  addOffer('sh-north-tmrw', 'sam', 'manager_confirmed', null, { sentAt: ago(30 * HOUR) });
  ['sam', 'omar', 'ben', 'leah', 'alex'].forEach((k) => addOffer('sh-north-2', k, 'manager_confirmed', 'b-north-2', { sentAt: at(-4, 15) }));
  // Grand Hall bar shift: mixed responses (batch)
  addOffer('sh-grand-3', 'alex', 'staff_accepted', 'b-grand-3', { sentAt: ago(9 * HOUR), staffAcceptedAt: ago(4 * HOUR) });
  addOffer('sh-grand-3', 'maya', 'staff_accepted', 'b-grand-3', { sentAt: ago(9 * HOUR), staffAcceptedAt: ago(90 * MIN) });
  addOffer('sh-grand-3', 'omar', 'declined', 'b-grand-3', { sentAt: ago(9 * HOUR) });
  addOffer('sh-grand-3', 'ben', 'pending', 'b-grand-3', { sentAt: ago(9 * HOUR) });
  addOffer('sh-river-4', 'maya', 'manager_confirmed', 'b-river-4', { sentAt: ago(28 * HOUR) });
  addOffer('sh-river-4', 'grace', 'pending', 'b-river-4', { sentAt: ago(28 * HOUR) });
  addOffer('sh-river-4', 'leah', 'withdrawn', 'b-river-4', { sentAt: ago(28 * HOUR) });
  addOffer('sh-harbour-past', 'isla', 'manager_confirmed', null, { sentAt: at(-4, 9) });
  addOffer('sh-harbour-past', 'kai', 'manager_confirmed', null, { sentAt: at(-4, 9) });
  ['sam', 'ben', 'leah', 'priya'].forEach((k) => addOffer('sh-north-past', k, 'manager_confirmed', 'b-north-past', { sentAt: at(-6, 9) }));
  addOffer('sh-river-cancel', 'priya', 'withdrawn', null, { sentAt: at(-6, 9) });
  // Venue request: live (in progress) — every pipeline stage represented
  addOffer('vr-grand-live', 'ben', 'pending', 'b-live', { sentAt: ago(70 * MIN) });
  addOffer('vr-grand-live', 'omar', 'pending', 'b-live', { sentAt: ago(70 * MIN), notificationReadAt: ago(40 * MIN) });
  addOffer('vr-grand-live', 'leah', 'staff_accepted', 'b-live', { sentAt: at(-3, 11), staffAcceptedAt: ago(25 * MIN) });
  addOffer('vr-grand-live', 'sam', 'manager_confirmed', 'b-live', { sentAt: at(-3, 11) });
  addOffer('vr-grand-live', 'alex', 'manager_confirmed', 'b-live', { sentAt: at(-3, 11) });
  addOffer('vr-grand-live', 'priya', 'manager_confirmed', 'b-live', { sentAt: at(-3, 11) });
  addOffer('vr-grand-live', 'daniel', 'manager_confirmed', 'b-live', { sentAt: at(-3, 11) });
  addOffer('vr-grand-live', 'maya', 'manager_confirmed', 'b-live', { sentAt: at(-3, 11) });
  addOffer('vr-grand-live', 'grace', 'declined', 'b-live', { sentAt: at(-3, 11) });
  // Venue request: completed yesterday
  ['alex', 'sam', 'maya'].forEach((k) => addOffer('vr-harbour-done', k, 'manager_confirmed', 'b-done', { sentAt: at(-5, 12) }));
  // Venue request: approved and offered next week
  ['priya', 'leah', 'ben'].forEach((k) => addOffer('vr-river-offered', k, 'pending', 'b-river-offered', { sentAt: ago(20 * HOUR), notificationReadAt: k === 'leah' ? ago(5 * HOUR) : null }));

  // Attendance
  addAttendance('sh-harbour-past', 'isla', -6, 4, 20);
  addAttendance('sh-harbour-past', 'kai', 1, 0, 20);
  ['sam', 'ben', 'leah', 'priya'].forEach((k, i) => addAttendance('sh-north-past', k, -5 + i * 3, i === 2 ? -30 : 2, 45));
  // Live venue request: three clocked in, one finished a short early slot
  addAttendance('vr-grand-live', 'alex', -3, null);
  addAttendance('vr-grand-live', 'priya', 1, null);
  addAttendance('vr-grand-live', 'daniel', 4, null);
  {
    const shift = s.shifts.find((x) => x.id === 'vr-grand-live');
    s.attendance.push({ id: uid('at'), shiftId: shift.id, staffProfileId: 'st-maya', clockInAt: plus(shift.startsAt, -8 * MIN), clockOutAt: ago(6 * MIN), breakMinutes: 0, status: 'completed' });
  }
  ['alex', 'sam', 'maya'].forEach((k, i) => addAttendance('vr-harbour-done', k, -5 + i * 2, i === 1 ? 12 : 3, 30));
  // Older completed history for payroll
  for (let d = 4; d <= 9; d++) {
    const id = `sh-hist-${d}`;
    const venue = ['v-grand', 'v-river', 'v-harbour', 'v-north'][d % 4];
    const role = { 'v-grand': 'r-event', 'v-river': 'r-wait', 'v-harbour': 'r-chef', 'v-north': 'r-ware' }[venue];
    s.shifts.push(mk(id, venue, role, at(-d, 8 + (d % 3) * 3), at(-d, 15 + (d % 3) * 3), 2, 'completed'));
    const people = [['alex', 'priya'], ['maya', 'grace'], ['daniel', 'omar'], ['sam', 'ben'], ['leah', 'priya'], ['grace', 'maya']][d - 4];
    people.forEach((k, i) => { addOffer(id, k, 'manager_confirmed', null, { sentAt: at(-d - 3, 10) }); addAttendance(id, k, -3 + i * 4, i ? 5 : -10, 30); });
  }
  recomputeFilled(s);

  s.requestedStaff = { 'vr-river-wedding': ['st-priya', 'st-grace'] };

  s.notifications = [
    { id: 'n-1', type: 'offer_accepted', title: 'Offer accepted', message: 'Priya Shah accepted Chef de partie at Harbour Kitchen.', readAt: null, createdAt: ago(42 * MIN) },
    { id: 'n-2', type: 'shift_request', title: 'New shift request', message: 'Riley Chen requested 4 Waiting staff at Riverside House.', readAt: null, createdAt: ago(50 * MIN) },
    { id: 'n-3', type: 'offer_accepted', title: 'Offer accepted', message: 'Maya Lindqvist accepted Bartender at The Grand Hall.', readAt: null, createdAt: ago(90 * MIN) },
    { id: 'n-4', type: 'offer_declined', title: 'Offer declined', message: 'Omar Haddad declined Bartender at The Grand Hall.', readAt: ago(3 * HOUR), createdAt: ago(6 * HOUR) },
  ];

  const actor = (n) => ({ fullName: n });
  const auditSeed = [
    [3, 'offer.accepted', 'Priya Shah', 'offer', 'Chef de partie · Harbour Kitchen'],
    [50, 'shift.request_submitted', 'Riley Chen', 'shift', 'Riverside House · Waiting staff'],
    [95, 'offer.confirmed', 'Jordan Hale', 'offer', 'Sam Reed · Northgate Depot'],
    [140, 'attendance.clocked_in', 'Alex Morgan', 'attendance', 'The Grand Hall'],
    [170, 'offer.sent', 'Jordan Hale', 'offer', 'Bartender · The Grand Hall'],
    [240, 'user.invite_queued', 'Jordan Hale', 'user', 'Avery Quinn'],
    [300, 'manager.venue_assigned', 'Jordan Hale', 'manager', 'Avery Quinn → Harbour Kitchen'],
    [420, 'offer.declined', 'Omar Haddad', 'offer', 'Bartender · The Grand Hall'],
    [600, 'role.permissions_updated', 'Jordan Hale', 'role', 'Shift coordinator'],
    [1500, 'attendance.clocked_out', 'Sam Reed', 'attendance', 'Northgate Depot'],
    [1560, 'profile.updated', 'Jordan Hale', 'user', 'Jordan Hale'],
    [2900, 'user.activated', 'Leah Fischer', 'user', 'Leah Fischer'],
    [3100, 'manager_workspace.updated', 'Jordan Hale', 'manager workspace', 'Northwind Staffing'],
    [4300, 'offer.withdrawn', 'Jordan Hale', 'offer', 'Leah Fischer · Riverside House'],
    [5800, 'user.created', 'Jordan Hale', 'user', 'Nina Rossi'],
  ];
  s.audit = auditSeed.map(([minsAgo, action, who, targetType, name], i) => ({ id: `al-${i}`, action, actor: actor(who), metadata: { name }, targetType, targetId: uid('t'), createdAt: ago(minsAgo * MIN) }));

  s.timelines = {};
  s.notes = {
    'st-alex': [{ id: 'note-1', authorName: 'Jordan Hale', body: 'Strong on cocktail service. Happy to cover late finishes at The Grand Hall.', createdAt: at(-12, 16) }],
  };
  s.emails = {
    'st-alex': [{ id: 'em-1', subject: 'Your shifts next week', status: 'SENT', createdAt: at(-5, 9, 30) }],
  };

  s.members = persona ? [
    { userId: persona.id, firstName: persona.firstName, lastName: persona.lastName, email: persona.email, roles: [], status: 'active', isOwner: true },
    { userId: 'u-morgan', firstName: 'Morgan', lastName: 'Pike', email: 'morgan.pike@example.test', roles: [{ id: 'role-coord', name: 'Shift coordinator', isMemberRole: true }], status: 'active', isOwner: false },
    { userId: 'u-sasha', firstName: 'Sasha', lastName: 'Ward', email: 'sasha.ward@example.test', roles: [{ id: 'role-coord', name: 'Shift coordinator', isMemberRole: true }], status: 'pending_setup', isOwner: false },
  ] : [];
  s.memberInvitations = [
    { id: 'mi-1', email: 'harper.wells@example.test', role: { id: 'role-coord', name: 'Shift coordinator' }, status: 'sent', sendCount: 1, maxSends: 3, expiresAt: plus(ago(5 * HOUR), 24 * HOUR), lastSentAt: ago(5 * HOUR), createdAt: ago(5 * HOUR), invitedByName: persona ? `${persona.firstName} ${persona.lastName}` : null },
  ];
  s.roles = [
    { id: 'role-manager', key: 'manager', name: 'Manager', isSystem: true, assignedUserCount: 1 },
    { id: 'role-staff', key: 'staff', name: 'Staff', isSystem: true, assignedUserCount: 12 },
    { id: 'role-venue', key: 'venue_manager', name: 'Venue manager', isSystem: true, assignedUserCount: 2 },
    { id: 'role-coord', key: 'shift_coordinator', name: 'Shift coordinator', isSystem: false, assignedUserCount: 0 },
  ];

  s.organisations = [
    { id: 'org-northwind', name: 'Northwind Staffing', slug: 'northwind', suspended: false, createdAt: at(-120, 9), ceo: { id: 'u-casey', email: 'casey.lane@example.test', firstName: 'Casey', lastName: 'Lane', accountStatus: 'active' } },
    { id: 'org-harbourline', name: 'Harbourline Hospitality', slug: 'harbourline', suspended: false, createdAt: at(-64, 14), ceo: { id: 'u-h1', email: 'morgan.ellis@example.test', firstName: 'Morgan', lastName: 'Ellis', accountStatus: 'active' } },
    { id: 'org-summit', name: 'Summit Events Co', slug: 'summit-events', suspended: false, createdAt: at(-9, 11), ceo: { id: 'u-h2', email: 'jules.baker@example.test', firstName: 'Jules', lastName: 'Baker', accountStatus: 'invited' } },
    { id: 'org-bluebell', name: 'Bluebell Catering', slug: 'bluebell', suspended: true, createdAt: at(-210, 10), ceo: { id: 'u-h3', email: 'drew.parker@example.test', firstName: 'Drew', lastName: 'Parker', accountStatus: 'active' } },
  ];
  return s;
}

function recomputeFilled(s) {
  for (const sh of s.shifts) {
    sh.filledCount = s.offers.filter((o) => o.shiftId === sh.id && o.status === 'manager_confirmed').length;
  }
}

// ─── Views (response shapes) ────────────────────────────────────────────────────────────────
const fullName = (p) => `${p.firstName} ${p.lastName}`;
function offerView(s, o) {
  const sh = s.shifts.find((x) => x.id === o.shiftId);
  const st = s.staff.find((x) => x.id === o.staffProfileId);
  const hours = (new Date(sh.endsAt) - new Date(sh.startsAt)) / HOUR - (sh.breakMinutes || 0) / 60;
  return {
    id: o.id, status: o.status, sentAt: o.sentAt, expiresAt: o.expiresAt, respondedAt: o.respondedAt, declineReason: o.declineReason,
    staffAcceptedAt: o.staffAcceptedAt, managerConfirmedAt: o.managerConfirmedAt, managerRejectedAt: o.managerRejectedAt, rejectionReason: o.rejectionReason,
    estimatedPayPence: Math.round(hours * sh.payRatePence), offerBatchId: o.offerBatchId, shiftId: sh.id, startsAt: sh.startsAt, endsAt: sh.endsAt,
    venueName: venueName(s, sh.venueId), roleName: roleName(s, sh.jobRoleId), staffProfileId: st.id, staffName: fullName(st),
  };
}
const venueName = (s, id) => s.venues.find((v) => v.id === id)?.name ?? '–';
const roleName = (s, id) => s.jobRoles.find((r) => r.id === id)?.name ?? '–';
function attendanceView(s, a) {
  const sh = s.shifts.find((x) => x.id === a.shiftId);
  const st = s.staff.find((x) => x.id === a.staffProfileId);
  let workedMinutes = null; let earnedPence = null;
  if (a.clockOutAt) {
    workedMinutes = Math.max(0, Math.round((new Date(a.clockOutAt) - new Date(a.clockInAt)) / MIN) - (a.breakMinutes || 0));
    earnedPence = Math.round((workedMinutes / 60) * sh.payRatePence);
  }
  return { id: a.id, status: a.status, clockInAt: a.clockInAt, clockOutAt: a.clockOutAt, workedMinutes, earnedPence, shiftId: sh.id, startsAt: sh.startsAt, endsAt: sh.endsAt, venueId: sh.venueId, venueName: venueName(s, sh.venueId), roleName: roleName(s, sh.jobRoleId), staffProfileId: st.id, staffName: fullName(st) };
}
function staffView(s, st) {
  if (st.invitationStatus === 'queued' && st.inviteSettlesAt && Date.now() > st.inviteSettlesAt) st.invitationStatus = 'pending';
  return { ...st };
}
function shiftView(sh) {
  const { requestedBy, submittedAt, ...rest } = sh;
  return rest;
}
function venueRequestView(s, sh) {
  const offers = s.offers.filter((o) => o.shiftId === sh.id);
  const confirmed = offers.filter((o) => o.status === 'manager_confirmed').length;
  const accepted = offers.filter((o) => o.status === 'staff_accepted').length;
  const rejected = offers.filter((o) => o.status === 'declined').length;
  const selected = sh.status === 'pending_manager_approval' || sh.status === 'declined' ? (s.requestedStaff[sh.id] || []).length : offers.filter((o) => !['declined', 'withdrawn', 'expired', 'manager_rejected'].includes(o.status)).length;
  const mgr = s.managers.find((m) => m.id === sh.requestedBy);
  return {
    id: sh.id, status: sh.status, displayStatus: resolveVenueOfferStatus({ status: sh.status, required: sh.requiredCount, confirmed, accepted, rejected }),
    startsAt: sh.startsAt, endsAt: sh.endsAt, requiredCount: sh.requiredCount, selectedCount: String(selected), payRatePence: sh.payRatePence, notes: sh.notes,
    submittedAt: sh.submittedAt, venueName: venueName(s, sh.venueId), roleName: roleName(s, sh.jobRoleId), venueManagerName: mgr ? fullName(mgr) : '–',
  };
}
// Mirrors rab-server venue-offer-presentation.ts (resolveVenueOfferStatus).
function resolveVenueOfferStatus({ status, required, confirmed, accepted, rejected }) {
  if (status === 'declined') return 'Declined';
  if (status === 'pending_manager_approval') return 'Pending approval';
  if (confirmed >= required && required > 0) return 'Fully filled';
  if (rejected > 0) return `${rejected} staff rejected`;
  if (confirmed + accepted > 0) return 'Partially filled';
  return 'Offered';
}
// The 12 lanes, in board order (rab-server venue-offer-presentation.ts PIPELINE_STAGES).
const STAGES = ['OFFERED', 'WAITING', 'STAFF ACCEPTED', 'CONFIRMED', 'LATE STAFF', 'CLOCKED IN', 'PENDING REVIEW', 'CLOCKED OUT', 'NO SHOW', 'REJECTED', 'CANCELLED', 'DELETED OFFER'];
const OUT_OF_SHIFT = ['NO SHOW', 'REJECTED', 'CANCELLED', 'DELETED OFFER'];
const GRACE_MINUTES = 10;
function assignmentStatusOf(o, shift) {
  return { pending: 'offered', staff_accepted: 'staff_accepted', manager_confirmed: shift.status === 'completed' ? 'completed' : 'confirmed', declined: 'declined', withdrawn: 'withdrawn', expired: 'expired', manager_rejected: 'rejected' }[o.status] || 'offered';
}
// Mirrors rab-server venue-offer-presentation.ts (resolveVenueOfferKanbanStage) and late-clock-in.ts.
function stageOf(o, shift, att) {
  const attendance = att?.status ?? null;
  if (att?.clockOutAt) return ['under_review', 'disputed'].includes(attendance) && !att.reviewedAt ? 'PENDING REVIEW' : 'CLOCKED OUT';
  if (att?.clockInAt) return ['missing_clock_out', 'disputed'].includes(attendance) ? 'PENDING REVIEW' : 'CLOCKED IN';
  const assignment = o.noShow ? 'no_show' : assignmentStatusOf(o, shift);
  if (assignment === 'no_show') return 'NO SHOW';
  if (shift.status === 'cancelled' || assignment === 'cancelled' || o.cancelledAt) return 'CANCELLED';
  if (o.status === 'declined' || o.status === 'manager_rejected' || assignment === 'rejected') return 'REJECTED';
  if (['expired', 'withdrawn'].includes(o.status)) return 'DELETED OFFER';
  if (assignment === 'confirmed' || assignment === 'completed') {
    const late = shift.status !== 'completed' && new Date(shift.startsAt).getTime() <= Date.now() - GRACE_MINUTES * MIN;
    return late ? 'LATE STAFF' : 'CONFIRMED';
  }
  if (o.status === 'staff_accepted') return 'STAFF ACCEPTED';
  if (o.status === 'pending') return o.notificationReadAt ? 'WAITING' : 'OFFERED';
  return 'DELETED OFFER';
}
function pipelineView(s, shiftId) {
  const sh = s.shifts.find((x) => x.id === shiftId);
  if (!sh) return null;
  const now = Date.now();
  const staff = s.offers.filter((o) => o.shiftId === sh.id).map((o) => {
    const st = s.staff.find((x) => x.id === o.staffProfileId);
    const att = s.attendance.find((a) => a.shiftId === sh.id && a.staffProfileId === st.id);
    const stage = stageOf(o, sh, att);
    const assignmentStatus = assignmentStatusOf(o, sh);
    const workedMinutes = att?.clockOutAt ? Math.max(0, Math.round((new Date(att.clockOutAt) - new Date(att.clockInAt)) / MIN) - (att.breakMinutes || 0)) : null;
    return {
      staffProfileId: st.id, name: fullName(st), avatarFileId: null, offerId: o.id, stage, offerStatus: o.status, assignmentStatus,
      attendanceStatus: att ? att.status : null, sentAt: o.sentAt, acceptedAt: o.staffAcceptedAt, respondedAt: o.respondedAt, cancelledAt: o.cancelledAt,
      terminalSource: !OUT_OF_SHIFT.includes(stage) ? null : o.cancelledAt ? 'Cancelled by Internal Manager' : o.status === 'declined' ? 'Declined by staff' : o.status === 'expired' ? 'Offer expired' : o.status === 'manager_rejected' ? 'Rejected by manager' : sh.status === 'cancelled' ? 'Shift cancelled' : o.status === 'withdrawn' ? 'Offer withdrawn' : null,
      clockInAt: att?.clockInAt ?? null, clockOutAt: att?.clockOutAt ?? null, breakMinutes: att?.clockOutAt ? att.breakMinutes : null, workedMinutes,
      declineReason: o.declineReason, withdrawnReason: o.withdrawnReason, rejectionReason: o.rejectionReason,
      canManagerCancel: !['cancelled', 'completed', 'declined', 'pending_manager_approval'].includes(sh.status) && now < new Date(sh.startsAt).getTime() - 15 * MIN && !att && ['pending', 'staff_accepted', 'manager_confirmed'].includes(o.status),
    };
  });
  const count = (stage) => staff.filter((r) => r.stage === stage).length;
  const confirmed = staff.filter((r) => ['confirmed', 'completed'].includes(r.assignmentStatus)).length;
  const accepted = staff.filter((r) => r.assignmentStatus === 'staff_accepted').length;
  const rejected = staff.filter((r) => r.offerStatus === 'declined').length;
  const reserved = staff.filter((r) => ['offered', 'staff_accepted', 'confirmed', 'completed'].includes(r.assignmentStatus) && !['withdrawn', 'declined', 'expired', 'manager_rejected'].includes(r.offerStatus)).length;
  const live = staff.filter((r) => !OUT_OF_SHIFT.includes(r.stage));
  const ready = live.length > 0 && live.every((r) => r.clockOutAt);
  const finalised = sh.status === 'completed';
  const report = {
    ready,
    originalFileId: ready ? `timesheet-original-${sh.id}` : null,
    signedFileId: ready && finalised ? `timesheet-signed-${sh.id}` : null,
    reportStatus: finalised ? 'finalised' : ready ? 'ready' : 'pending',
    finalisedByName: finalised ? 'Riley Chen' : null,
    finalisedAt: finalised ? plus(sh.endsAt, 40 * MIN) : null,
    staff: live.map((r) => ({ roleName: roleName(s, sh.jobRoleId), staffProfileId: r.staffProfileId, staffName: r.name, avatarFileId: null, clockInAt: r.clockInAt, clockOutAt: r.clockOutAt, breakMinutes: r.breakMinutes, workedMinutes: r.workedMinutes, attendanceStatus: r.attendanceStatus, assignmentStatus: r.assignmentStatus, corrected: false })),
  };
  return {
    shift: { id: sh.id, venueName: venueName(s, sh.venueId), roleName: roleName(s, sh.jobRoleId), startsAt: sh.startsAt, endsAt: sh.endsAt, status: sh.status, requiredCount: sh.requiredCount },
    serverNow: new Date().toISOString(),
    tableStatus: resolveVenueOfferStatus({ status: sh.status, required: sh.requiredCount, confirmed, accepted, rejected }),
    summary: { required: sh.requiredCount, filled: confirmed, open: Math.max(0, sh.requiredCount - confirmed), offered: count('OFFERED'), waiting: count('WAITING'), accepted: count('STAFF ACCEPTED'), confirmed: count('CONFIRMED'), late: count('LATE STAFF'), clockedIn: count('CLOCKED IN'), pendingReview: count('PENDING REVIEW'), clockedOut: count('CLOCKED OUT'), noShow: count('NO SHOW'), rejected: count('REJECTED'), cancelled: count('CANCELLED'), deleted: count('DELETED OFFER') },
    stageCounts: Object.fromEntries(STAGES.map((st) => [st, count(st)])),
    stages: STAGES, staff, report,
    replacementPlaces: !['cancelled', 'completed'].includes(sh.status) && now < new Date(sh.startsAt).getTime() ? Math.max(0, sh.requiredCount - reserved) : 0,
  };
}

// ─── Staff reviews ─────────────────────────────────────────────────────────────────────────
const REVIEW_KEYS = ['grooming', 'attitude', 'skills', 'attendance', 'timeKeeping'];
const reviewScore = (rv) => Math.round((REVIEW_KEYS.reduce((a, k) => a + rv.ratings[k], 0) / REVIEW_KEYS.length) * 10) / 10;
function staffReviewsView(s, st, q) {
  let rows = s.reviews.filter((rv) => rv.staffProfileId === st.id);
  const reviewer = q.get('reviewer');
  const range = q.get('range');
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  if (range === 'this_month') rows = rows.filter((rv) => new Date(rv.startsAt) >= monthStart);
  if (range === 'last_month') rows = rows.filter((rv) => new Date(rv.startsAt) >= lastMonthStart && new Date(rv.startsAt) < monthStart);
  if (range === 'custom') {
    if (q.get('from')) rows = rows.filter((rv) => rv.startsAt.slice(0, 10) >= q.get('from'));
    if (q.get('to')) rows = rows.filter((rv) => rv.startsAt.slice(0, 10) <= q.get('to'));
  }
  const reviewers = s.managers.filter((m) => m.type === 'venue' && m.accountStatus === 'active').map((m) => ({ userId: m.id, name: fullName(m), venues: (m.venueIds || []).map((id) => venueName(s, id)), reviews: rows.filter((rv) => rv.reviewerUserId === m.id).length }));
  if (reviewer) rows = rows.filter((rv) => rv.reviewerUserId === reviewer);
  const total = rows.length;
  const avg = (vals) => (vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null);
  const scores = rows.map(reviewScore);
  const distribution = [5, 4, 3, 2, 1].map((stars) => { const count = scores.filter((x) => Math.round(x) === stars).length; return { stars, count, percent: total ? Math.round((count / total) * 100) : 0 }; });
  return {
    staff: { id: st.id, name: fullName(st), roleName: roleName(s, st.jobRoleId) }, reviewers, total, reviewerCount: new Set(rows.map((rv) => rv.reviewerUserId)).size, average: avg(scores), distribution,
    categories: Object.fromEntries(REVIEW_KEYS.map((k) => [k, avg(rows.map((rv) => rv.ratings[k]))])),
    history: rows.slice().sort((a, b) => (a.startsAt < b.startsAt ? 1 : -1)).map((rv) => ({ id: rv.id, reviewerUserId: rv.reviewerUserId, reviewerName: fullName(s.managers.find((m) => m.id === rv.reviewerUserId)), venueName: rv.venueName, roleName: rv.roleName, startsAt: rv.startsAt, endsAt: rv.endsAt, score: reviewScore(rv), feedback: rv.feedback, submittedAt: rv.submittedAt })),
  };
}

// ─── Generic list helpers ──────────────────────────────────────────────────────────────────
function listOf(rows, q, { search, sorters = {}, defaultSort, defaultDirection = 'asc' } = {}) {
  let out = rows.slice();
  const term = (q.get('q') || '').trim().toLowerCase();
  if (term && search) out = out.filter((r) => search(r).toLowerCase().includes(term));
  const key = q.get('sort') || defaultSort;
  const dir = q.get('direction') || defaultDirection;
  const getter = sorters[key];
  if (getter) out.sort((a, b) => { const x = getter(a); const y = getter(b); return (x < y ? -1 : x > y ? 1 : 0) * (dir === 'desc' ? -1 : 1); });
  const total = out.length;
  const limit = Number(q.get('limit') || 500);
  const page = Math.max(1, Number(q.get('page') || 1));
  return { data: out.slice((page - 1) * limit, page * limit), total };
}
const dayStart = (ymd) => new Date(`${ymd}T00:00:00`).getTime();
const dayEnd = (ymd) => dayStart(ymd) + 24 * HOUR;

function overlaps(s, staffId, startsAt, endsAt, exceptShiftId) {
  const a = new Date(startsAt).getTime(); const b = new Date(endsAt).getTime();
  return s.offers.some((o) => {
    if (o.staffProfileId !== staffId || o.status !== 'manager_confirmed' || o.shiftId === exceptShiftId) return false;
    const sh = s.shifts.find((x) => x.id === o.shiftId);
    if (!sh || ['cancelled', 'completed'].includes(sh.status)) return false;
    return new Date(sh.startsAt).getTime() < b && new Date(sh.endsAt).getTime() > a;
  });
}
function sendOffers(s, sh, staffIds, batchId) {
  return staffIds.map((staffProfileId) => {
    const st = s.staff.find((x) => x.id === staffProfileId);
    if (!st || st.accountStatus !== 'active' || st.employmentStatus !== 'active') return { staffProfileId, ok: false, message: 'This staff member is not active.' };
    if (s.offers.some((o) => o.shiftId === sh.id && o.staffProfileId === staffProfileId && ['pending', 'staff_accepted', 'manager_confirmed'].includes(o.status))) return { staffProfileId, ok: false, message: 'This staff member already has an offer for this shift.' };
    // Same message as rab-server assert-staff-eligible-for-offer.ts.
    if (overlaps(s, staffProfileId, sh.startsAt, sh.endsAt, sh.id)) return { staffProfileId, ok: false, message: 'This staff member already has a confirmed shift that overlaps this time.' };
    const sentAt = new Date().toISOString();
    s.offers.push({ id: uid('of'), shiftId: sh.id, staffProfileId, status: 'pending', offerBatchId: batchId, sentAt, expiresAt: plus(sentAt, 48 * HOUR), respondedAt: null, staffAcceptedAt: null, managerConfirmedAt: null, managerRejectedAt: null, rejectionReason: null, declineReason: null, withdrawnReason: null, cancelledAt: null, notificationReadAt: null });
    return { staffProfileId, ok: true };
  });
}
function confirmOffer(s, o) {
  if (!o || o.status !== 'staff_accepted') return false;
  o.status = 'manager_confirmed';
  o.managerConfirmedAt = new Date().toISOString();
  recomputeFilled(s);
  const sh = s.shifts.find((x) => x.id === o.shiftId);
  if (['offered', 'open', 'partially_filled'].includes(sh.status)) sh.status = sh.filledCount >= sh.requiredCount ? 'fully_filled' : 'partially_filled';
  s.audit.unshift({ id: uid('al'), action: 'offer.confirmed', actor: { fullName: fullName(s.me) }, metadata: { name: `${fullName(s.staff.find((x) => x.id === o.staffProfileId))} · ${venueName(s, sh.venueId)}` }, targetType: 'offer', targetId: o.id, createdAt: new Date().toISOString() });
  return true;
}

// ─── Multipart (avatar/logo uploads) ───────────────────────────────────────────────────────
function parseMultipartFile(request) {
  const ct = request.headers()['content-type'] || '';
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
  const buf = request.postDataBuffer();
  if (!m || !buf) return null;
  const boundary = Buffer.from('--' + (m[1] || m[2]));
  let start = buf.indexOf(boundary);
  while (start !== -1) {
    const next = buf.indexOf(boundary, start + boundary.length);
    if (next === -1) break;
    const part = buf.subarray(start + boundary.length + 2, next - 2);
    const headerEnd = part.indexOf('\r\n\r\n');
    const headers = part.subarray(0, headerEnd).toString('utf8');
    if (/filename=/i.test(headers)) {
      const type = (/content-type:\s*([^\r\n]+)/i.exec(headers) || [])[1] || 'application/octet-stream';
      return { contentType: type.trim(), body: part.subarray(headerEnd + 4) };
    }
    start = next;
  }
  return null;
}

// ─── Generated imagery (no photos of real people) ──────────────────────────────────────────
function logoSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8a6243"/><stop offset="1" stop-color="#5c3d27"/></linearGradient></defs><rect width="256" height="256" rx="56" fill="url(#g)"/><path d="M72 188V68h22l68 86V68h22v120h-22L94 102v86z" fill="#fff7ec"/><circle cx="196" cy="62" r="14" fill="#f2c48d"/></svg>`;
}
function avatarSvg(seed) {
  const palettes = [['#f3d9c4', '#b5835a', '#5c3d27'], ['#d7e6f5', '#5b86b5', '#2d4a6b'], ['#dcefd9', '#5e9a59', '#2f5a2c'], ['#f1e1f5', '#9a6bb0', '#55366a']];
  const [bg, body, head] = palettes[(seed.charCodeAt(0) || 0) % palettes.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" fill="${bg}"/><circle cx="128" cy="104" r="46" fill="${head}"/><path d="M40 256c6-58 42-92 88-92s82 34 88 92z" fill="${body}"/></svg>`;
}
function fileFor(s, key) {
  if (s.files[key]) return s.files[key];
  if (key.startsWith('logo-')) return { contentType: 'image/svg+xml', body: Buffer.from(logoSvg()) };
  if (key.startsWith('avatar-')) return { contentType: 'image/svg+xml', body: Buffer.from(avatarSvg(key.slice(7))) };
  return null;
}

// Renders the timesheet with rab-server's own template (final-timesheet.html.ts) so the
// document a reader sees has the real layout — only the rows are synthetic.
let templateFn = null;
function loadTimesheetTemplate() {
  if (templateFn) return templateFn;
  const ts = require(path.join(REPO_ROOT, 'node_modules', 'typescript'));
  const load = (file) => ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const escapeSrc = load(path.join(REPO_ROOT, 'packages/rab-server/src/engine/utils/escape-html.ts'));
  const escapeMod = { exports: {} };
  new Function('module', 'exports', 'require', escapeSrc)(escapeMod, escapeMod.exports, require);
  const tplSrc = load(path.join(REPO_ROOT, 'packages/rab-server/src/modules/attendance/templates/final-timesheet.html.ts'));
  const tplMod = { exports: {} };
  new Function('module', 'exports', 'require', tplSrc)(tplMod, tplMod.exports, (id) => (id.includes('escape-html') ? escapeMod.exports : require(id)));
  templateFn = tplMod.exports.renderFinalTimesheetHtml;
  return templateFn;
}
async function timesheetPdf(s, page, key) {
  const shiftId = key.replace(/^timesheet-(original|signed)-/, '');
  const unsigned = key.startsWith('timesheet-original-');
  const sh = s.shifts.find((x) => x.id === shiftId);
  const v = s.venues.find((x) => x.id === sh.venueId);
  const rows = s.attendance.filter((a) => a.shiftId === sh.id).map((a) => {
    const st = s.staff.find((x) => x.id === a.staffProfileId);
    const view = attendanceView(s, a);
    return { name: fullName(st), roleName: roleName(s, sh.jobRoleId), scheduledStart: sh.startsAt, scheduledEnd: sh.endsAt, clockInAt: a.clockInAt, clockOutAt: a.clockOutAt, breakMinutes: a.breakMinutes, workedMinutes: view.workedMinutes, status: a.status, corrected: false };
  });
  const html = loadTimesheetTemplate()({ venueName: v.name, venueAddress: `${v.address.line1}, ${v.address.city} ${v.address.postcode}`, roleName: roleName(s, sh.jobRoleId), startsAt: sh.startsAt, endsAt: sh.endsAt, staff: rows, unsigned, finalisedByName: 'Riley Chen', finalisedAt: plus(sh.endsAt, 40 * MIN) });
  const ctx = await page.context().browser().newContext();
  try {
    const p = await ctx.newPage();
    await p.setContent(html, { waitUntil: 'load' });
    return await p.pdf({ format: 'A4', printBackground: true });
  } finally {
    await ctx.close();
  }
}

// ─── Router ────────────────────────────────────────────────────────────────────────────────
function handler(s, page, opts) {
  const unhandled = [];
  const json = (status, body) => ({ status, body });
  const notFound = () => json(404, { statusCode: 404, message: 'Not found' });

  async function route(method, p, q, req) {
    const body = () => { try { return req.postDataJSON() || {}; } catch { return {}; } };
    const me = s.me;
    let m;

    // Auth (public)
    if (p === '/auth/config') return json(200, { authProviders: { password: true, google: true, microsoft: true }, domain: { scheme: 'https', workspaceBaseDomain: 'crewflow.example' } });
    if (p === '/auth/me' || p === '/auth/capabilities') {
      if (!me) return json(401, { statusCode: 401, message: 'Missing credentials' });
      // Current contract: a flag -> boolean map of the display-hint permissions (auth.controller.ts `capabilities`).
      // Manager and CEO hold every one of these in their production role sets (ROLE_DEFS).
      if (p === '/auth/capabilities') return json(200, Object.fromEntries(CAPABILITY_FLAGS.map((f) => [f, me.roles.includes('manager') || me.roles.includes('ceo')])));
      return json(200, { id: me.id, email: me.email, firstName: s.profile.firstName, lastName: s.profile.lastName, organisationId: ORG_ID, roles: me.roles, mustResetPassword: false, isPlatformAdmin: me.isPlatformAdmin, sessionId: 'sess-current', applicationTarget: 'manager_web', sessionExpiresAt: plus(new Date().toISOString(), 12 * HOUR) });
    }
    if (p === '/auth/refresh') return json(401, { statusCode: 401, message: 'Invalid refresh token.' });
    if (p === '/auth/login') return json(401, { statusCode: 401, message: 'Invalid email or password.' });
    if (p === '/auth/logout') return json(200, {});
    if (p === '/auth/forgot-password') return json(200, {});
    // Member invitation landing page (fictional workspace and address).
    if (p === '/invitations/resolve' && method === 'POST') return json(200, { email: 'rowan.ellis@example.test', roleLabel: 'Shift coordinator', workspaceName: 'Northwind Staffing' });
    if (['/auth/reset-password', '/auth/activate-account', '/auth/set-password'].includes(p)) return json(200, { applicationTarget: 'manager_web', managerLoginUrl: `${APP_ORIGIN}/login` });
    if (!me) return json(401, { statusCode: 401, message: 'Missing credentials' });

    // Files
    if ((m = p.match(/^\/files\/previews$/))) return json(200, { previews: {} });
    if ((m = p.match(/^\/files\/(.+)$/))) {
      const key = decodeURIComponent(m[1]);
      if (key.startsWith('timesheet-')) return { status: 200, raw: await timesheetPdf(s, page, key), contentType: 'application/pdf' };
      const f = fileFor(s, key);
      return f ? { status: 200, raw: f.body, contentType: f.contentType } : notFound();
    }

    // Profile & preferences
    if (p === '/profile') {
      if (method === 'PATCH') { const b = body(); for (const k of ['firstName', 'lastName', 'jobTitle']) if (b[k] !== undefined) s.profile[k] = b[k]; }
      return json(200, s.profile);
    }
    if (p === '/profile/avatar') {
      if (method === 'DELETE') { s.profile.avatarKey = null; return json(200, s.profile); }
      const f = parseMultipartFile(req); const key = uid('avatar-upload'); if (f) s.files[key] = f; s.profile.avatarKey = key; return json(201, s.profile);
    }
    if (p === '/profile/preferences') { if (method === 'PATCH') Object.assign(s.preferences, body()); return json(200, s.preferences); }
    if (p === '/profile/notification-preferences') {
      if (method === 'PATCH') { const b = body(); const row = s.notificationPrefs.find((x) => x.notificationType === b.notificationType); if (row) Object.assign(row, b); return json(200, row); }
      return json(200, s.notificationPrefs);
    }
    if (p === '/profile/sessions') { if (method === 'DELETE') { const n = s.sessions.length - 1; s.sessions = s.sessions.filter((x) => x.isCurrentDevice); return json(200, { revokedCount: n }); } return json(200, s.sessions); }
    if ((m = p.match(/^\/profile\/sessions\/([^/]+)$/))) { s.sessions = s.sessions.filter((x) => x.familyId !== m[1]); return json(200, {}); }

    // Manager workspace (onboarding)
    if (p === '/manager-workspaces/me') {
      if (method === 'PATCH') { Object.assign(s.workspace, { name: body().name ?? s.workspace.name }); return json(200, s.workspace); }
      if (!s.workspace) return json(404, { statusCode: 404, message: 'No workspace.' });
      if (s.workspace.schemaStatus === 'CREATING' && q.get('fresh')) { s.pollCount += 1; if (s.pollCount >= (opts.readyAfterPolls ?? 2)) s.workspace.schemaStatus = 'READY'; }
      return json(200, s.workspace);
    }
    if (p === '/manager-workspaces/subdomain/check') {
      const candidate = String(body().candidate || '');
      const taken = ['acme', 'crewflow', 'admin', 'www'].includes(candidate);
      return json(200, { available: !taken, normalized: candidate, reserved: ['admin', 'www'].includes(candidate), ...(taken ? { suggested: `${candidate}-staffing`, alternatives: [`${candidate}-team`, `${candidate}-hq`] } : {}) });
    }
    if (p === '/manager-workspaces' && method === 'POST') {
      const b = body();
      s.workspace = { id: 'ws-northwind', name: b.name, subdomain: b.subdomain, logoKey: null, status: 'active', schemaStatus: 'CREATING', onboardingCompletedAt: null, createdAt: new Date().toISOString() };
      s.pollCount = 0;
      return json(201, s.workspace);
    }
    if (p === '/manager-workspaces/me/logo') {
      if (method === 'DELETE') { s.workspace.logoKey = null; return json(200, s.workspace); }
      const f = parseMultipartFile(req); const key = uid('logo-upload'); if (f) s.files[key] = f; s.workspace.logoKey = key; return json(201, s.workspace);
    }
    if (p === '/manager-workspaces/me/complete-onboarding') { s.workspace.onboardingCompletedAt = new Date().toISOString(); return json(200, s.workspace); }
    if (p === '/manager-workspaces/me/subdomain') { s.workspace.subdomain = body().subdomain; return json(200, s.workspace); }

    // Dashboard
    if (p === '/dashboard/summary') {
      s.summaryCalls = (s.summaryCalls || 0) + 1; // evidence that a background refresh really happened
      // Manager persona: venueManagerCount = the Venue managers list of their workspace (the same population as
      // Users -> Venue managers); CEO / platform admin: the organisation's Managers, venueManagerCount null.
      const isManager = (s.me?.roles || []).includes('manager');
      const venueManagers = s.managers.filter((x) => x.type === 'venue');
      // venueCount: every venue in the workspace, as the server counts it (no status filter).
      // `summaryOverride` reproduces what the server sends a caller who lacks a permission (null = "not available to you").
      return json(200, { ...{ staffCount: s.staff.length, activeStaffCount: s.staff.filter((x) => x.employmentStatus === 'active').length, managerCount: isManager ? null : s.managers.length, venueManagerCount: isManager ? venueManagers.length : null, venueCount: s.venues.length, activeOfferCount: s.offers.filter((o) => ['pending', 'staff_accepted'].includes(o.status)).length }, ...(s.summaryOverride || {}) });
    }

    // Venue managers of the caller's workspace (a Manager's Users -> Venue managers tab)
    if (p === '/venue-managers' && method === 'GET') {
      const rows = s.managers.filter((x) => x.type === 'venue').map((x) => ({ id: x.id, email: x.email, firstName: x.firstName, lastName: x.lastName, accountStatus: x.accountStatus, invitationStatus: x.invitationStatus, pendingInvite: x.pendingInvite, createdAt: x.createdAt, venues: (x.venueIds || []).map((id) => ({ id, name: venueName(s, id) })) }));
      return json(200, listOf(rows, q, { search: (r) => `${r.firstName} ${r.lastName} ${r.email}`, sorters: { createdAt: (r) => r.createdAt }, defaultSort: 'createdAt', defaultDirection: 'desc' }));
    }

    // Job roles
    if (p === '/job-roles') {
      if (method === 'POST') { const b = body(); const r = { id: uid('r'), name: b.name, defaultRatePence: b.defaultRatePence ?? 1300 }; s.jobRoles.push(r); return json(201, r); }
      return json(200, s.jobRoles);
    }

    // Staff & managers
    for (const [base, coll] of [['staff', 'staff'], ['managers', 'managers'], ['venue-managers', 'managers']]) {
      const rows = s[coll];
      if (p === `/${base}`) {
        if (method === 'POST') {
          const b = body();
          if (rows.some((r) => r.email.toLowerCase() === String(b.email).toLowerCase()) || s.staff.concat(s.managers).some((r) => r.email.toLowerCase() === String(b.email).toLowerCase())) return json(409, { statusCode: 409, message: 'A user with this email already exists.' });
          const rec = {
            id: uid(base === 'staff' ? 'st' : 'mg'), email: b.email, firstName: b.firstName, lastName: b.lastName, phone: b.phone ?? null,
            accountStatus: 'invited', invitationStatus: 'queued', inviteSettlesAt: Date.now() + 3500, pendingInvite: { sendNumber: 1, maxSendAttempts: 3, expiresAt: plus(new Date().toISOString(), 24 * HOUR) },
            mustResetPassword: false, avatarKey: null, createdAt: new Date().toISOString(),
          };
          if (base === 'staff') {
            s.staffSeq += 1;
            Object.assign(rec, { staffRef: `STAFF ${s.staffSeq}`, employmentStatus: 'pending_compliance', defaultPayRatePence: b.defaultPayRatePence ?? null, jobRoleId: b.jobRoleId ?? null, employmentType: b.employmentType ?? null, startDate: b.startDate ?? null, dateOfBirth: b.dateOfBirth ?? null, preferredName: b.preferredName ?? null, address: b.address ?? null, city: b.city ?? null, postcode: b.postcode ?? null, emergencyContactName: b.emergencyContactName ?? null, emergencyContactRelationship: b.emergencyContactRelationship ?? null, emergencyContactPhone: b.emergencyContactPhone ?? null, availableDays: b.availableDays ?? [], preferredShiftTimes: b.preferredShiftTimes ?? null, maxHoursPerWeek: b.maxHoursPerWeek ?? null });
          } else {
            Object.assign(rec, { type: base === 'venue-managers' ? 'venue' : b.type || 'internal', jobTitle: b.jobTitle ?? null, venueIds: [] });
            if (base === 'venue-managers') s.vmTeams[rec.id] = [];
          }
          rows.unshift(rec);
          s.timelines[rec.id] = [{ id: uid('tl'), action: 'user.invite_queued', actor: { fullName: fullName(s.profile) }, createdAt: new Date().toISOString() }, { id: uid('tl'), action: 'user.created', actor: { fullName: fullName(s.profile) }, createdAt: new Date().toISOString() }];
          s.audit.unshift({ id: uid('al'), action: 'user.created', actor: { fullName: fullName(s.profile) }, metadata: { name: `${b.firstName} ${b.lastName}` }, targetType: 'user', targetId: rec.id, createdAt: new Date().toISOString() });
          return json(201, { ...rec, invite: { sendNumber: 1, queued: true } });
        }
        const filtered = rows.filter((r) => {
          if (base === 'staff') {
            if (q.get('status') && r.employmentStatus !== q.get('status')) return false;
            if (q.get('employmentType') && r.employmentType !== q.get('employmentType')) return false;
            if (q.get('jobRoleId') && r.jobRoleId !== q.get('jobRoleId')) return false;
          } else {
            if (q.get('status') && r.accountStatus !== q.get('status')) return false;
            if (q.get('type') && r.type !== q.get('type')) return false;
          }
          return true;
        }).map((r) => (base === 'staff' ? staffView(s, r) : staffView(s, r)));
        return json(200, listOf(filtered, q, { search: (r) => `${r.firstName} ${r.lastName} ${r.email} ${r.staffRef || ''}`, sorters: { name: (r) => `${r.firstName} ${r.lastName}`, staffRef: (r) => Number(String(r.staffRef || '').replace(/\D/g, '')), email: (r) => r.email, defaultPayRatePence: (r) => r.defaultPayRatePence ?? 0, createdAt: (r) => r.createdAt, jobTitle: (r) => r.jobTitle || '' }, defaultSort: 'createdAt', defaultDirection: 'desc' }));
      }
      if (p === `/${base}/bulk-email`) { const ids = body().userIds || []; return json(200, { queued: ids.length, skipped: 0 }); }
      if ((m = p.match(new RegExp(`^/${base}/([^/]+)(?:/(.+))?$`)))) {
        const rec = rows.find((r) => r.id === m[1]);
        if (!rec) return notFound();
        const sub = m[2];
        if (!sub) {
          if (method === 'PATCH') { Object.assign(rec, body()); return json(200, staffView(s, rec)); }
          if (method === 'DELETE') return json(409, { statusCode: 409, code: 'USER_HAS_PROTECTED_HISTORY', message: 'Protected history.' });
          const view = staffView(s, rec);
          if (coll === 'managers') view.venues = (rec.venueIds || []).map((id) => ({ id, name: venueName(s, id) }));
          return json(200, view);
        }
        // Assigned staff (owner-managed team of a venue manager)
        if (base === 'venue-managers' && sub === 'staff') {
          const team = (s.vmTeams[rec.id] ||= []);
          if (method === 'POST') {
            const ids = body().staffProfileIds || [];
            const added = ids.filter((id) => !team.some(([x]) => x === id));
            added.forEach((id) => team.push([id, 0]));
            return json(201, { added, alreadyAssigned: ids.filter((id) => !added.includes(id)) });
          }
          return json(200, team.map(([id, daysAgo]) => { const st = s.staff.find((x) => x.id === id); return { id, firstName: st.firstName, lastName: st.lastName, email: st.email, accountStatus: st.accountStatus, employmentStatus: st.employmentStatus, jobRoleName: roleName(s, st.jobRoleId), assignedAt: ago(daysAgo * 24 * HOUR + HOUR) }; }));
        }
        if (base === 'venue-managers' && method === 'DELETE' && (m = sub.match(/^staff\/([^/]+)$/))) {
          s.vmTeams[rec.id] = (s.vmTeams[rec.id] || []).filter(([x]) => x !== m[1]);
          return json(204, {});
        }
        // Staff reviews (Users -> staff -> Staff reviews)
        if (base === 'staff' && sub === 'reviews') return json(200, staffReviewsView(s, rec, q));
        if (base === 'staff' && (m = sub.match(/^reviews\/([^/]+)$/))) {
          const rv = s.reviews.find((x) => x.id === m[1] && x.staffProfileId === rec.id);
          if (!rv) return notFound();
          const reviewer = s.managers.find((x) => x.id === rv.reviewerUserId);
          return json(200, { staff: { name: fullName(rec) }, venueName: rv.venueName, roleName: rv.roleName, startsAt: rv.startsAt, endsAt: rv.endsAt, reviewer: { userId: reviewer.id, name: fullName(reviewer), role: 'Venue manager' }, submittedAt: rv.submittedAt, score: reviewScore(rv), ratings: rv.ratings, feedback: rv.feedback });
        }
        if (sub === 'email') { rec.email = body().email; return json(200, rec); }
        if (sub === 'avatar') { if (method === 'DELETE') { rec.avatarKey = null; return json(200, rec); } const f = parseMultipartFile(req); const key = uid('avatar-upload'); if (f) s.files[key] = f; rec.avatarKey = key; return json(201, rec); }
        if (sub === 'timeline') {
          const items = s.timelines[rec.id] || [
            { id: uid('tl'), action: 'offer.accepted', actor: { fullName: fullName(rec) }, createdAt: ago(42 * MIN) },
            { id: uid('tl'), action: 'offer.sent', actor: { fullName: 'Jordan Hale' }, createdAt: ago(20 * HOUR) },
            { id: uid('tl'), action: 'attendance.clocked_out', actor: { fullName: fullName(rec) }, createdAt: at(-1, 23, 4) },
            { id: uid('tl'), action: 'attendance.clocked_in', actor: { fullName: fullName(rec) }, createdAt: at(-1, 15, 54) },
            { id: uid('tl'), action: 'offer.confirmed', actor: { fullName: 'Jordan Hale' }, createdAt: at(-4, 13) },
            { id: uid('tl'), action: 'profile.updated', actor: { fullName: fullName(rec) }, createdAt: at(-20, 18) },
            { id: uid('tl'), action: 'user.activated', actor: { fullName: fullName(rec) }, createdAt: plus(rec.createdAt, 26 * HOUR) },
            { id: uid('tl'), action: 'user.invited', actor: { fullName: 'Jordan Hale' }, createdAt: plus(rec.createdAt, 2 * MIN) },
            { id: uid('tl'), action: 'user.created', actor: { fullName: 'Jordan Hale' }, createdAt: rec.createdAt },
          ];
          return json(200, items);
        }
        if (sub === 'emails') return json(200, s.emails[rec.id] || []);
        if (sub === 'notes') {
          if (method === 'POST') { const n = { id: uid('note'), authorName: fullName(s.profile), body: body().body, createdAt: new Date().toISOString() }; (s.notes[rec.id] ||= []).unshift(n); return json(201, n); }
          return json(200, s.notes[rec.id] || []);
        }
        if (sub === 'venues') { rec.venueIds = [...(rec.venueIds || []), body().venueId]; return json(201, {}); }
        if (sub === 'deactivate') { if (base === 'staff') rec.employmentStatus = 'inactive'; else rec.accountStatus = 'suspended'; return json(200, rec); }
        if (sub === 'reactivate') { if (base === 'staff') rec.employmentStatus = 'active'; else rec.accountStatus = 'active'; return json(200, rec); }
        if (sub === 'reset-password') return json(200, {});
        if (sub === 'resend-invite') { rec.pendingInvite = { ...(rec.pendingInvite || {}), sendNumber: (rec.pendingInvite?.sendNumber || 1) + 1 }; return json(200, rec); }
        if (sub === 'cancel-invite') { rec.invitationStatus = 'cancelled'; return json(200, rec); }
      }
    }

    // Venues
    if (p === '/venues') {
      if (method === 'POST') {
        const b = body();
        const v = { id: uid('v'), name: b.name, clientName: b.clientName ?? null, type: b.type, address: b.address || {}, instructions: b.instructions ?? null, breakPaid: !!b.breakPaid, defaultBreakMinutes: b.defaultBreakMinutes ?? null, lat: b.lat ?? null, lng: b.lng ?? null, geofenceRadiusM: b.geofenceRadiusM ?? 200, enforceGeofence: !!b.enforceGeofence, status: 'active', createdAt: new Date().toISOString() };
        s.venues.unshift(v); s.roleRates[v.id] = [];
        return json(201, v);
      }
      const rows = s.venues.filter((v) => (!q.get('status') || v.status === q.get('status')) && (!q.get('type') || v.type === q.get('type')));
      return json(200, listOf(rows, q, { search: (v) => `${v.name} ${v.clientName || ''} ${v.address?.city || ''}`, sorters: { name: (v) => v.name, createdAt: (v) => v.createdAt }, defaultSort: 'name' }));
    }
    if ((m = p.match(/^\/venues\/([^/]+)(?:\/(role-rates|archive)(?:\/([^/]+))?)?$/))) {
      const v = s.venues.find((x) => x.id === m[1]);
      if (!v) return notFound();
      if (!m[2]) { if (method === 'PATCH') { const b = body(); Object.assign(v, b); return json(200, v); } return json(200, v); }
      if (m[2] === 'archive') { v.status = 'archived'; return json(200, v); }
      const rates = (s.roleRates[v.id] ||= []);
      if (method === 'POST') { const b = body(); const r = { id: uid('rr'), jobRoleId: b.jobRoleId, payRatePence: b.payRatePence }; rates.push(r); return json(201, r); }
      if (method === 'DELETE') { s.roleRates[v.id] = rates.filter((r) => r.id !== m[3]); return json(200, {}); }
      return json(200, rates);
    }

    // Shifts
    if (p === '/shifts/requests') {
      const st = q.get('status');
      const rows = s.shifts.filter((sh) => sh.requestedBy).filter((sh) => !st || (st === 'pending' ? sh.status === 'pending_manager_approval' : st === 'declined' ? sh.status === 'declined' : !['pending_manager_approval', 'declined'].includes(sh.status)))
        .sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1)).map((sh) => venueRequestView(s, sh));
      return json(200, listOf(rows, q, { search: (r) => `${r.venueName} ${r.roleName} ${r.venueManagerName}` }));
    }
    if (p === '/shifts/with-offers' && method === 'POST') {
      const b = body();
      const v = s.venues.find((x) => x.id === b.venueId);
      const role = s.jobRoles.find((r) => r.id === b.jobRoleId);
      const rate = b.payRatePence ?? (s.roleRates[v.id] || []).find((r) => r.jobRoleId === role.id)?.payRatePence ?? role.defaultRatePence;
      const sh = { id: uid('sh'), venueId: v.id, jobRoleId: role.id, startsAt: b.startsAt, endsAt: b.endsAt, breakMinutes: b.breakMinutes ?? 0, requiredCount: (b.staffProfileIds || []).length, filledCount: 0, payRatePence: rate, status: 'offered', notes: b.notes ?? null, title: null, address: b.address ?? null, createdAt: new Date().toISOString(), requestedBy: null, submittedAt: null, declinedReason: null };
      s.shifts.push(sh);
      const batchId = uid('b');
      const results = sendOffers(s, sh, b.staffProfileIds || [], batchId);
      return json(201, { batchId, shiftId: sh.id, results });
    }
    if (p === '/shifts') {
      let rows = s.shifts.slice();
      const from = q.get('from'); const to = q.get('to');
      if (from) rows = rows.filter((sh) => new Date(sh.startsAt) >= new Date(from));
      if (to) rows = rows.filter((sh) => new Date(sh.startsAt) <= new Date(to));
      if (q.get('status')) rows = rows.filter((sh) => sh.status === q.get('status'));
      if (q.get('venueId')) rows = rows.filter((sh) => sh.venueId === q.get('venueId'));
      if (q.get('jobRoleId')) rows = rows.filter((sh) => sh.jobRoleId === q.get('jobRoleId'));
      if (q.get('startsAtFrom')) rows = rows.filter((sh) => new Date(sh.startsAt).getTime() >= dayStart(q.get('startsAtFrom')));
      if (q.get('startsAtTo')) rows = rows.filter((sh) => new Date(sh.startsAt).getTime() < dayEnd(q.get('startsAtTo')));
      return json(200, listOf(rows.map(shiftView), q, { search: (sh) => `${venueName(s, sh.venueId)} ${roleName(s, sh.jobRoleId)}`, sorters: { startsAt: (sh) => sh.startsAt, venue: (sh) => venueName(s, sh.venueId), jobRole: (sh) => roleName(s, sh.jobRoleId), status: (sh) => sh.status, createdAt: (sh) => sh.createdAt }, defaultSort: 'startsAt' }));
    }
    if ((m = p.match(/^\/shifts\/([^/]+)(?:\/(.+))?$/))) {
      const sh = s.shifts.find((x) => x.id === m[1]);
      if (!sh) return notFound();
      const sub = m[2];
      if (!sub) return json(200, shiftView(sh));
      if (sub === 'pipeline') return json(200, pipelineView(s, sh.id));
      if (sub === 'publish') { sh.status = 'open'; return json(200, shiftView(sh)); }
      if (sub === 'cancel') { sh.status = 'cancelled'; sh.cancellationReason = body().reason ?? null; return json(200, shiftView(sh)); }
      if (sub === 'offers/bulk') { const batchId = uid('b'); const results = sendOffers(s, sh, body().staffProfileIds || [], batchId); if (sh.status === 'open') sh.status = 'offered'; return json(201, { batchId, results }); }
      if (sub === 'requested-staff') {
        if (method === 'PUT') { s.requestedStaff[sh.id] = body().staffProfileIds || []; }
        return json(200, (s.requestedStaff[sh.id] || []).map((id) => { const st = s.staff.find((x) => x.id === id); return { staffProfileId: id, firstName: st.firstName, lastName: st.lastName, email: st.email, stillActive: true, available: true, breakMinutes: null }; }));
      }
      if ((m = sub.match(/^requested-staff\/(.+)$/))) { s.requestedStaff[sh.id] = (s.requestedStaff[sh.id] || []).filter((id) => id !== m[1]); return json(200, {}); }
      if (sub === 'selectable-staff') {
        const rows = s.staff.filter((x) => x.accountStatus === 'active' && x.employmentStatus === 'active').map((x) => ({ id: x.id, firstName: x.firstName, lastName: x.lastName, staffRef: x.staffRef, email: x.email, phone: x.phone, defaultPayRatePence: x.defaultPayRatePence, accountStatus: x.accountStatus, employmentStatus: x.employmentStatus, createdAt: x.createdAt, available: !overlaps(s, x.id, sh.startsAt, sh.endsAt, sh.id) }));
        return json(200, listOf(rows, q, { search: (r) => `${r.firstName} ${r.lastName} ${r.email}`, sorters: { name: (r) => `${r.firstName} ${r.lastName}` }, defaultSort: 'name' }));
      }
      if (sub === 'approve') {
        sh.status = 'offered';
        sendOffers(s, sh, s.requestedStaff[sh.id] || [], uid('b'));
        delete s.requestedStaff[sh.id];
        return json(200, shiftView(sh));
      }
      if (sub === 'decline') { sh.status = 'declined'; sh.declinedReason = body().reason ?? null; return json(200, shiftView(sh)); }
      if ((m = sub.match(/^pipeline\/offers\/([^/]+)\/cancel$/))) { const o = s.offers.find((x) => x.id === m[1]); if (o) { o.status = 'withdrawn'; o.cancelledAt = new Date().toISOString(); o.withdrawnReason = body().reason ?? null; } recomputeFilled(s); return json(200, {}); }
      if (sub === 'pipeline/replacements') { sendOffers(s, sh, body().staffProfileIds || [], uid('b')); return json(201, {}); }
    }

    // Offers
    if (p === '/offers') {
      let rows = s.offers.slice();
      if (q.get('status')) rows = rows.filter((o) => o.status === q.get('status'));
      const views = rows.map((o) => offerView(s, o)).filter((o) => {
        const sf = q.get('shiftDateFrom'); const stTo = q.get('shiftDateTo');
        if (sf && new Date(o.startsAt).getTime() < (sf.length === 10 ? dayStart(sf) : new Date(sf).getTime())) return false;
        if (stTo && new Date(o.startsAt).getTime() >= (stTo.length === 10 ? dayEnd(stTo) : new Date(stTo).getTime() + 24 * HOUR)) return false;
        return true;
      });
      return json(200, listOf(views, q, { search: (o) => `${o.staffName} ${o.venueName} ${o.roleName}`, sorters: { sentAt: (o) => o.sentAt, shiftDate: (o) => o.startsAt, staff: (o) => o.staffName, venue: (o) => o.venueName, status: (o) => o.status }, defaultSort: 'sentAt', defaultDirection: 'desc' }));
    }
    if ((m = p.match(/^\/offers\/batches\/([^/]+)(\/confirm-all)?$/))) {
      const batch = s.offers.filter((o) => o.offerBatchId === m[1]);
      if (!batch.length) return notFound();
      if (m[2]) { const results = batch.filter((o) => o.status === 'staff_accepted').map((o) => ({ offerId: o.id, ok: confirmOffer(s, o) })); return json(200, { results }); }
      const sh = s.shifts.find((x) => x.id === batch[0].shiftId);
      const counts = {};
      for (const o of batch) counts[o.status] = (counts[o.status] || 0) + 1;
      return json(200, { batchId: m[1], shift: { id: sh.id, startsAt: sh.startsAt, endsAt: sh.endsAt, venueName: venueName(s, sh.venueId), roleName: roleName(s, sh.jobRoleId) }, counts, recipients: batch.map((o) => ({ id: o.id, status: o.status, staffName: fullName(s.staff.find((x) => x.id === o.staffProfileId)), staffProfileId: o.staffProfileId, rejectionReason: o.rejectionReason, declineReason: o.declineReason })) });
    }
    if ((m = p.match(/^\/offers\/([^/]+)\/(confirm|reject|withdraw)$/))) {
      const o = s.offers.find((x) => x.id === m[1]);
      if (!o) return notFound();
      if (m[2] === 'confirm') { if (!confirmOffer(s, o)) return json(409, { statusCode: 409, message: 'This offer is no longer awaiting confirmation.' }); }
      if (m[2] === 'reject') { o.status = 'manager_rejected'; o.managerRejectedAt = new Date().toISOString(); o.rejectionReason = body().reason ?? null; }
      if (m[2] === 'withdraw') { o.status = 'withdrawn'; }
      recomputeFilled(s);
      return json(200, offerView(s, o));
    }

    // Attendance (Payroll)
    if (p === '/attendance') {
      let rows = s.attendance.map((a) => attendanceView(s, a));
      if (q.get('venueId')) rows = rows.filter((r) => r.venueId === q.get('venueId'));
      if (q.get('status')) rows = rows.filter((r) => r.status === q.get('status'));
      if (q.get('clockInFrom')) rows = rows.filter((r) => new Date(r.clockInAt) >= new Date(q.get('clockInFrom')));
      if (q.get('clockInTo')) rows = rows.filter((r) => new Date(r.clockInAt) <= new Date(q.get('clockInTo')));
      return json(200, listOf(rows, q, { search: (r) => `${r.staffName} ${r.venueName}`, sorters: { clockInAt: (r) => r.clockInAt, staff: (r) => r.staffName, venue: (r) => r.venueName, workedMinutes: (r) => r.workedMinutes ?? -1, earnedPence: (r) => r.earnedPence ?? -1 }, defaultSort: 'clockInAt', defaultDirection: 'desc' }));
    }

    // Notifications
    if (p === '/notifications') return json(200, s.notifications);
    if (p === '/notifications/unread-count') return json(200, { count: s.notifications.filter((n) => !n.readAt).length });
    if (p === '/notifications/read-all') { s.notifications.forEach((n) => { n.readAt ||= new Date().toISOString(); }); return json(200, {}); }
    if ((m = p.match(/^\/notifications\/([^/]+)\/read$/))) { const n = s.notifications.find((x) => x.id === m[1]); if (n) n.readAt = new Date().toISOString(); return json(200, {}); }

    // Audit
    if (p === '/audit-logs') {
      if (q.get('entityType') === 'offer' && q.get('entityId')) {
        const o = s.offers.find((x) => x.id === q.get('entityId'));
        const name = o ? fullName(s.staff.find((x) => x.id === o.staffProfileId)) : 'Staff';
        const items = o ? [o.staffAcceptedAt && { id: uid('a'), action: 'offer.accepted', actor: { fullName: name }, createdAt: o.staffAcceptedAt }, { id: uid('a'), action: 'offer.sent', actor: { fullName: 'Jordan Hale' }, createdAt: o.sentAt }].filter(Boolean) : [];
        return json(200, { items, page: 1, limit: 50, total: items.length });
      }
      let items = s.audit.slice();
      if (q.get('action')) items = items.filter((x) => x.action === q.get('action'));
      return json(200, { items, page: Number(q.get('page') || 1), limit: Number(q.get('limit') || 50), total: items.length });
    }

    // Search
    if (p === '/search') {
      const term = (q.get('q') || '').toLowerCase();
      const hit = (t) => t.toLowerCase().includes(term);
      const out = [];
      s.staff.filter((x) => hit(fullName(x))).slice(0, 5).forEach((x) => out.push({ id: x.id, name: fullName(x), type: 'Staff', group: 'People', to: '/users' }));
      s.managers.filter((x) => hit(fullName(x))).slice(0, 5).forEach((x) => out.push({ id: x.id, name: fullName(x), type: 'Manager', group: 'People', to: '/users' }));
      s.venues.filter((v) => hit(v.name)).slice(0, 5).forEach((v) => out.push({ id: v.id, name: v.name, type: 'Venue', group: 'Venues', to: '/venues' }));
      s.shifts.filter((sh) => hit(venueName(s, sh.venueId)) && new Date(sh.startsAt) > Date.now() - 24 * HOUR).slice(0, 4).forEach((sh) => out.push({ id: sh.id, name: `${venueName(s, sh.venueId)} · ${new Date(sh.startsAt).toLocaleDateString('en-GB')}`, type: 'Shift', group: 'Shifts', to: '/shifts' }));
      s.offers.filter((o) => { const st = s.staff.find((x) => x.id === o.staffProfileId); return hit(fullName(st)) && o.status !== 'withdrawn'; }).slice(0, 4).forEach((o) => { const st = s.staff.find((x) => x.id === o.staffProfileId); const sh = s.shifts.find((x) => x.id === o.shiftId); out.push({ id: o.id, name: `${fullName(st)} → ${venueName(s, sh.venueId)}`, type: 'Offer', group: 'Offers', to: '/offers' }); });
      return json(200, out);
    }

    // Roles
    // Members (Settings -> Workspace -> Members): email-first invitations to CUSTOM workspace roles only.
    if (p === '/leadership/capabilities') return json(200, { leadership: { canCreateOrganisation: false, initialManagerScope: (me.roles || []).includes('ceo') ? 'own' : 'none' } });
    if (p === '/members' && method === 'GET') {
      const rows = s.members.map((m) => ({ ...m, isSelf: m.userId === me.id }));
      const term = (q.get('search') || '').toLowerCase();
      const out = term ? rows.filter((m) => `${m.firstName} ${m.lastName} ${m.email}`.toLowerCase().includes(term)) : rows;
      return json(200, { data: out, total: out.length });
    }
    if (p === '/member-invitations/assignable-roles') return json(200, s.roles.filter((r) => !r.isSystem).map((r) => ({ id: r.id, name: r.name, permissionKeys: ['schedule.view', 'offer.send'] })));
    if (p === '/member-invitations' && method === 'GET') {
      const st = q.get('status');
      const rows = st ? s.memberInvitations.filter((i) => i.status === st) : s.memberInvitations;
      return json(200, { data: rows, total: rows.length, page: Number(q.get('page') || 1), limit: Number(q.get('limit') || 10) });
    }
    if (p === '/member-invitations' && method === 'POST') {
      const b = body(); const role = s.roles.find((r) => r.id === b.roleId);
      const results = (b.emails || []).map((email) => {
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { email, outcome: 'invalid_email' };
        s.memberInvitations.unshift({ id: uid('mi'), email, role: { id: role.id, name: role.name }, status: 'sent', sendCount: 1, maxSends: 3, expiresAt: plus(new Date().toISOString(), 24 * HOUR), lastSentAt: new Date().toISOString(), createdAt: new Date().toISOString(), invitedByName: fullName(s.profile) });
        return { email, outcome: 'invited' };
      });
      return json(201, { results });
    }
    if ((m = p.match(/^\/member-invitations\/([^/]+)\/(resend|revoke)$/))) {
      const inv = s.memberInvitations.find((i) => i.id === m[1]); if (!inv) return notFound();
      if (m[2] === 'revoke') inv.status = 'revoked'; else { inv.sendCount += 1; inv.lastSentAt = new Date().toISOString(); }
      return json(200, inv);
    }
    if (p === '/roles') return json(200, s.roles);
    if (p === '/roles/permissions') return json(200, []);
    if ((m = p.match(/^\/roles\/([^/]+)$/))) return json(200, { ...s.roles.find((r) => r.id === m[1]), permissionKeys: [] });

    // Platform admin
    if (p === '/admin/organisations') return json(200, s.organisations);
    if ((m = p.match(/^\/admin\/organisations\/([^/]+)$/))) return json(200, { ...s.organisations.find((o) => o.id === m[1]) });
    if (p === '/admin/general') return json(200, { version: '1.0.0', latestVersion: '1.0.0' });
    if (p === '/admin/recent-users') return json(200, s.staff.slice(0, 5).map((x) => ({ id: x.id, firstName: x.firstName, lastName: x.lastName, email: x.email })));
    if (p === '/admin/health') return json(200, [{ name: 'Database', status: 'operational' }, { name: 'Queue', status: 'operational' }]);
    if (p === '/admin/config') return json(200, { smtp: { host: 'smtp.example.test', port: 587, secure: false, username: 'mailer', fromAddress: 'no-reply@example.test', fromName: 'Crewflow', passwordSet: true }, storage: { driver: 'local' }, maintenance: { enabled: false, message: null } });
    if (p === '/workspace/security') return json(200, { password: { organisationEnabled: true, systemEnabled: true }, google: { organisationEnabled: false, systemEnabled: false }, microsoft: { organisationEnabled: false, systemEnabled: false } });

    // Fail VISIBLY: an unknown request is a fixture gap, never a plausible empty list (which would put an invented
    // "nothing here" state into published media) and never a pass-through to a real server.
    unhandled.push(`${method} ${p}${q.toString() ? '?' + q : ''}`);
    return json(501, { statusCode: 501, message: `Documentation fixture has no handler for ${method} ${p}` });
  }
  return { route, unhandled };
}

// ─── Public API ────────────────────────────────────────────────────────────────────────────
/**
 * Installs the fixture backend on a Playwright page.
 * @param {import('playwright').Page} page
 * @param {{ persona?: 'manager'|'ceo'|'platformAdmin'|'newManager'|'anon', theme?: 'light'|'dark', latencyMs?: number, readyAfterPolls?: number, mutate?: (state) => void }} opts
 */
async function install(page, opts = {}) {
  const state = buildState(opts.persona || 'manager', opts);
  if (opts.mutate) opts.mutate(state);
  const { route, unhandled } = handler(state, page, opts);
  const cors = { 'access-control-allow-origin': APP_ORIGIN, 'access-control-allow-credentials': 'true', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', vary: 'Origin' };
  const theme = opts.theme || 'light';
  const rt = { requests: 0, queued: [], waiters: [], n: 0 };
  const push = (type) => { rt.queued.push(type); rt.waiters.splice(0).forEach((w) => w()); };
  await page.addInitScript((t) => { try { localStorage.setItem('theme', t); } catch { /* ignore */ } }, theme);

  // Belt and braces: anything that is neither the app origin, an intercepted /rest/v1 call nor web fonts is aborted and
  // reported, so a capture can never reach a real development or production server by accident.
  await page.route((url) => url.origin !== new URL(APP_ORIGIN).origin && !/^(fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(url.hostname), (r) => {
    unhandled.push(`BLOCKED ${r.request().method()} ${r.request().url()}`);
    return r.abort('blockedbyclient');
  });
  // The phone field's flag images come from a public icon CDN in the real app; captures serve the identical files from the
  // locally installed `country-flag-icons` package instead of the network.
  await page.route('https://purecatamphetamine.github.io/country-flag-icons/**', (r) => {
    const rel = new URL(r.request().url()).pathname.replace(/^\/country-flag-icons\//, '');
    const file = path.join(REPO_ROOT, 'node_modules', 'country-flag-icons', ...rel.split('/'));
    if (!/^[\w/]+\.svg$/.test(rel) || !fs.existsSync(file)) { unhandled.push(`MISSING FLAG ${rel}`); return r.abort(); }
    return r.fulfill({ status: 200, contentType: 'image/svg+xml', body: fs.readFileSync(file) });
  });
  await page.route('**/rest/v1/**', async (r) => {
    const req = r.request();
    const url = new URL(req.url());
    const p = url.pathname.replace(/^.*\/rest\/v1/, '') || '/';
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    if (p.startsWith('/realtime')) {
      // Default: 204 = "realtime off". With `realtime: true` the stream is held open and each `push(type)` delivers one
      // server-sent event through the app's real refresh path (the client reconnects for the next one).
      if (!opts.realtime) return r.fulfill({ status: 204, headers: cors });
      const mine = ++rt.requests;
      while (!rt.queued.length || mine !== rt.requests) {
        await new Promise((resolve) => rt.waiters.push(resolve));
        if (mine !== rt.requests) return r.abort().catch(() => {});
      }
      const frames = rt.queued.splice(0).map((type) => `data: ${JSON.stringify({ eventId: `fx-${++rt.n}`, type, occurredAt: new Date().toISOString() })}

`).join('');
      return r.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/event-stream' }, body: frames }).catch(() => {});
    }
    try {
      const res = await route(req.method(), p, url.searchParams, req);
      const latency = typeof opts.latencyMs === 'function' ? opts.latencyMs(req.method(), p) : opts.latencyMs || 0;
      if (latency) await new Promise((resolve) => setTimeout(resolve, latency));
      if (res.raw) return r.fulfill({ status: res.status, headers: { ...cors, 'content-type': res.contentType }, body: res.raw });
      return r.fulfill({ status: res.status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(res.body) });
    } catch (err) {
      unhandled.push(`ERROR ${req.method()} ${p}: ${err.message}`);
      return r.fulfill({ status: 500, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Fixture error' }) });
    }
  });
  return { state, unhandled, push };
}

/** Generated PNG imagery for upload interactions (logo / profile photo). */
async function generatedPng(browser, kind, seed = 'jordan') {
  const ctx = await browser.newContext({ viewport: { width: 256, height: 256 } });
  try {
    const p = await ctx.newPage();
    await p.setContent(`<html><body style="margin:0">${kind === 'logo' ? logoSvg() : avatarSvg(seed)}</body></html>`);
    return await p.locator('svg').screenshot({ omitBackground: true });
  } finally {
    await ctx.close();
  }
}

module.exports = { install, generatedPng, PERSONAS, APP_ORIGIN, at, ago };
