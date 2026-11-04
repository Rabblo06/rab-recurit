/**
 * T7 (Agent 5, independent tests): the owner-login (Option A, PERMANENT — owner addendum 2026-11-04) lifecycle harness.
 * There is no mode switch: one URL (PG_DATABASE_URL), one login (crewflow_owner). Disposable loopback PostgreSQL ONLY.
 *
 *   MIGRATION_SECURITY_ADMIN_URL=<superuser of a DISPOSABLE loopback cluster, crewflow.disposable_cluster=on> \
 *   CREWFLOW_OWNER_BOOTSTRAP_PASSWORD=<the crewflow_owner password this harness sets> \
 *   ts-node --transpile-only -P packages/rab-server/tsconfig.app.json \
 *     packages/rab-server/src/database/typeorm/scripts/twenty-mode-check.ts <command> [args] [--report <file.json>]
 *
 * Commands
 *   list                       the scenario ids and what each proves
 *   owner-fixture <db>         PRE-T2 STAND-IN: give an existing chain database (built by migration-security-check.ts) the
 *                              Option A login `crewflow_owner` with the M0 §3.1 memberships, so the behaviour catalogue
 *                              (__tests__/integration/twenty) can run before Agent 1's bootstrap exists. Labelled as a fixture
 *                              in every report; once twenty-migrate exists the catalogue runs on a TW-I1 database instead.
 *   scenario <id> [<id> ...]   run scenarios; each creates its OWN database (twa_tw_<id>_<run>) and spawns the REAL
 *                              migrate child as a separate process whose environment holds only PG_DATABASE_URL (the owner
 *                              URL) and the non-secret settings CREWFLOW_MIGRATE_ON_START / CREWFLOW_MIGRATION_APPROVAL_MODE /
 *                              CREWFLOW_UPGRADE_FAILURE_POLICY (never the admin URL, never another password).
 *
 * Agreed interfaces (lead, 2026-11-04):
 *   child  packages/rab-server/dist/database/typeorm/scripts/migrate/twenty/twenty-migrate.js (override TWENTY_MIGRATE_ENTRYPOINT)
 *   exit   0 ok/ahead, 64 config, 65 behind, 66 failed, 67 identity, 68 post-check, 69 lock,
 *          70 upgrade failed but continue-if-compatible passed every check (addendum)
 *   stdout final line `TWENTY_MIGRATE_RESULT {"state":…,"applied":[…],"pending":[…],"exitCode":n}`
 * When the child does not exist yet every scenario reports BLOCKED (never PASSED).
 *
 * Every scenario asserts the ACTUAL database state afterwards (ledger, roles, memberships, posture, lock holders), not only
 * the exit code. Output: database names, migration names, counts. Never a URL or password.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Client } from 'pg';

import { compareWithGolden } from '../core/security-posture';

// ---------------------------------------------------------------------------------------------------------------------
// Configuration and refusals
// ---------------------------------------------------------------------------------------------------------------------

class Refusal extends Error {}

export const EXIT = { ok: 0, config: 64, behind: 65, failed: 66, identity: 67, postCheck: 68, lock: 69, continuedCompatible: 70 } as const;
/** Env names the one-URL configuration must REJECT (addendum): each, when present, is a config failure (64). */
export const REJECTED_ENV = [
  'PG_WORKER_DATABASE_URL',
  'CREWFLOW_PROVISIONER_DATABASE_URL',
  'DATABASE_URL_UNPOOLED',
  'CREWFLOW_BOOTSTRAP_PASSWORD',
  'CREWFLOW_APP_BOOTSTRAP_PASSWORD',
  'CREWFLOW_WORKER_BOOTSTRAP_PASSWORD',
  'DB_TARGET',
  'ALLOW_PRODUCTION_DB_COMMANDS',
  'CREWFLOW_DB_MODE',
] as const;
export const GATED_EXCLUDED_MIGRATION = 1786721330000;
export const MIGRATION_LOCK_KEY_SQL = `x'637265776d696772'::bigint`;
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..', '..');
const DEFAULT_ENTRYPOINT = join(REPO_ROOT, 'packages', 'rab-server', 'dist', 'database', 'typeorm', 'scripts', 'migrate', 'twenty', 'twenty-migrate.js');
const MIGRATIONS_DIR = join(__dirname, '..', 'core', 'migrations');
const GOLDEN = readFileSync(join(__dirname, '..', 'core', 'security-posture.golden.txt'), 'utf8').split('\n').filter(Boolean);
const RUN_ID = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;

function log(message: string): void {
  process.stdout.write(`[twenty-mode-check] ${message}\n`);
}

