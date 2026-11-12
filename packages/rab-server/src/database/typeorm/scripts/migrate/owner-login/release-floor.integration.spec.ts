/**
 * Phase X U-1 (integration): the REAL locked runner and the REAL migrate-on-start decision (outcome, serve, the epoch bump)
 * on disposable databases of the disposable test cluster, as crewflow_owner, with the target guard seamed to PRODUCTION
 * (the floor, like N1 before it, applies to production targets only). Every case asserts the database afterwards (ledger,
 * tenant rows), not only the outcome.
 *
 *   fresh             an EMPTY database                                   ok, the whole chain (floor not consulted)
 *   R254              a v0.4.0 / cd7c7e32 / 4c38aa1a ledger + tenant rows  ok, exactly the 2 newer migrations, rows intact,
 *                                                                          entity-cache epoch bumped once, nothing else in Redis
 *   resume            R254 + 1786721440000 + tenant rows                   ok, exactly 1786721450000
 *   R256 (CURRENT)    the upgraded database again                          ok, nothing applied, no bump
 *   AHEAD             R256 + a newer unknown name                          ok, nothing applied
 *   older             R254 minus its last four ledger rows + tenant rows   65 behind (UnsupportedUpgradeStartError),
 *                                                                          serve=false, ledger and rows unchanged
 *   unknown (hole)    R254 + 1786721450000 recorded, 1786721440000 not     65 behind, nothing applied
 *   wrong database    the guard names another database                     67 identity (MigrationSessionDatabaseError)
 *   legacy login      the cluster superuser on an R254 database            N1 still refuses there (UnapprovedProduction…)
 *
 * GATED: TEST_DATABASE_URL must be crewflow_owner and TEST_DATABASE_URL_UNPOOLED the superuser of a loopback cluster marked
 * crewflow.disposable_cluster=on (ci-server's twenty-mode-check ci-db build). Databases are created per run and dropped.
 */
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import Redis from 'ioredis';
import { Client } from 'pg';

import { GuardedTarget, LockedMigrationOptions, runLockedMigrations } from '../locked-migration-runner';
import { runMigrateOnStart } from './migrate-on-start';
import { RELEASE_MANIFESTS } from './release-floor';

jest.setTimeout(900_000);

const OWNER_URL = process.env.TEST_DATABASE_URL?.trim() ?? '';
const ADMIN_URL = process.env.TEST_DATABASE_URL_UNPOOLED?.trim() ?? '';
const REDIS_URL = (process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? '').trim();
const loginOf = (url: string) => {
  try {
    return decodeURIComponent(new URL(url).username);
  } catch {
    return '';
  }
};
const RUN = OWNER_URL !== '' && ADMIN_URL !== '' && loginOf(OWNER_URL) === 'crewflow_owner';
const describeIfOwnerCluster = RUN ? describe : describe.skip;

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'core', 'migrations');
const R254 = RELEASE_MANIFESTS.find((m) => m.id === 'R254')!.names;
const NEWER = ['OutboxClaimIndexes1786721440000', 'RefreshTokenReplacedByIndex1786721450000'];
const filesThrough = (lastTimestamp: number) =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{13}-[^.]+\.(ts|js)$/.test(f) && Number(f.slice(0, 13)) <= lastTimestamp)
    .map((f) => join(MIGRATIONS_DIR, f));

const RUN_ID = randomBytes(4).toString('hex');
const dbName = (kind: string) => `u1a_floor_${RUN_ID}_${kind}`;
const qi = (name: string) => {
  if (!/^u1a_floor_[0-9a-f]{8}_[a-z0-9]+$/.test(name)) throw new Error('not a database this spec creates');
  return `"${name}"`;
};
const withDb = (base: string, db: string) => {
  const u = new URL(base);
  u.pathname = `/${db}`;
  return u.toString();
};

