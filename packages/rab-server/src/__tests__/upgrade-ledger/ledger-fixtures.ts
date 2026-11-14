/**
 * B2 tests: disposable per-case databases on the test cluster (the release-floor.integration.spec.ts pattern), R254 / R256
 * migration histories, the synthetic seed and the before/after facts of the deploy-order suite (read-only reuse of
 * packages/rab-docker/deploy-order-tests/seed-organisations.sql and data-facts.sql, owned by agent A2).
 *
 * Every database this module creates matches DB_NAME_RE and is dropped by dropAll(). The admin URL is the disposable
 * cluster's superuser (fixtures only); the owner URL is crewflow_owner (what the start path connects as). No URL is logged.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import { GuardedTarget, LockedMigrationOptions, runLockedMigrations } from '../../database/typeorm/scripts/migrate/locked-migration-runner';
import { LEDGER_SELECT_SQL, LedgerRow, withDatabase } from './ledger-contract';

export const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'database', 'typeorm', 'core', 'migrations');
const DEPLOY_ORDER_TESTS = join(REPO_ROOT, 'packages', 'rab-docker', 'deploy-order-tests');

/** The last migration of each release (release-floor.ts RELEASE_MANIFESTS). */
export const R254_LAST = 1786721430000;
export const R256_LAST = 1786721450000;

const DB_NAME_RE = /^b2_ledger_[0-9a-f]{8}_[a-z0-9]+$/;

export function qi(name: string): string {
  if (!DB_NAME_RE.test(name)) throw new Error('not a database this spec creates');
  return `"${name}"`;
}

export function filesThrough(lastTimestamp: number): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{13}-[^.]+\.(ts|js)$/.test(f) && Number(f.slice(0, 13)) <= lastTimestamp)
    .map((f) => join(MIGRATIONS_DIR, f));
}

/** psql meta-commands (`\set ...`) removed: the files are run over the wire protocol (simple query, several statements). */
function sqlFile(name: string): string {
  return readFileSync(join(DEPLOY_ORDER_TESTS, name), 'utf8')
    .split('\n')
    .filter((l) => !l.startsWith('\\'))
    .join('\n');
}

export class Cluster {
  readonly created: string[] = [];
  constructor(
    readonly ownerUrl: string,
    readonly adminUrl: string,
    readonly runId: string,
  ) {}

  dbName(kind: string): string {
    return `b2_ledger_${this.runId}_${kind}`;
  }

  async admin<T = Record<string, unknown>>(db: string, sql: string, params: unknown[] = []): Promise<T[]> {
    const c = new Client({ connectionString: withDatabase(this.adminUrl, db), application_name: 'b2-ledger-spec' });
    await c.connect();
    try {
      return (await c.query(sql, params)).rows as T[];
    } finally {
      await c.end();
    }
  }

  /** Several statements in one simple-protocol round trip; returns the LAST result's rows. */
  async adminScript(db: string, sql: string): Promise<Record<string, unknown>[]> {
    const c = new Client({ connectionString: withDatabase(this.adminUrl, db), application_name: 'b2-ledger-spec' });
    await c.connect();
    try {
      const r = (await c.query(sql)) as unknown;
      const list = Array.isArray(r) ? r : [r];
      return (list[list.length - 1] as { rows: Record<string, unknown>[] }).rows;
    } finally {
      await c.end();
    }
  }

  async assertDisposable(): Promise<void> {
    const [row] = await this.admin<{ marker: string | null; superuser: boolean }>(
      'postgres',
      "SELECT current_setting('crewflow.disposable_cluster', true) AS marker, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser",
    );
    if (row?.marker !== 'on' || !row.superuser) throw new Error('refusing: TEST_DATABASE_URL_UNPOOLED is not the superuser of a disposable cluster');
  }

  async createDatabase(db: string, template?: string): Promise<void> {
    if (template) await this.admin('postgres', 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [template]);
    // sql-injection-reviewed: db and template pass qi() (this module's own name pattern only)
    await this.admin('postgres', `CREATE DATABASE ${qi(db)}${template ? ` TEMPLATE ${qi(template)}` : ''}`);
    this.created.push(db);
    // sql-injection-reviewed: db passes qi()
    await this.admin('postgres', `ALTER DATABASE ${qi(db)} SET crewflow.disposable_test_database = 'true'`);
    // sql-injection-reviewed: db passes qi() (the provider grant of 01-crewflow-owner.sql, per database)
    await this.admin(db, `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${qi(db)} TO crewflow_owner WITH GRANT OPTION`);
  }