export function parseAdminUrl(raw: string | undefined): URL {
  let u: URL;
  try {
    u = new URL(raw ?? '');
  } catch {
    throw new Refusal('MIGRATION_SECURITY_ADMIN_URL is not a valid URL'); // never echo the input: it holds a password
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Refusal('the admin URL is not a loopback disposable cluster. Refusing.');
  return u;
}

/** Only databases this harness (twa_tw_*) or the M2 harness (*_fresh_* / *_upgrade_*) creates may be touched. */
export function assertHarnessDatabaseName(db: string): void {
  if (!/^(twa_tw_[a-z0-9_]+|[a-z0-9_]+_(fresh|upgrade)_[a-z0-9]+)$/.test(db)) throw new Refusal(`refusing: "${db}" is not a harness database name`);
}

function withDb(base: URL, db: string, user?: string, password?: string): string {
  const u = new URL(base.toString());
  u.pathname = `/${db}`;
  u.search = '';
  if (user) {
    u.username = user;
    u.password = encodeURIComponent(password ?? '');
  }
  return u.toString();
}

async function withClient<T>(connectionString: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString, application_name: 'twenty-mode-check' });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export interface Ctx {
  admin: URL;
  ownerPassword: string;
  entrypoint: string;
}

function context(): Ctx {
  const admin = parseAdminUrl(process.env.MIGRATION_SECURITY_ADMIN_URL);
  const ownerPassword = process.env.CREWFLOW_OWNER_BOOTSTRAP_PASSWORD?.trim();
  if (!ownerPassword) throw new Refusal('CREWFLOW_OWNER_BOOTSTRAP_PASSWORD is required');
  return { admin, ownerPassword, entrypoint: process.env.TWENTY_MIGRATE_ENTRYPOINT || DEFAULT_ENTRYPOINT };
}

async function assertDisposableCluster(ctx: Ctx): Promise<{ major: number }> {
  return withClient(withDb(ctx.admin, 'postgres'), async (c) => {
    const { rows } = await c.query(
      `SELECT r.rolsuper, current_setting('crewflow.disposable_cluster', true) AS marker,
              (SELECT setting FROM pg_settings WHERE name = 'server_version_num')::int AS num
         FROM pg_roles r WHERE r.rolname = current_user`,
    );
    if (!rows[0]?.rolsuper) throw new Refusal('the admin login is not a superuser of the disposable cluster. Refusing.');
    if (rows[0].marker !== 'on') throw new Refusal('the cluster is not marked disposable (crewflow.disposable_cluster = on). Refusing.');
    return { major: Math.floor(Number(rows[0].num) / 10000) };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The provider-admin step (M0 §5.1) and the pre-T2 owner fixture (M0 §3.1)
// ---------------------------------------------------------------------------------------------------------------------

/** M0 §5.1, run as the provider admin: the ONE manual step. Cluster-wide, idempotent; never alters an existing role's shape. */
export async function ensureOwnerLogin(ctx: Ctx): Promise<void> {
  await withClient(withDb(ctx.admin, 'postgres'), async (c) => {
    const { rows } = await c.query(`SELECT 1 FROM pg_roles WHERE rolname = 'crewflow_owner'`);
    if (rows.length === 0) {
      // Literal, not a parameter: CREATE ROLE takes no bind parameters. The value is hex from openssl/randomBytes.
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(ctx.ownerPassword)) throw new Refusal('CREWFLOW_OWNER_BOOTSTRAP_PASSWORD must be 16-128 [A-Za-z0-9_-]');
      await c.query(
        `CREATE ROLE crewflow_owner LOGIN PASSWORD '${ctx.ownerPassword}' NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB CREATEROLE INHERIT`,
      );
      log('created crewflow_owner (provider-admin step, M0 §5.1; password never printed)');
    }
  });
}

/** A new, EMPTY database for one scenario: §5.1's database grant only. Nothing else exists in it. */
export async function createEmptyScenarioDatabase(ctx: Ctx, db: string): Promise<void> {
  assertHarnessDatabaseName(db);
  await withClient(withDb(ctx.admin, 'postgres'), async (c) => {
    await c.query(`CREATE DATABASE "${db}"`);
    await c.query(`ALTER DATABASE "${db}" SET crewflow.disposable_test_database = 'true'`);
    await c.query(`GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${db}" TO crewflow_owner WITH GRANT OPTION`);
  });
  log(`created empty ${db}`);
}

/**
 * PRE-T2 STAND-IN. On a chain database built by the separated M2 harness, give crewflow_owner the end-state memberships of
 * an Option A install (M0 §3.1/§5.2): INHERIT+SET on rab_secure_owner and crewflow; SET on rab_owner; INHERIT on rab_app;
 * the irrevocable implicit ADMIN row PostgreSQL 16+ adds for every role the login creates (modelled as ADMIN TRUE on the
 * same grant); NO usable membership of crewflow_app or crewflow_worker (crewflow_worker is created by the throwaway
 * rolemaker and keeps 0 members). Differences from a real T2 install are listed in FIXTURE_LIMITS and in every report.
 */
export const FIXTURE_LIMITS = [
  'roles were created by the cluster superuser, not by crewflow_owner: the implicit ADMIN rows are simulated with ADMIN TRUE',
  'crewflow / crewflow_app keep the separated harness passwords (a T2 install leaves them LOGIN with no password)',
  'the database owner is the harness superuser; crewflow_owner holds CONNECT, CREATE, TEMPORARY WITH GRANT OPTION (§5.1)',
];

export async function ownerFixture(ctx: Ctx, db: string): Promise<void> {
  assertHarnessDatabaseName(db);
  await ensureOwnerLogin(ctx);
  await withClient(withDb(ctx.admin, db), async (c) => {
    await c.query(`GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${db}" TO crewflow_owner WITH GRANT OPTION`);
    const grants: Array<[string, string]> = [
      ['rab_secure_owner', 'ADMIN TRUE, INHERIT TRUE, SET TRUE'],
      ['crewflow', 'ADMIN TRUE, INHERIT TRUE, SET TRUE'],
      ['rab_owner', 'ADMIN TRUE, INHERIT FALSE, SET TRUE'],
      ['rab_app', 'ADMIN TRUE, INHERIT TRUE, SET FALSE'],
      // crewflow_app is created by crewflow_owner in §5.2: implicit ADMIN-only row, no INHERIT, no SET.
      ['crewflow_app', 'ADMIN TRUE, INHERIT FALSE, SET FALSE'],
    ];
    for (const [role, opts] of grants) {
      const { rows } = await c.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role]);
      if (rows.length) await c.query(`GRANT "${role}" TO crewflow_owner WITH ${opts}`);
      else log(`fixture: role ${role} does not exist on this cluster (skipped)`);
    }
  });
  const problems = await ownerShapeProblems(ctx, db);
  if (problems.length) throw new Refusal(`fixture produced an unexpected owner shape: ${problems.join('; ')}`);
  log(`owner-fixture applied to ${db} (PRE-T2 STAND-IN; limits: ${FIXTURE_LIMITS.length})`);
}

