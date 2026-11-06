// D-Q6 realistic journeys: K6P_ORGS active organisations x PROFILE.perOrg people, each VU one person (journeys.js).
// Started by lib/k6-run.js inside the pinned grafana/k6 image on crewflow-cost-net; never run by hand against anything
// else (the target host is fixed and checked).
//
// Timeline: setup() logs every account in (argon2, before the window), prints K6P_SETUP_DONE t0=<epoch ms>, then all VUs
// start; each VU's first session starts after a seeded 0-K6P_SPREAD_S s pause. The resource window of measure.sh is
// [t0 + K6P_WARM_S, t0 + K6P_WARM_S + K6P_WIN_S); every request carries win=in|out and half=a|b (first/second half of
// the window), and only win=in requests are reported. handleSummary prints ONE line `K6P_RESULT {json}`.
import http from 'k6/http';
import exec from 'k6/execution';
import { env, envNum, seedVu, think, SUMMARY_TREND_STATS, SYSTEM_TAGS } from './lib.js';
import { PROFILE } from './profile.js';
import { PERSONA_RUN, setWindowStart } from './journeys.js';

const BASE = env('BASE_URL', 'http://costaudit-api:3000');
if (BASE !== 'http://costaudit-api:3000') throw new Error('BASE_URL must be the disposable harness API http://costaudit-api:3000');
const ORGS = envNum('K6P_ORGS', 8);
const ORG_FROM = envNum('K6P_ORG_FROM', 1);
const WARM_S = envNum('K6P_WARM_S', 60);
const WIN_S = envNum('K6P_WIN_S', 240);
const TAIL_S = envNum('K6P_TAIL_S', 20);
const SPREAD_S = envNum('K6P_SPREAD_S', 30);
// Access tokens live 15 min (environment-variables.ts, keyring note) and setup logs in once: the run must end before.
if (WARM_S + WIN_S + TAIL_S > 780) throw new Error('K6P_WARM_S + K6P_WIN_S + K6P_TAIL_S must stay under 13 min (15-min access tokens)');

const p2 = (n) => String(n).padStart(2, '0');
const ACCOUNTS = [];
for (let o = ORG_FROM; o < ORG_FROM + ORGS; o++) {
  const dom = `org${p2(o)}.example.test`; // harness seed (seed/seed.js): synthetic organisations only
  for (let i = 1; i <= PROFILE.perOrg.im; i++) ACCOUNTS.push({ persona: 'im', email: `manager${i}@${dom}` });
  for (let i = 1; i <= PROFILE.perOrg.vm; i++) ACCOUNTS.push({ persona: 'vm', email: `venuemanager${i}@${dom}` });
  for (let i = 1; i <= PROFILE.perOrg.staff; i++) ACCOUNTS.push({ persona: 'staff', email: `staff${p2(i)}@${dom}` });
}
const VUS = ACCOUNTS.length;

// Every request name and journey the journeys use: each gets win=in sub-metrics (k6 reports a tag combination only when
// a threshold names it; these thresholds always pass).
export const JOURNEYS = ['staff:start', 'staff:poll', 'staff:accept', 'staff:history', 'staff:payroll-read', 'vm:start', 'vm:poll', 'vm:request',
  'vm:sent-detail', 'vm:attendance-read', 'im:start', 'im:poll', 'im:approvals', 'im:approve', 'im:confirmations', 'im:confirm', 'im:venue-offers',
  'im:pipeline', 'im:send-offer', 'im:calendar', 'im:payroll-read'];
export const ENDPOINTS = ['GET /offers/mine?scope=all', 'GET /offers/mine?scope=current', 'GET /attendance/me/active', 'GET /notifications/unread-count',
  'GET /realtime/stream', 'POST /offers/:id/accept', 'GET /attendance/me/history', 'GET /payroll/me/payslips', 'GET /payroll/me/statements',
  'GET /auth/capabilities', 'GET /shifts (all pages)', 'GET /venues (all pages)', 'GET /job-roles (all pages)', 'GET /offers (all pages)',
  'GET /shifts/sent (all pages)', 'GET /staff/venue-directory?limit=1', 'GET /attendance/report/shifts?limit=1', 'GET /staff/venue-directory',
  'POST /shifts/request', 'GET /shifts/sent/:id', 'GET /attendance/report/shifts', 'GET /attendance/report/shift/:id', 'GET /shifts/sent?limit=50',
  'GET /auth/me', 'GET /dashboard/summary', 'GET /profile', 'GET /offers?status&limit=1', 'GET /shifts?range&limit=1', 'GET /attendance?7d',
  'GET /shifts?range&limit=200', 'GET /venues', 'GET /shifts?next14d&limit=25', 'GET /offers?sort=sentAt&limit=6', 'GET /shifts/requests/pending',
  'GET /shifts/:id', 'GET /shifts/:id/requested-staff', 'POST /shifts/:id/approve', 'GET /offers?status=staff_accepted', 'POST /offers/:id/confirm',
  'GET /shifts/requests', 'GET /shifts/:id/pipeline', 'GET /staff', 'POST /shifts/:id/offers', 'GET /shifts?range (all pages)',
  'GET /offers?status=manager_confirmed&day (all pages)', 'GET /job-roles', 'GET /payroll/period', 'GET /payroll/runs', 'GET /payroll/calendar'];
const PERSONAS = ['staff', 'vm', 'im'];

