'use strict';
/**
 * UPGRADE LOGBOOK REAL-CONTAINER TESTS (OWNER-DB-ULTIMATE.md Part B, TEST-ONLY; agent "B2 tests").
 *
 * The production compose files unchanged, THE documented command `docker compose pull && docker compose up -d`, a SEEDED
 * database, one PostgreSQL major per run (16, 17 or 18). The machinery (projects, secrets, psql as the superuser and as
 * crewflow_owner, a lock holder) is agent A2's `../deploy-order-tests/upgrade-lib.cjs`, required read-only, and so are its
 * `seed-organisations.sql` and `data-facts.sql` (read through Project.psqlFile, which resolves them in that folder).
 *
 *   ULT_REPOSITORY=127.0.0.1:<port>/adolphus             a LOCAL registry (never Docker Hub)
 *   ULT_R254_DIGEST=sha256:…    R254 = 0.4.0 (adolphus:cd7c7e32), re-pushed locally
 *   ULT_R256_DIGEST=sha256:…    R256 = 0.5.0 (0e0a6edd), re-pushed locally
 *   ULT_NEW_DIGEST=sha256:…     the image under test (B1's deploy/upgrade-ledger, 0.6.0), built locally
 *   ULT_PROBE_FAIL_DIGEST=sha256:…  NEW + DotProbeFail1786799990001 (deploy-order-tests/probe/build-probe-images.cjs, unchanged)
 *   ULT_PG_IMAGE=postgres@sha256:…  ULT_REDIS_IMAGE=redis@sha256:…  [ULT_PG15_IMAGE=postgres@sha256:… for L10b]
 *     node packages/rab-docker/upgrade-ledger-tests/run-upgrade-ledger-tests.cjs <16|17|18> <out-dir> [--only=L1,L3] [--keep]
 *   [ULT_PROJECT_PREFIX=cf-b2t]  project names <prefix>-pg<major>-<case>; <out-dir> OUTSIDE the repository (per-run secrets).
 *
 * Cases (each its own disposable project, one after another, `down` after each):
 *   L1  adopt R254: seeded R254 -> NEW: exactly one instance is_initial row `0.4.0_TypeOrmMigrations` (0.4.0); the 0.6.0
 *       steps completed attempt 1; data, money, foreign keys and tenant ownership identical; the API healthy before the
 *       Worker starts; RLS as crewflow_owner (no context = 0 rows, also on the logbook); `up -d --force-recreate rab-api`
 *       (a restart) adds NO row.
 *   L2  adopt R256 -> `0.5.0_TypeOrmMigrations` (0.5.0), the same.
 *   L3  an older history (R254 minus its last four migrations): 65 in a restart loop, nothing applied, no logbook table,
 *       the Worker never started.
 *   L4  crash in the migrations step: the ledger migration blocked by a lock holder, the API SIGKILLed: no logbook row, the
 *       lock free; `up -d` resumes: `0.6.0_TypeOrmMigrations` completed attempt 1.
 *   L5  a failed migration (probe image, same version): 66, never serves, the Worker not started; each restart adds the next
 *       attempt (contiguous, all `failed`, error_message set); back to NEW: completed attempt n+1, serves.
 *   L6  only an upgrade COMMAND fails: 70, serves, /healthz upgrade.upgrade = "failed", the Worker starts. NOT RUNNABLE on
 *       0.6.0 (UPGRADE_COMMANDS['0-6'] is empty and the command-failure seam needs NODE_ENV=test): reported, not faked.
 *   L7  rollback to R256 after NEW: serves with a warning (AHEAD); then a loosened known object (FORCE RLS removed from
 *       core.payroll_record): refused.
 *   L8  a skipped release (the logbook says only 0.3.0): NEW refuses 65 and applies nothing; every candidate "force"
 *       variable in runtime.env changes nothing; the documented manual command
 *       `docker compose run --rm --no-deps rab-api node dist/command upgrade --force` applies, its rows have forced = true;
 *       then `up -d` serves.
 *   L9  two migrate children of NEW race for the lock on a seeded R256 database: no duplicate (name, attempt).
 *   L10 security stays fatal: crewflow_owner made BYPASSRLS -> refused (and refused under --force); [L10b with
 *       ULT_PG15_IMAGE: PostgreSQL 15 refused].
 *   L11 deleting a seeded workspace (superuser) removes its logbook rows (FK cascade) and nothing else.
 *
 * Limits: at most five running containers of this run; every data dir a tmpfs; cleanup = `down` of this run's own projects
 * only (never a prune, never another project). Results: <out>/RESULTS.json, SUMMARY.md, run.log, evidence/.
 */
