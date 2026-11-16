/**
 * B2 tests (OWNER-DB-ULTIMATE.md Part B3; UPGRADE-LEDGER-INTERFACE.md §3): the upgrade logbook driven by B1's REAL start path
 * (the migrate-on-start child twenty-migrate.ts) and the manual `upgrade --force` command, as CHILD PROCESSES on per-case
 * disposable databases of the test cluster, as crewflow_owner. Every case asserts the database afterwards (core.migrations,
 * core.upgrade_migration, the seeded tenant data), never only the exit code.
 *
 *   Release 0.7.0 (C3 switched on; strict upgrade from 0.6.0): the cases start from a "0.6.0-COMPLETE" template
 *   (Cluster.build060Complete: every 0.6.0 migration, the seed, every workspace provisioned as 0.6.0 does, 0.6.0's logbook)
 *   and every start carries a backup marker the cutover's REAL checks accept (Cluster.backupEnv). No seam skips the cutover.
 *   The 0.6.0 adoption rules themselves are pinned by the pure decision specs (ledger-decision.spec, upgrade-version-check.spec).
 *   LU-1   0.7.0 never adopts: an R254 / R256 history (no logbook) on a production target is refused with 65, nothing applied.
 *   LU-2   from a 0.6.0-complete database: without the backup the cutover step fails (70, serves, nothing copied); with it
 *          one start applies 0.7.0, every step recorded once, seeded core facts identical, a restart adds NO row.
 *   LU-3   an older history (R254 minus its last four) and a holed one -> 65, nothing applied, no logbook row.
 *   LU-4   a failed upgrade COMMAND -> `failed` attempt 1, the next start attempt 2, fixed -> completed 3; never `started`.
 *   LU-5   a crash inside the migrations step (SIGKILL on the ledger migration's start event) -> no row; the next start
 *          re-runs it and records attempt 1.
 *   LU-6   the lock race: two starts at once -> no duplicate (name, attempt); both serve.
 *   LU-7   every upgrade command run twice is idempotent.
 *   LU-8   previous version incomplete (a skipped release) -> 65, nothing applied; `upgrade --force` applies with forced = true.
 *   LU-9   --force is unreachable from the environment.
 *   LU-10  a failed MIGRATION -> 66, refused, retried next start; a failed COMMAND only -> 70, serves (healthz upgradeFailed true).
 *   LU-11  rollback (a newer version completed in the ledger) -> serves with a WARNING (child 0, API boot gates pass); a
 *          loosened known object (NO FORCE) -> refused at the API boot gate (`force-rls`).
 *   LU-12  security refusals stay fatal, also under --force: the superuser login, BYPASSRLS, RLS disabled (post-check 68),
 *          NO FORCE (the API boot gate; the migrate child checks ENABLE only).
 *          (PG < 16: the container suite, L10, with a real PostgreSQL 15 image.)
 *
 * Gated on b1() (B1's modules on the branch) and an owner-login disposable cluster (crewflow.disposable_cluster=on).
 */
import { randomBytes } from 'node:crypto';

import { Client } from 'pg';

import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { codeMigrationNames } from '../../database/typeorm/scripts/migrate/owner-login/migrate-on-start';
import { apiBootGateRefusal, b1, EXIT, LedgerRow, loginOf, migrationsStep, Query, urls, withDatabase } from './ledger-contract';
import { attemptProblems, Cluster, factDifferences, R254_LAST, R256_LAST, V060_LAST } from './ledger-fixtures';

jest.setTimeout(1_800_000);

const env = resolveIntegrationTestDatabase(process.env);
const RUN = b1() !== null && loginOf(env.appUrl) === 'crewflow_owner';
const describeIfB1 = RUN ? describe : describe.skip;

const instanceInitial = (rows: LedgerRow[]) => rows.filter((r) => r.is_initial && r.workspace_id === null);
const ids = (rows: LedgerRow[]) => rows.map((r) => r.id);
/**
 * What a start that stops AT `stopAt` (failed or killed there) leaves in core.migrations: the starting set plus every code
 * migration ordered before `stopAt` (each commits on its own; e.g. XP-09's TokenCleanupRotationOrder1786721460000 sorts
 * just before the logbook migration), and nothing at or after it. Derived from the code, never a literal list.
 */
