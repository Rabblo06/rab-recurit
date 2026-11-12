#!/usr/bin/env node
/*
 * Shell-level tests for the API start: packages/rab-docker/rab/api-prestart.sh (the image's API command since Phase B P7)
 * and packages/rab-docker/rab/start.sh (retired as a migrating entrypoint; now only delegates to api-prestart.sh), and for
 * the Worker start, packages/rab-docker/rab/worker-start.sh (DB-SETUP: derive the crewflow_owner URL, swap, exec).
 *
 * Runs the REAL scripts with the image's shell (BusyBox sh in node:24-alpine, same base as the production image) inside a
 * throwaway container per case. Every node entrypoint they could call is replaced by a stub mounted at its real path,
 * INCLUDING the migration entrypoints (setup-db.js, deploy-prepare.js, the retired prestart-migrate.js) and the
 * bootstrap-admin command, so the tests prove the API start never runs any of them. No database, no network, no secrets.
 *
 * Usage: node packages/rab-docker/rab/api-prestart-test/run-prestart-shell-tests.cjs
 */
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const IMAGE = 'node:24-alpine';
const PRESTART = path.resolve(__dirname, '..', 'api-prestart.sh');
const START = path.resolve(__dirname, '..', 'start.sh');
const WORKER_START = path.resolve(__dirname, '..', 'worker-start.sh');
const SCRIPTS_DIR = '/app/packages/rab-server/dist/database/typeorm/scripts';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crewflow-prestart-'));
const stubs = path.join(work, 'stubs');
fs.mkdirSync(stubs);
// Each stub reports the environment it actually received, from the kernel's view, then exits with the code in /ctl/<name>.
// DB-SETUP: also the CA path it got, whether the ADMIN sentinel is in its own kernel environment (admin=) and in PID 1's
// (admin1=; in this harness PID 1 is the script itself until it execs) — present|absent, the value is never printed — and a
// short hash of its PG_DATABASE_URL.
const stub = (name) => `
const fs = require('fs');
const keys = (p) => fs.readFileSync(p, 'utf8').split('\\0').filter(Boolean).map((kv) => kv.split('=')[0]).sort();
const code = Number((() => { try { return fs.readFileSync('/ctl/${name}', 'utf8'); } catch { return '0'; } })());
const raw = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const admin = raw('/proc/self/environ').includes('ADMINSENTINEL') ? 'present' : 'absent';
const admin1 = raw('/proc/1/environ').includes('ADMINSENTINEL') ? 'present' : 'absent';
const url = require('crypto').createHash('sha256').update(process.env.PG_DATABASE_URL || '').digest('hex').slice(0, 12);
console.log('STUB ${name} pid=' + process.pid + ' ppid=' + process.ppid + ' t=' + process.hrtime.bigint() + ' upgrade=' + (process.env.CREWFLOW_UPGRADE_INCOMPLETE || '-') + ' ca=' + (process.env.PG_SSL_CA_CERT_PATH || '-') + ' admin=' + admin + ' admin1=' + admin1 + ' url=' + url + ' self=' + keys('/proc/self/environ').join(',') + ' pid1=' + keys('/proc/1/environ').join(','));
process.exit(code);
`;
const STUBS = {
  check: `${SCRIPTS_DIR}/check-pending-migrations.js`,
  main: '/app/packages/rab-server/dist/main.js',
  // Must never run from the API start:
  migrate: `${SCRIPTS_DIR}/prestart-migrate.js`,
  setupdb: `${SCRIPTS_DIR}/setup-db.js`,
  deployprepare: `${SCRIPTS_DIR}/deploy-prepare.js`,
  command: '/app/packages/rab-server/dist/command/main.js',
  // O3 C2: the one-shot job scheduler registration (the image carries the Worker dist).
  register: '/app/packages/rab-worker/dist/register-schedulers.js',
  // DB-SETUP: the bootstrap child (the only admin connection) and the Worker's main (exec'd by worker-start.sh).
  bootstrap: `${SCRIPTS_DIR}/owner-login/bootstrap-owner-login.js`,
  workermain: '/app/packages/rab-worker/dist/main.js',
};
for (const name of Object.keys(STUBS)) fs.writeFileSync(path.join(stubs, `${name}.js`), stub(name));
// DB-SETUP PID 1: the image's tini (node:24-alpine has none). Like the real one it stays the process it was exec'd as (PID 1
// when the script was PID 1), runs its arguments as a CHILD, forwards TERM/INT and exits with the child's status; it
// reports whether the ADMIN sentinel is in its own kernel environment (the value is never printed).
const TINI = '/sbin/tini';
fs.writeFileSync(path.join(stubs, 'tini.sh'), [
  '#!/bin/sh',
  '[ "$1" = -s ] && shift',
  '[ "$1" = -- ] && shift',
  'adm=absent; tr "\\000" "\\n" < /proc/$$/environ | grep -q ADMINSENTINEL && adm=present',
  'pwv=absent; tr "\\000" "\\n" < /proc/$$/environ | grep -q "^PG_DATABASE_PASSWORD=" && pwv=present',
  'echo "STUB tini pid=$$ admin=$adm pgpw=$pwv argc=$#"',
  '"$@" &',
  'child=$!',
  'trap \'kill -TERM "$child" 2>/dev/null\' TERM INT',
  'wait "$child"',
  '',
].join('\n'), { mode: 0o755 });
fs.chmodSync(path.join(stubs, 'tini.sh'), 0o755);
// DB-SETUP: the derive step. Writes /ctl/derive-url (or, when absent, PG_DATABASE_URL unchanged = pass-through) to fd 4,
// exactly as derive-runtime-url.js does, unless /ctl/derive is non-zero or /ctl/derive-empty exists. Logs one line.
const DERIVE = `${SCRIPTS_DIR}/owner-login/derive-runtime-url.js`;
fs.writeFileSync(path.join(stubs, 'derive.js'), `
const fs = require('fs');
const read = (f, d) => { try { return fs.readFileSync(f, 'utf8'); } catch { return d; } };
const code = Number(read('/ctl/derive', '0'));
const admin = read('/proc/self/environ', '').includes('ADMINSENTINEL') ? 'present' : 'absent';
console.log('STUB derive pid=' + process.pid + ' t=' + process.hrtime.bigint() + ' admin=' + admin + ' ca=' + (process.env.PG_SSL_CA_CERT_PATH || '-'));
if (code === 0) fs.writeSync(4, read('/ctl/derive-empty', null) !== null ? '' : read('/ctl/derive-url', process.env.PG_DATABASE_URL || ''));
process.exit(code);
`);
// Owner-login architecture: the short-lived migrate child (Agent 1). It reports its environment like the other stubs, prints
// /ctl/migrate-result (the TWENTY_MIGRATE_RESULT line) when present, and exits with the next code of /ctl/migrate-seq
// (comma-separated; the attempt counter lives in the container's writable /tmp), so a 69-then-0 retry can be driven.
const MIGRATE_CHILD = `${SCRIPTS_DIR}/migrate/twenty/twenty-migrate.js`;
fs.writeFileSync(path.join(stubs, 'twentymigrate.js'), `
const fs = require('fs');
const keys = (p) => fs.readFileSync(p, 'utf8').split('\\0').filter(Boolean).map((kv) => kv.split('=')[0]).sort();
const read = (f, d) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return d; } };
const n = Number(read('/tmp/migrate-attempts', '0')) + 1;
// Best effort: a --read-only container (the shipped rab-api has no tmpfs) cannot keep the counter; single-code cases need none.
try { fs.writeFileSync('/tmp/migrate-attempts', String(n)); } catch {}
const seq = read('/ctl/migrate-seq', '0').split(',');
const code = Number(seq[Math.min(n, seq.length) - 1]);
console.log('STUB twentymigrate attempt=' + n + ' approval=' + (process.env.CREWFLOW_MIGRATION_APPROVED || '') + ' self=' + keys('/proc/self/environ').join(','));
const result = read('/ctl/migrate-result', '');
if (result) console.log('TWENTY_MIGRATE_RESULT ' + result);
process.exit(code);
`);