const fs = require('node:fs');
const path = require('node:path');

const L = require('../deploy-order-tests/upgrade-lib.cjs');

const argv = process.argv.slice(2);
const MAJOR = argv[0];
const OUT = argv[1] ? path.resolve(argv[1]) : '';
const ONLY = (argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
const KEEP = argv.includes('--keep');
const fail = (m) => {
  console.error(m);
  process.exit(2);
};
if (!['16', '17', '18'].includes(MAJOR) || !OUT) fail('usage: run-upgrade-ledger-tests.cjs <16|17|18> <out-dir> [--only=L1,...] [--keep]');
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REF = /^[a-z0-9./_:-]+@sha256:[0-9a-f]{64}$/;
for (const k of ['ULT_R254_DIGEST', 'ULT_R256_DIGEST', 'ULT_NEW_DIGEST', 'ULT_PROBE_FAIL_DIGEST']) if (!DIGEST.test(process.env[k] ?? '')) fail(`${k} must be sha256:<64 hex>`);
for (const k of ['ULT_PG_IMAGE', 'ULT_REDIS_IMAGE']) if (!REF.test(process.env[k] ?? '')) fail(`${k} must be <repository>@sha256:<64 hex>`);
if (process.env.ULT_PG15_IMAGE && !REF.test(process.env.ULT_PG15_IMAGE)) fail('ULT_PG15_IMAGE must be <repository>@sha256:<64 hex>');
if (!/^127\.0\.0\.1:\d+\/[a-z0-9._/-]+$/.test(process.env.ULT_REPOSITORY ?? '')) fail('ULT_REPOSITORY must be a LOCAL registry repository (127.0.0.1:<port>/<name>)');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const rel = path.relative(REPO_ROOT.toLowerCase(), OUT.toLowerCase());
if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) fail('the output directory must be OUTSIDE the repository (it holds per-run secrets)');
const PREFIX = process.env.ULT_PROJECT_PREFIX || 'cf-b2t';
if (!/^[a-z][a-z0-9-]{0,15}$/.test(PREFIX)) fail('ULT_PROJECT_PREFIX must match ^[a-z][a-z0-9-]{0,15}$');

const REPO = process.env.ULT_REPOSITORY;
const IMG = { r254: process.env.ULT_R254_DIGEST, r256: process.env.ULT_R256_DIGEST, next: process.env.ULT_NEW_DIGEST, probeFail: process.env.ULT_PROBE_FAIL_DIGEST };
const NEW_VERSION = '0.6.0';
const LEDGER_MIGRATION = 'UpgradeMigrationLedger1786721470000';
/** B1's entry inside the image (WORKDIR /app): packages/rab-server/dist/command/index.js dispatches `upgrade`. */
const FORCE_ENTRY = 'packages/rab-server/dist/command';
const SEEDED_TABLES = [
  'attendance', 'job_offer', 'job_role', 'manager_profile', 'manager_workspace', 'payroll_calendar', 'payroll_calendar_period', 'payroll_record',
  'payroll_run', 'payroll_run_line', 'role', 'shift', 'shift_assignment', 'staff_profile', 'user', 'venue', 'workspace_membership',
];

fs.mkdirSync(path.join(OUT, 'evidence'), { recursive: true });
const results = [];
const logLines = [];
const note = (line) => {
  const l = L.redact(line);
  logLines.push(l);
  console.log(`[${PREFIX}-pg${MAJOR}] ${l}`);
};
const evidence = (name, text) => fs.writeFileSync(path.join(OUT, 'evidence', name), L.redact(text));
const writeResults = () => {
  fs.writeFileSync(path.join(OUT, 'RESULTS.json'), JSON.stringify({ major: MAJOR, images: IMG, results }, null, 2));
  fs.writeFileSync(path.join(OUT, 'run.log'), logLines.join('\n'));
  fs.writeFileSync(
    path.join(OUT, 'SUMMARY.md'),
    `# Upgrade logbook container tests, PostgreSQL ${MAJOR}\n\n| Case | Status | Title |\n|---|---|---|\n${results.map((r) => `| ${r.id} | ${r.status} | ${r.title} |`).join('\n')}\n`,
  );
};

function project(kind, opts) {
  const p = new L.Project(`${PREFIX}-pg${MAJOR}-${kind}`, OUT, opts);
  L.writeSecrets(p.secretsDir);
  return p;
}
function use(p, digest, pgImage = process.env.ULT_PG_IMAGE) {
  L.writeComposeEnv(p, { repository: REPO, digest, pgImage, redisImage: process.env.ULT_REDIS_IMAGE });
}