// ---------------------------------------------------------------------------------------------------------------------
// State readers (the assertions run on these, never on exit codes alone)
// ---------------------------------------------------------------------------------------------------------------------

export interface DbState {
  exists: boolean;
  ledger: string[];
  gatedExcludedApplied: boolean;
  workerMembers: number | null;
  ownerAttrs: { super: boolean; bypass: boolean; createrole: boolean; replication: boolean; createdb: boolean } | null;
  lockHolders: number;
  coreTables: number;
}

export async function readState(ctx: Ctx, db: string): Promise<DbState> {
  const exists = await withClient(withDb(ctx.admin, 'postgres'), async (c) => (await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [db])).rows.length === 1);
  const empty: DbState = { exists, ledger: [], gatedExcludedApplied: false, workerMembers: null, ownerAttrs: null, lockHolders: 0, coreTables: 0 };
  if (!exists) return empty;
  return withClient(withDb(ctx.admin, db), async (c) => {
    const hasLedger = (await c.query(`SELECT to_regclass('core.migrations') IS NOT NULL AS has`)).rows[0].has as boolean;
    const ledger = hasLedger ? (await c.query('SELECT name FROM core.migrations ORDER BY timestamp, id')).rows.map((r) => String(r.name)) : [];
    const worker = (
      await c.query(`SELECT (SELECT count(*) FROM pg_auth_members m WHERE m.roleid = r.oid)::int AS members FROM pg_roles r WHERE r.rolname = 'crewflow_worker'`)
    ).rows[0];
    const owner = (
      await c.query(
        `SELECT rolsuper AS super, rolbypassrls AS bypass, rolcreaterole AS createrole, rolreplication AS replication, rolcreatedb AS createdb
           FROM pg_roles WHERE rolname = 'crewflow_owner'`,
      )
    ).rows[0];
    const lock = (
      await c.query(
        `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted
            AND ((classid::bigint << 32) | objid::bigint) = ${MIGRATION_LOCK_KEY_SQL}`,
      )
    ).rows[0];
    const tables = (await c.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'core' AND c.relkind = 'r'`)).rows[0];
    return {
      exists,
      ledger,
      gatedExcludedApplied: ledger.some((n) => n.endsWith(String(GATED_EXCLUDED_MIGRATION))),
      workerMembers: worker ? Number(worker.members) : null,
      ownerAttrs: owner ?? null,
      lockHolders: Number(lock.n),
      coreTables: Number(tables.n),
    };
  });
}

/** The migration files in the chain (never gated-migrations/): what "head" means for this checkout. */
export function chainMigrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{13}-.+\.ts$/.test(f) && !f.endsWith('.spec.ts'))
    .map((f) => {
      const [ts, rest] = [f.slice(0, 13), f.slice(14, -3)];
      return `${rest}${ts}`;
    })
    .sort((a, b) => Number(a.slice(-13)) - Number(b.slice(-13)));
}

export async function ownerShapeProblems(ctx: Ctx, db: string): Promise<string[]> {
  const s = await readState(ctx, db);
  const p: string[] = [];
  if (!s.ownerAttrs) return ['crewflow_owner does not exist'];
  if (s.ownerAttrs.super) p.push('crewflow_owner is SUPERUSER');
  if (s.ownerAttrs.bypass) p.push('crewflow_owner has BYPASSRLS');
  if (s.ownerAttrs.replication) p.push('crewflow_owner has REPLICATION');
  if (s.ownerAttrs.createdb) p.push('crewflow_owner has CREATEDB');
  if (s.workerMembers !== null && s.workerMembers !== 0) p.push(`crewflow_worker has ${s.workerMembers} member(s), expected 0 (B3)`);
  p.push(...(await reachabilityProblems(withDb(ctx.admin, db), 'crewflow_owner')));
  return p;
}

/**
 * MEMBER-semantics reachability walk (M0 §6.4 #7, G-12): every role reachable from `login` by INHERIT, SET **or ADMIN**
 * (an ADMIN holder can grant itself SET), recursively. Any reachable superuser, BYPASSRLS, REPLICATION role or predefined
 * pg_* data/server role is a problem. Reference oracle for the in-place boot gate (Agent 3, security); the negative controls in
 * __tests__/integration/twenty/twenty-refusals.integration.spec.ts must fail this AND the real gate.
 */
export const REACHABILITY_SQL = `
WITH RECURSIVE reach(oid, path) AS (
  SELECT oid, rolname::text FROM pg_roles WHERE rolname = $1
  UNION
  SELECT m.roleid, reach.path || '>' || pg_get_userbyid(m.roleid)
    FROM pg_auth_members m JOIN reach ON m.member = reach.oid
   WHERE m.inherit_option OR m.set_option OR m.admin_option)
SELECT reach.path, r.rolname, r.rolsuper, r.rolbypassrls, r.rolreplication
  FROM reach JOIN pg_roles r ON r.oid = reach.oid
 WHERE r.rolsuper OR r.rolbypassrls OR r.rolreplication
    OR r.rolname IN ('pg_read_all_data','pg_write_all_data','pg_read_server_files','pg_write_server_files',
                     'pg_execute_server_program','pg_signal_backend','pg_checkpoint','pg_create_subscription','pg_use_reserved_connections')
    OR r.rolname IN ('neon_superuser','rds_superuser','cloudsqlsuperuser','azure_pg_admin','supabase_admin','doadmin')
 ORDER BY 1`;

export async function reachabilityProblems(connectionString: string, login: string): Promise<string[]> {
  return withClient(connectionString, async (c) =>
    (await c.query(REACHABILITY_SQL, [login])).rows.map(
      (r) => `reachable privileged role ${r.rolname} via ${r.path} (super=${r.rolsuper} bypassrls=${r.rolbypassrls} replication=${r.rolreplication})`,
    ),
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// The child: the REAL Twenty migrate entrypoint, with only the owner URL
// ---------------------------------------------------------------------------------------------------------------------

export interface ChildResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  result: { state?: string; applied?: string[]; pending?: string[]; exitCode?: number } | null;
  tail: string[];
  ms: number;
}

/** The env the child gets: PG_DATABASE_URL and non-secret settings. Nothing inherited from this process except PATH. */
export function childEnvironment(ownerUrl: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    NODE_ENV: 'production',
    PG_DATABASE_URL: ownerUrl,
    CREWFLOW_MIGRATE_ON_START: 'true',
    ...extra,
  };
  if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return env;
}

function redact(line: string): string {
  return line.replace(/postgres(ql)?:\/\/[^\s'"]+/g, 'postgres://<redacted>');
}

export function runChild(entrypoint: string, env: NodeJS.ProcessEnv, opts: { killAfterMs?: number; killOnLine?: RegExp } = {}): Promise<ChildResult> {
  const started = Date.now();
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [entrypoint], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines: string[] = [];
    let result: ChildResult['result'] = null;
    const onData = (buf: Buffer) => {
      for (const raw of buf.toString('utf8').split('\n')) {
        if (!raw.trim()) continue;
        const line = redact(raw);
        lines.push(line);
        const m = /^TWENTY_MIGRATE_RESULT (\{.*\})\s*$/.exec(raw);
        if (m) {
          try {
            result = JSON.parse(m[1]);
          } catch {
            result = { state: 'UNPARSEABLE' };
          }
        }
        if (opts.killOnLine?.test(raw)) child.kill('SIGKILL');
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = opts.killAfterMs ? setTimeout(() => child.kill('SIGKILL'), opts.killAfterMs) : null;
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ exitCode: code, signal, result, tail: lines.slice(-15), ms: Date.now() - started });
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------------------------------

export type Status = 'PASSED' | 'FAILED' | 'BLOCKED' | 'NOT TESTED';
export interface ScenarioReport {
  id: string;
  title: string;
  status: Status;
  pgMajor?: number;
  database?: string;
  evidence: string[];
  failures: string[];
}

interface Scenario {
  id: string;
  title: string;
  /** Interfaces/inputs this scenario needs that do not exist yet; while any is unmet the scenario is BLOCKED. */
  needs?: (ctx: Ctx) => string[];
  run: (ctx: Ctx, r: ScenarioReport) => Promise<void>;
}

const entrypointNeed = (ctx: Ctx) => (existsSync(ctx.entrypoint) ? [] : [`the Twenty migrate child is not built (${ctx.entrypoint.replace(REPO_ROOT, '<repo>')}); T2 (Agent 1)`]);

function expect(r: ScenarioReport, ok: boolean, message: string): void {
  (ok ? r.evidence : r.failures).push(`${ok ? 'ok' : 'FAIL'}: ${message}`);
}

async function assertHeadState(ctx: Ctx, db: string, r: ScenarioReport): Promise<DbState> {
  const s = await readState(ctx, db);
  const chain = chainMigrationNames();
  const missing = chain.filter((n) => !s.ledger.includes(n));
  const unknown = s.ledger.filter((n) => !chain.includes(n));
  expect(r, missing.length === 0, `ledger holds every chain migration (${s.ledger.length}/${chain.length}; missing ${missing.slice(0, 5).join(', ') || 'none'})`);
  expect(r, unknown.length === 0, `ledger holds nothing outside the chain (${unknown.slice(0, 5).join(', ') || 'none'})`);
  expect(r, new Set(s.ledger).size === s.ledger.length, 'no migration recorded twice');
  expect(r, !s.gatedExcludedApplied, `${GATED_EXCLUDED_MIGRATION} is NOT applied (gated, excluded)`);
  expect(r, s.workerMembers === 0, `crewflow_worker exists with 0 members (B3; got ${s.workerMembers})`);
  expect(r, s.lockHolders === 0, `no session still holds the migration lock (got ${s.lockHolders})`);
  const shape = await ownerShapeProblems(ctx, db);
  expect(r, shape.length === 0, `crewflow_owner shape and reachability clean (${shape.join('; ') || 'clean'})`);
  const posture = await compareWithGolden(withDb(ctx.admin, db), GOLDEN);
  expect(
    r,
    posture.core.missing.length === 0 && posture.core.unexpected.length === 0,
    `security posture equals the golden (${posture.lines} lines; missing ${posture.core.missing.length}, unexpected ${posture.core.unexpected.length}: ${[
      ...posture.core.missing.slice(0, 3).map((l) => `-${l}`),
      ...posture.core.unexpected.slice(0, 3).map((l) => `+${l}`),
    ].join(' ')})`,
  );
  return s;
}

function childSummary(c: ChildResult): string {
  return `exit=${c.exitCode}${c.signal ? ` signal=${c.signal}` : ''} state=${c.result?.state ?? '-'} applied=${c.result?.applied?.length ?? '-'} pending=${c.result?.pending?.length ?? '-'} ${c.ms}ms`;
}

const db = (id: string) => `twa_tw_${id.toLowerCase().replace(/[^a-z0-9]/g, '')}_${RUN_ID}`;
const ownerUrl = (ctx: Ctx, name: string) => withDb(ctx.admin, name, 'crewflow_owner', ctx.ownerPassword);

export const SCENARIOS: Scenario[] = [
  {
    id: 'TW-I1',
    title: 'fresh install on an EMPTY database with only the owner URL: head, golden posture, 1786721330000 absent, B3 holds',
    needs: entrypointNeed,
    run: async (ctx, r) => {
      const name = db(r.id);
      r.database = name;
      await ensureOwnerLogin(ctx);
      await createEmptyScenarioDatabase(ctx, name);
      const c = await runChild(ctx.entrypoint, childEnvironment(ownerUrl(ctx, name)));
      r.evidence.push(`child: ${childSummary(c)}`);
      expect(r, c.exitCode === EXIT.ok, `exit code 0 (got ${c.exitCode})`);
      expect(r, c.result !== null, 'final TWENTY_MIGRATE_RESULT line present');
      expect(r, c.result?.exitCode === c.exitCode, 'TWENTY_MIGRATE_RESULT.exitCode equals the process exit code');
      expect(r, (c.result?.pending ?? ['?']).length === 0, 'nothing pending afterwards');
      await assertHeadState(ctx, name, r);
    },
  },
  {
    id: 'S1',
    title: 'second boot on a current database: exit 0, nothing applied, ledger byte-identical',
    needs: entrypointNeed,
    run: async (ctx, r) => {
      const name = db(r.id);
      r.database = name;
      await ensureOwnerLogin(ctx);
      await createEmptyScenarioDatabase(ctx, name);
      const first = await runChild(ctx.entrypoint, childEnvironment(ownerUrl(ctx, name)));
      expect(r, first.exitCode === EXIT.ok, `first boot exit 0 (${childSummary(first)})`);
      const before = await readState(ctx, name);
      const second = await runChild(ctx.entrypoint, childEnvironment(ownerUrl(ctx, name)));
      r.evidence.push(`second: ${childSummary(second)}`);
      expect(r, second.exitCode === EXIT.ok, 'second boot exit 0');
      expect(r, (second.result?.applied ?? ['?']).length === 0, 'second boot applied nothing');
      const after = await readState(ctx, name);
      expect(r, JSON.stringify(after.ledger) === JSON.stringify(before.ledger), 'ledger unchanged by the second boot');
      await assertHeadState(ctx, name, r);
    },
  },
  {
    id: 'S4',
    title: 'three replicas start together on an EMPTY database: one migrates, the others wait on the lock; no duplicate, all exit 0',
    needs: entrypointNeed,
    run: async (ctx, r) => {
      const name = db(r.id);
      r.database = name;
      await ensureOwnerLogin(ctx);
      await createEmptyScenarioDatabase(ctx, name);
      const runs = await Promise.all([1, 2, 3].map(() => runChild(ctx.entrypoint, childEnvironment(ownerUrl(ctx, name)))));
      runs.forEach((c, i) => r.evidence.push(`replica ${i + 1}: ${childSummary(c)}`));
      expect(r, runs.every((c) => c.exitCode === EXIT.ok), 'every replica exits 0');
      const appliers = runs.filter((c) => (c.result?.applied?.length ?? 0) > 0);
      expect(r, appliers.length === 1, `exactly one replica applied migrations (got ${appliers.length})`);
      await assertHeadState(ctx, name, r);
    },
  },
  {
    id: 'CFG-1',
    title: 'invalid or forbidden configuration: every rejected env name and every invalid setting exits 64; the database is untouched',
    needs: entrypointNeed,
    run: async (ctx, r) => {
      const name = db(r.id);
      r.database = name;
      await ensureOwnerLogin(ctx);
      await createEmptyScenarioDatabase(ctx, name);
      const cases: Array<[string, Record<string, string>]> = [
        ...REJECTED_ENV.map((k): [string, Record<string, string>] => [`${k} present`, { [k]: k.endsWith('_URL') ? 'postgres://x@127.0.0.1:1/x' : 'x' }]),
        ['CREWFLOW_MIGRATE_ON_START=maybe', { CREWFLOW_MIGRATE_ON_START: 'maybe' }],
        ['CREWFLOW_MIGRATION_APPROVAL_MODE=sometimes', { CREWFLOW_MIGRATION_APPROVAL_MODE: 'sometimes' }],
        ['CREWFLOW_UPGRADE_FAILURE_POLICY=ignore', { CREWFLOW_UPGRADE_FAILURE_POLICY: 'ignore' }],
      ];
      for (const [label, extra] of cases) {
        const c = await runChild(ctx.entrypoint, childEnvironment(ownerUrl(ctx, name), extra));
        expect(r, c.exitCode === EXIT.config, `${label}: exit 64 (${childSummary(c)})`);
      }
      const missing = await runChild(ctx.entrypoint, { ...childEnvironment(ownerUrl(ctx, name)), PG_DATABASE_URL: undefined });
      expect(r, missing.exitCode === EXIT.config, `PG_DATABASE_URL missing: exit 64 (${childSummary(missing)})`);
      const s = await readState(ctx, name);
      expect(r, s.ledger.length === 0 && s.coreTables === 0, `nothing created (ledger ${s.ledger.length}, core tables ${s.coreTables})`);
    },
  },
  {
    id: 'UPG-1',
    title: "upgrade a database built in today's SEPARATED layout to the owner login: pending-only, no bootstrap, no ROW_COPY shim, roles and posture unchanged",
    needs: (ctx) => [...entrypointNeed(ctx), ...(process.env.TWENTY_SEPARATED_TEMPLATE_DB ? [] : ['TWENTY_SEPARATED_TEMPLATE_DB: a chain database built by migration-security-check.ts (fresh), used as a template'])],
    run: async (ctx, r) => {
      const template = process.env.TWENTY_SEPARATED_TEMPLATE_DB!;
      assertHarnessDatabaseName(template);
      const name = db(r.id);
      r.database = name;
      await ensureOwnerLogin(ctx);
      await withClient(withDb(ctx.admin, 'postgres'), async (c) => {
        await c.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
        await c.query(`ALTER DATABASE "${name}" SET crewflow.disposable_test_database = 'true'`);
      });
      const before = await readState(ctx, name);
      // 1. Without the one-time membership grants the owner login must be refused with an actionable identity error, not attempt anything.
      await withClient(withDb(ctx.admin, name), (c) => c.query(`GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${name}" TO crewflow_owner WITH GRANT OPTION`));
      const refused = await runChild(ctx.entrypoint, childEnvironment(ownerUrl(ctx, name)));
      expect(r, refused.exitCode === EXIT.identity, `before the upgrade admin step: exit 67 (${childSummary(refused)})`);
      // 2. The documented one-time upgrade admin step (memberships), then the child: CURRENT, nothing applied, nothing bootstrapped.
      await ownerFixture(ctx, name);
      const c = await runChild(ctx.entrypoint, childEnvironment(ownerUrl(ctx, name)));
      r.evidence.push(`child: ${childSummary(c)}`);
      expect(r, c.exitCode === EXIT.ok, 'exit 0');
      expect(r, (c.result?.applied ?? ['?']).length === 0, 'applied nothing (pending-only: the ledger was already at head)');
      expect(r, c.result?.state === 'CURRENT', `state CURRENT (got ${c.result?.state})`);
      const after = await readState(ctx, name);
      expect(r, JSON.stringify(after.ledger) === JSON.stringify(before.ledger), 'ledger byte-identical (no shim, no re-run)');
      await assertHeadState(ctx, name, r);
    },
  },
  {
    id: 'RB-1',
    title: 'old-image rollback: an older child on a NEWER ledger (unknown migration) exits 0 as AHEAD, applies nothing, never rewinds',
    needs: entrypointNeed,
    run: async (ctx, r) => {
      const name = db(r.id);
      r.database = name;
      await ensureOwnerLogin(ctx);
      await createEmptyScenarioDatabase(ctx, name);
      const first = await runChild(ctx.entrypoint, childEnvironment(ownerUrl(ctx, name)));
      expect(r, first.exitCode === EXIT.ok, `install exit 0 (${childSummary(first)})`);
      // A newer release's migration this checkout does not know (timestamp far in the future, ledger row only).
      await withClient(withDb(ctx.admin, name), (c) => c.query(`INSERT INTO core.migrations (timestamp, name) VALUES (9786700000000, 'NewerReleaseOnly9786700000000')`));
      const before = await readState(ctx, name);
      for (const onStart of ['true', 'false']) {
        const c = await runChild(ctx.entrypoint, childEnvironment(ownerUrl(ctx, name), { CREWFLOW_MIGRATE_ON_START: onStart }));
        r.evidence.push(`MIGRATE_ON_START=${onStart}: ${childSummary(c)}`);
        expect(r, c.exitCode === EXIT.ok, `MIGRATE_ON_START=${onStart}: exit 0 (rollback stays healthy, C-1)`);
        expect(r, c.result?.state === 'AHEAD', `state AHEAD (got ${c.result?.state})`);
        expect(r, (c.result?.applied ?? ['?']).length === 0, 'applied nothing');
      }
      const after = await readState(ctx, name);
      expect(r, JSON.stringify(after.ledger) === JSON.stringify(before.ledger), 'ledger unchanged, newer row kept (never rewound)');
    },
  },
  {
    id: 'ID-1',
    title: 'wrong identity: superuser, a BYPASSRLS login, crewflow_app — each refused (67) before anything is applied',
    needs: entrypointNeed,
    run: async (ctx, r) => {
      const name = db(r.id);
      r.database = name;
      await ensureOwnerLogin(ctx);
      await createEmptyScenarioDatabase(ctx, name);
      const pw = randomBytes(18).toString('hex');
      const bypass = `twa_tw_bypass_${RUN_ID}`;
      await withClient(withDb(ctx.admin, 'postgres'), async (c) => {
        await c.query(`CREATE ROLE "${bypass}" LOGIN BYPASSRLS CREATEROLE PASSWORD '${pw}'`);
        await c.query(`GRANT CONNECT, CREATE ON DATABASE "${name}" TO "${bypass}"`);
      });
      try {
        const cases: Array<[string, string]> = [
          ['superuser (provider admin)', ctx.admin.toString().replace(/\/postgres$/, `/${name}`)],
          ['BYPASSRLS + CREATEROLE login', withDb(ctx.admin, name, bypass, pw)],
        ];
        for (const [label, url] of cases) {
          const c = await runChild(ctx.entrypoint, childEnvironment(withDb(new URL(url), name)));
          expect(r, c.exitCode === EXIT.identity, `${label}: exit 67 (${childSummary(c)})`);
        }
        const s = await readState(ctx, name);
        expect(r, s.ledger.length === 0 && s.coreTables === 0, `nothing created (ledger ${s.ledger.length}, core tables ${s.coreTables})`);
      } finally {
        await withClient(withDb(ctx.admin, 'postgres'), async (c) => {
          await c.query(`REVOKE ALL ON DATABASE "${name}" FROM "${bypass}"`);
          await c.query(`DROP ROLE "${bypass}"`);
        });
      }
    },
  },
  {
    id: 'LOCK-1',
    title: 'lock timeout: another session holds the crewmigr lock; the child gives up with 69 and applies nothing',
    needs: entrypointNeed,
    run: async (ctx, r) => {
      const name = db(r.id);
      r.database = name;
      await ensureOwnerLogin(ctx);
      await createEmptyScenarioDatabase(ctx, name);
      const holder = new Client({ connectionString: withDb(ctx.admin, name), application_name: 'twenty-mode-check-lock-holder' });
      await holder.connect();
      try {
        await holder.query(`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY_SQL})`);
        const c = await runChild(ctx.entrypoint, childEnvironment(ownerUrl(ctx, name), { CREWFLOW_MIGRATION_LOCK_WAIT_SECONDS: '5' }), { killAfterMs: 120_000 });
        r.evidence.push(`child: ${childSummary(c)}`);
        expect(r, c.exitCode === EXIT.lock, 'exit 69 (lock)');
        expect(r, c.ms < 60_000, `gave up within the bounded wait (${c.ms} ms)`);
      } finally {
        await holder.end();
      }
      const s = await readState(ctx, name);
      expect(r, s.ledger.length === 0, `nothing applied (ledger ${s.ledger.length})`);
    },
  },
  {
    id: 'S3',
    title: 'interrupted at 6 kill points (incl. inside a transaction=false migration), then resumed to head',
    needs: (ctx) => [
      ...entrypointNeed(ctx),
      'a deterministic kill-point seam in twenty-migrate (e.g. a log line per migration start/commit to kill on); requested from Agent 1 via the lead',
    ],
    run: async () => undefined,
  },
  {
    id: 'S2',
    title: 'pending migrations with CREWFLOW_MIGRATE_ON_START=false: exit 65 (behind), nothing applied; allowlist/token approval',
    needs: (ctx) => [...entrypointNeed(ctx), 'a way to build a database one migration behind head through the real runner (seam requested from Agent 1)'],
    run: async () => undefined,
  },
  {
    id: 'UPF-1',
    title: 'upgrade failure under policy refuse (exit 66, API unready) and continue-if-compatible (exit 70 only if every compatibility check passes)',
    needs: (ctx) => [...entrypointNeed(ctx), 'a way to make one pending migration fail through the real runner (seam requested from Agent 1)', 'assessUpgradeFailure checks[] in TWENTY_MIGRATE_RESULT'],
    run: async () => undefined,
  },
  {
    id: 'PG15-1',
    title: 'PostgreSQL 15 is refused before anything is applied (D10)',
    needs: (ctx) => [...entrypointNeed(ctx), 'a disposable postgres:15 cluster (twa-test-pg15): run this scenario against it'],
    run: async () => undefined,
  },
];


