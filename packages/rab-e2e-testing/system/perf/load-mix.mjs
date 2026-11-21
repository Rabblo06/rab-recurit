// M9 hardening (Lane F) — open-model load mix against a DISPOSABLE API built from main (loopback only).
//
// Drives the realistic peak mix the hardening plan names (staff app reads, check-in / clock-in / clock-out, offer
// responses, manager scheduling, Venue Manager app reads, payroll reads and one payroll run) at fixed ARRIVAL rates
// (requests are sent on schedule whether or not earlier ones have answered, so a slow server cannot slow the test down
// and hide its own latency; latency is measured from the scheduled send time). Phases and the peak definition: see
// packages/rab-docker/docs/hardening/LOAD-TEST.md.
//
//   PERF_API=http://127.0.0.1:3490 PERF_ORIGIN=https://app.example.test PERF_PASSWORD=<seed password> \
//   PERF_APP_SECRET=<the disposable stack's APP_SECRET, for the shift QR only> PERF_WORK=<seed-volume --out json> \
//   [PERF_MANAGER_EMAIL=admin@acme.test] [PERF_VM_EMAIL=<venue manager>] [PERF_PHASES=warmup:120:0.5,peak:900:1,spike:180:2,recovery:120:1] \
//   [PERF_PG_CONTAINER=<disposable postgres container>] [PERF_API_PID=<pid>] [PERF_WORKER_PID=<pid>] \
//     node packages/rab-e2e-testing/system/perf/load-mix.mjs <out.json>
//
// The shift QR is signed here exactly as AttendanceQrService signs the printed one (HS256, HKDF-derived key, issuer
// rab-attendance, audience rab-qr): that stands in for a staff member scanning the venue's printed QR. It needs the
// stack's APP_SECRET, so it only ever runs against a throwaway stack whose secret was generated for the run.
//
// Client IPs: every virtual user presents its own CF-Connecting-IP, honoured only because the API under test was started
// with TRUSTED_PROXY_CIDRS=127.0.0.1/32. The per-IP / per-account limits stay at their production values.
import { execFile } from 'node:child_process';
import { createHmac, hkdfSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';

const [outFile] = process.argv.slice(2);
if (!outFile) throw new Error('usage: load-mix.mjs <out.json>');
const API = new URL(process.env.PERF_API ?? 'http://127.0.0.1:3490');
if (!['127.0.0.1', 'localhost'].includes(API.hostname)) throw new Error('refusing: PERF_API is not a loopback address');
const ORIGIN = process.env.PERF_ORIGIN ?? 'https://app.lanef.test';
const PASSWORD = process.env.PERF_PASSWORD ?? '';
const APP_SECRET = process.env.PERF_APP_SECRET ?? '';
if (!PASSWORD || !APP_SECRET) throw new Error('PERF_PASSWORD and PERF_APP_SECRET are required');
const WORK = JSON.parse(readFileSync(process.env.PERF_WORK ?? '', 'utf8'));
const MANAGER_EMAIL = process.env.PERF_MANAGER_EMAIL ?? 'admin@acme.test';
const VM_EMAIL = process.env.PERF_VM_EMAIL ?? '';
const PHASES = (process.env.PERF_PHASES ?? 'warmup:120:0.5,peak:900:1,spike:180:2,recovery:120:1').split(',').map((p) => {
  const [name, secs, mult] = p.split(':');
  return { name, secs: Number(secs), mult: Number(mult) };
});
// Arrival rates at multiplier 1.0 (requests or flows per second), see LOAD-TEST.md §2 for the derivation.
const RATES = {
  staffRead: Number(process.env.PERF_RATE_STAFF_READ ?? 8),
  clockFlow: Number(process.env.PERF_RATE_CLOCK_FLOW ?? 0.6), // 3 requests each: check-in, clock-in, clock-out
  offerRespond: Number(process.env.PERF_RATE_OFFER ?? 1),
  managerRead: Number(process.env.PERF_RATE_MANAGER_READ ?? 8),
  createAndSend: Number(process.env.PERF_RATE_CREATE ?? 0.15),
  offerConfirm: Number(process.env.PERF_RATE_CONFIRM ?? 0.4),
  vmRead: Number(process.env.PERF_RATE_VM_READ ?? (VM_EMAIL ? 1 : 0)),
  payrollRead: Number(process.env.PERF_RATE_PAYROLL_READ ?? 0.2),
  login: Number(process.env.PERF_RATE_LOGIN ?? 0.2),
};
const MANAGER_SESSIONS = Number(process.env.PERF_MANAGER_SESSIONS ?? 8);
const SEARCH_TERMS = process.env.PERF_SEARCH_TERMS ? process.env.PERF_SEARCH_TERMS.split(',') : null;
const STAFF_READER_POOL = Number(process.env.PERF_STAFF_READERS ?? 400);
const PAYROLL_RUN_AT_S = Number(process.env.PERF_PAYROLL_RUN_AT ?? (PHASES[0].secs + 300));

// ------------------------------------------------------------------------------------------------ HTTP + recording
const agent = new http.Agent({ keepAlive: true, maxSockets: 512 });
let ipSeq = 1;
const nextIp = () => {
  const n = ipSeq++;
  return `10.${80 + ((n >> 16) & 15)}.${(n >> 8) & 255}.${n & 255}`;
};
function request(method, path, { cookie, bearer, body, mobile, ip, origin } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers = { Host: API.host, Accept: 'application/json' };
  if (payload) headers['Content-Type'] = 'application/json';
  if (origin) headers.Origin = origin;
  if (cookie) headers.Cookie = cookie;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (mobile) headers['X-Client-Platform'] = 'mobile';
  if (ip) headers['CF-Connecting-IP'] = ip;
  return new Promise((resolve) => {
    const r = http.request({ host: API.hostname, port: API.port, method, path: `/rest/v1${path}`, headers, agent, timeout: 30_000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = text ? JSON.parse(text) : undefined;
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', (e) => resolve({ status: -1, text: String(e) }));
    if (payload) r.write(payload);
    r.end();
  });
}

const T0 = Date.now() + 2_000; // measured window starts after preparation, see main()
let phaseIdx = -1;
let inFlight = 0;
const samples = []; // [phase, group, endpoint, status, ms, lagMs, tRelS]
const errorsSample = [];
const counters = { skippedNoBooking: 0, skippedNoOffer: 0, skippedNoConfirm: 0, clockOutsNotDue: 0, clientCapDrops: 0 };
const CLIENT_CAP = 800;

/** Sends at `scheduledAt` (ms epoch) and records latency from the schedule (open model). */
async function timed(group, endpoint, scheduledAt, fn) {
  if (inFlight >= CLIENT_CAP) {
    counters.clientCapDrops++;
    samples.push([PHASES[phaseIdx]?.name ?? 'prep', group, endpoint, -2, 30_000, 0, (Date.now() - T0) / 1000]);
    return { status: -2 };
  }
  inFlight++;
  const lag = Date.now() - scheduledAt;
  const res = await fn();
  inFlight--;
  const ms = Date.now() - scheduledAt;
  samples.push([PHASES[phaseIdx]?.name ?? 'prep', group, endpoint, res.status, ms, lag, (scheduledAt - T0) / 1000]);
  if ((res.status < 200 || res.status >= 300) && errorsSample.length < 400) {
    errorsSample.push({ group, endpoint, status: res.status, body: (res.text ?? '').slice(0, 300) });
  }
  return res;
}

// ------------------------------------------------------------------------------------------------ sessions
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REFRESH_AFTER_MS = 11 * 60_000; // access tokens live 15 minutes (session-policy.ts ACCESS_TOKEN_TTL_MS)
const cookieJar = (res, prev = '') => {
  const jar = Object.fromEntries(prev.split('; ').filter(Boolean).map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]));
  for (const c of [].concat(res.headers?.['set-cookie'] ?? [])) {
    const kv = c.split(';')[0];
    jar[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1);
  }
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
};

const staffSessions = new Map();
async function staffLogin(email, group = 'prep', scheduledAt = Date.now()) {
  const ip = nextIp();
  const res = await timed(group, 'POST /auth/login (staff app)', scheduledAt, () =>
    request('POST', '/auth/login', { mobile: true, ip, body: { email, password: PASSWORD, applicationTarget: 'staff_app' } }),
  );
  if (res.status !== 200 || !res.json?.accessToken) return null;
  const s = { email, ip, bearer: res.json.accessToken, refresh: res.json.refreshToken, at: Date.now(), refreshing: null };
  staffSessions.set(email, s);
  return s;
}
async function ensureStaffFresh(s) {
  if (Date.now() - s.at < REFRESH_AFTER_MS) return s;
  if (!s.refreshing) {
    s.refreshing = (async () => {
      const res = await timed('auth-refresh', 'POST /auth/refresh (staff app)', Date.now(), () =>
        request('POST', '/auth/refresh', { mobile: true, ip: s.ip, body: { refreshToken: s.refresh } }),
      );
      if (res.status === 200 && res.json?.accessToken) {
        s.bearer = res.json.accessToken;
        s.refresh = res.json.refreshToken ?? s.refresh;
        s.at = Date.now();
      }
      s.refreshing = null;
    })();
  }
  await s.refreshing;
  return s;
}
const staffCall = async (s, group, endpoint, method, path, body, scheduledAt) => {
  await ensureStaffFresh(s);
  return timed(group, endpoint, scheduledAt, () => request(method, path, { mobile: true, ip: s.ip, bearer: s.bearer, body }));
};

const webSessions = [];
async function webLogin(email, applicationTarget) {
  const ip = nextIp();
  const mobile = applicationTarget === 'venue_manager_app';
  const res = await request('POST', '/auth/login', {
    ip,
    mobile,
    origin: mobile ? undefined : ORIGIN,
    body: { email, password: PASSWORD, ...(applicationTarget ? { applicationTarget } : {}) },
  });
  if (res.status !== 200) throw new Error(`login ${email} ${applicationTarget ?? 'web'}: ${res.status} ${(res.text ?? '').slice(0, 200)}`);
  return mobile
    ? { email, ip, mobile, bearer: res.json.accessToken, refresh: res.json.refreshToken, at: Date.now(), refreshing: null }
    : { email, ip, mobile, cookie: cookieJar(res), at: Date.now(), refreshing: null };
}
async function ensureWebFresh(s) {
  if (Date.now() - s.at < REFRESH_AFTER_MS) return s;
  if (!s.refreshing) {
    s.refreshing = (async () => {
      const res = await timed('auth-refresh', s.mobile ? 'POST /auth/refresh (venue manager app)' : 'POST /auth/refresh (console cookie)', Date.now(), () =>
        s.mobile
          ? request('POST', '/auth/refresh', { mobile: true, ip: s.ip, body: { refreshToken: s.refresh } })
          : request('POST', '/auth/refresh', { ip: s.ip, origin: ORIGIN, cookie: s.cookie, body: {} }),
      );
      if (res.status === 200) {
        if (s.mobile) {
          s.bearer = res.json.accessToken;
          s.refresh = res.json.refreshToken ?? s.refresh;
        } else s.cookie = cookieJar(res, s.cookie);
        s.at = Date.now();
      }
      s.refreshing = null;
    })();
  }
  await s.refreshing;
  return s;
}
const webCall = async (s, group, endpoint, method, path, body, scheduledAt) => {
  await ensureWebFresh(s);
  return timed(group, endpoint, scheduledAt, () =>
    s.mobile
      ? request(method, path, { mobile: true, ip: s.ip, bearer: s.bearer, body })
      : request(method, path, { ip: s.ip, origin: ORIGIN, cookie: s.cookie, body }),
  );
};

// ------------------------------------------------------------------------------------------------ shift QR
const QR_KEY = Buffer.from(Buffer.from(hkdfSync('sha256', Buffer.from(APP_SECRET, 'utf8'), Buffer.alloc(0), 'rab-qr-token-v1', 32)).toString('hex'), 'utf8');
const b64u = (b) => Buffer.from(b).toString('base64url');
function shiftQr(shiftId, venueId, ver) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ shiftId, venueId, ver, iat: Math.floor(Date.now() / 1000), iss: 'rab-attendance', aud: 'rab-qr' }));
  return `${head}.${body}.${createHmac('sha256', QR_KEY).update(`${head}.${body}`).digest('base64url')}`;
}

