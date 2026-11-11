'use strict';
/**
 * UPGRADE-WITH-DATA REAL-CONTAINER TESTS (Phase X U-1b, TEST-ONLY). Proves the U-1 upgrade floor (release-floor.ts) and the
 * kept controls on REAL containers with a SEEDED database, on one PostgreSQL major per run (16 or 18), with the production
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
 *     node packages/rab-docker/deploy-order-tests/run-upgrade-with-data-tests.cjs <16|18> <out-dir> [--only=U1,U2,...]
 *
 * Cases (each its own disposable project dou-pg<major>-<case>; run one after another):
 *   U1  seed-then-upgrade: fresh PREV, SEED (seed-organisations.sql: 2 organisations, users, staff, venues, shifts,
 *       assignments, offers, attendance, payroll), facts; [control: N1 image refuses, 65, Worker never started, nothing
 *       applied]; NEW: floor passes, 254 -> 256, entity-cache epoch bump logged, API healthy before the Worker starts; the
 *       seeded row sets, money, FKs and tenant ownership unchanged (data-facts.sql); RLS regression as crewflow_owner;
 *       rollback to PREV: AHEAD, serves, data unchanged.
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
 * Limits kept: at most five running containers of this run (rab-postgres, rab-redis, rab-api, rab-worker + the operator's
 * registry; U7: two one-off migrate containers instead of rab-api/rab-worker); every data dir a tmpfs; cleanup is `down` of
 * this run's own projects only (never a prune, never another project). Secrets per run under <out>/secrets-<project>,
 * redacted from every output. Results: <out>/RESULTS.json, SUMMARY.md, run.log, evidence/.
 */
const fs = require('node:fs');
const path = require('node:path');

const L = require('./upgrade-lib.cjs');