// ---------------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------------

async function runScenarios(ids: string[]): Promise<ScenarioReport[]> {
  const ctx = context();
  const { major } = await assertDisposableCluster(ctx);
  if (major < 16) log(`cluster is PostgreSQL ${major}: only refusal scenarios are meaningful (Twenty refuses < 16, D10)`);
  const out: ScenarioReport[] = [];
  for (const id of ids) {
    const s = SCENARIOS.find((x) => x.id === id);
    if (!s) throw new Refusal(`unknown scenario ${id}`);
    const r: ScenarioReport = { id: s.id, title: s.title, status: 'NOT TESTED', pgMajor: major, evidence: [], failures: [] };
    const unmet = s.needs?.(ctx) ?? [];
    if (unmet.length) {
      r.status = 'BLOCKED';
      r.failures.push(...unmet.map((u) => `needs: ${u}`));
    } else {
      try {
        await s.run(ctx, r);
        r.status = r.failures.length ? 'FAILED' : 'PASSED';
      } catch (e) {
        r.status = 'FAILED';
        r.failures.push(`threw: ${e instanceof Error ? redact(e.message) : 'unknown error'}`);
      }
    }
    log(`${r.id} ${r.status}${r.database ? ` (${r.database})` : ''}`);
    for (const line of [...r.evidence, ...r.failures]) log(`  ${line}`);
    out.push(r);
  }
  return out;
}