// ------------------------------------------------------------------------------------------------ scenarios
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const live = WORK.liveBookings.map((b) => ({ ...b, startsMs: Date.parse(b.startsAt), endsMs: Date.parse(b.endsAt), used: false }));
const offers = WORK.pendingOffers.map((o) => ({ ...o, used: false }));
const toConfirm = [];
let managers = [];
let vm = null;
let readers = [];
let refData = { venueIds: [], jobRoleId: null, staffIds: [], shiftIds: [], periodId: null, month: null };
let loginCursor = 0;

const STAFF_READS = [
  ['GET /auth/me', '/auth/me', 2],
  ['GET /attendance/me/active', '/attendance/me/active', 3],
  ['GET /offers/mine', '/offers/mine', 2],
  ['GET /attendance/me/history', '/attendance/me/history?limit=20', 1],
  ['GET /payroll/me/statements', '/payroll/me/statements?limit=100', 1],
  ['GET /payroll/me/payslips', '/payroll/me/payslips', 0.5],
  ['GET /notifications/unread-count', '/notifications/unread-count', 2],
  ['GET /notifications', '/notifications?limit=20', 0.5],
];
const weighted = (list) => {
  const total = list.reduce((a, x) => a + x.at(-1), 0);
  return () => {
    let r = Math.random() * total;
    for (const x of list) if ((r -= x.at(-1)) <= 0) return x;
    return list.at(-1);
  };
};
const nextStaffRead = weighted(STAFF_READS);
const iso = (ms) => new Date(ms).toISOString();
const MANAGER_READS = () => [
  ['GET /shifts (page 1, 50)', '/shifts?limit=50', 2],
  ['GET /shifts (this week)', `/shifts?limit=200&from=${encodeURIComponent(iso(Date.now() - 3 * 86400_000))}&to=${encodeURIComponent(iso(Date.now() + 4 * 86400_000))}`, 2],
  ['GET /offers (page 1, 50)', '/offers?limit=50', 1],
  ['GET /staff (page 1, 50)', '/staff?limit=50', 1],
  ['GET /staff?q=', `/staff?limit=50&q=${encodeURIComponent(`Staff ${1 + Math.floor(Math.random() * 999)}`)}`, 0.5],
  ['GET /attendance (page 1, 50)', '/attendance?limit=50', 1],
  ['GET /dashboard/summary', '/dashboard/summary', 1],
  // Selective terms, as a person searches (a staff reference, one venue). Every seeded user is "Perf Staff <n>", so a bare
  // "perf" or "staff" matches all 5,000 staff and every offer: that degenerate case is measured separately (LOAD-TEST.md).
  // PERF_SEARCH_TERMS (comma-separated) replaces them, e.g. the broad terms of the 2026-11-21 baseline run.
  ['GET /search', `/search?q=${encodeURIComponent(SEARCH_TERMS ? pick(SEARCH_TERMS) : pick([`PF-${1 + Math.floor(Math.random() * 5000)}`, `Perf Venue ${1 + Math.floor(Math.random() * 19)}`]))}&limit=20`, 0.5],
  ['GET /shifts/:id', `/shifts/${pick(refData.shiftIds)}`, 1],
  ['GET /attendance/report/shifts', `/attendance/report/shifts?bucket=${pick(['current', 'history'])}&page=1&limit=20`, 1],
];

