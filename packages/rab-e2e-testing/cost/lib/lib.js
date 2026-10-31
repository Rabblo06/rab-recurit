// Shared host-side helpers for the cost harness (Node >= 22: global fetch/FormData/Blob). Ported from the 2026-10-26
// audit harness; differences: no hard-coded paths (COST_SECRETS / COST_OUT / COST_API_PORT), psql runs INSIDE the
// disposable Postgres container (never a host client, never another database), and secrets are never printed.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const SECRETS_FILE = process.env.COST_SECRETS || 'C:/rab-ai-wt/cost-secrets/cost.env';
const secrets = Object.fromEntries(
  fs.readFileSync(SECRETS_FILE, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const BASE = process.env.API_BASE || `http://127.0.0.1:${process.env.COST_API_PORT || 23070}`;
const OUT = process.env.COST_OUT || path.join(process.cwd(), 'results');
fs.mkdirSync(OUT, { recursive: true });
const ORIGIN = 'http://127.0.0.1:5173';
const dockerEnv = { ...process.env, MSYS_NO_PATHCONV: '1' };

// Distinct client IP per request (the API trusts cf-connecting-ip from the cost network only), so the per-IP throttles
// are not what is measured. Deterministic sequence.
let ipCounter = 4096;
const nextIp = () => { ipCounter++; return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${(ipCounter & 255) || 1}`; };

async function loginWeb(email) {
  const res = await fetch(`${BASE}/rest/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': nextIp(), origin: ORIGIN },
    body: JSON.stringify({ email, password: secrets.SEED_PW, applicationTarget: 'manager_web' }),
  });
  if (res.status !== 200) throw new Error(`web login ${email}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]);
  return { cookie: cookies.join('; ') };
}

async function loginMobile(email) {
  const res = await fetch(`${BASE}/rest/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': nextIp(), 'x-client-platform': 'mobile' },
    body: JSON.stringify({ email, password: secrets.SEED_PW, applicationTarget: 'staff_app' }),
  });
  if (res.status !== 200) throw new Error(`mobile login ${email}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  return { bearer: j.accessToken, refresh: j.refreshToken };
}

function authHeaders(auth) {
  if (auth.cookie) return { cookie: auth.cookie, origin: ORIGIN };
  if (auth.bearer) return { authorization: `Bearer ${auth.bearer}`, 'x-client-platform': 'mobile' };
  return {};
}

async function call(auth, method, url, body, extraHeaders = {}) {
  const headers = { ...authHeaders(auth), 'cf-connecting-ip': nextIp(), ...extraHeaders };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const t = performance.now();
  const res = await fetch(`${BASE}${url}`, { method, headers, body: payload });
  const buf = Buffer.from(await res.arrayBuffer());
  const ms = performance.now() - t;
  return { status: res.status, ms, bytes: buf.length, requestId: res.headers.get('x-request-id'), body: buf, contentEncoding: res.headers.get('content-encoding') };
}

/** Parses the API container's `request_complete` log blocks (Nest Logger util.inspect output) by requestId. */
function requestLog(container = 'costaudit-api', since) {
  const args = ['logs', container];
  if (since) args.push('--since', since);
  const text = execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'], env: dockerEnv }).replace(/\x1b\[[0-9;]*m/g, '');
  const map = new Map();
  for (const block of text.split("event: 'request_complete'").slice(1)) {
    const g = (k) => { const m = new RegExp(`${k}: '?([^,'\\n]+)'?`).exec(block); return m ? m[1] : null; };
    const stagesMatch = /stages: \{([\s\S]*?)\}/.exec(block);
    const stages = {};
    if (stagesMatch) for (const m of stagesMatch[1].matchAll(/(\w+): ([\d.]+)/g)) stages[m[1]] = +(+m[2]).toFixed(2);
    const id = g('requestId');
    if (id) map.set(id, { route: g('route'), status: Number(g('status')), durationMs: Number(g('durationMs')), sqlCount: Number(g('sqlCount')), transactionCount: Number(g('transactionCount')), stages });
  }
  return map;
}