const appliedBefore = (before: string[], stopAt: string): string[] => {
  const ts = (n: string) => Number(n.slice(-13));
  const names = new Set(before);
  for (const n of codeMigrationNames()) if (ts(n) < ts(stopAt)) names.add(n);
  return [...names].sort((a, b) => ts(a) - ts(b));
};
const of = (rows: LedgerRow[], name: string) => rows.filter((r) => r.name === name && r.workspace_id === null).map((r) => [r.status, r.attempt]);

describeIfB1("the upgrade logbook on real databases (Part B3, B1's start path and upgrade --force)", () => {
  const B1 = b1()!;
  const cl = new Cluster(env.appUrl, env.adminUrl, randomBytes(4).toString('hex'));
  const TPL254 = cl.dbName('tpl254');
  const TPL256 = cl.dbName('tpl256');
  /** 0.6.0-complete (every 0.6.0 migration), and the same one migration short (one pending for the 0.7.0 migrations step). */
  const TPL060 = cl.dbName('tpl060');
  const TPL060P = cl.dbName('tpl060p');
  const V = B1.currentVersion;
  const commands = B1.upgradeCommands();
  /**
   * The command cases use B1's test probes (interface §4): two no-op commands appended to the code version (after 0.7.0's
   * real HwsCutover); the LAST one is the one made to fail.
   */
  const PROBES = ['B2ProbeAlpha', 'B2ProbeOmega'] as const;
  const probeEnv = B1.seams.probeEnv(PROBES);
  const failEnv = { ...probeEnv, ...B1.seams.failCommandEnv(PROBES[1]) };
  const lastCommand = () => {
    const s = B1.stepsOf(V, PROBES);
    return s[s.length - 1]!;
  };

  /** B1's isVersionComplete as crewflow_owner on `db` (one transaction, rolled back). */
  async function complete(db: string, version = V, probes: readonly string[] = []): Promise<boolean> {
    const c = new Client({ connectionString: withDatabase(env.appUrl, db), application_name: 'b2-ledger-upgrade-spec' });
    await c.connect();
    try {
      await c.query('BEGIN');
      const q: Query = async (sql, params) => (await c.query(sql, params as unknown[])).rows;
      return await B1.isVersionComplete(q, version, probes);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  }

  beforeAll(async () => {
    urls.owner = env.appUrl;
    urls.admin = env.adminUrl;
    await cl.assertDisposable();
    expect(await cl.buildRelease(TPL254, R254_LAST)).toBe(254);
    await cl.seed(TPL254);
    expect(await cl.buildRelease(TPL256, R256_LAST)).toBe(256);
    await cl.seed(TPL256);
    // R254 / R256 carry no logbook: adoption reads that as "no record" (Twenty skips the check when nothing is recorded).
    expect([await cl.ledgerExists(TPL254), await cl.ledgerExists(TPL256)]).toEqual([false, false]);
    await cl.build060Complete(TPL060);
    await cl.build060Complete(TPL060P, V060_LAST - 1);
    expect((await cl.migrationNames(TPL060P)).length).toBe((await cl.migrationNames(TPL060)).length - 1);
  });

  afterAll(async () => {
    await cl.dropAll();
    cl.removeBackups();
  });

  /** Per database: the backup marker env (made once, the first time a start needs it). */
  const backups = new Map<string, Record<string, string>>();
  const backupOf = async (db: string) => {
    // Release 0.7.0 runs with HWS on (production compose): explicit, so an in-process run (upgrade --force) in an HWS-off CI job
    // does not defer the cutover.
    if (!backups.has(db)) backups.set(db, { ...(await cl.backupEnv(db)), HWS_RUNTIME_ENABLED: 'true' });
    return backups.get(db)!;
  };
  /** The start path with this database's verified backup marker (the 0.7.0 cutover refuses to copy without one). */
  const start = async (db: string, opts: Parameters<typeof B1.start>[1] = {}) => B1.start(db, { ...opts, env: { ...(await backupOf(db)), ...(opts?.env ?? {}) } });
  /** A per-case copy of a 0.6.0-complete template. */
  async function from060(kind: string, template: string = TPL060): Promise<string> {
    const db = cl.dbName(kind);
    await cl.createDatabase(db, template);
    return db;
  }
  /** A 0.6.0-complete database upgraded to the code version by one start (exit 0). */
  async function upgradedFrom(template: string, kind: string): Promise<string> {
    const db = await from060(kind, template);
    const out = await start(db);
    expect([out.exitCode, out.serve]).toEqual([EXIT.ok, true]);
    return db;
  }

  // ------------------------------------------------------------------------------------------------------- LU-1 / LU-2
  for (const [release, template] of [
    ['R254', () => TPL254],
    ['R256', () => TPL256],
  ] as const) {
    it(`LU-1 0.7.0 never adopts: an ${release} history (no logbook) on a production target is refused with 65, nothing applied`, async () => {
      const db = cl.dbName(`noadopt${release.toLowerCase()}`);
      await cl.createDatabase(db, template());
      const before = { names: await cl.migrationNames(db), facts: await cl.facts(db) };
      const out = await B1.startProduction(db);
      expect([out.exitCode, out.serve]).toEqual([EXIT.behind, false]);
      expect(await cl.migrationNames(db)).toEqual(before.names);
      expect(await cl.ledgerExists(db)).toBe(false);
      expect(factDifferences(before.facts, await cl.facts(db))).toEqual([]);
    });
  }

  it('LU-2 from a 0.6.0-complete database: no backup -> the cutover step fails (70, serves); with it one start applies 0.7.0, every step once, core facts identical, a restart adds nothing', async () => {
    const db = await from060('from060');
    const before = { facts: await cl.facts(db), ids: ids(await cl.ledger(db)) };
    const cutoverStep = B1.stepsOf(V).find((n) => /_HwsCutover_/.test(n))!;
    expect(cutoverStep).toBeTruthy();
    // Without the backup marker: the cutover refuses to copy (owner rule), the step fails, the API serves (70).
    const refused = await B1.start(db);
    expect([refused.exitCode, refused.serve, refused.upgradeStatus]).toEqual([EXIT.commandFailedServing, true, 'failed']);
    expect(of(await cl.ledger(db), cutoverStep)).toEqual([['failed', 1]]);
    expect(factDifferences(before.facts, await cl.facts(db))).toEqual([]);
    // With the verified backup: the release completes in one start.
    const first = await start(db);
    expect([first.exitCode, first.serve, first.upgradeStatus]).toEqual([EXIT.ok, true, 'ok']);
    expect(first.upgrade).toMatchObject({ codeVersion: V, adoptedFrom: null, forced: false });
    const rows = await cl.ledger(db);
    expect(instanceInitial(rows)).toEqual([]);
    expect(of(rows, migrationsStep(V))).toEqual([['completed', 1]]);
    expect(of(rows, cutoverStep)).toEqual([['failed', 1], ['completed', 2]]);
    expect(attemptProblems(rows)).toEqual([]);
    expect(await complete(db)).toBe(true);
    // The core copies are never written by the cutover: every seeded fact is identical, except the ONE insert-only audit
    // record per verified workspace the cutover writes by design (C3: workspace.hws_cutover_verified; one per seeded org).
    const diff = factDifferences(before.facts, await cl.facts(db));
    expect(diff.filter((d) => !d.startsWith('rows|audit_log|'))).toEqual([]);
    expect(diff.filter((d) => d.startsWith('rows|audit_log|')).map((d) => d.replace(/^(rows\|audit_log\|[^:]+): 0:- -> 1:[0-9a-f]{32}$/, '$1 +1'))).toEqual(
      diff.filter((d) => d.startsWith('rows|audit_log|')).map((d) => `${d.split(':')[0]} +1`),
    );
    expect(before.ids.every((id) => ids(rows).includes(id))).toBe(true);
    const again = await start(db);
    expect([again.exitCode, again.serve]).toEqual([EXIT.ok, true]);
    expect(ids(await cl.ledger(db))).toEqual(ids(rows));
  });

  // ------------------------------------------------------------------------------------------------------------ LU-3
  it('LU-3 an older history (R254 minus its last four) is refused with 65 and nothing is applied', async () => {
    const db = cl.dbName('older');
    await cl.createDatabase(db, TPL254);
    const names = await cl.migrationNames(db);
    await cl.admin(db, 'DELETE FROM core.migrations WHERE name = ANY ($1::text[])', [names.slice(-4)]);
    const before = { names: await cl.migrationNames(db), facts: await cl.facts(db) };
    // A production target: a local / test target deliberately leaves an unattributable history unchecked (B1 `unchecked`).
    const out = await B1.startProduction(db);
    expect([out.exitCode, out.serve]).toEqual([EXIT.behind, false]);
    expect(await cl.migrationNames(db)).toEqual(before.names);
    expect(await cl.ledgerExists(db)).toBe(false);
    expect(factDifferences(before.facts, await cl.facts(db))).toEqual([]);
  });

  it('LU-3 an unknown history (a hole: 1786721450000 recorded, 1786721440000 not) is refused with 65, nothing applied', async () => {
    const db = cl.dbName('hole');
    await cl.createDatabase(db, TPL254);
    await cl.admin(db, "INSERT INTO core.migrations (timestamp, name) VALUES (1786721450000, 'RefreshTokenReplacedByIndex1786721450000')");
    const before = await cl.migrationNames(db);
    // A production target: a local / test target deliberately leaves an unattributable history unchecked (B1 `unchecked`).
    const out = await B1.startProduction(db);
    expect([out.exitCode, out.serve]).toEqual([EXIT.behind, false]);
    expect(await cl.migrationNames(db)).toEqual(before);
    expect(await cl.ledgerExists(db)).toBe(false);
  });

  // ------------------------------------------------------------------------------------------------------ LU-10 (66)
  it('LU-10 a failing MIGRATION is refused with 66 (never serves) and retried on the next start', async () => {
    const db = await from060('migfail', TPL060P);
    const before = await cl.migrationNames(db);
    const pending = codeMigrationNames().find((n) => !before.includes(n))!;
    const first = await start(db, { env: B1.seams.failMigrationEnv(pending) });
    expect([first.exitCode, first.serve]).toEqual([EXIT.migrationFailed, false]);
    // Everything before the failing migration applied and stays; the failing one and everything after it did not.
    expect(await cl.migrationNames(db)).toEqual(appliedBefore(before, pending));
    expect(await cl.migrationNames(db)).not.toContain(pending);
    // Never recorded completed while a migration is missing.
    expect(of(await cl.ledger(db), migrationsStep(V)).filter(([status]) => status === 'completed')).toEqual([]);
    const retry = await start(db);
    expect([retry.exitCode, retry.serve]).toEqual([EXIT.ok, true]);
    expect(of(await cl.ledger(db), migrationsStep(V)).slice(-1)[0]?.[0]).toBe('completed');
  });

  // ------------------------------------------------------------------------------------------------ LU-4 / LU-10 (70)
  it('LU-4/LU-10 a failing upgrade COMMAND: 70 and serves with status failed; attempt 1, then 2; fixed -> completed 3', async () => {
    const command = lastCommand();
    const db = await from060('cmdfail');
    const first = await start(db, { env: failEnv });
    expect([first.exitCode, first.serve, first.upgradeStatus]).toEqual([EXIT.commandFailedServing, true, 'failed']);
    expect(of(await cl.ledger(db), command)).toEqual([['failed', 1]]);
    expect((await cl.ledger(db)).find((r) => r.name === command)!.error_message).toBeTruthy();
    expect(await complete(db, V, PROBES)).toBe(false);
    // The first probe (before the failing one) completed once and is not re-run or re-recorded.
    expect(of(await cl.ledger(db), B1.stepsOf(V, PROBES).at(-2)!)).toEqual([['completed', 1]]);
    const second = await start(db, { env: failEnv });
    expect([second.exitCode, second.serve]).toEqual([EXIT.commandFailedServing, true]);
    expect(of(await cl.ledger(db), command)).toEqual([['failed', 1], ['failed', 2]]);
    const fixed = await start(db, { env: probeEnv });
    expect([fixed.exitCode, fixed.serve, fixed.upgradeStatus]).toEqual([EXIT.ok, true, 'ok']);
    const all = await cl.ledger(db);
    expect(of(all, command)).toEqual([['failed', 1], ['failed', 2], ['completed', 3]]);
    expect(of(all, B1.stepsOf(V, PROBES).at(-2)!)).toEqual([['completed', 1]]);
    expect(attemptProblems(all)).toEqual([]);
    expect(await complete(db, V, PROBES)).toBe(true);
  });

  // ----------------------------------------------------------------------------------------------------------- LU-13
  it('LU-13 (CI POST-1) a version an unforced start already moved on to is retried after a post-check failure, never refused 65', async () => {
    const db = await upgradedFrom(TPL060, 'postfail');
    // The logbook a FRESH install of the code version leaves: its own steps only, no previous-version row (superuser
    // fixture: the 0.6.0 instance row removed). Nothing previous is complete, so the gate could only pass on this version.
    await cl.admin(db, `DELETE FROM core.upgrade_migration WHERE workspace_id IS NULL AND executed_by_version = '0.6.0'`);
    expect(of(await cl.ledger(db), migrationsStep(V))).toEqual([['completed', 1]]);
    await cl.admin(db, 'ALTER TABLE core.audit_log DISABLE ROW LEVEL SECURITY');
    let refused: Awaited<ReturnType<typeof B1.start>>;
    try {
      refused = await start(db);
    } finally {
      await cl.admin(db, 'ALTER TABLE core.audit_log ENABLE ROW LEVEL SECURITY');
    }
    expect([refused.exitCode, refused.serve]).toEqual([EXIT.postCheck, false]);
    expect(of(await cl.ledger(db), migrationsStep(V))).toEqual([['completed', 1], ['failed', 2]]);
    // Repaired: the next start retries the version (attempt 3), it is not sent back to the previous-version check.
    const retry = await start(db);
    expect([retry.exitCode, retry.serve]).toEqual([EXIT.ok, true]);
    expect(of(await cl.ledger(db), migrationsStep(V))).toEqual([['completed', 1], ['failed', 2], ['completed', 3]]);
    expect(attemptProblems(await cl.ledger(db))).toEqual([]);
    expect(await complete(db)).toBe(true);
  });

  // ------------------------------------------------------------------------------------------------------------ LU-5
  it('LU-5 a crash inside the migrations step leaves no row; the next start re-runs it as attempt 1', async () => {
    const db = await from060('crash', TPL060P);
    const before = await cl.migrationNames(db);
    const ledgerBefore = ids(await cl.ledger(db));
    const pending = codeMigrationNames().find((n) => !before.includes(n))!;
    const crashed = await start(db, { killOnMigration: pending });
    expect(crashed.killed).toBe(true);
    expect(await cl.migrationNames(db)).toEqual(appliedBefore(before, pending));
    expect(await cl.migrationNames(db)).not.toContain(pending);
    expect(ids(await cl.ledger(db))).toEqual(ledgerBefore);
    // The session lock went with the process.
    expect(await cl.admin(db, "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND classid = 1668441463 AND objid = 1835624306 AND granted")).toEqual([]);
    const resumed = await start(db);
    expect([resumed.exitCode, resumed.serve]).toEqual([EXIT.ok, true]);
    expect(of(await cl.ledger(db), migrationsStep(V))).toEqual([['completed', 1]]);
    expect(await complete(db)).toBe(true);
  });

  // ------------------------------------------------------------------------------------------------------------ LU-6
  it('LU-6 two starts at once never duplicate an attempt (the count is taken under the migration lock)', async () => {
    const db = await from060('race');
    const env = await backupOf(db);
    const [a, b] = await Promise.all([B1.start(db, { env }), B1.start(db, { env })]);
    expect([a.serve, b.serve]).toEqual([true, true]);
    const rows = await cl.ledger(db);
    expect(attemptProblems(rows)).toEqual([]);
    expect(instanceInitial(rows)).toEqual([]);
    expect(rows.filter((r) => r.attempt !== 1)).toEqual([]);
  });

  it('LU-6 two FAILING starts at once: attempts 1 and 2, never two attempt-1 rows', async () => {
    const command = lastCommand();
    const db = await from060('racefail');
    const env = { ...(await backupOf(db)), ...failEnv };
    await Promise.all([B1.start(db, { env }), B1.start(db, { env })]);
    expect(of(await cl.ledger(db), command).map((x) => x[1]).sort()).toEqual([1, 2]);
    expect(attemptProblems(await cl.ledger(db))).toEqual([]);
  });

  // ------------------------------------------------------------------------------------------------------------ LU-7
  it('LU-7 every upgrade command run twice is idempotent; a whole upgrade run twice records nothing new', async () => {
    const db = await upgradedFrom(TPL060, 'idem');
    // The real commands of this release, each run alone twice (0.7.0: HwsCutover, already completed by the start above).
    for (const cmd of commands) {
      await B1.runCommand(db, cmd.name);
      const once = await cl.facts(db);
      await B1.runCommand(db, cmd.name);
      expect([cmd.name, factDifferences(once, await cl.facts(db))]).toEqual([cmd.name, []]);
    }
    // The whole start path with the probe commands, twice: the second run re-runs nothing and records nothing.
    const first = await start(db, { env: probeEnv });
    expect([first.exitCode, first.serve]).toEqual([EXIT.ok, true]);
    const once = { ids: ids(await cl.ledger(db)), facts: await cl.facts(db) };
    const second = await start(db, { env: probeEnv });
    expect([second.exitCode, second.serve]).toEqual([EXIT.ok, true]);
    expect(ids(await cl.ledger(db))).toEqual(once.ids);
    expect(factDifferences(once.facts, await cl.facts(db))).toEqual([]);
    for (const step of B1.stepsOf(V, PROBES).slice(1)) expect([step, of(await cl.ledger(db), step)]).toEqual([step, [['completed', 1]]]);
  });

  // ------------------------------------------------------------------------------------------------- LU-8 / LU-9 / LU-12
  describe('the previous-version check and --force', () => {
    /**
     * A skipped release: a database at the current schema whose logbook says only that 0.3.0 completed (fixture written by
     * the superuser on a disposable database): not an adoption (rows exist), the current version not complete, and no
     * accepted previous version complete.
     */
    async function skippedRelease(kind: string): Promise<string> {
      const db = await upgradedFrom(TPL060, kind);
      await cl.admin(db, 'DELETE FROM core.upgrade_migration WHERE workspace_id IS NULL');
      await cl.admin(db, "INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, is_initial, workspace_id, forced) VALUES ('0.3.0_TypeOrmMigrations', 'completed', 1, '0.3.0', false, NULL, false)");
      return db;
    }

    it('LU-8 previous version incomplete -> 65, nothing applied; then upgrade --force applies with forced = true; then normal starts serve', async () => {
      const db = await skippedRelease('skipped');
      const before = { names: await cl.migrationNames(db), ledger: ids(await cl.ledger(db)) };
      const refused = await start(db);
      expect([refused.exitCode, refused.serve]).toEqual([EXIT.behind, false]);
      expect(await cl.migrationNames(db)).toEqual(before.names);
      expect(ids(await cl.ledger(db))).toEqual(before.ledger);

      const forced = await B1.forceUpgrade(db, { env: await backupOf(db) });
      expect(forced.exitCode).toBe(EXIT.ok);
      const added = (await cl.ledger(db)).filter((r) => !before.ledger.includes(r.id));
      expect(added.length).toBeGreaterThan(0);
      expect(added.filter((r) => !r.forced)).toEqual([]);
      expect(await complete(db)).toBe(true);

      const after = await start(db);
      expect([after.exitCode, after.serve]).toEqual([EXIT.ok, true]);
      expect((await cl.ledger(db)).length).toBe(before.ledger.length + added.length);
    });

    it('LU-14 (review L1) a workspace is_initial row at the code version is not "version started": nothing previous complete -> still 65', async () => {
      const db = await skippedRelease('wsinitial');
      const [{ id: ws }] = await cl.admin<{ id: string }>(db, 'SELECT id::text AS id FROM core.manager_workspace ORDER BY id LIMIT 1');
      // What workspace creation writes at the code version (markNewWorkspaceInitial), superuser fixture.
      await cl.admin(
        db,
        "INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, is_initial, workspace_id, forced) VALUES ($1, 'completed', 1, $2, true, $3::uuid, false)",
        [migrationsStep(V), V, ws],
      );
      const rows = await cl.ledger(db);
      expect(rows.filter((r) => r.executed_by_version === V && r.workspace_id === null)).toEqual([]);
      expect(rows.some((r) => r.executed_by_version === V && r.is_initial && r.workspace_id === ws)).toBe(true);
      const before = { names: await cl.migrationNames(db), ledger: ids(rows) };
      const refused = await B1.start(db);
      expect([refused.exitCode, refused.serve]).toEqual([EXIT.behind, false]);
      expect(await cl.migrationNames(db)).toEqual(before.names);
      expect(ids(await cl.ledger(db))).toEqual(before.ledger);
    });

    it('LU-9 --force is unreachable from the environment: every candidate variable leaves the start path refusing', async () => {
      const db = await skippedRelease('forceenv');
      const before = ids(await cl.ledger(db));
      const candidates = ['CREWFLOW_UPGRADE_FORCE', 'CREWFLOW_FORCE_UPGRADE', 'UPGRADE_FORCE', 'FORCE_UPGRADE', 'CREWFLOW_FORCE', 'FORCE', 'CREWFLOW_UPGRADE_ARGS', 'npm_config_force', 'NODE_OPTIONS'];
      for (const value of ['true', '1', '--force']) {
        const extra = Object.fromEntries(candidates.map((k) => [k, k === 'NODE_OPTIONS' ? '' : value]));
        const out = await B1.start(db, { env: extra });
        // The previous-version refusal (65) or env validation refusing an unknown variable (64): never applied, never served.
        expect([value, [EXIT.behind, EXIT.config].includes(out.exitCode as 64 | 65), out.serve]).toEqual([value, true, false]);
      }
      // The manual command itself takes `--force` / `-f` only: look-alikes are a usage refusal (64), never a forced run.
      for (const args of [['--force=true'], ['--forced'], ['force'], ['--FORCE'], ['--force', 'extra']]) {
        const out = await B1.upgradeCommand(db, args);
        expect([args.join(' '), out.exitCode]).toEqual([args.join(' '), EXIT.config]);
      }
      // And the command WITHOUT --force refuses like the start path.
      expect((await B1.upgradeCommand(db, [])).exitCode).toBe(EXIT.behind);
      expect(ids(await cl.ledger(db))).toEqual(before);
    });

    it('LU-12 --force never skips a security refusal: RLS disabled on a tenant table -> the post-check refuses (68), nothing completed', async () => {
      const db = await skippedRelease('forcesec');
      await cl.admin(db, 'ALTER TABLE core.payroll_record DISABLE ROW LEVEL SECURITY');
      const before = ids(await cl.ledger(db));
      const out = await B1.forceUpgrade(db);
      expect(out.exitCode).toBe(EXIT.postCheck);
      // A refused run may log its own failure (failed, forced), never a completed step.
      const added = (await cl.ledger(db)).filter((r) => !before.includes(r.id));
      expect(added.filter((r) => r.status !== 'failed')).toEqual([]);
      expect(await apiBootGateRefusal(db)).toBe('force-rls');
      // A FORCED run that failed does not open the previous-version check for normal starts (its rows are forced):
      // repaired, a normal start is still refused 65 and needs --force again.
      await cl.admin(db, 'ALTER TABLE core.payroll_record ENABLE ROW LEVEL SECURITY');
      const normal = await B1.start(db);
      expect([normal.exitCode, normal.serve]).toEqual([EXIT.behind, false]);
    });

    it('LU-12 posture drift the migrate child does not check (NO FORCE on a tenant table): --force or not, the API boot gate refuses', async () => {
      // The migrate child's post-checks test ENABLE (deploy-post-checks.ts rls-disabled), the FORCE spot check is the API /
      // Worker boot gate (database-boot-gate-rules.ts assertForceRlsGate, main.js after the child). --force skips neither:
      // the start is refused at the gate whatever the upgrade did.
      const db = await skippedRelease('forcenoforce');
      await cl.admin(db, 'ALTER TABLE core.payroll_record NO FORCE ROW LEVEL SECURITY');
      expect(await apiBootGateRefusal(db)).toBe('force-rls');
      const out = await B1.forceUpgrade(db);
      expect([EXIT.ok, EXIT.postCheck]).toContain(out.exitCode);
      expect(await apiBootGateRefusal(db)).toBe('force-rls');
    });
  });

  // ----------------------------------------------------------------------------------------------------------- LU-11
  it('LU-11 rollback: a newer version completed in the ledger serves with a WARNING; a loosened known security object blocks', async () => {
    const db = await upgradedFrom(TPL060, 'rollback');
    await cl.admin(db, "INSERT INTO core.migrations (timestamp, name) VALUES (1799999999999, 'FutureRelease1799999999999')");
    await cl.admin(db, "INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, is_initial, workspace_id, forced) VALUES ('9.9.0_TypeOrmMigrations', 'completed', 1, '9.9.0', false, NULL, false)");
    const before = ids(await cl.ledger(db));
    const served = await B1.start(db);
    expect([served.exitCode, served.serve]).toEqual([EXIT.ok, true]);
    expect(served.lines.join('\n')).toMatch(/WARN/i);
    expect(ids(await cl.ledger(db))).toEqual(before);
    // The API (main.js boot gates) serves this AHEAD database: the schema gate tolerates a newer ledger (C-1).
    expect(await apiBootGateRefusal(db)).toBeNull();
    // A loosened known security object: the start is refused at the API boot gate (the FORCE spot check), with or without
    // a successful migrate child.
    await cl.admin(db, 'ALTER TABLE core.payroll_record NO FORCE ROW LEVEL SECURITY');
    const child = await B1.start(db);
    expect([EXIT.ok, EXIT.postCheck]).toContain(child.exitCode);
    expect(await apiBootGateRefusal(db)).toBe('force-rls');
    expect(ids(await cl.ledger(db))).toEqual(before);
  });

  // ----------------------------------------------------------------------------------------------------------- LU-12
  it('LU-12 the superuser login is refused (fatal), nothing applied', async () => {
    const db = cl.dbName('superuser');
    await cl.createDatabase(db, TPL256);
    const before = await cl.migrationNames(db);
    const out = await B1.start(db, { asSuperuser: true });
    expect(out.serve).toBe(false);
    expect(out.exitCode).not.toBe(EXIT.ok);
    expect(await cl.migrationNames(db)).toEqual(before);
    expect(await cl.ledgerExists(db)).toBe(false);
  });

  it('LU-12 a BYPASSRLS runtime login is refused (fatal), also under --force; nothing applied', async () => {
    const db = cl.dbName('bypassrls');
    await cl.createDatabase(db, TPL256);
    const before = await cl.migrationNames(db);
    await cl.admin('postgres', 'ALTER ROLE crewflow_owner BYPASSRLS');
    try {
      expect((await B1.start(db)).serve).toBe(false);
      expect((await B1.forceUpgrade(db)).exitCode).not.toBe(EXIT.ok);
    } finally {
      await cl.admin('postgres', 'ALTER ROLE crewflow_owner NOBYPASSRLS');
    }
    expect(await cl.migrationNames(db)).toEqual(before);
    expect(await cl.ledgerExists(db)).toBe(false);
  });
});
