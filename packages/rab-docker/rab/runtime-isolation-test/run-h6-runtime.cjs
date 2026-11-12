'use strict';
/**
 * H6 runtime-isolation matrix (Docker hardening H6). Runs the COMMITTED production compose file with a test override
 * (docker-compose.h6-runtime-test.yml: local images, development URLs, a throwaway PostgreSQL/MinIO/SMTP sink) in its own
 * disposable Compose project, and records each row of the H6.7 runtime regression matrix plus the container-security
 * matrix as PASS / FAIL / BLOCKED, with raw output in <evidence-dir>/NN-*.log and a summary in <evidence-dir>/SUMMARY.md.
 *
 *   H6_APP_IMAGE=<crewflow image> H6_WORKER_IMAGE=<crewflow image (O1: the same image)> \
 *     node packages/rab-docker/rab/runtime-isolation-test/run-h6-runtime.cjs <evidence-dir> [--compose <production file>]
 *     [--matrix-only] [--keep]
 *
 * --compose      the production compose file to test (default: the committed one). The "before" matrix passes the
 *                pre-H6 file (e.g. `git show e8d16623:packages/rab-docker/docker-compose.production.yml`).
 * --matrix-only  start the stack, record the container-security matrix (S1-S3) only, then stop.
 * --keep         leave the stack running at the end.
 *
 * Safety: project `crewflow-h6-runtime` only; no host port is published; no .env file is read (every credential is random
 * per run, passed as an H6_* variable and redacted from every evidence file); no Docker volume is created (every data
 * directory is a tmpfs); cleanup stops and removes this project's own containers BY EXACT NAME (never `down -v`, never a
 * prune). The project network is left in place (see the H6 report).
 *
 * O1 (one image): the Worker is ONE process (`node packages/rab-worker/dist/main.js`, uid 1000) under compose's init and
 * the image's tini, with no capability (CapBnd 0) and two jobs tmpfs mounts; the retired root launcher and its provisioner
 * child (uid 10001) are gone, and provisioning runs in-process. KNOWN GAP (pre-existing since #72, not changed by O1): the
 * database cases (M01 guard role, M12 escalation, M13) still expect the separated `crewflow_app` login; the runtime now
 * requires the owner login (crewflow_owner), so those rows need the owner-login rework before this harness passes again.
 */
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT = 'crewflow-h6-runtime';
const REPO = path.resolve(__dirname, '../../../..');
const PROJECT_DIR = path.join(REPO, 'packages/rab-docker');
const OVERRIDE = path.join(__dirname, 'docker-compose.h6-runtime-test.yml');
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const PROD = path.resolve(opt('--compose') || path.join(PROJECT_DIR, 'docker-compose.production.yml'));
const MATRIX_ONLY = argv.includes('--matrix-only');
const KEEP = argv.includes('--keep');
const OUT = path.resolve(argv[0] && !argv[0].startsWith('--') ? argv[0] : '');
if (!argv[0] || argv[0].startsWith('--')) {
  console.error('usage: run-h6-runtime.cjs <evidence-dir> [--compose <file>] [--matrix-only] [--keep]');
  process.exit(2);
}
for (const k of ['H6_APP_IMAGE', 'H6_WORKER_IMAGE']) {
  if (!process.env[k]) {
    console.error(`${k} must name a prebuilt local image`);
    process.exit(2);
  }
}
fs.mkdirSync(OUT, { recursive: true });

const hex = (n) => crypto.randomBytes(n).toString('hex');
const SECRETS = {
  H6_SUPERUSER_PASSWORD: hex(24),
  H6_CREWFLOW_PASSWORD: hex(24),
  H6_APP_PASSWORD: hex(24),
  H6_APP_SECRET: hex(48),
  H6_S3_ACCESS_KEY: `h6${hex(10)}`,
  H6_S3_SECRET_KEY: hex(24),
  H6_FIXTURE_PASSWORD: `Fx${hex(16)}`,
};
// The QA fixture is seeded with H6_SEED_IMAGE (default: the image under test). seed-qa on a branch without PR #38
// (fix/qa-seed-org-provisioning) fails organisation RLS; pass that branch's image for the FIXTURE step only.
const SEED_IMAGE = process.env.H6_SEED_IMAGE || process.env.H6_APP_IMAGE;
const MIGRATION_URL = `postgres://rab:${SECRETS.H6_SUPERUSER_PASSWORD}@pg:5432/rab`;
// Never inherit a developer DATABASE_URL / TEST_* / CREWFLOW_* / REDIS_URL into compose interpolation or the docker CLI.
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DATABASE_|TEST_|CREWFLOW_|REDIS_URL|DB_TARGET|PG_|COMPOSE_)/.test(k)));
const ENV = {
  ...BASE_ENV,
  ...SECRETS,
  H6_MIGRATION_URL: MIGRATION_URL,
  H6_BOOTSTRAP_CREWFLOW: SECRETS.H6_CREWFLOW_PASSWORD,
  H6_BOOTSTRAP_APP: SECRETS.H6_APP_PASSWORD,
  // The production file pulls <repo>@${CREWFLOW_IMAGE_TAG} since 2026-11-11 (it never builds). The override replaces the
  // image with H6_APP_IMAGE / H6_WORKER_IMAGE, but Compose interpolates the base first: a placeholder digest lets it render.
  CREWFLOW_IMAGE_TAG: `sha256:${'0'.repeat(64)}`,
  MSYS_NO_PATHCONV: '1',
};
const redact = (s) => Object.values(SECRETS).reduce((acc, v) => acc.split(v).join('<redacted>'), String(s ?? ''));

let currentLog = path.join(OUT, '00-setup.log');
const write = (text) => fs.appendFileSync(currentLog, `${redact(text)}\n`);

function docker(args, { input, timeout = 300_000, env = {}, quiet = false } = {}) {
  const res = spawnSync('docker', args, { env: { ...ENV, ...env }, encoding: 'utf8', input, timeout, maxBuffer: 64 * 1024 * 1024 });
  const raw = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const out = redact(raw);
  if (!quiet) write(`$ docker ${redact(args.join(' ')).slice(0, 400)}\n${out.trimEnd()}\n[exit ${res.status}]`);
  return { code: res.status, out, raw, stdout: redact(res.stdout ?? '') };
}
const composeFiles = ['-p', PROJECT, '--project-directory', PROJECT_DIR, '-f', PROD, '-f', OVERRIDE];
const compose = (args, opts) => docker(['compose', ...composeFiles, ...args], opts);
const psql = (sql, opts = {}) => compose(['exec', '-T', 'pg', 'psql', '-U', opts.user || 'rab', '-d', 'rab', '-v', 'ON_ERROR_STOP=1', '-qAt'], { input: sql, quiet: opts.quiet, timeout: opts.timeout ?? 60_000, env: opts.env });
const sql1 = (sql) => psql(sql, { quiet: true }).out.trim();
/** As the restricted runtime login over TCP (password auth), exactly as the API and the jobs child connect. */
const appSql = (sql) => compose(['exec', '-T', '-e', 'PGPASSWORD', 'pg', 'psql', '-h', '127.0.0.1', '-U', 'crewflow_app', '-d', 'rab', '-v', 'ON_ERROR_STOP=1', '-qAt'], { input: sql, quiet: true, env: { PGPASSWORD: SECRETS.H6_APP_PASSWORD } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label, predicate, timeoutMs, everyMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = predicate();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
    await sleep(everyMs);
  }
}

const results = [];
const measured = {};
// --only M09,M10,...: run just these cases after the always-needed setup (00, 10, M01, M02). Dependencies are the
// caller's job (M10 needs M09).
const ONLY = opt('--only') ? new Set(['00', '10', 'M01', 'M02', ...opt('--only').split(',').map((s) => s.trim())]) : null;
async function step(id, title, fn) {
  if (ONLY && !ONLY.has(id)) return;
  currentLog = path.join(OUT, `${id}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}.log`);
  fs.writeFileSync(currentLog, `# ${id} ${title}\n# ${new Date().toISOString()}\n`);
  const started = Date.now();
  let status = 'PASS';
  let note = '';
  try {
    const r = await fn();
    if (r && r.status) ({ status, note = '' } = r);
    else if (typeof r === 'string') note = r;
  } catch (e) {
    status = 'FAIL';
    note = redact(e.message);
  }
  write(`\n# RESULT: ${status}${note ? ` — ${note}` : ''} (${Math.round((Date.now() - started) / 1000)}s)`);
  results.push({ id, title, status, note, log: path.basename(currentLog) });
  console.log(`${status.padEnd(7)} ${id} ${title}${note ? ` — ${note}` : ''}`);
}
const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};

// ------------------------------------------------------------------------------------------------ helpers