/** Superuser SQL inside the disposable container (unix socket). Refuses unless the database carries the cost marker. */
let markerChecked = false;
function psql(sql) {
  const run = (s) => execFileSync('docker', ['exec', '-i', 'costaudit-pg', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'rab', '-d', 'rab', '-Atq'], { input: s, encoding: 'utf8', env: dockerEnv, maxBuffer: 1 << 28 }).replace(/\r/g, '').trim();
  if (!markerChecked) {
    const m = run(`select shobj_description(oid,'pg_database') from pg_database where datname=current_database()`);
    if (m !== 'crewflow-cost disposable measurement database') throw new Error('refusing: costaudit-pg is not the crewflow-cost disposable cluster');
    markerChecked = true;
  }
  return run(sql);
}

function redis(...args) {
  return execFileSync('docker', ['exec', 'costaudit-redis', 'redis-cli', ...args], { encoding: 'utf8', env: dockerEnv, maxBuffer: 1 << 28 }).replace(/\r/g, '').trim();
}
const redisInfo = (section) => Object.fromEntries(redis('INFO', ...(section ? [section] : [])).split('\n').filter((l) => l.includes(':')).map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1)]));

// Container guard (same rule as lib/guard.sh assert_harness_container): only a costaudit-* container that carries the
// compose project label crewflow-cost or the crewflow-cost.harness=true label may be paused/unpaused/stopped/started.
// An absent container passes the guard (docker then fails on its own). Never acts on the dev stack.
function assertHarnessContainer(name) {
  if (!/^costaudit-[A-Za-z0-9_.-]+$/.test(name)) throw new Error(`container guard: refusing to act on '${name}' (not a costaudit-* harness container)`);
  let labels;
  try {
    labels = JSON.parse(execFileSync('docker', ['container', 'inspect', '-f', '{{json .Config.Labels}}', name], { encoding: 'utf8', env: dockerEnv, stdio: ['ignore', 'pipe', 'ignore'] })) || {};
  } catch {
    return; // absent
  }
  if (labels['com.docker.compose.project'] === 'crewflow-cost' || labels['crewflow-cost.harness'] === 'true') return;
  throw new Error(`container guard: '${name}' is not harness-owned (no crewflow-cost project/harness label); refusing`);
}
function harnessDocker(verb, name, opts = {}) {
  if (!['pause', 'unpause', 'stop', 'start'].includes(verb)) throw new Error(`harnessDocker: verb '${verb}' not allowed`);
  assertHarnessContainer(name);
  return execFileSync('docker', [verb, name], { env: dockerEnv, ...opts });
}
const HARNESS_LABEL_ARGS = ['--label', 'crewflow-cost.harness=true'];

const cgroupUsec = (c) => Number(/usage_usec (\d+)/.exec(execFileSync('docker', ['exec', c, 'cat', '/sys/fs/cgroup/cpu.stat'], { encoding: 'utf8', env: dockerEnv }))[1]);
const cgroupMem = (c) => { try { return Number(execFileSync('docker', ['exec', c, 'cat', '/sys/fs/cgroup/memory.current'], { encoding: 'utf8', env: dockerEnv }).trim()); } catch { return null; } };

/** Uncompressible RGB PNG of roughly `targetBytes`, from a seeded stream (deterministic bytes). */
function noisePng(targetBytes, seed = 1) {
  const side = Math.ceil(Math.sqrt(targetBytes / 3));
  const rowLen = side * 3 + 1;
  const raw = Buffer.alloc(rowLen * side);
  let counter = 0;
  let block = Buffer.alloc(0);
  let off = 0;
  const nextByte = () => { if (off >= block.length) { block = crypto.createHash('sha256').update(`${seed}:${counter++}`).digest(); off = 0; } return block[off++]; };
  for (let y = 0; y < side; y++) { raw[y * rowLen] = 0; for (let x = 1; x < rowLen; x++) raw[y * rowLen + x] = nextByte(); }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(side, 0); ihdr.writeUInt32BE(side, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}

const pct = (arr, p) => { const a = [...arr].filter((x) => x != null && !Number.isNaN(x)).sort((x, y) => x - y); return a.length ? +a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))].toFixed(2) : null; };
const median = (a) => pct(a, 50);
const writeJson = (name, obj) => { fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj, null, 2)); return path.join(OUT, name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { BASE, OUT, secrets, dockerEnv, harnessDocker, assertHarnessContainer, HARNESS_LABEL_ARGS, loginWeb, loginMobile, call, requestLog, psql, redis, redisInfo, cgroupUsec, cgroupMem, noisePng, pct, median, nextIp, authHeaders, writeJson, sleep };
