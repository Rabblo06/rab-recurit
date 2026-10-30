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

function run(name, env, { ctl = {}, entry = 'api-prestart.sh', withPrestart = true } = {}) {
  const ctlDir = path.join(work, `ctl-${name}`);
  fs.mkdirSync(ctlDir);
  for (const [k, v] of Object.entries(ctl)) fs.writeFileSync(path.join(ctlDir, k), String(v));
  const args = ['run', '--rm', '--network', 'none', '-w', '/app', '-v', `${START}:/app/start.sh:ro`];
  if (withPrestart) args.push('-v', `${PRESTART}:/app/api-prestart.sh:ro`);
  for (const [stubName, target] of Object.entries(STUBS)) args.push('-v', `${path.join(stubs, `${stubName}.js`)}:${target}:ro`);
  args.push('-v', `${ctlDir}:/ctl:ro`);
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push(IMAGE, 'sh', `/app/${entry}`);
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const BASE = { NODE_ENV: 'production', APP_SECRET: 'x'.repeat(40), PG_DATABASE_URL: 'postgres://crewflow_app@db/rab' };
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
];
for (const name of FORBIDDEN) {
  r = run(`forbidden-${name}`, { ...BASE, [name]: name === 'CREWFLOW_MIGRATION_APPROVED' ? 'apply-pending-migrations' : 'x' });
  check(`3 ${name} on the api service -> refused (64), nothing ran`, r.code === 64 && !line(r.out, 'check') && !line(r.out, 'main') && noMigration(r.out), r.out);
}

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

fs.rmSync(work, { recursive: true, force: true });
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