async function staffReadOnce(at) {
  const s = pick(readers);
  const [name, path] = nextStaffRead();
  await staffCall(s, 'staff-read', name, 'GET', path, undefined, at);
}
async function clockFlowOnce(at) {
  const now = Date.now();
  const b = live.find((x) => !x.used && x.startsMs - 15 * 60_000 <= now && now <= x.endsMs + 110 * 60_000);
  if (!b) {
    counters.skippedNoBooking++;
    return;
  }
  b.used = true;
  const s = staffSessions.get(b.email);
  if (!s) return;
  const qr = shiftQr(b.shiftId, b.venueId, b.qrVersion);
  await staffCall(s, 'clock', 'GET /attendance/me/active', 'GET', '/attendance/me/active', undefined, at);
  await staffCall(s, 'clock', 'POST /attendance/check-in', 'POST', '/attendance/check-in', { shiftId: b.shiftId, qrToken: qr }, Date.now());
  await sleep(1000 + Math.random() * 2000);
  const ci = await staffCall(s, 'clock', 'POST /attendance/clock-in', 'POST', '/attendance/clock-in', { shiftId: b.shiftId, qrToken: qr }, Date.now());
  if (ci.status !== 200 && ci.status !== 201) return;
  const outAt = Date.now() + 120_000 + Math.random() * 180_000;
  setTimeout(() => {
    if (phaseIdx < 0 || phaseIdx >= PHASES.length) {
      counters.clockOutsNotDue++;
      return;
    }
    staffCall(s, 'clock', 'POST /attendance/clock-out', 'POST', '/attendance/clock-out', { qrToken: shiftQr(b.shiftId, b.venueId, b.qrVersion) }, outAt);
  }, outAt - Date.now());
}
async function offerRespondOnce(at) {
  const o = offers.find((x) => !x.used && staffSessions.has(x.email));
  if (!o) {
    counters.skippedNoOffer++;
    return;
  }
  o.used = true;
  const s = staffSessions.get(o.email);
  if (Math.random() < 0.8) {
    const r = await staffCall(s, 'offer', 'POST /offers/:id/accept', 'POST', `/offers/${o.offerId}/accept`, {}, at);
    if (r.status >= 200 && r.status < 300) toConfirm.push(o.offerId);
  } else {
    await staffCall(s, 'offer', 'POST /offers/:id/decline', 'POST', `/offers/${o.offerId}/decline`, { reason: 'Not available (load test)' }, at);
  }
}
async function managerReadOnce(at) {
  const [name, path] = weighted(MANAGER_READS())();
  await webCall(pick(managers), 'manager-read', name, 'GET', path, undefined, at);
}
async function createAndSendOnce(at) {
  const start = Date.now() + (10 + Math.floor(Math.random() * 20)) * 86400_000 + Math.floor(Math.random() * 24) * 3600_000;
  const startsAt = new Date(Math.floor(start / 900_000) * 900_000);
  const staffProfileIds = Array.from({ length: 3 }, () => pick(refData.staffIds)).filter((v, i, a) => a.indexOf(v) === i);
  await webCall(pick(managers), 'manager-write', 'POST /shifts/with-offers', 'POST', '/shifts/with-offers', {
    venueId: pick(refData.venueIds), jobRoleId: refData.jobRoleId, startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 6 * 3600_000).toISOString(),
    requiredCount: 1, notes: 'load test', staffProfileIds, expiresInHours: 48,
  }, at);
}
async function offerConfirmOnce(at) {
  const id = toConfirm.shift();
  if (!id) {
    counters.skippedNoConfirm++;
    return;
  }
  await webCall(pick(managers), 'manager-write', 'POST /offers/:id/confirm', 'POST', `/offers/${id}/confirm`, {}, at);
}
async function vmReadOnce(at) {
  const [name, path] = pick([
    ['GET /attendance/report/shifts (VM app)', `/attendance/report/shifts?bucket=${pick(['current', 'history'])}&page=1&limit=20`],
    ['GET /shifts/sent (VM app)', '/shifts/sent?view=all&page=1&limit=20'],
    ['GET /staff/venue-directory (VM app)', '/staff/venue-directory?limit=30&page=1'],
  ]);
  await webCall(vm, 'vm-read', name, 'GET', path, undefined, at);
}
async function payrollReadOnce(at) {
  const [name, path] = pick([
    ['GET /payroll/runs', '/payroll/runs'],
    ['GET /payroll/records (pending)', '/payroll/records?status=pending_approval&limit=50'],
    ['GET /payroll/period', `/payroll/period?month=${refData.month}`],
  ]);
  await webCall(pick(managers), 'payroll', name, 'GET', path, undefined, at);
}
async function loginOnce(at) {
  const n = 4001 + (loginCursor++ % 1000);
  await staffLogin(`perf${n}@perf-lanef.test`, 'login', at);
}
async function payrollRun() {
  const m = managers[0];
  if (!refData.periodId) return;
  const prep = await webCall(m, 'payroll-run', 'POST /payroll/runs/prepare', 'POST', '/payroll/runs/prepare', { periodId: refData.periodId }, Date.now());
  const runId = prep.json?.id ?? prep.json?.run?.id;
  if (runId) {
    await webCall(m, 'payroll-run', 'GET /payroll/runs/:id', 'GET', `/payroll/runs/${runId}`, undefined, Date.now());
    await webCall(m, 'payroll-run', 'GET /payroll/runs/:id/export', 'GET', `/payroll/runs/${runId}/export`, undefined, Date.now());
  }
  for (let i = 0; i < 2; i++) {
    const list = await webCall(m, 'payroll-run', 'GET /payroll/records (pending, 50)', 'GET', '/payroll/records?status=pending_approval&limit=50', undefined, Date.now());
    const ids = (list.json?.data ?? []).map((r) => r.id);
    if (ids.length) await webCall(m, 'payroll-run', 'POST /payroll/records/bulk-approve (50)', 'POST', '/payroll/records/bulk-approve', { ids }, Date.now());
  }
}