const argv = process.argv.slice(2);
const MAJOR = argv[0];
const OUT = argv[1] ? path.resolve(argv[1]) : '';
const ONLY = (argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
const KEEP = argv.includes('--keep');
function fail(msg) {
  console.error(msg);
  process.exit(2);
}
if (!['16', '18'].includes(MAJOR) || !OUT) fail('usage: run-upgrade-with-data-tests.cjs <16|18> <out-dir> [--only=U1,...] [--keep]');
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REF = /^[a-z0-9./_:-]+@sha256:[0-9a-f]{64}$/;
for (const k of ['DOT_PREV_DIGEST', 'DOT_NEW_DIGEST', 'DOT_PROBE_FAIL_DIGEST', 'DOT_PROBE_PARTIAL_DIGEST']) if (!DIGEST.test(process.env[k] ?? '')) fail(`${k} must be sha256:<64 hex>`);
if (process.env.DOT_CONTROL_DIGEST && !DIGEST.test(process.env.DOT_CONTROL_DIGEST)) fail('DOT_CONTROL_DIGEST must be sha256:<64 hex> when set');
for (const k of ['DOT_PG_IMAGE', 'DOT_REDIS_IMAGE']) if (!REF.test(process.env[k] ?? '')) fail(`${k} must be <repository>@sha256:<64 hex>`);
if (!/^127\.0\.0\.1:\d+\/[a-z0-9._/-]+$/.test(process.env.DOT_REPOSITORY ?? '')) fail('DOT_REPOSITORY must be a LOCAL registry repository (127.0.0.1:<port>/<name>)');

const REPO = process.env.DOT_REPOSITORY;
const IMG = {
  prev: process.env.DOT_PREV_DIGEST,
  next: process.env.DOT_NEW_DIGEST,
  probeFail: process.env.DOT_PROBE_FAIL_DIGEST,
  probePartial: process.env.DOT_PROBE_PARTIAL_DIGEST,
  control: process.env.DOT_CONTROL_DIGEST || null,
};
const REGISTRY_CONTAINER = process.env.DOT_REGISTRY_CONTAINER || 'deploy-order-registry';
const MAX_CONTAINERS = 5;
const NEWER = ['OutboxClaimIndexes1786721440000', 'RefreshTokenReplacedByIndex1786721450000'];
/** The tables the seed writes: their row sets (count + md5 of ids) per organisation must not change across an upgrade. */
const SEEDED_TABLES = [
  'attendance', 'job_offer', 'job_role', 'manager_profile', 'manager_workspace', 'payroll_calendar', 'payroll_calendar_period', 'payroll_record',
  'payroll_run', 'payroll_run_line', 'role', 'shift', 'shift_assignment', 'staff_profile', 'user', 'venue', 'workspace_membership',
];

fs.mkdirSync(path.join(OUT, 'evidence'), { recursive: true });
const results = [];
const logLines = [];
let peak = { count: 0, at: '', names: [] };
const projects = [];

function note(line) {
  const l = L.redact(line);
  logLines.push(l);
  console.log(`[dou-pg${MAJOR}] ${l}`);
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
  const p = new L.Project(`dou-pg${MAJOR}-${kind}`, OUT, opts);
  projects.push(p);
  L.writeSecrets(p.secretsDir);
  return p;
}
function use(p, digest) {
  L.writeComposeEnv(p, { repository: REPO, digest, pgImage: process.env.DOT_PG_IMAGE, redisImage: process.env.DOT_REDIS_IMAGE });
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
    if (p) for (const svc of ['rab-api', 'rab-worker']) evidence(`${id}-failure-${svc}.log`, L.run('docker', ['logs', '--tail', '400', p.container(svc)]).out);
  } finally {
    if (p && !KEEP) {
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

function facts(p) {
  const lines = p.psqlFile('data-facts.sql').split('\n').filter(Boolean);
  const map = new Map(lines.map((l) => [l.slice(0, l.lastIndexOf('|')), l.slice(l.lastIndexOf('|') + 1)]));
  return { lines, map };
}

/** Seeded row sets and money equal; every FK holds; every cross-table organisation_id agrees. */
function compareFacts(check, before, after, label) {
  const seeded = [...before.map.keys()].filter((k) => k.startsWith('rows|') && SEEDED_TABLES.includes(k.split('|')[1]));
  const changed = seeded.filter((k) => before.map.get(k) !== after.map.get(k));
  check(seeded.length === SEEDED_TABLES.length * 2 && changed.length === 0, `${label}: the seeded row sets of ${SEEDED_TABLES.length} tables x 2 organisations are identical (count + md5 of ids)${changed.length ? `; changed: ${changed.join(', ')}` : ''}`);
  const nonZero = (k) => [...before.map.keys()].filter((key) => key.startsWith('rows|') && key.split('|')[1] === k && !before.map.get(key).startsWith('0:'));
  check(nonZero('payroll_record').length === 2 && nonZero('attendance').length === 2, `${label}: the seed is really there (payroll and attendance rows in both organisations)`);
  const money = [...before.map.keys()].filter((k) => k.startsWith('money|'));
  const moneyChanged = money.filter((k) => before.map.get(k) !== after.map.get(k));
  check(money.length === 6 && moneyChanged.length === 0, `${label}: payroll pence and worked minutes unchanged (${money.map((k) => `${k.slice(6)}=${after.map.get(k)}`).join(', ')})`);
  const fkBad = [...after.map.entries()].filter(([k, v]) => k.startsWith('fk|') && v !== '0');
  const fkCount = [...after.map.keys()].filter((k) => k.startsWith('fk|')).length;
  check(fkCount > 100 && fkBad.length === 0, `${label}: all ${fkCount} core foreign keys hold row by row${fkBad.length ? `; orphans: ${fkBad.map(([k, v]) => `${k}=${v}`).join(', ')}` : ''}`);
  const ownBad = [...after.map.entries()].filter(([k, v]) => k.startsWith('own|') && v !== '0');
  const ownCount = [...after.map.keys()].filter((k) => k.startsWith('own|')).length;
  check(ownCount > 20 && ownBad.length === 0, `${label}: tenant ownership holds on ${ownCount} cross-table references (child organisation_id = parent's)${ownBad.length ? `; violations: ${ownBad.map(([k, v]) => `${k}=${v}`).join(', ')}` : ''}`);
}

/** RLS regression as the runtime login: no context -> zero rows; organisation A's context -> exactly A's rows, none of B's. */
function rlsCheck(p, check, label) {
  const ids = p
    .psql(`SELECT o.slug || ' ' || o.id || ' ' || w.id || ' ' || w.owner_user_id FROM core.organisation o JOIN core.manager_workspace w ON w.organisation_id = o.id WHERE o.slug::text LIKE 'dot-seed-%' ORDER BY o.slug`)
    .split('\n')
    .map((l) => l.split(' '));
  const [a, b] = ids;
  const uuid = /^[0-9a-f-]{36}$/;
  if (!a || !b || ![...a.slice(1), ...b.slice(1)].every((v) => uuid.test(v))) throw new Error('cannot read the seeded organisation ids');
  const tables = ['shift', 'shift_assignment', 'job_offer', 'attendance', 'payroll_record', 'payroll_run_line', 'staff_profile', 'venue'];
  const counts = (where = '') => tables.map((t) => `(SELECT count(*) FROM core.${t}${where})`).join(" || ',' || ");
  const none = p.psqlOwner(`SELECT ${counts()};`);
  check(/^0(,0)*$/.test(none) && none.split(',').length === tables.length, `${label}: crewflow_owner with NO tenant context reads 0 rows from ${tables.length} tenant tables (${none})`);
  const ctx = (org, ws, user) => `BEGIN; SELECT set_config('rab.organisation_id', '${org}', true), set_config('rab.workspace_id', '${ws}', true), set_config('rab.user_id', '${user}', true);`;
  const own = p.psqlOwner(`${ctx(a[1], a[2], a[3])}\nSELECT 'A|' || ${counts()} || '|B|' || ${counts(` WHERE organisation_id = '${b[1]}'`)};\nCOMMIT;`).split('\n').pop();
  const expected = p.psql(`SELECT ${counts(` WHERE organisation_id = '${a[1]}'`)}`);
  check(own === `A|${expected}|B|${tables.map(() => '0').join(',')}`, `${label}: in organisation A's context it reads exactly A's rows (${expected}) and none of B's`);
  const mixed = p.psqlOwner(`${ctx(a[1], b[2], a[3])}\nSELECT ${counts()};\nCOMMIT;`).split('\n').pop();
  check(/^0(,0)*$/.test(mixed), `${label}: organisation A with organisation B's workspace reads 0 rows (${mixed})`);
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
      const since = L.nowS() - 1;
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
    const since = L.nowS() - 1;
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
    const since = L.nowS() - 1;
    const d = u2.deploy(900_000);
    evidence('U2-older-deploy.log', d.out);
    check(d.code !== 0, `deploy of NEW on the older history FAILS (exit ${d.code}): compose reports the unhealthy API`);
    await L.waitFor('a second refusal (restart loop)', () => (u2.logs('rab-api').match(/UnsupportedUpgradeStartError/g) || []).length >= 4, 240_000, 5000);
    let al = u2.logs('rab-api');
    evidence('U2-older-api.log', al);
    check(/older than every supported release/.test(al) && migrateResult(al).every((r) => r.exitCode === 65 && r.serve === false), 'refused with UnsupportedUpgradeStartError, every attempt exit 65, serve:false (fail closed under continue)');
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
    void since;
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
      await L.waitFor('the API migrate child to block on the push_delivery index', () => u3.psql(`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE 'CREATE INDEX CONCURRENTLY%push_delivery_claim_idx%'`) === '1', 50_000, 1000);
      check(true, 'the migrate child is inside OutboxClaimIndexes1786721440000, waiting for its second index');
      check(u3.neverStarted('rab-worker'), 'Worker waiting: the new Worker is not started while the API migrates');
      check(u3.psql(`SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('core.email_outbox_claim_idx')`) === 't', 'the first index (email_outbox_claim_idx) is already built: partial DDL of a transaction=false migration');
      const k = L.run('docker', ['kill', '--signal', 'KILL', u3.container('rab-api')]);
      check(k.code === 0, 'SIGKILL of the rab-api container mid-migration');
      await holder.release();
      await L.waitFor('the killed session to end', () => u3.psql(`SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted AND ((classid::bigint << 32) | objid::bigint) = ${L.MIGRATION_LOCK_KEY_SQL}`) === '0' || u3.health('rab-api').startsWith('healthy'), 60_000, 1000);
      const ledger = u3.psql(`SELECT count(*) FROM core.migrations`);
      n(`just after the kill: ledger ${ledger}, api ${u3.health('rab-api')}`);
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
    check(JSON.stringify(res.applied) === JSON.stringify(NEWER), `the two real migrations were applied before the probe failed (${JSON.stringify(res.applied)})`);
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
  }, KEEP ? null : null);

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
    const pg = u6.compose(['up', '-d', '--wait', 'rab-postgres'], { timeout: 300_000 });
    check(pg.code === 0, `rab-postgres up (exit ${pg.code})`);
    u6.psql(`CREATE TABLE public.not_crewflow (id int); INSERT INTO public.not_crewflow VALUES (1);`);
    const d = u6.deploy(900_000);
    evidence('U6-deploy.log', d.out);
    check(d.code !== 0, `deploy of NEW on a foreign database FAILS (exit ${d.code})`);
    const al = u6.logs('rab-api');
    evidence('U6-api.log', al);
    check(/state FOREIGN/.test(al) && /DatabaseStateError/.test(al) && migrateResult(al).every((r) => r.exitCode === 67), 'classified FOREIGN, refused with DatabaseStateError, exit 67');
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
    const pull = u7.compose(['pull', 'rab-api'], { timeout: 600_000 });
    check(pull.code === 0, 'NEW pulled');
    const holder = await u7.holdLock(`SELECT pg_advisory_lock(${L.MIGRATION_LOCK_KEY_SQL})`);
    const child = () => u7.composeAsync(['run', '--rm', '-T', '--no-deps', '--entrypoint', 'node', 'rab-api', 'packages/rab-server/dist/database/typeorm/scripts/migrate/twenty/twenty-migrate.js']);
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
