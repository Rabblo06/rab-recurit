// What ONE real user of each persona does, as k6 code (the "virtual user" of the realistic-load-test method: one VU is one
// person with the app open, with human pauses; polls keep running while the person reads). main.js runs these.
//
// Every request path, poll interval and request group is read from the client code on main (basis CODE, file:line in
// profile.js and the cost/screen-traffic/schedules/after-c1.mjs schedule it extends). Session lengths, think times and
// how often a person takes an action are ASSUMED (no production request logs exist; see profile.js), and every choice
// comes from a seeded PRNG so all arms replay the same traffic shape.
//
// Safety: synthetic accounts of the harness seed only (*.example.test), the disposable harness API only (main.js refuses
// any other host), no payroll writes (payroll is read only), no clock-in, no deletes. Emails go to the LOGGER driver,
// push and realtime are off.
import http from 'k6/http';
import { check } from 'k6';
import { env, envNum, think, jitter, between, chance, pickOne, pickWeighted } from './lib.js';
import { PROFILE } from './profile.js';

const API = `${env('BASE_URL', 'http://costaudit-api:3000')}/rest/v1`;
const ORIGIN = 'http://127.0.0.1:5173'; // the harness API's only CORS origin (docker-compose.cost.yml CORS_ORIGINS)
const MIN = 60_000;
const DAY = 86_400_000;

// Expected statuses are declared per call, never silenced globally (429 and 5xx always count as failures).
const OK = http.expectedStatuses({ min: 200, max: 299 });
// 409: a booking conflict the server refuses by design (double booking, offer no longer pending/accepted, staff
// overlap). Counted as expected, and reported separately through the `conflict` check.
const OK_OR_CONFLICT = http.expectedStatuses({ min: 200, max: 299 }, 409);

// ---- the measurement window ----------------------------------------------------------------------------------------
// main.js setup() fixes t0 (epoch ms) when the VUs start; the resource window of measure.sh is [t0+WARM, t0+WARM+WIN).
let T0 = 0;
const WARM_MS = envNum('K6P_WARM_S', 60) * 1000;
const WIN_MS = envNum('K6P_WIN_S', 240) * 1000;
export function setWindowStart(t0) { T0 = t0; }
function winTags() {
  const el = Date.now() - T0 - WARM_MS;
  if (el < 0 || el >= WIN_MS) return { win: 'out', half: 'x' };
  return { win: 'in', half: el < WIN_MS / 2 ? 'a' : 'b' };
}

// ---- HTTP ----------------------------------------------------------------------------------------------------------
function headersFor(u, background) {
  const h = { Accept: 'application/json', 'Content-Type': 'application/json', 'cf-connecting-ip': u.ip };
  if (u.cookie) { h.Cookie = u.cookie; h.Origin = ORIGIN; } else { h.Authorization = `Bearer ${u.bearer}`; h['x-client-platform'] = 'mobile'; }
  // C1 policy: timer-driven runs send X-Crewflow-Background: 1; start, resume and user actions do not.
  if (background) h['X-Crewflow-Background'] = '1';
  return h;
}
function params(u, name, journey, o = {}) {
  return {
    headers: headersFor(u, o.background),
    tags: { name, journey, persona: u.persona, ...winTags() },
    responseCallback: o.conflictOk ? OK_OR_CONFLICT : OK,
    timeout: '30s',
  };
}
function verdict(res, name, conflictOk) {
  check(res, { [`${name} 2xx`]: (r) => r.status >= 200 && r.status < 300 || (conflictOk && r.status === 409) });
  if (conflictOk && res.status === 409) check(res, { conflict: () => true });
  return res;
}
function get(u, path, name, journey, o = {}) {
  return verdict(http.get(`${API}${path}`, params(u, name, journey, o)), name, o.conflictOk);
}
function post(u, path, body, name, journey, o = {}) {
  return verdict(http.post(`${API}${path}`, JSON.stringify(body ?? {}), params(u, name, journey, o)), name, o.conflictOk);
}
/** Requests the client sends in parallel, as one k6 batch (≤ 6 per host, like a browser). */
function batch(u, list, journey, o = {}) {
  const res = http.batch(list.map(([path, name]) => ['GET', `${API}${path}`, null, params(u, name, journey, o)]));
  res.forEach((r, i) => verdict(r, list[i][1]));
  return res;
}
function json(res) {
  if (!res || res.status < 200 || res.status >= 300 || !res.body) return null;
  try { return JSON.parse(res.body); } catch { return null; }
}
const rows = (j) => (Array.isArray(j) ? j : j && Array.isArray(j.data) ? j.data : []);
const qs = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const sep = (p) => (p.includes('?') ? '&' : '?');

