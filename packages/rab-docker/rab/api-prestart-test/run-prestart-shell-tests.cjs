#!/usr/bin/env node
/*
 * Shell-level tests for packages/rab-docker/rab/api-prestart.sh (Twenty-parity Phase 7, opt-in, proposal only).
 *
 * Runs the REAL script with the image's shell (BusyBox sh in node:24-alpine, same base as the production image) inside a
 * throwaway container per case. The three node entrypoints it calls are replaced by stubs mounted at their real paths, so
 * this proves the shell's own decisions and its credential handling on a real Linux /proc:
 *   - what the short-lived migration child receives (env -i allowlist), and
 *   - what main.js receives after `exec env -u ...` (its /proc/self/environ and PID 1's /proc/1/environ).
 * The real migration logic (advisory lock, ledger, failure recovery) is tested separately against a throwaway PostgreSQL
 * (docs/evidence/server-path-provisioning-2026-10-22/phase7-*.log). No database, no network, no secrets.
 *
 * Usage: node packages/rab-docker/rab/api-prestart-test/run-prestart-shell-tests.cjs
 */
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const IMAGE = 'node:24-alpine';
const SCRIPT = path.resolve(__dirname, '..', 'api-prestart.sh');
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
fs.writeFileSync(path.join(stubs, 'prestart-migrate.js'), stub('migrate'));
fs.writeFileSync(path.join(stubs, 'check-pending-migrations.js'), stub('check'));
fs.writeFileSync(path.join(stubs, 'main.js'), stub('main'));