/** Every container of one service (two with --scale), oldest first. */
function containerIds(service) {
  return compose(['ps', '-a', '-q', service], { quiet: true }).out.trim().split('\n').filter(Boolean);
}
const containerId = (service) => containerIds(service)[0];
function inspectId(id, format) {
  return id ? docker(['inspect', '-f', format, id], { quiet: true }).out.trim() : '';
}
const inspect = (service, format) => inspectId(containerId(service), format);
const healthOf = (service) => inspect(service, '{{if .State.Health}}{{.State.Health.Status}}{{end}}');
const restartsOf = (service) => Number(inspect(service, '{{.RestartCount}}') || 0);
const logsOf = (service, since) => compose(['logs', '--no-color', ...(since ? ['--since', since] : []), service], { quiet: true }).out;
/** `docker exec` into one container (by id) as `user`, with an EMPTY environment (never the container's own). */
function execIn(id, user, script, { env = {}, quiet = false, timeout = 120_000 } = {}) {
  const pass = Object.keys(env).flatMap((k) => ['-e', k]);
  const keep = Object.keys(env).map((k) => `${k}="$${k}"`).join(' ');
  return docker(['exec', '-u', user, ...pass, id, 'sh', '-c', `exec env -i PATH=/usr/local/bin:/usr/bin:/bin ${keep} sh -c '${script.replace(/'/g, `'"'"'`)}'`], { env, quiet, timeout });
}
const execAs = (service, user, script, opts) => execIn(containerId(service), user, script, opts);

function procTable(id) {
  const script = 'for p in /proc/[0-9]*; do u=$(awk \'/^Uid:/{print $2}\' $p/status 2>/dev/null) || continue; c=$(tr "\\0" " " < $p/cmdline 2>/dev/null); [ -n "$u" ] && echo "${p#/proc/}|$u|$c"; done';
  return execIn(id, '0:0', script, { quiet: true }).out.split('\n').filter((l) => /^\d+\|/.test(l)).map((l) => {
    const [pid, uid, ...cmd] = l.split('|');
    return { pid: Number(pid), uid: Number(uid), cmd: cmd.join('|').trim() };
  });
}
/** O1: the Worker container's processes: compose's init (PID 1), the image's tini, and the ONE Worker node process. */
const INIT_RE = /\b(docker-init|tini)\b/;
function workerPids(id) {
  const t = procTable(id);
  const find = (uid, re) => t.find((p) => p.uid === uid && re.test(p.cmd) && !INIT_RE.test(p.cmd))?.pid;
  return {
    table: t,
    tini: t.find((p) => /\btini\b/.test(p.cmd))?.pid,
    jobs: find(1000, /^\S*node packages\/rab-worker\/dist\/main\.js/),
    workers: t.filter((p) => /rab-worker\/dist\/main\.js/.test(p.cmd) && !INIT_RE.test(p.cmd)).length,
  };
}
const STATUS_KEYS = ['Uid', 'Gid', 'Groups', 'CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb', 'NoNewPrivs', 'Seccomp', 'Seccomp_filters'];
function procStatus(id, pids) {
  const r = execIn(id, '0:0', `for p in ${pids.join(' ')}; do echo "--- pid $p"; grep -E '^(${STATUS_KEYS.join('|')}):' /proc/$p/status; done`, { quiet: true });
  const out = {};
  for (const block of r.out.split('--- pid ').slice(1)) {
    const [head, ...lines] = block.split('\n');
    const rec = {};
    for (const l of lines) {
      const m = /^([A-Za-z_]+):\s*(.*)$/.exec(l);
      if (m) rec[m[1]] = m[2].trim().replace(/\s+/g, ' ');
    }
    out[`pid ${head.trim()}`] = rec;
  }
  return out;
}
function hostConfig(id) {
  return JSON.parse(inspectId(id, '{{json .HostConfig}}') || '{}');
}
/** Mount points of one container (from /proc/self/mounts) with their options. */
function mounts(id) {
  return execIn(id, '0:0', 'cat /proc/self/mounts', { quiet: true }).out.split('\n').filter(Boolean).map((l) => {
    const [src, target, type, options] = l.split(' ');
    return { src, target, type, options };
  });
}
/** Mount points `user` can create a file in (probe file removed again). Pseudo filesystems are skipped. */
function writableMounts(id, user) {
  // Mount points, plus the directories a runtime identity could own on the root filesystem itself (writable only when
  // the root is not read-only).
  const dirs = ['/', '/tmp', '/var/tmp', '/run', '/app', '/app/storage', '/home/node', '/opt', '/opt/crewflow-bundle', '/etc', '/nonexistent'];
  const targets = [...new Set([...mounts(id).filter((m) => !/^(proc|sysfs|cgroup2?|devpts|mqueue)$/.test(m.type) && !m.target.startsWith('/proc') && !m.target.startsWith('/sys')).map((m) => m.target), ...dirs])];
  const script = targets.map((t) => `f="${t.replace(/\/$/, '')}/.h6-write-probe-$$"; if ( : > "$f" ) 2>/dev/null; then echo "WRITABLE ${t}"; rm -f "$f"; fi`).join('\n');
  return execIn(id, user, script, { quiet: true }).out.split('\n').filter((l) => l.startsWith('WRITABLE ')).map((l) => l.slice(9)).sort();
}
function cgroupStats(id) {
  const r = execIn(id, '0:0', 'cd /sys/fs/cgroup && for f in memory.max memory.peak memory.current pids.max pids.peak pids.current cpu.max; do printf "%s=%s\\n" $f "$(cat $f 2>/dev/null)"; done', { quiet: true });
  return Object.fromEntries(r.out.split('\n').filter((l) => l.includes('=')).map((l) => l.split('=')));
}
const mib = (bytes) => (Number(bytes) / 1048576).toFixed(1);

function seedCreatingWorkspace(label) {
  const r = psql(`
DO $$
DECLARE o uuid; u uuid; r uuid; w uuid := gen_random_uuid();
BEGIN
  INSERT INTO core.organisation(name, slug) VALUES ('${label}', '${label}') RETURNING id INTO o;
  PERFORM set_config('rab.organisation_id', o::text, true);
  INSERT INTO core.role(organisation_id, key, name, is_system) VALUES (o, 'manager', 'Manager', true) RETURNING id INTO r;
  INSERT INTO core."user"(organisation_id, email, first_name, last_name, status) VALUES (o, '${label}@h6-runtime.invalid', 'H6', 'Owner', 'active') RETURNING id INTO u;
  INSERT INTO core.user_role(user_id, role_id, organisation_id) VALUES (u, r, o);
  PERFORM set_config('rab.user_id', u::text, true);
  INSERT INTO core.manager_workspace(id, organisation_id, owner_user_id, name, subdomain, status, schema_status) VALUES (w, o, u, '${label} Workspace', '${label}', 'active', 'CREATING');
  PERFORM set_config('rab.workspace_id', w::text, true);
  INSERT INTO core.manager_profile(organisation_id, user_id, type, workspace_id) VALUES (o, u, 'internal', w);
END $$;
SELECT id || '|' || organisation_id FROM core.manager_workspace WHERE subdomain = '${label}';`);
  assert(r.code === 0, `seeding ${label} failed`);
  const [id, organisationId] = r.out.trim().split('\n').pop().split('|');
  return { id, organisationId };
}
const wsStatus = (id) => sql1(`SELECT coalesce(mw.schema_status,'NULL') || '|' || coalesce(r.status,'-') FROM core.manager_workspace mw LEFT JOIN core.workspace_schema_registry r ON r.workspace_id = mw.id WHERE mw.id = '${id}'`);

/** One HTTP call from INSIDE the API container (node fetch, uid 1000, no redirect following). JSON result. */
function apiFetch(url, { method = 'GET', headers = {}, body } = {}) {
  const js = `fetch(process.env.U,{method:process.env.M,redirect:'manual',headers:JSON.parse(process.env.H),body:process.env.B||undefined}).then(async r=>{const b=Buffer.from(await r.arrayBuffer());console.log(JSON.stringify({status:r.status,location:r.headers.get('location'),type:r.headers.get('content-type'),len:b.length,sha256:require('crypto').createHash('sha256').update(b).digest('hex'),magic:b.subarray(0,5).toString('latin1'),text:/json|text|xml/.test(r.headers.get('content-type')||'')?b.toString('utf8').slice(0,4000):''}))},e=>{console.log(JSON.stringify({error:String(e.cause?.code||e.message)}))})`;
  // The script travels as an environment variable like the inputs: nothing is spliced into the shell command line.
  const env = { J: js, U: url, M: method, H: JSON.stringify(headers), B: body ?? '' };
  const r = execAs('rab-api', '1000:1000', 'node -e "$J"', { env, quiet: true });
  // Parse the RAW output: the redacted copy replaces the per-run S3 access key inside a presigned URL's X-Amz-Credential
  // with "<redacted>", which is exactly a URL the storage must refuse (H6 M10 root cause, harness defect). Callers write
  // only redacted text (write() redacts), so nothing unredacted reaches the evidence.
  const line = String(r.raw ?? '').trim().split('\n').pop();
  try {
    return JSON.parse(line);
  } catch {
    return { error: `unparsable: ${redact(line).slice(0, 200)}` };
  }
}
const mailCount = () => Number(compose(['exec', '-T', 'smtp', 'sh', '-c', 'ls /out | wc -l'], { quiet: true }).out.trim() || 0);

async function startShiftReport(minutesAhead) {
  const ids = sql1(`SELECT v.id || '|' || v.organisation_id || '|' || v.workspace_id || '|' || (SELECT id FROM core.job_role WHERE organisation_id = v.organisation_id LIMIT 1) || '|' || (SELECT id FROM core."user" WHERE email = 'manager.qa@example.test') FROM core.venue v WHERE v.name = 'ADOLPHUS QA Venue' LIMIT 1`).split('|');
  const [venueId, orgId, wsId, jobRoleId, managerId] = ids;
  const shiftId = sql1(`SELECT set_config('rab.organisation_id','${orgId}',false); INSERT INTO core.shift(organisation_id, workspace_id, venue_id, job_role_id, starts_at, ends_at, required_count, pay_rate_pence, status, created_by, published_at)
    VALUES ('${orgId}', '${wsId}', '${venueId}', '${jobRoleId}', now() + interval '${minutesAhead} minutes', now() + interval '4 hours', 1, 1200, 'open', '${managerId}', now()) RETURNING id;`).split('\n').pop();
  return { shiftId, orgId, wsId };
}
const reportState = (shiftId) => sql1(`SELECT status || '|' || (pre_shift_pdf_generated_at IS NOT NULL) FROM core.shift_report WHERE shift_id = '${shiftId}'`);

// ------------------------------------------------------------------------------------------------ security matrix

function securityMatrix(label) {
  const rows = [];
  const api = containerId('rab-api');
  const apiStatus = procStatus(api, [1]);
  const apiHc = hostConfig(api);
  rows.push({ container: 'rab-api', process: 'pid 1 (node main.js)', ...apiStatus['pid 1'] });
  const workers = containerIds('rab-worker');
  const w = workers[0];
  const p = workerPids(w);
  const wStatus = procStatus(w, [1, p.tini, p.jobs].filter(Boolean));
  rows.push({ container: 'rab-worker', process: 'pid 1 (init)', ...wStatus['pid 1'] });
  if (p.tini && p.tini !== 1) rows.push({ container: 'rab-worker', process: 'tini', ...wStatus[`pid ${p.tini}`] });
  rows.push({ container: 'rab-worker', process: 'jobs (node main.js)', ...wStatus[`pid ${p.jobs}`] });
  const wHc = hostConfig(w);
  const hc = (h) => ({
    ReadonlyRootfs: h.ReadonlyRootfs, Privileged: h.Privileged, CapDrop: h.CapDrop, CapAdd: h.CapAdd, SecurityOpt: h.SecurityOpt,
    PidsLimit: h.PidsLimit, MemoryMiB: h.Memory ? h.Memory / 1048576 : 0, NanoCpus: h.NanoCpus, Tmpfs: h.Tmpfs, Binds: h.Binds,
    PortBindings: h.PortBindings, NetworkMode: h.NetworkMode, PidMode: h.PidMode, IpcMode: h.IpcMode, Init: h.Init, RestartPolicy: h.RestartPolicy?.Name,
  });
  const writable = {
    'rab-api uid 1000': writableMounts(api, '1000:1000'),
    'rab-worker root (exec, container caps)': writableMounts(w, '0:0'),
    'rab-worker uid 1000 (jobs)': writableMounts(w, '1000:1000'),
  };
  const matrix = { label, processes: rows, hostConfig: { 'rab-api': hc(apiHc), 'rab-worker': hc(wHc) }, writable, users: { 'rab-api': inspectId(api, '{{.Config.User}}'), 'rab-worker': inspectId(w, '{{.Config.User}}') } };
  fs.writeFileSync(path.join(OUT, `security-matrix-${label}.json`), JSON.stringify(matrix, null, 2));
  const md = [`## Container-security matrix (${label})`, '', '| container | process | Uid | Groups | CapEff | CapBnd | CapAmb | NoNewPrivs | Seccomp filters |', '|---|---|---|---|---|---|---|---|---|'];
  for (const r of rows) md.push(`| ${r.container} | ${r.process} | ${(r.Uid || '').split(' ')[0]} | ${r.Groups || '-'} | ${r.CapEff} | ${r.CapBnd} | ${r.CapAmb} | ${r.NoNewPrivs} | ${r.Seccomp_filters ?? r.Seccomp} |`);
  md.push('', '| container | read-only root | CapDrop | CapAdd | SecurityOpt | PidsLimit | Memory MiB | CPUs | tmpfs |', '|---|---|---|---|---|---|---|---|---|');
  for (const [name, h] of Object.entries(matrix.hostConfig)) {
    md.push(`| ${name} | ${h.ReadonlyRootfs} | ${JSON.stringify(h.CapDrop)} | ${JSON.stringify(h.CapAdd)} | ${JSON.stringify(h.SecurityOpt)} | ${h.PidsLimit ?? 0} | ${h.MemoryMiB} | ${(h.NanoCpus || 0) / 1e9} | ${Object.keys(h.Tmpfs || {}).join(' ') || '-'} |`);
  }
  md.push('', '| identity | writable mount points |', '|---|---|');
  for (const [k, v] of Object.entries(writable)) md.push(`| ${k} | ${v.join(' ') || '(none)'} |`);
  fs.writeFileSync(path.join(OUT, `security-matrix-${label}.md`), `${md.join('\n')}\n`);
  write(md.join('\n'));
  return matrix;
}

// ------------------------------------------------------------------------------------------------ cleanup

function cleanup() {
  currentLog = path.join(OUT, '99-cleanup.log');
  compose(['--profile', '*', 'stop', '-t', '60'], { timeout: 600_000 });
  const names = compose(['--profile', '*', 'ps', '-a', '--format', '{{.Name}}'], { quiet: true }).out.split('\n').map((s) => s.trim()).filter((n) => n.startsWith(`${PROJECT}-`));
  if (names.length) docker(['rm', ...names]);
  write(`removed containers (exact names): ${names.join(' ') || '(none)'}; network ${PROJECT}_default left in place; no volume was created`);
}

// ------------------------------------------------------------------------------------------------ the run

// A stopped run must not leave the project's containers behind (the next run refuses to start next to them).
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    console.error(`received ${sig}: stopping this project's containers`);
    try { finish(); } finally { if (!KEEP) cleanup(); }
    process.exit(130);
  });
}