/** Flutter/iOS `all()` and rab-front fetchAllPages: page=1..N at a fixed limit until `total` or a short page. */
function pageAllParallel(u, lists, journey, o = {}) {
  const state = lists.map(([path, name, limit]) => ({ path, name, limit, page: 1, got: 0, done: false, rows: [] }));
  for (let round = 0; round < 15 && state.some((s) => !s.done); round++) {
    const open = state.filter((s) => !s.done);
    const res = batch(u, open.map((s) => [`${s.path}${sep(s.path)}page=${s.page}&limit=${s.limit}`, s.name]), journey, o);
    res.forEach((r, i) => {
      const s = open[i];
      const j = json(r);
      const data = rows(j);
      s.rows.push(...data);
      s.got += data.length;
      const total = j && typeof j.total === 'number' ? j.total : null;
      if (!j || Array.isArray(j) || data.length < s.limit || (total !== null && s.got >= total)) s.done = true;
      else s.page++;
    });
  }
  return state.map((s) => s.rows);
}
/** Keyset walk (`limit`, `cursor` -> `{ data, nextCursor }`), first page possibly already fetched in a batch. */
function keysetWalk(u, path, name, journey, first, o = {}) {
  let j = json(first);
  const out = rows(j);
  for (let i = 0; i < 10 && j && j.nextCursor; i++) {
    j = json(get(u, `${path}${sep(path)}cursor=${encodeURIComponent(j.nextCursor)}`, name, journey, o));
    out.push(...rows(j));
  }
  return out;
}

// ---- a foreground session: polls on their own timers, user actions in between --------------------------------------
// Events run one at a time in time order (one VU is one thread); a poll timer re-arms after its run ends (the C1
// serial policy: "the next delay starts after it ends"), with ±20 % jitter. An action is a list of steps, each after a
// human pause.
function foreground(durS, timers, actions) {
  const end = Date.now() + durS * 1000;
  const q = [];
  for (const t of timers) q.push({ at: Date.now() + jitter(t.everyS) * 1000, timer: t });
  for (const a of actions) q.push({ at: Date.now() + a.atS * 1000, steps: a.steps, i: 0 });
  while (q.length) {
    q.sort((x, y) => x.at - y.at);
    const e = q.shift();
    if (e.at >= end) break;
    const wait = (e.at - Date.now()) / 1000;
    if (wait > 0) think(wait, wait);
    if (e.timer) {
      e.timer.run();
      q.push({ at: Date.now() + jitter(e.timer.everyS) * 1000, timer: e.timer });
    } else {
      const ctx = e.ctx || {};
      const go = e.steps[e.i].run(ctx);
      if (go !== false && e.i + 1 < e.steps.length) {
        const [lo, hi] = e.steps[e.i + 1].afterS || [0, 0];
        q.push({ at: Date.now() + between(lo, hi) * 1000, steps: e.steps, i: e.i + 1, ctx });
      }
    }
  }
  const rest = (end - Date.now()) / 1000;
  if (rest > 0) think(rest, rest);
}

const realtimeProbe = ['/realtime/stream', 'GET /realtime/stream']; // 204 while REALTIME_ENABLED=false: the client stops
const bell = (u, journey) => ({ everyS: PROFILE.poll.bellS, run: () => get(u, '/notifications/unread-count', 'GET /notifications/unread-count', journey, { background: true }) });

