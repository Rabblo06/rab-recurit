// Wave 6 lane E2E — latency of key endpoints on the DISPOSABLE stack (API 127.0.0.1:3300 only), with docker stats sampling.
//
//   node packages/rab-e2e-testing/system/perf/load.mjs <state.json> <out.json> <mode: light|load> [concurrency=8] [requests=300]
//
// light: sequential, no client-IP header — exactly what one browser behind the dev-like stack sees (per-IP throttles apply,
//        so it stays under 120 requests/min per route).
// load:  N concurrent virtual users, each request presenting its own client IP through CF-Connecting-IP. Only meaningful
//        when the API was started with TRUSTED_PROXY_CIDRS covering the Docker gateway (the perf phase does that).
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';

const [stateFile, outFile, mode = 'light', concArg = '8', reqArg = '300'] = process.argv.slice(2);
const state = JSON.parse(readFileSync(stateFile, 'utf8'));
const CONC = mode === 'light' ? 1 : Number(concArg);
const N = mode === 'light' ? Math.min(Number(reqArg), 60) : Number(reqArg);
const PASSWORD = process.env.E2E_SYNTHETIC_PASSWORD ?? 'W6-e2e-Synthetic-Pass-2026!';
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
let ipSeq = 1;
const nextIp = () => { const n = ipSeq++; return `10.${77 + ((n >> 16) & 7)}.${(n >> 8) & 255}.${n & 255}`; };

function request(method, path, { host, origin, cookie, bearer, body, mobile, ip } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers = { Host: host, Accept: 'application/json' };
  if (payload) headers['Content-Type'] = 'application/json';
  if (origin) headers.Origin = origin;
  if (cookie) headers.Cookie = cookie;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (mobile) headers['X-Client-Platform'] = 'mobile';
  if (ip) headers['CF-Connecting-IP'] = ip;
  const t0 = process.hrtime.bigint();
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: 3300, method, path, headers, agent, timeout: 60_000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, ms: Number(process.hrtime.bigint() - t0) / 1e6, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', (e) => resolve({ status: -1, ms: Number(process.hrtime.bigint() - t0) / 1e6, text: String(e) }));
    if (payload) r.write(payload);
    r.end();
  });
}

const A = state.A;
const hostA = `${A.label}.localhost:5300`;
const originA = `http://${hostA}`;

async function managerCookie() {
  const res = await request('POST', '/rest/v1/auth/login', { host: hostA, origin: originA, body: { email: A.imEmail, password: PASSWORD }, ip: mode === 'load' ? nextIp() : undefined });
  if (res.status !== 200) throw new Error(`manager login ${res.status} ${res.text.slice(0, 200)}`);
  return [].concat(res.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).join('; ');
}

function stats(samples) {
  const ok = samples.filter((s) => s.status >= 200 && s.status < 300).map((s) => s.ms).sort((a, b) => a - b);
  const pct = (p) => (ok.length ? ok[Math.min(ok.length - 1, Math.ceil((p / 100) * ok.length) - 1)] : null);
  const statuses = samples.reduce((a, s) => ({ ...a, [s.status]: (a[s.status] ?? 0) + 1 }), {});
  return { n: samples.length, ok: ok.length, statuses, p50: pct(50), p95: pct(95), p99: pct(99), max: ok.at(-1) ?? null, mean: ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null };
}

async function run(name, makeReq) {
  const samples = [];
  let i = 0;
  const t0 = Date.now();
  const workers = Array.from({ length: CONC }, async () => {
    for (;;) {
      const k = i++;
      if (k >= N) return;
      samples.push(await makeReq(k));
      if (mode === 'light') await new Promise((r) => setTimeout(r, 550)); // < 120/min per route
    }
  });
  await Promise.all(workers);
  const wall = Date.now() - t0;
  const s = { endpoint: name, mode, concurrency: CONC, ...stats(samples), wallMs: wall, rps: Math.round((samples.length / wall) * 1000 * 10) / 10 };
  const fmt = (v) => (v == null ? '-' : v.toFixed(1));
  console.log(`${name.padEnd(34)} n=${s.n} ok=${s.ok} p50=${fmt(s.p50)} p95=${fmt(s.p95)} p99=${fmt(s.p99)} max=${fmt(s.max)} rps=${s.rps} ${JSON.stringify(s.statuses)}`);
  return s;
}

