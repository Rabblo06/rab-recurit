/**
 * B2 tests (OWNER-DB-ULTIMATE.md Part B3; UPGRADE-LEDGER-INTERFACE.md §3): the upgrade logbook driven by B1's REAL start path
 * (the migrate-on-start child twenty-migrate.ts) and the manual `upgrade --force` command, as CHILD PROCESSES on per-case
 * disposable databases of the test cluster, as crewflow_owner. Every case asserts the database afterwards (core.migrations,
 * core.upgrade_migration, the seeded tenant data), never only the exit code.
 *
 *   LU-1   adoption R254: exactly ONE instance is_initial row (`0.4.0_TypeOrmMigrations`, 0.4.0), then the upgrade in the same
 *          start; seeded rows, content, money, foreign keys and tenant ownership identical; a restart adds NO row.
 *   LU-2   adoption R256 -> 0.5.0, the same.
 *   LU-3   an older history (R254 minus its last four) and a holed one -> 65, nothing applied, no logbook row.
 *   LU-4   a failed upgrade COMMAND -> `failed` attempt 1, the next start attempt 2, fixed -> completed 3; never `started`.
 *   LU-5   a crash inside the migrations step (SIGKILL on the ledger migration's start event) -> no row; the next start
 *          re-runs it and records attempt 1.
 *   LU-6   the lock race: two starts at once -> no duplicate (name, attempt); both serve.
 *   LU-7   every upgrade command run twice is idempotent.
 *   LU-8   previous version incomplete (a skipped release) -> 65, nothing applied; `upgrade --force` applies with forced = true.
 *   LU-9   --force is unreachable from the environment.
 *   LU-10  a failed MIGRATION -> 66, refused, retried next start; a failed COMMAND only -> 70, serves (healthz `failed`).
 *   LU-11  rollback (a newer version completed in the ledger) -> serves with a WARNING; a loosened known object -> refused.
 *   LU-12  security refusals stay fatal, also under --force: the superuser login, BYPASSRLS, posture drift.
 *          (PG < 16: the container suite, L10, with a real PostgreSQL 15 image.)
 *
 * Gated on b1() (B1's modules on the branch) and an owner-login disposable cluster (crewflow.disposable_cluster=on).
 */
import { randomBytes } from 'node:crypto';

import { Client } from 'pg';

import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { ADOPTION, b1, EXIT, LEDGER_MIGRATION_NAME, LedgerRow, loginOf, migrationsStep, Query, urls, withDatabase } from './ledger-contract';
import { attemptProblems, Cluster, factDifferences, R254_LAST, R256_LAST } from './ledger-fixtures';

jest.setTimeout(1_800_000);

const env = resolveIntegrationTestDatabase(process.env);
const RUN = b1() !== null && loginOf(env.appUrl) === 'crewflow_owner';
const describeIfB1 = RUN ? describe : describe.skip;

const instanceInitial = (rows: LedgerRow[]) => rows.filter((r) => r.is_initial && r.workspace_id === null);
const ids = (rows: LedgerRow[]) => rows.map((r) => r.id);
const of = (rows: LedgerRow[], name: string) => rows.filter((r) => r.name === name && r.workspace_id === null).map((r) => [r.status, r.attempt]);