// ---- Staff (rab-mobile, Flutter Home) ------------------------------------------------------------------------------
function staffReconcile(u, journey, background) {
  const r = batch(u, [['/offers/mine?scope=current&limit=50', 'GET /offers/mine?scope=current'], ['/attendance/me/active', 'GET /attendance/me/active']], journey, { background });
  u.offers = keysetWalk(u, '/offers/mine?scope=current&limit=50', 'GET /offers/mine?scope=current', journey, r[0], { background });
}
export function staffSession(u) {
  const P = PROFILE.staff;
  // Start (offers_provider.dart, attendance_provider.dart, notifications_provider.dart constructors + realtime probe).
  const r = batch(u, [['/offers/mine?scope=all&limit=200', 'GET /offers/mine?scope=all'], ['/attendance/me/active', 'GET /attendance/me/active'],
    ['/notifications/unread-count', 'GET /notifications/unread-count'], realtimeProbe], 'staff:start');
  u.offers = keysetWalk(u, '/offers/mine?scope=all&limit=200', 'GET /offers/mine?scope=all', 'staff:start', r[0]);
  const dur = between(...P.sessionS);
  const actions = [];
  if (chance(P.acceptP)) {
    actions.push({ atS: between(10, dur * 0.6), steps: [
      { run: (c) => { // the person opens an offer card (data already on the phone) and decides
        const soon = Date.now() + PROFILE.deadlineMarginMin * MIN;
        const pending = (u.offers || []).filter((o) => o.status === 'pending' && Date.parse(o.startsAt) > soon && Date.parse(o.expiresAt) > Date.now());
        if (!pending.length) return false;
        c.offer = pickOne(pending);
        return true;
      } },
      { afterS: P.decideS, run: (c) => {
        post(u, `/offers/${c.offer.id}/accept`, {}, 'POST /offers/:id/accept', 'staff:accept', { conflictOk: true });
        staffReconcile(u, 'staff:accept'); // the app reloads its offers after its own mutation
      } },
    ] });
  }
  if (chance(P.historyP)) actions.push({ atS: between(5, dur * 0.8), steps: [{ run: () => { get(u, '/attendance/me/history?limit=50', 'GET /attendance/me/history', 'staff:history'); } }] });
  if (chance(P.payslipsP)) actions.push({ atS: between(5, dur * 0.8), steps: [{ run: () => { batch(u, [['/payroll/me/payslips', 'GET /payroll/me/payslips'], ['/payroll/me/statements', 'GET /payroll/me/statements']], 'staff:payroll-read'); } }] });
  foreground(dur, [{ everyS: PROFILE.poll.staffReconcileS, run: () => staffReconcile(u, 'staff:poll', true) }, bell(u, 'staff:poll')], actions);
  think(...P.awayS); // app in the background: no requests
}