// ------------------------------------------------------------------------------------------------ resource sampler
const resources = [];
let lastCpu = {};
const procCpu = (pid) => {
  try {
    const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return (Number(f[11]) + Number(f[12])) / 100; // utime + stime, seconds (USER_HZ 100)
  } catch {
    return null;
  }
};
const sh = (cmd, a) => new Promise((resolve) => execFile(cmd, a, { timeout: 4000 }, (err, out) => resolve(err ? '' : out.trim())));
async function sampleOnce() {
  const row = { t: Math.round((Date.now() - T0) / 1000), phase: PHASES[phaseIdx]?.name ?? 'prep', inFlight };
  for (const [k, pid] of [['api', process.env.PERF_API_PID], ['worker', process.env.PERF_WORKER_PID]]) {
    if (!pid) continue;
    const cpu = procCpu(pid);
    if (cpu != null && lastCpu[k]) row[`${k}CpuPct`] = Math.round(((cpu - lastCpu[k].cpu) / ((Date.now() - lastCpu[k].at) / 1000)) * 100);
    if (cpu != null) lastCpu[k] = { cpu, at: Date.now() };
  }
  const pgc = process.env.PERF_PG_CONTAINER;
  if (pgc) {
    const st = await sh('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}}|{{.MemUsage}}', pgc]);
    if (st) {
      const [cpu, mem] = st.split('|');
      row.dbCpuPct = Number(cpu.replace('%', ''));
      row.dbMem = mem.split(' / ')[0];
    }
    const act = await sh('docker', ['exec', '-u', 'postgres', pgc, 'sh', '-c',
      `PGPASSWORD="$(cat /run/lanef/su)" psql -X -At -h /var/run/postgresql -U lanef_admin -d crewflow -c "select count(*), count(*) filter (where state = 'active'), count(*) filter (where wait_event_type = 'Lock') from pg_stat_activity where datname = current_database() and backend_type = 'client backend'"`]);
    if (act) {
      const [total, active, lockWait] = act.split('|').map(Number);
      Object.assign(row, { dbConns: total, dbActive: active, dbLockWait: lockWait });
    }
  }
  resources.push(row);
}

