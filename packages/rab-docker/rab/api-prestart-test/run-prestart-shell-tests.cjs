#!/usr/bin/env node
/*
 * Shell-level tests for the API start: packages/rab-docker/rab/api-prestart.sh (the image's API command since Phase B P7)
 * and packages/rab-docker/rab/start.sh (retired as a migrating entrypoint; now only delegates to api-prestart.sh), for
 * the Worker start, packages/rab-docker/rab/worker-start.sh, and for the one-shot packages/rab-docker/rab/db-setup.sh
 * (owner decision 2026-11-18, Twenty's way: rab-api and rab-worker read PG_DATABASE_URL, the crewflow_owner URL, from their
 * environment; only db-setup holds an admin login; there is no target file, password file, setup volume or derive step).
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
const DB_SETUP = path.resolve(__dirname, '..', 'db-setup.sh');
const SCRIPTS_DIR = '/app/packages/rab-server/dist/database/typeorm/scripts';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crewflow-prestart-'));
const stubs = path.join(work, 'stubs');
fs.mkdirSync(stubs);
// Each stub reports the environment it actually received, from the kernel's view, then exits with the code in /ctl/<name>.
// DB-SETUP: also the CA path it got, whether the ADMIN sentinel is in its own kernel environment (admin=) and in PID 1's
// (admin1=; in this harness PID 1 is the script itself until it execs) — present|absent, the value is never printed — and
// short hashes of its PG_DATABASE_URL (url=) and PG_ADMIN_URL (aurl=). The bootstrap-child stub writes NO file: the real
// child writes none either.
const stub = (name) => `
const fs = require('fs');
const keys = (p) => fs.readFileSync(p, 'utf8').split('\\0').filter(Boolean).map((kv) => kv.split('=')[0]).sort();
const readCtl = (f, d) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return d; } };
// /ctl/<name>-seq (comma-separated exit codes, one per run; the counter needs a writable /tmp) wins over /ctl/<name>.
const seq = readCtl('/ctl/${name}-seq', null);
let code;
if (seq !== null) {
  const n = Number(readCtl('/tmp/${name}-attempts', '0')) + 1;
  try { fs.writeFileSync('/tmp/${name}-attempts', String(n)); } catch {}
  const list = seq.split(',');
  code = Number(list[Math.min(n, list.length) - 1]);
} else code = Number(readCtl('/ctl/${name}', '0'));
const raw = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const admin = raw('/proc/self/environ').includes('ADMINSENTINEL') ? 'present' : 'absent';
const admin1 = raw('/proc/1/environ').includes('ADMINSENTINEL') ? 'present' : 'absent';
const url = require('crypto').createHash('sha256').update(process.env.PG_DATABASE_URL || '').digest('hex').slice(0, 12);
const aurl = require('crypto').createHash('sha256').update(process.env.PG_ADMIN_URL || '').digest('hex').slice(0, 12);
console.log('STUB ${name} tf=' + (process.env.CREWFLOW_DB_TARGET_FILE ? 'set' : '-') + ' pid=' + process.pid + ' ppid=' + process.ppid + ' t=' + process.hrtime.bigint() + ' upgrade=' + (process.env.CREWFLOW_UPGRADE_INCOMPLETE || '-') + ' ca=' + (process.env.PG_SSL_CA_CERT_PATH || '-') + ' admin=' + admin + ' admin1=' + admin1 + ' url=' + url + ' aurl=' + aurl + ' argv=' + (process.argv.slice(2).join('|') || '-') + ' self=' + keys('/proc/self/environ').join(',') + ' pid1=' + keys('/proc/1/environ').join(','));
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

// Owner decision 2026-11-18: no setup volume is mounted anywhere (there is none any more); `cmd` runs a shell line instead
// of a script.
function run(name, env, { ctl = {}, entry = 'api-prestart.sh', withPrestart = true, dockerArgs = [], cmd = null, execSetup = false } = {}) {
  // db-setup.sh waits for the database before the child (section 15); the harness has no database (--network none), so
  // every other db-setup case runs with CREWFLOW_DB_WAIT_SECONDS=0 (do not wait) unless it sets the variable itself.
  if ((entry.startsWith('db-setup.sh') || (cmd && cmd.includes('db-setup'))) && !Object.prototype.hasOwnProperty.call(env, 'CREWFLOW_DB_WAIT_SECONDS')) {
    env = { ...env, CREWFLOW_DB_WAIT_SECONDS: '0' };
  }
  const ctlDir = path.join(work, `ctl-${name}`);
  fs.mkdirSync(ctlDir);
  for (const [k, v] of Object.entries(ctl)) fs.writeFileSync(path.join(ctlDir, k), String(v));
  // execSetup: db-setup.sh mounted with its image mode (0555 in rab/Dockerfile), so the compose wrapper's `exec ./db-setup.sh`
  // runs it exactly as in the image (the repository file is 0644).
  let setupFile = DB_SETUP;
  if (execSetup) {
    setupFile = path.join(work, `db-setup-${name}.sh`);
    fs.copyFileSync(DB_SETUP, setupFile);
    fs.chmodSync(setupFile, 0o555);
  }
  const args = ['run', '--rm', '--network', 'none', ...dockerArgs, '-w', '/app', '-v', `${START}:/app/start.sh:ro`, '-v', `${WORKER_START}:/app/worker-start.sh:ro`, '-v', `${setupFile}:/app/db-setup.sh:ro`];
  if (withPrestart) args.push('-v', `${PRESTART}:/app/api-prestart.sh:ro`);
  for (const [stubName, target] of Object.entries(STUBS)) args.push('-v', `${path.join(stubs, `${stubName}.js`)}:${target}:ro`);
  args.push('-v', `${path.join(stubs, 'twentymigrate.js')}:${MIGRATE_CHILD}:ro`);
  args.push('-v', `${path.join(stubs, 'tini.sh')}:${TINI}:ro`);
  args.push('-v', `${ctlDir}:/ctl:ro`);
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  const [script, ...scriptArgs] = entry.split(' ');
  if (cmd) args.push(IMAGE, 'sh', '-c', cmd);
  else args.push(IMAGE, 'sh', `/app/${script}`, ...scriptArgs);
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// Owner-login architecture: CREWFLOW_MIGRATE_ON_START is required on the API; the failure delay is 0 except where a case
// measures it.
// Owner decision 2026-11-18 (Twenty's way): PG_DATABASE_URL is the crewflow_owner URL, from the environment. OWNER_PW is a
// valid bundled password (32+ of A-Z a-z 0-9 _ -), so the same URL serves db-setup's mode (a) cases too.
const OWNER_PW = `ownerpw${'0123456789abcdef'.repeat(4)}`;
const RUNTIME_URL = `postgres://crewflow_owner:${OWNER_PW}@db:5432/crewflow?sslmode=verify-full`;
const BASE = {
  NODE_ENV: 'production',
  PG_DATABASE_URL: RUNTIME_URL,
  APP_SECRET: 'x'.repeat(40),
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
  'CREWFLOW_OWNER_PASSWORD', 'CREWFLOW_OWNER_BOOTSTRAP_PASSWORD', 'PG_DATABASE_PASSWORD', 'PG_DATABASE_APP_PASSWORD', 'CREWFLOW_DB_MODE', 'CREWFLOW_PROVISIONER_ENABLED', 'CREWFLOW_PROVISIONER_ANYTHING',
  // ASSERTION CHANGE (owner decision C1, 2026-11-05): DISABLE_DB_MIGRATIONS left this list — it is accepted (case 9).
  // CREWFLOW_UPGRADE_INCOMPLETE is retired (OWNER-DB-ULTIMATE Part B3): an inherited value is refused.
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
check('6c the report prints no environment value', !r.out.includes(BASE.APP_SECRET) && !r.out.includes(OWNER_PW), r.out);

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
// OWNER-DB-ULTIMATE Part B3: exit 70 = every migration applied, only an upgrade COMMAND failed (serve with upgradeFailed:true).
const DEGRADED = JSON.stringify({ state: 'CURRENT', applied: [], pending: [], failedMigration: null, outcome: 'degradedContinue', serve: true, reason: 'upgrade command 0.6.0_FixThing_1786799990000 failed (CommandFailure); schema current', checks: [], upgrade: { codeVersion: '0.6.0', forced: false, decision: 'continue', adoptedFrom: null, recorded: [{ name: '0.6.0_FixThing_1786799990000', status: 'failed', attempt: 1 }], commandFailure: { name: '0.6.0_FixThing_1786799990000', errorName: 'CommandFailure' } }, exitCode: 70 });
const upgradeOf = (out) => ((line(out, 'main').match(/ upgrade=([^ ]*) /) || [])[1] || '');
const before = (out, a, b) => out.indexOf(a) >= 0 && out.indexOf(b) > out.indexOf(a);
r = run('cfg-missing', { ...BASE, CREWFLOW_MIGRATE_ON_START: '' });
check('8a CREWFLOW_MIGRATE_ON_START unset on the API -> refused (64) naming it, nothing ran', r.code === 64 && /CREWFLOW_MIGRATE_ON_START is required on the API service/.test(r.out) && !line(r.out, 'check') && !migrated(r.out) && !line(r.out, 'main'), r.out);
for (const [name, value] of [
  ['CREWFLOW_MIGRATE_ON_START', 'yes'], ['CREWFLOW_MIGRATION_APPROVAL_MODE', 'allowlist'], ['CREWFLOW_UPGRADE_FAILURE_POLICY', 'continue'],
  ['CREWFLOW_UPGRADE_FAILURE', 'continue'], ['CREWFLOW_UPGRADE_FAILURE', 'refuse'], ['CREWFLOW_UPGRADE_FAILURE_POLICY', 'continue-if-compatible'], ['DISABLE_DB_MIGRATIONS', 'yes'],
  ['DISABLE_CRON_JOBS_REGISTRATION', 'yes'], ['WORKER_SCHEDULER', 'cron'],
  ['CREWFLOW_STARTUP_FAILURE_DELAY_SECONDS', '301'], ['CREWFLOW_STARTUP_FAILURE_DELAY_SECONDS', '5s'],
]) {
  r = run(`cfg-bad-${name}-${value}`, { ...BASE, [name]: value });
  const echoed = r.out.includes(`=${value}`);
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
check('8e exit 70 + a verified upgrade-COMMAND failure (Part B3) -> main starts WITHOUT CREWFLOW_UPGRADE_INCOMPLETE, with a loud WARNING naming the command', r.code === 0 && line(r.out, 'main') &&
  upgradeOf(r.out) === '-' &&
  /WARNING - an upgrade COMMAND FAILED \(0\.6\.0_FixThing_1786799990000\); every migration applied, so the API serves with upgradeFailed:true/.test(r.out) &&
  /WARNING - an upgrade command failed; every migration is applied, so the API serves/.test(r.out), r.out);
r = run('migrate-70-failedmigration', MIGRATE_ON, { ctl: { 'migrate-seq': '70', 'migrate-result': DEGRADED.replace('"failedMigration":null', '"failedMigration":"Broken1786730000000"') } });
check('8f a 70 result naming a failed MIGRATION is vetoed -> 66: a failed migration never serves (Part B3)', r.code === 66 && /not a verified upgrade-command failure/.test(r.out) && !line(r.out, 'main'), r.out);
r = run('migrate-70-nocommand', MIGRATE_ON, { ctl: { 'migrate-seq': '70', 'migrate-result': DEGRADED.replace(/"commandFailure":\{[^}]*\}/, '"commandFailure":null') } });
check('8f2 a 70 result naming no failed command is vetoed -> 66', r.code === 66 && /not a verified upgrade-command failure/.test(r.out) && !line(r.out, 'main'), r.out);
r = run('migrate-70-fresh', MIGRATE_ON, { ctl: { 'migrate-seq': '70', 'migrate-result': DEGRADED.replace('"state":"CURRENT"', '"state":"EMPTY"') } });
check('8g a 70 result naming a FRESH install (EMPTY) is vetoed -> 66: a fresh install never serves', r.code === 66 && /not a verified upgrade-command failure/.test(r.out) && !line(r.out, 'main'), r.out);
r = run('migrate-70-partial', MIGRATE_ON, { ctl: { 'migrate-seq': '70', 'migrate-result': DEGRADED.replace('"state":"CURRENT"', '"state":"BOOTSTRAP-PARTIAL"') } });
check('8g2 a 70 result naming BOOTSTRAP-PARTIAL is vetoed -> 66', r.code === 66 && !line(r.out, 'main'), r.out);
r = run('migrate-70-noserve', MIGRATE_ON, { ctl: { 'migrate-seq': '70', 'migrate-result': DEGRADED.replace('"serve":true', '"serve":false') } });
check('8h a 70 result without serve:true is vetoed -> 66', r.code === 66 && !line(r.out, 'main'), r.out);
r = run('migrate-70-readonly', MIGRATE_ON, { ctl: { 'migrate-seq': '70', 'migrate-result': DEGRADED }, dockerArgs: ['--read-only', '--user', '1000:1000'] });
check('8h6 read-only root, no tmpfs (as shipped): a verified 70 still starts main.js', r.code === 0 && line(r.out, 'main') && !/Read-only file system/.test(r.out), r.out);
for (const [label, env] of [['CREWFLOW_UPGRADE_FAILURE=continue', { CREWFLOW_UPGRADE_FAILURE: 'continue' }], ['CREWFLOW_UPGRADE_FAILURE_POLICY=continue-if-compatible', { CREWFLOW_UPGRADE_FAILURE_POLICY: 'continue-if-compatible' }]]) {
  r = run(`migrate-removed-${label.length}`, { ...MIGRATE_ON, ...env }, { ctl: { 'migrate-seq': '0' } });
  check(`8h10 ${label} (removed, Part B3) -> refused (64) before the child ran`, r.code === 64 && /was removed \(OWNER-DB-ULTIMATE Part B3\)/.test(r.out) && !migrated(r.out) && !line(r.out, 'main'), r.out);
}
const prestartSource = fs.readFileSync(PRESTART, 'utf8');
check('8h8 api-prestart.sh writes no file: no mktemp, no /tmp path, no output redirection to a file path', !/mktemp/.test(prestartSource) && !/\/tmp\//.test(prestartSource) && !/>>?\s*"?\$?\{?[A-Za-z_]*(NOTE|FILE)/.test(prestartSource), 'api-prestart.sh still references a temporary file');
r = run('migrate-70-stream', MIGRATE_ON, { ctl: { 'migrate-seq': '70', 'migrate-result': DEGRADED } });
check('8h9 the child output still streams to the log (its own lines and the TWENTY_MIGRATE_RESULT line appear) and the machine lines never do', r.code === 0 && /STUB twentymigrate attempt=1 /.test(r.out) && /TWENTY_MIGRATE_RESULT \{/.test(r.out) && !/relay-status=/.test(r.out), r.out);
r = run('migrate-0-no-upgrade-flag', MIGRATE_ON, { ctl: { 'migrate-seq': '0', 'migrate-result': RESULT({ exitCode: 0, serve: true }) } });
check('8h4 exit 0 -> main.js never receives CREWFLOW_UPGRADE_INCOMPLETE', r.code === 0 && upgradeOf(r.out) === '-' && !keysOf(line(r.out, 'main'), 'self').includes('CREWFLOW_UPGRADE_INCOMPLETE'), r.out);
r = run('inherited-upgrade-incomplete', { ...BASE, CREWFLOW_UPGRADE_INCOMPLETE: 'Broken1786730000000' });
check('8h5 an inherited CREWFLOW_UPGRADE_INCOMPLETE (retired) -> refused (64) before anything ran', r.code === 64 && /CREWFLOW_UPGRADE_INCOMPLETE was retired \(OWNER-DB-ULTIMATE Part B3\)/.test(r.out) && !line(r.out, 'check') && !line(r.out, 'main') && !line(r.out, 'register'), r.out);
r = run('migrate-66-fresh', MIGRATE_ON, { ctl: { 'migrate-seq': '66', 'migrate-result': JSON.stringify({ state: 'EMPTY', exitCode: 66, serve: false }) } });
check('8i fresh-install failure (child 66) -> no start, exit 66, main never runs', r.code === 66 && /a migration failed/.test(r.out) && !line(r.out, 'main'), r.out);
r = run('migrate-66-upgrade', MIGRATE_ON, { ctl: { 'migrate-seq': '66', 'migrate-result': RESULT({ exitCode: 66, serve: false, failedMigration: 'Broken1786730000000' }) } });
check('8i2 an UPGRADE migration failure (child 66) -> no start, exit 66 (Part B3: never served), main never runs', r.code === 66 && /a migration failed: the API does not start/.test(r.out) && !line(r.out, 'main'), r.out);
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
for (const seam of ['CREWFLOW_MIGRATION_TEST_STOP_BEFORE', 'CREWFLOW_MIGRATION_TEST_FAIL_AT', 'CREWFLOW_TEST_UPGRADE_COMMANDS', 'CREWFLOW_TEST_UPGRADE_FAIL_COMMAND', 'CREWFLOW_TEST_DEFER_SERVER_PROVISIONING', 'CREWFLOW_TEST_SEARCH_PATH_TRAP']) {
  r = run(`seam-prod-${seam}`, { ...MIGRATE_ON, [seam]: '1786700000000' }, { ctl: { 'migrate-seq': '0' } });
  check(`8q ${seam} outside NODE_ENV=test -> refused (64), the migrate child never ran`, r.code === 64 && r.out.includes(`${seam} is a test seam`) && !migrated(r.out) && !line(r.out, 'main'), r.out);
}
// Security review I3: a runtime CREWFLOW_APP_VERSION must equal the image's /app/package.json version.
{
  const pkgDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'b1-pkg-'));
  const pkg = path.join(pkgDir, 'package.json');
  fs.writeFileSync(pkg, JSON.stringify({ name: 'rab', version: '0.6.0', workspaces: {} }));
  const mount = ['-v', `${pkg}:/app/package.json:ro`];
  r = run('app-version-mismatch', { ...MIGRATE_ON, CREWFLOW_APP_VERSION: '9.9.9' }, { ctl: { 'migrate-seq': '0' }, dockerArgs: mount });
  check('8s CREWFLOW_APP_VERSION differing from /app/package.json -> refused (64) before anything ran', r.code === 64 && /CREWFLOW_APP_VERSION differs from this image's release version/.test(r.out) && !migrated(r.out) && !line(r.out, 'main'), r.out);
  r = run('app-version-match', { ...MIGRATE_ON, CREWFLOW_APP_VERSION: '0.6.0' }, { ctl: { 'migrate-seq': '0', 'migrate-result': RESULT({ exitCode: 0, serve: true }) }, dockerArgs: mount });
  check('8s2 CREWFLOW_APP_VERSION equal to /app/package.json -> starts', r.code === 0 && migrated(r.out) && line(r.out, 'main'), r.out);
  fs.rmSync(pkgDir, { recursive: true, force: true });
  // Review R3: set, but no /app/package.json to verify it against -> refused (fail closed).
  r = run('app-version-no-package', { ...MIGRATE_ON, CREWFLOW_APP_VERSION: '0.6.0' }, { ctl: { 'migrate-seq': '0' } });
  check('8s3 CREWFLOW_APP_VERSION set without /app/package.json -> refused (64) before anything ran', r.code === 64 && /CREWFLOW_APP_VERSION is set but this image has no \/app\/package\.json/.test(r.out) && !migrated(r.out) && !line(r.out, 'main'), r.out);
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
check('10h a failed upgrade command (70) and a failed registration -> main still starts', r.code === 0 && line(r.out, 'main') && /registration FAILED/.test(r.out), r.out);
r = run('c2-behind-no-register', BASE, { ctl: { check: 1 } });
check('10i the schema behind (65) -> no registration either (the start is refused first)', r.code === 65 && !line(r.out, 'register'), r.out);

// 11. Owner decision 2026-11-18 (Twenty's way): rab-api READS PG_DATABASE_URL, the crewflow_owner URL, from its
// environment. api-prestart.sh refuses an empty one and one with an empty crewflow_owner password; it passes any other value
// unchanged (its login, its host shape and the role's attributes are judged by the processes: checkRuntimeLogin and the boot
// gates). There is no target file, no password file and no derive step; it never runs the bootstrap child.
const ADMIN_URL = 'postgres://postgres:ADMINSENTINEL1@db:5432/crewflow?sslmode=verify-full';
const hash = (v) => require('node:crypto').createHash('sha256').update(v).digest('hex').slice(0, 12);
const field = (l, k) => ((l.match(new RegExp(` ${k}=([^ ]*)`)) || [])[1] || '');
// Order by the stubs' monotonic clock (stdout and stderr are captured separately, so text position proves nothing).
const tOf = (out, who) => BigInt(field(line(out, who), 't') || '0');
const inOrder = (out, ...who) => who.every((w) => tOf(out, w) > 0n) && who.slice(1).every((w, i) => tOf(out, who[i]) < tOf(out, w));
const NO_FILES = (l) => !['CREWFLOW_DB_TARGET_FILE', 'PG_DATABASE_PASSWORD', 'PG_DATABASE_APP_PASSWORD', 'RUNTIME_URL', 'CREWFLOW_DB_SETUP_LOCK_TOKEN', 'CREWFLOW_DB_SETUP_FLOCK_FD'].some((k) => keysOf(l, 'self').includes(k));
r = run('url-order', MIGRATE_ON, { ctl: { 'migrate-seq': '0' } });
check('11a the migrate child, the registration and main.js (under tini) run in that order; the bootstrap child never ran', r.code === 0 &&
  before(r.out, 'STUB twentymigrate ', 'STUB register ') && inOrder(r.out, 'register', 'main') && underTini(r.out, 'main') && !line(r.out, 'bootstrap'), r.out);
check('11b every process (the registration, main.js, tini) holds exactly the given crewflow_owner URL; no admin credential anywhere', /STUB tini pid=1 admin=absent pgpw=absent /.test(r.out) &&
  ['register', 'main'].every((w) => field(line(r.out, w), 'admin') === 'absent' && field(line(r.out, w), 'url') === hash(RUNTIME_URL)), r.out);
check('11c main.js gets PG_DATABASE_URL and no target-file, lock or password variable; the password is never printed', keysOf(line(r.out, 'main'), 'self').includes('PG_DATABASE_URL') &&
  NO_FILES(line(r.out, 'main')) && !r.out.includes(OWNER_PW), r.out);
r = run('url-readonly', MIGRATE_ON, { ctl: { 'migrate-seq': '0' }, dockerArgs: ['--read-only', '--user', '1000:1000'] });
check('11d read-only root, uid 1000, no volume but the CA (as shipped): main.js gets the URL', r.code === 0 && field(line(r.out, 'main'), 'url') === hash(RUNTIME_URL) && field(line(r.out, 'main'), 'admin') === 'absent', r.out);
r = run('url-check-path', BASE);
check('11e CREWFLOW_MIGRATE_ON_START=false: the read-only schema check runs on the same URL', r.code === 0 && field(line(r.out, 'check'), 'url') === hash(RUNTIME_URL) && field(line(r.out, 'check'), 'admin') === 'absent', r.out);
for (const [label, env] of [['empty', { ...MIGRATE_ON, PG_DATABASE_URL: '' }], ['unset', Object.fromEntries(Object.entries(MIGRATE_ON).filter(([k]) => k !== 'PG_DATABASE_URL'))]]) {
  r = run(`url-${label}`, env, { ctl: { 'migrate-seq': '0' } });
  check(`11f DENIAL: PG_DATABASE_URL ${label} on rab-api -> refused (64) before anything ran (no migrate child, check, registration, API or bootstrap child)`, r.code === 64 &&
    /PG_DATABASE_URL is empty: it is the crewflow_owner URL/.test(r.out) && !migrated(r.out) && !line(r.out, 'check') && !line(r.out, 'main') && !line(r.out, 'bootstrap') && !/STUB tini/.test(r.out), r.out);
}
for (const url of ['postgresql://crewflow_owner:@db:5432/crewflow?sslmode=verify-full', 'postgres://crewflow_owner:@db-direct.example:25060/d?sslmode=verify-full']) {
  r = run(`url-empty-password-${hash(url)}`, { ...MIGRATE_ON, PG_DATABASE_URL: url }, { ctl: { 'migrate-seq': '0' } });
  check('11g DENIAL: a crewflow_owner URL with an EMPTY password (PG_DATABASE_APP_PASSWORD unset for the bundled db) -> refused (64), nothing ran', r.code === 64 &&
    /PG_DATABASE_URL has an empty crewflow_owner password/.test(r.out) && !migrated(r.out) && !line(r.out, 'main') && !/STUB tini/.test(r.out), r.out);
}
// The shell does not judge the login: every non-empty URL with a password reaches the processes unchanged, which refuse a
// non-crewflow_owner login, a pooler host or a privileged role (runtime-db-config.ts checkRuntimeLogin, the boot gates).
for (const url of ['postgresql://crewflow_owner:pw-external-0123@db-direct.example:25060/defaultdb?sslmode=verify-full', `postgres://crewflow_owner:${OWNER_PW}@db:5432/crewflow`]) {
  r = run(`url-passed-${hash(url)}`, { ...MIGRATE_ON, PG_DATABASE_URL: url }, { ctl: { 'migrate-seq': '0' } });
  check('11h a crewflow_owner URL reaches the migrate child and main.js byte for byte (no rewrite, no derive step)', r.code === 0 &&
    field(line(r.out, 'main'), 'url') === hash(url) && keysOf(migrated(r.out), 'self').includes('PG_DATABASE_URL'), r.out);
}
// Owner decision 2026-11-17: PG_ADMIN_URL never reaches rab-api (never-in-runtime-env.ts; this is the image enforcer).
for (const [label, url] of [['the bundled admin URL', ADMIN_URL], ['an external admin URL', 'postgresql://doadmin:ADMINSENTINEL2@db-direct.example:25060/d?sslmode=verify-full'], ['any non-empty value', 'ADMINSENTINEL6']]) {
  for (const entry of [undefined, 'api-prestart.sh node /app/packages/rab-server/dist/command/main.js some:command']) {
    r = run(`admin-url-${entry ? 'oneoff-' : ''}${label.replace(/[^a-z]+/g, '-')}`, { ...MIGRATE_ON, PG_ADMIN_URL: url }, { ...(entry ? { entry } : {}), ctl: { 'migrate-seq': '0' } });
    check(`11i DENIAL PG_ADMIN_URL: ${label} in rab-api's environment${entry ? ' (a one-off)' : ''} -> refused (64) before anything runs; the value is never printed`, r.code === 64 &&
      /PG_ADMIN_URL must never be set on the api service/.test(r.out) && !migrated(r.out) && !line(r.out, 'bootstrap') && !line(r.out, 'main') && !line(r.out, 'command') && !/STUB tini/.test(r.out) && !r.out.includes('ADMINSENTINEL'), r.out);
  }
}
// D1 a: the bundled db's CA, only when the URL's host is exactly `db` and PG_SSL_CA_CERT_PATH is unset or blank.
const DB_CA = '/run/crewflow/db-ca/ca.crt';
const CA_CASES = [
  ['host db, CA unset -> the bundled CA', RUNTIME_URL, {}, DB_CA],
  ['host db with a port and userinfo, CA blank -> the bundled CA', 'postgresql://crewflow_owner:p@db:5432/crewflow?sslmode=verify-full', { PG_SSL_CA_CERT_PATH: '' }, DB_CA],
  ['host db, CA set -> kept', RUNTIME_URL, { PG_SSL_CA_CERT_PATH: '/run/crewflow/pg-ca.crt' }, '/run/crewflow/pg-ca.crt'],
  // The inline CA (PEM text, one line with \n escapes) is the operator's choice: no path is added beside it (both set refuses).
  ['host db, inline PG_SSL_CA_CERT set -> path not set', RUNTIME_URL, { PG_SSL_CA_CERT: '-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----' }, '-'],
  ['external host -> not set', 'postgresql://crewflow_owner:p@db-direct.example:25060/defaultdb?sslmode=verify-full', {}, '-'],
  ['host db.example.com -> not set', 'postgresql://crewflow_owner:p@db.example.com:5432/d?sslmode=verify-full', {}, '-'],
  ['host dbx -> not set', 'postgresql://crewflow_owner:p@dbx:5432/d?sslmode=verify-full', {}, '-'],
  ['a query naming host=db does not count', 'postgresql://crewflow_owner:p@other.example:5432/d?host=db&sslmode=verify-full', {}, '-'],
];
for (const [label, url, extra, want] of CA_CASES) {
  r = run(`ca-${label.replace(/[^a-z]+/g, '-')}`, { ...MIGRATE_ON, PG_DATABASE_URL: url, ...extra }, { ctl: { 'migrate-seq': '0' } });
  check(`11j ${label} (main.js gets it)`, r.code === 0 && field(line(r.out, 'main'), 'ca') === want, r.out);
}

// 12. worker-start.sh: the same rule. It never runs the bootstrap child; it reads PG_DATABASE_URL, refuses an empty one or an
// empty password, every admin / second URL and the compose-only passwords; then tini runs the Worker as its child.
const W = { NODE_ENV: 'production', APP_SECRET: 'x'.repeat(40), PG_DATABASE_URL: RUNTIME_URL, DISABLE_DB_MIGRATIONS: 'true' };
r = run('worker-ok', W, { entry: 'worker-start.sh' });
const wm = line(r.out, 'workermain');
check('12a worker-start.sh: tini (PID 1, clean environment) runs the Worker with exactly the given URL and the bundled CA; no bootstrap child, no API', r.code === 0 &&
  underTini(r.out, 'workermain') && /STUB tini pid=1 admin=absent pgpw=absent /.test(r.out) &&
  !line(r.out, 'bootstrap') && !line(r.out, 'main') && field(wm, 'admin') === 'absent' && field(wm, 'admin1') === 'absent' && field(wm, 'url') === hash(RUNTIME_URL) && field(wm, 'ca') === DB_CA, r.out);
check('12b the Worker keeps PG_DATABASE_URL and gets no target-file, lock or password variable; nothing secret is printed', keysOf(wm, 'self').includes('PG_DATABASE_URL') && NO_FILES(wm) && !r.out.includes(OWNER_PW), r.out);
r = run('worker-readonly', W, { entry: 'worker-start.sh', dockerArgs: ['--read-only', '--user', '1000:1000'] });
check('12c read-only root, uid 1000 (as shipped): the same URL', r.code === 0 && field(line(r.out, 'workermain'), 'url') === hash(RUNTIME_URL) && field(line(r.out, 'workermain'), 'admin') === 'absent', r.out);
for (const [name, pattern] of [['PG_DATABASE_PASSWORD', /PG_DATABASE_PASSWORD must never be set on the worker service/], ['PG_DATABASE_APP_PASSWORD', /PG_DATABASE_APP_PASSWORD must never be set on the worker service/]]) {
  r = run(`worker-${name}`, { ...W, [name]: 'x'.repeat(64) }, { entry: 'worker-start.sh' });
  check(`12d ${name} on the worker service -> refused (64), nothing ran, the value is not echoed`, r.code === 64 && pattern.test(r.out) && !line(r.out, 'workermain') && !/STUB tini/.test(r.out) && !r.out.includes('x'.repeat(64)), r.out);
}
for (const [label, env] of [['empty', { ...W, PG_DATABASE_URL: '' }], ['unset', Object.fromEntries(Object.entries(W).filter(([k]) => k !== 'PG_DATABASE_URL'))]]) {
  r = run(`worker-url-${label}`, env, { entry: 'worker-start.sh' });
  check(`12e DENIAL: PG_DATABASE_URL ${label} on rab-worker -> refused (64); the Worker never starts`, r.code === 64 && /PG_DATABASE_URL is empty/.test(r.out) && !line(r.out, 'workermain') && !/STUB tini/.test(r.out), r.out);
}
r = run('worker-empty-password', { ...W, PG_DATABASE_URL: 'postgresql://crewflow_owner:@db:5432/crewflow?sslmode=verify-full' }, { entry: 'worker-start.sh' });
check('12f DENIAL: an empty crewflow_owner password -> refused (64); the Worker never starts', r.code === 64 && /PG_DATABASE_URL has an empty crewflow_owner password/.test(r.out) && !line(r.out, 'workermain'), r.out);
r = run('worker-external', { ...W, PG_DATABASE_URL: 'postgresql://crewflow_owner:pw-external-0123@db-direct.example:25060/d?sslmode=verify-full' }, { entry: 'worker-start.sh' });
check('12g an external crewflow_owner URL reaches the Worker unchanged, without the bundled CA', r.code === 0 &&
  field(line(r.out, 'workermain'), 'url') === hash('postgresql://crewflow_owner:pw-external-0123@db-direct.example:25060/d?sslmode=verify-full') && field(line(r.out, 'workermain'), 'ca') === '-', r.out);
r = run('worker-trap-prod', { ...W, CREWFLOW_TEST_SEARCH_PATH_TRAP: 'true' }, { entry: 'worker-start.sh' });
check('12h Part C2: the search_path trap seam outside NODE_ENV=test -> refused (64), nothing ran', r.code === 64 && /CREWFLOW_TEST_SEARCH_PATH_TRAP is a test seam/.test(r.out) && !line(r.out, 'workermain') && !/STUB tini/.test(r.out), r.out);
for (const [label, url] of [['the bundled admin URL', ADMIN_URL], ['an external admin URL', 'postgresql://doadmin:ADMINSENTINEL2@db-direct.example:25060/d?sslmode=verify-full']]) {
  r = run(`worker-admin-url-${label.replace(/[^a-z]+/g, '-')}`, { ...W, PG_ADMIN_URL: url }, { entry: 'worker-start.sh' });
  check(`12i DENIAL PG_ADMIN_URL: ${label} on rab-worker -> refused (64); the Worker never starts; the value is never printed`, r.code === 64 && /PG_ADMIN_URL must never be set on the worker service/.test(r.out) && !line(r.out, 'workermain') && !/STUB tini/.test(r.out) && !r.out.includes('ADMINSENTINEL'), r.out);
}
// Security review of PR #230, L-1: the admin URL under another name (the retired PG_DATABASE_ADMIN_URL, db-setup's
// CREWFLOW_BUNDLED_DB_ADMIN_URL) or ANY variable holding a postgres:// URL, on the API, the one-off and the Worker: refused
// (64) before anything runs; the value never appears in the output. PG_ADMIN_URL="" (the compose pin, L-2) is accepted.
{
  const L1_URL = 'postgresql://postgres:ADMINSENTINEL8@db:5432/crewflow?sslmode=verify-full';
  const ONE_OFF = 'api-prestart.sh node /app/packages/rab-server/dist/command/main.js bootstrap-admin';
  for (const [name, value, pattern] of [
    ['PG_DATABASE_ADMIN_URL', L1_URL, /PG_DATABASE_ADMIN_URL must never be set on the (api|worker) service/],
    ['CREWFLOW_BUNDLED_DB_ADMIN_URL', L1_URL, /CREWFLOW_BUNDLED_DB_ADMIN_URL must never be set on the (api|worker) service/],
    ['X', L1_URL, /X holds a PostgreSQL URL/],
    ['SOME_OTHER_DSN', 'POSTGRES://doadmin:ADMINSENTINEL9@db-direct.example:5432/d', /SOME_OTHER_DSN holds a PostgreSQL URL/],
    // Follow-up hardening: leading blanks / quotes, a driver prefix or suffix, a libpq keyword DSN with a password.
    ['QUOTED_DSN', ' "postgresql://postgres:ADMINSENTINEL10@db:5432/crewflow"', /QUOTED_DSN holds a PostgreSQL URL/],
    ['JDBC_DSN', 'jdbc:postgresql://db:5432/crewflow?user=postgres&password=ADMINSENTINEL11', /JDBC_DSN holds a PostgreSQL URL/],
    ['DRIVER_DSN', 'postgresql+psycopg://postgres:ADMINSENTINEL12@db:5432/crewflow', /DRIVER_DSN holds a PostgreSQL URL/],
    ['KEYWORD_DSN', 'host=db port=5432 dbname=crewflow user=postgres password=ADMINSENTINEL13 sslmode=verify-full', /KEYWORD_DSN holds a PostgreSQL URL or a libpq password DSN/],
  ]) {
    for (const [where, env, opts] of [
      ['the API', { ...MIGRATE_ON, [name]: value }, { ctl: { 'migrate-seq': '0' } }],
      ['the one-off (bootstrap-admin)', { ...MIGRATE_ON, [name]: value }, { entry: ONE_OFF }],
      ['the Worker', { ...W, [name]: value }, { entry: 'worker-start.sh' }],
    ]) {
      r = run(`l1-${name}-${where.replace(/[^a-z]+/gi, '-')}`, env, opts);
      check(`12j DENIAL L-1: ${name}=<a postgres URL> on ${where} -> refused (64) before anything runs; the value is never printed`, r.code === 64 && pattern.test(r.out) &&
        !migrated(r.out) && !line(r.out, 'main') && !line(r.out, 'workermain') && !line(r.out, 'command') && !/STUB tini/.test(r.out) && !r.out.includes('ADMINSENTINEL'), r.out);
    }
  }
  // Not a database credential: an https URL, a variable NAMED like a password, a password= with no host/dbname/user.
  r = run('l1-not-a-dsn-api', { ...BASE, SENTRY_DSN: 'https://k@o1.ingest.example/1', EMAIL_SMTP_PASSWORD: 'x'.repeat(20), NOTE_VALUE: 'password=1' });
  check('12k L-1: an https DSN, a *_PASSWORD variable and a bare password= are not refused; the API starts', r.code === 0 && Boolean(line(r.out, 'main')), r.out);
  // The refusal block is literally the same code in both entrypoints.
  const dsnBlock = (file) => { const t = fs.readFileSync(file, 'utf8'); const a1 = t.indexOf('# BEGIN crewflow database-URL refusal'); const b1 = t.indexOf('# END crewflow database-URL refusal'); return a1 >= 0 && b1 > a1 ? t.slice(a1, b1) : null; };
  check('12l the database-URL refusal block is identical in api-prestart.sh and worker-start.sh', dsnBlock(PRESTART) !== null && dsnBlock(PRESTART) === dsnBlock(WORKER_START), 'the BEGIN/END crewflow database-URL refusal blocks differ');
  r = run('l2-admin-url-pinned-empty-api', { ...BASE, PG_ADMIN_URL: '' });
  check('12m L-2: PG_ADMIN_URL="" (the compose pin) on the API is accepted; main.js starts', r.code === 0 && Boolean(line(r.out, 'main')), r.out);
  r = run('l2-admin-url-pinned-empty-worker', { ...W, PG_ADMIN_URL: '' }, { entry: 'worker-start.sh' });
  check('12m2 L-2: PG_ADMIN_URL="" (the compose pin) on the Worker is accepted; the Worker starts', r.code === 0 && Boolean(line(r.out, 'workermain')), r.out);
}
r = run('worker-args', W, { entry: 'worker-start.sh node x.js' });
check('12n worker-start.sh with arguments -> refused (64), nothing ran', r.code === 64 && /takes no arguments/.test(r.out) && !line(r.out, 'workermain') && !/STUB tini/.test(r.out), r.out);

// 13. The owner CLI one-off (`docker compose run --rm --no-deps rab-api node .../command/main.js <cmd>`): api-prestart.sh keeps
// every refusal, keeps the same PG_DATABASE_URL (from the environment: an OpenShip terminal or `run -e` works the same),
// then execs tini with the arguments.
const ONEOFF = 'api-prestart.sh node /app/packages/rab-server/dist/command/main.js some:command';
r = run('oneoff', BASE, { entry: ONEOFF });
const cmdLine = line(r.out, 'command');
check('13a one-off: tini (PID 1, clean) runs the command with exactly the given URL; no bootstrap, migration, registration or API', r.code === 0 &&
  /STUB tini pid=1 admin=absent pgpw=absent argc=3/.test(r.out) && / ppid=1 /.test(cmdLine) && field(cmdLine, 'admin') === 'absent' && field(cmdLine, 'admin1') === 'absent' &&
  field(cmdLine, 'url') === hash(RUNTIME_URL) && !line(r.out, 'bootstrap') && !line(r.out, 'twentymigrate') && !line(r.out, 'check') && !line(r.out, 'register') && !line(r.out, 'main') &&
  /one-off command: running it as crewflow_owner/.test(r.out), r.out);
for (const [name, value] of [['CREWFLOW_MIGRATION_DATABASE_URL', 'postgres://x@db/rab'], ['PG_DATABASE_PASSWORD', 'x'.repeat(40)], ['PG_DATABASE_APP_PASSWORD', 'x'.repeat(40)], ['CREWFLOW_OPS_RUN', 'one-off'], ['CREWFLOW_MIGRATION_APPROVED', `pending-1-${'0'.repeat(64)}`]]) {
  r = run(`oneoff-forbidden-${name}`, { ...BASE, [name]: value }, { entry: ONEOFF });
  check(`13b one-off: every other refusal still applies (${name} refused, 64), nothing ran`, r.code === 64 && !line(r.out, 'command') && !/STUB tini/.test(r.out), r.out);
}
r = run('oneoff-no-url', { ...BASE, PG_DATABASE_URL: '' }, { entry: ONEOFF });
check('13c one-off without PG_DATABASE_URL -> refused (64); the command never runs', r.code === 64 && /PG_DATABASE_URL is empty/.test(r.out) && !line(r.out, 'command') && !/STUB tini/.test(r.out), r.out);
// The owner CLI's per-invocation authority (DB_TARGET / ALLOW_PRODUCTION_DB_COMMANDS on `docker compose run -e`): handed to
// the one-off command only; the API start keeps refusing both (case 3).
r = run('oneoff-authority', { ...BASE, DB_TARGET: 'production', ALLOW_PRODUCTION_DB_COMMANDS: 'true' }, { entry: 'api-prestart.sh node /app/packages/rab-server/dist/command/main.js bootstrap-admin' });
check('13d one-off: DB_TARGET and ALLOW_PRODUCTION_DB_COMMANDS reach the command (and only through this path); the URL is unchanged', r.code === 0 &&
  ['DB_TARGET', 'ALLOW_PRODUCTION_DB_COMMANDS'].every((k) => keysOf(line(r.out, 'command'), 'self').includes(k)) && field(line(r.out, 'command'), 'url') === hash(RUNTIME_URL) &&
  field(line(r.out, 'command'), 'admin') === 'absent' && !line(r.out, 'bootstrap'), r.out);
r = run('api-authority', { ...BASE, DB_TARGET: 'production', ALLOW_PRODUCTION_DB_COMMANDS: 'true' });
check('13e the API start (no arguments) with DB_TARGET / ALLOW_PRODUCTION_DB_COMMANDS -> refused (64), nothing ran', r.code === 64 && !line(r.out, 'main') && !/STUB tini/.test(r.out), r.out);

// 14. db-setup.sh, the one-shot service's entrypoint and the ONLY holder of an admin login. It picks the mode (a: bundled
// superuser from CREWFLOW_BUNDLED_DB_ADMIN_URL; b: PG_ADMIN_URL; c: PG_DATABASE_URL only), runs the bootstrap child with
// PG_DATABASE_URL (always) and PG_ADMIN_URL (a, b), and starts nothing else. It writes NO file and takes no file lock.
const EXT_ADMIN = 'postgresql://doadmin:ADMINSENTINEL7@db-direct.example:25060/d?sslmode=verify-full';
const EXT_OWNER = 'postgresql://crewflow_owner:pw-external-0123@db-direct.example:25060/d?sslmode=verify-full';
const BUNDLED_ADMIN_EMPTY = 'postgresql://postgres:@db:5432/crewflow?sslmode=verify-full';
const BUNDLED = { NODE_ENV: 'production', CREWFLOW_BUNDLED_DB: '1', PG_ADMIN_URL: '', PG_DATABASE_URL: RUNTIME_URL, CREWFLOW_BUNDLED_DB_ADMIN_URL: ADMIN_URL };
const MODE_B = { NODE_ENV: 'production', CREWFLOW_BUNDLED_DB: '0', PG_ADMIN_URL: EXT_ADMIN, PG_DATABASE_URL: EXT_OWNER, CREWFLOW_BUNDLED_DB_ADMIN_URL: BUNDLED_ADMIN_EMPTY };
const MODE_C = { NODE_ENV: 'production', CREWFLOW_BUNDLED_DB: '0', PG_ADMIN_URL: '', PG_DATABASE_URL: EXT_OWNER, CREWFLOW_BUNDLED_DB_ADMIN_URL: BUNDLED_ADMIN_EMPTY };
const SETUP_RO = ['--read-only', '--user', '1000:1000'];
const boot = (out) => line(out, 'bootstrap');
r = run('setup-bundled', BUNDLED, { entry: 'db-setup.sh', dockerArgs: SETUP_RO });
check('14a mode (a): the bundled superuser URL reaches the child as PG_ADMIN_URL, with PG_DATABASE_URL (the bundled crewflow_owner URL) and the bundled CA; never under its compose name; exit 0',
  r.code === 0 && /db-setup: mode bundled/.test(r.out) && field(boot(r.out), 'admin') === 'present' && field(boot(r.out), 'aurl') === hash(ADMIN_URL) && field(boot(r.out), 'url') === hash(RUNTIME_URL) &&
  field(boot(r.out), 'ca') === DB_CA && !keysOf(boot(r.out), 'self').includes('CREWFLOW_BUNDLED_DB_ADMIN_URL') && /db-setup: done \(crewflow_owner ready for PG_DATABASE_URL\)/.test(r.out), r.out);
check('14b ... read-only root, uid 1000, NO writable volume (as shipped): db-setup needs none; no target, lock or password variable reaches the child; APP_SECRET never did; nothing secret printed',
  NO_FILES(boot(r.out)) && field(boot(r.out), 'tf') === '-' && !keysOf(boot(r.out), 'self').includes('APP_SECRET') && !r.out.includes('ADMINSENTINEL') && !r.out.includes(OWNER_PW), r.out);
check('14c db-setup.sh starts nothing else (no API, Worker, migration, tini)', !line(r.out, 'main') && !line(r.out, 'workermain') && !line(r.out, 'twentymigrate') && !/STUB tini/.test(r.out), r.out);
r = run('setup-mode-b', MODE_B, { entry: 'db-setup.sh', dockerArgs: SETUP_RO });
check('14d mode (b): PG_ADMIN_URL AND PG_DATABASE_URL both set is the normal admin mode: the child gets both, no bundled URL, no bundled CA; exit 0',
  r.code === 0 && /db-setup: mode admin/.test(r.out) && field(boot(r.out), 'aurl') === hash(EXT_ADMIN) && field(boot(r.out), 'url') === hash(EXT_OWNER) && field(boot(r.out), 'ca') === '-' &&
  !keysOf(boot(r.out), 'self').includes('CREWFLOW_BUNDLED_DB_ADMIN_URL'), r.out);
r = run('setup-mode-b-bundled-1', { ...MODE_B, CREWFLOW_BUNDLED_DB: '1' }, { entry: 'db-setup.sh', dockerArgs: SETUP_RO });
check('14d2 PG_ADMIN_URL with CREWFLOW_BUNDLED_DB=1 -> still mode admin (the bundled db runs unused); the bundled superuser URL is dropped', r.code === 0 && /db-setup: mode admin/.test(r.out) && field(boot(r.out), 'aurl') === hash(EXT_ADMIN), r.out);
r = run('setup-mode-c', MODE_C, { entry: 'db-setup.sh', dockerArgs: SETUP_RO });
check('14e mode (c): CREWFLOW_BUNDLED_DB=0 + PG_DATABASE_URL only -> the child gets only the crewflow_owner URL (no admin, no bundled URL); exit 0',
  r.code === 0 && /db-setup: mode owner/.test(r.out) && field(boot(r.out), 'url') === hash(EXT_OWNER) && field(boot(r.out), 'aurl') === hash('') && field(boot(r.out), 'admin') === 'absent' &&
  !keysOf(boot(r.out), 'self').includes('CREWFLOW_BUNDLED_DB_ADMIN_URL'), r.out);
for (const code of [64, 70, 1]) {
  r = run(`setup-bootstrap-${code}`, MODE_B, { entry: 'db-setup.sh', ctl: { bootstrap: code } });
  check(`14f the bootstrap child exits ${code} -> db-setup exits ${code} with a fixed line`, r.code === code && /the database setup step (refused|failed)/.test(r.out) && !/db-setup: done/.test(r.out), r.out);
}
for (const [label, env, entry, pattern] of [
  ['an unknown argument', MODE_B, 'db-setup.sh sh', /takes no argument, or exactly one: harden/],
  ['harden plus another argument', MODE_B, 'db-setup.sh harden now', /takes no argument, or exactly one: harden/],
  // Security review of PR #246, L2: an old compose.env with the admin URL in PG_DATABASE_URL, refused in shell before node.
  ['an admin login in PG_DATABASE_URL (mode b; an old compose.env)', { ...MODE_B, PG_DATABASE_URL: EXT_ADMIN }, 'db-setup.sh', /PG_DATABASE_URL does not log in as crewflow_owner: it is always the crewflow_owner URL/],
  ['an admin login in PG_DATABASE_URL (mode c)', { ...MODE_C, PG_DATABASE_URL: EXT_ADMIN }, 'db-setup.sh', /PG_DATABASE_URL does not log in as crewflow_owner/],
  ['an admin login in PG_DATABASE_URL (bundled)', { ...BUNDLED, PG_DATABASE_URL: ADMIN_URL }, 'db-setup.sh', /PG_DATABASE_URL does not log in as crewflow_owner/],
  ['a look-alike login (crewflow_owner2) in PG_DATABASE_URL', { ...MODE_C, PG_DATABASE_URL: EXT_OWNER.replace('crewflow_owner:', 'crewflow_owner2:') }, 'db-setup.sh', /PG_DATABASE_URL does not log in as crewflow_owner/],
  ['a PG_DATABASE_URL without userinfo', { ...MODE_C, PG_DATABASE_URL: 'postgresql://db-direct.example:25060/d?sslmode=verify-full' }, 'db-setup.sh', /PG_DATABASE_URL does not log in as crewflow_owner/],
  ['a PG_ADMIN_URL that logs in as crewflow_owner', { ...MODE_B, PG_ADMIN_URL: EXT_OWNER }, 'db-setup.sh', /PG_ADMIN_URL logs in as crewflow_owner, the app login/],
  ['an admin login in PG_DATABASE_URL (db-harden)', { ...MODE_B, PG_DATABASE_URL: EXT_ADMIN }, 'db-setup.sh harden', /db-harden: REFUSED - PG_DATABASE_URL does not log in as crewflow_owner/],
  // Owner decision M1: db-harden's bounded wait, validated in shell.
  ['a non-numeric harden timeout', { ...MODE_B, CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS: '20m' }, 'db-setup.sh harden', /CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS must be a whole number of seconds from 60 to 7200/],
  ['a harden timeout below 60 in production', { ...MODE_B, CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS: '59' }, 'db-setup.sh harden', /from 60 to 7200/],
  ['a harden timeout above 7200', { ...MODE_B, CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS: '7201' }, 'db-setup.sh harden', /from 60 to 7200/],
  ['a huge harden timeout', { ...MODE_B, CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS: '99999999999999999999' }, 'db-setup.sh harden', /from 60 to 7200/],
  ['a zero harden timeout under NODE_ENV=test', { ...MODE_B, NODE_ENV: 'test', CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS: '0' }, 'db-setup.sh harden', /from 1 to 7200/],
  ['PG_DATABASE_PASSWORD', { ...MODE_B, PG_DATABASE_PASSWORD: 'y'.repeat(64) }, 'db-setup.sh', /PG_DATABASE_PASSWORD must never reach a container but the bundled db/],
  ['PG_DATABASE_APP_PASSWORD', { ...MODE_B, PG_DATABASE_APP_PASSWORD: 'y'.repeat(64) }, 'db-setup.sh', /PG_DATABASE_APP_PASSWORD must never reach a container/],
  ['APP_SECRET (never part of a database credential)', { ...MODE_B, APP_SECRET: 'y'.repeat(64) }, 'db-setup.sh', /APP_SECRET must never reach db-setup/],
  ['a CREWFLOW_BUNDLED_DB other than 0 or 1', { ...MODE_B, CREWFLOW_BUNDLED_DB: 'yes' }, 'db-setup.sh', /CREWFLOW_BUNDLED_DB must be exactly 0/],
  ['an empty PG_DATABASE_URL', { ...MODE_B, PG_DATABASE_URL: '' }, 'db-setup.sh', /PG_DATABASE_URL is empty: it is always required/],
  ['an unset PG_DATABASE_URL', Object.fromEntries(Object.entries(MODE_B).filter(([k]) => k !== 'PG_DATABASE_URL')), 'db-setup.sh', /PG_DATABASE_URL is empty: it is always required/],
  ['an empty crewflow_owner password (PG_DATABASE_APP_PASSWORD unset)', { ...BUNDLED, PG_DATABASE_URL: 'postgresql://crewflow_owner:@db:5432/crewflow?sslmode=verify-full' }, 'db-setup.sh', /the crewflow_owner password in PG_DATABASE_URL is empty/],
  ['the bundled db without PG_DATABASE_PASSWORD (fail closed, no compose :?)', { ...BUNDLED, CREWFLOW_BUNDLED_DB_ADMIN_URL: BUNDLED_ADMIN_EMPTY }, 'db-setup.sh', /PG_DATABASE_PASSWORD is required for the bundled database/],
  ['the bundled db with no bundled URL in the definition', Object.fromEntries(Object.entries(BUNDLED).filter(([k]) => k !== 'CREWFLOW_BUNDLED_DB_ADMIN_URL')), 'db-setup.sh', /the bundled database URL is missing from this service definition/],
  ['a bundled crewflow_owner password shorter than 32', { ...BUNDLED, PG_DATABASE_URL: 'postgresql://crewflow_owner:short0123@db:5432/crewflow?sslmode=verify-full' }, 'db-setup.sh', /PG_DATABASE_APP_PASSWORD must be 32\+ characters/],
  ['a bundled crewflow_owner password with a character outside A-Z a-z 0-9 _ -', { ...BUNDLED, PG_DATABASE_URL: `postgresql://crewflow_owner:${'a'.repeat(40)}.x@db:5432/crewflow?sslmode=verify-full` }, 'db-setup.sh', /PG_DATABASE_APP_PASSWORD must be 32\+ characters/],
  ['CREWFLOW_BUNDLED_DB=0 (mode c) with a PG_DATABASE_URL still on host db', { ...MODE_C, PG_DATABASE_URL: RUNTIME_URL }, 'db-setup.sh', /CREWFLOW_BUNDLED_DB=0 \(your own database\) but PG_DATABASE_URL still names the bundled host db/],
  ['CREWFLOW_BUNDLED_DB=0 (mode b) with a PG_DATABASE_URL still on host db', { ...MODE_B, PG_DATABASE_URL: RUNTIME_URL }, 'db-setup.sh', /CREWFLOW_BUNDLED_DB=0 \(your own database\) but PG_DATABASE_URL still names the bundled host db/],
  // Owner decision 2026-11-19 / security review F6 of #259: the URL compose built from PG_DATABASE_APP_PASSWORD and
  // PG_DATABASE_HOST (set) is checked at run time; PG_ADMIN_DIRECT_URL and PG_DATABASE_SESSION_URL login rules.
  ['a built URL with a short password', { ...MODE_B, PG_DATABASE_HOST: 'db-direct.example', PG_DATABASE_URL: 'postgresql://crewflow_owner:short0123@db-direct.example:25060/d?sslmode=verify-full' }, 'db-setup.sh', /the crewflow_owner URL built from PG_DATABASE_APP_PASSWORD and PG_DATABASE_HOST/],
  ['a built URL whose host carries a brace', { ...MODE_B, PG_DATABASE_HOST: 'db{x}', PG_DATABASE_URL: `postgresql://crewflow_owner:${'a'.repeat(40)}@db{x}:25060/d?sslmode=verify-full` }, 'db-setup.sh', /is malformed/],
  ['a built URL whose port is not digits', { ...MODE_B, PG_DATABASE_HOST: 'db-direct.example', PG_DATABASE_URL: `postgresql://crewflow_owner:${'a'.repeat(40)}@db-direct.example:25x/d?sslmode=verify-full` }, 'db-setup.sh', /is malformed/],
  ['PG_ADMIN_DIRECT_URL without PG_ADMIN_URL', { ...MODE_C, PG_ADMIN_DIRECT_URL: EXT_ADMIN }, 'db-setup.sh', /PG_ADMIN_DIRECT_URL is set without PG_ADMIN_URL/],
  ['a PG_ADMIN_DIRECT_URL that logs in as crewflow_owner', { ...MODE_B, PG_ADMIN_DIRECT_URL: EXT_OWNER }, 'db-setup.sh', /PG_ADMIN_DIRECT_URL logs in as crewflow_owner/],
  ['a PG_DATABASE_SESSION_URL that is not crewflow_owner', { ...MODE_B, PG_DATABASE_SESSION_URL: EXT_ADMIN }, 'db-setup.sh', /PG_DATABASE_SESSION_URL does not log in as crewflow_owner/],
]) {
  r = run(`setup-refuse-${label.replace(/[^a-z]+/gi, '-')}`, env, { entry });
  check(`14g db-setup.sh refuses ${label} (64) before the child runs; nothing is printed of the value`, r.code === 64 && pattern.test(r.out) && !boot(r.out) &&
    !r.out.includes('y'.repeat(64)) && !r.out.includes('ADMINSENTINEL') && !r.out.includes(OWNER_PW), r.out);
}
for (const [label, env, want] of [
  ['mode b, admin on host db, CA unset -> the bundled CA', { ...MODE_B, CREWFLOW_BUNDLED_DB: '1', PG_ADMIN_URL: ADMIN_URL, PG_DATABASE_URL: RUNTIME_URL }, DB_CA],
  ['mode b, admin on host db, CA set -> kept', { ...MODE_B, CREWFLOW_BUNDLED_DB: '1', PG_ADMIN_URL: ADMIN_URL, PG_DATABASE_URL: RUNTIME_URL, PG_SSL_CA_CERT_PATH: '/run/crewflow/pg-ca.crt' }, '/run/crewflow/pg-ca.crt'],
  ['mode c, external host -> not set', MODE_C, '-'],
]) {
  r = run(`setup-ca-${label.replace(/[^a-z]+/g, '-')}`, env, { entry: 'db-setup.sh' });
  check(`14h db-setup.sh CA: ${label} (the bootstrap child gets it)`, r.code === 0 && field(boot(r.out), 'ca') === want, r.out);
}

// 16. Security review of PR #246, L2: rab-api, the owner CLI one-off and rab-worker refuse a PG_DATABASE_URL whose login is
// not crewflow_owner (a pure shell userinfo parse; an old compose.env with the admin URL there) with exit 64 BEFORE any node
// process runs. The percent-encoded underscore form of crewflow_owner is the same login and is accepted.
{
  const L2_ADMIN = 'postgresql://doadmin:ADMINSENTINEL9@db-direct.example:25060/d?sslmode=verify-full';
  const NODE_STUBS = ['check', 'main', 'register', 'command', 'workermain', 'bootstrap', 'twentymigrate'];
  const noNode = (out) => NODE_STUBS.every((n) => !line(out, n)) && !/STUB tini/.test(out);
  for (const [label, entry, env] of [
    ['rab-api', 'api-prestart.sh', { ...BASE, PG_DATABASE_URL: L2_ADMIN }],
    ['rab-api (the bundled superuser URL)', 'api-prestart.sh', { ...BASE, PG_DATABASE_URL: ADMIN_URL }],
    ['the owner CLI one-off', 'api-prestart.sh node /app/packages/rab-server/dist/command/main.js bootstrap-admin', { ...BASE, PG_DATABASE_URL: L2_ADMIN }],
    ['rab-worker', 'worker-start.sh', { ...W, PG_DATABASE_URL: L2_ADMIN }],
    ['rab-worker (no userinfo)', 'worker-start.sh', { ...W, PG_DATABASE_URL: 'postgresql://db-direct.example:25060/d?sslmode=verify-full' }],
  ]) {
    r = run(`l2-${label.replace(/[^a-z]+/gi, '-')}`, env, { entry });
    check(`16a DENIAL L2: an admin login in PG_DATABASE_URL on ${label} -> refused (64) before any node process ran; the value is never printed`,
      r.code === 64 && /PG_DATABASE_URL does not log in as crewflow_owner: it is always the crewflow_owner URL/.test(r.out) && noNode(r.out) && !r.out.includes('ADMINSENTINEL'), r.out);
  }
  const ENCODED = RUNTIME_URL.replace('crewflow_owner:', 'crewflow%5Fowner:');
  r = run('l2-encoded-api', { ...BASE, PG_DATABASE_URL: ENCODED });
  check('16b the percent-encoded crewflow%5Fowner login is crewflow_owner: rab-api starts with it unchanged', r.code === 0 && field(line(r.out, 'main'), 'url') === hash(ENCODED), r.out);
  const ENCODED_LOWER = RUNTIME_URL.replace('crewflow_owner:', 'crewflow%5fowner:');
  r = run('l2-encoded-worker', { ...W, PG_DATABASE_URL: ENCODED_LOWER }, { entry: 'worker-start.sh' });
  check('16b ... and rab-worker (lower-case %5f)', r.code === 0 && field(line(r.out, 'workermain'), 'url') === hash(ENCODED_LOWER), r.out);
  r = run('l2-encoded-setup', { ...MODE_C, PG_DATABASE_URL: EXT_OWNER.replace('crewflow_owner:', 'crewflow%5Fowner:') }, { entry: 'db-setup.sh' });
  check('16b ... and db-setup (the child decides the rest)', r.code === 0 && Boolean(boot(r.out)), r.out);
}

// 17. Owner decision M1: `db-setup.sh harden` is the one-shot db-harden service. It runs the same refusals and mode
// selection, then the child with --harden (bundled / admin modes) and the validated, exported harden timeout; mode c has no
// admin login and exits 0 without any node process; a child failure (e.g. its bounded wait timed out) is that exit code.
{
  r = run('harden-bundled', BUNDLED, { entry: 'db-setup.sh harden', dockerArgs: SETUP_RO });
  check('17a db-harden, bundled: the child runs with --harden, the bundled admin as PG_ADMIN_URL, the default timeout exported; exit 0',
    r.code === 0 && /db-harden: mode bundled/.test(r.out) && field(boot(r.out), 'argv') === '--harden' && field(boot(r.out), 'aurl') === hash(ADMIN_URL) &&
    keysOf(boot(r.out), 'self').includes('CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS') && /db-harden: done/.test(r.out) && !r.out.includes('ADMINSENTINEL') && !r.out.includes(OWNER_PW), r.out);
  r = run('harden-mode-b', { ...MODE_B, CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS: '300' }, { entry: 'db-setup.sh harden' });
  check('17b db-harden, mode b with a valid timeout: the child runs with --harden and your admin URL; exit 0', r.code === 0 && field(boot(r.out), 'argv') === '--harden' && field(boot(r.out), 'aurl') === hash(EXT_ADMIN), r.out);
  r = run('harden-mode-c', MODE_C, { entry: 'db-setup.sh harden' });
  check('17c db-harden, mode c (no admin login): one fixed line, exit 0, NO node process', r.code === 0 && /db-harden: no admin login \(mode c\): nothing to harden/.test(r.out) && !boot(r.out), r.out);
  r = run('setup-no-harden-argv', MODE_B, { entry: 'db-setup.sh' });
  check('17d plain db-setup runs the child WITHOUT --harden and needs no harden timeout', r.code === 0 && field(boot(r.out), 'argv') === '-', r.out);
  for (const code of [64, 75]) {
    r = run(`harden-child-${code}`, MODE_B, { entry: 'db-setup.sh harden', ctl: { bootstrap: code } });
    check(`17e db-harden: the child exits ${code} -> exit ${code}, a fixed line, nothing claimed done`, r.code === code && /db-harden: REFUSED - the CREATEROLE hardening step (refused|failed or timed out)/.test(r.out) && !/db-harden: done/.test(r.out), r.out);
  }
  r = run('harden-test-timeout', { ...MODE_B, NODE_ENV: 'test', CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS: '5' }, { entry: 'db-setup.sh harden' });
  check('17f under NODE_ENV=test a short harden timeout (5 s) is accepted', r.code === 0 && field(boot(r.out), 'argv') === '--harden', r.out);
}

// 15. db-setup and db-harden wait for the database themselves (owner instruction 2026-11-18, Twenty's Helm wait-for-db): no
// depends_on: db in docker-compose.production.yml / docker-compose.image.yml. The block (BEGIN/END crewflow wait-for-db) runs
// inside db-setup.sh (db-setup and `db-setup.sh harden`) and, identical, in the db-setup compose wrapper that execs
// ./db-setup.sh (the published 0.6.0 image has no wait). Target: PG_ADMIN_URL's host when it is set (mode b: both URLs set),
// else the bundled db (mode a), else PG_DATABASE_URL's host (mode c). A fake PostgreSQL in the same container (127.0.0.1,
// --network none) answers the startup message: 57P03 while "starting up", then an authentication request ('R'), or the hba
// error 28000 (both mean "accepts connections").
{
  const waitApi = require('../../scripts/db-setup-wait.cjs');
  const FAKE_PG = `
const net = require('net');
const [mode, slowSeconds, port] = [process.argv[2], Number(process.argv[3] || 0), Number(process.argv[4] || 5432)];
const t0 = Date.now();
const err = (s, code) => { const b = Buffer.from('SFATAL\\0C' + code + '\\0Mfake\\0\\0', 'latin1'); const h = Buffer.alloc(5); h.write('E'); h.writeInt32BE(4 + b.length, 1); s.end(Buffer.concat([h, b])); };
net.createServer((s) => {
  s.on('error', () => {});
  s.once('data', (d) => {
    // The probe sends exactly a protocol-3.0 startup message with the fixed placeholder login, no password.
    const ok = d.readInt32BE(4) === 196608 && d.toString('latin1').includes('user\\0crewflow_wait_for_db\\0');
    if (!ok) return s.destroy();
    if (Date.now() - t0 < slowSeconds * 1000) return err(s, '57P03');
    if (mode === 'hba') return err(s, '28000');
    const r = Buffer.alloc(9); r.write('R'); r.writeInt32BE(8, 1); r.writeInt32BE(10, 5); s.end(r);
  });
}).listen(port, '127.0.0.1');
`;
  // The compose wrapper's script, exactly as docker-compose.production.yml commits it (`$$` undone), from the raw text.
  const wrapperOf = (rel) => {
    const text = fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');
    const m = /\n {6}- \|\n( {8}set -eu\n {8}# BEGIN crewflow wait-for-db\n[\s\S]*? {8}exec \.\/db-setup\.sh\n)/.exec(text);
    return m ? m[1].split('\n').map((l) => l.replace(/^ {8}/, '')).join('\n').split('$$').join('$') : null;
  };
  const WRAP = wrapperOf('docker-compose.production.yml');
  check('15a the wait block is identical in db-setup.sh and in the db-setup wrapper of docker-compose.production.yml and docker-compose.image.yml (exactly: set -eu, the block, the call, exec ./db-setup.sh)',
    WRAP !== null && WRAP === waitApi.waitWrapperScript() && wrapperOf('docker-compose.image.yml') === WRAP, 'the wait blocks differ');
  // Mode b, both URLs set: the admin URL is on the fake server; the crewflow_owner URL names an unreachable host, so only a
  // wait on PG_ADMIN_URL's host can succeed.
  const ADMIN_LOCAL = 'postgres://postgres:ADMINSENTINEL1@127.0.0.1:55432/crewflow?sslmode=verify-full';
  const LOCAL = { ...MODE_B, PG_ADMIN_URL: ADMIN_LOCAL };
  const OWNER_LOCAL = `postgresql://crewflow_owner:${OWNER_PW}@127.0.0.1:55432/crewflow?sslmode=verify-full`;
  const ctlFor = (extra = {}) => ({ 'fakepg.cjs': FAKE_PG, 'wrapper.sh': WRAP ?? 'exit 99', ...extra });
  const noSecret = (out) => !out.includes('ADMINSENTINEL') && !out.includes(OWNER_PW) && !out.includes('pw-external') && !out.includes('127.0.0.1') &&
    !out.includes('55432') && !out.includes('db-direct') && !out.includes('postgres://') && !out.includes('postgresql://');
  const before = (out, a, b) => out.indexOf(a) >= 0 && out.indexOf(b) > out.indexOf(a);
  const tookOf = (out) => Number((/took=(\d+)/.exec(out) || [])[1]);

  // In-image (db-setup.sh), mode b: a slow database (57P03 for 3 s) -> progress lines, then "accepts", THEN the child; exit 0.
  r = run('wait-slow', { ...LOCAL, CREWFLOW_DB_WAIT_SECONDS: '30' }, { ctl: ctlFor(), cmd: 'node /ctl/fakepg.cjs ok 3 55432 & sleep 0.5; sh /app/db-setup.sh; echo "exit=$?"' });
  check("15b db-setup.sh, mode b (both URLs): PG_ADMIN_URL's host still starting up (57P03) is waited for with progress lines, then the child runs; exit 0; nothing of either URL is printed",
    /exit=0/.test(r.out) && /db-setup: waiting for your database to accept connections \(\d+s of 30s\): the server is starting up or shutting down \(57P03\)/.test(r.out) &&
    before(r.out, 'your database accepts connections', 'STUB bootstrap') && field(boot(r.out), 'aurl') === hash(ADMIN_LOCAL) && noSecret(r.out), r.out);
  // Unreachable -> the ONE fixed line, exit 70, no child.
  r = run('wait-timeout', { ...LOCAL, CREWFLOW_DB_WAIT_SECONDS: '4' }, { cmd: 'start=$(date +%s); sh /app/db-setup.sh; echo "exit=$? took=$(( $(date +%s) - start ))"' });
  const took = tookOf(r.out);
  check('15c db-setup.sh: an unreachable database -> after the bound (4 s) ONE fixed line and exit 70; the child never runs; nothing is printed of the URL',
    /exit=70/.test(r.out) && took >= 4 && took <= 9 && (r.out.match(/db-setup: REFUSED - the database did not accept connections within 4s \(CREWFLOW_DB_WAIT_SECONDS\)/g) || []).length === 1 &&
    /connection refused/.test(r.out) && !boot(r.out) && noSecret(r.out), `${took}\n${r.out}`);
  // The hba refusal (28000: e.g. the bundled db's hostssl-only pg_hba.conf for the probe's plain TCP) means "up".
  r = run('wait-hba', { ...LOCAL, CREWFLOW_DB_WAIT_SECONDS: '20' }, { ctl: ctlFor(), cmd: 'node /ctl/fakepg.cjs hba 0 55432 & sleep 0.5; sh /app/db-setup.sh; echo "exit=$?"' });
  check('15d db-setup.sh: an error answer other than 57P03 (28000, the TLS-only pg_hba.conf) counts as "accepts connections"; the child runs', /exit=0/.test(r.out) && before(r.out, 'accepts connections', 'STUB bootstrap'), r.out);
  // The bound: whole seconds 0-900; anything else refused (64) before anything connects; 0 = do not wait.
  for (const v of ['abc', '901', '1000', '-1', '30s', '0300']) {
    r = run(`wait-bad-${v.replace(/[^a-z0-9]/gi, 'x')}`, { ...LOCAL, CREWFLOW_DB_WAIT_SECONDS: v }, { entry: 'db-setup.sh' });
    check(`15e CREWFLOW_DB_WAIT_SECONDS=${v} -> refused (64) before anything connects; the value is not printed`, r.code === 64 && /CREWFLOW_DB_WAIT_SECONDS must be a whole number of seconds from 0 to 900/.test(r.out) && !boot(r.out) && !r.out.includes(`=${v}`), r.out);
  }
  r = run('wait-zero', { ...LOCAL, CREWFLOW_DB_WAIT_SECONDS: '0' }, { entry: 'db-setup.sh' });
  check('15f CREWFLOW_DB_WAIT_SECONDS=0 -> no wait (no probe line); the child runs at once', r.code === 0 && !/waiting for|accepts connections/.test(r.out) && Boolean(boot(r.out)), r.out);
  // Mode c (PG_DATABASE_URL only): its own host is waited for.
  r = run('wait-mode-c', { ...MODE_C, PG_DATABASE_URL: OWNER_LOCAL, CREWFLOW_DB_WAIT_SECONDS: '30' }, { ctl: ctlFor(), cmd: 'node /ctl/fakepg.cjs ok 2 55432 & sleep 0.5; sh /app/db-setup.sh; echo "exit=$?"' });
  check("15f2 db-setup.sh, mode c: PG_DATABASE_URL's host is waited for, then the read-only child runs; exit 0",
    /exit=0/.test(r.out) && /\(57P03\)/.test(r.out) && before(r.out, 'your database accepts connections', 'STUB bootstrap') && noSecret(r.out), r.out);

  // db-harden (`db-setup.sh harden`, no compose wrapper): the same in-script wait, on PG_ADMIN_URL's host, before the child.
  r = run('wait-harden', { ...LOCAL, CREWFLOW_DB_WAIT_SECONDS: '30' }, { ctl: ctlFor(), cmd: 'node /ctl/fakepg.cjs ok 3 55432 & sleep 0.5; sh /app/db-setup.sh harden; echo "exit=$?"' });
  check("15f3 db-harden, mode b: waits for PG_ADMIN_URL's host (57P03, then accepts), then the child runs with --harden; exit 0",
    /exit=0/.test(r.out) && /\(57P03\)/.test(r.out) && before(r.out, 'your database accepts connections', 'STUB bootstrap') && field(boot(r.out), 'argv') === '--harden' && noSecret(r.out), r.out);
  r = run('wait-harden-mode-c', { ...MODE_C, CREWFLOW_DB_WAIT_SECONDS: '' }, { cmd: 'start=$(date +%s); sh /app/db-setup.sh harden; echo "exit=$? took=$(( $(date +%s) - start ))"' });
  check('15f4 db-harden, mode c: nothing to harden, so it never waits (unreachable database, default bound): exit 0 at once, no probe line',
    /exit=0/.test(r.out) && tookOf(r.out) <= 3 && !/waiting for/.test(r.out) && !boot(r.out), r.out);

  // The compose wrapper (the published image's path): the same block, then `exec ./db-setup.sh` (which waits again: instant).
  r = run('wrap-slow', { ...LOCAL, CREWFLOW_DB_WAIT_SECONDS: '30' }, { ctl: ctlFor(), execSetup: true, cmd: 'node /ctl/fakepg.cjs ok 3 55432 & sleep 0.5; sh -c "$(cat /ctl/wrapper.sh)" db-setup; echo "exit=$?"' });
  check("15g compose wrapper, mode b (both URLs): waits for PG_ADMIN_URL's host, then execs ./db-setup.sh (whose own wait passes at once: safe to run twice), the child runs; exit 0",
    /exit=0/.test(r.out) && /\(57P03\)/.test(r.out) && (r.out.match(/your database accepts connections/g) || []).length === 2 && before(r.out, 'accepts connections', 'STUB bootstrap') && noSecret(r.out), r.out);
  r = run('wrap-timeout', { ...LOCAL, CREWFLOW_DB_WAIT_SECONDS: '3' }, { ctl: ctlFor(), execSetup: true, cmd: 'sh -c "$(cat /ctl/wrapper.sh)" db-setup; echo "exit=$?"' });
  check('15h compose wrapper: an unreachable database -> the fixed line, exit 70; db-setup.sh never runs (no mode line, no child)',
    /exit=70/.test(r.out) && /did not accept connections within 3s/.test(r.out) && !/db-setup: mode /.test(r.out) && !boot(r.out) && noSecret(r.out), r.out);
  // Mode (a) through the wrapper: the bundled db's host `db` (here 127.0.0.1 via --add-host), from CREWFLOW_BUNDLED_DB_ADMIN_URL.
  r = run('wrap-bundled', { ...BUNDLED, CREWFLOW_DB_WAIT_SECONDS: '30' },
    { ctl: ctlFor(), execSetup: true, dockerArgs: ['--add-host', 'db:127.0.0.1'], cmd: 'node /ctl/fakepg.cjs ok 2 5432 & sleep 0.5; sh -c "$(cat /ctl/wrapper.sh)" db-setup; echo "exit=$?"' });
  check('15i compose wrapper, mode (a): waits for the bundled database (host db), then db-setup.sh runs the child with the bundled URL; exit 0',
    /exit=0/.test(r.out) && /the bundled database \(db\) accepts connections/.test(r.out) && field(boot(r.out), 'aurl') === hash(ADMIN_URL) && !r.out.includes('ADMINSENTINEL') && !r.out.includes(OWNER_PW), r.out);
  // Settings db-setup.sh refuses are never waited for (default bound, nothing listening): the refusal comes at once.
  for (const [label, env, pattern] of [
    ['the bundled db without PG_DATABASE_PASSWORD', { ...BUNDLED, CREWFLOW_BUNDLED_DB_ADMIN_URL: BUNDLED_ADMIN_EMPTY, CREWFLOW_DB_WAIT_SECONDS: '' }, /PG_DATABASE_PASSWORD is required for the bundled database/],
    ['an empty PG_DATABASE_URL', { ...LOCAL, PG_DATABASE_URL: '', CREWFLOW_DB_WAIT_SECONDS: '' }, /PG_DATABASE_URL is empty: it is always required/],
    ['an empty crewflow_owner password (PG_DATABASE_APP_PASSWORD unset)', { ...BUNDLED, PG_DATABASE_URL: 'postgresql://crewflow_owner:@db:5432/crewflow?sslmode=verify-full', CREWFLOW_DB_WAIT_SECONDS: '' }, /the crewflow_owner password in PG_DATABASE_URL is empty/],
    ['a CREWFLOW_BUNDLED_DB other than 0 or 1', { ...LOCAL, CREWFLOW_BUNDLED_DB: 'yes', CREWFLOW_DB_WAIT_SECONDS: '' }, /CREWFLOW_BUNDLED_DB must be exactly 0/],
  ]) {
    r = run(`wrap-refuse-${label.replace(/[^a-z0-9]+/gi, '-')}`, env, { ctl: ctlFor(), execSetup: true, cmd: 'start=$(date +%s); sh -c "$(cat /ctl/wrapper.sh)" db-setup; echo "exit=$? took=$(( $(date +%s) - start ))"' });
    check(`15j compose wrapper: ${label} is not waited for; db-setup.sh refuses it at once (64)`, /exit=64/.test(r.out) && tookOf(r.out) <= 3 && pattern.test(r.out) && !/waiting for/.test(r.out) && !boot(r.out), r.out);
  }
  // A stop during the wait ends it at once (TERM forwarded; exit 143), never the 40 s grace period.
  r = run('wrap-term', { ...LOCAL, CREWFLOW_DB_WAIT_SECONDS: '60' }, { ctl: ctlFor(), execSetup: true, cmd: 'start=$(date +%s); sh -c "$(cat /ctl/wrapper.sh)" db-setup & pid=$!; sleep 3; kill -TERM $pid; wait $pid; echo "exit=$? took=$(( $(date +%s) - start ))"' });
  check('15k compose wrapper: TERM during the wait stops it at once (exit 143), the child never runs', /exit=143/.test(r.out) && tookOf(r.out) <= 6 && !boot(r.out), r.out);
}

// The bundled-db CA block is literally the same code in all three scripts.
const block = (file) => {
  const t = fs.readFileSync(file, 'utf8');
  const a = t.indexOf('# BEGIN crewflow bundled-db CA');
  const b = t.indexOf('# END crewflow bundled-db CA');
  return a >= 0 && b > a ? t.slice(a, b) : null;
};
const ownerBlock = (file) => {
  const t = fs.readFileSync(file, 'utf8');
  const a = t.indexOf('# BEGIN crewflow owner-login check');
  const b = t.indexOf('# END crewflow owner-login check');
  return a >= 0 && b > a ? t.slice(a, b) : null;
};
check('15a2 the owner-login check block (security review of PR #246, L2) is identical in api-prestart.sh, worker-start.sh and db-setup.sh',
  ownerBlock(PRESTART) !== null && ownerBlock(PRESTART) === ownerBlock(WORKER_START) && ownerBlock(PRESTART) === ownerBlock(DB_SETUP), 'the BEGIN/END crewflow owner-login check blocks differ');
check('15a the bundled-db CA block is identical in api-prestart.sh, worker-start.sh and db-setup.sh', block(PRESTART) !== null && block(PRESTART) === block(WORKER_START) && block(PRESTART) === block(DB_SETUP), 'the BEGIN/END crewflow bundled-db CA blocks differ');
const workerSource = fs.readFileSync(WORKER_START, 'utf8');
const setupSource = fs.readFileSync(DB_SETUP, 'utf8');
check('15b worker-start.sh writes no file, never traces (set -x) and never runs the bootstrap child', !/mktemp|\/tmp\//.test(workerSource) && !/set -[a-z]*x/.test(workerSource) && !/bootstrap-owner-login/.test(workerSource), 'worker-start.sh writes a file, traces, or runs the bootstrap child');
check('15c api-prestart.sh never runs the bootstrap child and never traces (set -x)', !/bootstrap-owner-login/.test(prestartSource) && !/set -[a-z]*x/.test(prestartSource), 'api-prestart.sh runs the bootstrap child or enables tracing');
// Owner decision 2026-11-18: no derive step, no target or password file, no setup volume, no file lock, anywhere.
const RETIRED_FILE_CONTRACT = /derive-runtime-url|CREWFLOW_DB_TARGET_FILE|\/run\/crewflow\/db-target|owner-password(?!-wait)|target\.json|\.db-setup\.(flock|lock)|\bflock\b|CREWFLOW_DB_SETUP_LOCK_TOKEN|CREWFLOW_TEST_DB_SETUP_WAIT_SECONDS/;
check('15d none of the three scripts names the retired file contract (derive step, target / password file, setup volume, run lock, wait seam)',
  [prestartSource, workerSource, setupSource].every((t) => !RETIRED_FILE_CONTRACT.test(t)), 'a script still names the retired target/password-file contract');
check('15e db-setup.sh runs the child in the background and forwards TERM/INT',
  /&\nCHILD=\$!\ntrap 'kill -TERM "\$CHILD"[^\n]*exit 143' TERM INT\nwait "\$CHILD"/.test(setupSource), 'db-setup.sh does not forward signals to the child');
check('15f db-setup.sh writes and removes no file (no redirection to a path, no rm, no mkdir)', !/^\s*(rm|mkdir|mv|cp) /m.test(setupSource) && !/>>?\s*"?\$?[A-Za-z_{}]*\//.test(setupSource.replace(/\d?>\s*\/dev\/null/g, '')), 'db-setup.sh touches a file');
check('15g db-setup.sh never traces (set -x) and starts no runtime process (main.js, the Worker, a migration, tini)', !/set -[a-z]*x/.test(setupSource) && !/dist\/main\.js|twenty-migrate|\/sbin\/tini|register-schedulers/.test(setupSource), 'db-setup.sh traces or starts a runtime process');

fs.rmSync(work, { recursive: true, force: true });
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