// ---- Venue Manager (rab-mobile, Sent Shifts) -----------------------------------------------------------------------
function vmFullRefresh(u, journey) {
  const caps = json(get(u, '/auth/capabilities', 'GET /auth/capabilities', journey)) || {};
  const [shifts, venues, roles, , sent] = pageAllParallel(u, [
    ['/shifts', 'GET /shifts (all pages)', 100], ['/venues?includeArchived=true', 'GET /venues (all pages)', 100],
    ['/job-roles', 'GET /job-roles (all pages)', 100], ['/offers', 'GET /offers (all pages)', 100], ['/shifts/sent?view=all', 'GET /shifts/sent (all pages)', 100],
  ], journey);
  if (caps['staff.view']) get(u, '/staff/venue-directory?limit=1', 'GET /staff/venue-directory?limit=1', journey);
  if (caps['report.view']) batch(u, [['/attendance/report/shifts?bucket=current&page=1&limit=1', 'GET /attendance/report/shifts?limit=1'], ['/attendance/report/shifts?bucket=history&page=1&limit=1', 'GET /attendance/report/shifts?limit=1']], journey);
  u.venues = venues.filter((v) => !v.archivedAt && v.status !== 'archived');
  u.roles = roles.filter((r) => !r.archivedAt);
  u.sent = sent;
  u.shifts = shifts;
}
export function vmSession(u) {
  const P = PROFILE.vm;
  batch(u, [['/notifications/unread-count', 'GET /notifications/unread-count'], realtimeProbe], 'vm:start');
  vmFullRefresh(u, 'vm:start');
  const dur = between(...P.sessionS);
  const actions = [];
  if (chance(P.requestP)) {
    actions.push({ atS: between(10, dur * 0.5), steps: [
      { run: (c) => { // opens "Request staff": the team list
        c.team = rows(json(get(u, '/staff/venue-directory?limit=100', 'GET /staff/venue-directory', 'vm:request')));
        return c.team.length > 0 && (u.venues || []).length > 0 && (u.roles || []).length > 0;
      } },
      { afterS: P.formS, run: (c) => {
        // A night shift 2-8 days ahead (the seed's shifts end by 22:00, so a 23:00 start overlaps none of them; far from
        // the 180-min roster window and the start-30 min offer deadline).
        const day = Math.floor(Date.now() / DAY) * DAY + (2 + Math.floor(between(0, 7))) * DAY;
        const start = day + 23 * 3600_000;
        const n = 1 + Math.floor(between(0, 2));
        const picks = [];
        while (picks.length < n && picks.length < c.team.length) { const s = pickOne(c.team); if (!picks.includes(s.id)) picks.push(s.id); }
        post(u, '/shifts/request', {
          venueId: pickOne(u.venues).id, jobRoleId: pickOne(u.roles).id, startsAt: new Date(start).toISOString(),
          endsAt: new Date(start + 5 * 3600_000).toISOString(), staffRequired: picks.length, staffProfileIds: picks, breakMinutes: 30,
        }, 'POST /shifts/request', 'vm:request', { conflictOk: true });
        vmFullRefresh(u, 'vm:request'); // venue_manager_provider refresh() after the user's own mutation
      } },
    ] });
  }
  if (chance(P.sentDetailP)) actions.push({ atS: between(5, dur * 0.8), steps: [{ run: () => {
    const s = (u.sent || []).length ? pickOne(u.sent) : null;
    if (s) get(u, `/shifts/sent/${s.id}`, 'GET /shifts/sent/:id', 'vm:sent-detail');
  } }] });
  if (chance(P.attendanceP)) actions.push({ atS: between(5, dur * 0.8), steps: [{ run: () => {
    const list = rows(json(get(u, '/attendance/report/shifts?bucket=history&page=1&limit=20', 'GET /attendance/report/shifts', 'vm:attendance-read')));
    if (list.length) { const s = pickOne(list); get(u, `/attendance/report/shift/${s.shiftId || s.id}`, 'GET /attendance/report/shift/:id', 'vm:attendance-read'); }
  } }] });
  foreground(dur, [{ everyS: PROFILE.poll.vmSentS, run: () => get(u, '/shifts/sent?view=all&page=1&limit=50', 'GET /shifts/sent?limit=50', 'vm:poll', { background: true }) }, bell(u, 'vm:poll')], actions);
  think(...P.awayS);
}