(async () => {
  write(`# H6 runtime matrix — project ${PROJECT}\n# production file: ${path.relative(REPO, PROD) || PROD}\n# override: ${path.relative(REPO, OVERRIDE)}`);
  write(`# fixture seed image: ${SEED_IMAGE}`);
  write(`# images: app=${process.env.H6_APP_IMAGE} ${docker(['image', 'inspect', '-f', '{{.Id}}', process.env.H6_APP_IMAGE], { quiet: true }).out.trim()} worker=${process.env.H6_WORKER_IMAGE} ${docker(['image', 'inspect', '-f', '{{.Id}}', process.env.H6_WORKER_IMAGE], { quiet: true }).out.trim()}`);
  const existing = compose(['--profile', '*', 'ps', '-a', '--format', '{{.Name}}'], { quiet: true }).out.trim();
  if (existing) {
    console.error(`project ${PROJECT} already has containers (${existing.replace(/\n/g, ' ')}); remove them first`);
    process.exit(2);
  }
  const fx = {};

  await step('00', 'The test override sets no runtime security key: the effective settings are the production file\'s', async () => {
    const keys = ['user', 'read_only', 'cap_drop', 'cap_add', 'security_opt', 'tmpfs', 'pids_limit', 'mem_limit', 'memswap_limit', 'cpus', 'stop_grace_period', 'privileged', 'healthcheck', 'restart', 'init', 'ipc', 'pid', 'network_mode', 'devices', 'shm_size', 'ulimits'];
    const dummy = { ...SECRETS, H6_MIGRATION_URL: 'x', CREWFLOW_SECRETS_DIR: '/nonexistent' };
    const render = (files) => JSON.parse(docker(['compose', '-p', `${PROJECT}-cfg`, '--project-directory', PROJECT_DIR, ...files.flatMap((f) => ['-f', f]), 'config', '--no-env-resolution', '--format', 'json'], { quiet: true, env: dummy }).stdout);
    const prodOnly = render([PROD]);
    const merged = render([PROD, OVERRIDE]);
    const diffs = [];
    for (const svc of ['rab-api', 'rab-worker']) {
      for (const k of keys) {
        const a = JSON.stringify(prodOnly.services[svc][k] ?? null);
        const b = JSON.stringify(merged.services[svc][k] ?? null);
        if (a !== b) diffs.push(`${svc}.${k}: production=${a} merged=${b}`);
      }
    }
    write(`compared ${keys.length} keys on rab-api and rab-worker\n${diffs.join('\n') || 'identical'}`);
    for (const svc of ['rab-api', 'rab-worker']) write(`${svc} (production file): ${JSON.stringify(Object.fromEntries(keys.filter((k) => prodOnly.services[svc][k] !== undefined).map((k) => [k, prodOnly.services[svc][k]])))}`);
    assert(diffs.length === 0, `override changes ${diffs.length} security key(s)`);
    return 'override changes none of the security keys';
  });

  await step('10', 'Disposable stack and guarded migrations (throwaway database only); QA fixture', async () => {
    assert(compose(['up', '-d', '--wait', '--no-build', 'pg', 'rab-redis', 'smtp', 'minio']).code === 0, 'infra did not start');
    const a = compose(['run', '--rm', '--no-deps', '-e', 'MIGRATION_URL', 'rab-migrate'], { env: { MIGRATION_URL: 'postgres://rab_owner:rab_owner_dev_only@pg:5432/rab' }, timeout: 600_000 });
    assert(/refuses to run as 'rab_owner'/.test(a.out), 'phase A did not stop at the role split');
    const b = compose(['run', '--rm', '--no-deps', 'rab-migrate'], { timeout: 600_000 });
    assert(b.code === 0 && /Migrations applied/.test(b.out), 'phase B failed');
    const roles = sql1(`SELECT string_agg(rolname || ':' || rolcanlogin || ':' || rolsuper || ':' || rolbypassrls, ' ' ORDER BY rolname) FROM pg_roles WHERE rolname IN ('crewflow','crewflow_app','rab_secure_owner')`);
    write(`roles: ${roles}`);
    assert(roles === 'crewflow:true:false:false crewflow_app:true:false:false rab_secure_owner:false:false:false', 'unexpected role posture');
    // Fixture (PR #38 seed-qa): a platform administrator through bootstrap-admin (the `crewflow` operator login), then
    // seed-qa --admin-email as crewflow_app. One-off containers on this project's network, read-only, no capabilities.
    const cli = (name, dbUrl, env, args) => docker(['run', '--rm', '--name', `${PROJECT}-${name}`, '--network', `${PROJECT}_default`, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '-e', 'NODE_ENV=development', '-e', 'RAB_RUNTIME_ENV=development', '-e', 'DB_TARGET=local', '-e', `DATABASE_URL=${dbUrl}`, '-e', 'REDIS_URL=redis://rab-redis:6379',
      '-e', `APP_SECRET=${SECRETS.H6_APP_SECRET}`, '-e', 'APP_URL=http://127.0.0.1:5173', '-e', 'ACCOUNTS_URL=http://127.0.0.1:5173', '-e', 'CORS_ORIGINS=http://127.0.0.1:5173',
      '-e', 'EMAIL_DRIVER=LOGGER', '-e', 'STORAGE_DRIVER=LOCAL', '-e', 'PUSH_ENABLED=false', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      '--entrypoint', 'node', SEED_IMAGE, 'packages/rab-server/dist/command/main.js', ...args], { timeout: 300_000 });
    const admin = 'platform-admin@h6-runtime.invalid';
    const boot = cli('bootstrap', `postgres://crewflow:${SECRETS.H6_CREWFLOW_PASSWORD}@pg:5432/rab`, { BOOTSTRAP_ADMIN_EMAIL: admin, BOOTSTRAP_ADMIN_ORG_SLUG: 'h6-platform' }, ['bootstrap-admin']);
    assert(boot.code === 0 && /Platform Admin bootstrapped/.test(boot.out), 'bootstrap-admin failed');
    const seed = cli('seed', `postgres://crewflow_app:${SECRETS.H6_APP_PASSWORD}@pg:5432/rab`, { SEED_QA_PASSWORD: SECRETS.H6_FIXTURE_PASSWORD }, ['seed-qa', '--admin-email', admin]);
    assert(/Seeded QA fixture/.test(seed.out), 'seed-qa fixture failed');
    fx.migrations = sql1('SELECT count(*) FROM core.migrations');
    fx.probe = seedCreatingWorkspace('h6-first');
    return `migrations=${fx.migrations}`;
  });

  await step('M01', 'API start under the production runtime keys (healthy, restricted role, no migration)', async () => {
    const t0 = Date.now();
    assert(compose(['up', '-d', '--wait', '--wait-timeout', '240', '--no-build', 'rab-api']).code === 0, 'rab-api not healthy');
    measured.apiStartToHealthyMs = Date.now() - t0;
    const logs = logsOf('rab-api');
    write(logs.split('\n').filter((l) => /api-prestart|runtime-db-guard|Nest application successfully started|EROFS|EACCES|read-only/i.test(l)).join('\n'));
    assert(/api-prestart: checking the schema is current/.test(logs), 'api-prestart did not run');
    assert(/\[runtime-db-guard\] process=api .* role=crewflow_app probe=read-only-ok/.test(logs), 'API guard line missing or wrong role');
    assert(!/EROFS|read-only file system/i.test(logs), 'the API hit the read-only filesystem');
    // H6: the API's own report of what the platform applied (api-prestart.sh from this branch).
    const iso = (/api-prestart: (runtime isolation as declared|WARNING runtime isolation weaker)[^\n]*/.exec(logs) || [''])[0];
    measured.apiIsolationLine = iso;
    if (!MATRIX_ONLY) assert(/runtime isolation as declared: uid=1000 CapBnd=0000000000000000 NoNewPrivs=1 root=read-only pids\.max=\d+ memory\.max=\d+/.test(iso), `API isolation line: ${iso || '(none)'}`);
    return `healthy in ${measured.apiStartToHealthyMs} ms (includes rab-migrate check run)`;
  });

  await step('M02', 'Worker start under the production runtime keys (one process, in-process provisioning)', async () => {
    const t0 = Date.now();
    assert(compose(['up', '-d', '--wait', '--wait-timeout', '300', '--no-build', 'rab-worker']).code === 0, 'rab-worker not healthy');
    measured.workerStartToHealthyMs = Date.now() - t0;
    const logs = logsOf('rab-worker');
    write(logs.split('\n').filter((l) => /worker-isolation\]|runtime-db-guard|rab-worker ready|workspace provisioning: in-process|EROFS|EACCES/.test(l)).join('\n'));
    assert(/workspace provisioning: in-process on the owner login/.test(logs), 'no in-process provisioning line');
    assert(/^rab-worker ready/m.test(logs), 'Worker not ready');
    assert(!/\[worker-bundle\]|start-worker-bundle/.test(logs), 'launcher output (the launcher is retired)');
    const iso = (/\[worker-isolation\] (runtime isolation as declared|WARNING runtime isolation weaker)[^\n]*/.exec(logs) || [''])[0];
    measured.workerIsolationLine = iso;
    if (!MATRIX_ONLY) assert(/runtime isolation as declared: uid=1000 CapBnd=0000000000000000 NoNewPrivs=1 root=read-only pids\.max=\d+ memory\.max=\d+/.test(iso), `Worker isolation line: ${iso || '(none)'}`);
    fx.workerPids = workerPids(containerId('rab-worker'));
    write(fx.workerPids.table.map((x) => `${x.pid} uid=${x.uid} ${x.cmd}`).join('\n'));
    assert(fx.workerPids.jobs && fx.workerPids.workers === 1, 'expected exactly one Worker process');
    return `healthy in ${measured.workerStartToHealthyMs} ms`;
  });

  await step('S1', 'Container-security matrix: identities, capabilities, no-new-privileges, host config, writable paths', async () => {
    const m = securityMatrix(MATRIX_ONLY ? 'before' : 'after');
    fx.matrix = m;
    if (MATRIX_ONLY) return 'recorded (matrix-only run)';
    const byProc = Object.fromEntries(m.processes.map((r) => [`${r.container}/${r.process.split(' ')[0]}`, r]));
    const zero = '0000000000000000';
    for (const k of ['rab-api/pid', 'rab-worker/pid', 'rab-worker/jobs']) {
      const r = byProc[k];
      for (const c of ['CapInh', 'CapPrm', 'CapEff', 'CapAmb']) assert(r[c] === zero, `${k} ${c}=${r[c]}`);
      assert(r.NoNewPrivs === '1', `${k} NoNewPrivs=${r.NoNewPrivs}`);
      // The only supplementary group allowed is the process's own primary GID (Docker adds it from the image's /etc/group
      // for `node`); never another group.
      const gid = (r.Gid || '').split(' ')[0];
      assert((r.Groups || '').split(' ').filter(Boolean).every((g) => g === gid), `${k} supplementary groups ${r.Groups}`);
    }
    assert(byProc['rab-api/pid'].CapBnd === zero, `rab-api CapBnd=${byProc['rab-api/pid'].CapBnd} (cap_drop ALL)`);
    assert(byProc['rab-api/pid'].Uid.split(' ').every((x) => x === '1000'), 'rab-api not uid 1000');
    // O1: no root process and no capability anywhere in the Worker container (no identity switch any more).
    for (const k of ['rab-worker/pid', 'rab-worker/jobs']) {
      assert(byProc[k].CapBnd === zero, `${k} CapBnd=${byProc[k].CapBnd} (cap_drop ALL, no cap_add)`);
      assert(byProc[k].Uid.split(' ').every((x) => x === '1000'), `${k} not uid 1000`);
    }
    for (const [name, h] of Object.entries(m.hostConfig)) {
      assert(h.ReadonlyRootfs === true && h.Privileged === false, `${name} read-only/privileged`);
      assert(JSON.stringify(h.CapDrop) === '["ALL"]', `${name} CapDrop`);
      assert((h.SecurityOpt || []).includes('no-new-privileges:true'), `${name} no-new-privileges`);
      assert(h.PidsLimit > 0 && h.MemoryMiB > 0 && h.NanoCpus > 0, `${name} limits missing`);
      assert(!h.Binds || h.Binds.length === 0, `${name} has bind mounts`);
      assert(!h.PortBindings || Object.keys(h.PortBindings).length === 0, `${name} publishes ports (the override resets the API port)`);
      assert(!/^host$/.test(h.NetworkMode) && !/^host$/.test(h.PidMode), `${name} host namespace`);
    }
    assert(!m.hostConfig['rab-api'].CapAdd, 'rab-api CapAdd');
    assert(!m.hostConfig['rab-worker'].CapAdd || m.hostConfig['rab-worker'].CapAdd.length === 0, `rab-worker CapAdd ${JSON.stringify(m.hostConfig['rab-worker'].CapAdd)}`);
    assert(m.hostConfig['rab-worker'].Init === true, 'rab-worker without init (the watchdog SIGKILL is ignored for PID 1)');
    // Writable paths: the API only the kernel's /dev/shm (+ /dev/mqueue is skipped as pseudo); the Worker only its jobs dirs.
    assert(JSON.stringify(m.writable['rab-api uid 1000']) === '["/dev/shm"]', `rab-api writable: ${m.writable['rab-api uid 1000']}`);
    assert(JSON.stringify(m.writable['rab-worker uid 1000 (jobs)']) === '["/dev/shm","/run/crewflow-health/jobs","/tmp/crewflow-jobs"]', `jobs writable: ${m.writable['rab-worker uid 1000 (jobs)']}`);
    return 'API and Worker: uid 1000, no capability (CapBnd 0), NNP; Worker under init, one process';
  });

  if (MATRIX_ONLY) {
    if (!KEEP) cleanup();
    finish();
    return;
  }

  await step('M04', 'In-process provisioning (the Worker, uid 1000) brings a CREATING workspace to READY', async () => {
    await waitFor('h6-first READY', () => wsStatus(fx.probe.id) === 'READY|READY', 120_000);
    const owner = sql1(`SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'workspace_' || replace('${fx.probe.id}', '-', '')`);
    write(`schema owner: ${owner}`);
    return `READY; schema owner ${owner}`;
  });

  await step('M05', 'Read-only root filesystem: every identity is refused outside its own tmpfs', async () => {
    const paths = ['/', '/app', '/app/node_modules', '/app/packages', '/app/storage', '/tmp', '/home/node', '/etc', '/opt'];
    const probe = (svc, user) => execAs(svc, user, paths.map((p) => {
      const f = `${p.replace(/\/$/, '')}/.h6-ro-$$`;
      return `if ( : > "${f}" ) 2>/dev/null; then echo "${p} WRITABLE"; rm -f "${f}"; else echo "${p} refused"; fi`;
    }).join('\n'));
    const out = [];
    for (const [svc, user] of [['rab-api', '1000:1000'], ['rab-worker', '0:0'], ['rab-worker', '1000:1000']]) {
      const r = probe(svc, user);
      out.push(`${svc} ${user}: ${r.out.trim().split('\n').join('; ')}`);
      assert(!/WRITABLE/.test(r.out), `${svc} ${user} could write: ${r.out}`);
    }
    // The error is EROFS (the filesystem), not only EACCES (ownership): shown for the API's own storage dir.
    const e = execAs('rab-api', '1000:1000', 'touch /app/storage/x 2>&1; touch /tmp/x 2>&1; mkdir /home/node/.node_modules 2>&1; true');
    write(out.join('\n'));
    assert(/Read-only file system/.test(e.out), 'expected EROFS');
    return 'no write outside the jobs tmpfs (EROFS)';
  });

  await step('M06', 'Tmp dirs: jobs tmpfs ownership/mode/noexec (two mounts); the API has no writable tmpfs', async () => {
    const w = containerId('rab-worker');
    const tm = mounts(w).filter((m) => m.type === 'tmpfs' && /crewflow/.test(m.target));
    write(tm.map((m) => `${m.target} ${m.options}`).join('\n'));
    for (const m of tm) assert(/\bnoexec\b/.test(m.options) && /\bnosuid\b/.test(m.options) && /\bnodev\b/.test(m.options), `${m.target}: ${m.options}`);
    assert(tm.length === 2, `expected 2 crewflow tmpfs mounts (O1: jobs only), got ${tm.length}`);
    const own = execAs('rab-worker', '1000:1000', 'echo ok > /tmp/crewflow-jobs/h6 && cat /tmp/crewflow-jobs/h6 && rm /tmp/crewflow-jobs/h6; cp /bin/busybox /tmp/crewflow-jobs/bb && /tmp/crewflow-jobs/bb true 2>&1; echo "exec-from-tmp=$?"; rm -f /tmp/crewflow-jobs/bb');
    write(own.out);
    assert(/^ok$/m.test(own.out), 'jobs cannot use its own tmp');
    assert(/exec-from-tmp=126/.test(own.out), 'a binary in the jobs tmpfs executed (noexec missing)');
    const apiTmpfs = mounts(containerId('rab-api')).filter((m) => m.type === 'tmpfs' && !m.target.startsWith('/dev') && !m.target.startsWith('/proc') && !m.target.startsWith('/sys'));
    write(`rab-api tmpfs mounts (excluding /dev,/proc,/sys): ${apiTmpfs.map((m) => `${m.target} ${m.options}`).join('; ') || '(none)'}`);
    // The ONLY tmpfs the API may have is docker-compose.image.yml's OpenShip import guard: one /tmp, root-owned, mode 0555,
    // so no identity in the container (uid 1000, nor root: cap_drop ALL leaves no DAC override) can write to it.
    // docker-compose.production.yml has none. Anything else, or a guard that can be written to, fails.
    const other = apiTmpfs.filter((m) => m.target !== '/tmp');
    assert(other.length === 0, `the API has a tmpfs other than the /tmp import guard: ${other.map((m) => m.target).join(' ')}`);
    const guard = apiTmpfs.filter((m) => m.target === '/tmp');
    assert(guard.length <= 1, `the API has ${guard.length} /tmp tmpfs mounts`);
    if (guard.length === 0) return 'noexec,nosuid,nodev jobs tmpfs; API has no tmpfs';
    const st = execAs('rab-api', '0:0', 'stat -c "%u:%g %a" /tmp');
    const probe = (user) => execAs('rab-api', user, 'if ( : > /tmp/.h6-guard-$$ ) 2>/dev/null; then echo WRITABLE; rm -f /tmp/.h6-guard-$$; else echo refused; fi; if mkdir /tmp/.h6-guard-d-$$ 2>/dev/null; then echo WRITABLE; rmdir /tmp/.h6-guard-d-$$; fi').out.trim();
    const asApp = probe('1000:1000');
    const asRoot = probe('0:0');
    write(`rab-api /tmp guard: stat ${st.out.trim()}; uid 1000: ${asApp}; root: ${asRoot}`);
    assert(/(^|,)mode=0?555(,|$)/.test(guard[0].options), `the /tmp guard is not mode 0555: ${guard[0].options}`);
    assert(st.out.trim() === '0:0 555', `the /tmp guard is not root-owned mode 0555: ${st.out.trim()}`);
    assert(asApp === 'refused' && asRoot === 'refused', `the /tmp guard is writable (uid 1000: ${asApp}; root: ${asRoot})`);
    return 'noexec,nosuid,nodev jobs tmpfs; API: only the read-only (0555, root-owned) /tmp import guard';
  });

  await step('M07', 'Code permissions: /app and /opt/crewflow-bundle root-owned, not group/other-writable (both services)', async () => {
    const find = "find /app /opt/crewflow-bundle -path /app/storage -prune -o ! -type l \\( ! -user 0 -o ! -group 0 -o -perm /022 \\) -print 2>/dev/null | head -n 20; echo count=$(find /app /opt/crewflow-bundle -path /app/storage -prune -o ! -type l \\( ! -user 0 -o ! -group 0 -o -perm /022 \\) -print 2>/dev/null | wc -l)";
    const a = execAs('rab-api', '0:0', find);
    const w = execAs('rab-worker', '0:0', find);
    const s = execAs('rab-worker', '0:0', 'find / -xdev -type f -perm /6000 2>/dev/null | head; echo suid=$(find / -xdev -type f -perm /6000 2>/dev/null | wc -l); stat -c "%U:%G %a %n" /opt/crewflow-bundle /opt/crewflow-bundle/*');
    write(`api: ${a.out}\nworker: ${w.out}\n${s.out}`);
    assert(/count=0/.test(a.out) && /count=0/.test(w.out), 'writable or non-root application files');
    assert(/suid=0/.test(s.out), 'setuid/setgid files present');
    return '0 non-root/writable files; 0 setuid/setgid';
  });

  await step('M08', 'Node home restrictions: no writable or creatable module search path for any runtime identity', async () => {
    const api = execAs('rab-api', '1000:1000', 'stat -c "%U:%G %a %n" /home/node; HOME=/home/node node -e "const m=require(\'module\');const fs=require(\'fs\');for(const p of m.globalPaths){let w=false;try{fs.accessSync(p,fs.constants.W_OK);w=true}catch{};console.log(p, w?\'WRITABLE\':\'not-writable\')}"; mkdir -p /home/node/.node_modules/pg-native 2>&1; echo mkdir=$?');
    const w = containerId('rab-worker');
    const p = workerPids(w);
    const jobsHome = execIn(w, '1000:1000', `tr '\\0' '\\n' < /proc/${p.jobs}/environ | grep -E '^(HOME|TMPDIR|XDG_CONFIG_HOME|XDG_CACHE_HOME)='; mkdir /nonexistent 2>&1; echo mkdir=$?`);
    write(`api:\n${api.out}\njobs:\n${jobsHome.out}`);
    assert(/root:root 555 \/home\/node/.test(api.out) && !/WRITABLE/.test(api.out) && /mkdir=1/.test(api.out), 'API home writable');
    assert(/^HOME=\/nonexistent$/m.test(jobsHome.out) && /mkdir=1/.test(jobsHome.out), 'jobs HOME');
    return 'API HOME root:root 0555; Worker HOME=/nonexistent (not creatable)';
  });

  await step('M11', 'Redis: both services use it; Redis and PostgreSQL publish no port', async () => {
    const ping = compose(['exec', '-T', 'rab-redis', 'redis-cli', 'ping'], { quiet: true }).out.trim();
    const clients = compose(['exec', '-T', 'rab-redis', 'redis-cli', 'client', 'list'], { quiet: true }).out.split('\n').filter(Boolean).length;
    const ports = ['rab-redis', 'pg', 'rab-api', 'rab-worker'].map((s) => `${s}=${inspect(s, '{{json .HostConfig.PortBindings}}')}|${inspect(s, '{{json .NetworkSettings.Ports}}')}`);
    write(`ping=${ping} clients=${clients}\n${ports.join('\n')}`);
    assert(ping === 'PONG' && clients >= 3, 'redis not in use');
    for (const s of ['rab-redis', 'pg']) assert(/^\{\}|^null/.test(inspect(s, '{{json .HostConfig.PortBindings}}')), `${s} publishes a port`);
    const prodRedis = docker(['compose', '-p', `${PROJECT}-cfg`, '--project-directory', PROJECT_DIR, '-f', PROD, 'config', '--no-env-resolution', '--format', 'json'], { quiet: true, env: { CREWFLOW_SECRETS_DIR: '/nonexistent' } });
    const cfg = JSON.parse(prodRedis.stdout);
    write(`production file rab-redis ports: ${JSON.stringify(cfg.services['rab-redis'].ports ?? null)}; services: ${Object.keys(cfg.services).join(' ')}`);
    assert(!cfg.services['rab-redis'].ports && !Object.values(cfg.services).some((s) => /postgres/.test(String(s.image))), 'production file publishes Redis or runs PostgreSQL');
    return `PONG, ${clients} clients; no host port on Redis/PostgreSQL (production file: none either)`;
  });

  await step('M12', 'Restricted PostgreSQL: runtime containers never hold the migrator credential; crewflow_app cannot escalate', async () => {
    const envNames = (svc) => inspect(svc, '{{json .Config.Env}}');
    const api = JSON.parse(envNames('rab-api')).map((e) => e.split('=')[0]);
    const wrk = JSON.parse(envNames('rab-worker')).map((e) => e.split('=')[0]);
    const forbidden = /^(CREWFLOW_MIGRATION_|CREWFLOW_MIGRATOR|ALLOW_PRODUCTION_DB_COMMANDS|DB_TARGET|DATABASE_URL_UNPOOLED|CREWFLOW_BOOTSTRAP_PASSWORD|CREWFLOW_APP_BOOTSTRAP_PASSWORD|CREWFLOW_OPS_|PG_OPS_)/;
    write(`rab-api env names: ${api.sort().join(' ')}\nrab-worker env names: ${wrk.sort().join(' ')}`);
    assert(!api.some((k) => forbidden.test(k)) && !wrk.some((k) => forbidden.test(k)), 'a migration/ops variable reached a runtime container');
    assert(!api.includes('CREWFLOW_PROVISIONER_DATABASE_URL'), 'API has the provisioning URL');
    const values = [...JSON.parse(envNames('rab-api')), ...JSON.parse(envNames('rab-worker'))].join('\n');
    assert(!values.includes(`rab:${SECRETS.H6_SUPERUSER_PASSWORD}@`) && !values.includes('crewflow_migrator'), 'migration credential value in a runtime container');
    const w = containerId('rab-worker');
    const p = workerPids(w);
    const jobsEnv = execIn(w, '1000:1000', `tr '\\0' '\\n' < /proc/${p.jobs}/environ | cut -d= -f1 | sort | tr '\\n' ' '`, { quiet: true }).out;
    assert(!/CREWFLOW_PROVISIONER_|DATABASE_URL_UNPOOLED/.test(jobsEnv), 'the Worker holds a provisioner variable');
    const esc = appSql(`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user;
SELECT pg_has_role(current_user, 'crewflow', 'MEMBER'), pg_has_role(current_user, 'rab_secure_owner', 'MEMBER');`);
    const setRole = appSql('SET ROLE crewflow;');
    const ddl = appSql('CREATE SCHEMA h6_should_fail;');
    write(`crewflow_app posture: ${esc.out.trim().replace(/\n/g, ' / ')}\nSET ROLE crewflow: ${setRole.out.trim()}\nCREATE SCHEMA: ${ddl.out.trim()}`);
    assert(/^f\|f\|f\|f$/m.test(esc.out) && /^f\|f$/m.test(esc.out), 'crewflow_app has elevated attributes or memberships');
    assert(setRole.code !== 0 && ddl.code !== 0, 'crewflow_app escalated');
    return 'no migrator/ops variable on rab-api/rab-worker; crewflow_app: no SUPERUSER/BYPASSRLS/membership, SET ROLE and DDL refused';
  });

  await step('M13', 'FORCE RLS: runtime login sees no row without tenant context, none of another tenant\'s', async () => {
    const forced = sql1(`SELECT string_agg(c.relname || '=' || c.relrowsecurity || '/' || c.relforcerowsecurity, ' ' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'core' AND c.relname IN ('stored_file','shift_report','shift','user','manager_workspace','venue')`);
    const [orgA, wsA] = sql1(`SELECT organisation_id || '|' || workspace_id FROM core.venue WHERE name = 'ADOLPHUS QA Venue'`).split('|');
    const ctx = (org, ws) => `SELECT set_config('rab.organisation_id', '${org}', true), set_config('rab.workspace_id', '${ws}', true);`;
    const counts = appSql(`SELECT count(*) FROM core.shift;
SELECT count(*) FROM core.venue;
BEGIN; ${ctx(fx.probe.organisationId, fx.probe.id)} SELECT count(*) FROM core.venue; COMMIT;
BEGIN; ${ctx(orgA, wsA)} SELECT count(*) FROM core.venue; COMMIT;`).out.trim().split('\n').filter((l) => /^\d+$/.test(l));
    write(`core RLS/FORCE: ${forced}\ncrewflow_app counts [shift no ctx, venue no ctx, venue other org, venue own org]: ${counts.join(' ')}`);
    assert(/stored_file=true\/true/.test(forced) && /shift_report=true\/true/.test(forced) && /venue=true\/true/.test(forced), 'FORCE RLS missing');
    assert(counts[0] === '0' && counts[1] === '0' && counts[2] === '0' && Number(counts[3]) >= 1, `unexpected counts ${counts}`);
    return `no context → 0 rows; other tenant → 0; own tenant → ${counts[3]}`;
  });

  await step('M14', 'BullMQ consumer: a real email (forgot-password) goes outbox → BullMQ → SMTP sink', async () => {
    const before = mailCount();
    const r = apiFetch('http://localhost:3000/rest/v1/auth/forgot-password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'manager.qa@example.test' }) });
    write(`forgot-password: ${JSON.stringify({ status: r.status, error: r.error })}`);
    await waitFor('email in sink', () => mailCount() > before, 90_000);
    const keys = compose(['exec', '-T', 'rab-redis', 'sh', '-c', "redis-cli --scan --pattern 'bull:*' | sed -E 's/:[^:]+$//' | sort | uniq -c | sort -rn | head -20"], { quiet: true }).out;
    write(`bull keys:\n${keys}`);
    const outbox = sql1(`SELECT string_agg(status, ',') FROM core.email_outbox`);
    write(`email_outbox: ${outbox}`);
    assert(/bull:/.test(keys), 'no BullMQ keys');
    assert(/sent/i.test(outbox), 'outbox not marked sent');
    return `mail delivered; outbox ${outbox}`;
  });

  await step('M09', 'Native PDF (no browser) + M10 report upload: real pre-shift report rendered by the jobs child, bytes in object storage', async () => {
    const { shiftId, orgId } = await startShiftReport(20);
    fx.shift = { shiftId, orgId };
    const mailsBefore = mailCount();
    const since = new Date(Date.now() - 5_000).toISOString();
    compose(['restart', '-t', '60', 'rab-worker']); // the scheduler runs its first cycle at start (otherwise every 5 minutes)
    const sampler = setInterval(() => {
      const s = cgroupStats(containerId('rab-worker'));
      measured.workerPeakDuringPdf = { memoryPeakMiB: mib(s['memory.peak']), pidsPeak: s['pids.peak'] };
    }, 4000);
    try {
      await waitFor('report ready', () => /^ready\|true$/.test(reportState(shiftId)), 240_000, 3000);
    } finally {
      clearInterval(sampler);
    }
    const s = cgroupStats(containerId('rab-worker'));
    measured.workerPeakDuringPdf = { memoryPeakMiB: mib(s['memory.peak']), pidsPeak: s['pids.peak'], memoryMaxMiB: mib(s['memory.max']), pidsMax: s['pids.max'], cpuMax: s['cpu.max'] };
    const file = sql1(`SELECT sf.id || '|' || sf.kind || '|' || sf.status || '|' || coalesce(sf.size_bytes::text,'?') || '|' || sf.object_key || '|' || coalesce(sf.bucket,'-') FROM core.stored_file sf WHERE sf.organisation_id = '${orgId}' AND sf.mime_type = 'application/pdf' ORDER BY sf.created_at DESC LIMIT 1`);
    write(`stored_file: ${file}`);
    const [fileId, kind, status, size, key] = file.split('|');
    fx.reportFile = { fileId, kind, size: Number(size), key, orgId };
    const cols = sql1(`SELECT string_agg(column_name || ':' || data_type, ' ' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'core' AND table_name = 'stored_file'`);
    write(`core.stored_file columns: ${cols}`);
    assert(!/bytea/.test(cols), 'stored_file has a bytea column (PDF bytes in PostgreSQL)');
    const obj = compose(['exec', '-T', 'minio', 'sh', '-c', `mc alias set h6 http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; mc stat --json "h6/h6-runtime/${key}" | head -c 600; echo; mc cat "h6/h6-runtime/${key}" | sha256sum`], { quiet: true });
    write(`object: ${obj.out}`);
    assert(/"status":"success"/.test(obj.out), 'object not in MinIO');
    fx.reportFile.objectSha = (/^([0-9a-f]{64})/m.exec(obj.out) || [])[1];
    assert(status === 'AVAILABLE' && fx.reportFile.size > 1000, `stored_file ${status} ${size}`);
    const logs = logsOf('rab-worker', since);
    write(logs.split('\n').filter((l) => /shift report scheduler|render|native|storage/i.test(l)).slice(-10).join('\n'));
    assert(/shift report scheduler: generated=1/.test(logs), 'scheduler did not log the generated report');
    await waitFor('report email', () => mailCount() > mailsBefore, 120_000, 3000);
    // P5: the render ran in the jobs process itself. No browser binary exists, no browser process or profile directory
    // appeared, and the jobs tmpfs holds nothing but (at most) the XDG config/cache directories the compose points at.
    const left = execAs('rab-worker', '1000:1000', 'ls -A /tmp/crewflow-jobs | grep -v -x -e .config -e .cache | wc -l; for p in /usr/bin/chromium /usr/bin/chromium-browser /usr/lib/chromium; do test -e "$p" && echo "present $p"; done; true');
    const browser = procTable(containerId('rab-worker')).filter((p) => /chrom|playwright/i.test(p.cmd)).length;
    write(`jobs tmp entries after render (besides .config/.cache): ${left.out.trim()}\nbrowser processes: ${browser}`);
    assert(/^0$/m.test(left.out.trim().split('\n')[0]) && !/present/.test(left.out) && browser === 0, 'the render left temp files, or a browser exists');
    return `PDF ${size} bytes in MinIO (key in PostgreSQL); Worker peak ${measured.workerPeakDuringPdf.memoryPeakMiB} MiB / ${measured.workerPeakDuringPdf.pidsPeak} tasks`;
  });

  await step('M10', 'Report retrieval: authorised presigned download returns the same bytes; anonymous and cross-tenant get nothing', async () => {
    const f = fx.reportFile;
    const problems = [];
    const expect = (cond, label) => {
      if (!cond) problems.push(label);
    };
    /** A storage error body, without request ids, signatures or the (already redacted) access key. */
    const errBody = (r) => String(r.text || '').replace(/<(RequestId|HostId)>[^<]*/g, '<$1>').replace(/[0-9a-f]{64}/g, '<hex64>').slice(0, 1200);
    const login = apiFetch('http://localhost:3000/rest/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'manager.qa@example.test', password: SECRETS.H6_FIXTURE_PASSWORD }) });
    const token = (() => { try { return JSON.parse(login.text).accessToken; } catch { return undefined; } })();
    write(`login: status=${login.status} token=${token ? 'yes' : 'no'} ${token ? '' : login.text.slice(0, 300)}`);
    assert(login.status === 200 && token, 'fixture login failed');
    const dl = apiFetch(`http://localhost:3000/rest/v1/files/${f.fileId}/download`, { headers: { authorization: `Bearer ${token}` } });
    const shown = (u) => (u ? u.replace(/X-Amz-(Signature|Credential)=[^&]+/g, 'X-Amz-$1=<redacted>') : '-');
    write(`download: status=${dl.status} location=${shown(dl.location)}`);
    assert(dl.status === 302 && dl.location, 'no presigned redirect');
    const signedHost = new URL(dl.location).host;
    write(`presigned URL host: ${signedHost} (the harness fetches it from inside the API container on the project network, Host header = that same value)`);
    const obj = apiFetch(dl.location);
    write(`presigned GET (app URL): status=${obj.status} len=${obj.len} magic=${obj.magic} sha256=${obj.sha256} (object ${f.objectSha})${obj.status === 200 ? '' : `\nerror body: ${errBody(obj)}`}`);
    expect(obj.status === 200 && obj.magic === '%PDF-' && obj.sha256 === f.objectSha, `presigned bytes differ (status ${obj.status})`);
    // Root-cause demonstration for the run-4 failure: the previous harness fetched the REDACTED copy of this URL.
    const redactedCopy = apiFetch(redact(dl.location));
    write(`the same URL with the access key redacted (what run 4 fetched): status=${redactedCopy.status} ${(/<Code>[^<]*<\/Code>/.exec(String(redactedCopy.text)) || [''])[0]} (changed=${redact(dl.location) !== dl.location})`);
    // Controls, minted in the same container with the same client settings: a plain presigned GET, and one with the same
    // response-content-type / response-content-disposition parameters the API adds. Separates signing from environment.
    const filename = sql1(`SELECT original_filename FROM core.stored_file WHERE id = '${f.fileId}'`);
    write(`stored original_filename: ${filename}`);
    for (const variant of ['plain', 'app-params']) {
      const js = "const {S3Client,GetObjectCommand}=require('@aws-sdk/client-s3');const {getSignedUrl}=require('@aws-sdk/s3-request-presigner');const c=new S3Client({region:process.env.S3_REGION,endpoint:process.env.S3_ENDPOINT,forcePathStyle:process.env.S3_FORCE_PATH_STYLE==='true',credentials:{accessKeyId:process.env.S3_ACCESS_KEY_ID,secretAccessKey:process.env.S3_SECRET_ACCESS_KEY}});const extra=process.env.V==='app-params'?{ResponseContentType:'application/pdf',ResponseContentDisposition:'attachment; filename=\"'+process.env.FN+'\"'}:{};getSignedUrl(c,new GetObjectCommand({Bucket:process.env.S3_BUCKET,Key:process.env.K,...extra}),{expiresIn:120}).then(async u=>{const r=await fetch(u);const t=await r.text();console.log(JSON.stringify({status:r.status,body:r.status===200?'':t.slice(0,1200)}))})";
      const r = docker(['exec', '-u', '1000:1000', '-w', '/app', '-e', 'K', '-e', 'V', '-e', 'FN', '-e', 'J', containerId('rab-api'), 'sh', '-c', 'node -e "$J"'], { quiet: true, env: { K: f.key, V: variant, FN: filename || 'report.pdf', J: js } });
      const line = r.out.trim().split('\n').pop();
      write(`control presign (${variant}): ${String(line).replace(/<(RequestId|HostId)>[^<]*/g, '<$1>').slice(0, 1400)}`);
    }
    const tampered = apiFetch(dl.location.replace(/X-Amz-Signature=[0-9a-f]{8}/, 'X-Amz-Signature=00000000'));
    const anon = apiFetch(`http://localhost:3000/rest/v1/files/${f.fileId}/download`);
    const direct = apiFetch(`http://minio:9000/h6-runtime/${f.key}`);
    write(`tampered signature: ${tampered.status}; anonymous API: ${anon.status}; unsigned object URL: ${direct.status}`);
    expect(tampered.status === 403, `tampered signature returned ${tampered.status}`);
    expect(anon.status === 401, `anonymous API returned ${anon.status}`);
    expect(direct.status === 403, `unsigned object URL returned ${direct.status}`);
    const wsOwn = sql1(`SELECT coalesce(workspace_id::text, '') FROM core.stored_file WHERE id = '${f.fileId}'`);
    const ctx = (org, ws) => `SELECT set_config('rab.organisation_id', '${org}', true), set_config('rab.workspace_id', '${ws}', true);`;
    const rls = appSql(`SELECT count(*) FROM core.stored_file WHERE id = '${f.fileId}';
BEGIN; ${ctx(fx.probe.organisationId, fx.probe.id)} SELECT count(*) FROM core.stored_file WHERE id = '${f.fileId}'; COMMIT;
BEGIN; ${ctx(f.orgId, wsOwn)} SELECT count(*) FROM core.stored_file WHERE id = '${f.fileId}'; COMMIT;`).out.trim().split('\n').filter((l) => /^\d+$/.test(l));
    write(`crewflow_app rows for the report file [no context, other tenant, own tenant]: ${rls.join(' ')}`);
    expect(rls.join(' ') === '0 0 1', `RLS rows ${rls.join(' ')}`);
    // Cross-tenant through the API: the h6-first owner (another organisation) must get 404.
    psql(`UPDATE core."user" SET password_hash = (SELECT password_hash FROM core."user" WHERE email = 'manager.qa@example.test') WHERE email = 'h6-first@h6-runtime.invalid'`, { quiet: true });
    const other = apiFetch('http://localhost:3000/rest/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'h6-first@h6-runtime.invalid', password: SECRETS.H6_FIXTURE_PASSWORD }) });
    const otherToken = (() => { try { return JSON.parse(other.text).accessToken; } catch { return undefined; } })();
    if (!otherToken) {
      write(`other-tenant login: status=${other.status} ${String(other.text).slice(0, 300)}`);
      problems.push(`other-tenant account could not sign in (status ${other.status}) — API cross-tenant check NOT RUN`);
    } else {
      const cross = apiFetch(`http://localhost:3000/rest/v1/files/${f.fileId}/download`, { headers: { authorization: `Bearer ${otherToken}` } });
      write(`other-tenant download: ${cross.status}`);
      expect(cross.status === 404, `cross-tenant download returned ${cross.status}`);
    }
    assert(problems.length === 0, problems.join('; '));
    return 'presigned bytes match; tampered 403, anonymous 401, unsigned 403, other tenant 404; RLS 0/0/1';
  });

  await step('M21', 'Isolation after failed jobs: a refused render and a storage outage leave no process/temp residue; next job succeeds', async () => {
    const w = containerId('rab-worker');
    const restarts0 = restartsOf('rab-worker');
    // P5: the native renderer loads no document and cannot navigate (the Chromium navigation case is gone). Its
    // fail-closed path: an unknown document kind must be refused, never rendered as something else.
    const prog = [
      "const u=require('/app/packages/rab-worker/dist/queues/rab-reports/render-pdf.util.js')",
      "Promise.resolve().then(()=>u.renderReportPdf({kind:'no-such-document',data:{}},Object.assign({},process.env,{PDF_RENDERER:'native'}))).then(()=>console.log('UNEXPECTED render ok'),e=>console.log('refused: '+e.message))",
    ].join(';');
    const bad = execIn(w, '1000:1000', `cd /app && HOME=/nonexistent TMPDIR=/tmp/crewflow-jobs XDG_CONFIG_HOME=/tmp/crewflow-jobs/.config XDG_CACHE_HOME=/tmp/crewflow-jobs/.cache node -e "${prog}"`);
    write(`unknown-document render: ${bad.out.trim()}`);
    assert(/refused: /.test(bad.out) && !/UNEXPECTED/.test(bad.out), 'an unknown document was not refused');
    // Real job failure: object storage down while a report is due.
    // Outage without data loss: MinIO keeps running (its tmpfs /data survives) but leaves the project network.
    const minioId = containerId('minio');
    const net = `${PROJECT}_default`;
    assert(docker(['network', 'disconnect', net, minioId]).code === 0, 'could not disconnect minio');
    const { shiftId } = await startShiftReport(20);
    const since = new Date(Date.now() - 5_000).toISOString();
    compose(['restart', '-t', '60', 'rab-worker']);
    await waitFor('a failed report cycle', () => /shift report scheduler: generated=0 failed=[1-9]/.test(logsOf('rab-worker', since)), 240_000, 5000);
    const state = reportState(shiftId);
    const browser = procTable(containerId('rab-worker')).filter((p) => /chrom|playwright/i.test(p.cmd)).length;
    const tmp = execAs('rab-worker', '1000:1000', 'ls -A /tmp/crewflow-jobs | grep -v -x -e .config -e .cache | wc -l').out.trim();
    const failLogs = logsOf('rab-worker', since).split('\n').filter((l) => /shift report|storage|S3|ECONNREFUSED|ENOTFOUND|failed/i.test(l)).slice(0, 12);
    write(`report state during outage: ${state || '(no ready report)'}; browser processes ${browser}; jobs tmp entries ${tmp}\n${failLogs.join('\n')}`);
    assert(!/^ready\|true$/.test(state) && browser === 0 && tmp === '0', 'failure left residue or reported ready');
    const restartsDuring = restartsOf('rab-worker') - restarts0;
    assert(docker(['network', 'connect', '--alias', 'minio', net, minioId]).code === 0, 'could not reconnect minio');
    await waitFor('minio healthy', () => healthOf('minio') === 'healthy', 60_000);
    const bucket = compose(['exec', '-T', 'minio', 'sh', '-c', 'mc alias set h6 http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; mc stat h6/h6-runtime >/dev/null 2>&1 && echo 1 || echo 0'], { quiet: true }).out.trim();
    write(`bucket present after the outage: ${bucket}`);
    assert(bucket === '1', 'the bucket did not survive the outage');
    const since2 = new Date(Date.now() - 5_000).toISOString();
    compose(['restart', '-t', '60', 'rab-worker']);
    await waitFor('report ready after recovery', () => /^ready\|true$/.test(reportState(shiftId)), 240_000, 5000);
    write(logsOf('rab-worker', since2).split('\n').filter((l) => /shift report scheduler/.test(l)).slice(-3).join('\n'));
    return `refused render clean; storage outage → failed cycle, no residue, ${restartsDuring} container restart(s); recovered → ready`;
  });

  await step('M15', 'Worker health: the jobs-only per-instance check passes (health script exit 0)', async () => {
    await waitFor('rab-worker healthy', () => healthOf('rab-worker') === 'healthy', 240_000, 3000);
    const h = execAs('rab-worker', '1000:1000', 'env CREWFLOW_PROVISIONER_ENABLED=false node /opt/crewflow-bundle/worker-bundle-health.cjs; echo exit=$?');
    write(h.out);
    assert(/exit=0/.test(h.out), 'health script failed');
    return 'healthy';
  });

  await step('M19', 'Resource limits applied by the kernel (cgroup v2) and the PID cap enforced; measured peaks', async () => {
    const a = cgroupStats(containerId('rab-api'));
    const w = cgroupStats(containerId('rab-worker'));
    // API load: 30 sign-in attempts (argon2 in-process) + 200 health requests, then read the peak.
    for (let i = 0; i < 30; i++) apiFetch('http://localhost:3000/rest/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `nobody${i}@h6-runtime.invalid`, password: 'wrong-password-h6' }) });
    execAs('rab-api', '1000:1000', 'i=0; while [ $i -lt 200 ]; do wget -qO- http://localhost:3000/healthz >/dev/null; i=$((i+1)); done');
    const a2 = cgroupStats(containerId('rab-api'));
    measured.api = { memoryMaxMiB: mib(a2['memory.max']), memoryPeakMiB: mib(a2['memory.peak']), memoryCurrentMiB: mib(a2['memory.current']), pidsMax: a2['pids.max'], pidsPeak: a2['pids.peak'], cpuMax: a2['cpu.max'] };
    measured.worker = { memoryMaxMiB: mib(w['memory.max']), memoryPeakMiB: mib(w['memory.peak']), memoryCurrentMiB: mib(w['memory.current']), pidsMax: w['pids.max'], pidsPeak: w['pids.peak'], cpuMax: w['cpu.max'] };
    write(`api before load: ${JSON.stringify(a)}\napi after load: ${JSON.stringify(measured.api)}\nworker: ${JSON.stringify(measured.worker)}`);
    // PID cap enforcement (API): one node process (uid 1000) spawns up to 400 short-lived children and counts the ones the
    // kernel refuses (EAGAIN). A shell cannot do this: busybox sh exits on a failed background fork, and its orphans would
    // then be re-parented to the API's PID 1 (node), which does not reap them (see the H6 report). node reaps its own
    // children, so nothing is left behind; zombies are counted afterwards to prove it.
    const probe = "const {spawn}=require('child_process');const fs=require('fs');let refused=0;const codes={};const kids=[];for(let i=0;i<400;i++){let c;try{c=spawn('sleep',['6'],{stdio:'ignore'})}catch(e){refused++;codes[e.code]=(codes[e.code]||0)+1;continue}c.on('error',e=>{refused++;codes[e.code]=(codes[e.code]||0)+1});kids.push(c)}setTimeout(()=>{const r=f=>fs.readFileSync('/sys/fs/cgroup/'+f,'utf8').trim();console.log(JSON.stringify({attempted:400,spawned:kids.filter(k=>k.pid).length,refused,codes,peak:r('pids.peak'),max:r('pids.max'),events:r('pids.events')}))},9000)";
    const fork = docker(['exec', '-u', '1000:1000', '-e', 'J', containerId('rab-api'), 'sh', '-c', 'node -e "$J"'], { quiet: true, env: { J: probe }, timeout: 120_000 });
    const res = (() => { try { return JSON.parse(fork.out.trim().split('\n').pop()); } catch { return null; } })();
    const zombies = execAs('rab-api', '0:0', "z=0; for p in /proc/[0-9]*; do [ \"$(awk '{print $3}' $p/stat 2>/dev/null)\" = Z ] && z=$((z+1)); done; echo $z", { quiet: true }).out.trim();
    write(`fork probe: ${res ? JSON.stringify(res) : fork.out.slice(-400)}; zombies afterwards: ${zombies}`);
    assert(res, 'fork probe output');
    const peak = Number(res.peak);
    const max = Number(res.max);
    const started = res.spawned;
    // Enforcement proof = the KERNEL refused forks at the cap: EAGAIN for every refusal, fewer than 400 spawned, and the
    // cgroup's own "max" event counter is non-zero. pids.peak may exceed pids.max by the processes `docker exec` ATTACHES
    // to the cgroup (cgroup v2: "organisational operations are not blocked by cgroup policies"), never by forks: the
    // overshoot is bounded by the 3 exec'd processes of this probe (sh, node, and the concurrent health-check exec).
    const onlyEagain = Object.keys(res.codes || {}).every((c) => c === 'EAGAIN');
    assert(res.refused > 0 && onlyEagain && res.spawned < 400 && /max \d*[1-9]/.test(res.events) && peak >= max && peak - max <= 3, `pids_limit not enforced (spawned ${res.spawned}, refused ${res.refused} ${JSON.stringify(res.codes)}, peak ${peak}, max ${max}, events ${res.events})`);
    assert(zombies === '0', `zombies left in the API container: ${zombies}`);
    await waitFor('rab-api healthy after the fork probe', () => healthOf('rab-api') === 'healthy', 60_000);
    assert(a2['memory.max'] !== 'max' && a2['pids.max'] !== 'max' && a2['cpu.max'] && !/^max /.test(a2['cpu.max']), 'API cgroup limits missing');
    assert(w['memory.max'] !== 'max' && w['pids.max'] !== 'max' && !/^max /.test(w['cpu.max']), 'Worker cgroup limits missing');
    return `API peak ${measured.api.memoryPeakMiB}/${measured.api.memoryMaxMiB} MiB, ${measured.api.pidsPeak}/${measured.api.pidsMax} tasks (fork probe stopped at ${started}); Worker peak ${measured.worker.memoryPeakMiB}/${measured.worker.memoryMaxMiB} MiB, ${measured.worker.pidsPeak}/${measured.worker.pidsMax} tasks`;
  });

  await step('M20', 'Two Worker replicas under the same limits: both healthy; 4 workspaces each provisioned exactly once', async () => {
    const many = Array.from({ length: 4 }, (_, i) => seedCreatingWorkspace(`h6-race-${i}`));
    assert(compose(['up', '-d', '--wait', '--wait-timeout', '300', '--no-build', '--no-recreate', '--scale', 'rab-worker=2', 'rab-worker']).code === 0, 'two replicas not healthy');
    const ids = containerIds('rab-worker');
    assert(ids.length === 2, `expected 2 replicas, got ${ids.length}`);
    await waitFor('all race workspaces READY', () => many.every((w) => wsStatus(w.id) === 'READY|READY'), 180_000);
    const dup = sql1(`SELECT count(*) FROM core.workspace_schema_registry WHERE workspace_id IN (${many.map((w) => `'${w.id}'`).join(',')})`);
    measured.replicas = ids.map((id) => cgroupStats(id)).map((s) => ({ memoryPeakMiB: mib(s['memory.peak']), pidsPeak: s['pids.peak'] }));
    write(`registry rows ${dup}; replicas ${JSON.stringify(measured.replicas)}`);
    assert(dup === '4', `registry rows ${dup}`);
    compose(['up', '-d', '--wait', '--no-build', '--no-recreate', '--scale', 'rab-worker=1', 'rab-worker']);
    return `2 replicas healthy; 4/4 provisioned once; peaks ${measured.replicas.map((r) => `${r.memoryPeakMiB} MiB/${r.pidsPeak} tasks`).join(', ')}`;
  });

  await step('M18', 'Restart recovery: a killed Worker process ends the container, the restart policy brings it back healthy', async () => {
    await waitFor('rab-worker healthy', () => healthOf('rab-worker') === 'healthy', 240_000, 3000);
    const before = restartsOf('rab-worker');
    const startedBefore = inspect('rab-worker', '{{.State.StartedAt}}');
    const p = workerPids(containerId('rab-worker'));
    const since = new Date(Date.now() - 5_000).toISOString();
    execAs('rab-worker', '1000:1000', `kill -9 ${p.jobs}`);
    await waitFor('container restarted', () => restartsOf('rab-worker') > before, 180_000, 3000);
    await waitFor('healthy again', () => healthOf('rab-worker') === 'healthy', 300_000, 5000);
    const logs = logsOf('rab-worker', since).split('\n').filter((l) => /rab-worker ready|workspace provisioning: in-process/.test(l)).slice(0, 12);
    write(logs.join('\n'));
    const p2 = workerPids(containerId('rab-worker'));
    // A restarted container gets a fresh PID namespace, so the Worker may get the SAME pid number again: compare the
    // container start time and require a new start in the Worker's own log instead.
    const startedAfter = inspect('rab-worker', '{{.State.StartedAt}}');
    write(`StartedAt ${startedBefore} → ${startedAfter}; Worker now pid ${p2.jobs}`);
    assert(p2.jobs && p2.workers === 1 && startedAfter !== startedBefore, 'Worker not restarted');
    assert(logs.some((l) => /rab-worker ready/.test(l)), 'expected a new start in the Worker log');
    return `restart count ${before} → ${restartsOf('rab-worker')}; healthy`;
  });

  await step('M16', 'SIGTERM: API drains and exits within its grace; the Worker drains (jobs + in-process provisioning), exit 0', async () => {
    const t0 = Date.now();
    const since = new Date(Date.now() - 10_000).toISOString();
    compose(['stop', '-t', '35', 'rab-api']);
    measured.apiStopMs = Date.now() - t0;
    const apiExit = inspect('rab-api', '{{.State.ExitCode}}');
    const apiLog = logsOf('rab-api', since).split('\n').slice(-8).join('\n');
    write(`rab-api stop ${measured.apiStopMs} ms, exit ${apiExit}\n${apiLog}`);
    // Worker: stop it while the API is down too (the order a full `down` would use).
    await waitFor('rab-worker healthy', () => healthOf('rab-worker') === 'healthy', 240_000, 3000);
    const since2 = new Date(Date.now() - 10_000).toISOString();
    const t1 = Date.now();
    compose(['stop', '-t', '45', 'rab-worker']);
    measured.workerStopMs = Date.now() - t1;
    const exit = inspect('rab-worker', '{{.State.ExitCode}}');
    const stopLog = logsOf('rab-worker', since2);
    write(`rab-worker stop ${measured.workerStopMs} ms, exit ${exit}\n${stopLog.split('\n').filter((l) => /Worker received|SIGTERM|shut down cleanly/.test(l)).join('\n')}`);
    assert(apiExit === '0' && measured.apiStopMs < 35_000, `API exit ${apiExit} after ${measured.apiStopMs} ms`);
    assert(/^Worker shut down cleanly$/m.test(stopLog), 'missing "Worker shut down cleanly"');
    assert(exit === '0' && measured.workerStopMs < 45_000, `Worker exit ${exit} after ${measured.workerStopMs} ms`);
    return `API exit 0 in ${measured.apiStopMs} ms; Worker exit 0 in ${measured.workerStopMs} ms (init → tini → node, one drain)`;
  });

  await step('M17', 'Graceful start after stop: both come back healthy, no orphan or zombie processes', async () => {
    assert(compose(['up', '-d', '--wait', '--wait-timeout', '300', '--no-build', 'rab-api', 'rab-worker']).code === 0, 'did not come back');
    const t = procTable(containerId('rab-worker'));
    const zombies = execAs('rab-worker', '0:0', "for p in /proc/[0-9]*; do awk '{print $3}' $p/stat 2>/dev/null; done | grep -c Z || true", { quiet: true }).out.trim();
    write(`${t.map((x) => `${x.pid} uid=${x.uid} ${x.cmd}`).join('\n')}\nzombies=${zombies}`);
    const nodes = t.filter((x) => /\bnode\b/.test(x.cmd) && !INIT_RE.test(x.cmd));
    assert(nodes.length === 1 && t.every((x) => x.uid === 1000) && zombies === '0', 'orphans, a second node process, a non-1000 process, or zombies');
    return 'healthy; exactly one Worker node process, all uid 1000; 0 zombies';
  });

  finish();
  if (!KEEP) cleanup();
})().catch((e) => {
  console.error(redact(e.stack || e.message));
  try { finish(); } finally { if (!KEEP) cleanup(); }
  process.exitCode = 1;
});

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  const md = [
    `# H6 runtime matrix — ${new Date().toISOString()}`,
    '',
    `- production file: \`${path.relative(REPO, PROD) || PROD}\`; override: \`${path.relative(REPO, OVERRIDE)}\``,
    `- images: \`${process.env.H6_APP_IMAGE}\`, \`${process.env.H6_WORKER_IMAGE}\``,
    `- mode: ${MATRIX_ONLY ? 'matrix only' : 'full'}`,
    '',
    '| id | case | result | note | log |',
    '|---|---|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.title} | ${r.status} | ${String(r.note).replace(/\|/g, '/')} | ${r.log} |`),
    '',
    `PASS ${results.filter((r) => r.status === 'PASS').length} / FAIL ${results.filter((r) => r.status === 'FAIL').length} / other ${results.filter((r) => !['PASS', 'FAIL'].includes(r.status)).length}`,
    '',
    '## MEASURED',
    '```json',
    JSON.stringify(measured, null, 2),
    '```',
  ];
  fs.writeFileSync(path.join(OUT, 'SUMMARY.md'), redact(md.join('\n')));
  if (results.some((r) => r.status === 'FAIL')) process.exitCode = 1;
}