// docker stats sampler (disposable containers only).
const containers = ['crewflow-e2e-server-1', 'crewflow-e2e-worker-1', 'crewflow-e2e-postgres-1', 'crewflow-e2e-redis-1'];
const mem = Object.fromEntries(containers.map((c) => [c, { memMiB: [], cpu: [] }]));
let sampling = true;
const toMiB = (s) => { const m = s.match(/([\d.]+)\s*([KMG]i?B)/); if (!m) return 0; const v = Number(m[1]); return m[2].startsWith('G') ? v * 1024 : m[2].startsWith('K') ? v / 1024 : v; };
async function sampler() {
  while (sampling) {
    await new Promise((resolve) => execFile('docker', ['stats', '--no-stream', '--format', '{{.Name}}|{{.MemUsage}}|{{.CPUPerc}}', ...containers], (err, out) => {
      if (!err) for (const line of out.trim().split('\n')) { const [n, m, c] = line.split('|'); if (mem[n]) { mem[n].memMiB.push(toMiB(m)); mem[n].cpu.push(Number(String(c).replace('%', ''))); } }
      resolve();
    }));
    await new Promise((r) => setTimeout(r, 1500));
  }
}

const samplerP = sampler();
const cookie = await managerCookie();
const auth = { host: hostA, origin: originA, cookie };
const seededShift = (await request('GET', '/rest/v1/shifts?limit=1&sort=startsAt&direction=asc', auth)).text.match(/"id":"([0-9a-f-]{36})"/)?.[1];
const seededStaff = (await request('GET', '/rest/v1/staff?limit=1&q=Perf', auth)).text.match(/"id":"([0-9a-f-]{36})"/)?.[1];
const runId = state.notes.perfRunId ?? A.payrollRunId;
const tag = A.label.replace(/[^a-z0-9]/g, '');
const ip = () => (mode === 'load' ? nextIp() : undefined);
const results = [];
results.push(await run('POST /auth/login (staff, mobile)', (k) => request('POST', '/rest/v1/auth/login', { host: '127.0.0.1:3300', mobile: true, body: { email: `perf${(k % 400) + 1}.${tag}@perf-e2e.test`, password: PASSWORD, applicationTarget: 'staff_app' }, ip: ip() })));
results.push(await run('GET /shifts (page 1, 50)', () => request('GET', '/rest/v1/shifts?limit=50', { ...auth, ip: ip() })));
results.push(await run('GET /shifts (date range, 50)', () => request('GET', `/rest/v1/shifts?limit=50&from=${encodeURIComponent(new Date(Date.now() - 60 * 86400_000).toISOString())}&to=${encodeURIComponent(new Date().toISOString())}`, { ...auth, ip: ip() })));
results.push(await run('GET /offers (page 1, 50)', () => request('GET', '/rest/v1/offers?limit=50', { ...auth, ip: ip() })));
results.push(await run('GET /staff (page 1, 50)', () => request('GET', '/rest/v1/staff?limit=50', { ...auth, ip: ip() })));
results.push(await run('GET /attendance (page 1, 50)', () => request('GET', '/rest/v1/attendance?limit=50', { ...auth, ip: ip() })));
results.push(await run('GET /search?q=perf', (k) => request('GET', `/rest/v1/search?q=${encodeURIComponent(['perf', 'Staff 12', `PF-${tag}-1`, 'Perf Venue'][k % 4])}&limit=20`, { ...auth, ip: ip() })));
if (seededShift) results.push(await run('GET /timeline/shifts/:id', () => request('GET', `/rest/v1/timeline/shifts/${seededShift}`, { ...auth, ip: ip() })));
if (seededStaff) results.push(await run('GET /timeline/staff/:id', () => request('GET', `/rest/v1/timeline/staff/${seededStaff}`, { ...auth, ip: ip() })));
if (runId) results.push(await run('GET /payroll/runs/:id', () => request('GET', `/rest/v1/payroll/runs/${runId}`, { ...auth, ip: ip() })));
results.push(await run('GET /dashboard/summary', () => request('GET', '/rest/v1/dashboard/summary', { ...auth, ip: ip() })));
sampling = false;
await samplerP;
const resources = Object.fromEntries(Object.entries(mem).map(([n, v]) => [n, {
  memMiBMax: Math.round(Math.max(0, ...v.memMiB)), memMiBAvg: Math.round(v.memMiB.reduce((a, b) => a + b, 0) / Math.max(1, v.memMiB.length)),
  cpuPctMax: Math.round(Math.max(0, ...v.cpu)), samples: v.memMiB.length,
}]));
console.log(JSON.stringify(resources));
writeFileSync(outFile, JSON.stringify({ mode, concurrency: CONC, requestsPerEndpoint: N, at: new Date().toISOString(), seededShift, seededStaff, runId, results, resources }, null, 2));