// ------------------------------------------------------------------------------------------------ main
async function prepare() {
  console.log(`[load-mix] preparing: ${MANAGER_SESSIONS} console sessions, ${live.length} bookings, ${offers.length} pending offers`);
  for (let i = 0; i < MANAGER_SESSIONS; i++) managers.push(await webLogin(MANAGER_EMAIL));
  if (VM_EMAIL) vm = await webLogin(VM_EMAIL, 'venue_manager_app');
  const m = managers[0];
  const shifts = await request('GET', '/shifts?limit=200', { ip: m.ip, origin: ORIGIN, cookie: m.cookie });
  refData.shiftIds = (shifts.json?.data ?? []).map((x) => x.id);
  refData.venueIds = [...new Set((shifts.json?.data ?? []).map((x) => x.venueId))];
  refData.jobRoleId = shifts.json?.data?.[0]?.jobRoleId;
  for (let page = 60; page < 66; page++) {
    const st = await request('GET', `/staff?limit=50&page=${page}`, { ip: m.ip, origin: ORIGIN, cookie: m.cookie });
    refData.staffIds.push(...(st.json?.data ?? []).map((x) => x.id));
  }
  // The payroll calendar comes from the seed (importing it is Initial-Manager-only): the run uses the latest period that
  // ended more than 14 days ago, so its approved records exist.
  const now = new Date();
  const d = (ms) => new Date(ms).toISOString().slice(0, 10);
  refData.month = d(now.getTime()).slice(0, 7);
  const cal2 = await request('GET', '/payroll/calendar', { ip: m.ip, origin: ORIGIN, cookie: m.cookie });
  const periods = (cal2.json?.calendars ?? []).flatMap((c) => c.periods ?? []).sort((a, b) => String(b.end ?? b.periodEnd).localeCompare(String(a.end ?? a.periodEnd)));
  refData.periodId = periods.find((p) => String(p.end ?? p.periodEnd) < d(now.getTime() - 14 * 86400_000))?.id ?? periods[0]?.id ?? null;
  console.log(`[load-mix] ref data: ${refData.venueIds.length} venues, ${refData.staffIds.length} staff ids, payroll period ${refData.periodId ? 'found' : 'MISSING'}`);
  // Staff sessions: every booking and offer holder (they must act as themselves), concurrency 6 (argon2 is the cost).
  const emails = [...new Set([...live.map((b) => b.email), ...offers.map((o) => o.email)])];
  let i = 0;
  let failed = 0;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (;;) {
      const k = i++;
      if (k >= emails.length) return;
      if (!(await staffLogin(emails[k]))) failed++;
    }
  }));
  readers = [...staffSessions.values()].slice(0, STAFF_READER_POOL);
  console.log(`[load-mix] ${staffSessions.size} staff sessions in ${Math.round((Date.now() - t0) / 1000)} s (${failed} failed logins)`);
  samples.length = 0; // preparation is not part of the measurement
}

