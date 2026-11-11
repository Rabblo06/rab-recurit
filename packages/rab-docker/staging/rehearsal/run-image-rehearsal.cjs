'use strict';
/**
 * LOCAL ISOLATED STAGING REHEARSAL of packages/rab-docker/docker-compose.image.yml (owner decisions R4/R5, 2026-11-03).
 *
 *   S_IMAGE=<repository>@sha256:<digest> (O2: the one image for every application service) \
 *   S_REDIS_IMAGE=redis@sha256:<digest> S_SEED_IMAGE=<image with PR #38 seed-qa> S_REDIS_CONF=<reviewed redis.conf> \
 *     node packages/rab-docker/staging/rehearsal/run-image-rehearsal.cjs <evidence-dir> [--keep]
 *
 * The images are LOCAL candidate images referenced by digest (the containerd image store gives every local image a
 * repository@sha256 reference); nothing is pulled, pushed or built. Compose runs the variant with the rehearsal override
 * (docker-compose.image-rehearsal.yml): throwaway PostgreSQL / MinIO / SMTP sink, every data directory a tmpfs.
 *
 * Cases (each PASS / FAIL / BLOCKED with raw output in <evidence-dir>/NN-*.log, summary in SUMMARY.md):
 *   R00 static: the verifier on the variant; the override changes no runtime security key and no image
 *   R01 throwaway infrastructure up; Redis is the variant's own hardened service (reviewed config + per-run ACL)
 *   R02 Redis hardening holds: unauthenticated NOAUTH, PING-only health user, app user denied admin, noeviction + AOF
 *   O3 (owner decisions C1-C5): docker-compose.image.yml has NO rab-migrate any more; the API migrates on start. R03 is
 *       therefore BLOCKED until this driver is reworked for O3 and the owner login (KNOWN GAP, like its separated-login
 *       database steps); its original text follows.
 *   R03 guarded migrations through the variant's rab-migrate (API image by digest): deploy-prepare check (3) / apply,
 *       phase A as rab_owner, phase B as the bootstrap superuser, a wrong token refused (1, nothing applied), final
 *       check (0); ledger, the gated 1786721330000 absent; rab-migrate's own container read-only / no capability
 *   R04 rab-api healthy under CREWFLOW_RUNTIME_ISOLATION=enforce (depends_on: rab-migrate check run completes first)
 *   R05 rab-worker healthy under enforce (O1: one process, in-process provisioning)
 *   R06 restrictions hold: CapBnd / CapEff / NoNewPrivs per process, read-only root (EROFS), kernel PID / memory limits
 *   R07 a real report PDF rendered by the Worker lands in MinIO; PostgreSQL holds only the reference
 *   R08 enforce refuses a weakened container (read-only root removed from rab-api, no-new-privileges from rab-worker).
 *       BLOCKED when the images predate the enforce mode (they only report "WARNING ... starting anyway").
 *
 * Safety: project `crewflow-s-rehearsal` only; no host port; no .env read (random credentials per run, redacted from every
 * evidence file); no Docker volume created; cleanup stops and removes this project's containers BY EXACT NAME (never
 * `down -v`, never a prune). The project network is left in place. Adapted from rab/runtime-isolation-test/run-h6-runtime.cjs.
 *
 * O1 (one image): the Worker is the same image as the API, ONE process as uid 1000 under compose's init and tini, no
 * capability, two jobs tmpfs mounts; the retired launcher and its provisioner child are gone. KNOWN GAP (pre-existing since
 * #72, not changed by O1): the rehearsal's database steps still use the separated logins (crewflow_app / crewflow); the
 * runtime now requires the owner login (crewflow_owner).
 */
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROJECT = 'crewflow-s-rehearsal';
const REPO = path.resolve(__dirname, '../../../..');
const PROJECT_DIR = path.join(REPO, 'packages/rab-docker');
const VARIANT = path.join(PROJECT_DIR, 'docker-compose.image.yml');
const PRODUCTION = path.join(PROJECT_DIR, 'docker-compose.production.yml');
const OVERRIDE = path.join(__dirname, 'docker-compose.image-rehearsal.yml');
const WEAKENED = path.join(__dirname, 'docker-compose.image-rehearsal-weakened.yml');
const { checkVariant, renderModels } = require('../verify-image-compose.cjs');

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const OUT = path.resolve(argv[0] && !argv[0].startsWith('--') ? argv[0] : '');
if (!argv[0] || argv[0].startsWith('--')) {
  console.error('usage: run-image-rehearsal.cjs <evidence-dir> [--keep]');
  process.exit(2);
}
const DIGEST_REF = /^(.+)@(sha256:[0-9a-f]{64})$/;
for (const k of ['S_IMAGE', 'S_REDIS_IMAGE', 'S_SEED_IMAGE', 'S_REDIS_CONF']) {
  if (!process.env[k]) {
    console.error(`${k} is required`);
    process.exit(2);
  }
}
for (const k of ['S_IMAGE', 'S_REDIS_IMAGE']) {
  if (!DIGEST_REF.test(process.env[k])) {
    console.error(`${k} must be <repository>@sha256:<64 hex>`);
    process.exit(2);
  }
}
fs.mkdirSync(OUT, { recursive: true });