async function step(id, title, fn, p) {
  if (ONLY.length && !ONLY.includes(id)) return;
  const r = { id, title, status: 'NOT RUN', checks: [], notes: [] };
  results.push(r);
  note(`=== ${id} ${title}`);
  const check = (ok, what) => {
    r.checks.push({ ok: Boolean(ok), what: L.redact(what) });
    note(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
    return Boolean(ok);
  };
  const n = (t) => {
    r.notes.push(L.redact(t));
    note(`  note: ${t}`);
  };
  try {
    const verdict = await fn(check, n);
    r.status = verdict === 'NOT RUNNABLE' ? 'NOT RUNNABLE' : r.checks.length && r.checks.every((c) => c.ok) ? 'PASS' : 'FAIL';
  } catch (e) {
    r.status = 'FAIL';
    r.checks.push({ ok: false, what: `threw: ${L.redact(e && e.message ? e.message : String(e))}` });
    note(`  FAIL threw: ${e && e.message ? e.message : e}`);
  } finally {
    if (p && r.status === 'FAIL') for (const svc of ['rab-api', 'rab-worker']) evidence(`${id}-failure-${svc}.log`, L.run('docker', ['logs', '--tail', '400', p.container(svc)]).out);
    if (p && !KEEP) note(`  cleanup ${p.name}: compose down exit ${p.down().code}`);
  }
  note(`=== ${id} ${r.status}`);
  writeResults();
}

// ------------------------------------------------------------------------------------------------------------ helpers
const LEDGER_SQL = `SELECT coalesce(string_agg(name || '|' || status || '|' || attempt || '|' || executed_by_version || '|' || is_initial || '|' || coalesce(workspace_id::text, '-') || '|' || forced || '|' || (error_message IS NOT NULL), E'\\n' ORDER BY created_at, name, attempt), '') FROM core.upgrade_migration`;
const hasLedger = (p) => p.psql("SELECT to_regclass('core.upgrade_migration') IS NOT NULL") === 't';
function ledger(p) {
  if (!hasLedger(p)) return [];
  return p
    .psql(LEDGER_SQL)
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [name, status, attempt, version, initial, ws, forced, hasMessage] = l.split('|');
      return { name, status, attempt: Number(attempt), version, initial: initial === 'true', ws: ws === '-' ? null : ws, forced: forced === 'true', hasMessage: hasMessage === 'true' };
    });
}
const ledgerIds = (p) => (hasLedger(p) ? p.psql('SELECT coalesce(string_agg(id::text, \',\' ORDER BY id), \'\') FROM core.upgrade_migration') : '');
const instanceOf = (rows, name) => rows.filter((r) => r.name === name && r.ws === null && !r.initial).map((r) => `${r.status}:${r.attempt}`);
function attemptProblems(rows) {
  const groups = new Map();
  for (const r of rows.filter((x) => !x.initial)) {
    const k = `${r.name}@${r.ws ?? 'instance'}`;
    groups.set(k, [...(groups.get(k) ?? []), r.attempt]);
  }
  return [...groups].filter(([, a]) => [...a].sort((x, y) => x - y).some((v, i) => v !== i + 1)).map(([k, a]) => `${k}: ${a.join(',')}`);
}
function facts(p) {
  const lines = p.psqlFile('data-facts.sql').split('\n').filter(Boolean);
  return new Map(lines.map((l) => [l.slice(0, l.lastIndexOf('|')), l.slice(l.lastIndexOf('|') + 1)]).filter(([k]) => k !== 'ledger|count'));
}
function compareFacts(check, before, after, label) {
  const changed = [...before.keys()].filter((k) => !k.startsWith('fk|') && !k.startsWith('own|') && before.get(k) !== after.get(k));
  const seeded = [...before.keys()].filter((k) => k.startsWith('rows|') && SEEDED_TABLES.includes(k.split('|')[1]));
  check(seeded.length === SEEDED_TABLES.length * 2 && changed.length === 0, `${label}: seeded rows, content and money identical (${before.size} facts)${changed.length ? `; changed: ${changed.join(', ')}` : ''}`);
  const bad = [...after].filter(([k, v]) => (k.startsWith('fk|') || k.startsWith('own|')) && v !== '0');
  check(bad.length === 0, `${label}: every core foreign key and every tenant-ownership reference holds${bad.length ? `; ${bad.map(([k, v]) => `${k}=${v}`).join(', ')}` : ''}`);
}
function migrateResults(log) {
  return [...log.matchAll(/TWENTY_MIGRATE_RESULT (\{.*\})/g)].map((m) => {
    try {
      return JSON.parse(m[1]);
    } catch {
      return {};
    }
  });
}
async function freshSeeded(p, check, digest, expectCount) {
  use(p, digest);
  const d = p.deploy();
  evidence(`${p.name}-base-deploy.log`, d.out);
  check(d.code === 0, `fresh deploy of the base release: exit ${d.code}`);
  await p.waitHealthy('rab-api', 300_000);
  await p.waitHealthy('rab-worker', 300_000);
  check(p.psql('SELECT count(*) FROM core.migrations') === String(expectCount), `base release installed exactly ${expectCount} migrations`);
  check(p.psql('SHOW server_version_num').startsWith(MAJOR), `PostgreSQL major ${MAJOR}`);
  check(!hasLedger(p), 'the base release has no logbook table');
  p.psqlFile('seed-organisations.sql');
  check(p.psql(`SELECT count(*) FROM core.organisation WHERE slug::text LIKE 'dot-seed-%'`) === '2', 'seeded 2 synthetic organisations');
}
async function deployNew(p, check, label, digest = IMG.next) {
  use(p, digest);
  const since = L.nowS() - 1;
  const d = p.deploy();
  evidence(`${p.name}-${label}-deploy.log`, d.out);
  check(d.code === 0, `${label}: deploy exit ${d.code} after ${Math.round(d.ms / 1000)} s`);
  await p.waitHealthy('rab-api', 300_000);
  await p.waitHealthy('rab-worker', 300_000);
  const ev = p.events(since, L.nowS() + 1);
  const apiHealthy = ev.find((e) => e.service === 'rab-api' && e.action.startsWith('health_status: healthy'));
  const workerStart = ev.find((e) => e.service === 'rab-worker' && e.action === 'start');
  check(apiHealthy && workerStart && apiHealthy.t < workerStart.t, `${label}: the API was healthy before the Worker started`);
}
function rlsNoContext(p, check, label) {
  const r = p.psqlOwner('SELECT (SELECT count(*) FROM core.upgrade_migration) || \',\' || (SELECT count(*) FROM core.payroll_record) || \',\' || (SELECT count(*) FROM core.shift);');
  check(r === '0,0,0', `${label}: crewflow_owner with no tenant context and no upgrade scope reads 0 rows (logbook, payroll_record, shift): ${r}`);
}
/** A deploy that must FAIL (short health window): the API refuses; returns its migrate results. */
function deployRefused(p, check, digest, label, pgImage) {
  p.setShortHealth(true);
  use(p, digest, pgImage);
  const since = L.nowS() - 1;
  const d = p.deploy(900_000);
  evidence(`${p.name}-${label}-deploy.log`, d.out);
  check(d.code !== 0, `${label}: the deploy fails (exit ${d.code})`);
  const al = p.logs('rab-api');
  evidence(`${p.name}-${label}-api.log`, al);
  check(p.neverStarted('rab-worker') || !p.events(since, L.nowS() + 1).some((e) => e.service === 'rab-worker' && e.action === 'start'), `${label}: the Worker was not started`);
  p.setShortHealth(false);
  return { results: migrateResults(al), log: al };
}