function run(name, env, ctl = {}) {
  const ctlDir = path.join(work, `ctl-${name}`);
  fs.mkdirSync(ctlDir);
  for (const [k, v] of Object.entries(ctl)) fs.writeFileSync(path.join(ctlDir, k), String(v));
  const args = ['run', '--rm', '--network', 'none', '-w', '/app',
    '-v', `${SCRIPT}:/app/api-prestart.sh:ro`,
    '-v', `${path.join(stubs, 'prestart-migrate.js')}:${SCRIPTS_DIR}/prestart-migrate.js:ro`,
    '-v', `${path.join(stubs, 'check-pending-migrations.js')}:${SCRIPTS_DIR}/check-pending-migrations.js:ro`,
    '-v', `${path.join(stubs, 'main.js')}:/app/packages/rab-server/dist/main.js:ro`,
    '-v', `${ctlDir}:/ctl:ro`];
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push(IMAGE, 'sh', '/app/api-prestart.sh');
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const BASE = { NODE_ENV: 'production', APP_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgres://crewflow_app@db/rab' };
const MIG = 'postgres://bootstrap@db/rab';
let failures = 0;
const check = (label, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${label}${cond ? '' : `\n${detail}`}`);
  if (!cond) failures++;
};
const line = (out, who) => (out.split('\n').find((l) => l.startsWith(`STUB ${who} `)) || '');
const keysOf = (l, which) => ((l.match(new RegExp(`${which}=([^ ]*)`)) || [])[1] || '').split(',').filter(Boolean);

// 1. Default: nothing approved, nothing privileged -> check runs, main starts, no migration variable anywhere.
let r = run('default', BASE);
check('1 default start: no migration step, check ran, main started (exit 0)', r.code === 0 && !line(r.out, 'migrate') && line(r.out, 'check') && line(r.out, 'main'), r.out);

// 2. A migration credential without approval is refused before anything runs.
r = run('unapproved-credential', { ...BASE, CREWFLOW_PRESTART_MIGRATION_DATABASE_URL: MIG });
check('2 credential WITHOUT approval refused (64), main never starts', r.code === 64 && !line(r.out, 'main') && /not approved/.test(r.out), r.out);

// 3. Approved run: the migration child gets ONLY the allowlist; main gets NO migration variable (self and PID 1).
r = run('approved', { ...BASE, CREWFLOW_MIGRATION_APPROVED: 'apply-pending-migrations', CREWFLOW_PRESTART_MIGRATION_DATABASE_URL: MIG, DB_TARGET: 'production', ALLOW_PRODUCTION_DB_COMMANDS: 'true' });
const mig = line(r.out, 'migrate');
const main = line(r.out, 'main');
const migKeys = keysOf(mig, 'self');
const mainSelf = keysOf(main, 'self');
const mainPid1 = keysOf(main, 'pid1');
const forbiddenInMain = ['CREWFLOW_PRESTART_MIGRATION_DATABASE_URL', 'CREWFLOW_MIGRATION_APPROVED', 'DB_TARGET', 'ALLOW_PRODUCTION_DB_COMMANDS', 'DATABASE_URL_UNPOOLED'];
check('3a approved: migration child ran and main started (exit 0)', r.code === 0 && mig && main, r.out);
check('3b migration child received the credential as DATABASE_URL_UNPOOLED and NOT the api secrets (env -i allowlist)',
  migKeys.includes('DATABASE_URL_UNPOOLED') && !migKeys.includes('APP_SECRET') && !migKeys.includes('CREWFLOW_PRESTART_MIGRATION_DATABASE_URL'), mig);
check('3c main.js /proc/self/environ has no migration variable', forbiddenInMain.every((k) => !mainSelf.includes(k)) && mainSelf.includes('APP_SECRET'), main);
check('3d main.js is PID 1 after exec and /proc/1/environ has no migration variable (the shell holding it is gone)',
  /STUB main pid=1 /.test(main) && forbiddenInMain.every((k) => !mainPid1.includes(k)), main);

// 4. A failed migration step stops the start: main never runs.
r = run('migrate-fails', { ...BASE, CREWFLOW_MIGRATION_APPROVED: 'apply-pending-migrations', CREWFLOW_PRESTART_MIGRATION_DATABASE_URL: MIG, DB_TARGET: 'local' }, { migrate: 1 });
check('4 failed migration step -> exit 70, main never starts', r.code === 70 && !line(r.out, 'main'), r.out);

// 5. Pending without approval: the restricted check fails -> refused, main never starts.
r = run('pending-unapproved', BASE, { check: 1 });
check('5 pending migrations without approval -> exit 65, main never starts', r.code === 65 && !line(r.out, 'main'), r.out);

// 6. Variables that must never be on the api service.
for (const name of ['DATABASE_URL_UNPOOLED', 'CREWFLOW_MIGRATION_DATABASE_URL', 'CREWFLOW_PROVISIONER_DATABASE_URL', 'CREWFLOW_BOOTSTRAP_PASSWORD']) {
  r = run(`forbidden-${name}`, { ...BASE, [name]: 'x' });
  check(`6 ${name} on the api service -> refused (64)`, r.code === 64 && !line(r.out, 'main'), r.out);
}

// 7. Approved with a pooled host or without DB_TARGET -> refused before any migration.
r = run('pooler', { ...BASE, CREWFLOW_MIGRATION_APPROVED: 'apply-pending-migrations', CREWFLOW_PRESTART_MIGRATION_DATABASE_URL: 'postgres://x@ep-1-pooler.eu.neon.tech/db', DB_TARGET: 'production' });
check('7a approved with a -pooler host -> refused (64), no migration step', r.code === 64 && !line(r.out, 'migrate'), r.out);
r = run('no-target', { ...BASE, CREWFLOW_MIGRATION_APPROVED: 'apply-pending-migrations', CREWFLOW_PRESTART_MIGRATION_DATABASE_URL: MIG });
check('7b approved without DB_TARGET -> refused (64), no migration step', r.code === 64 && !line(r.out, 'migrate'), r.out);
r = run('approved-no-url', { ...BASE, CREWFLOW_MIGRATION_APPROVED: 'apply-pending-migrations' });
check('7c approved without the one-time credential -> refused (64)', r.code === 64 && !line(r.out, 'main'), r.out);

fs.rmSync(work, { recursive: true, force: true });
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