const hex = (n) => crypto.randomBytes(n).toString('hex');
const SECRETS = {
  S_SUPERUSER_PASSWORD: hex(24),
  S_CREWFLOW_PASSWORD: hex(24),
  S_APP_PASSWORD: hex(24),
  S_APP_SECRET: hex(48),
  S_REDIS_PASSWORD: hex(24),
  S_S3_ACCESS_KEY: `s${hex(10)}`,
  S_S3_SECRET_KEY: hex(24),
  S_FIXTURE_PASSWORD: `Fx${hex(16)}`,
};
// The per-run ACL file holds only the SHA-256 of the per-run random password: `#<sha256>` is the hashed form Redis's ACL
// file format defines (the same form as the Infrastructure template users.acl.example), so no clear-text password is ever
// written. CodeQL js/insufficient-password-hash flags this SHA-256: a documented false positive (the hash format is fixed
// by Redis, the password is 24 random bytes per run, the Redis is a throwaway with no published port), left open for the
// owner, not silenced. The file lives in a private mkdtemp directory removed at the end; `ops` stays disabled.
const SECRETS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'crewflow-s-rehearsal-'));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const APP_PERMS = 'resetkeys ~* resetchannels &* +@all -@admin -@dangerous +info +client|setname +client|getname +client|id +client|info +client|list -flushall -flushdb -keys -swapdb';
fs.writeFileSync(path.join(SECRETS_DIR, 'redis-users.acl'), [
  `user default off resetpass ${APP_PERMS}`,
  `user crewflow on #${sha(SECRETS.S_REDIS_PASSWORD)} ${APP_PERMS}`,
  'user healthcheck on nopass resetkeys resetchannels -@all +ping',
  'user ops off resetpass resetkeys ~* resetchannels -@all +ping +info',
  '',
].join('\n'), { mode: 0o644 }); // 0644 is acceptable: hashes only; read by the redis user (uid 999) through the bind mount; the mkdtemp directory is private and removed afterwards

const [, imageRepo, imageDigest] = DIGEST_REF.exec(process.env.S_IMAGE);
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DATABASE_|TEST_|CREWFLOW_|REDIS_URL|DB_TARGET|PG_|COMPOSE_)/.test(k)));
const ENV = {
  ...BASE_ENV,
  ...SECRETS,
  CREWFLOW_IMAGE_REPOSITORY: imageRepo,
  CREWFLOW_IMAGE_TAG: imageDigest,
  CREWFLOW_REDIS_IMAGE: process.env.S_REDIS_IMAGE,
  CREWFLOW_REDIS_CONF: path.resolve(process.env.S_REDIS_CONF).replace(/\\/g, '/'),
  CREWFLOW_SECRETS_DIR: SECRETS_DIR.replace(/\\/g, '/'),
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
// An empty --env-file: compose must not read a developer's packages/rab-docker/.env for interpolation.
const EMPTY_ENV_FILE = path.join(SECRETS_DIR, 'empty.env');
fs.writeFileSync(EMPTY_ENV_FILE, '');
const files = (extra = []) => ['--env-file', EMPTY_ENV_FILE, '-p', PROJECT, '--project-directory', PROJECT_DIR, '-f', VARIANT, '-f', OVERRIDE, ...extra.flatMap((f) => ['-f', f])];
const compose = (args, opts = {}) => docker(['compose', ...files(opts.extra), ...args], opts);
const psql = (sql, opts = {}) => compose(['exec', '-T', 'pg', 'psql', '-U', 'rab', '-d', 'rab', '-v', 'ON_ERROR_STOP=1', '-qAt'], { input: sql, quiet: opts.quiet, timeout: 60_000 });
const sql1 = (sql) => psql(sql, { quiet: true }).out.trim();
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
async function step(id, title, fn) {
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
  results.push({ id, title, status, note });
  console.log(`${status.padEnd(7)} ${id} ${title}${note ? ` — ${note}` : ''}`);
  return status;
}
const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};