  async dropAll(): Promise<void> {
    for (const db of [...this.created].reverse()) {
      // sql-injection-reviewed: db passes qi()
      await this.admin('postgres', `DROP DATABASE IF EXISTS ${qi(db)} WITH (FORCE)`).catch(() => undefined);
    }
  }

  /** An owner-login install of exactly the migrations up to `last` (R254 or R256), as the release-floor spec builds it. */
  async buildRelease(db: string, last: number): Promise<number> {
    await this.createDatabase(db);
    const seam: LockedMigrationOptions['assertTarget'] = async (): Promise<GuardedTarget> => ({ target: 'test', app: { database: db, host: '127.0.0.1' } });
    const built = await runLockedMigrations({
      label: 'b2-ledger-template',
      env: { NODE_ENV: 'test', PG_DATABASE_URL: withDatabase(this.ownerUrl, db) },
      dotenvValues: {},
      mode: 'apply',
      approvalMode: 'none',
      requireOwnerLogin: true,
      assertTarget: seam,
      dataSourceOverrides: { migrations: filesThrough(last) },
      log: () => undefined,
    });
    return built.applied.length;
  }

  /** The deploy-order seed: two synthetic organisations with staff, shifts, attendance and payroll (superuser). */
  async seed(db: string): Promise<void> {
    await this.adminScript(db, sqlFile('seed-organisations.sql'));
  }

  /** data-facts.sql as `kind|key -> value` (the `ledger|count` fact excluded: an upgrade changes it by design). */
  async facts(db: string): Promise<Map<string, string>> {
    const rows = await this.adminScript(db, sqlFile('data-facts.sql'));
    const map = new Map<string, string>();
    for (const r of rows) {
      const line = String(Object.values(r)[0]);
      const k = line.slice(0, line.lastIndexOf('|'));
      if (k !== 'ledger|count') map.set(k, line.slice(line.lastIndexOf('|') + 1));
    }
    return map;
  }

  async migrationNames(db: string): Promise<string[]> {
    return (await this.admin<{ name: string }>(db, 'SELECT name FROM core.migrations ORDER BY timestamp, id')).map((r) => r.name);
  }

  async ledgerExists(db: string): Promise<boolean> {
    return (await this.admin<{ ok: boolean }>(db, "SELECT to_regclass('core.upgrade_migration') IS NOT NULL AS ok"))[0]!.ok;
  }

  async ledger(db: string): Promise<LedgerRow[]> {
    if (!(await this.ledgerExists(db))) return [];
    return this.admin<LedgerRow>(db, LEDGER_SELECT_SQL);
  }
}

/**
 * The facts that must be identical before and after an upgrade: every seeded row set / content / money fact recorded
 * BEFORE, plus every foreign-key and tenant-ownership fact AFTER must be 0. Returns the differences (empty = identical).
 */
export function factDifferences(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of before) {
    if (k.startsWith('fk|') || k.startsWith('own|')) continue;
    if (after.get(k) !== v) out.push(`${k}: ${v} -> ${after.get(k) ?? '<missing>'}`);
  }
  for (const [k, v] of after) if ((k.startsWith('fk|') || k.startsWith('own|')) && v !== '0') out.push(`${k}=${v}`);
  const seeded = [...before.keys()].filter((k) => k.startsWith('rows|') && !before.get(k)!.startsWith('0:'));
  if (seeded.length < 20) out.push(`the seed is not really there (${seeded.length} non-empty row sets)`);
  return out;
}

/** Rows grouped by (name, workspace): attempts must be 1..n with no gap and no duplicate. */
export function attemptProblems(rows: readonly LedgerRow[]): string[] {
  const groups = new Map<string, number[]>();
  for (const r of rows) {
    if (r.is_initial) continue;
    const k = `${r.name}@${r.workspace_id ?? 'instance'}`;
    groups.set(k, [...(groups.get(k) ?? []), r.attempt]);
  }
  const out: string[] = [];
  for (const [k, list] of groups) {
    const sorted = [...list].sort((a, b) => a - b);
    if (sorted.some((a, i) => a !== i + 1)) out.push(`${k}: attempts ${sorted.join(',')}`);
  }
  return out;
}