describeIfOwnerCluster('the upgrade floor on real databases (production target seam, crewflow_owner)', () => {
  const created: string[] = [];
  const admin = (db = 'postgres') => new Client({ connectionString: withDb(ADMIN_URL, db), application_name: 'u1a-floor-spec' });
  const adminQuery = async <T = Record<string, unknown>>(db: string, sql: string, params: unknown[] = []): Promise<T[]> => {
    const c = admin(db);
    await c.connect();
    try {
      return (await c.query(sql, params)).rows as T[];
    } finally {
      await c.end();
    }
  };
  const productionSeam =
    (database: string): LockedMigrationOptions['assertTarget'] =>
    async (): Promise<GuardedTarget> => ({ target: 'production', app: { database, host: '127.0.0.1' } });
  const testSeam =
    (database: string): LockedMigrationOptions['assertTarget'] =>
    async (): Promise<GuardedTarget> => ({ target: 'test', app: { database, host: '127.0.0.1' } });

  async function createDatabase(db: string, template?: string): Promise<void> {
    if (template) await adminQuery('postgres', 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [template]);
    // sql-injection-reviewed: db and template pass qi() (this spec's own name pattern only), nothing else interpolated
    await adminQuery('postgres', `CREATE DATABASE ${qi(db)}${template ? ` TEMPLATE ${qi(template)}` : ''}`);
    created.push(db);
    // sql-injection-reviewed: db passes qi()
    await adminQuery('postgres', `ALTER DATABASE ${qi(db)} SET crewflow.disposable_test_database = 'true'`);
    // sql-injection-reviewed: db passes qi() (the provider grant of 01-crewflow-owner.sql, per database)
    await adminQuery(db, `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${qi(db)} TO crewflow_owner WITH GRANT OPTION`);
  }

  const ledger = async (db: string) =>
    (await adminQuery<{ name: string }>(db, 'SELECT name FROM core.migrations ORDER BY timestamp, id')).map((r) => r.name);
  const tenantRows = async (db: string) =>
    (await adminQuery<{ orgs: number; named: number }>(db, `SELECT count(*)::int AS orgs, count(*) FILTER (WHERE slug = $1)::int AS named FROM core.organisation`, [`u1a-floor-${RUN_ID}`]))[0]!;
  const indexExists = async (db: string, name: string) =>
    (await adminQuery<{ ok: boolean }>(db, `SELECT to_regclass($1) IS NOT NULL AS ok`, [`core.${name}`]))[0]!.ok;

  /** The migrate-on-start decision, in process, with the production seam and the owner login on `db`. */
  async function migrateOnStart(db: string, extraEnv: Record<string, string> = {}, seamDatabase = db) {
    const lines: string[] = [];
    const result = await runMigrateOnStart(
      { migrationApprovalMode: 'none', upgradeFailurePolicy: 'continue' },
      {
        env: { NODE_ENV: 'test', PG_DATABASE_URL: withDb(OWNER_URL, db), ...extraEnv } as NodeJS.ProcessEnv,
        log: (line) => lines.push(line),
        runner: (options) => runLockedMigrations({ ...options, assertTarget: productionSeam(seamDatabase), dotenvValues: {} }),
      },
    );
    return { result, lines };
  }

  const TPL = dbName('tpl');

  beforeAll(async () => {
    const [cluster] = await adminQuery<{ marker: string | null; superuser: boolean }>(
      'postgres',
      `SELECT current_setting('crewflow.disposable_cluster', true) AS marker, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser`,
    );
    if (cluster?.marker !== 'on' || !cluster.superuser) throw new Error('refusing: TEST_DATABASE_URL_UNPOOLED is not the superuser of a disposable cluster');
    // The R254 template: a fresh owner-login install of exactly the v0.4.0 migration set, then one tenant row (so it is an
    // EXISTING database: the fresh-install proof fails from here on, as on a real deployment).
    await createDatabase(TPL);
    const built = await runLockedMigrations({
      label: 'u1a-floor-template',
      env: { NODE_ENV: 'test', PG_DATABASE_URL: withDb(OWNER_URL, TPL) },
      dotenvValues: {},
      mode: 'apply',
      approvalMode: 'none',
      requireOwnerLogin: true,
      assertTarget: testSeam(TPL),
      dataSourceOverrides: { migrations: filesThrough(1786721430000) },
      log: () => undefined,
    });
    expect(built.applied).toHaveLength(254);
    expect(await ledger(TPL)).toEqual([...R254]);
    await adminQuery(TPL, `INSERT INTO core.organisation (name, slug) VALUES ('U-1a floor organisation', $1)`, [`u1a-floor-${RUN_ID}`]);
  });

  afterAll(async () => {
    for (const db of created.reverse()) {
      // sql-injection-reviewed: db passes qi()
      await adminQuery('postgres', `DROP DATABASE IF EXISTS ${qi(db)} WITH (FORCE)`).catch(() => undefined);
    }
  });

  it('fresh: an EMPTY database installs the whole chain (the floor is never consulted on a proven fresh install)', async () => {
    const db = dbName('fresh');
    await createDatabase(db);
    const { result, lines } = await migrateOnStart(db);
    expect(result).toMatchObject({ outcome: 'ok', serve: true, state: 'EMPTY' });
    expect(result.applied.length).toBeGreaterThanOrEqual(256);
    expect(lines.join('\n')).not.toMatch(/upgrade floor:/);
  });

  describe('an existing R254 database (with tenant rows) upgrades, then is CURRENT, then tolerates AHEAD', () => {
    const db = dbName('r254');
    const ns = `u1afloor${RUN_ID}`;
    let redis: Redis | null = null;
    const k = (rest: string) => `crewflow:${ns}:${rest}`;

    beforeAll(async () => {
      await createDatabase(db, TPL);
      if (REDIS_URL) {
        redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
        await redis.connect();
        await redis.set(k('entitycache:user:u1:epoch'), '3');
        await redis.set(k('entitycache:user:u1:v3'), '{"cached":true}', 'EX', 300);
        await redis.set(`bull:${ns}:queue:1`, 'job', 'EX', 300);
        await redis.set(`${ns}-throttler-key`, '7', 'EX', 300);
        await redis.set(`rab:${ns}:heartbeat`, 'alive', 'EX', 300);
      }
    });

    afterAll(async () => {
      if (redis) {
        await redis.del(k('entitycache:user:u1:epoch'), k('entitycache:user:u1:v3'), `bull:${ns}:queue:1`, `${ns}-throttler-key`, `rab:${ns}:heartbeat`);
        redis.disconnect();
      }
    });

    it('R254: applies exactly the two newer migrations, keeps the tenant rows, bumps the entity-cache epoch only', async () => {
      const before = await tenantRows(db);
      expect(before.named).toBe(1);
      const env: Record<string, string> = REDIS_URL ? { REDIS_URL, NODE_ENV: ns } : {};
      const { result, lines } = await migrateOnStart(db, env);
      expect(result).toMatchObject({ outcome: 'ok', serve: true, state: 'CHAIN-PARTIAL' });
      expect(result.applied).toEqual(NEWER);
      expect(lines.join('\n')).toMatch(/upgrade floor: upgrade floor passed: the ledger contains R254; 2 migration\(s\) to apply/);
      expect(lines.join('\n')).toMatch(/fresh install not proven/);
      expect(await ledger(db)).toEqual([...R254, ...NEWER]);
      expect(await tenantRows(db)).toEqual(before);
      if (redis) {
        expect(lines.join('\n')).toMatch(/entity-cache epoch bumped after 2 applied migration/);
        expect(await redis.get(k('entitycache:user:u1:epoch'))).toBe('4');
        expect(await redis.get(k('entitycache:user:u1:v3'))).toBe('{"cached":true}');
        expect(await redis.get(`bull:${ns}:queue:1`)).toBe('job');
        expect(await redis.get(`${ns}-throttler-key`)).toBe('7');
        expect(await redis.get(`rab:${ns}:heartbeat`)).toBe('alive');
      }
    });

    it('R256 (CURRENT): nothing applied, no epoch bump', async () => {
      const env: Record<string, string> = REDIS_URL ? { REDIS_URL, NODE_ENV: ns } : {};
      const { result, lines } = await migrateOnStart(db, env);
      expect(result).toMatchObject({ outcome: 'ok', serve: true, state: 'CURRENT', applied: [] });
      expect(lines.join('\n')).not.toMatch(/entity-cache epoch bumped/);
      if (redis) expect(await redis.get(k('entitycache:user:u1:epoch'))).toBe('4');
    });

    it('AHEAD (an image rollback): allowed, nothing applied', async () => {
      await adminQuery(db, `INSERT INTO core.migrations (timestamp, name) VALUES (1799999999999, 'FutureRelease1799999999999')`);
      const { result } = await migrateOnStart(db);
      expect(result).toMatchObject({ outcome: 'ok', serve: true, state: 'AHEAD', applied: [] });
      expect(await ledger(db)).toEqual([...R254, ...NEWER, 'FutureRelease1799999999999']);
    });

    it('the locked session on another database than the guarded one: identity (67), never a migration failure', async () => {
      const { result } = await migrateOnStart(db, {}, 'some_other_database');
      expect(result).toMatchObject({ outcome: 'identity', serve: false });
      expect(result.reason).toMatch(/MigrationSessionDatabaseError/);
    });
  });

  it('resume: R254 plus 1786721440000 (a partial upgrade) applies exactly the rest', async () => {
    const db = dbName('resume');
    await createDatabase(db, TPL);
    await runLockedMigrations({
      label: 'u1a-floor-partial',
      env: { NODE_ENV: 'test', PG_DATABASE_URL: withDb(OWNER_URL, db) },
      dotenvValues: {},
      mode: 'apply',
      approvalMode: 'none',
      requireOwnerLogin: true,
      assertTarget: testSeam(db),
      dataSourceOverrides: { migrations: filesThrough(1786721440000) },
      log: () => undefined,
    });
    expect(await ledger(db)).toEqual([...R254, NEWER[0]]);
    const { result, lines } = await migrateOnStart(db);
    expect(result).toMatchObject({ outcome: 'ok', serve: true, applied: [NEWER[1]] });
    expect(lines.join('\n')).toMatch(/plus 1 later migration\(s\) \(resuming a partial upgrade\)/);
    expect((await tenantRows(db)).named).toBe(1);
  });

  it('older than the floor: 65 behind (UnsupportedUpgradeStartError), serve=false under continue, ledger and rows unchanged', async () => {
    const db = dbName('older');
    await createDatabase(db, TPL);
    await adminQuery(db, `DELETE FROM core.migrations WHERE name = ANY($1::text[])`, [R254.slice(-4)]);
    const ledgerBefore = await ledger(db);
    const rowsBefore = await tenantRows(db);
    const { result } = await migrateOnStart(db);
    expect(result).toMatchObject({ outcome: 'behind', serve: false, policy: 'continue', applied: [] });
    expect(result.reason).toMatch(/UnsupportedUpgradeStartError: .*older than every supported release.*Nothing was applied/);
    expect(await ledger(db)).toEqual(ledgerBefore);
    expect(await tenantRows(db)).toEqual(rowsBefore);
  });

  it('unknown history (a hole: 1786721450000 recorded, 1786721440000 not): 65 behind, nothing applied', async () => {
    const db = dbName('hole');
    await createDatabase(db, TPL);
    await adminQuery(db, `INSERT INTO core.migrations (timestamp, name) VALUES (1786721450000, $1)`, [NEWER[1]]);
    const { result } = await migrateOnStart(db);
    expect(result).toMatchObject({ outcome: 'behind', serve: false, applied: [] });
    expect(result.reason).toMatch(/not a supported release .*not contiguously/);
    expect(await ledger(db)).toEqual([...R254, NEWER[1]]);
    expect(await indexExists(db, 'email_outbox_claim_idx')).toBe(false);
  });

  it('the legacy (non-owner) login keeps N1: the cluster superuser on an R254 database is refused by the approval list', async () => {
    const db = dbName('legacy');
    await createDatabase(db, TPL);
    await expect(
      runLockedMigrations({
        label: 'u1a-floor-legacy',
        env: { NODE_ENV: 'test', PG_DATABASE_URL: withDb(ADMIN_URL, db) },
        dotenvValues: {},
        mode: 'check',
        assertTarget: productionSeam(db),
        log: () => undefined,
      }),
    ).rejects.toMatchObject({ name: 'UnapprovedProductionMigrationError' });
    expect(await ledger(db)).toEqual([...R254]);
  });
});