const containerIds = (service, extra) => compose(['ps', '-a', '-q', service], { quiet: true, extra }).out.trim().split('\n').filter(Boolean);
const containerId = (service) => containerIds(service)[0];
const inspectId = (id, format) => (id ? docker(['inspect', '-f', format, id], { quiet: true }).out.trim() : '');
const logsOf = (service, since) => compose(['logs', '--no-color', ...(since ? ['--since', since] : []), service], { quiet: true }).out;
function execIn(id, user, script, { env = {}, quiet = false, timeout = 120_000 } = {}) {
  const pass = Object.keys(env).flatMap((k) => ['-e', k]);
  const keep = Object.keys(env).map((k) => `${k}="$${k}"`).join(' ');
  return docker(['exec', '-u', user, ...pass, id, 'sh', '-c', `exec env -i PATH=/usr/local/bin:/usr/bin:/bin ${keep} sh -c '${script.replace(/'/g, `'"'"'`)}'`], { env, quiet, timeout });
}
function procTable(id) {
  const script = 'for p in /proc/[0-9]*; do u=$(awk \'/^Uid:/{print $2}\' $p/status 2>/dev/null) || continue; c=$(tr "\\0" " " < $p/cmdline 2>/dev/null); [ -n "$u" ] && echo "${p#/proc/}|$u|$c"; done';
  return execIn(id, '0:0', script, { quiet: true }).out.split('\n').filter((l) => /^\d+\|/.test(l)).map((l) => {
    const [pid, uid, ...cmd] = l.split('|');
    return { pid: Number(pid), uid: Number(uid), cmd: cmd.join('|').trim() };
  });
}
function procStatus(id, pid) {
  const r = execIn(id, '0:0', `grep -E '^(Uid|CapEff|CapBnd|CapAmb|NoNewPrivs):' /proc/${pid}/status`, { quiet: true });
  return Object.fromEntries(r.out.split('\n').map((l) => /^([A-Za-z]+):\s*(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].trim().replace(/\s+/g, ' ')]));
}
const cgroup = (id) => Object.fromEntries(execIn(id, '0:0', 'cd /sys/fs/cgroup && for f in memory.max memory.peak pids.max pids.peak cpu.max; do printf "%s=%s\\n" $f "$(cat $f 2>/dev/null)"; done', { quiet: true }).out.split('\n').filter((l) => l.includes('=')).map((l) => l.split('=')));
const isolationLine = (logs, prefix) => (new RegExp(`${prefix}[^\\n]*(runtime isolation as declared|WARNING runtime isolation weaker|REFUSED[^\\n]*runtime isolation)[^\\n]*`).exec(logs) || [''])[0];

function cleanup() {
  currentLog = path.join(OUT, '99-cleanup.log');
  compose(['--profile', '*', 'stop', '-t', '60'], { timeout: 600_000 });
  const names = docker(['ps', '-a', '--filter', `label=com.docker.compose.project=${PROJECT}`, '--format', '{{.Names}}'], { quiet: true }).out.split('\n').map((s) => s.trim()).filter((n) => n.startsWith(`${PROJECT}-`));
  if (names.length) docker(['rm', ...names]);
  write(`removed containers (exact names): ${names.join(' ') || '(none)'}; network ${PROJECT}_default left in place; no volume was created`);
  fs.rmSync(SECRETS_DIR, { recursive: true, force: true });
}
function finish() {
  const md = ['# Image compose variant: local isolated staging rehearsal', '', `- project: ${PROJECT}`, `- image: ${process.env.S_IMAGE}`,
    `- redis image: ${process.env.S_REDIS_IMAGE}`, `- redis config sha256: ${sha(fs.readFileSync(process.env.S_REDIS_CONF))}`,
    `- finished: ${new Date().toISOString()}`, '', '| id | case | result | note |', '|---|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.title} | ${r.status} | ${r.note.replace(/\|/g, '/')} |`), '', '## Measured', '', '```json', JSON.stringify(measured, null, 2), '```', ''];
  fs.writeFileSync(path.join(OUT, 'SUMMARY.md'), redact(md.join('\n')));
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    try { finish(); } finally { if (!KEEP) cleanup(); }
    process.exit(130);
  });
}