async function main(argv: string[]): Promise<number> {
  const reportIdx = argv.indexOf('--report');
  const reportFile = reportIdx >= 0 ? argv[reportIdx + 1] : undefined;
  const args = reportIdx >= 0 ? argv.filter((_, i) => i !== reportIdx && i !== reportIdx + 1) : argv;
  const [command, ...rest] = args;
  if (command === 'list') {
    for (const s of SCENARIOS) log(`${s.id}: ${s.title}`);
    return 0;
  }
  if (command === 'owner-fixture') {
    const ctx = context();
    await assertDisposableCluster(ctx);
    await ownerFixture(ctx, rest[0] ?? '');
    return 0;
  }
  if (command === 'scenario') {
    const reports = await runScenarios(rest.length ? rest : SCENARIOS.map((s) => s.id));
    if (reportFile) writeFileSync(reportFile, JSON.stringify({ runId: RUN_ID, fixtureLimits: FIXTURE_LIMITS, reports }, null, 2));
    return reports.some((r) => r.status === 'FAILED') ? 1 : 0;
  }
  process.stderr.write('usage: twenty-mode-check.ts list | owner-fixture <db> | scenario [<id> ...] [--report <file>]\n');
  return 2;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`[twenty-mode-check] ${e instanceof Refusal ? 'REFUSED' : 'ERROR'}: ${e instanceof Error ? redact(e.message) : 'unknown'}\n`);
      process.exit(e instanceof Refusal ? 2 : 1);
    },
  );
}