// ---- Internal Manager (rab-front web console) -------------------------------------------------------------------------
const iso = (ms) => new Date(ms).toISOString();
const startOfDay = (ms) => Math.floor(ms / DAY) * DAY;
const startOfWeek = (ms) => { const d = startOfDay(ms); const dow = (new Date(d).getUTCDay() + 6) % 7; return d - dow * DAY; };
function imDashboard(u, journey) {
  // features/dashboard/Dashboard.tsx at this commit: the distinct requests (the same set lib/endpoints.js measures).
  const now = Date.now();
  const d0 = startOfDay(now);
  const res = batch(u, [
    ['/auth/me', 'GET /auth/me'], ['/auth/capabilities', 'GET /auth/capabilities'], ['/notifications/unread-count', 'GET /notifications/unread-count'], realtimeProbe,
    ['/dashboard/summary', 'GET /dashboard/summary'], ['/profile', 'GET /profile'],
    ['/offers?status=pending&limit=1', 'GET /offers?status&limit=1'], ['/offers?status=staff_accepted&limit=1', 'GET /offers?status&limit=1'],
    ['/offers?status=manager_confirmed&limit=1', 'GET /offers?status&limit=1'], ['/offers?status=declined&limit=1', 'GET /offers?status&limit=1'],
    ['/offers?status=expired&limit=1', 'GET /offers?status&limit=1'],
    [`/shifts?${qs({ from: iso(now), to: iso(now + 30 * DAY), status: 'open', limit: 1 })}`, 'GET /shifts?range&limit=1'],
    [`/shifts?${qs({ from: iso(now), to: iso(now + 30 * DAY), limit: 1 })}`, 'GET /shifts?range&limit=1'],
    [`/attendance?${qs({ clockInFrom: iso(d0 - 6 * DAY), clockInTo: iso(now), page: 1, limit: 200 })}`, 'GET /attendance?7d'],
    [`/shifts?${qs({ from: iso(d0 - 30 * DAY), to: iso(now), page: 1, limit: 200 })}`, 'GET /shifts?range&limit=200'],
    ['/venues?page=1&limit=200', 'GET /venues'],
    [`/shifts?${qs({ from: iso(d0), to: iso(d0 + 14 * DAY), sort: 'startsAt', direction: 'asc', limit: 25 })}`, 'GET /shifts?next14d&limit=25'],
    [`/shifts?${qs({ from: iso(startOfWeek(now)), to: iso(startOfWeek(now) + 7 * DAY), sort: 'startsAt', direction: 'asc', page: 1, limit: 200 })}`, 'GET /shifts?range&limit=200'],
    ['/offers?sort=sentAt&direction=desc&limit=6', 'GET /offers?sort=sentAt&limit=6'],
  ], journey);
  u.upcoming = rows(json(res[16])).filter((s) => ['open', 'offered', 'partially_filled'].includes(s.status) && Date.parse(s.startsAt) > now + PROFILE.deadlineMarginMin * MIN);
}
const PAGES = [
  { name: 'approvals', weight: PROFILE.im.pageWeights.approvals, visit: (u, dwell) => {
    const list = () => rows(json(get(u, '/shifts/requests/pending?page=1&limit=50', 'GET /shifts/requests/pending', 'im:approvals')));
    const pending = list();
    const steps = pending.length ? [{ afterS: [3, 10], run: (c) => {
      c.s = pending[0];
      get(u, `/shifts/${c.s.id}`, 'GET /shifts/:id', 'im:approvals');
      get(u, `/shifts/${c.s.id}/requested-staff`, 'GET /shifts/:id/requested-staff', 'im:approvals');
    } }, { afterS: PROFILE.im.reviewS, run: (c) => { post(u, `/shifts/${c.s.id}/approve`, {}, 'POST /shifts/:id/approve', 'im:approve', { conflictOk: true }); list(); } }] : [];
    foreground(dwell, [bell(u, 'im:poll')], steps.length ? [{ atS: 0, steps: [{ run: () => true }, ...steps] }] : []);
  } },
  { name: 'confirmations', weight: PROFILE.im.pageWeights.confirmations, visit: (u, dwell) => {
    const list = () => rows(json(get(u, '/offers?status=staff_accepted&sort=shiftDate&direction=asc&page=1&limit=50', 'GET /offers?status=staff_accepted', 'im:confirmations')));
    const soon = Date.now() + PROFILE.deadlineMarginMin * MIN;
    const ready = list().filter((o) => Date.parse(o.startsAt) > soon);
    const steps = ready.length ? [{ afterS: PROFILE.im.reviewS, run: () => { post(u, `/offers/${ready[0].id}/confirm`, {}, 'POST /offers/:id/confirm', 'im:confirm', { conflictOk: true }); list(); } }] : [];
    foreground(dwell, [bell(u, 'im:poll')], steps.length ? [{ atS: 0, steps: [{ run: () => true }, ...steps] }] : []);
  } },
  { name: 'venue-offers', weight: PROFILE.im.pageWeights.venueOffers, visit: (u, dwell) => {
    const page = () => get(u, '/shifts/requests?page=1&limit=50', 'GET /shifts/requests', 'im:venue-offers', { background: true });
    get(u, '/shifts/requests?page=1&limit=50', 'GET /shifts/requests', 'im:venue-offers');
    foreground(dwell, [{ everyS: PROFILE.poll.webVenueOffersS, run: page }, bell(u, 'im:poll')], []);
  } },
  { name: 'pipeline', weight: PROFILE.im.pageWeights.pipeline, visit: (u, dwell) => {
    if (!(u.upcoming || []).length) return think(dwell, dwell);
    const s = pickOne(u.upcoming);
    batch(u, [[`/shifts/${s.id}/pipeline`, 'GET /shifts/:id/pipeline'], ['/auth/capabilities', 'GET /auth/capabilities'], ['/auth/me', 'GET /auth/me']], 'im:pipeline');
    const steps = chance(PROFILE.im.sendOfferP) ? [{ atS: between(5, dwell * 0.5), steps: [
      { run: (c) => { c.staff = rows(json(get(u, '/staff?page=1&limit=50', 'GET /staff', 'im:send-offer'))).filter((x) => x.staffProfileId || x.id); return c.staff.length > 0; } },
      { afterS: [5, 20], run: (c) => { const p = pickOne(c.staff); post(u, `/shifts/${s.id}/offers`, { staffProfileId: p.staffProfileId || p.id }, 'POST /shifts/:id/offers', 'im:send-offer', { conflictOk: true }); } },
    ] }] : [];
    foreground(dwell, [{ everyS: PROFILE.poll.webPipelineS, run: () => get(u, `/shifts/${s.id}/pipeline`, 'GET /shifts/:id/pipeline', 'im:pipeline', { background: true }) }, bell(u, 'im:poll')], steps);
  } },
  { name: 'calendar', weight: PROFILE.im.pageWeights.calendar, visit: (u, dwell) => {
    // features/scheduling/Calendar.tsx: the week's shifts, venues incl. archived, job roles, the day's confirmed people.
    const w0 = startOfWeek(Date.now());
    pageAllParallel(u, [
      [`/shifts?${qs({ from: iso(w0), to: iso(w0 + 7 * DAY) })}`, 'GET /shifts?range (all pages)', 200],
      ['/venues?includeArchived=true', 'GET /venues (all pages)', 200],
      [`/offers?${qs({ status: 'manager_confirmed', shiftDateFrom: iso(startOfDay(Date.now())), shiftDateTo: iso(startOfDay(Date.now())) })}`, 'GET /offers?status=manager_confirmed&day (all pages)', 200],
    ], 'im:calendar');
    get(u, '/job-roles', 'GET /job-roles', 'im:calendar');
    foreground(dwell, [bell(u, 'im:poll')], []);
  } },
  { name: 'payroll', weight: PROFILE.im.pageWeights.payroll, visit: (u, dwell) => {
    // features/payroll/usePayroll.ts + PayrollRunsView.tsx: READS only (no approval, no run, no export).
    const month = new Date().toISOString().slice(0, 7);
    batch(u, [[`/payroll/period?month=${month}`, 'GET /payroll/period'], ['/payroll/runs', 'GET /payroll/runs'], ['/payroll/calendar', 'GET /payroll/calendar']], 'im:payroll-read');
    foreground(dwell, [bell(u, 'im:poll')], []);
  } },
];
export function imSession(u) {
  const P = PROFILE.im;
  imDashboard(u, 'im:start');
  const visits = P.visits[0] + Math.floor(between(0, P.visits[1] - P.visits[0] + 1));
  for (let i = 0; i < visits; i++) pickWeighted(PAGES).visit(u, between(...P.dwellS));
  think(...P.awayS); // tab hidden: polls paused (refetchIntervalInBackground false)
}

export const PERSONA_RUN = { staff: staffSession, vm: vmSession, im: imSession };