function schedule(rate, fn, endAt) {
  // Deterministic pacing with a per-phase multiplier; ticks every 50 ms.
  let acc = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    if (now >= endAt || phaseIdx < 0) return;
    acc += ((now - last) / 1000) * rate * PHASES[phaseIdx].mult;
    last = now;
    while (acc >= 1) {
      acc -= 1;
      fn(now).catch((e) => errorsSample.length < 400 && errorsSample.push({ fatal: String(e) }));
    }
  }, 50);
  return timer;
}

function pct(sorted, p) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null;
}
function summarise(filter) {
  const rows = samples.filter(filter);
  const groups = {};
  for (const [phase, group, endpoint, status, ms] of rows) {
    for (const key of [`${group}`, `${group} | ${endpoint}`]) {
      const g = (groups[key] ??= { n: 0, errors: 0, conflicts: 0, other4xx: 0, ms: [], statuses: {} });
      g.n++;
      g.statuses[status] = (g.statuses[status] ?? 0) + 1;
      if (status < 0 || status >= 500) g.errors++;
      else if (status === 409) g.conflicts++;
      else if (status >= 400) g.other4xx++;
      g.ms.push(ms);
    }
  }
  return Object.fromEntries(Object.entries(groups).sort().map(([k, g]) => {
    const s = g.ms.sort((a, b) => a - b);
    return [k, { n: g.n, p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), max: s.at(-1), errors: g.errors, errorRatePct: Math.round((g.errors / g.n) * 10000) / 100, conflicts409: g.conflicts, other4xx: g.other4xx, statuses: g.statuses }];
  }));
}