(async () => {
  write(`# image rehearsal — project ${PROJECT}\n# variant: ${path.relative(REPO, VARIANT)}\n# override: ${path.relative(REPO, OVERRIDE)}`);
  const existing = docker(['ps', '-a', '--filter', `label=com.docker.compose.project=${PROJECT}`, '--format', '{{.Names}}'], { quiet: true }).out.trim();
  if (existing) {
    console.error(`project ${PROJECT} already has containers (${existing.replace(/\n/g, ' ')}); remove them first`);
    process.exit(2);
  }
  const volumesBefore = docker(['volume', 'ls', '-q'], { quiet: true }).out.trim().split('\n').sort();
  const fx = {};

  const r00 = await step('R00', 'Static: verifier passes; the override changes no runtime security key and no image', async () => {
    const m = renderModels();
    const problems = checkVariant(m.variant, m.production, m.variantFiles);
    write(`verifier problems: ${problems.join(' | ') || 'none'}`);
    assert(problems.length === 0, `verifier: ${problems.length} problem(s)`);
    const keys = ['image', 'user', 'read_only', 'cap_drop', 'cap_add', 'security_opt', 'tmpfs', 'pids_limit', 'mem_limit', 'cpus', 'stop_grace_period', 'privileged', 'healthcheck', 'restart', 'command', 'entrypoint', 'network_mode', 'pid', 'ipc'];
    const render = (fs_) => JSON.parse(docker(['compose', '--env-file', EMPTY_ENV_FILE, '-p', `${PROJECT}-cfg`, '--project-directory', PROJECT_DIR, ...fs_.flatMap((f) => ['-f', f]), 'config', '--no-env-resolution', '--format', 'json'], { quiet: true }).stdout);
    const alone = render([VARIANT]);
    const merged = render([VARIANT, OVERRIDE]);
    const diffs = [];
    for (const svc of ['rab-api', 'rab-worker', 'rab-redis']) {
      for (const k of keys) {
        // The one documented exception: rab-redis's data directory is a tmpfs instead of a named volume (no Docker volume).
        if (svc === 'rab-redis' && k === 'tmpfs' && JSON.stringify(merged.services[svc][k]) === '["/data"]' && alone.services[svc][k] === undefined) continue;
        if (JSON.stringify(alone.services[svc][k] ?? null) !== JSON.stringify(merged.services[svc][k] ?? null)) diffs.push(`${svc}.${k}`);
      }
      // depends_on may only GAIN the throwaway infrastructure; every condition of the variant stays.
      for (const [dep, v] of Object.entries(alone.services[svc].depends_on ?? {})) {
        if (merged.services[svc].depends_on?.[dep]?.condition !== v.condition) diffs.push(`${svc}.depends_on.${dep}`);
      }
    }
    write(`images: ${['rab-api', 'rab-worker', 'rab-redis'].map((s) => `${s}=${merged.services[s].image}`).join(' ')}`);
    write(`differences in security keys: ${diffs.join(', ') || 'none'}`);
    assert(diffs.length === 0, `override changes ${diffs.join(', ')}`);
    assert(merged.services['rab-api'].environment.CREWFLOW_RUNTIME_ISOLATION === 'enforce' && merged.services['rab-worker'].environment.CREWFLOW_RUNTIME_ISOLATION === 'enforce', 'enforce not set');
    return 'verifier clean; override changes no security key, condition or image';
  });

  if (r00 !== 'PASS') {
    console.error('R00 failed: not starting anything with an unverified definition');
    finish();
    cleanup();
    process.exit(1);
  }

  await step('R01', 'Throwaway infrastructure up; Redis from the variant (reviewed config, per-run ACL)', async () => {
    // minio-init is a one-shot: `up --wait` reports an exited container as a failure, so it runs as rab-api's dependency.
    const r = compose(['up', '-d', '--wait', '--pull', 'never', 'pg', 'rab-redis', 'smtp', 'minio'], { timeout: 300_000 });
    assert(r.code === 0, 'infrastructure did not start');
    const redisImage = inspectId(containerId('rab-redis'), '{{.Config.Image}}');
    write(`rab-redis image: ${redisImage}`);
    assert(redisImage === process.env.S_REDIS_IMAGE, 'rab-redis is not the pinned image');
    return `redis ${redisImage.split('@')[1].slice(0, 19)}…`;
  });

  await step('R02', 'Redis hardening: NOAUTH unauthenticated, PING-only health user, admin denied, noeviction + AOF', async () => {
    const r = (args, env = {}) => compose(['exec', '-T', ...Object.keys(env).flatMap((k) => ['-e', k]), 'rab-redis', 'sh', '-c', args], { quiet: true, env });
    const anon = r('redis-cli ping 2>&1').out.trim();
    const health = r('redis-cli --no-auth-warning --user healthcheck --pass healthcheck ping').out.trim();
    const healthSet = r('redis-cli --no-auth-warning --user healthcheck --pass healthcheck set x 1 2>&1').out.trim();
    const auth = { RP: SECRETS.S_REDIS_PASSWORD };
    const appConfig = r('redis-cli --no-auth-warning --user crewflow --pass "$RP" config get maxmemory-policy 2>&1', auth).out.trim();
    const appInfo = r('redis-cli --no-auth-warning --user crewflow --pass "$RP" info memory | grep maxmemory_policy; redis-cli --no-auth-warning --user crewflow --pass "$RP" info persistence | grep aof_enabled', auth).out.trim();
    const defaultLogin = r('redis-cli --no-auth-warning --user default --pass "" ping 2>&1').out.trim();
    write(`anonymous PING: ${anon}\nhealthcheck PING: ${health}\nhealthcheck SET: ${healthSet}\ncrewflow CONFIG GET: ${appConfig}\ncrewflow INFO: ${appInfo}\ndefault login: ${defaultLogin}`);
    assert(/NOAUTH/.test(anon), 'unauthenticated client was not refused');
    assert(health === 'PONG', 'health user cannot PING');
    assert(/NOPERM/.test(healthSet), 'health user can write');
    assert(/NOPERM/.test(appConfig), 'application user can run CONFIG');
    assert(/maxmemory_policy:noeviction/.test(appInfo) && /aof_enabled:1/.test(appInfo), 'noeviction / AOF not in effect');
    assert(/WRONGPASS|NOAUTH|disabled/i.test(defaultLogin), 'default user can log in');
    return 'NOAUTH / PING-only / NOPERM CONFIG / noeviction / AOF on / default disabled';
  });

  await step('R03', 'Guarded migrations via the variant\'s rab-migrate (deploy-prepare, approval token, phases A and B)', async () => {
    // O3: there is no rab-migrate in docker-compose.image.yml; the API migrates on start (R04). Not reworked yet.
    if (!fx.o3ReleaseStep) return { status: 'BLOCKED', note: 'O3: no rab-migrate (the API migrates on start); this step needs the O3 / owner-login rework' };
    const run = (name, env) => {
      const r = compose(['run', '--rm', '--no-deps', '--pull', 'never', ...Object.keys(env).flatMap((k) => ['-e', k]), 'rab-migrate'], { env, timeout: 900_000 });
      const token = (/approval token for exactly this set: (pending-\d+-[0-9a-f]{64})/.exec(r.out) || [])[1];
      const pending = Number((/(\d+) migration\(s\) pending, in run order/.exec(r.out) || [])[1] || 0);
      measured[`migrate_${name}`] = { exit: r.code, pending };
      write(`== ${name}: exit ${r.code}, pending ${pending}, token ${token ? token.slice(0, 20) + '…' : '-'}`);
      return { ...r, token, pending };
    };
    // Two statements: a CASE with a subquery on a missing table fails at planning time, before the CASE is evaluated.
    const ledger = () => (sql1("SELECT to_regclass('core.migrations') IS NOT NULL") === 't' ? Number(sql1('SELECT count(*) FROM core.migrations')) : 0);
    const ownerUrl = 'postgres://rab_owner:rab_owner_dev_only@pg:5432/rab';
    const superUrl = `postgres://rab:${SECRETS.S_SUPERUSER_PASSWORD}@pg:5432/rab`;
    const aCheck = run('phaseA-check', { PG_DATABASE_URL: ownerUrl, CREWFLOW_MIGRATION_PHASE: 'A' });
    assert(aCheck.code === 3 && aCheck.token && ledger() === 0, `phase A check: exit ${aCheck.code}, ledger ${ledger()}`);
    const aApply = run('phaseA-apply', { PG_DATABASE_URL: ownerUrl, CREWFLOW_MIGRATION_PHASE: 'A', CREWFLOW_MIGRATION_APPROVED: aCheck.token });
    const afterA = ledger();
    measured.ledgerAfterPhaseA = afterA;
    const split = sql1("SELECT count(*) FROM core.migrations WHERE name = 'CrewflowSingleCredentialRoleArchitecture1786682000000'");
    assert(afterA > 0 && split === '0', `phase A should stop before the role split (ledger ${afterA}, split ${split}, exit ${aApply.code})`);
    const bCheck = run('phaseB-check', { PG_DATABASE_URL: superUrl, CREWFLOW_MIGRATION_PHASE: 'B' });
    assert(bCheck.code === 3 && bCheck.token && bCheck.pending > 0, `phase B check: exit ${bCheck.code}`);
    const wrong = run('phaseB-wrong-token', { PG_DATABASE_URL: superUrl, CREWFLOW_MIGRATION_PHASE: 'B', CREWFLOW_MIGRATION_APPROVED: aCheck.token, CREWFLOW_BOOTSTRAP_PASSWORD: SECRETS.S_CREWFLOW_PASSWORD, CREWFLOW_APP_BOOTSTRAP_PASSWORD: SECRETS.S_APP_PASSWORD });
    assert(wrong.code === 1 && ledger() === afterA, `a stale token was not refused (exit ${wrong.code}, ledger ${ledger()})`);
    const legacy = run('phaseB-legacy-constant', { PG_DATABASE_URL: superUrl, CREWFLOW_MIGRATION_PHASE: 'B', CREWFLOW_MIGRATION_APPROVED: 'apply-pending-migrations' });
    assert(legacy.code === 1 && ledger() === afterA, `the retired constant was not refused (exit ${legacy.code})`);
    const t0 = Date.now();
    const bApply = run('phaseB-apply', { PG_DATABASE_URL: superUrl, CREWFLOW_MIGRATION_PHASE: 'B', CREWFLOW_MIGRATION_APPROVED: bCheck.token, CREWFLOW_BOOTSTRAP_PASSWORD: SECRETS.S_CREWFLOW_PASSWORD, CREWFLOW_APP_BOOTSTRAP_PASSWORD: SECRETS.S_APP_PASSWORD });
    measured.phaseBApplyMs = Date.now() - t0;
    assert(bApply.code === 0 && /post-checks passed/.test(bApply.out), `phase B apply: exit ${bApply.code}`);
    // Final check run in a NAMED container, so its runtime settings can be inspected; removed by exact name.
    const name = `${PROJECT}-migrate-final-check`;
    const fin = compose(['run', '--name', name, '--no-deps', '--pull', 'never', 'rab-migrate'], { timeout: 300_000 });
    const hc = JSON.parse(inspectId(name, '{{json .HostConfig}}') || '{}');
    const user = inspectId(name, '{{.Config.User}}');
    const image = inspectId(name, '{{.Config.Image}}');
    docker(['rm', name]);
    measured.migrateContainer = { user, ReadonlyRootfs: hc.ReadonlyRootfs, CapDrop: hc.CapDrop, SecurityOpt: hc.SecurityOpt, Mounts: (hc.Mounts || []).map((m) => `${m.Type}:${m.Target}`), image };
    write(`final check: exit ${fin.code}\nrab-migrate container: ${JSON.stringify(measured.migrateContainer)}`);
    assert(fin.code === 0 && /schema is current/.test(fin.out), 'final check run not clean');
    assert(hc.ReadonlyRootfs === true && JSON.stringify(hc.CapDrop) === '["ALL"]' && (hc.SecurityOpt || []).includes('no-new-privileges:true') && user === '1000:1000', 'rab-migrate container not hardened');
    assert(image === process.env.S_IMAGE, 'rab-migrate did not run the image by digest');
    const ledgerInfo = sql1("SELECT count(*) || '|' || max(timestamp) || '|' || count(*) FILTER (WHERE timestamp = 1786721330000) || '|' || count(*) FILTER (WHERE timestamp > 1786719300000) FROM core.migrations");
    const [count, max, gated, afterMarker] = ledgerInfo.split('|');
    measured.ledger = { count: Number(count), max, gated: Number(gated), afterProductionMarker: Number(afterMarker) };
    write(`ledger: ${JSON.stringify(measured.ledger)}`);
    assert(gated === '0', '1786721330000 was applied');
    const roles = sql1("SELECT string_agg(rolname || ':' || rolcanlogin || ':' || rolsuper || ':' || rolbypassrls, ' ' ORDER BY rolname) FROM pg_roles WHERE rolname IN ('crewflow','crewflow_app','crewflow_worker','rab_secure_owner')");
    write(`roles: ${roles}`);
    assert(roles === 'crewflow:true:false:false crewflow_app:true:false:false crewflow_worker:true:false:false rab_secure_owner:false:false:false', 'unexpected role posture');
    return `A check 3 → apply stops at the split (${afterA}); B check 3 (${bCheck.pending} pending) → stale token 1, retired constant 1 → apply 0 (${measured.phaseBApplyMs} ms) → check 0; ledger ${count}, max ${max}, 1786721330000 absent`;
  });

  await step('R03b', 'Read-only ledger inventory (print-ledger-inventory-sql.cjs) on the migrated throwaway database', async () => {
    const { inventorySql } = require('../print-ledger-inventory-sql.cjs');
    const r = compose(['exec', '-T', '-e', 'PGOPTIONS=-c default_transaction_read_only=on', 'pg', 'psql', '-U', 'rab', '-d', 'rab', '-X', '-v', 'ON_ERROR_STOP=1', '-P', 'pager=off'], { input: inventorySql(), timeout: 120_000 });
    const summary = (/=== L1[\s\S]*?\(\d+ rows?\)/.exec(r.out) || [''])[0];
    measured.inventory = summary.split('\n').filter((l) => /\|/.test(l)).map((l) => l.trim());
    assert(r.code === 0, 'inventory failed');
    assert(/applied\s*\|\s*250/.test(summary) && !/pending_|unknown|gated_applied/.test(summary), `unexpected inventory: ${measured.inventory.join(' / ')}`);
    assert(/t\s*\|\s*f\s*\|\s*f\s*\|\s*f\s*\|\s*f\s*\|\s*f\s*\|\s*t\s*\|\s*crewflow_app:inherit=true:set=false:admin=false\s*\|\s*0\s*\|\s*0/.test(r.out), 'crewflow_worker shape line not as expected');
    return 'applied 250, nothing pending / unknown / gated; crewflow_worker shape as reviewed; read-only session';
  });

  await step('R04', 'rab-api healthy under CREWFLOW_RUNTIME_ISOLATION=enforce (it migrates on start, O3)', async () => {
    const t0 = Date.now();
    const r = compose(['up', '-d', '--wait', '--wait-timeout', '300', '--pull', 'never', 'rab-api'], { timeout: 400_000 });
    measured.apiStartToHealthyMs = Date.now() - t0;
    const logs = logsOf('rab-api');
    write(logs.split('\n').filter((l) => /api-prestart|runtime-db-guard|Nest application successfully started|EROFS|EACCES/i.test(l)).join('\n'));
    assert(r.code === 0, 'rab-api not healthy');
    assert(inspectId(containerId('rab-api'), '{{.Config.Image}}') === process.env.S_IMAGE, 'rab-api is not the pinned image');
    const iso = isolationLine(logs, 'api-prestart: ');
    measured.apiIsolationLine = iso;
    assert(/runtime isolation as declared: uid=1000 CapBnd=0000000000000000 NoNewPrivs=1 root=read-only/.test(iso), `API isolation: ${iso || '(none)'}`);
    fx.enforceInImage = /mode=enforce/.test(iso);
    return `healthy in ${measured.apiStartToHealthyMs} ms; ${fx.enforceInImage ? 'mode=enforce reported' : 'image reports no mode (pre-enforce image: report-only)'}`;
  });

  await step('R05', 'rab-worker healthy under enforce (one process, in-process provisioning)', async () => {
    const t0 = Date.now();
    const r = compose(['up', '-d', '--wait', '--wait-timeout', '300', '--pull', 'never', 'rab-worker'], { timeout: 400_000 });
    measured.workerStartToHealthyMs = Date.now() - t0;
    const logs = logsOf('rab-worker');
    write(logs.split('\n').filter((l) => /worker-isolation\]|runtime-db-guard|rab-worker ready|workspace provisioning: in-process|EROFS|EACCES/.test(l)).join('\n'));
    assert(r.code === 0, 'rab-worker not healthy');
    assert(inspectId(containerId('rab-worker'), '{{.Config.Image}}') === process.env.S_IMAGE, 'rab-worker is not the pinned image');
    assert(/workspace provisioning: in-process on the owner login/.test(logs), 'no in-process provisioning line');
    assert(!/\[worker-bundle\]|start-worker-bundle/.test(logs), 'launcher output (the launcher is retired)');
    const iso = isolationLine(logs, '\\[worker-isolation\\] ');
    measured.workerIsolationLine = iso;
    assert(/runtime isolation as declared: uid=1000 CapBnd=0000000000000000 NoNewPrivs=1 root=read-only/.test(iso), `Worker isolation: ${iso || '(none)'}`);
    return `healthy in ${measured.workerStartToHealthyMs} ms`;
  });

  await step('R06', 'Restrictions hold: capabilities, no-new-privileges, read-only root, kernel limits', async () => {
    const api = containerId('rab-api');
    const w = containerId('rab-worker');
    const t = procTable(w);
    const pid = (uid, re) => t.find((p) => p.uid === uid && re.test(p.cmd) && !/\b(docker-init|tini)\b/.test(p.cmd))?.pid;
    const procs = {
      'rab-api pid1': procStatus(api, 1),
      'rab-worker pid1': procStatus(w, 1),
      'rab-worker jobs': procStatus(w, pid(1000, /rab-worker\/dist\/main\.js/)),
    };
    const hc = (id) => { const h = JSON.parse(inspectId(id, '{{json .HostConfig}}')); return { ReadonlyRootfs: h.ReadonlyRootfs, Privileged: h.Privileged, CapDrop: h.CapDrop, CapAdd: h.CapAdd, SecurityOpt: h.SecurityOpt, PidsLimit: h.PidsLimit, MemoryMiB: h.Memory / 1048576, Cpus: h.NanoCpus / 1e9, Tmpfs: Object.keys(h.Tmpfs || {}), PortBindings: h.PortBindings, Binds: h.Binds }; };
    const hosts = { 'rab-api': hc(api), 'rab-worker': hc(w) };
    const erofs = {
      'rab-api uid 1000 /app': execIn(api, '1000:1000', 'touch /app/.s-probe 2>&1; echo rc=$?', { quiet: true }).out.trim(),
      'rab-worker jobs /': execIn(w, '1000:1000', 'touch /.s-probe 2>&1; echo rc=$?', { quiet: true }).out.trim(),
      'rab-worker jobs own tmpfs': execIn(w, '1000:1000', 'touch /tmp/crewflow-jobs/.s-probe && rm /tmp/crewflow-jobs/.s-probe; echo rc=$?', { quiet: true }).out.trim(),
    };
    const limits = { 'rab-api': cgroup(api), 'rab-worker': cgroup(w) };
    measured.restrictions = { procs, hosts, erofs, limits };
    write(JSON.stringify(measured.restrictions, null, 2));
    const zero = '0000000000000000';
    for (const k of ['rab-api pid1', 'rab-worker pid1', 'rab-worker jobs']) {
      assert(procs[k].CapEff === zero && procs[k].CapAmb === zero && procs[k].NoNewPrivs === '1', `${k}: CapEff ${procs[k].CapEff} NoNewPrivs ${procs[k].NoNewPrivs}`);
      assert(procs[k].CapBnd === zero, `${k} CapBnd ${procs[k].CapBnd} (O1: no capability anywhere)`);
    }
    for (const [n, h] of Object.entries(hosts)) {
      assert(h.ReadonlyRootfs === true && h.Privileged === false && JSON.stringify(h.CapDrop) === '["ALL"]' && (h.SecurityOpt || []).includes('no-new-privileges:true'), `${n} host config`);
      assert(h.PidsLimit > 0 && h.MemoryMiB > 0 && h.Cpus > 0, `${n} limits`);
      assert(!h.Binds || h.Binds.length === 0, `${n} bind mounts`);
      assert(!h.PortBindings || Object.keys(h.PortBindings).length === 0, `${n} publishes a port`);
    }
    assert(/Read-only file system[\s\S]*rc=1/.test(erofs['rab-api uid 1000 /app']) && /Read-only file system[\s\S]*rc=1/.test(erofs['rab-worker jobs /']), 'root filesystem writable');
    assert(/rc=0/.test(erofs['rab-worker jobs own tmpfs']), 'the Worker cannot use its own tmpfs');
    assert(!hosts['rab-worker'].CapAdd || hosts['rab-worker'].CapAdd.length === 0, `rab-worker CapAdd ${JSON.stringify(hosts['rab-worker'].CapAdd)}`);
    assert(limits['rab-api']['pids.max'] === '256' && limits['rab-worker']['pids.max'] === '1024', 'PID limits not applied by the kernel');
    return `API and Worker CapBnd 0, NNP=1 everywhere, EROFS, pids.max 256/1024, memory.max ${(Number(limits['rab-api']['memory.max']) / 1048576).toFixed(0)}/${(Number(limits['rab-worker']['memory.max']) / 1048576).toFixed(0)} MiB`;
  });

  await step('R07', 'Report PDF rendered by the Worker lands in MinIO; PostgreSQL stores the reference only', async () => {
    // Credentials travel in the docker CLI's environment (`-e NAME` without a value), never on its command line.
    const cli = (name, dbUrl, env, args) => {
      const all = {
        NODE_ENV: 'development', RAB_RUNTIME_ENV: 'development', DB_TARGET: 'local', DATABASE_URL: dbUrl,
        REDIS_URL: `redis://crewflow:${SECRETS.S_REDIS_PASSWORD}@rab-redis:6379`, APP_SECRET: SECRETS.S_APP_SECRET,
        APP_URL: 'http://127.0.0.1:5173', ACCOUNTS_URL: 'http://127.0.0.1:5173', CORS_ORIGINS: 'http://127.0.0.1:5173',
        EMAIL_DRIVER: 'LOGGER', STORAGE_DRIVER: 'LOCAL', PUSH_ENABLED: 'false', ...env,
      };
      return docker(['run', '--rm', '--name', `${PROJECT}-${name}`, '--network', `${PROJECT}_default`, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pull', 'never',
        ...Object.keys(all).flatMap((k) => ['-e', k]), '--entrypoint', 'node', process.env.S_SEED_IMAGE, 'packages/rab-server/dist/command/main.js', ...args], { timeout: 300_000, env: all });
    };
    const admin = 'platform-admin@staging-rehearsal.invalid';
    const boot = cli('bootstrap', `postgres://crewflow:${SECRETS.S_CREWFLOW_PASSWORD}@pg:5432/rab`, { BOOTSTRAP_ADMIN_EMAIL: admin, BOOTSTRAP_ADMIN_ORG_SLUG: 's-platform' }, ['bootstrap-admin']);
    assert(boot.code === 0 && /Platform Admin bootstrapped/.test(boot.out), 'bootstrap-admin failed');
    const seed = cli('seed', `postgres://crewflow_app:${SECRETS.S_APP_PASSWORD}@pg:5432/rab`, { SEED_QA_PASSWORD: SECRETS.S_FIXTURE_PASSWORD }, ['seed-qa', '--admin-email', admin]);
    assert(/Seeded QA fixture/.test(seed.out), 'seed-qa fixture failed');
    const ids = sql1(`SELECT v.id || '|' || v.organisation_id || '|' || v.workspace_id || '|' || (SELECT id FROM core.job_role WHERE organisation_id = v.organisation_id LIMIT 1) || '|' || (SELECT id FROM core."user" WHERE email = 'manager.qa@example.test') FROM core.venue v WHERE v.name = 'ADOLPHUS QA Venue' LIMIT 1`).split('|');
    const [venueId, orgId, wsId, jobRoleId, managerId] = ids;
    const shiftId = sql1(`SELECT set_config('rab.organisation_id','${orgId}',false); INSERT INTO core.shift(organisation_id, workspace_id, venue_id, job_role_id, starts_at, ends_at, required_count, pay_rate_pence, status, created_by, published_at)
      VALUES ('${orgId}', '${wsId}', '${venueId}', '${jobRoleId}', now() + interval '20 minutes', now() + interval '4 hours', 1, 1200, 'open', '${managerId}', now()) RETURNING id;`).split('\n').pop();
    write(`fixture shift ${shiftId} (organisation ${orgId})`);
    compose(['restart', '-t', '60', 'rab-worker']); // the scheduler runs its first cycle at start
    await waitFor('report ready', () => /^ready\|true$/.test(sql1(`SELECT status || '|' || (pre_shift_pdf_generated_at IS NOT NULL) FROM core.shift_report WHERE shift_id = '${shiftId}'`)), 300_000, 3000);
    const file = sql1(`SELECT sf.status || '|' || coalesce(sf.size_bytes::text,'?') || '|' || sf.object_key FROM core.stored_file sf WHERE sf.organisation_id = '${orgId}' AND sf.mime_type = 'application/pdf' ORDER BY sf.created_at DESC LIMIT 1`);
    const [status, size, key] = file.split('|');
    const cols = sql1("SELECT string_agg(data_type, ' ') FROM information_schema.columns WHERE table_schema = 'core' AND table_name = 'stored_file'");
    const obj = compose(['exec', '-T', 'minio', 'sh', '-c', `mc alias set s http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; mc stat --json "s/s-rehearsal/${key}" | head -c 400; echo; mc cat "s/s-rehearsal/${key}" | head -c 5`], { quiet: true });
    write(`stored_file: ${status} ${size} ${key}\nobject: ${obj.out}`);
    measured.pdf = { status, sizeBytes: Number(size), worker: cgroup(containerId('rab-worker')) };
    assert(!/bytea/.test(cols), 'stored_file has a bytea column');
    assert(status === 'AVAILABLE' && Number(size) > 1000, `stored_file ${status} ${size}`);
    assert(/"status":"success"/.test(obj.out) && /%PDF-/.test(obj.out), 'PDF object not in MinIO');
    return `PDF ${size} bytes in MinIO (key in PostgreSQL); Worker memory.peak ${(Number(measured.pdf.worker['memory.peak']) / 1048576).toFixed(0)} MiB, pids.peak ${measured.pdf.worker['pids.peak']}`;
  });

  await step('R08', 'Enforce refuses a weakened container (rab-api writable root; rab-worker without no-new-privileges)', async () => {
    const outcome = {};
    for (const [service, wait] of [['rab-api', 25_000], ['rab-worker', 40_000]]) {
      const name = `${PROJECT}-weakened-${service}`;
      docker(['compose', ...files([WEAKENED]), 'run', '-d', '--name', name, '--no-deps', '--pull', 'never', service]);
      await sleep(wait);
      const state = inspectId(name, '{{.State.Status}}|{{.State.ExitCode}}');
      const logs = docker(['logs', name], { quiet: true }).out;
      docker(['stop', '-t', '30', name], { quiet: true });
      docker(['rm', name]);
      const line = (/(REFUSED[^\n]*runtime isolation[^\n]*|runtime isolation weaker[^\n]*|WARNING runtime isolation[^\n]*)/.exec(logs) || [''])[0];
      outcome[service] = { state, line };
      write(`${service}: state ${state}\n${line}`);
    }
    measured.weakened = outcome;
    // Refused = never running, exit 64 (API) / 1 (the Worker's startup refusal), and the refusal names the enforce mode.
    const refused = (o) => /^(exited|restarting)\|(64|1)$/.test(o.state) && /CREWFLOW_RUNTIME_ISOLATION=enforce/.test(o.line);
    if (refused(outcome['rab-api']) && refused(outcome['rab-worker'])) return 'both refused to start under enforce';
    const reportOnly = (o) => /WARNING runtime isolation weaker[^\n]*starting anyway/.test(o.line) && !/mode=/.test(o.line);
    if (reportOnly(outcome['rab-api']) && reportOnly(outcome['rab-worker'])) {
      return { status: 'BLOCKED', note: 'the images predate the enforce mode (report-only: each WARNING names the removed control and starts anyway); needs release images with Agent D\'s CREWFLOW_RUNTIME_ISOLATION change' };
    }
    throw new Error(`unexpected: ${JSON.stringify(outcome)}`);
  });

  const volumesAfter = docker(['volume', 'ls', '-q'], { quiet: true }).out.trim().split('\n').sort();
  measured.volumesCreated = volumesAfter.filter((v) => !volumesBefore.includes(v));
  finish();
  if (!KEEP) cleanup();
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n${results.filter((r) => r.status === 'PASS').length} passed, ${failed} failed, ${results.filter((r) => r.status === 'BLOCKED').length} blocked; volumes created: ${measured.volumesCreated.length}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(redact(e.stack || e.message));
  try { finish(); } finally { if (!KEEP) cleanup(); }
  process.exit(1);
});
