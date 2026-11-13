'use strict';
/**
 * UPGRADE-WITH-DATA REAL-CONTAINER TESTS (Phase X U-1b, TEST-ONLY). Proves the U-1 upgrade floor (release-floor.ts) and the
 * kept controls on REAL containers with a SEEDED database, on one PostgreSQL major per run (16, 17 or 18), with the production
 * compose files unchanged and THE documented command `docker compose pull && docker compose up -d`:
 *
 *   DOT_REPOSITORY=127.0.0.1:<port>/adolphus            a LOCAL registry (never Docker Hub)
 *   DOT_PREV_DIGEST=sha256:…      R254: the published cd7c7e32 image (adhin007/adolphus:cd7c7e32…), re-pushed locally
 *   DOT_NEW_DIGEST=sha256:…       the image under test (U-1a or later), built locally
 *   DOT_PROBE_FAIL_DIGEST=sha256:…     NEW + probe/1786799990001-DotProbeFail.js      (probe/build-probe-images.cjs)
 *   DOT_PROBE_PARTIAL_DIGEST=sha256:…  NEW + probe/1786799990002-DotProbePartial.js   (probe/build-probe-images.cjs)
 *   [DOT_CONTROL_DIGEST=sha256:…] optional RED CONTROL: an image that still has N1 on the owner-login path (0e0a6edd / main
 *                                 before U-1a); it must refuse the seeded R254 database (SU-01), proving the test can fail
 *   DOT_PG_IMAGE=postgres@sha256:…  DOT_REDIS_IMAGE=redis@sha256:…
 *     node packages/rab-docker/deploy-order-tests/run-upgrade-with-data-tests.cjs <16|17|18> <out-dir> [--only=U1,U2,...]
 *
 *   [DOT_PROJECT_PREFIX=dou]       project names <prefix>-pg<major>-<case> (per agent / per run; never shared)
 *   <out-dir> must be OUTSIDE the repository (it holds the per-run secrets).
 *
 * Cases (each its own disposable project <prefix>-pg<major>-<case>; run one after another):
 *   U1  seed-then-upgrade: fresh PREV, SEED (seed-organisations.sql: 2 organisations, users, staff, venues, shifts,
 *       assignments, offers, attendance, payroll), facts; [control: N1 image refuses, 65, Worker never started, nothing
 *       applied]; NEW: floor passes, 254 -> 256, entity-cache epoch bump logged, API healthy before the Worker starts; the
 *       seeded row sets, money, FKs and tenant ownership unchanged (data-facts.sql); RLS regression as crewflow_owner;
 *       rollback to PREV: AHEAD, serves, data unchanged; then the comparator SELF-CHECK: a rewritten seeded value and a
 *       row moved to the other organisation make compareFacts FAIL, a wrong expectation makes rlsCheck FAIL, and the
 *       reverted data compares equal again.
 *   U2  skipped / unknown history refused: seeded PREV with its last four ledger rows removed (older than R254): NEW
 *       refuses (UnsupportedUpgradeStartError, exit 65) in a restart loop, nothing applied, Worker never started; the
 *       loop re-reads the ledger: a hole (1786721450000 recorded, 1786721440000 not) is refused too; the ledger repaired
 *       -> the same container applies and becomes healthy; the Worker starts on the next `up -d` (SU-02 behaviour).
 *   U3  crash mid-upgrade, then resume: the second index of OutboxClaimIndexes1786721440000 is blocked by a lock holder;
 *       while it waits the Worker is NOT started; the API container is SIGKILLed; the first index is left VALID without
 *       a ledger row (partial DDL), the migration lock is free; `up -d` resumes: 256, both indexes VALID, data unchanged.
 *   U4  failed transactional migration (C3, continue): PROBE_FAIL -> exit 70, the API serves with upgradeFailed:true, the
 *       Worker starts; 256 applied, the probe not recorded; data unchanged. NEW again -> CURRENT, upgradeFailed:false.
 *   U5  failed NON-transactional migration: PROBE_PARTIAL -> exit 70, serves; its first step (an index) stays, the probe is
 *       not recorded; NEW again -> CURRENT.
 *   U6  foreign database: an EMPTY database with a non-Crewflow table in `public` -> FOREIGN, DatabaseStateError (67),
 *       nothing created (no core schema), the Worker never started.
 *   U7  two migrate children racing for the lock on a seeded R254 database (the NEW image's migrate child, twice, while
 *       a holder keeps the advisory lock): both wait, one applies exactly 2, the other applies 0 and finds CURRENT; no
 *       duplicate ledger rows.
 *
 * DB-SETUP: the database is docker-compose.image.yml's bundled `db` (DOT_PG_IMAGE = a DEBIAN postgres image of the major:
 * the db service runs as 999:999 with the Debian volume layout; an alpine image does not fit it). Its first start runs the
 * shipped 01-crewflow-owner.sql (docker-compose.deploy-order-owner.yml), so every case starts from the hand-made
 * crewflow_owner every R254 deployment has, and compose.env holds that crewflow_owner URL as PG_DATABASE_URL: the
 * PASS-THROUGH path (D5). PR #125 (the Twenty Helm way): only db-setup reads it, checks it read-only and copies its password
 * into the setup volume's password file (never changing it); rab-api / rab-worker build their URL from the target file +
 * that password file. PREV and the red control have no worker-start.sh: their deploys add docker-compose.deploy-order-prev.yml
 * (the previous release's own start-up and its PG_DATABASE_URL), with the crewflow_owner URL whose password logs in now.
 *
 * Limits kept: at most five running containers of this run (db, rab-redis, rab-api, rab-worker + the operator's
 * registry; U7: two one-off migrate containers instead of rab-api/rab-worker); redis on a tmpfs, the db in the project's own
 * named volumes; cleanup is `down --volumes` of
 * this run's own projects only (never a prune, never another project). Secrets per run under <out>/secrets-<project>,
 * redacted from every output. Results: <out>/RESULTS.json, SUMMARY.md, run.log, evidence/.
 */
