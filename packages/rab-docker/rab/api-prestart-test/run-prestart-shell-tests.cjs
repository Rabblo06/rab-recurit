#!/usr/bin/env node
/*
 * Shell-level tests for the API start: packages/rab-docker/rab/api-prestart.sh (the image's API command since Phase B P7)
 * and packages/rab-docker/rab/start.sh (retired as a migrating entrypoint; now only delegates to api-prestart.sh).
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
const SCRIPTS_DIR = '/app/packages/rab-server/dist/database/typeorm/scripts';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crewflow-prestart-'));
const stubs = path.join(work, 'stubs');
fs.mkdirSync(stubs);
// Each stub reports the environment it actually received, from the kernel's view, then exits with the code in /ctl/<name>.
const stub = (name) => `
const fs = require('fs');
const keys = (p) => fs.readFileSync(p, 'utf8').split('\\0').filter(Boolean).map((kv) => kv.split('=')[0]).sort();
const code = Number((() => { try { return fs.readFileSync('/ctl/${name}', 'utf8'); } catch { return '0'; } })());
console.log('STUB ${name} pid=' + process.pid + ' self=' + keys('/proc/self/environ').join(',') + ' pid1=' + keys('/proc/1/environ').join(','));
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
};
for (const name of Object.keys(STUBS)) fs.writeFileSync(path.join(stubs, `${name}.js`), stub(name));
// Owner-login architecture: the short-lived migrate child (Agent 1). It reports its environment like the other stubs, prints
// /ctl/migrate-result (the TWENTY_MIGRATE_RESULT line) when present, and exits with the next code of /ctl/migrate-seq
// (comma-separated; the attempt counter lives in the container's writable /tmp), so a 69-then-0 retry can be driven.
const MIGRATE_CHILD = `${SCRIPTS_DIR}/migrate/twenty/twenty-migrate.js`;
fs.writeFileSync(path.join(stubs, 'twentymigrate.js'), `
const fs = require('fs');
const keys = (p) => fs.readFileSync(p, 'utf8').split('\\0').filter(Boolean).map((kv) => kv.split('=')[0]).sort();
const read = (f, d) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return d; } };
const n = Number(read('/tmp/migrate-attempts', '0')) + 1;
fs.writeFileSync('/tmp/migrate-attempts', String(n));
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
  const args = ['run', '--rm', '--network', 'none', ...dockerArgs, '-w', '/app', '-v', `${START}:/app/start.sh:ro`];
  if (withPrestart) args.push('-v', `${PRESTART}:/app/api-prestart.sh:ro`);
  for (const [stubName, target] of Object.entries(STUBS)) args.push('-v', `${path.join(stubs, `${stubName}.js`)}:${target}:ro`);
  args.push('-v', `${path.join(stubs, 'twentymigrate.js')}:${MIGRATE_CHILD}:ro`);
  args.push('-v', `${ctlDir}:/ctl:ro`);
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push(IMAGE, 'sh', `/app/${entry}`);
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
check('1c main.js is PID 1 after exec and keeps the runtime environment', /STUB main pid=1 /.test(main) && keysOf(main, 'self').includes('APP_SECRET') && keysOf(main, 'self').includes('PG_DATABASE_URL'), main);

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
  // Phase B (ops): the one-off operations container's variables.
  'CREWFLOW_OPS_RUN', 'PG_OPS_APP_DATABASE_URL', 'CREWFLOW_OPS_ACTOR_SOURCE', 'CREWFLOW_OPS_ACTOR_ID', 'CREWFLOW_OPS_CHANGE_REF',
  // Owner-login architecture: one PG_DATABASE_URL, no role password, no mode switch, no provisioner setting on the API.
  'DATABASE_URL', 'DATABASE_DIRECT_URL', 'PG_DATABASE_REPLICA_URL', 'PG_WORKER_DATABASE_URL', 'CREWFLOW_WORKER_BOOTSTRAP_PASSWORD',
  'CREWFLOW_OWNER_PASSWORD', 'CREWFLOW_OWNER_BOOTSTRAP_PASSWORD', 'CREWFLOW_DB_MODE', 'DISABLE_DB_MIGRATIONS', 'CREWFLOW_PROVISIONER_ENABLED', 'CREWFLOW_PROVISIONER_ANYTHING',
];
// Final review F5: the approval is now a token naming the exact pending set (pending-<count>-<sha256>); a well-formed token
// is refused on the API exactly like any other value (by name), and so is the retired constant.
const APPROVAL_TOKEN = `pending-1-${'0'.repeat(64)}`;
for (const name of FORBIDDEN) {
  r = run(`forbidden-${name}`, { ...BASE, [name]: name === 'CREWFLOW_MIGRATION_APPROVED' ? APPROVAL_TOKEN : 'x' });
  check(`3 ${name} on the api service -> refused (64), nothing ran`, r.code === 64 && !line(r.out, 'check') && !line(r.out, 'main') && noMigration(r.out), r.out);
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
const DEGRADED = RESULT({ exitCode: 70, serve: true, policy: 'continue-if-compatible', reason: 'migration 1786730000000-Broken failed: lock timeout', failedMigration: '1786730000000-Broken', checks: [] });
r = run('cfg-missing', { ...BASE, CREWFLOW_MIGRATE_ON_START: '' });
check('8a CREWFLOW_MIGRATE_ON_START unset on the API -> refused (64) naming it, nothing ran', r.code === 64 && /CREWFLOW_MIGRATE_ON_START is required on the API service/.test(r.out) && !line(r.out, 'check') && !migrated(r.out) && !line(r.out, 'main'), r.out);
for (const [name, value] of [['CREWFLOW_MIGRATE_ON_START', 'yes'], ['CREWFLOW_MIGRATION_APPROVAL_MODE', 'allowlist'], ['CREWFLOW_UPGRADE_FAILURE_POLICY', 'continue'], ['CREWFLOW_STARTUP_FAILURE_DELAY_SECONDS', '301'], ['CREWFLOW_STARTUP_FAILURE_DELAY_SECONDS', '5s']]) {
  r = run(`cfg-bad-${name}-${value}`, { ...BASE, [name]: value });
  check(`8b ${name}=${value} -> refused (64), value not echoed, nothing ran`, r.code === 64 && r.out.includes(name) && !r.out.includes(`=${value}`) && !line(r.out, 'main') && !migrated(r.out), r.out);
}
// Owner decision BC-11 (2026-11-05): the approval token is optional and off by default, production included.
r = run('cfg-prod-approval-default', { ...BASE, CREWFLOW_MIGRATE_ON_START: 'true' }, { ctl: { 'migrate-seq': '0' } });
check('8c production + migrate-on-start with NO approval mode -> accepted (none): the child runs, main starts', r.code === 0 && /approval=none/.test(r.out) && migrated(r.out) && line(r.out, 'main'), r.out);
r = run('cfg-prod-approval-token-missing', { ...BASE, CREWFLOW_MIGRATE_ON_START: 'true', CREWFLOW_MIGRATION_APPROVAL_MODE: 'token' }, { ctl: { 'migrate-seq': '0' } });
check('8c2 production + token mode: the mode reaches the child, which enforces the token (no approval value is handed over without one)', migrated(r.out) && /approval=token/.test(r.out) && /STUB twentymigrate attempt=1 approval= /.test(r.out), r.out);
r = run('cfg-prod-approval-invalid', { ...BASE, CREWFLOW_MIGRATE_ON_START: 'true', CREWFLOW_MIGRATION_APPROVAL_MODE: 'allowlist' });
check('8c3 an invalid approval mode -> refused (64), the child never ran', r.code === 64 && /CREWFLOW_MIGRATION_APPROVAL_MODE must be exactly one of: none, token/.test(r.out) && !migrated(r.out), r.out);

r = run('migrate-ok', MIGRATE_ON, { ctl: { 'migrate-seq': '0', 'migrate-result': RESULT({ exitCode: 0, serve: true }) } });
check('8d migrate-on-start, child exit 0 -> main starts as PID 1; the read-only check is not needed; no retired migration entrypoint ran', r.code === 0 && migrated(r.out) && /STUB main pid=1 /.test(line(r.out, 'main')) && !line(r.out, 'check') && noMigration(r.out), r.out);
r = run('migrate-70', { ...MIGRATE_ON, CREWFLOW_UPGRADE_FAILURE_POLICY: 'continue-if-compatible' }, { ctl: { 'migrate-seq': '70', 'migrate-result': DEGRADED } });
check('8e exit 70 + continue-if-compatible + a verified result -> main starts with a loud WARNING naming the reason and the failing migration', r.code === 0 && line(r.out, 'main') &&
  /WARNING DEGRADED START - the schema upgrade FAILED .* reason=migration 1786730000000-Broken failed: lock timeout failing_migration=1786730000000-Broken state=CHAIN-PARTIAL/.test(r.out) &&
  /WARNING DEGRADED START - the upgrade failed and continue-if-compatible passed every check/.test(r.out), r.out);
r = run('migrate-70-policy-refuse', MIGRATE_ON, { ctl: { 'migrate-seq': '70', 'migrate-result': DEGRADED } });
check('8f exit 70 while CREWFLOW_UPGRADE_FAILURE_POLICY=refuse -> no start (66)', r.code === 66 && !line(r.out, 'main'), r.out);
r = run('migrate-70-fresh', { ...MIGRATE_ON, CREWFLOW_UPGRADE_FAILURE_POLICY: 'continue-if-compatible' }, { ctl: { 'migrate-seq': '70', 'migrate-result': JSON.stringify({ state: 'EMPTY', exitCode: 70, serve: true, policy: 'continue-if-compatible', reason: 'x' }) } });
check('8g a 70 result naming a FRESH install (EMPTY) is vetoed -> 66: a fresh install never serves', r.code === 66 && /not a verified continue-if-compatible upgrade/.test(r.out) && !line(r.out, 'main'), r.out);
r = run('migrate-70-noserve', { ...MIGRATE_ON, CREWFLOW_UPGRADE_FAILURE_POLICY: 'continue-if-compatible' }, { ctl: { 'migrate-seq': '70', 'migrate-result': DEGRADED.replace('"serve":true', '"serve":false') } });
check('8h a 70 result without serve:true is vetoed -> 66', r.code === 66 && !line(r.out, 'main'), r.out);
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
check('8m token mode: the approval reaches ONLY the migrate child; main.js never holds it', r.code === 0 && migrated(r.out).includes(`approval=${TOKEN}`) &&
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

fs.rmSync(work, { recursive: true, force: true });
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