function run(name, env, { ctl = {}, entry = 'api-prestart.sh', withPrestart = true, dockerArgs = [] } = {}) {
  const ctlDir = path.join(work, `ctl-${name}`);
  fs.mkdirSync(ctlDir);
  for (const [k, v] of Object.entries(ctl)) fs.writeFileSync(path.join(ctlDir, k), String(v));
  const args = ['run', '--rm', '--network', 'none', ...dockerArgs, '-w', '/app', '-v', `${START}:/app/start.sh:ro`, '-v', `${WORKER_START}:/app/worker-start.sh:ro`];
  if (withPrestart) args.push('-v', `${PRESTART}:/app/api-prestart.sh:ro`);
  for (const [stubName, target] of Object.entries(STUBS)) args.push('-v', `${path.join(stubs, `${stubName}.js`)}:${target}:ro`);
  args.push('-v', `${path.join(stubs, 'twentymigrate.js')}:${MIGRATE_CHILD}:ro`);
  args.push('-v', `${path.join(stubs, 'derive.js')}:${DERIVE}:ro`);
  args.push('-v', `${path.join(stubs, 'tini.sh')}:${TINI}:ro`);
  args.push('-v', `${ctlDir}:/ctl:ro`);
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  const [script, ...scriptArgs] = entry.split(' ');
  args.push(IMAGE, 'sh', `/app/${script}`, ...scriptArgs);
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// Owner-login architecture: CREWFLOW_MIGRATE_ON_START is required on the API; the failure delay is 0 except where a case
// measures it.
const BASE = {
  NODE_ENV: 'production',
  APP_SECRET: 'x'.repeat(40),
  PG_DATABASE_URL: 'postgres://crewflow_owner@db/rab',
  CREWFLOW_MIGRATE_ON_START: 'false',
  CREWFLOW_STARTUP_FAILURE_DELAY_SECONDS: '0',
};
let failures = 0;
const check = (label, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${label}${cond ? '' : `\n${detail}`}`);
  if (!cond) failures++;
};
const line = (out, who) => (out.split('\n').find((l) => l.startsWith(`STUB ${who} `)) || '');
const keysOf = (l, which) => ((l.match(new RegExp(`${which}=([^ ]*)`)) || [])[1] || '').split(',').filter(Boolean);
const NEVER = ['migrate', 'setupdb', 'deployprepare', 'command'];
const noMigration = (out) => NEVER.every((n) => !line(out, n));

// 1. Default start: read-only check, then main.js as PID 1 with its environment intact. No migration entrypoint ran.
let r = run('default', BASE);
const main = line(r.out, 'main');
check('1a default start: check ran, main started (exit 0)', r.code === 0 && line(r.out, 'check') && main, r.out);
check('1b no migration / bootstrap entrypoint ran', noMigration(r.out), r.out);
// DB-SETUP PID 1: the script execs tini (PID 1 from then on), which runs main.js as its child.
const underTini = (out, who) => /STUB tini pid=1 /.test(out) && / ppid=1 /.test(line(out, who)) && !/ pid=1 /.test(line(out, who));
check('1c tini is PID 1 after exec, main.js its child, with the runtime environment', underTini(r.out, 'main') && keysOf(main, 'self').includes('APP_SECRET') && keysOf(main, 'self').includes('PG_DATABASE_URL'), r.out);

// 2. Pending migrations (the restricted check fails) -> refused, main never starts, still nothing migrates.
r = run('pending', BASE, { ctl: { check: 1 } });
check('2 schema behind the code -> exit 65, main never starts, nothing migrates', r.code === 65 && !line(r.out, 'main') && noMigration(r.out), r.out);

// 3. Any migration/bootstrap credential or approval on the api service -> refused before anything runs.
const FORBIDDEN = [
  'DATABASE_URL_UNPOOLED', 'CREWFLOW_MIGRATION_DATABASE_URL', 'CREWFLOW_PRESTART_MIGRATION_DATABASE_URL', 'CREWFLOW_PROVISIONER_DATABASE_URL',
  'CREWFLOW_BOOTSTRAP_PASSWORD', 'CREWFLOW_APP_BOOTSTRAP_PASSWORD', 'CREWFLOW_MIGRATOR_PASSWORD', 'CREWFLOW_MIGRATION_PHASE',
  'CREWFLOW_MIGRATION_APPROVED', 'ALLOW_PRODUCTION_DB_COMMANDS',
  // Security review L-4: command authority and the production identity bootstrap flag.
  'DB_TARGET', 'CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP',
  // Retired separated-mode operations variables (the removed rab-ops container): refused if present.
  'CREWFLOW_OPS_RUN', 'PG_OPS_APP_DATABASE_URL', 'CREWFLOW_OPS_ACTOR_SOURCE', 'CREWFLOW_OPS_ACTOR_ID', 'CREWFLOW_OPS_CHANGE_REF',
  // Owner-login architecture: one PG_DATABASE_URL, no role password, no mode switch, no provisioner setting on the API.
  'DATABASE_URL', 'DATABASE_DIRECT_URL', 'PG_DATABASE_REPLICA_URL', 'PG_WORKER_DATABASE_URL', 'CREWFLOW_WORKER_BOOTSTRAP_PASSWORD',
  'CREWFLOW_OWNER_PASSWORD', 'CREWFLOW_OWNER_BOOTSTRAP_PASSWORD', 'PG_DATABASE_PASSWORD', 'CREWFLOW_DB_MODE', 'CREWFLOW_PROVISIONER_ENABLED', 'CREWFLOW_PROVISIONER_ANYTHING',
  // ASSERTION CHANGE (owner decision C1, 2026-11-05): DISABLE_DB_MIGRATIONS left this list — it is accepted (case 9).
  // O3 C3: only api-prestart.sh may set CREWFLOW_UPGRADE_INCOMPLETE (after a verified exit 70); an inherited value is refused.
  'CREWFLOW_UPGRADE_INCOMPLETE',
];
// Final review F5: the approval is now a token naming the exact pending set (pending-<count>-<sha256>); a well-formed token
// is refused on the API exactly like any other value (by name), and so is the retired constant.
const APPROVAL_TOKEN = `pending-1-${'0'.repeat(64)}`;
for (const name of FORBIDDEN) {
  r = run(`forbidden-${name}`, { ...BASE, [name]: name === 'CREWFLOW_MIGRATION_APPROVED' ? APPROVAL_TOKEN : 'x' });
  check(`3 ${name} on the api service -> refused (64), nothing ran`, r.code === 64 && !line(r.out, 'check') && !line(r.out, 'main') && !line(r.out, 'bootstrap') && noMigration(r.out), r.out);
}
r = run('forbidden-legacy-approval', { ...BASE, CREWFLOW_MIGRATION_APPROVED: 'apply-pending-migrations' });
check('3 CREWFLOW_MIGRATION_APPROVED=apply-pending-migrations (retired) on the api service -> refused (64), nothing ran', r.code === 64 && !line(r.out, 'check') && !line(r.out, 'main') && noMigration(r.out), r.out);

// 4. The retired opt-in prestart migration (approval + one-time credential) is refused, not run.
r = run('old-optin', { ...BASE, CREWFLOW_MIGRATION_APPROVED: 'apply-pending-migrations', CREWFLOW_PRESTART_MIGRATION_DATABASE_URL: 'postgres://bootstrap@db/rab', DB_TARGET: 'production' });
check('4 retired opt-in prestart migration -> refused (64), no migration step', r.code === 64 && noMigration(r.out) && !line(r.out, 'main'), r.out);

// 5. start.sh (old default CMD) never migrates: it delegates to api-prestart.sh, or refuses when that is missing.
r = run('start-sh', BASE, { entry: 'start.sh' });
check('5a start.sh -> api-prestart path: check ran, main started, nothing migrated', r.code === 0 && line(r.out, 'check') && line(r.out, 'main') && noMigration(r.out), r.out);
r = run('start-sh-forbidden', { ...BASE, DATABASE_URL_UNPOOLED: 'postgres://crewflow@db/rab' }, { entry: 'start.sh' });
check('5b start.sh with a migration credential -> refused (64), nothing ran', r.code === 64 && !line(r.out, 'main') && noMigration(r.out), r.out);
r = run('start-sh-missing', BASE, { entry: 'start.sh', withPrestart: false });
check('5c start.sh without api-prestart.sh in the image -> refused (64), never falls back to migrating', r.code === 64 && !line(r.out, 'main') && noMigration(r.out), r.out);

// 6. Docker hardening H6: the isolation report. Never a refusal — it names each control the platform did not apply.
// The PID gap is host-dependent: with no --pids-limit the container's pids.max is "max" on Docker Desktop but a systemd
// TasksMax value (e.g. 17436) on GitHub runners, so the report correctly names "no PID limit" only on the former.
r = run('isolation-default', BASE, { dockerArgs: ['--pids-limit', '-1'] });
check('6a Docker defaults (root, 14 capabilities, writable root, no memory limit) -> WARNING naming each gap, still starts', r.code === 0 && line(r.out, 'main') &&
  r.out.includes('api-prestart: WARNING runtime isolation weaker than docker-compose.production.yml declares (running as root; capabilities in the bounding set (CapBnd=') &&
  /\(CapBnd=[0-9a-f]{16}\); no-new-privileges is off; root filesystem is writable(; no PID limit)?; no memory limit\): uid=0 .* pids\.max=(max|\d+) memory\.max=max /.test(r.out), r.out);
r = run('isolation-declared', BASE, { dockerArgs: ['--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '256', '--memory', '768m'] });
check('6b the production rab-api settings -> "runtime isolation as declared", no warning, starts', r.code === 0 && line(r.out, 'main') &&
  r.out.includes('api-prestart: runtime isolation as declared: uid=1000 CapBnd=0000000000000000 NoNewPrivs=1 root=read-only pids.max=256 memory.max=805306368') && !/WARNING/.test(r.out), r.out);
check('6c the report prints no environment value', !r.out.includes(BASE.APP_SECRET) && !r.out.includes(BASE.PG_DATABASE_URL), r.out);

// 7. Owner decision "never drop a security setting silently": CREWFLOW_RUNTIME_ISOLATION=enforce refuses (64) when any
// declared control is missing, before the schema check or main.js. Each case removes exactly one control.
const PROD = ['--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '256', '--memory', '768m'];
const without = (...drop) => {
  const out = [];
  for (let i = 0; i < PROD.length; i += 1) {
    if (drop.includes(PROD[i])) { if (PROD[i] !== '--read-only') i += 1; continue; }
    out.push(PROD[i]);
  }
  return out;
};
const ENFORCE = { ...BASE, CREWFLOW_RUNTIME_ISOLATION: 'enforce' };
const refusedBy = (out, re) => /api-prestart: REFUSED - runtime isolation weaker than declared and CREWFLOW_RUNTIME_ISOLATION=enforce \(/.test(out) && re.test(out);
r = run('enforce-full', ENFORCE, { dockerArgs: PROD });
check('7a enforce + every declared control -> starts, "as declared ... mode=enforce"', r.code === 0 && line(r.out, 'check') && line(r.out, 'main') &&
  r.out.includes('api-prestart: runtime isolation as declared: uid=1000 CapBnd=0000000000000000 NoNewPrivs=1 root=read-only pids.max=256 memory.max=805306368 mode=enforce'), r.out);
for (const [label, args, re] of [
  ['root user', ['--user', '0:0', ...without('--user')], /running as root/],
  ['another uid', ['--user', '1234:1234', ...without('--user')], /uid 1234, expected 1000/],
  ['capabilities kept (no cap_drop)', without('--cap-drop'), /capabilities in the bounding set \(CapBnd=[0-9a-f]{16}\)/],
  ['no-new-privileges off', without('--security-opt'), /no-new-privileges is off/],
  ['writable root (no read_only)', without('--read-only'), /root filesystem is writable/],
  ['no memory limit', without('--memory'), /no memory limit/],
]) {
  r = run(`enforce-${label.replace(/[^a-z]+/g, '-')}`, ENFORCE, { dockerArgs: args });
  check(`7b enforce + ${label} -> refused (64) naming the control; neither the schema check nor main ran`, r.code === 64 && refusedBy(r.out, re) && !line(r.out, 'check') && !line(r.out, 'main'), r.out);
}
// PID limit: Docker Desktop leaves pids.max "max" with --pids-limit -1; hosts whose systemd caps every container (GitHub
// runners: TasksMax) DO limit PIDs, so there the control is genuinely present and enforce must start.
r = run('enforce-no-pids', ENFORCE, { dockerArgs: [...without('--pids-limit'), '--pids-limit', '-1'] });
if (/pids\.max=max /.test(r.out)) {
  check('7c enforce + no PID limit -> refused (64) naming it', r.code === 64 && refusedBy(r.out, /no PID limit/) && !line(r.out, 'main'), r.out);
} else {
  check('7c enforce + no compose PID limit on a host that caps PIDs itself -> the host limit is reported and the API starts', r.code === 0 && /pids\.max=\d+ /.test(r.out) && line(r.out, 'main'), r.out);
}
for (const [n, value] of ['ENFORCE', 'Enforce', 'yes', 'true', 'strict'].entries()) {
  r = run(`isolation-invalid-${n}`, { ...BASE, CREWFLOW_RUNTIME_ISOLATION: value }, { dockerArgs: PROD });
  check(`7d CREWFLOW_RUNTIME_ISOLATION=${value} -> refused (64), nothing ran`, r.code === 64 && /api-prestart: REFUSED - CREWFLOW_RUNTIME_ISOLATION must be "warn" or "enforce"/.test(r.out) && !line(r.out, 'check') && !line(r.out, 'main'), r.out);
}
r = run('isolation-warn-explicit', { ...BASE, CREWFLOW_RUNTIME_ISOLATION: 'warn' }, { dockerArgs: without('--read-only') });
check('7e warn (explicit) + a missing control -> starts and warns, naming it', r.code === 0 && line(r.out, 'main') && /api-prestart: WARNING runtime isolation weaker than docker-compose\.production\.yml declares \(root filesystem is writable\): .* mode=warn /.test(r.out), r.out);

// 8. Owner-login architecture: the database start-up settings and the migrate-on-start child (M0 §7 exit codes).
const MIGRATE_ON = { ...BASE, CREWFLOW_MIGRATE_ON_START: 'true', CREWFLOW_MIGRATION_APPROVAL_MODE: 'none' };
const migrated = (out) => line(out, 'twentymigrate');
const RESULT = (o) => JSON.stringify({ state: 'CHAIN-PARTIAL', applied: [], pending: ['1786730000000-Broken'], ...o });
// O3 C3 (owner decision 2026-11-05): the child reports policy "continue" (CREWFLOW_UPGRADE_FAILURE, default continue).
const DEGRADED = RESULT({ exitCode: 70, serve: true, policy: 'continue', outcome: 'degradedContinue', reason: 'migration Broken1786730000000 failed: relation exists', failedMigration: 'Broken1786730000000', checks: [] });
const upgradeOf = (out) => ((line(out, 'main').match(/ upgrade=([^ ]*) /) || [])[1] || '');
const before = (out, a, b) => out.indexOf(a) >= 0 && out.indexOf(b) > out.indexOf(a);
r = run('cfg-missing', { ...BASE, CREWFLOW_MIGRATE_ON_START: '' });
check('8a CREWFLOW_MIGRATE_ON_START unset on the API -> refused (64) naming it, nothing ran', r.code === 64 && /CREWFLOW_MIGRATE_ON_START is required on the API service/.test(r.out) && !line(r.out, 'check') && !migrated(r.out) && !line(r.out, 'main'), r.out);
for (const [name, value] of [
  ['CREWFLOW_MIGRATE_ON_START', 'yes'], ['CREWFLOW_MIGRATION_APPROVAL_MODE', 'allowlist'], ['CREWFLOW_UPGRADE_FAILURE_POLICY', 'continue'],
  ['CREWFLOW_UPGRADE_FAILURE', 'maybe'], ['CREWFLOW_UPGRADE_FAILURE', 'continue-if-compatible'], ['DISABLE_DB_MIGRATIONS', 'yes'],
  ['DISABLE_CRON_JOBS_REGISTRATION', 'yes'], ['WORKER_SCHEDULER', 'cron'],
  ['CREWFLOW_STARTUP_FAILURE_DELAY_SECONDS', '301'], ['CREWFLOW_STARTUP_FAILURE_DELAY_SECONDS', '5s'],
]) {
  r = run(`cfg-bad-${name}-${value}`, { ...BASE, [name]: value });
  // The deprecated-alias refusal names the allowed values of the new name ("CREWFLOW_UPGRADE_FAILURE=continue|refuse"): that
  // documented hint is taken out before the no-echo check, which otherwise stays exactly as strict for every case.
  const echoed = r.out.split('CREWFLOW_UPGRADE_FAILURE=continue|refuse').join('').includes(`=${value}`);
  check(`8b ${name}=${value} -> refused (64), value not echoed, nothing ran`, r.code === 64 && r.out.includes(name) && !echoed && !line(r.out, 'main') && !migrated(r.out), r.out);
}
// Owner decision BC-11 (2026-11-05): the approval token is optional and off by default, production included.
r = run('cfg-prod-approval-default', { ...BASE, CREWFLOW_MIGRATE_ON_START: 'true' }, { ctl: { 'migrate-seq': '0' } });
check('8c production + migrate-on-start with NO approval mode -> accepted (none): the child runs, main starts', r.code === 0 && /approval=none/.test(r.out) && migrated(r.out) && line(r.out, 'main'), r.out);
r = run('cfg-prod-approval-token-missing', { ...BASE, CREWFLOW_MIGRATE_ON_START: 'true', CREWFLOW_MIGRATION_APPROVAL_MODE: 'token' }, { ctl: { 'migrate-seq': '0' } });
check('8c2 production + token mode: the mode reaches the child, which enforces the token (no approval value is handed over without one)', migrated(r.out) && /approval=token/.test(r.out) && /STUB twentymigrate attempt=1 approval= /.test(r.out), r.out);
r = run('cfg-prod-approval-invalid', { ...BASE, CREWFLOW_MIGRATE_ON_START: 'true', CREWFLOW_MIGRATION_APPROVAL_MODE: 'allowlist' });
check('8c3 an invalid approval mode -> refused (64), the child never ran', r.code === 64 && /CREWFLOW_MIGRATION_APPROVAL_MODE must be exactly one of: none, token/.test(r.out) && !migrated(r.out), r.out);

r = run('migrate-ok', MIGRATE_ON, { ctl: { 'migrate-seq': '0', 'migrate-result': RESULT({ exitCode: 0, serve: true }) } });
check('8d migrate-on-start, child exit 0 -> main starts under tini (PID 1); the read-only check is not needed; no retired migration entrypoint ran', r.code === 0 && migrated(r.out) && underTini(r.out, 'main') && !line(r.out, 'check') && noMigration(r.out), r.out);
r = run('migrate-70', MIGRATE_ON, { ctl: { 'migrate-seq': '70', 'migrate-result': DEGRADED } });
check('8e exit 70 + CREWFLOW_UPGRADE_FAILURE unset (default continue) + a verified result -> main starts with CREWFLOW_UPGRADE_INCOMPLETE=<failedMigration> and a loud WARNING naming the reason and the migration', r.code === 0 && line(r.out, 'main') &&
  upgradeOf(r.out) === 'Broken1786730000000' &&
  /WARNING DEGRADED START - the schema upgrade FAILED and CREWFLOW_UPGRADE_FAILURE=continue; .* reason=migration Broken1786730000000 failed: relation exists failing_migration=Broken1786730000000 state=CHAIN-PARTIAL/.test(r.out) &&
  /WARNING DEGRADED START - the upgrade FAILED at Broken1786730000000 and CREWFLOW_UPGRADE_FAILURE=continue/.test(r.out), r.out);
r = run('migrate-70-alias', { ...MIGRATE_ON, CREWFLOW_UPGRADE_FAILURE_POLICY: 'continue-if-compatible' }, { ctl: { 'migrate-seq': '70', 'migrate-result': DEGRADED } });
check('8e2 the deprecated CREWFLOW_UPGRADE_FAILURE_POLICY=continue-if-compatible means continue -> main starts degraded', r.code === 0 && upgradeOf(r.out) === 'Broken1786730000000', r.out);
for (const [label, env] of [['CREWFLOW_UPGRADE_FAILURE=refuse', { CREWFLOW_UPGRADE_FAILURE: 'refuse' }], ['deprecated CREWFLOW_UPGRADE_FAILURE_POLICY=refuse', { CREWFLOW_UPGRADE_FAILURE_POLICY: 'refuse' }]]) {
  r = run(`migrate-70-refuse-${label.length}`, { ...MIGRATE_ON, ...env }, { ctl: { 'migrate-seq': '70', 'migrate-result': DEGRADED } });
  check(`8f exit 70 while ${label} -> no start (66)`, r.code === 66 && !line(r.out, 'main'), r.out);
}
r = run('migrate-70-oldpolicy', MIGRATE_ON, { ctl: { 'migrate-seq': '70', 'migrate-result': DEGRADED.replace('"policy":"continue"', '"policy":"continue-if-compatible"') } });
check('8f2 a 70 result naming another policy (the old continue-if-compatible) is vetoed -> 66', r.code === 66 && /not a verified continue upgrade/.test(r.out) && !line(r.out, 'main'), r.out);
r = run('migrate-70-fresh', MIGRATE_ON, { ctl: { 'migrate-seq': '70', 'migrate-result': JSON.stringify({ state: 'EMPTY', exitCode: 70, serve: true, policy: 'continue', reason: 'x', failedMigration: 'Init1786000000000' }) } });
check('8g a 70 result naming a FRESH install (EMPTY) is vetoed -> 66: a fresh install never serves', r.code === 66 && /not a verified continue upgrade/.test(r.out) && !line(r.out, 'main'), r.out);
r = run('migrate-70-partial', MIGRATE_ON, { ctl: { 'migrate-seq': '70', 'migrate-result': DEGRADED.replace('"state":"CHAIN-PARTIAL"', '"state":"BOOTSTRAP-PARTIAL"') } });
check('8g2 a 70 result naming BOOTSTRAP-PARTIAL is vetoed -> 66', r.code === 66 && !line(r.out, 'main'), r.out);
r = run('migrate-70-noserve', MIGRATE_ON, { ctl: { 'migrate-seq': '70', 'migrate-result': DEGRADED.replace('"serve":true', '"serve":false') } });
check('8h a 70 result without serve:true is vetoed -> 66', r.code === 66 && !line(r.out, 'main'), r.out);
r = run('migrate-70-noname', MIGRATE_ON, { ctl: { 'migrate-seq': '70', 'migrate-result': DEGRADED.replace(',"failedMigration":"Broken1786730000000"', '') } });
check('8h2 a verified 70 without failedMigration -> main starts with CREWFLOW_UPGRADE_INCOMPLETE=unknown (the API gate then refuses: fail closed)', r.code === 0 && upgradeOf(r.out) === 'unknown', r.out);
r = run('migrate-70-badname', MIGRATE_ON, { ctl: { 'migrate-seq': '70', 'migrate-result': DEGRADED.replace('"failedMigration":"Broken1786730000000"', '"failedMigration":"x;rm -rf /"') } });
check('8h3 a failedMigration that is not a migration name is never passed on -> unknown', r.code === 0 && upgradeOf(r.out) === 'unknown' && !r.out.includes('upgrade=x;'), r.out);
// O3 T8a-TMP regression: the shipped rab-api is read_only with NO tmpfs. The failed migration's name must still reach main.js
// exactly (it used to go through a mktemp file, which failed, so main.js got "unknown" and gate 7 refused to serve).
r = run('migrate-70-readonly', MIGRATE_ON, { ctl: { 'migrate-seq': '70', 'migrate-result': DEGRADED }, dockerArgs: ['--read-only', '--user', '1000:1000'] });
check('8h6 read-only root, no tmpfs (as shipped): a verified 70 -> main.js gets CREWFLOW_UPGRADE_INCOMPLETE=<the exact failed migration>, not unknown', r.code === 0 && upgradeOf(r.out) === 'Broken1786730000000' && !/Read-only file system/.test(r.out), r.out);
r = run('migrate-70-tmpdir-unwritable', { ...MIGRATE_ON, TMPDIR: '/proc' }, { ctl: { 'migrate-seq': '70', 'migrate-result': DEGRADED } });
check('8h7 TMPDIR pointing at a non-writable directory: a verified 70 still passes the exact name', r.code === 0 && upgradeOf(r.out) === 'Broken1786730000000', r.out);
const prestartSource = fs.readFileSync(PRESTART, 'utf8');
check('8h8 api-prestart.sh writes no file: no mktemp, no /tmp path, no output redirection to a file path', !/mktemp/.test(prestartSource) && !/\/tmp\//.test(prestartSource) && !/>>?\s*"?\$?\{?[A-Za-z_]*(NOTE|FILE)/.test(prestartSource), 'api-prestart.sh still references a temporary file');
r = run('migrate-70-stream', MIGRATE_ON, { ctl: { 'migrate-seq': '70', 'migrate-result': DEGRADED } });
check('8h9 the child output still streams to the log (its own lines and the TWENTY_MIGRATE_RESULT line appear) and the machine lines never do', r.code === 0 && /STUB twentymigrate attempt=1 /.test(r.out) && /TWENTY_MIGRATE_RESULT \{/.test(r.out) && !/failed-migration=|relay-status=/.test(r.out), r.out);
r = run('migrate-0-no-upgrade-flag', MIGRATE_ON, { ctl: { 'migrate-seq': '0', 'migrate-result': RESULT({ exitCode: 0, serve: true }) } });
check('8h4 exit 0 -> main.js never receives CREWFLOW_UPGRADE_INCOMPLETE', r.code === 0 && upgradeOf(r.out) === '-' && !keysOf(line(r.out, 'main'), 'self').includes('CREWFLOW_UPGRADE_INCOMPLETE'), r.out);
r = run('inherited-upgrade-incomplete', { ...BASE, CREWFLOW_UPGRADE_INCOMPLETE: 'Broken1786730000000' });
check('8h5 an inherited CREWFLOW_UPGRADE_INCOMPLETE -> refused (64) before anything ran (only api-prestart.sh sets it)', r.code === 64 && /CREWFLOW_UPGRADE_INCOMPLETE must never be set on the api service/.test(r.out) && !line(r.out, 'check') && !line(r.out, 'main') && !line(r.out, 'register'), r.out);
r = run('migrate-66-fresh', MIGRATE_ON, { ctl: { 'migrate-seq': '66', 'migrate-result': JSON.stringify({ state: 'EMPTY', exitCode: 66, serve: false }) } });
check('8i fresh-install failure (child 66) -> no start, exit 66, main never runs', r.code === 66 && /a migration failed/.test(r.out) && !line(r.out, 'main'), r.out);
for (const code of [64, 65, 67, 68, 1]) {
  r = run(`migrate-${code}`, MIGRATE_ON, { ctl: { 'migrate-seq': String(code) } });
  check(`8j child exit ${code} -> no start, the same exit code`, r.code === code && !line(r.out, 'main'), r.out);
}
r = run('migrate-69-retry', MIGRATE_ON, { ctl: { 'migrate-seq': '69,0' } });
check('8k exit 69 (lock timeout) is retried with backoff; the second attempt succeeds -> main starts', r.code === 0 && /attempt=2/.test(r.out) && /retrying in 10s/.test(r.out) && line(r.out, 'main'), r.out);
r = run('migrate-delay', { ...MIGRATE_ON, CREWFLOW_STARTUP_FAILURE_DELAY_SECONDS: '2' }, { ctl: { 'migrate-seq': '66' } });
check('8l a failure waits CREWFLOW_STARTUP_FAILURE_DELAY_SECONDS before exiting (bounded backoff)', r.code === 66 && /waiting 2s before exiting/.test(r.out), r.out);

const TOKEN = `pending-1-${'a'.repeat(64)}`;
r = run('migrate-token', { ...MIGRATE_ON, CREWFLOW_MIGRATION_APPROVAL_MODE: 'token', CREWFLOW_MIGRATION_APPROVED: TOKEN }, { ctl: { 'migrate-seq': '0' } });
check('8m token mode: the approval reaches ONLY the migrate child; neither the scheduler registration nor main.js holds it', r.code === 0 && migrated(r.out).includes(`approval=${TOKEN}`) &&
  line(r.out, 'register') && !keysOf(line(r.out, 'register'), 'self').includes('CREWFLOW_MIGRATION_APPROVED') &&
  !keysOf(line(r.out, 'main'), 'self').includes('CREWFLOW_MIGRATION_APPROVED') && !keysOf(line(r.out, 'main'), 'pid1').includes('CREWFLOW_MIGRATION_APPROVED'), r.out);
r = run('token-none', { ...MIGRATE_ON, CREWFLOW_MIGRATION_APPROVED: TOKEN }, { ctl: { 'migrate-seq': '0' } });
check('8n an approval with CREWFLOW_MIGRATION_APPROVAL_MODE=none -> refused (64), the child never ran', r.code === 64 && !migrated(r.out), r.out);
r = run('token-no-migrate', { ...BASE, CREWFLOW_MIGRATION_APPROVAL_MODE: 'token', CREWFLOW_MIGRATION_APPROVED: TOKEN });
check('8o an approval with CREWFLOW_MIGRATE_ON_START=false -> refused (64)', r.code === 64 && !line(r.out, 'main'), r.out);
r = run('pending-no-migrate', { ...BASE }, { ctl: { check: 1 } });
check('8p CREWFLOW_MIGRATE_ON_START=false and the schema behind -> 65, the child never ran', r.code === 65 && line(r.out, 'check') && !migrated(r.out), r.out);
for (const seam of ['CREWFLOW_MIGRATION_TEST_STOP_BEFORE', 'CREWFLOW_MIGRATION_TEST_FAIL_AT', 'CREWFLOW_TEST_DEFER_SERVER_PROVISIONING']) {
  r = run(`seam-prod-${seam}`, { ...MIGRATE_ON, [seam]: '1786700000000' }, { ctl: { 'migrate-seq': '0' } });
  check(`8q ${seam} outside NODE_ENV=test -> refused (64), the migrate child never ran`, r.code === 64 && r.out.includes(`${seam} is a test seam`) && !migrated(r.out) && !line(r.out, 'main'), r.out);
}
r = run('seam-test', { ...MIGRATE_ON, NODE_ENV: 'test', CREWFLOW_MIGRATION_TEST_FAIL_AT: '1786700000000' }, { ctl: { 'migrate-seq': '0' } });
check('8r a test seam under NODE_ENV=test reaches the migrate child (it applies its own three-condition check)', r.code === 0 && migrated(r.out).includes('CREWFLOW_MIGRATION_TEST_FAIL_AT'), r.out);

// 9. O3 C1 (owner decision 2026-11-05): DISABLE_DB_MIGRATIONS=true = this process never migrates. It overrides
// CREWFLOW_MIGRATE_ON_START (which is then not required): the read-only check runs, the migrate child never does.
r = run('c1-disable-overrides', { ...MIGRATE_ON, DISABLE_DB_MIGRATIONS: 'true' }, { ctl: { 'migrate-seq': '0' } });
check('9a DISABLE_DB_MIGRATIONS=true + CREWFLOW_MIGRATE_ON_START=true -> the child never runs; the read-only check does; main starts', r.code === 0 && !migrated(r.out) && line(r.out, 'check') && line(r.out, 'main') &&
  /DISABLE_DB_MIGRATIONS=true - this process never migrates/.test(r.out), r.out);
r = run('c1-disable-no-migrate-setting', { ...BASE, CREWFLOW_MIGRATE_ON_START: '', DISABLE_DB_MIGRATIONS: 'true' });
check('9b DISABLE_DB_MIGRATIONS=true with CREWFLOW_MIGRATE_ON_START unset -> accepted (not required), check + main', r.code === 0 && line(r.out, 'check') && line(r.out, 'main') && !migrated(r.out), r.out);
r = run('c1-disable-behind', { ...BASE, DISABLE_DB_MIGRATIONS: 'true' }, { ctl: { check: 1 } });
check('9c DISABLE_DB_MIGRATIONS=true and the schema behind -> 65, nothing migrates, main never starts', r.code === 65 && !migrated(r.out) && !line(r.out, 'main'), r.out);
r = run('c1-disable-false', { ...MIGRATE_ON, DISABLE_DB_MIGRATIONS: 'false' }, { ctl: { 'migrate-seq': '0' } });
check('9d DISABLE_DB_MIGRATIONS=false + CREWFLOW_MIGRATE_ON_START=true -> the child runs as before', r.code === 0 && migrated(r.out) && line(r.out, 'main'), r.out);
r = run('c1-disable-false-unset', { ...BASE, CREWFLOW_MIGRATE_ON_START: '', DISABLE_DB_MIGRATIONS: 'false' });
check('9e DISABLE_DB_MIGRATIONS=false with CREWFLOW_MIGRATE_ON_START unset -> still required (64)', r.code === 64 && /CREWFLOW_MIGRATE_ON_START is required/.test(r.out) && !line(r.out, 'main'), r.out);

// 10. O3 C2 (owner decision 2026-11-05, like Twenty's entrypoint): the API registers every job scheduler at start-up, after
// the migrate step and before main.js, unless DISABLE_CRON_JOBS_REGISTRATION=true. A failure is a WARNING; the API starts.
r = run('c2-register-default', BASE);
check('10a production default (WORKER_SCHEDULER unset = bullmq): check, then the registration, then main.js', r.code === 0 && line(r.out, 'register') &&
  before(r.out, 'STUB check ', 'STUB register ') && before(r.out, 'STUB register ', 'STUB main ') && underTini(r.out, 'main'), r.out);
r = run('c2-register-after-migrate', MIGRATE_ON, { ctl: { 'migrate-seq': '0' } });
check('10b migrate-on-start: the migrate child, then the registration, then main.js', r.code === 0 && before(r.out, 'STUB twentymigrate ', 'STUB register ') && before(r.out, 'STUB register ', 'STUB main '), r.out);
r = run('c2-disabled', { ...BASE, DISABLE_CRON_JOBS_REGISTRATION: 'true' });
check('10c DISABLE_CRON_JOBS_REGISTRATION=true -> no registration, main starts', r.code === 0 && !line(r.out, 'register') && line(r.out, 'main') && /DISABLE_CRON_JOBS_REGISTRATION=true - job schedulers are not registered/.test(r.out), r.out);
r = run('c2-disabled-false', { ...BASE, DISABLE_CRON_JOBS_REGISTRATION: 'false' });
check('10d DISABLE_CRON_JOBS_REGISTRATION=false -> registers', r.code === 0 && line(r.out, 'register') && line(r.out, 'main'), r.out);
r = run('c2-register-fails', BASE, { ctl: { register: 1 } });
check('10e a registration failure -> a loud WARNING and the API starts anyway (exit 0)', r.code === 0 && line(r.out, 'main') && /WARNING job scheduler registration FAILED \(exit 1\) - starting the API anyway/.test(r.out), r.out);
r = run('c2-dev-interval', { ...BASE, NODE_ENV: 'development' });
check('10f development with WORKER_SCHEDULER unset (interval) -> nothing to register, main starts', r.code === 0 && !line(r.out, 'register') && line(r.out, 'main') && /WORKER_SCHEDULER=interval - each Worker runs its own timers/.test(r.out), r.out);
r = run('c2-dev-bullmq', { ...BASE, NODE_ENV: 'development', WORKER_SCHEDULER: 'bullmq' });
check('10g development with WORKER_SCHEDULER=bullmq -> registers', r.code === 0 && line(r.out, 'register') && line(r.out, 'main'), r.out);
r = run('c2-degraded-register-fails', MIGRATE_ON, { ctl: { 'migrate-seq': '70', 'migrate-result': DEGRADED, register: 1 } });
check('10h a failed upgrade (70) and a failed registration -> main still starts degraded, naming the failed migration', r.code === 0 && upgradeOf(r.out) === 'Broken1786730000000' && /registration FAILED/.test(r.out), r.out);
r = run('c2-behind-no-register', BASE, { ctl: { check: 1 } });
check('10i the schema behind (65) -> no registration either (the start is refused first)', r.code === 65 && !line(r.out, 'register'), r.out);

// 11. DB-SETUP (database setup like Twenty; DB-SETUP-PLAN §5.3): PG_DATABASE_URL is the ADMIN URL. The bootstrap child (the
// only admin connection) runs first, then the derive step; every later process (migrate child, check, scheduler registration,
// main.js as PID 1) holds ONLY the derived crewflow_owner URL: the admin sentinel is in no kernel environment of theirs.
const ADMIN_URL = 'postgres://postgres:ADMINSENTINEL1@db:5432/crewflow?sslmode=verify-full';
const RUNTIME_URL = 'postgres://crewflow_owner:derived0123@db:5432/crewflow?sslmode=verify-full';
const hash = (v) => require('node:crypto').createHash('sha256').update(v).digest('hex').slice(0, 12);
const field = (l, k) => ((l.match(new RegExp(` ${k}=([^ ]*)`)) || [])[1] || '');
const ADMIN = { ...MIGRATE_ON, PG_DATABASE_URL: ADMIN_URL };
const DERIVED = { 'migrate-seq': '0', 'derive-url': RUNTIME_URL };
r = run('dbsetup-order', ADMIN, { ctl: DERIVED });
// Order by the stubs' monotonic clock (stdout and stderr are captured separately, so text position proves nothing).
const tOf = (out, who) => BigInt(field(line(out, who), 't') || '0');
const inOrder = (out, ...who) => who.every((w) => tOf(out, w) > 0n) && who.slice(1).every((w, i) => tOf(out, who[i]) < tOf(out, w));
check('11a admin URL: bootstrap, then derive, then the migrate child, the registration and main.js (PID 1), in that order', r.code === 0 &&
  inOrder(r.out, 'bootstrap', 'derive', 'register', 'main') && line(r.out, 'twentymigrate') && underTini(r.out, 'main'), r.out);
check('11b the bootstrap child (and only it, with the pure derive step) receives the admin URL', field(line(r.out, 'bootstrap'), 'admin') === 'present' && field(line(r.out, 'bootstrap'), 'url') === hash(ADMIN_URL), r.out);
check('11c no admin URL in the kernel environment of the migrate child, the registration, main.js or PID 1 (tini) after the hand-over; they get the derived URL', !/admin=present/.test(line(r.out, 'twentymigrate')) &&
  /STUB tini pid=1 admin=absent pgpw=absent /.test(r.out) &&
  ['register', 'main'].every((w) => field(line(r.out, w), 'admin') === 'absent' && field(line(r.out, w), 'url') === hash(RUNTIME_URL)) &&
  field(line(r.out, 'main'), 'admin1') === 'absent', r.out);
check('11d PG_DATABASE_URL keeps its name (main.js reads the one variable); no admin credential variable reaches main.js', keysOf(line(r.out, 'main'), 'self').includes('PG_DATABASE_URL') && !keysOf(line(r.out, 'main'), 'self').includes('PG_DATABASE_PASSWORD') && !keysOf(line(r.out, 'main'), 'self').includes('RUNTIME_URL'), r.out);
check('11e neither the admin URL, its password nor the derived URL is ever printed', !r.out.includes('ADMINSENTINEL') && !r.out.includes('derived0123'), r.out);
r = run('dbsetup-readonly', ADMIN, { ctl: DERIVED, dockerArgs: ['--read-only', '--user', '1000:1000'] });
check('11f read-only root, uid 1000 (as shipped): the swap writes no file and main.js still gets only the derived URL', r.code === 0 && field(line(r.out, 'main'), 'url') === hash(RUNTIME_URL) && field(line(r.out, 'main'), 'admin') === 'absent', r.out);
r = run('dbsetup-check-path', { ...BASE, PG_DATABASE_URL: ADMIN_URL }, { ctl: DERIVED });
check('11g CREWFLOW_MIGRATE_ON_START=false: the read-only schema check also runs on the derived URL only', r.code === 0 && field(line(r.out, 'check'), 'admin') === 'absent' && field(line(r.out, 'check'), 'url') === hash(RUNTIME_URL), r.out);
for (const code of [64, 70, 1]) {
  r = run(`dbsetup-bootstrap-${code}`, ADMIN, { ctl: { ...DERIVED, bootstrap: code } });
  check(`11h the bootstrap child exits ${code} -> no start (exit ${code}); neither derive, the migrate child nor main.js ran`, r.code === code && !line(r.out, 'derive') && !line(r.out, 'twentymigrate') && !line(r.out, 'main') && /the database setup step (refused|failed)/.test(r.out), r.out);
}
for (const code of [64, 70]) {
  r = run(`dbsetup-derive-${code}`, ADMIN, { ctl: { ...DERIVED, derive: code } });
  check(`11i the derive step exits ${code} -> no start (exit ${code}); the migrate child and main.js never ran`, r.code === code && line(r.out, 'bootstrap') && !line(r.out, 'twentymigrate') && !line(r.out, 'main') && /could not build the crewflow_owner connection/.test(r.out), r.out);
}
r = run('dbsetup-derive-empty', ADMIN, { ctl: { ...DERIVED, 'derive-empty': '1' } });
check('11j an empty runtime URL -> refused (70), main.js never ran', r.code === 70 && /empty crewflow_owner connection/.test(r.out) && !line(r.out, 'main') && !line(r.out, 'twentymigrate'), r.out);
r = run('dbsetup-no-url', { ...MIGRATE_ON, PG_DATABASE_URL: '' });
check('11k no PG_DATABASE_URL -> refused (64) before the bootstrap child', r.code === 64 && /PG_DATABASE_URL is required/.test(r.out) && !line(r.out, 'bootstrap') && !line(r.out, 'main'), r.out);
r = run('dbsetup-passthrough', { ...MIGRATE_ON, PG_DATABASE_URL: RUNTIME_URL }, { ctl: { 'migrate-seq': '0' } });
check('11l a crewflow_owner URL (D5): the bootstrap child runs (it passes through without connecting) and main.js gets the URL byte for byte', r.code === 0 && line(r.out, 'bootstrap') && field(line(r.out, 'main'), 'url') === hash(RUNTIME_URL), r.out);
// D1 a: the bundled db's CA, only for the host `db` and only when PG_SSL_CA_CERT_PATH is unset.
const DB_CA = '/run/crewflow/db-ca/ca.crt';
for (const [label, url, extra, want] of [
  ['host db, CA unset -> the bundled CA', ADMIN_URL, {}, DB_CA],
  ['host db with a port and userinfo, CA blank -> the bundled CA', 'postgresql://postgres:p@db:5432/crewflow?sslmode=verify-full', { PG_SSL_CA_CERT_PATH: '' }, DB_CA],
  ['host db, CA set -> kept', ADMIN_URL, { PG_SSL_CA_CERT_PATH: '/run/crewflow/pg-ca.crt' }, '/run/crewflow/pg-ca.crt'],
  ['external host -> not set', 'postgresql://doadmin:p@db-direct.example:25060/defaultdb?sslmode=verify-full', {}, '-'],
  ['host db.example.com -> not set', 'postgresql://doadmin:p@db.example.com:5432/d?sslmode=verify-full', {}, '-'],
  ['host dbx -> not set', 'postgresql://doadmin:p@dbx:5432/d?sslmode=verify-full', {}, '-'],
  ['a query naming host=db does not count', 'postgresql://doadmin:p@other.example:5432/d?host=db&sslmode=verify-full', {}, '-'],
]) {
  r = run(`dbsetup-ca-${label.replace(/[^a-z]+/g, '-')}`, { ...MIGRATE_ON, PG_DATABASE_URL: url, ...extra }, { ctl: { 'migrate-seq': '0' } });
  check(`11m ${label} (bootstrap child and main.js agree)`, r.code === 0 && field(line(r.out, 'bootstrap'), 'ca') === want && field(line(r.out, 'main'), 'ca') === want, r.out);
}

// 12. DB-SETUP: worker-start.sh, the Worker's command. It never runs the bootstrap child; it derives the same URL, swaps
// it in, unsets the admin credential and execs the Worker, whose kernel environment then holds no admin URL.
const W = { NODE_ENV: 'production', APP_SECRET: 'x'.repeat(40), PG_DATABASE_URL: ADMIN_URL, DISABLE_DB_MIGRATIONS: 'true' };
r = run('worker-ok', W, { entry: 'worker-start.sh', ctl: { 'derive-url': RUNTIME_URL } });
const wm = line(r.out, 'workermain');
check('12a worker-start.sh: derive, then tini (PID 1, clean environment) runs the Worker as its child with only the derived URL; the bootstrap child never ran', r.code === 0 &&
  inOrder(r.out, 'derive', 'workermain') && underTini(r.out, 'workermain') && /STUB tini pid=1 admin=absent pgpw=absent /.test(r.out) && !line(r.out, 'bootstrap') && !line(r.out, 'main') &&
  field(wm, 'admin') === 'absent' && field(wm, 'admin1') === 'absent' && field(wm, 'url') === hash(RUNTIME_URL) && field(wm, 'ca') === DB_CA, r.out);
check('12b the Worker keeps PG_DATABASE_URL and gets no admin credential variable; nothing secret is printed', keysOf(wm, 'self').includes('PG_DATABASE_URL') && !keysOf(wm, 'self').includes('PG_DATABASE_PASSWORD') &&
  !keysOf(wm, 'self').includes('RUNTIME_URL') && !r.out.includes('ADMINSENTINEL') && !r.out.includes('derived0123'), r.out);
r = run('worker-readonly', W, { entry: 'worker-start.sh', ctl: { 'derive-url': RUNTIME_URL }, dockerArgs: ['--read-only', '--user', '1000:1000'] });
check('12c read-only root, uid 1000 (as shipped): the same swap', r.code === 0 && field(line(r.out, 'workermain'), 'url') === hash(RUNTIME_URL) && field(line(r.out, 'workermain'), 'admin') === 'absent', r.out);
r = run('worker-password', { ...W, PG_DATABASE_PASSWORD: 'x'.repeat(64) }, { entry: 'worker-start.sh', ctl: { 'derive-url': RUNTIME_URL } });
check('12d PG_DATABASE_PASSWORD on the worker service -> refused (64), nothing ran, the value is not echoed', r.code === 64 && /PG_DATABASE_PASSWORD must never be set on the worker service/.test(r.out) && !line(r.out, 'derive') && !line(r.out, 'workermain') && !r.out.includes('x'.repeat(64)), r.out);
for (const code of [64, 70]) {
  r = run(`worker-derive-${code}`, W, { entry: 'worker-start.sh', ctl: { derive: code } });
  check(`12e the derive step exits ${code} -> the Worker never starts (exit ${code})`, r.code === code && !line(r.out, 'workermain') && /could not build the crewflow_owner connection/.test(r.out), r.out);
}
r = run('worker-derive-empty', W, { entry: 'worker-start.sh', ctl: { 'derive-empty': '1' } });
check('12f an empty runtime URL -> refused (70), the Worker never starts', r.code === 70 && !line(r.out, 'workermain'), r.out);
r = run('worker-no-url', { ...W, PG_DATABASE_URL: '' }, { entry: 'worker-start.sh' });
check('12g no PG_DATABASE_URL -> refused (64)', r.code === 64 && /PG_DATABASE_URL is required/.test(r.out) && !line(r.out, 'derive') && !line(r.out, 'workermain'), r.out);
r = run('worker-passthrough', { ...W, PG_DATABASE_URL: RUNTIME_URL }, { entry: 'worker-start.sh' });
check('12h a crewflow_owner URL (D5) reaches the Worker byte for byte', r.code === 0 && field(line(r.out, 'workermain'), 'url') === hash(RUNTIME_URL), r.out);
r = run('worker-external', { ...W, PG_DATABASE_URL: 'postgresql://doadmin:ADMINSENTINEL2@db-direct.example:25060/d?sslmode=verify-full' }, { entry: 'worker-start.sh', ctl: { 'derive-url': RUNTIME_URL } });
check('12i an external host: no bundled CA is set; the admin URL still never reaches the Worker', r.code === 0 && field(line(r.out, 'workermain'), 'ca') === '-' && field(line(r.out, 'workermain'), 'admin') === 'absent', r.out);
r = run('worker-args', W, { entry: 'worker-start.sh node x.js', ctl: { 'derive-url': RUNTIME_URL } });
check('12m worker-start.sh with arguments -> refused (64), nothing ran', r.code === 64 && /takes no arguments/.test(r.out) && !line(r.out, 'derive') && !line(r.out, 'workermain') && !/STUB tini/.test(r.out), r.out);

// 13. DB-SETUP PID 1: the owner CLI one-off (`docker compose run --rm --no-deps rab-api node .../command/main.js <cmd>`):
// api-prestart.sh, the entrypoint, keeps every refusal, swaps the URL, then execs tini with the arguments. No bootstrap
// child, no migration, no registration, no API; the command runs as crewflow_owner with no admin URL anywhere.
r = run('oneoff', ADMIN, { entry: 'api-prestart.sh node /app/packages/rab-server/dist/command/main.js some:command', ctl: { 'derive-url': RUNTIME_URL } });
const cmdLine = line(r.out, 'command');
check('13a one-off: derive, then tini (PID 1, clean) runs the command as its child with only the derived URL; no bootstrap, migration, registration or API', r.code === 0 &&
  line(r.out, 'derive') && /STUB tini pid=1 admin=absent pgpw=absent argc=3/.test(r.out) && / ppid=1 /.test(cmdLine) && field(cmdLine, 'admin') === 'absent' && field(cmdLine, 'admin1') === 'absent' &&
  field(cmdLine, 'url') === hash(RUNTIME_URL) && !line(r.out, 'bootstrap') && !line(r.out, 'twentymigrate') && !line(r.out, 'check') && !line(r.out, 'register') && !line(r.out, 'main') &&
  /one-off command: running it as crewflow_owner/.test(r.out), r.out);
r = run('oneoff-forbidden', { ...ADMIN, DB_TARGET: 'production' }, { entry: 'api-prestart.sh node /app/packages/rab-server/dist/command/main.js some:command', ctl: { 'derive-url': RUNTIME_URL } });
check('13b one-off: every refusal still applies (DB_TARGET refused, 64), nothing ran', r.code === 64 && !line(r.out, 'derive') && !line(r.out, 'command') && !/STUB tini/.test(r.out), r.out);
r = run('oneoff-derive-fails', ADMIN, { entry: 'api-prestart.sh node /app/packages/rab-server/dist/command/main.js some:command', ctl: { derive: 64 } });
check('13c one-off: a failed derive step -> refused (64); the command never runs with the admin URL', r.code === 64 && !line(r.out, 'command') && !/STUB tini/.test(r.out), r.out);

// The bundled-db CA block is literally the same code in both scripts.
const block = (file) => {
  const t = fs.readFileSync(file, 'utf8');
  const a = t.indexOf('# BEGIN crewflow bundled-db CA');
  const b = t.indexOf('# END crewflow bundled-db CA');
  return a >= 0 && b > a ? t.slice(a, b) : null;
};
check('12j the bundled-db CA block is identical in api-prestart.sh and worker-start.sh', block(PRESTART) !== null && block(PRESTART) === block(WORKER_START), 'the BEGIN/END crewflow bundled-db CA blocks differ');
const workerSource = fs.readFileSync(WORKER_START, 'utf8');
check('12k worker-start.sh writes no file, never traces (set -x) and never runs the bootstrap child', !/mktemp|\/tmp\//.test(workerSource) && !/set -[a-z]*x/.test(workerSource) && !/bootstrap-owner-login/.test(workerSource), 'worker-start.sh writes a file, traces, or runs the bootstrap child');
check('12l api-prestart.sh never traces (set -x)', !/set -[a-z]*x/.test(prestartSource), 'api-prestart.sh enables tracing');

fs.rmSync(work, { recursive: true, force: true });
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