const fs = require('node:fs');
const path = require('node:path');

const L = require('./upgrade-lib.cjs');

const argv = process.argv.slice(2);
const MAJOR = argv[0];
const OUT = argv[1] ? path.resolve(process.platform === 'win32' ? argv[1].replace(/^\/([a-z])\//i, '$1:/') : argv[1]) : '';
const ONLY = (argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
const KEEP = argv.includes('--keep');
function fail(msg) {
  console.error(msg);
  process.exit(2);
}
if (!['16', '17', '18'].includes(MAJOR) || !OUT) fail('usage: run-upgrade-with-data-tests.cjs <16|17|18> <out-dir> [--only=U1,...] [--keep]');
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REF = /^[a-z0-9./_:-]+@sha256:[0-9a-f]{64}$/;
for (const k of ['DOT_PREV_DIGEST', 'DOT_NEW_DIGEST', 'DOT_PROBE_FAIL_DIGEST', 'DOT_PROBE_PARTIAL_DIGEST']) if (!DIGEST.test(process.env[k] ?? '')) fail(`${k} must be sha256:<64 hex>`);
if (process.env.DOT_CONTROL_DIGEST && !DIGEST.test(process.env.DOT_CONTROL_DIGEST)) fail('DOT_CONTROL_DIGEST must be sha256:<64 hex> when set');
for (const k of ['DOT_PG_IMAGE', 'DOT_REDIS_IMAGE']) if (!REF.test(process.env[k] ?? '')) fail(`${k} must be <repository>@sha256:<64 hex>`);
if (!/^127\.0\.0\.1:\d+\/[a-z0-9._/-]+$/.test(process.env.DOT_REPOSITORY ?? '')) fail('DOT_REPOSITORY must be a LOCAL registry repository (127.0.0.1:<port>/<name>)');

// Review note 7: outputs (which hold per-run secrets) never go inside the repository.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const inside = (child, parent) => {
  const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
if (inside(OUT, REPO_ROOT)) fail('the output directory must be OUTSIDE the repository (it holds per-run secrets)');
// Review note 6: the project-name prefix, so two runs (or two agents) never share or tear down each other's projects.
const PREFIX = process.env.DOT_PROJECT_PREFIX || 'dou';
if (!/^[a-z][a-z0-9-]{0,15}$/.test(PREFIX)) fail('DOT_PROJECT_PREFIX must match ^[a-z][a-z0-9-]{0,15}$');

const REPO = process.env.DOT_REPOSITORY;
const IMG = {
  prev: process.env.DOT_PREV_DIGEST,
  next: process.env.DOT_NEW_DIGEST,
  probeFail: process.env.DOT_PROBE_FAIL_DIGEST,
  probePartial: process.env.DOT_PROBE_PARTIAL_DIGEST,
  control: process.env.DOT_CONTROL_DIGEST || null,
};
const REGISTRY_CONTAINER = process.env.DOT_REGISTRY_CONTAINER || 'deploy-order-registry';
// + the one-shot db-setup (PR #125 options A and 2), which runs again on every `up -d` while the old stack may still run.
const MAX_CONTAINERS = 6;
const NEWER = ['OutboxClaimIndexes1786721440000', 'RefreshTokenReplacedByIndex1786721450000'];
const { SEEDED_TABLES, facts, compareFacts, rlsCheck } = L; // shared with run-db-setup-tests.cjs (S7)

fs.mkdirSync(path.join(OUT, 'evidence'), { recursive: true });
const results = [];
const logLines = [];
let peak = { count: 0, at: '', names: [] };
const projects = [];

function note(line) {
  const l = L.redact(line);
  logLines.push(l);
  console.log(`[${PREFIX}-pg${MAJOR}] ${l}`);
}
function evidence(name, text) {
  fs.writeFileSync(path.join(OUT, 'evidence', name), L.redact(text));
}
const imageRef = (digest) => `${REPO}@${digest}`;

function startPeakSampler() {
  const timer = setInterval(() => {
    const names = projects.map((p) => p.name);
    const r = L.run('docker', ['ps', '--format', '{{.Names}}|{{.Label "com.docker.compose.project"}}'], { timeout: 20_000 });
    const mine = r.stdout
      .split('\n')
      .filter(Boolean)
      .filter((l) => {
        const [n, proj] = l.split('|');
        return n === REGISTRY_CONTAINER || names.includes(proj);
      })
      .map((l) => l.split('|')[0]);
    if (mine.length > peak.count) peak = { count: mine.length, at: new Date().toISOString(), names: mine };
  }, 2000);
  timer.unref();
  return () => clearInterval(timer);
}

function project(kind, opts) {
  const p = new L.Project(`${PREFIX}-pg${MAJOR}-${kind}`, OUT, opts);
  projects.push(p);
  L.writeSecrets(p.secretsDir);
  return p;
}
/**
 * Points the project at `digest`; PREV (R254) and the red control predate DB-SETUP: their own start-up (prev overlay) and
 * the crewflow_owner URL with the password that logs in now (the hand-made one: PR #125 never changes it). The NEW images
 * keep the hand-made URL in compose.env (unchanged operator file): db-setup reads it and rab-api / rab-worker never do.
 */
function use(p, digest) {
  const prev = digest === IMG.prev || digest === IMG.control;
  p.setPrev(prev);
  L.writeComposeEnv(p, { repository: REPO, digest, pgImage: process.env.DOT_PG_IMAGE, redisImage: process.env.DOT_REDIS_IMAGE, databaseUrl: prev ? L.ownerUrl(p.ownerPasswordNow()) : L.ownerUrl() });
}

/** `p`: the case's project (failure logs, teardown). `down: false` keeps it running for the next case (U4 -> U5). */
async function step(id, title, fn, p, { down = true } = {}) {
  if (ONLY.length && !ONLY.includes(id)) return;
  const r = { id, title, status: 'NOT RUN', checks: [], notes: [] };
  results.push(r);
  note(`=== ${id} ${title}`);
  const check = (ok, what) => {
    r.checks.push({ ok: Boolean(ok), what: L.redact(what) });
    note(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
    return Boolean(ok);
  };
  try {
    await fn(check, (n) => {
      r.notes.push(L.redact(n));
      note(`  note: ${n}`);
    });
    r.status = r.checks.length && r.checks.every((c) => c.ok) ? 'PASS' : 'FAIL';
  } catch (e) {
    r.status = 'FAIL';
    r.checks.push({ ok: false, what: `threw: ${L.redact(e && e.message ? e.message : String(e))}` });
    note(`  FAIL threw: ${e && e.message ? e.message : e}`);
  } finally {
    // A failed case (a failed check or a throw) keeps its containers' logs, before any teardown.
    if (p && r.status === 'FAIL') for (const svc of ['rab-api', 'rab-worker']) evidence(`${id}-failure-${svc}.log`, L.run('docker', ['logs', '--tail', '400', p.container(svc)]).out);
    if (p && down && !KEEP) {
      const d = p.down();
      note(`  cleanup ${p.name}: compose down exit ${d.code}`);
    }
  }
  note(`=== ${id} ${r.status}`);
  writeResults();
}

function writeResults() {
  fs.writeFileSync(path.join(OUT, 'RESULTS.json'), JSON.stringify({ major: MAJOR, images: IMG, peak, results }, null, 2));
}

// ------------------------------------------------------------------------------------------------------- shared checks
/** A fresh deploy of PREV (R254), waited until both are healthy, then the seed. */
async function freshSeeded(p, check, { seed = true } = {}) {
  use(p, IMG.prev);
  const d = p.deploy();
  evidence(`${p.name}-prev-deploy.log`, d.out);
  check(d.code === 0, `fresh deploy of PREV (R254) exit ${d.code} after ${Math.round(d.ms / 1000)} s`);
  await p.waitHealthy('rab-api', 300_000);
  await p.waitHealthy('rab-worker', 300_000);
  check(p.psql('SELECT count(*) FROM core.migrations') === '254', 'PREV installed exactly the R254 set (254 ledger rows)');
  const pg = p.psql('SHOW server_version_num');
  check(pg.startsWith(MAJOR), `PostgreSQL major ${MAJOR} (server_version_num ${pg})`);
  if (seed) {
    p.psqlFile('seed-organisations.sql');
    check(p.psql(`SELECT count(*) FROM core.organisation WHERE slug::text LIKE 'dot-seed-%'`) === '2', 'seeded 2 synthetic organisations (users, staff, venues, shifts, offers, attendance, payroll)');
  }
}

/** Runs `fn` with a collecting `check` and returns the failed descriptions (the step's own checks are not touched). */
function failuresOf(fn) {
  const failed = [];
  fn((ok, what) => {
    if (!ok) failed.push(what);
    return Boolean(ok);
  });
  return failed;
}

/**
 * Review note 2: the comparators can FAIL. On the disposable database, after the real comparisons: (a) one seeded value is
 * rewritten -> compareFacts reports the content change; (b) one row is moved to the other organisation with FK triggers
 * off (session_replication_role = replica, superuser, this disposable database only) -> compareFacts reports the tenant
 * ownership violation; (c) rlsCheck is given a wrong expectation -> it fails. Each mutation is reverted and the facts are
 * proven equal again, so the case still ends on unchanged data.
 */
function comparatorSelfCheck(p, check, baseline) {
  const orgA = `(SELECT id FROM core.organisation WHERE slug = 'dot-seed-a')`;
  const orgB = `(SELECT id FROM core.organisation WHERE slug = 'dot-seed-b')`;
  const asg = p.psql(`SELECT id FROM core.shift_assignment WHERE organisation_id = ${orgA} ORDER BY id LIMIT 1`);
  const att = p.psql(`SELECT id FROM core.attendance WHERE organisation_id = ${orgA} ORDER BY id LIMIT 1`);
  if (!/^[0-9a-f-]{36}$/.test(asg) || !/^[0-9a-f-]{36}$/.test(att)) throw new Error('self-check: cannot pick the seeded rows');
  p.psql(`UPDATE core.shift_assignment SET pay_rate_snapshot_pence = pay_rate_snapshot_pence + 1 WHERE id = '${asg}'`);
  const a = failuresOf((c) => compareFacts(c, baseline, facts(p), 'self-check'));
  check(a.some((w) => /CONTENT is identical.*changed: content\|shift_assignment\|dot-seed-a/.test(w)), `SELF-CHECK: a rewritten pay_rate_snapshot_pence makes compareFacts FAIL (${a.length} failure(s))`);
  p.psql(`UPDATE core.shift_assignment SET pay_rate_snapshot_pence = pay_rate_snapshot_pence - 1 WHERE id = '${asg}'`);
  p.psql(`SET session_replication_role = replica; UPDATE core.attendance SET organisation_id = ${orgB} WHERE id = '${att}'`);
  const b = failuresOf((c) => compareFacts(c, baseline, facts(p), 'self-check'));
  check(b.some((w) => /tenant ownership holds.*violations: .*payroll_record\.payroll_record_attendance_id_fkey=1/.test(w)), `SELF-CHECK: an attendance row moved to the other organisation makes compareFacts FAIL on tenant ownership (${b.length} failure(s))`);
  p.psql(`SET session_replication_role = replica; UPDATE core.attendance SET organisation_id = ${orgA} WHERE id = '${att}'`);
  const r = failuresOf((c) => rlsCheck(p, c, 'self-check', { tamperExpected: true }));
  check(r.some((w) => /organisation A's context/.test(w)), 'SELF-CHECK: rlsCheck FAILS when given a wrong expectation');
  const back = failuresOf((c) => compareFacts(c, baseline, facts(p), 'self-check'));
  check(back.length === 0, `SELF-CHECK: both mutations reverted, the facts equal the baseline again${back.length ? ` (${back.join('; ')})` : ''}`);
}

function migrateResult(log) {
  const lines = [...log.matchAll(/TWENTY_MIGRATE_RESULT (\{.*\})/g)].map((m) => {
    try {
      return JSON.parse(m[1]);
    } catch {
      return null;
    }
  });
  return lines.filter(Boolean);
}

// ------------------------------------------------------------------------------------------------------------- main
async function main() {
  L.newSecrets();
  const stopSampler = startPeakSampler();
  note(`PostgreSQL ${process.env.DOT_PG_IMAGE}; PREV ${imageRef(IMG.prev)}; NEW ${imageRef(IMG.next)}; control ${IMG.control ? imageRef(IMG.control) : '(not set)'}`);

  // ---------------------------------------------------------------------------------------------------------------- U1
  const u1 = project('u1');
  await step('U1', 'seed-then-upgrade R254 -> NEW: floor passes, data intact, RLS holds; [control refuses]; rollback is AHEAD and serves', async (check, n) => {
    await freshSeeded(u1, check);
    const before = facts(u1);
    evidence('U1-facts-before.txt', before.lines.join('\n'));
    rlsCheck(u1, check, 'before');
    if (IMG.control) {
      u1.setShortHealth(true);
      use(u1, IMG.control);
      const since = L.watchEvents(u1.name); // live stream: the daemon's replay buffer overflows on a busy host
      const d = u1.deploy(900_000);
      evidence('U1-control-deploy.log', d.out);
      check(d.code !== 0, `RED CONTROL (N1 image ${IMG.control.slice(0, 19)}…): the deploy FAILS on the seeded R254 database (exit ${d.code})`);
      const al = u1.logs('rab-api');
      evidence('U1-control-api.log', al);
      check(/UnapprovedProductionMigrationError/.test(al) && /"exitCode":65/.test(al), 'RED CONTROL: N1 refused (UnapprovedProductionMigrationError, exit 65): the SU-01 outage this item removes');
      check(u1.neverStarted('rab-worker'), 'RED CONTROL: the Worker was never started');
      check(!u1.events(since, L.nowS() + 1).some((e) => e.service === 'rab-worker' && e.action === 'start'), 'RED CONTROL: no rab-worker start event');
      check(u1.psql('SELECT count(*) FROM core.migrations') === '254', 'RED CONTROL: nothing applied (254)');
      u1.setShortHealth(false);
    } else n('red control skipped (DOT_CONTROL_DIGEST not set)');
    use(u1, IMG.next);
    const since = L.watchEvents(u1.name); // live stream: the daemon's replay buffer overflows on a busy host
    const d = u1.deploy();
    evidence('U1-new-deploy.log', d.out);
    check(d.code === 0, `deploy of NEW on the seeded R254 database: exit ${d.code} after ${Math.round(d.ms / 1000)} s`);
    await u1.waitHealthy('rab-api', 300_000);
    await u1.waitHealthy('rab-worker', 300_000);
    const al = u1.logs('rab-api');
    evidence('U1-new-api.log', al);
    evidence('U1-new-worker.log', u1.logs('rab-worker'));
    check(/upgrade floor: upgrade floor passed: the ledger contains R254; 2 migration\(s\) to apply/.test(al), 'the API log shows the floor admitting R254 (2 to apply)');
    check(/fresh install not proven/.test(al), 'the database was NOT a fresh install (tenant rows exist)');
    const res = migrateResult(al).pop() || {};
    check(res.exitCode === 0 && res.state === 'CHAIN-PARTIAL' && JSON.stringify(res.applied) === JSON.stringify(NEWER), `migrate result: exit ${res.exitCode}, ${res.state}, applied ${JSON.stringify(res.applied)}`);
    check(/entity-cache epoch bumped after 2 applied migration/.test(al), 'the allow-listed entity-cache epoch bump ran once after the applying run');
    check(u1.psql('SELECT count(*) FROM core.migrations') === '256', 'ledger 254 -> 256');
    const evs = u1.events(since, L.nowS() + 1);
    evidence('U1-new-events.txt', L.fmtEvents(evs));
    const apiHealthy = evs.find((e) => e.action.startsWith('health_status: healthy') && e.service === 'rab-api');
    const workerStart = evs.filter((e) => e.action === 'start' && e.service === 'rab-worker').pop();
    check(Boolean(apiHealthy && workerStart && apiHealthy.t < workerStart.t), `the NEW API was healthy ${apiHealthy ? L.iso(apiHealthy.t) : '?'} BEFORE the NEW Worker started ${workerStart ? L.iso(workerStart.t) : '?'}`);
    for (const s of ['rab-api', 'rab-worker']) check(u1.inspect(s, '{{.Config.Image}}') === imageRef(IMG.next), `${s} runs NEW`);
    const after = facts(u1);
    evidence('U1-facts-after.txt', after.lines.join('\n'));
    compareFacts(check, before, after, 'after the upgrade');
    rlsCheck(u1, check, 'after the upgrade');
    const hz = u1.healthz();
    check(hz.code === 0 && /"upgradeFailed":\s*false/.test(hz.body), `/healthz upgradeFailed:false (${hz.body.slice(0, 120)})`);
    // Rollback to PREV with the same command: AHEAD, serves, data unchanged.
    use(u1, IMG.prev);
    const r = u1.deploy();
    evidence('U1-rollback-deploy.log', r.out);
    check(r.code === 0, `rollback to PREV: exit ${r.code}`);
    await u1.waitHealthy('rab-api', 300_000);
    await u1.waitHealthy('rab-worker', 300_000);
    const rl = u1.logs('rab-api');
    evidence('U1-rollback-api.log', rl);
    check(/database state AHEAD/.test(rl), 'the old API classified the database AHEAD and served');
    compareFacts(check, before, facts(u1), 'after the rollback');
    comparatorSelfCheck(u1, check, before);
  }, u1);

  // ---------------------------------------------------------------------------------------------------------------- U2
  const u2 = project('u2');
  await step('U2', 'older and holed histories are refused (65, restart loop, nothing applied, Worker never started); a repaired ledger then upgrades', async (check, n) => {
    await freshSeeded(u2, check);
    const removed = u2.psql(`DELETE FROM core.migrations WHERE id IN (SELECT id FROM core.migrations ORDER BY timestamp DESC, id DESC LIMIT 4) RETURNING name || '|' || timestamp`).split('\n');
    n(`removed the last 4 ledger rows (an older history than R254): ${removed.map((x) => x.split('|')[0]).join(', ')}`);
    const before = facts(u2);
    u2.setShortHealth(true); // the refusal is reported in about a minute (the fresh install above used the production window)
    use(u2, IMG.next);
    const d = u2.deploy(900_000);
    evidence('U2-older-deploy.log', d.out);
    check(d.code !== 0, `deploy of NEW on the older history FAILS (exit ${d.code}): compose reports the unhealthy API`);
    await L.waitFor('a second refusal (restart loop)', () => (u2.logs('rab-api').match(/UnsupportedUpgradeStartError/g) || []).length >= 4, 240_000, 5000);
    let al = u2.logs('rab-api');
    evidence('U2-older-api.log', al);
    check(/older than every supported release/.test(al) && migrateResult(al).length >= 1 && migrateResult(al).every((r) => r.exitCode === 65 && r.serve === false), `refused with UnsupportedUpgradeStartError, every attempt (${migrateResult(al).length}) exit 65, serve:false (fail closed under continue)`);
    check(Number(u2.health('rab-api').split('|')[3]) >= 1, `the API is in its restart loop (${u2.health('rab-api')})`);
    check(u2.neverStarted('rab-worker'), 'the Worker was never started');
    check(u2.psql('SELECT count(*) FROM core.migrations') === '250', 'nothing applied (250 ledger rows)');
    compareFacts(check, before, facts(u2), 'after the refusal');
    // The restart loop re-reads the ledger: a hole is refused too.
    // One transaction: the loop must never see plain R254 in between (it would upgrade).
    const values = removed.map((row) => {
      const [name, ts] = row.split('|');
      if (!/^[A-Za-z0-9]+$/.test(name) || !/^\d{13}$/.test(ts)) throw new Error('unexpected ledger row');
      return `(${ts}, '${name}')`;
    });
    u2.psql(`INSERT INTO core.migrations (timestamp, name) VALUES ${[...values, `(1786721450000, '${NEWER[1]}')`].join(', ')}`);
    await L.waitFor('the hole refusal', () => /not contiguously/.test(u2.logs('rab-api')), 300_000, 5000);
    check(u2.psql(`SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('core.email_outbox_claim_idx')`) === '', 'hole (1786721450000 recorded, 1786721440000 not): refused, the 1786721440000 index was not built');
    check(u2.neverStarted('rab-worker'), 'the Worker is still not started');
    // Repair: the same restarting container upgrades; the Worker starts on the next documented command.
    u2.psql(`DELETE FROM core.migrations WHERE name = '${NEWER[1]}'`);
    await u2.waitHealthy('rab-api', 400_000);
    check(u2.psql('SELECT count(*) FROM core.migrations') === '256', 'after the ledger repair the restarting API applied both migrations (256) and became healthy');
    check(u2.neverStarted('rab-worker'), 'SU-02: the Worker stays not started until the next `up -d` (compose had already reported the failure)');
    const up = u2.compose(['up', '-d'], { timeout: 600_000 });
    evidence('U2-up-again.log', up.out);
    await u2.waitHealthy('rab-worker', 300_000);
    check(!u2.neverStarted('rab-worker'), `the next \`docker compose up -d\` (exit ${up.code}) started the Worker`);
    al = u2.logs('rab-api');
    evidence('U2-api-final.log', al);
  }, u2);

  // ---------------------------------------------------------------------------------------------------------------- U3
  const u3 = project('u3');
  await step('U3', 'crash in the middle of the upgrade (API SIGKILLed inside a transaction=false migration), then resume', async (check, n) => {
    await freshSeeded(u3, check);
    const before = facts(u3);
    const holder = await u3.holdLock('LOCK TABLE core.push_delivery IN SHARE MODE');
    n(`lock holder pid ${holder.pid}: core.push_delivery SHARE (blocks the second CREATE INDEX CONCURRENTLY of ${NEWER[0]} for up to its 60 s lock_timeout)`);
    use(u3, IMG.next);
    const dep = u3.deployAsync();
    try {
      await L.waitFor('the API migrate child to block on the push_delivery index', () => u3.psql(`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE 'CREATE INDEX CONCURRENTLY%push_delivery_claim_idx%'`) === '1', 120_000, 1000); // db-setup runs first (PR #125)
      check(true, 'the migrate child is inside OutboxClaimIndexes1786721440000, waiting for its second index');
      check(u3.neverStarted('rab-worker'), 'Worker waiting: the new Worker is not started while the API migrates');
      check(u3.psql(`SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('core.email_outbox_claim_idx')`) === 't', 'the first index (email_outbox_claim_idx) is already built: partial DDL of a transaction=false migration');
      const k = L.run('docker', ['kill', '--signal', 'KILL', u3.container('rab-api')]);
      check(k.code === 0, 'SIGKILL of the rab-api container mid-migration');
      await holder.release();
      await L.waitFor('the killed session to end', () => u3.psql(`SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted AND ((classid::bigint << 32) | objid::bigint) = ${L.MIGRATION_LOCK_KEY_SQL}`) === '0', 60_000, 1000);
      check(true, 'the killed migration session ended and released the migration lock');
      check(!u3.health('rab-api').startsWith('healthy') && u3.inspect('rab-api', '{{.State.Status}}') === 'exited', `the killed API stays down (${u3.health('rab-api')}): no restart behind the test's back`);
      check(u3.psql(`SELECT count(*) FROM core.migrations`) === '254', 'just after the kill: the ledger is still 254 (nothing of the interrupted run recorded)');
      check(
        u3.psql(`SELECT (SELECT count(*) FROM core.migrations WHERE name = '${NEWER[0]}') || '|' || coalesce((SELECT indisvalid::text FROM pg_index WHERE indexrelid = to_regclass('core.email_outbox_claim_idx')), 'absent')`) === '0|true',
        'the first index stays (VALID) WITHOUT a ledger row for OutboxClaimIndexes1786721440000: partial DDL of the killed transaction=false migration',
      );
    } finally {
      await holder.release().catch(() => undefined);
    }
    const dr = await dep.done;
    evidence('U3-deploy.log', dr.out);
    n(`the interrupted deploy command ended with exit ${dr.code}`);
    const up = u3.deploy();
    evidence('U3-resume-deploy.log', up.out);
    check(up.code === 0, `the documented command again resumes: exit ${up.code}`);
    await u3.waitHealthy('rab-api', 300_000);
    await u3.waitHealthy('rab-worker', 300_000);
    check(u3.psql('SELECT count(*) FROM core.migrations') === '256', 'resumed: ledger 256');
    check(u3.psql(`SELECT string_agg(c.relname || '=' || i.indisvalid, ',' ORDER BY c.relname) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname IN ('email_outbox_claim_idx', 'push_delivery_claim_idx')`) === 'email_outbox_claim_idx=true,push_delivery_claim_idx=true', 'both indexes VALID (no INVALID leftover)');
    check(u3.psql(`SELECT count(*) - count(DISTINCT name) FROM core.migrations`) === '0', 'no migration recorded twice');
    evidence('U3-api.log', u3.logs('rab-api'));
    compareFacts(check, before, facts(u3), 'after the crash and resume');
  }, u3);

  // ---------------------------------------------------------------------------------------------------------- U4 + U5
  const u4 = project('u4');
  await step('U4', 'a failed TRANSACTIONAL upgrade migration (C3 continue): exit 70, serves, Worker starts, data intact; NEW then CURRENT', async (check) => {
    await freshSeeded(u4, check);
    const before = facts(u4);
    use(u4, IMG.probeFail);
    const d = u4.deploy();
    evidence('U4-deploy.log', d.out);
    check(d.code === 0, `deploy of NEW+DotProbeFail: exit ${d.code} (the API serves degraded)`);
    await u4.waitHealthy('rab-api', 300_000);
    await u4.waitHealthy('rab-worker', 300_000);
    const al = u4.logs('rab-api');
    evidence('U4-api.log', al);
    const res = migrateResult(al).pop() || {};
    check(res.exitCode === 70 && res.serve === true && res.failedMigration === 'DotProbeFail1786799990001', `migrate result: exit ${res.exitCode}, serve ${res.serve}, failed ${res.failedMigration}`);
    // (The result line's `applied` lists only a SUCCESSFUL run's work; after a failure it is empty, so the ledger decides.)
    check(u4.psql(`SELECT count(*) FROM core.migrations WHERE name IN ('${NEWER[0]}', '${NEWER[1]}')`) === '2', 'the two real migrations were applied (and recorded) before the probe failed');
    check(/upgrade floor passed/.test(al), 'the floor admitted R254 (no N1 patch needed, unlike the O3 harness)');
    const hz = u4.healthz();
    check(/"upgradeFailed":\s*true/.test(hz.body), `/healthz upgradeFailed:true (${hz.body.slice(0, 120)})`);
    check(u4.psql(`SELECT count(*) FROM core.migrations WHERE name LIKE 'DotProbe%'`) === '0', 'the failed probe is not recorded');
    compareFacts(check, before, facts(u4), 'after the failed upgrade');
    use(u4, IMG.next);
    const r = u4.deploy();
    check(r.code === 0, `NEW (without the probe): exit ${r.code}`);
    await u4.waitHealthy('rab-api', 300_000);
    check(/"upgradeFailed":\s*false/.test(u4.healthz().body), 'NEW: CURRENT, upgradeFailed:false');
  }, u4, { down: Boolean(ONLY.length) && !ONLY.includes('U5') }); // U5 continues on this stack; tear it down here only when U5 will not run

  await step('U5', 'a failed NON-transactional migration: exit 70, serves; its committed first step stays, the probe is not recorded; NEW then CURRENT', async (check) => {
    if (!u4.inspect('rab-api', '{{.Id}}')) await freshSeeded(u4, check);
    const before = facts(u4);
    use(u4, IMG.probePartial);
    const d = u4.deploy();
    evidence('U5-deploy.log', d.out);
    check(d.code === 0, `deploy of NEW+DotProbePartial: exit ${d.code}`);
    await u4.waitHealthy('rab-api', 300_000);
    await u4.waitHealthy('rab-worker', 300_000);
    const al = u4.logs('rab-api');
    evidence('U5-api.log', al);
    const res = migrateResult(al).pop() || {};
    check(res.exitCode === 70 && res.serve === true && res.failedMigration === 'DotProbePartial1786799990002', `migrate result: exit ${res.exitCode}, serve ${res.serve}, failed ${res.failedMigration}`);
    check(u4.psql(`SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('core.dot_probe_partial_idx')`) === 't', 'partial DDL: the probe\'s committed first step (dot_probe_partial_idx) exists without a ledger row');
    check(u4.psql(`SELECT count(*) FROM core.migrations WHERE name LIKE 'DotProbe%'`) === '0', 'the probe is not recorded');
    compareFacts(check, before, facts(u4), 'after the partial failure');
    use(u4, IMG.next);
    const r = u4.deploy();
    check(r.code === 0, `NEW (without the probe): exit ${r.code}`);
    await u4.waitHealthy('rab-api', 300_000);
    check(/"upgradeFailed":\s*false/.test(u4.healthz().body), 'NEW: CURRENT, upgradeFailed:false');
  }, u4);

  // ---------------------------------------------------------------------------------------------------------------- U6
  const u6 = project('u6', { shortHealth: true });
  await step('U6', 'a FOREIGN database is refused (67), nothing created, the Worker never started', async (check) => {
    use(u6, IMG.next);
    const pg = u6.compose(['up', '-d', '--wait', L.DB_SERVICE], { timeout: 300_000 });
    check(pg.code === 0, `db up (exit ${pg.code})`);
    u6.psql(`CREATE TABLE public.not_crewflow (id int); INSERT INTO public.not_crewflow VALUES (1);`);
    const d = u6.deploy(900_000);
    evidence('U6-deploy.log', d.out);
    check(d.code !== 0, `deploy of NEW on a foreign database FAILS (exit ${d.code})`);
    const al = u6.logs('rab-api');
    evidence('U6-api.log', al);
    check(/state FOREIGN/.test(al) && /DatabaseStateError/.test(al) && migrateResult(al).length >= 1 && migrateResult(al).every((r) => r.exitCode === 67), `classified FOREIGN, refused with DatabaseStateError, every attempt (${migrateResult(al).length}) exit 67`);
    check(u6.psql(`SELECT count(*) FROM pg_namespace WHERE nspname = 'core'`) === '0', 'nothing created (no core schema)');
    check(u6.psql('SELECT count(*) FROM public.not_crewflow') === '1', 'the foreign table is untouched');
    check(u6.neverStarted('rab-worker'), 'the Worker was never started');
  }, u6);

  // ---------------------------------------------------------------------------------------------------------------- U7
  const u7 = project('u7');
  await step('U7', 'two migrate children race for the lock on a seeded R254 database: one applies 2, the other waits and finds CURRENT', async (check, n) => {
    await freshSeeded(u7, check);
    const stop = u7.compose(['stop', 'rab-worker', 'rab-api'], { timeout: 300_000 });
    check(stop.code === 0, 'rab-api and rab-worker stopped (the race is between two one-off migrate children)');
    use(u7, IMG.next);
    const pull = u7.compose(['pull', 'rab-api', 'db-setup'], { timeout: 600_000 });
    check(pull.code === 0, 'NEW pulled');
    // PR #125: rab-api never receives a database URL; the documented one-off form (the production entrypoint with a
    // command) builds the crewflow_owner URL from db-setup's target file, so NEW's db-setup runs once first.
    const setup = u7.compose(['run', '--rm', '-T', '--no-deps', 'db-setup'], { timeout: 300_000 });
    evidence('U7-db-setup.log', setup.out);
    check(setup.code === 0, `NEW's db-setup (one-off): exit ${setup.code} (target and password files written; crewflow_owner unchanged)`);
    const holder = await u7.holdLock(`SELECT pg_advisory_lock(${L.MIGRATION_LOCK_KEY_SQL})`);
    const child = () => u7.composeAsync(['run', '--rm', '-T', '--no-deps', 'rab-api', 'node', 'packages/rab-server/dist/database/typeorm/scripts/migrate/twenty/twenty-migrate.js']);
    const c1 = child();
    const c2 = child();
    try {
      await L.waitFor('both children to wait for the lock', () => (c1.output().match(/taking the migration lock/g) || []).length + (c2.output().match(/taking the migration lock/g) || []).length >= 2, 240_000, 2000);
      check(true, 'both children are waiting on the migration advisory lock');
    } finally {
      await holder.release();
    }
    const [r1, r2] = await Promise.all([c1.done, c2.done]);
    evidence('U7-child-1.log', r1.out);
    evidence('U7-child-2.log', r2.out);
    const a = migrateResult(r1.out).pop() || {};
    const b = migrateResult(r2.out).pop() || {};
    n(`child 1: exit ${r1.code} applied ${JSON.stringify(a.applied)} state ${a.state}; child 2: exit ${r2.code} applied ${JSON.stringify(b.applied)} state ${b.state}`);
    check(r1.code === 0 && r2.code === 0, 'both children exit 0');
    const applied = [a.applied || [], b.applied || []].sort((x, y) => y.length - x.length);
    check(JSON.stringify(applied[0]) === JSON.stringify(NEWER) && applied[1].length === 0, 'exactly one applied the two migrations; the other applied nothing');
    check([a.state, b.state].sort().join(',') === 'CHAIN-PARTIAL,CURRENT', `the second found the database CURRENT after waiting (${a.state}, ${b.state})`);
    check(u7.psql(`SELECT count(*) || '|' || count(DISTINCT name) FROM core.migrations`) === '256|256', 'ledger 256, no duplicate rows');
  }, u7);

  stopSampler();
  note(`peak of this run's running containers: ${peak.count} at ${peak.at} (${peak.names.join(', ')})`);
  writeResults();
  const summary = [
    `# Upgrade-with-data tests, PostgreSQL ${MAJOR}`,
    '',
    `PREV \`${imageRef(IMG.prev)}\`, NEW \`${imageRef(IMG.next)}\`; command \`docker compose pull && docker compose up -d\``,
    `peak running containers of this run: ${peak.count} (cap ${MAX_CONTAINERS})`,
    '',
    '| case | status | checks |',
    '|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.status} | ${r.checks.filter((c) => c.ok).length}/${r.checks.length} |`),
    '',
    ...results.flatMap((r) => [`## ${r.id} ${r.status}: ${r.title}`, ...r.checks.map((c) => `- ${c.ok ? 'ok' : '**FAIL**'} ${c.what}`), ...r.notes.map((x) => `- note: ${x}`), '']),
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'SUMMARY.md'), summary);
  fs.writeFileSync(path.join(OUT, 'run.log'), logLines.join('\n'));
  if (peak.count > MAX_CONTAINERS) note(`CONTAINER CAP EXCEEDED: ${peak.count} > ${MAX_CONTAINERS}`);
  process.exitCode = results.length > 0 && results.every((r) => r.status === 'PASS') && peak.count <= MAX_CONTAINERS ? 0 : 1;
}

main().catch((e) => {
  console.error(L.redact(e && e.stack ? e.stack : String(e)));
  for (const p of projects) if (!KEEP) p.down();
  process.exit(1);
});