describeIfB1("the upgrade logbook on real databases (Part B3, B1's start path and upgrade --force)", () => {
  const B1 = b1()!;
  const cl = new Cluster(env.appUrl, env.adminUrl, randomBytes(4).toString('hex'));
  const TPL254 = cl.dbName('tpl254');
  const TPL256 = cl.dbName('tpl256');
  const V = B1.currentVersion;
  const commands = B1.upgradeCommands();
  /**
   * 0.6.0 ships no real upgrade command (UPGRADE_COMMANDS['0-6'] is empty), so the command cases use B1's test probes
   * (interface §4): two no-op commands appended to the code version; the LAST one is the one made to fail.
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
  });

  afterAll(() => cl.dropAll());

  async function upgradedFrom(template: string, kind: string): Promise<string> {
    const db = cl.dbName(kind);
    await cl.createDatabase(db, template);
    const out = await B1.start(db);
    expect([out.exitCode, out.serve]).toEqual([EXIT.ok, true]);
    return db;
  }

  // ------------------------------------------------------------------------------------------------------- LU-1 / LU-2
  for (const [lu, release, template, version] of [
    [1, 'R254', () => TPL254, ADOPTION.R254],
    [2, 'R256', () => TPL256, ADOPTION.R256],
  ] as const) {
    it(`LU-${lu} adoption ${release}: one instance is_initial row at ${version}, upgraded in the same start, data identical, a restart adds nothing`, async () => {
      const db = cl.dbName(`adopt${release.toLowerCase()}`);
      await cl.createDatabase(db, template());
      const before = await cl.facts(db);
      const first = await B1.start(db);
      expect([first.exitCode, first.serve, first.upgradeStatus]).toEqual([EXIT.ok, true, 'ok']);
      expect(first.upgrade).toMatchObject({ codeVersion: V, adoptedFrom: version, forced: false });
      const rows = await cl.ledger(db);
      const initial = instanceInitial(rows);
      expect(initial).toHaveLength(1);
      expect(initial[0]).toMatchObject({ name: migrationsStep(version), executed_by_version: version, status: 'completed', attempt: 1, forced: false, error_message: null });
      expect(rows.filter((r) => r.status !== 'completed' || r.forced)).toEqual([]);
      expect(attemptProblems(rows)).toEqual([]);
      // "then upgrades in the same start": every step of the current version recorded once, the version complete.
      for (const step of B1.stepsOf(V)) expect([step, of(rows, step)]).toEqual([step, [['completed', 1]]]);
      expect(await complete(db)).toBe(true);
      expect(await complete(db, version)).toBe(true);
      expect(factDifferences(before, await cl.facts(db))).toEqual([]);
      const again = await B1.start(db);
      expect([again.exitCode, again.serve]).toEqual([EXIT.ok, true]);
      expect(ids(await cl.ledger(db))).toEqual(ids(rows));
      expect(factDifferences(before, await cl.facts(db))).toEqual([]);
    });
  }

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
    const db = cl.dbName('migfail');
    await cl.createDatabase(db, TPL256);
    const before = await cl.migrationNames(db);
    const first = await B1.start(db, { env: B1.seams.failMigrationEnv(LEDGER_MIGRATION_NAME) });
    expect([first.exitCode, first.serve]).toEqual([EXIT.migrationFailed, false]);
    expect(await cl.migrationNames(db)).toEqual(before);
    // The ledger migration itself failed (rolled back), so no table and no row: "the failed row only if the table exists".
    expect(await cl.ledgerExists(db)).toBe(false);
    const retry = await B1.start(db);
    expect([retry.exitCode, retry.serve]).toEqual([EXIT.ok, true]);
    expect(of(await cl.ledger(db), migrationsStep(V))).toEqual([['completed', 1]]);
  });

  // ------------------------------------------------------------------------------------------------ LU-4 / LU-10 (70)
  it('LU-4/LU-10 a failing upgrade COMMAND: 70 and serves with status failed; attempt 1, then 2; fixed -> completed 3', async () => {
    const command = lastCommand();
    const db = cl.dbName('cmdfail');
    await cl.createDatabase(db, TPL256);
    const first = await B1.start(db, { env: failEnv });
    expect([first.exitCode, first.serve, first.upgradeStatus]).toEqual([EXIT.commandFailedServing, true, 'failed']);
    expect(of(await cl.ledger(db), command)).toEqual([['failed', 1]]);
    expect((await cl.ledger(db)).find((r) => r.name === command)!.error_message).toBeTruthy();
    expect(await complete(db, V, PROBES)).toBe(false);
    // The first probe (before the failing one) completed once and is not re-run or re-recorded.
    expect(of(await cl.ledger(db), B1.stepsOf(V, PROBES).at(-2)!)).toEqual([['completed', 1]]);
    const second = await B1.start(db, { env: failEnv });
    expect([second.exitCode, second.serve]).toEqual([EXIT.commandFailedServing, true]);
    expect(of(await cl.ledger(db), command)).toEqual([['failed', 1], ['failed', 2]]);
    const fixed = await B1.start(db, { env: probeEnv });
    expect([fixed.exitCode, fixed.serve, fixed.upgradeStatus]).toEqual([EXIT.ok, true, 'ok']);
    const all = await cl.ledger(db);
    expect(of(all, command)).toEqual([['failed', 1], ['failed', 2], ['completed', 3]]);
    expect(of(all, B1.stepsOf(V, PROBES).at(-2)!)).toEqual([['completed', 1]]);
    expect(attemptProblems(all)).toEqual([]);
    expect(await complete(db, V, PROBES)).toBe(true);
  });

  // ------------------------------------------------------------------------------------------------------------ LU-5
  it('LU-5 a crash inside the migrations step leaves no row; the next start re-runs it as attempt 1', async () => {
    const db = cl.dbName('crash');
    await cl.createDatabase(db, TPL256);
    const before = await cl.migrationNames(db);
    const crashed = await B1.start(db, { killOnMigration: LEDGER_MIGRATION_NAME });
    expect(crashed.killed).toBe(true);
    expect(await cl.migrationNames(db)).toEqual(before);
    expect(await cl.ledger(db)).toEqual([]);
    // The session lock went with the process.
    expect(await cl.admin(db, "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND classid = 1668441463 AND objid = 1835624306 AND granted")).toEqual([]);
    const resumed = await B1.start(db);
    expect([resumed.exitCode, resumed.serve]).toEqual([EXIT.ok, true]);
    expect(of(await cl.ledger(db), migrationsStep(V))).toEqual([['completed', 1]]);
    expect(await complete(db)).toBe(true);
  });

  // ------------------------------------------------------------------------------------------------------------ LU-6
  it('LU-6 two starts at once never duplicate an attempt (the count is taken under the migration lock)', async () => {
    const db = cl.dbName('race');
    await cl.createDatabase(db, TPL256);
    const [a, b] = await Promise.all([B1.start(db), B1.start(db)]);
    expect([a.serve, b.serve]).toEqual([true, true]);
    const rows = await cl.ledger(db);
    expect(attemptProblems(rows)).toEqual([]);
    expect(instanceInitial(rows)).toHaveLength(1);
    expect(rows.filter((r) => r.attempt !== 1)).toEqual([]);
  });

  it('LU-6 two FAILING starts at once: attempts 1 and 2, never two attempt-1 rows', async () => {
    const command = lastCommand();
    const db = cl.dbName('racefail');
    await cl.createDatabase(db, TPL256);
    await Promise.all([B1.start(db, { env: failEnv }), B1.start(db, { env: failEnv })]);
    expect(of(await cl.ledger(db), command).map((x) => x[1]).sort()).toEqual([1, 2]);
    expect(attemptProblems(await cl.ledger(db))).toEqual([]);
  });

  // ------------------------------------------------------------------------------------------------------------ LU-7
  it('LU-7 every upgrade command run twice is idempotent; a whole upgrade run twice records nothing new', async () => {
    const db = await upgradedFrom(TPL256, 'idem');
    // The real commands of this release, each run alone twice (none in 0.6.0: UPGRADE_COMMANDS['0-6'] is empty).
    for (const cmd of commands) {
      await B1.runCommand(db, cmd.name);
      const once = await cl.facts(db);
      await B1.runCommand(db, cmd.name);
      expect([cmd.name, factDifferences(once, await cl.facts(db))]).toEqual([cmd.name, []]);
    }
    // The whole start path with the probe commands, twice: the second run re-runs nothing and records nothing.
    const first = await B1.start(db, { env: probeEnv });
    expect([first.exitCode, first.serve]).toEqual([EXIT.ok, true]);
    const once = { ids: ids(await cl.ledger(db)), facts: await cl.facts(db) };
    const second = await B1.start(db, { env: probeEnv });
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
      const db = await upgradedFrom(TPL256, kind);
      await cl.admin(db, 'DELETE FROM core.upgrade_migration WHERE workspace_id IS NULL');
      await cl.admin(db, "INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, is_initial, workspace_id, forced) VALUES ('0.3.0_TypeOrmMigrations', 'completed', 1, '0.3.0', false, NULL, false)");
      return db;
    }

    it('LU-8 previous version incomplete -> 65, nothing applied; then upgrade --force applies with forced = true; then normal starts serve', async () => {
      const db = await skippedRelease('skipped');
      const before = { names: await cl.migrationNames(db), ledger: ids(await cl.ledger(db)) };
      const refused = await B1.start(db);
      expect([refused.exitCode, refused.serve]).toEqual([EXIT.behind, false]);
      expect(await cl.migrationNames(db)).toEqual(before.names);
      expect(ids(await cl.ledger(db))).toEqual(before.ledger);

      const forced = await B1.forceUpgrade(db);
      expect(forced.exitCode).toBe(EXIT.ok);
      const added = (await cl.ledger(db)).filter((r) => !before.ledger.includes(r.id));
      expect(added.length).toBeGreaterThan(0);
      expect(added.filter((r) => !r.forced)).toEqual([]);
      expect(await complete(db)).toBe(true);

      const after = await B1.start(db);
      expect([after.exitCode, after.serve]).toEqual([EXIT.ok, true]);
      expect((await cl.ledger(db)).length).toBe(before.ledger.length + added.length);
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

    it('LU-12 --force never skips a security refusal: posture drift (FORCE RLS removed from a tenant table) still refuses', async () => {
      const db = await skippedRelease('forcesec');
      await cl.admin(db, 'ALTER TABLE core.payroll_record NO FORCE ROW LEVEL SECURITY');
      const before = ids(await cl.ledger(db));
      const out = await B1.forceUpgrade(db);
      expect(out.exitCode).not.toBe(EXIT.ok);
      expect(ids(await cl.ledger(db))).toEqual(before);
    });
  });

  // ----------------------------------------------------------------------------------------------------------- LU-11
  it('LU-11 rollback: a newer version completed in the ledger serves with a WARNING; a loosened known security object blocks', async () => {
    const db = await upgradedFrom(TPL256, 'rollback');
    await cl.admin(db, "INSERT INTO core.migrations (timestamp, name) VALUES (1799999999999, 'FutureRelease1799999999999')");
    await cl.admin(db, "INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, is_initial, workspace_id, forced) VALUES ('9.9.0_TypeOrmMigrations', 'completed', 1, '9.9.0', false, NULL, false)");
    const before = ids(await cl.ledger(db));
    const served = await B1.start(db);
    expect([served.exitCode, served.serve]).toEqual([EXIT.ok, true]);
    expect(served.lines.join('\n')).toMatch(/WARN/i);
    expect(ids(await cl.ledger(db))).toEqual(before);
    await cl.admin(db, 'ALTER TABLE core.payroll_record NO FORCE ROW LEVEL SECURITY');
    const blocked = await B1.start(db);
    expect(blocked.serve).toBe(false);
    expect(blocked.exitCode).not.toBe(EXIT.ok);
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