async function main() {
  await prepare();
  const start = Date.now();
  const total = PHASES.reduce((a, p) => a + p.secs, 0);
  const endAt = start + total * 1000;
  const sampler = setInterval(() => sampleOnce().catch(() => {}), 5000);
  const timers = [
    schedule(RATES.staffRead, staffReadOnce, endAt),
    schedule(RATES.clockFlow, clockFlowOnce, endAt),
    schedule(RATES.offerRespond, offerRespondOnce, endAt),
    schedule(RATES.managerRead, managerReadOnce, endAt),
    schedule(RATES.createAndSend, createAndSendOnce, endAt),
    schedule(RATES.offerConfirm, offerConfirmOnce, endAt),
    schedule(RATES.vmRead, vmReadOnce, endAt),
    schedule(RATES.payrollRead, payrollReadOnce, endAt),
    schedule(RATES.login, loginOnce, endAt),
  ];
  let ranPayroll = false;
  let elapsed = 0;
  for (const [i, p] of PHASES.entries()) {
    phaseIdx = i;
    console.log(`[load-mix] phase ${p.name}: ${p.secs} s at ${p.mult}x`);
    const phaseEnd = Date.now() + p.secs * 1000;
    while (Date.now() < phaseEnd) {
      if (!ranPayroll && Date.now() - start >= PAYROLL_RUN_AT_S * 1000) {
        ranPayroll = true;
        payrollRun().catch((e) => errorsSample.push({ fatal: `payroll run: ${e}` }));
      }
      await sleep(250);
    }
    elapsed += p.secs;
    const s = summarise((r) => r[0] === p.name);
    const top = Object.entries(s).filter(([k]) => !k.includes('|'));
    for (const [k, v] of top) console.log(`  ${k.padEnd(14)} n=${v.n} p50=${v.p50} p95=${v.p95} p99=${v.p99} max=${v.max} 5xx/net=${v.errors} 409=${v.conflicts409} 4xx=${v.other4xx}`);
  }
  phaseIdx = PHASES.length; // stop scheduling
  for (const t of timers) clearInterval(t);
  await sleep(5000);
  clearInterval(sampler);
  const out = {
    at: new Date(start).toISOString(),
    api: API.origin,
    phases: PHASES,
    rates: RATES,
    counters,
    work: { liveBookings: live.length, used: live.filter((b) => b.used).length, pendingOffers: offers.length, offersUsed: offers.filter((o) => o.used).length },
    perPhase: Object.fromEntries(PHASES.map((p) => [p.name, summarise((r) => r[0] === p.name)])),
    peakAndSpike: summarise((r) => r[0] === 'peak' || r[0] === 'spike'),
    whole: summarise(() => true),
    timeline: Object.values(samples.reduce((acc, r) => {
      const b = Math.floor(r[6] / 30) * 30;
      const x = (acc[b] ??= { t: b, n: 0, ms: [], errors: 0 });
      x.n++;
      x.ms.push(r[4]);
      if (r[3] < 0 || r[3] >= 500) x.errors++;
      return acc;
    }, {})).map((x) => ({ t: x.t, rps: Math.round((x.n / 30) * 10) / 10, p95: pct(x.ms.sort((a, b) => a - b), 95), errors: x.errors })),
    resources,
    errorsSample,
  };
  writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`[load-mix] wrote ${outFile}; counters ${JSON.stringify(counters)}`);
  process.exit(0);
}
main().catch((e) => {
  console.error('[load-mix] failed:', e);
  process.exit(1);
});