const thresholds = {};
const noop = (m, tags, t) => { thresholds[`${m}{${tags}}`] = [t]; };
for (const tags of ['win:in', 'win:in,half:a', 'win:in,half:b', ...JOURNEYS.map((j) => `journey:${j},win:in`), ...ENDPOINTS.map((n) => `name:${n},win:in`), ...PERSONAS.map((p) => `persona:${p},win:in`)]) {
  noop('http_req_duration', tags, 'max>=0');
  noop('http_req_failed', tags, 'rate>=0');
  noop('http_reqs', tags, 'count>=0');
}
noop('checks', 'check:conflict', 'rate>=0');

export const options = {
  scenarios: { people: { executor: 'constant-vus', vus: VUS, duration: `${WARM_S + WIN_S + TAIL_S}s`, gracefulStop: '5s' } },
  setupTimeout: '300s',
  thresholds,
  summaryTrendStats: SUMMARY_TREND_STATS,
  systemTags: SYSTEM_TAGS,
  userAgent: 'crewflow-cost-k6p (disposable harness)',
  discardResponseBodies: false,
  noConnectionReuse: false,
};

let loginSeq = 0;
function login(a) {
  const mobile = a.persona !== 'im';
  // Flutter sends no applicationTarget (auth_provider.dart); the web console sends manager_web (lib/lib.js loginWeb).
  const body = mobile ? { email: a.email, password: __ENV.SEED_PW } : { email: a.email, password: __ENV.SEED_PW, applicationTarget: 'manager_web' };
  const headers = { 'Content-Type': 'application/json', 'cf-connecting-ip': `192.0.2.${(++loginSeq % 250) + 1}` };
  if (mobile) headers['x-client-platform'] = 'mobile'; else headers.Origin = 'http://127.0.0.1:5173';
  const res = http.post(`${BASE}/rest/v1/auth/login`, JSON.stringify(body), { headers, tags: { name: 'POST /auth/login (setup)', journey: 'setup', win: 'out', half: 'x', persona: a.persona } });
  if (res.status !== 200) throw new Error(`login ${a.email}: HTTP ${res.status}`); // never the body: it may echo input
  if (mobile) {
    const token = JSON.parse(res.body).accessToken;
    if (!token) throw new Error(`login ${a.email}: no accessToken`);
    return { bearer: token };
  }
  const cookie = Object.entries(res.cookies).map(([k, v]) => `${k}=${v[0].value}`).join('; ');
  if (!cookie) throw new Error(`login ${a.email}: no session cookie`);
  return { cookie };
}

export function setup() {
  if (!__ENV.SEED_PW) throw new Error('SEED_PW not set');
  const users = ACCOUNTS.map((a, i) => ({ ...a, ...login(a), ip: `198.18.${Math.floor(i / 250)}.${(i % 250) + 1}` }));
  const t0 = Date.now();
  console.log(`K6P_SETUP_DONE t0=${t0} vus=${VUS} orgs=${ORGS} warm=${WARM_S} win=${WIN_S} tail=${TAIL_S}`);
  return { t0, users };
}

const SEED = envNum('K6P_SEED', 20261106);
export default function (data) {
  const idx = exec.vu.idInTest - 1;
  const u = data.users[idx % data.users.length];
  if (exec.vu.iterationInScenario === 0) {
    setWindowStart(data.t0);
    seedVu(SEED, idx + 1);
    think(0, SPREAD_S); // so people who start together do not stay in lockstep
  }
  PERSONA_RUN[u.persona](u);
}

const r1 = (x) => (x == null || Number.isNaN(x) ? null : Math.round(x * 10) / 10);
function stat(m, tags) {
  const d = m[`http_req_duration{${tags}}`], f = m[`http_req_failed{${tags}}`], c = m[`http_reqs{${tags}}`];
  if (!c || !c.values.count) return { n: 0 };
  return { n: c.values.count, rps: r1(c.values.count / WIN_S), p50: r1(d.values.med), p95: r1(d.values['p(95)']), p99: r1(d.values['p(99)']), max: r1(d.values.max), errorRate: f ? f.values.rate : 0 };
}
export function handleSummary(data) {
  const m = data.metrics;
  const per = Object.fromEntries(PERSONAS.map((p) => {
    const s = stat(m, `persona:${p},win:in`);
    const n = ACCOUNTS.filter((a) => a.persona === p).length;
    return [p, { ...s, users: n, perUserRps: n && s.n ? Math.round((s.n / n / WIN_S) * 10000) / 10000 : null }];
  }));
  const conflict = m['checks{check:conflict}'];
  const out = {
    meta: { k6: 'grafana/k6 (pinned digest, see lib/k6-run.js)', vus: VUS, orgs: ORGS, orgFrom: ORG_FROM, warmS: WARM_S, winS: WIN_S, tailS: TAIL_S, spreadS: SPREAD_S, seed: SEED, profile: PROFILE },
    overall: stat(m, 'win:in'),
    halves: { a: stat(m, 'win:in,half:a'), b: stat(m, 'win:in,half:b') },
    personas: per,
    journeys: Object.fromEntries(JOURNEYS.map((j) => [j, stat(m, `journey:${j},win:in`)])),
    endpoints: Object.fromEntries(ENDPOINTS.map((n) => [n, stat(m, `name:${n},win:in`)])),
    conflicts409: conflict ? conflict.values.passes : 0,
    checks: m.checks ? { passes: m.checks.values.passes, fails: m.checks.values.fails } : null,
    iterations: m.iterations ? m.iterations.values.count : 0,
    dataReceivedBytes: m.data_received ? m.data_received.values.count : null,
  };
  return { stdout: `K6P_RESULT ${JSON.stringify(out)}\n` };
}