// --------------------------------------------------------------------------------------------------------------- main
async function main() {
  L.newSecrets();
  note(`PostgreSQL ${process.env.ULT_PG_IMAGE}; R254 ${IMG.r254.slice(0, 19)}…; R256 ${IMG.r256.slice(0, 19)}…; NEW ${IMG.next.slice(0, 19)}…`);

  for (const [id, release, digest, count, version] of [
    ['L1', 'R254', IMG.r254, 254, '0.4.0'],
    ['L2', 'R256', IMG.r256, 256, '0.5.0'],
  ]) {
    const p = project(id.toLowerCase());
    await step(id, `adopt ${release}: one is_initial row at ${version}, upgraded in the same start, data identical, a restart adds nothing`, async (check) => {
      await freshSeeded(p, check, digest, count);
      const before = facts(p);
      rlsNoContext(p, check, 'before');
      await deployNew(p, check, 'NEW');
      const rows = ledger(p);
      evidence(`${id}-ledger.txt`, rows.map((r) => JSON.stringify(r)).join('\n'));
      const initial = rows.filter((r) => r.initial && r.ws === null);
      check(initial.length === 1 && initial[0].name === `${version}_TypeOrmMigrations` && initial[0].version === version && initial[0].status === 'completed' && initial[0].attempt === 1 && !initial[0].forced, `exactly one instance is_initial row ${version}_TypeOrmMigrations at ${version} (${initial.map((r) => `${r.name}@${r.version}`).join(', ')})`);
      check(instanceOf(rows, `${NEW_VERSION}_TypeOrmMigrations`).join(',') === 'completed:1', `${NEW_VERSION}_TypeOrmMigrations completed, attempt 1`);
      check(rows.every((r) => r.status === 'completed' && !r.forced && !r.hasMessage), 'every row completed, none forced, no message');
      check(attemptProblems(rows).length === 0, 'attempts contiguous, no duplicate');
      const res = migrateResults(p.logs('rab-api')).pop() || {};
      check(res.upgrade && res.upgrade.adoptedFrom === version && res.upgrade.codeVersion === NEW_VERSION, `result line: adoptedFrom ${res.upgrade && res.upgrade.adoptedFrom}, codeVersion ${res.upgrade && res.upgrade.codeVersion}`);
      compareFacts(check, before, facts(p), 'after the upgrade');
      rlsNoContext(p, check, 'after');
      const ids = ledgerIds(p);
      const r = p.compose(['up', '-d', '--force-recreate', 'rab-api'], { timeout: 900_000 });
      check(r.code === 0, `restart (up -d --force-recreate rab-api): exit ${r.code}`);
      await p.waitHealthy('rab-api', 300_000);
      check(ledgerIds(p) === ids, 'the restart added no logbook row (no second is_initial, no step re-recorded)');
      const hz = p.healthz();
      let body = {};
      try {
        body = JSON.parse(hz.body);
      } catch {
        /* checked below */
      }
      const up = (body.info || body.details || {}).upgrade || {};
      check(up.upgrade === 'ok' && up.upgradeFailed === false, `/healthz upgrade: ${JSON.stringify(up)}`);
    }, p);
  }

  const l3 = project('l3');
  await step('L3', 'an older history (R254 minus its last four): 65, nothing applied, no logbook, Worker never started', async (check) => {
    await freshSeeded(l3, check, IMG.r254, 254);
    l3.psql("DELETE FROM core.migrations WHERE id IN (SELECT id FROM core.migrations ORDER BY timestamp DESC, id DESC LIMIT 4)");
    const before = l3.psql('SELECT count(*) FROM core.migrations');
    const { results: rs } = deployRefused(l3, check, IMG.next, 'NEW');
    check(rs.length > 0 && rs.every((x) => x.exitCode === 65 && x.serve === false), `every start refused with 65 (${rs.map((x) => x.exitCode).join(',')}; ${rs.length} start(s) in the restart loop)`);
    check(l3.psql('SELECT count(*) FROM core.migrations') === before, `nothing applied (${before} migrations)`);
    check(!hasLedger(l3), 'no logbook table was created');
  }, l3);

  const l4 = project('l4');
  await step('L4', 'crash inside the migrations step (SIGKILL while the ledger migration waits on a lock): no row; up -d resumes, attempt 1', async (check, n) => {
    await freshSeeded(l4, check, IMG.r256, 256);
    const before = facts(l4);
    const holder = await l4.holdLock('LOCK TABLE core.manager_workspace IN ACCESS EXCLUSIVE MODE');
    n(`lock holder pid ${holder.pid}: core.manager_workspace ACCESS EXCLUSIVE (the logbook's FK needs it)`);
    use(l4, IMG.next);
    const dep = l4.deployAsync();
    try {
      await L.waitFor('the migrate child to block in the ledger migration', () => Number(l4.psql("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%upgrade_migration%'")) >= 1, 120_000, 1000);
      check(l4.neverStarted('rab-worker'), 'the Worker is not started while the API migrates');
      check(L.run('docker', ['kill', '--signal', 'KILL', l4.container('rab-api')]).code === 0, 'SIGKILL of rab-api inside the migrations step');
      await holder.release();
      await L.waitFor('the killed session to release the migration lock', () => l4.psql(`SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted AND ((classid::bigint << 32) | objid::bigint) = ${L.MIGRATION_LOCK_KEY_SQL}`) === '0', 60_000, 1000);
      check(!hasLedger(l4) || ledger(l4).length === 0, 'no logbook row for the crashed step (a crash leaves no row)');
      check(l4.psql('SELECT count(*) FROM core.migrations') === '256' && l4.psql(`SELECT count(*) FROM core.migrations WHERE name = '${LEDGER_MIGRATION}'`) === '0', 'nothing recorded in core.migrations either');
    } finally {
      await holder.release().catch(() => undefined);
    }
    await dep.done;
    await deployNew(l4, check, 'resume');
    const rows = ledger(l4);
    check(instanceOf(rows, `${NEW_VERSION}_TypeOrmMigrations`).join(',') === 'completed:1', `resumed: ${NEW_VERSION}_TypeOrmMigrations completed, attempt 1 (${instanceOf(rows, `${NEW_VERSION}_TypeOrmMigrations`)})`);
    compareFacts(check, before, facts(l4), 'after the crash and resume');
  }, l4);

  const l5 = project('l5');
  await step('L5', 'a failed migration: 66, never serves; each restart = the next attempt; back to NEW: completed n+1', async (check) => {
    await freshSeeded(l5, check, IMG.r256, 256);
    await deployNew(l5, check, 'NEW');
    const before = facts(l5);
    const base = instanceOf(ledger(l5), `${NEW_VERSION}_TypeOrmMigrations`);
    const { results: rs } = deployRefused(l5, check, IMG.probeFail, 'probe-fail');
    check(rs.length > 0 && rs.every((x) => x.exitCode === 66 && x.serve === false), `every start refused with 66 (${rs.map((x) => x.exitCode).join(',')})`);
    const rows = ledger(l5);
    const after = instanceOf(rows, `${NEW_VERSION}_TypeOrmMigrations`);
    const added = after.slice(base.length);
    check(added.length === rs.length && added.every((a, i) => a === `failed:${base.length + i + 1}`), `one failed row per start, attempts ${base.length + 1}..${base.length + rs.length} (${added.join(', ')})`);
    check(rows.filter((r) => r.status === 'failed').every((r) => r.hasMessage), 'every failed row carries its error message');
    check(attemptProblems(rows).length === 0, 'attempts contiguous, no duplicate');
    await deployNew(l5, check, 'NEW again');
    const final = instanceOf(ledger(l5), `${NEW_VERSION}_TypeOrmMigrations`);
    check(final[final.length - 1] === `completed:${final.length}`, `NEW again: completed attempt ${final.length}`);
    compareFacts(check, before, facts(l5), 'after the failed migration');
  }, l5);

  await step('L6', 'only an upgrade command fails: 70, serves, healthz upgrade "failed", Worker starts', async (check, n) => {
    n('NOT RUNNABLE on 0.6.0: UPGRADE_COMMANDS[0-6] is empty (UPGRADE-LEDGER-INTERFACE.md §2) and the planned CREWFLOW_UPGRADE_TEST_FAIL_COMMAND seam is NODE_ENV=test only, which a production image never runs. Proven at server level once a test command exists (ledger-upgrade LU-4/LU-10).');
    return 'NOT RUNNABLE';
  });

  const l7 = project('l7');
  await step('L7', 'rollback to R256 after NEW: serves with a warning; a loosened known object (payroll_record NO FORCE) refuses', async (check) => {
    await freshSeeded(l7, check, IMG.r256, 256);
    await deployNew(l7, check, 'NEW');
    const ids = ledgerIds(l7);
    use(l7, IMG.r256);
    const d = l7.deploy();
    evidence('L7-rollback-deploy.log', d.out);
    check(d.code === 0, `rollback deploy (R256 image on the 0.6.0 database): exit ${d.code}`);
    await l7.waitHealthy('rab-api', 300_000);
    const al = l7.logs('rab-api');
    evidence('L7-rollback-api.log', al);
    check(/AHEAD|newer|rollback/i.test(al) && /WARN/i.test(al), 'the old image logs a warning (database AHEAD) and serves');
    check(ledgerIds(l7) === ids, 'the old image wrote nothing to the logbook');
    l7.psql('ALTER TABLE core.payroll_record NO FORCE ROW LEVEL SECURITY');
    const { log } = deployRefused(l7, check, IMG.r256, 'rollback-loosened');
    check(!/"serve":true/.test(log.split('\n').slice(-50).join('\n')), 'with FORCE RLS removed from a known table the old image does not serve');
    l7.psql('ALTER TABLE core.payroll_record FORCE ROW LEVEL SECURITY');
  }, l7);

  const l8 = project('l8');
  await step('L8', 'skipped release: 65 and nothing applied; env "force" does nothing; the manual upgrade --force applies with forced = true', async (check, n) => {
    await freshSeeded(l8, check, IMG.r256, 256);
    await deployNew(l8, check, 'NEW');
    l8.psql("DELETE FROM core.upgrade_migration WHERE workspace_id IS NULL; INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, is_initial, workspace_id, forced) VALUES ('0.3.0_TypeOrmMigrations', 'completed', 1, '0.3.0', false, NULL, false)");
    const ids = ledgerIds(l8);
    const { results: rs } = deployRefused(l8, check, IMG.next, 'skipped');
    check(rs.length > 0 && rs.every((x) => x.exitCode === 65), `refused with 65 (${rs.map((x) => x.exitCode).join(',')})`);
    check(ledgerIds(l8) === ids, 'nothing written to the logbook');
    // Every candidate variable in the runtime env file: still refused (or refused by env validation), never forced.
    const runtimeEnv = path.join(l8.secretsDir, 'runtime.env');
    const original = fs.readFileSync(runtimeEnv, 'utf8');
    fs.appendFileSync(runtimeEnv, ['CREWFLOW_UPGRADE_FORCE=true', 'CREWFLOW_FORCE_UPGRADE=true', 'UPGRADE_FORCE=true', 'FORCE_UPGRADE=true', 'FORCE=true'].join('\n') + '\n');
    const envTry = deployRefused(l8, check, IMG.next, 'env-force');
    check(envTry.results.every((x) => x.exitCode === 65 || x.exitCode === 64), `with *FORCE* variables set: still refused (${envTry.results.map((x) => x.exitCode).join(',') || 'env validation refused before the child'})`);
    check(ledgerIds(l8) === ids, 'the env variables forced nothing');
    fs.writeFileSync(runtimeEnv, original);
    l8.compose(['stop', 'rab-api', 'rab-worker'], { timeout: 300_000 });
    // The owner's literal command (Part B3). The image's WORKDIR is /app, so `dist/command` must resolve there.
    const literal = l8.compose(['run', '--rm', '--no-deps', 'rab-api', 'node', 'dist/command', 'upgrade', '--force'], { timeout: 900_000 });
    evidence('L8-force-literal.log', literal.out);
    check(literal.code === 0, `the owner's literal command \`docker compose run --rm --no-deps rab-api node dist/command upgrade --force\`: exit ${literal.code}`);
    const f = literal.code === 0 ? literal : l8.compose(['run', '--rm', '--no-deps', 'rab-api', 'node', FORCE_ENTRY, 'upgrade', '--force'], { timeout: 900_000 });
    evidence('L8-force.log', f.out);
    check(f.code === 0, `upgrade --force (${literal.code === 0 ? 'literal form' : FORCE_ENTRY}): exit ${f.code}`);
    const forcedRows = ledger(l8).filter((r) => r.forced);
    check(forcedRows.length > 0 && forcedRows.every((r) => r.version === NEW_VERSION), `the forced run wrote ${forcedRows.length} row(s), every one forced = true`);
    n(`${ledger(l8).length} logbook row(s) after the forced run`);
    await deployNew(l8, check, 'after --force');
  }, l8);

  const l9 = project('l9');
  await step('L9', 'two migrate children race for the lock on a seeded R256 database: no duplicate (name, attempt)', async (check) => {
    await freshSeeded(l9, check, IMG.r256, 256);
    l9.compose(['stop', 'rab-api', 'rab-worker'], { timeout: 300_000 });
    use(l9, IMG.next);
    l9.compose(['pull', 'rab-api'], { timeout: 600_000 });
    const runChild = () => l9.composeAsync(['run', '--rm', '--no-deps', '-e', 'CREWFLOW_MIGRATE_ON_START=true', 'rab-api', 'node', 'packages/rab-server/dist/database/typeorm/scripts/migrate/twenty/twenty-migrate.js']);
    const [a, b] = [runChild(), runChild()];
    const [ra, rb] = await Promise.all([a.done, b.done]);
    evidence('L9-a.log', ra.out);
    evidence('L9-b.log', rb.out);
    check(ra.code === 0 && rb.code === 0, `both children exit 0 (${ra.code}, ${rb.code})`);
    const rows = ledger(l9);
    check(attemptProblems(rows).length === 0 && rows.every((r) => r.attempt === 1), `no duplicate attempt (${rows.map((r) => `${r.name}:${r.attempt}`).join(', ')})`);
    check(rows.filter((r) => r.initial && r.ws === null).length === 1, 'exactly one instance is_initial row');
  }, l9);

  const l10 = project('l10');
  await step('L10', 'security stays fatal: a BYPASSRLS runtime login is refused, also under --force', async (check) => {
    await freshSeeded(l10, check, IMG.r256, 256);
    l10.psql('ALTER ROLE crewflow_owner BYPASSRLS');
    try {
      const { results: rs } = deployRefused(l10, check, IMG.next, 'bypassrls');
      check(rs.every((x) => x.serve !== true), 'never served');
      check(!hasLedger(l10), 'nothing applied (no logbook table)');
      l10.compose(['stop', 'rab-api', 'rab-worker'], { timeout: 300_000 });
      const f = l10.compose(['run', '--rm', '--no-deps', 'rab-api', 'node', FORCE_ENTRY, 'upgrade', '--force'], { timeout: 900_000 });
      evidence('L10-force.log', f.out);
      check(f.code !== 0 && !hasLedger(l10), `upgrade --force refused too (exit ${f.code}), nothing applied`);
    } finally {
      l10.psql('ALTER ROLE crewflow_owner NOBYPASSRLS');
    }
  }, l10);

  if (process.env.ULT_PG15_IMAGE) {
    const l10b = project('l10b');
    await step('L10b', 'PostgreSQL 15: refused (fatal)', async (check) => {
      const { results: rs, log } = deployRefused(l10b, check, IMG.next, 'pg15', process.env.ULT_PG15_IMAGE);
      check(rs.every((x) => x.serve !== true) && !/"serve":true/.test(log), 'never served on PostgreSQL 15');
    }, l10b);
  }

  const l11 = project('l11');
  await step('L11', 'deleting a seeded workspace removes its logbook rows (FK cascade) and nothing else', async (check) => {
    await freshSeeded(l11, check, IMG.r256, 256);
    await deployNew(l11, check, 'NEW');
    const ws = l11.psql("SELECT w.id FROM core.manager_workspace w JOIN core.organisation o ON o.id = w.organisation_id WHERE o.slug = 'dot-seed-a'");
    const other = l11.psql("SELECT w.id FROM core.manager_workspace w JOIN core.organisation o ON o.id = w.organisation_id WHERE o.slug = 'dot-seed-b'");
    l11.psql(`INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, is_initial, workspace_id, forced) VALUES ('${NEW_VERSION}_TypeOrmMigrations', 'completed', 1, '${NEW_VERSION}', true, '${ws}', false), ('${NEW_VERSION}_TypeOrmMigrations', 'completed', 1, '${NEW_VERSION}', true, '${other}', false)`);
    const instance = l11.psql("SELECT count(*) FROM core.upgrade_migration WHERE workspace_id IS NULL");
    l11.psql(`DELETE FROM core.manager_workspace WHERE id = '${ws}'`);
    check(l11.psql(`SELECT count(*) FROM core.upgrade_migration WHERE workspace_id = '${ws}'`) === '0', 'the deleted workspace\'s row is gone (cascade)');
    check(l11.psql(`SELECT count(*) FROM core.upgrade_migration WHERE workspace_id = '${other}'`) === '1', 'the other workspace keeps its row');
    check(l11.psql("SELECT count(*) FROM core.upgrade_migration WHERE workspace_id IS NULL") === instance, 'instance rows untouched');
    const denied = L.run('docker', ['exec', '-i', '-e', 'PGPASSWORD', l11.container('rab-postgres'), 'psql', '-X', '-At', 'host=127.0.0.1 sslmode=require dbname=crewflow user=crewflow_owner'], {
      input: "BEGIN; SELECT set_config('rab.upgrade_scope', 'upgrade', true); DELETE FROM core.upgrade_migration; ROLLBACK;",
      env: { PGPASSWORD: L.secrets.owner },
    });
    // Refused (no privilege) or DELETE 0 (no RLS policy admits a delete): either way nothing goes.
    check((denied.code !== 0 && /permission denied/i.test(denied.out)) || (denied.code === 0 && /DELETE 0/.test(denied.out)), `crewflow_owner in the upgrade scope deletes nothing (${denied.code === 0 ? 'no row matched' : 'refused'})`);
    check(l11.psql('SELECT count(*) FROM core.upgrade_migration WHERE workspace_id IS NULL') === instance, 'the instance rows are all still there');
  }, l11);

  writeResults();
  const failed = results.filter((r) => r.status === 'FAIL').length;
  note(`done: ${results.map((r) => `${r.id}=${r.status}`).join(' ')}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  note(`FATAL ${e && e.message ? e.message : e}`);
  writeResults();
  process.exit(1);
});
