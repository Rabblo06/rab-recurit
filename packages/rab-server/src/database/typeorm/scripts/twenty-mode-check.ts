/**
 * T7 (Agent 5, independent tests): the owner-login lifecycle harness (Option A, PERMANENT — owner addendum 2026-11-04).
 * One URL (PG_DATABASE_URL), one login (crewflow_owner). Disposable loopback PostgreSQL ONLY. Independent of Agent 1's own
 * owner-login-lifecycle-check.ts: this file only spawns the BUILT child as a separate process and reads the database.
 *
 *   MIGRATION_SECURITY_ADMIN_URL=<superuser of a DISPOSABLE loopback cluster, crewflow.disposable_cluster=on> \
 *   CREWFLOW_OWNER_BOOTSTRAP_PASSWORD=<the crewflow_owner password> TWENTY_PG_CONTAINER=<docker container of that cluster> \
 *   ts-node --transpile-only -P packages/rab-server/tsconfig.app.json \
 *     packages/rab-server/src/database/typeorm/scripts/twenty-mode-check.ts <command> [--report <file.json>]
 *
 * Commands
 *   list                         the scenario ids
 *   owner-fixture <db>           PRE-T2 STAND-IN (kept for the catalogue on a separated-built chain; see FIXTURE_LIMITS)
 *   lifecycle                    the owner-login lifecycle suite on an owner-login cluster (cluster A): fresh install through
 *                                the real provider SQL (01-crewflow-owner.sql), second boot, deployment identity, AHEAD,
 *                                post-check failure, lock timeout, identity refusals, configuration and test-seam refusals,
 *                                behind (token mode, deploy-prepare check/apply), the ROW_COPY shim refusing a non-empty
 *                                database, failed upgrade under both policies, failed FIRST install, kills at "start" (incl.
 *                                a transaction=false migration) and at "recorded", 3 replicas; 1786721330000 never loaded.
 *   transition <separated-db>    UPG-1 on a separated-layout chain (cluster B, built by migration-security-check.ts): the real
 *                                transition-from-separated.sql, then the child: pending-only, CURRENT, nothing re-run.
 *
 * Interfaces (Agent 1, twa/db-lifecycle @ b5a03348):
 *   child  packages/rab-server/dist/database/typeorm/scripts/migrate/twenty/twenty-migrate.js
 *   exit   0 ok/ahead, 64 config, 65 behind, 66 failed, 67 identity, 68 post-check, 69 lock, 70 degraded continue
 *   stdout `TWENTY_MIGRATE_RESULT {state, applied, pending, failedMigration, outcome, exitCode, serve, policy, reason, checks[]}`
 *          `MIGRATION_EVENT {"event":"start"|"recorded","name","phase"}`
 *   seams  CREWFLOW_MIGRATION_TEST_STOP_BEFORE / CREWFLOW_MIGRATION_TEST_FAIL_AT (NODE_ENV=test + disposable database only)
 *
 * Every scenario asserts the ACTUAL database state (ledger, roles, B3, reachability, posture, lock holders, marker), never
 * the exit code alone. Output: database names, migration names, counts. Never a URL or password.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Client } from 'pg';

import { compareWithGolden, readSecurityPostureGoldens } from '../core/security-posture';

class Refusal extends Error {}

export const EXIT = { ok: 0, config: 64, behind: 65, failed: 66, identity: 67, postCheck: 68, lock: 69, degraded: 70 } as const;
export const GATED_EXCLUDED_MIGRATION = 1786721330000;
export const MIGRATION_LOCK_KEY_SQL = `x'637265776d696772'::bigint`;
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..', '..');
const DIST = join(REPO_ROOT, 'packages', 'rab-server', 'dist', 'database', 'typeorm', 'scripts');
const DEFAULT_ENTRYPOINT = join(DIST, 'migrate', 'twenty', 'twenty-migrate.js');
/** The same child from source (ts-node), for CI jobs that build the test database before `nx build rab-server`. */
const SOURCE_ENTRYPOINT = join(__dirname, 'migrate', 'twenty', 'twenty-migrate.ts');
const TSCONFIG_APP = join(REPO_ROOT, 'packages', 'rab-server', 'tsconfig.app.json');
const DEPLOY_PREPARE = join(DIST, 'deploy-prepare.js');
const OWNER_SQL = join(REPO_ROOT, 'packages', 'rab-docker', 'postgres-init', 'owner-login', '01-crewflow-owner.sql');
const TRANSITION_SQL = join(REPO_ROOT, 'packages', 'rab-docker', 'postgres-init', 'owner-login', 'transition-from-separated.sql');
const MIGRATIONS_DIR = join(__dirname, '..', 'core', 'migrations');
/** The committed goldens; compareWithGolden picks the one for the server's major (DB-SETUP section 6 follow-up). */
const GOLDEN = readSecurityPostureGoldens();
const RUN_ID = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;

/** Seam targets (reviewed by name in the report). */
const STOP_BEFORE = '1786719520000'; // before the ROW_COPY trio: the CHAIN-PARTIAL template
const FAIL_AT = 'AiSkillSchema1786721000000'; // a transactional migration after the trio
const FRESH_FAIL_AT = 'TenantSessionContext1786665700000'; // phase A, early in a first install
const KILL_START_TXFALSE = 'AttendanceMoneyChecks1786719810000'; // transaction=false
const KILL_INSIDE_TXFALSE = 'ArchiveAndSearchSchema1786719920000'; // transaction=false, killed 400 ms after start
const KILL_RECORDED = 'AiActionProposalActivate1786720960000'; // a shimmed ROW_COPY migration, transactional

function log(message: string): void {
  process.stdout.write(`[twenty-mode-check] ${message}\n`);
}

export function parseAdminUrl(raw: string | undefined): URL {
  let u: URL;
  try {
    u = new URL(raw ?? '');
  } catch {
    throw new Refusal('MIGRATION_SECURITY_ADMIN_URL is not a valid URL');
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Refusal('the admin URL is not a loopback disposable cluster. Refusing.');
  return u;
}

/**
 * The ONE way an identifier reaches SQL text in this file (sql-injection lint, Agent 3): a strict lower-case allow-list,
 * then double quotes. Database names additionally pass assertHarnessDatabaseName; role names are built here from RUN_ID.
 */
export function qi(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Refusal('refusing: not a plain lower-case identifier');
  return `"${name}"`;
}

/**
 * A SCRAM-SHA-256 verifier computed HERE, so no plaintext password is ever part of a statement (a failed statement can be
 * written to the server log with its text). PostgreSQL stores a pre-hashed verifier as-is (CREATE ROLE … PASSWORD '<verifier>').
 */
export function scramVerifier(password: string): string {
  const salt = randomBytes(16);
  const iterations = 4096;
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const hmac = (key: Buffer, text: string) => createHmac('sha256', key).update(text).digest();
  const storedKey = createHash('sha256').update(hmac(salted, 'Client Key')).digest();
  const serverKey = hmac(salted, 'Server Key');
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

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
  container: string | null;
}

function context(): Ctx {
  const admin = parseAdminUrl(process.env.MIGRATION_SECURITY_ADMIN_URL);
  const ownerPassword = process.env.CREWFLOW_OWNER_BOOTSTRAP_PASSWORD?.trim();
  if (!ownerPassword || !/^[A-Za-z0-9_-]{24,128}$/.test(ownerPassword)) throw new Refusal('CREWFLOW_OWNER_BOOTSTRAP_PASSWORD (24-128 [A-Za-z0-9_-]) is required');
  const container = process.env.TWENTY_PG_CONTAINER?.trim() || null;
  // twa-t5-*: Agent 5's local clusters; twenty-pg / disposable-postgres: the CI containers (ci-twenty-tests, disposable-postgres action).
  if (container && !/^twa-t5-pg1[6-9][a-z-]*$|^twenty-pg$|^disposable-postgres$/.test(container)) throw new Refusal('TWENTY_PG_CONTAINER is not a harness container name');
  return { admin, ownerPassword, entrypoint: process.env.TWENTY_MIGRATE_ENTRYPOINT || (existsSync(DEFAULT_ENTRYPOINT) ? DEFAULT_ENTRYPOINT : SOURCE_ENTRYPOINT), container };
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
// Provider steps: the REAL psql scripts, run inside the cluster's container as its superuser
// ---------------------------------------------------------------------------------------------------------------------

/** Runs one of Agent 1's provider SQL files with psql in the container, connected to `db`, the password only in a file. */
function runProviderSql(ctx: Ctx, file: string, db: string): { status: number | null; tail: string } {
  if (!ctx.container) throw new Refusal('TWENTY_PG_CONTAINER is required to run the provider SQL with psql');
  assertHarnessDatabaseName(db);
  const local = join(tmpdir(), `twa-t5-pw-${RUN_ID}`);
  writeFileSync(local, ctx.ownerPassword, { mode: 0o600 });
  try {
    const cp = (src: string, dst: string) => spawnSync('docker', ['cp', src, `${ctx.container}:${dst}`], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    if (cp(local, '/tmp/twa-owner-pw').status !== 0 || cp(file, '/tmp/twa-provider.sql').status !== 0) throw new Refusal('docker cp failed');
    const user = decodeURIComponent(ctx.admin.username);
    const r = spawnSync(
      'docker',
      ['exec', ctx.container, 'sh', '-c', `chmod 600 /tmp/twa-owner-pw && psql -X -q -U "${user}" -d "${db}" -v owner_password_file=/tmp/twa-owner-pw -f /tmp/twa-provider.sql; s=$?; rm -f /tmp/twa-owner-pw /tmp/twa-provider.sql; exit $s`],
      { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
    );
    return { status: r.status, tail: redact(`${r.stdout ?? ''}${r.stderr ?? ''}`).trim().split('\n').slice(-4).join(' | ') };
  } finally {
    unlinkSync(local);
  }
}

async function ownerExists(ctx: Ctx): Promise<boolean> {
  return withClient(withDb(ctx.admin, 'postgres'), async (c) => (await c.query(`SELECT 1 FROM pg_roles WHERE rolname = 'crewflow_owner'`)).rows.length === 1);
}

/** A new, EMPTY database. `disposable` sets the server-side test marker the seams require. */
async function createEmptyDatabase(ctx: Ctx, db: string, disposable = true): Promise<void> {
  assertHarnessDatabaseName(db);
  await withClient(withDb(ctx.admin, 'postgres'), async (c) => {
    // sql-injection-reviewed: db passed assertHarnessDatabaseName above and qi() (allow-listed identifier), nothing else interpolated
    await c.query(`CREATE DATABASE ${qi(db)}`);
    // sql-injection-reviewed: db passed assertHarnessDatabaseName above and qi() (allow-listed identifier), nothing else interpolated
    if (disposable) await c.query(`ALTER DATABASE ${qi(db)} SET crewflow.disposable_test_database = 'true'`);
  });
}

/** §5.1 for this database: the real 01-crewflow-owner.sql the first time on the cluster, then only its database GRANT. */
async function providerStep(ctx: Ctx, db: string, r: ScenarioReport): Promise<void> {
  if (!(await ownerExists(ctx))) {
    const res = runProviderSql(ctx, OWNER_SQL, db);
    expect(r, res.status === 0, `01-crewflow-owner.sql ran as the provider admin (psql exit ${res.status}${res.status ? `: ${res.tail}` : ''})`);
    const attrs = await withClient(withDb(ctx.admin, 'postgres'), async (c) =>
      (await c.query(`SELECT rolcanlogin, rolsuper, rolbypassrls, rolreplication, rolcreatedb, rolcreaterole, rolinherit FROM pg_roles WHERE rolname = 'crewflow_owner'`)).rows[0],
    );
    expect(
      r,
      Boolean(attrs && attrs.rolcanlogin && !attrs.rolsuper && !attrs.rolbypassrls && !attrs.rolreplication && !attrs.rolcreatedb && attrs.rolcreaterole && attrs.rolinherit),
      `crewflow_owner has the M0 §5.1 shape (${JSON.stringify(attrs)})`,
    );
  } else {
    assertHarnessDatabaseName(db);
    // sql-injection-reviewed: db passed assertHarnessDatabaseName and qi() (allow-listed identifier), nothing else interpolated
    await withClient(withDb(ctx.admin, db), (c) => c.query(`GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${qi(db)} TO crewflow_owner WITH GRANT OPTION`));
  }
}

async function cloneDatabase(ctx: Ctx, template: string, db: string): Promise<void> {
  assertHarnessDatabaseName(db);
  assertHarnessDatabaseName(template);
  await withClient(withDb(ctx.admin, 'postgres'), async (c) => {
    await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [template]);
    // sql-injection-reviewed: db and template passed assertHarnessDatabaseName and qi() (allow-listed identifiers)
    await c.query(`CREATE DATABASE ${qi(db)} TEMPLATE ${qi(template)}`);
    // sql-injection-reviewed: db passed assertHarnessDatabaseName and qi() (allow-listed identifier), nothing else interpolated
    await c.query(`ALTER DATABASE ${qi(db)} SET crewflow.disposable_test_database = 'true'`);
    // sql-injection-reviewed: db passed assertHarnessDatabaseName and qi() (allow-listed identifier), nothing else interpolated
    await c.query(`GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${qi(db)} TO crewflow_owner WITH GRANT OPTION`);
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The pre-T2 owner fixture (kept for the catalogue on a separated-built chain)
// ---------------------------------------------------------------------------------------------------------------------

export const FIXTURE_LIMITS = [
  'roles were created by the cluster superuser, not by crewflow_owner: the implicit ADMIN rows are simulated with ADMIN TRUE',
  'crewflow / crewflow_app keep the separated harness passwords (a T2 install leaves them NOLOGIN with no password: BC-17, owner decision 2026-11-05)',
  'the database owner is the harness superuser; crewflow_owner holds CONNECT, CREATE, TEMPORARY WITH GRANT OPTION (§5.1)',
];

export async function ownerFixture(ctx: Ctx, db: string): Promise<void> {
  assertHarnessDatabaseName(db);
  await withClient(withDb(ctx.admin, 'postgres'), async (c) => {
    if ((await c.query(`SELECT 1 FROM pg_roles WHERE rolname = 'crewflow_owner'`)).rows.length === 0) {
      // sql-injection-reviewed: the only interpolation is a SCRAM verifier computed here (base64 + '$:' only), never the plaintext password
      await c.query(`CREATE ROLE crewflow_owner LOGIN PASSWORD '${scramVerifier(ctx.ownerPassword)}' NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB CREATEROLE INHERIT`);
    }
  });
  await withClient(withDb(ctx.admin, db), async (c) => {
    // sql-injection-reviewed: db passed assertHarnessDatabaseName and qi() (allow-listed identifier), nothing else interpolated
    await c.query(`GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${qi(db)} TO crewflow_owner WITH GRANT OPTION`);
    for (const [role, opts] of [
      ['rab_secure_owner', 'ADMIN TRUE, INHERIT TRUE, SET TRUE'],
      ['crewflow', 'ADMIN TRUE, INHERIT TRUE, SET TRUE'],
      ['rab_owner', 'ADMIN TRUE, INHERIT FALSE, SET TRUE'],
      ['rab_app', 'ADMIN TRUE, INHERIT TRUE, SET FALSE'],
      ['crewflow_app', 'ADMIN TRUE, INHERIT FALSE, SET FALSE'],
    ] as const) {
      // sql-injection-reviewed: role and opts come from the constant table above; role also passes qi()
      if ((await c.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role])).rows.length) await c.query(`GRANT ${qi(role)} TO crewflow_owner WITH ${opts}`);
    }
  });
  log(`owner-fixture applied to ${db} (PRE-T2 STAND-IN; limits: ${FIXTURE_LIMITS.length})`);
}

// ---------------------------------------------------------------------------------------------------------------------
// State readers
// ---------------------------------------------------------------------------------------------------------------------

export interface DbState {
  exists: boolean;
  ledger: string[];
  gatedExcludedApplied: boolean;
  workerMembers: number | null;
  lockHolders: number;
  coreTables: number;
  marker: { bound: boolean; deploymentId: string | null } | null;
}

export async function readState(ctx: Ctx, db: string): Promise<DbState> {
  const exists = await withClient(withDb(ctx.admin, 'postgres'), async (c) => (await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [db])).rows.length === 1);
  if (!exists) return { exists, ledger: [], gatedExcludedApplied: false, workerMembers: null, lockHolders: 0, coreTables: 0, marker: null };
  return withClient(withDb(ctx.admin, db), async (c) => {
    const hasLedger = (await c.query(`SELECT to_regclass('core.migrations') IS NOT NULL AS has`)).rows[0].has as boolean;
    const ledger = hasLedger ? (await c.query('SELECT name FROM core.migrations ORDER BY timestamp, id')).rows.map((r) => String(r.name)) : [];
    const worker = (await c.query(`SELECT (SELECT count(*) FROM pg_auth_members m WHERE m.roleid = r.oid)::int AS n FROM pg_roles r WHERE r.rolname = 'crewflow_worker'`)).rows[0];
    const lock = (
      // sql-injection-reviewed: MIGRATION_LOCK_KEY_SQL is a code constant (the crewmigr bigint literal), no input
      await c.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted AND ((classid::bigint << 32) | objid::bigint) = ${MIGRATION_LOCK_KEY_SQL}`)
    ).rows[0];
    const tables = (await c.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'core' AND c.relkind = 'r'`)).rows[0];
    const hasMarker = (await c.query(`SELECT to_regclass('core.deployment_identity') IS NOT NULL AS has`)).rows[0].has as boolean;
    const markerRow = hasMarker ? (await c.query(`SELECT deployment_id::text AS id FROM core.deployment_identity LIMIT 1`)).rows[0] : undefined;
    return {
      exists,
      ledger,
      gatedExcludedApplied: ledger.some((n) => n.endsWith(String(GATED_EXCLUDED_MIGRATION))),
      workerMembers: worker ? Number(worker.n) : null,
      lockHolders: Number(lock.n),
      coreTables: Number(tables.n),
      marker: hasMarker ? { bound: Boolean(markerRow?.id), deploymentId: markerRow?.id ?? null } : null,
    };
  });
}

export function chainMigrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{13}-.+\.ts$/.test(f) && !f.endsWith('.spec.ts'))
    .map((f) => `${f.slice(14, -3)}${f.slice(0, 13)}`)
    .sort((a, b) => Number(a.slice(-13)) - Number(b.slice(-13)));
}

/**
 * MEMBER-semantics reachability walk (M0 §6.4 #7, G-12): every role reachable by INHERIT, SET **or ADMIN**, recursively.
 * Reference oracle for the in-place boot gate (Agent 3, security).
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
  return withClient(connectionString, async (c) => (await c.query(REACHABILITY_SQL, [login])).rows.map((r) => `reachable privileged role ${r.rolname} via ${r.path}`));
}

// ---------------------------------------------------------------------------------------------------------------------
// The child
// ---------------------------------------------------------------------------------------------------------------------

export interface ChildResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
  result: {
    state?: string; applied?: string[]; pending?: string[]; failedMigration?: string | null; outcome?: string; exitCode?: number;
    serve?: boolean; policy?: string; reason?: string; checks?: Array<{ name: string; ok: boolean; detail: string }>;
  } | null;
  events: Array<{ event: string; name: string; phase: string }>;
  lines: string[];
  ms: number;
}

/** PG_DATABASE_URL + non-secret settings; nothing inherited except PATH (and SystemRoot on Windows). */
export function childEnvironment(url: string, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: 'test', PG_DATABASE_URL: url, CREWFLOW_MIGRATE_ON_START: 'true', ...extra };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return env;
}

function redact(line: string): string {
  return line.replace(/postgres(ql)?:\/\/[^\s'"]+/g, 'postgres://<redacted>');
}

export function runChild(
  script: string,
  env: NodeJS.ProcessEnv,
  opts: { killOn?: { event: 'start' | 'recorded'; name: string; delayMs?: number }; timeoutMs?: number } = {},
): Promise<ChildResult> {
  const started = Date.now();
  return new Promise((resolvePromise) => {
    // A .ts entrypoint (the source child, before the dist build) runs through ts-node --transpile-only, as the repo's
    // migration entrypoints do (never tsx: decorator metadata, CLAUDE.md "Resolved gotchas").
    const argv = script.endsWith('.ts') ? [require.resolve('ts-node/dist/bin.js'), '--transpile-only', '-P', TSCONFIG_APP, script] : [script];
    const child = spawn(process.execPath, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines: string[] = [];
    const events: ChildResult['events'] = [];
    let result: ChildResult['result'] = null;
    let killed = false;
    let pending = '';
    const onLine = (raw: string) => {
      if (!raw.trim()) return;
      lines.push(redact(raw));
      const res = /TWENTY_MIGRATE_RESULT (\{.*\})\s*$/.exec(raw);
      if (res) {
        try {
          result = JSON.parse(res[1]);
        } catch {
          result = { state: 'UNPARSEABLE' };
        }
      }
      const ev = /MIGRATION_EVENT (\{.*\})\s*$/.exec(raw);
      if (ev) {
        try {
          const e = JSON.parse(ev[1]);
          events.push(e);
          if (opts.killOn && !killed && e.event === opts.killOn.event && e.name === opts.killOn.name) {
            killed = true;
            setTimeout(() => child.kill('SIGKILL'), opts.killOn.delayMs ?? 0);
          }
        } catch {
          /* a malformed event line: the assertions catch a missing event */
        }
      }
    };
    const onData = (buf: Buffer) => {
      pending += buf.toString('utf8');
      const parts = pending.split('\n');
      pending = parts.pop() ?? '';
      for (const p of parts) onLine(p);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs ?? 600_000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (pending) onLine(pending);
      resolvePromise({ exitCode: code, signal, killed, result, events, lines, ms: Date.now() - started });
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------------------------------------------------

export type Status = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT TESTED';
export interface ScenarioReport {
  id: string;
  title: string;
  status: Status;
  pgMajor?: number;
  database?: string;
  evidence: string[];
  failures: string[];
}

function expect(r: ScenarioReport, ok: boolean, message: string): void {
  (ok ? r.evidence : r.failures).push(`${ok ? 'ok' : 'FAIL'}: ${message}`);
}

function summary(c: ChildResult): string {
  const res = c.result;
  return (
    `exit=${c.exitCode}${c.killed ? ' (killed)' : ''} outcome=${res?.outcome ?? '-'} state=${res?.state ?? '-'} applied=${res?.applied?.length ?? '-'} ` +
    `pending=${res?.pending?.length ?? '-'} serve=${res?.serve ?? '-'} failed=${res?.failedMigration ?? '-'} events=${c.events.length} ${c.ms}ms` +
    (c.exitCode !== 0 && res?.reason ? ` reason=${redact(String(res.reason)).slice(0, 220)}` : '')
  );
}

function checksSummary(c: ChildResult): string {
  return (c.result?.checks ?? []).map((k) => `${k.name}=${k.ok ? 'ok' : 'FAIL'}`).join(',') || 'none';
}

const dbName = (id: string) => `twa_tw_${id.toLowerCase().replace(/[^a-z0-9]/g, '')}_${RUN_ID}`;
const ownerUrl = (ctx: Ctx, db: string) => withDb(ctx.admin, db, 'crewflow_owner', ctx.ownerPassword);

/**
 * BC-17 (owner decision 2026-11-05, MITIGATE; Agent 1 80686512 / f91f1038): after a fresh install or the transition,
 * crewflow and crewflow_app are NOLOGIN with no password, crewflow_migrator (where it exists) likewise, and crewflow_worker
 * keeps LOGIN but has no password. Cluster-wide facts, read from pg_authid by the fixture superuser; no password is printed.
 */
async function legacyLoginProblems(ctx: Ctx): Promise<string[]> {
  return withClient(withDb(ctx.admin, 'postgres'), async (c) => {
    const rows: Array<{ name: string; login: boolean; has_password: boolean }> = (
      await c.query(
        `SELECT rolname::text AS name, rolcanlogin AS login, rolpassword IS NOT NULL AS has_password FROM pg_catalog.pg_authid
          WHERE rolname IN ('crewflow', 'crewflow_app', 'crewflow_worker', 'crewflow_migrator') ORDER BY 1`,
      )
    ).rows;
    const out: string[] = [];
    for (const r of rows) {
      // Booleans only (the CI log masker hid part of the earlier wording): {login, pw} where pw = a stored verifier exists.
      if (r.name === 'crewflow_worker') {
        if (r.has_password) out.push(`crewflow_worker{login:${r.login},pw:true}`);
      } else if (r.login || r.has_password) {
        out.push(`${r.name}{login:${r.login},pw:${r.has_password}}`);
      }
    }
    if (!rows.some((r) => r.name === 'crewflow_app') || !rows.some((r) => r.name === 'crewflow')) out.push('crewflow / crewflow_app missing');
    return out;
  });
}

/** The head-state assertions every successful install must satisfy. */
async function assertHeadState(ctx: Ctx, db: string, r: ScenarioReport, opts: { golden?: boolean } = {}): Promise<DbState> {
  const s = await readState(ctx, db);
  const chain = chainMigrationNames();
  const missing = chain.filter((n) => !s.ledger.includes(n));
  const unknown = s.ledger.filter((n) => !chain.includes(n));
  expect(r, missing.length === 0, `ledger holds every chain migration (${s.ledger.length}/${chain.length}; missing ${missing.slice(0, 4).join(', ') || 'none'})`);
  expect(r, unknown.length === 0, `ledger holds nothing outside the chain (${unknown.slice(0, 4).join(', ') || 'none'})`);
  expect(r, new Set(s.ledger).size === s.ledger.length, 'no migration recorded twice');
  expect(r, !s.gatedExcludedApplied, `${GATED_EXCLUDED_MIGRATION} is NOT applied`);
  expect(r, s.workerMembers === 0, `crewflow_worker has 0 members (B3; got ${s.workerMembers})`);
  expect(r, s.lockHolders === 0, `no session holds the migration lock (got ${s.lockHolders})`);
  const reach = await reachabilityProblems(withDb(ctx.admin, db), 'crewflow_owner');
  expect(r, reach.length === 0, `crewflow_owner reaches no privileged role (${reach.join('; ') || 'clean'})`);
  const legacy = await legacyLoginProblems(ctx);
  expect(r, legacy.length === 0, `BC-17: legacy logins disabled (crewflow / crewflow_app / crewflow_migrator NOLOGIN, no password; crewflow_worker no password) (${legacy.join('; ') || 'clean'})`);
  if (opts.golden !== false) {
    const posture = await compareWithGolden(withDb(ctx.admin, db), GOLDEN);
    expect(
      r,
      posture.core.missing.length === 0 && posture.core.unexpected.length === 0,
      `security posture equals the golden (missing ${posture.core.missing.length}, unexpected ${posture.core.unexpected.length}${[
        ...posture.core.missing.slice(0, 3).map((l) => ` -${l}`),
        ...posture.core.unexpected.slice(0, 3).map((l) => ` +${l}`),
      ].join('')})`,
    );
  }
  return s;
}

function neverLoadedGated(r: ScenarioReport, ...children: ChildResult[]): void {
  const seen = children.flatMap((c) => c.events.map((e) => e.name)).filter((n) => n.endsWith(String(GATED_EXCLUDED_MIGRATION)));
  expect(r, seen.length === 0, `${GATED_EXCLUDED_MIGRATION} never appears in a MIGRATION_EVENT (${seen.length})`);
}

async function waitLockFree(ctx: Ctx, db: string, ms: number): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if ((await readState(ctx, db)).lockHolders === 0) return Date.now() - start;
    await new Promise((res) => setTimeout(res, 250));
  }
  return -1;
}

// ---------------------------------------------------------------------------------------------------------------------
// The lifecycle suite (cluster A)
// ---------------------------------------------------------------------------------------------------------------------

async function lifecycle(ctx: Ctx, major: number): Promise<ScenarioReport[]> {
  const out: ScenarioReport[] = [];
  const step = async (id: string, title: string, fn: (r: ScenarioReport) => Promise<void>) => {
    const r: ScenarioReport = { id, title, status: 'NOT TESTED', pgMajor: major, evidence: [], failures: [] };
    try {
      await fn(r);
      r.status = r.failures.length ? 'FAIL' : 'PASS';
    } catch (e) {
      r.status = 'FAIL';
      r.failures.push(`threw: ${e instanceof Error ? redact(e.message) : 'unknown error'}`);
    }
    log(`${r.id} ${r.status}${r.database ? ` (${r.database})` : ''}`);
    for (const line of [...r.evidence, ...r.failures]) log(`  ${line}`);
    out.push(r);
  };
  if (!existsSync(ctx.entrypoint)) {
    out.push({ id: 'ALL', title: 'lifecycle', status: 'BLOCKED', pgMajor: major, evidence: [], failures: [`child not built: ${ctx.entrypoint.replace(REPO_ROOT, '<repo>')}`] });
    return out;
  }
  const child = (db: string, extra: Record<string, string | undefined> = {}, opts: Parameters<typeof runChild>[2] = {}) =>
    runChild(ctx.entrypoint, childEnvironment(ownerUrl(ctx, db), extra), opts);
  const deploymentId = randomUUID();
  const declared = dbName('i1d');
  const head = dbName('i1');
  const tpl = dbName('tpl');
  const idEnv = { CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'test', CREWFLOW_DEPLOYMENT_ID: deploymentId };
  let bound = false;
  /**
   * A CHAIN-PARTIAL database built FROM SCRATCH: empty database, provider grant, the child with STOP_BEFORE. Never a
   * CREATE DATABASE ... TEMPLATE clone: a clone does not copy the database ACL (pg_database.datacl), so the bootstrap's
   * GRANT CREATE ON DATABASE ... TO rab_owner would be missing and Phase 0b fails for a reason no real install has
   * (harness artefact found in CI, PR #73 first run).
   */
  const partial = async (db: string, stopBefore: string, r: ScenarioReport) => {
    await createEmptyDatabase(ctx, db);
    await providerStep(ctx, db, r);
    const c = await child(db, { CREWFLOW_MIGRATION_TEST_STOP_BEFORE: stopBefore });
    const expected = chainMigrationNames().filter((n) => Number(n.slice(-13)) < Number(stopBefore));
    const s = await readState(ctx, db);
    // A seam-stopped install is a half-installed database: the post-checks fail (68) and it never serves. Exit 0 or 68.
    expect(r, c.exitCode === EXIT.ok || (c.exitCode === EXIT.postCheck && c.result?.serve === false), `partial install before ${stopBefore}: exit 0 or 68, never serving a half install (${summary(c)})`);
    expect(r, JSON.stringify(s.ledger) === JSON.stringify(expected), `ledger = exactly the ${expected.length} migrations before ${stopBefore} (got ${s.ledger.length})`);
  };

  await step('TW-I1d', 'fresh NON-production install that DECLARES its deployment (test/<id>): installs and auto-binds the marker (D6)', async (r) => {
    r.database = declared;
    await createEmptyDatabase(ctx, declared);
    await providerStep(ctx, declared, r);
    const c = await child(declared, idEnv);
    r.evidence.push(`child: ${summary(c)}`);
    expect(r, c.exitCode === EXIT.ok && c.result?.serve === true, 'exit 0, serve=true');
    const s = await readState(ctx, declared);
    bound = s.marker?.bound === true && s.marker.deploymentId === deploymentId;
    expect(r, bound, `marker auto-bound to the declared id (${s.marker?.deploymentId ? 'bound' : 'not bound'})`);
  });

  await step('TW-I1', 'fresh install on an EMPTY database through the real provider SQL, owner URL only (no deployment declaration)', async (r) => {
    r.database = head;
    await createEmptyDatabase(ctx, head);
    await providerStep(ctx, head, r);
    const c = await child(head, {});
    r.evidence.push(`child: ${summary(c)}`);
    expect(r, c.exitCode === EXIT.ok && c.result?.exitCode === 0 && c.result?.serve === true, 'exit 0, result exitCode 0, serve=true');
    expect(r, c.result?.state === 'EMPTY', `classified EMPTY (got ${c.result?.state})`);
    expect(r, (c.result?.applied?.length ?? 0) === chainMigrationNames().length, `applied the whole chain (${c.result?.applied?.length}/${chainMigrationNames().length})`);
    expect(r, c.events.filter((e) => e.event === 'recorded').length === chainMigrationNames().length, `one "recorded" event per migration (${c.events.filter((e) => e.event === 'recorded').length})`);
    expect(r, c.events.some((e) => e.phase === 'A') && c.events.some((e) => e.phase === 'B'), 'phase A and phase B both ran');
    neverLoadedGated(r, c);
    const s = await assertHeadState(ctx, head, r);
    expect(r, s.marker !== null && !s.marker.bound, 'no declaration: the deployment marker exists and stays unbound (non-production)');
  });

  await step('S1', 'second boot: CURRENT, nothing applied, ledger byte-identical, post-checks ran', async (r) => {
    r.database = head;
    const before = await readState(ctx, head);
    const c = await child(head, {});
    r.evidence.push(`child: ${summary(c)}`);
    expect(r, c.exitCode === EXIT.ok && c.result?.state === 'CURRENT' && (c.result?.applied ?? ['?']).length === 0, 'exit 0, CURRENT, applied nothing');
    expect(r, c.lines.some((l) => /post-checks passed/.test(l)), 'post-checks ran on a start with nothing pending (C-2)');
    const after = await readState(ctx, head);
    expect(r, JSON.stringify(after.ledger) === JSON.stringify(before.ledger), 'ledger unchanged');
  });

  await step('ID-2', 'deployment identity: a bound marker refuses a different id and a missing id (67); with no declaration only a production-bound marker refuses (67), outside production it starts (intentional)', async (r) => {
    r.database = declared;
    if (!bound) {
      r.failures.push('FAIL: no bound marker to test (TW-I1d did not bind; see its failure)');
      return;
    }
    const head = declared;
    const wrong = await child(head, { CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'test', CREWFLOW_DEPLOYMENT_ID: randomUUID() });
    expect(r, wrong.exitCode === EXIT.identity && wrong.result?.serve === false, `different CREWFLOW_DEPLOYMENT_ID: exit 67, serve=false (${summary(wrong)})`);
    const missing = await child(head, { CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'test' });
    expect(r, missing.exitCode === EXIT.identity, `missing CREWFLOW_DEPLOYMENT_ID on a bound database: exit 67 (${summary(missing)})`);
    // The child here is a NON-production process (NODE_ENV=test, DB_TARGET=local). BC-11 (owner decision 2026-11-05, Agent 1
    // 0074cecb) changes only PRODUCTION processes: an undeclared production process skips the marker check with one loud
    // warning and proceeds; a declared one is matched exactly (mismatch 67). Outside production the rules are unchanged
    // (pinned by Agent 1): a test-bound marker with no declaration starts; a PRODUCTION-bound marker refuses an undeclared
    // non-production process (67) and a non-production process may not declare production (67). The production path itself
    // needs TLS (N1), which this disposable container does not offer: it is covered by Agent 1's unit tests
    // (decideDeploymentIdentity 'BC-11: production, UNDECLARED …'), not here. The marker is rebound to production through the
    // bind definer (fixture superuser, a member of every role) on this disposable twa database only, then restored in finally.
    const none = await child(head, {});
    expect(r, none.exitCode === EXIT.ok, `no deployment declaration on a TEST-bound database: starts (intentional outside production) (${summary(none)})`);
    const productionId = randomUUID();
    const bindSql = `SELECT core.deployment_identity_bind($1, $2::uuid, $3, $4, $5::uuid, $6::text[])`;
    const hosts = await withClient(withDb(ctx.admin, head), async (c) => (await c.query(`SELECT bound_hosts FROM core.deployment_identity`)).rows[0]?.bound_hosts as string[]);
    await withClient(withDb(ctx.admin, head), (c) => c.query(bindSql, ['production', productionId, 'ID-2 production-bound probe (twenty-mode-check)', 'twenty-mode-check', deploymentId, hosts]));
    try {
      const noneProd = await child(head, {});
      expect(r, noneProd.exitCode === EXIT.identity && noneProd.result?.serve === false, `NON-production process, no declaration, PRODUCTION-bound marker: exit 67, serve=false (${summary(noneProd)})`);
      const missingProd = await child(head, { CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'production' });
      expect(r, missingProd.exitCode === EXIT.identity && missingProd.result?.serve === false, `NON-production process declaring production without CREWFLOW_DEPLOYMENT_ID: exit 67 (${summary(missingProd)})`);
    } finally {
      await withClient(withDb(ctx.admin, head), (c) => c.query(bindSql, ['test', deploymentId, 'ID-2 probe restores the test binding', 'twenty-mode-check', productionId, hosts]));
    }
    const s = await readState(ctx, head);
    expect(r, s.marker?.deploymentId === deploymentId, 'marker still bound to the original id');
    const same = await child(head, idEnv);
    expect(r, same.exitCode === EXIT.ok, `the declared id itself still starts (${summary(same)})`);
  });

  await step('RB-1', 'old-image rollback: a NEWER ledger (unknown migration) is AHEAD: exit 0, nothing applied, never rewound', async (r) => {
    r.database = head;
    await withClient(withDb(ctx.admin, head), (c) => c.query(`INSERT INTO core.migrations (timestamp, name) VALUES (9786700000000, 'NewerReleaseOnly9786700000000')`));
    try {
      const before = await readState(ctx, head);
      for (const policy of ['refuse', 'continue']) {
        const c = await child(head, { CREWFLOW_UPGRADE_FAILURE: policy });
        expect(r, c.exitCode === EXIT.ok && c.result?.state === 'AHEAD' && (c.result?.applied ?? ['?']).length === 0, `policy ${policy}: exit 0, AHEAD, applied nothing (${summary(c)})`);
        expect(r, c.lines.some((l) => /AHEAD/.test(l) && /WARNING/.test(l)), 'a WARNING names the AHEAD ledger');
      }
      const after = await readState(ctx, head);
      expect(r, JSON.stringify(after.ledger) === JSON.stringify(before.ledger), 'ledger unchanged, newer row kept');
    } finally {
      await withClient(withDb(ctx.admin, head), (c) => c.query(`DELETE FROM core.migrations WHERE timestamp = 9786700000000`));
    }
  });

  await step('POST-1', 'post-check failure (RLS disabled on a tenant table): 68 under refuse AND under continue (C3: post-checks stay fail-closed); never serves', async (r) => {
    r.database = head;
    await withClient(withDb(ctx.admin, head), (c) => c.query(`ALTER TABLE core.audit_log DISABLE ROW LEVEL SECURITY`));
    try {
      const refuse = await child(head, { CREWFLOW_UPGRADE_FAILURE_POLICY: 'refuse' });
      expect(r, refuse.exitCode === EXIT.postCheck && refuse.result?.serve === false, `refuse: exit 68, serve=false (${summary(refuse)})`);
      const cont = await child(head, { CREWFLOW_UPGRADE_FAILURE: 'continue' });
      expect(r, cont.exitCode === EXIT.postCheck && cont.result?.serve === false, `continue (C3): post-check still 68, serve=false (${summary(cont)}; checks ${checksSummary(cont)})`);
    } finally {
      await withClient(withDb(ctx.admin, head), (c) => c.query(`ALTER TABLE core.audit_log ENABLE ROW LEVEL SECURITY`));
    }
    const ok = await child(head, {});
    expect(r, ok.exitCode === EXIT.ok, `after repair: exit 0 (${summary(ok)})`);
  });

  await step('LOCK-1', 'lock timeout: another session holds the crewmigr lock: 69 within the bound wait, nothing changed', async (r) => {
    r.database = head;
    const before = await readState(ctx, head);
    const holder = new Client({ connectionString: withDb(ctx.admin, head), application_name: 'twa-t5-lock-holder' });
    await holder.connect();
    try {
      // sql-injection-reviewed: MIGRATION_LOCK_KEY_SQL is a code constant (the crewmigr bigint literal), no input
      await holder.query(`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY_SQL})`);
      // C3 (Agent 1 76dade62): the lock timeout is 69 under EVERY policy (no longer 70 under continue); the default is continue.
      for (const policy of ['refuse', 'continue', undefined]) {
        const c = await child(head, { CREWFLOW_MIGRATION_LOCK_WAIT_SECONDS: '5', CREWFLOW_UPGRADE_FAILURE: policy }, { timeoutMs: 120_000 });
        expect(r, c.exitCode === EXIT.lock && c.result?.serve === false, `policy ${policy ?? 'default (continue)'}: exit 69, serve=false (${summary(c)})`);
        expect(r, c.ms < 60_000, `gave up within the bounded wait (${c.ms} ms)`);
      }
    } finally {
      await holder.end();
    }
    const after = await readState(ctx, head);
    expect(r, JSON.stringify(after.ledger) === JSON.stringify(before.ledger), 'ledger unchanged');
  });

  await step('ID-1', 'identity refusals: superuser, BYPASSRLS+CREATEROLE login, a plain login: 67, nothing created on an EMPTY database', async (r) => {
    const empty = dbName('id1');
    r.database = empty;
    await createEmptyDatabase(ctx, empty);
    await providerStep(ctx, empty, r);
    const pw = randomBytes(18).toString('hex');
    const bypass = `twa_tw_bypass_${RUN_ID}`;
    const plain = `twa_tw_plain_${RUN_ID}`;
    await withClient(withDb(ctx.admin, 'postgres'), async (c) => {
      // sql-injection-reviewed: bypass is built from RUN_ID and passes qi(); the password is a SCRAM verifier computed here
      await c.query(`CREATE ROLE ${qi(bypass)} LOGIN BYPASSRLS CREATEROLE PASSWORD '${scramVerifier(pw)}'`);
      // sql-injection-reviewed: plain is built from RUN_ID and passes qi(); the password is a SCRAM verifier computed here
      await c.query(`CREATE ROLE ${qi(plain)} LOGIN PASSWORD '${scramVerifier(pw)}'`);
      // sql-injection-reviewed: empty passed assertHarnessDatabaseName; every identifier passes qi()
      await c.query(`GRANT CONNECT, CREATE ON DATABASE ${qi(empty)} TO ${qi(bypass)}, ${qi(plain)}`);
    });
    try {
      for (const [label, url] of [
        ['superuser (provider admin)', withDb(ctx.admin, empty)],
        ['BYPASSRLS + CREATEROLE login', withDb(ctx.admin, empty, bypass, pw)],
        ['plain login (not crewflow_owner, no CREATEROLE)', withDb(ctx.admin, empty, plain, pw)],
      ] as const) {
        const c = await runChild(ctx.entrypoint, childEnvironment(url));
        expect(r, c.exitCode === EXIT.identity && c.result?.serve === false, `${label}: exit 67 (${summary(c)})`);
      }
      const s = await readState(ctx, empty);
      expect(r, s.ledger.length === 0 && s.coreTables === 0, `nothing created (ledger ${s.ledger.length}, core tables ${s.coreTables})`);
    } finally {
      await withClient(withDb(ctx.admin, 'postgres'), async (c) => {
        // sql-injection-reviewed: every identifier passes qi() (harness-built names)
        await c.query(`REVOKE ALL ON DATABASE ${qi(empty)} FROM ${qi(bypass)}, ${qi(plain)}`);
        // sql-injection-reviewed: bypass is built from RUN_ID and passes qi()
        await c.query(`DROP ROLE ${qi(bypass)}`);
        // sql-injection-reviewed: plain is built from RUN_ID and passes qi()
        await c.query(`DROP ROLE ${qi(plain)}`);
      });
    }
  });

  await step('CFG-1', 'configuration refusals: 64, nothing created', async (r) => {
    const empty = dbName('cfg');
    r.database = empty;
    await createEmptyDatabase(ctx, empty);
    await providerStep(ctx, empty, r);
    const cases: Array<[string, Record<string, string | undefined>]> = [
      ['CREWFLOW_DB_MODE set', { CREWFLOW_DB_MODE: 'twenty' }],
      ['CREWFLOW_UPGRADE_FAILURE_POLICY=ignore', { CREWFLOW_UPGRADE_FAILURE_POLICY: 'ignore' }],
      ['CREWFLOW_UPGRADE_FAILURE=ignore', { CREWFLOW_UPGRADE_FAILURE: 'ignore' }],
      ['CREWFLOW_UPGRADE_FAILURE and the deprecated alias disagree', { CREWFLOW_UPGRADE_FAILURE: 'continue', CREWFLOW_UPGRADE_FAILURE_POLICY: 'refuse' }],
      ['CREWFLOW_MIGRATION_APPROVAL_MODE=sometimes', { CREWFLOW_MIGRATION_APPROVAL_MODE: 'sometimes' }],
      ['CREWFLOW_MIGRATE_ON_START=maybe', { CREWFLOW_MIGRATE_ON_START: 'maybe' }],
    ];
    for (const [label, extra] of cases) {
      const c = await child(empty, extra);
      expect(r, c.exitCode === EXIT.config && c.result?.serve === false, `${label}: exit 64 (${summary(c)})`);
    }
    // O3 C1 (owner decision 2026-11-05, "exactly like Twenty"): DISABLE_DB_MIGRATIONS=true is an ACCEPTED setting, "this
    // process never migrates" (api-prestart then never starts the child; the Worker never migrates either way). It is no
    // longer a misconfiguration; the child, if started anyway, declines to run with its own documented answer (Agent 1
    // cbd5880d): exit 64, the reason naming DISABLE_DB_MIGRATIONS, nothing created.
    const disabled = await child(empty, { DISABLE_DB_MIGRATIONS: 'true' });
    expect(r, disabled.exitCode === EXIT.config && disabled.result?.serve === false && /DISABLE_DB_MIGRATIONS=true: the migrate child does not run/.test(disabled.result?.reason ?? ''), `DISABLE_DB_MIGRATIONS=true (C1, accepted): the child does not run, reason says so (${summary(disabled)})`);
    // BC-11 (owner decision 2026-11-05, Agent 2 d27a371a): production without an explicit approval mode is no longer a
    // configuration refusal; the mode defaults to `none`. This disposable database has no TLS, so a production child stops
    // later (N1/TLS, not config): asserted as "not refused at config (exit != 64)". The invalid-mode pin above stays.
    const prodNoMode = await child(empty, { NODE_ENV: 'production' });
    expect(r, prodNoMode.exitCode !== EXIT.config, `production without an explicit approval mode: NOT a config refusal (exit != 64) (${summary(prodNoMode)})`);
    const missing = await runChild(ctx.entrypoint, childEnvironment(ownerUrl(ctx, empty), { PG_DATABASE_URL: undefined }));
    expect(r, missing.exitCode === EXIT.config, `PG_DATABASE_URL missing: exit 64 (${summary(missing)})`);
    const s = await readState(ctx, empty);
    expect(r, s.ledger.length === 0 && s.coreTables === 0, `nothing created (ledger ${s.ledger.length}, core tables ${s.coreTables})`);
  });

  await step('SEAM-1', 'test seams are refused (64, nothing created) outside NODE_ENV=test + disposable database + non-production', async (r) => {
    const nondisp = dbName('seamnd');
    r.database = nondisp;
    await createEmptyDatabase(ctx, nondisp, false);
    await providerStep(ctx, nondisp, r);
    const a = await child(nondisp, { CREWFLOW_MIGRATION_TEST_FAIL_AT: FAIL_AT });
    expect(r, a.exitCode === EXIT.config, `FAIL_AT on a database without crewflow.disposable_test_database: exit 64 (${summary(a)})`);
    const b = await child(nondisp, { CREWFLOW_MIGRATION_TEST_STOP_BEFORE: STOP_BEFORE });
    expect(r, b.exitCode === EXIT.config, `STOP_BEFORE on a database without the marker: exit 64 (${summary(b)})`);
    // Spoof attempt: the marker set as a SESSION option in the URL (a placeholder GUC any login may set) must not count.
    const spoofUrl = new URL(ownerUrl(ctx, nondisp));
    spoofUrl.searchParams.set('options', '-c crewflow.disposable_test_database=true');
    const g = await runChild(ctx.entrypoint, childEnvironment(spoofUrl.toString(), { CREWFLOW_MIGRATION_TEST_FAIL_AT: FAIL_AT }));
    expect(r, g.exitCode === EXIT.config, `marker spoofed through the URL's session options: still exit 64 (${summary(g)})`);
    const disp = dbName('seamprod');
    await createEmptyDatabase(ctx, disp);
    await providerStep(ctx, disp, r);
    const c = await child(disp, { NODE_ENV: 'development', CREWFLOW_MIGRATION_TEST_FAIL_AT: FAIL_AT });
    expect(r, c.exitCode === EXIT.config, `FAIL_AT with NODE_ENV=development: exit 64 (${summary(c)})`);
    const d = await child(disp, { CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'production', CREWFLOW_DEPLOYMENT_ID: randomUUID(), CREWFLOW_MIGRATION_TEST_FAIL_AT: FAIL_AT });
    expect(r, d.exitCode === EXIT.config, `FAIL_AT with a production deployment environment: exit 64 (${summary(d)})`);
    const e = await child(disp, { CREWFLOW_MIGRATION_TEST_STOP_BEFORE: '17867195' });
    expect(r, e.exitCode === EXIT.config, `malformed STOP_BEFORE: exit 64 (${summary(e)})`);
    const f = await child(disp, { CREWFLOW_MIGRATION_TEST_FAIL_AT: 'DROP TABLE x' });
    expect(r, f.exitCode === EXIT.config, `malformed FAIL_AT: exit 64 (${summary(f)})`);
    for (const name of [nondisp, disp]) {
      const s = await readState(ctx, name);
      expect(r, s.ledger.length === 0 && s.coreTables === 0, `${name}: nothing created`);
    }
  });

  await step('TPL', `CHAIN-PARTIAL: fresh install stopped before ${STOP_BEFORE} (test seam), built from scratch`, async (r) => {
    r.database = tpl;
    await partial(tpl, STOP_BEFORE, r);
  });

  await step('BEHIND-1', 'pending on a NON-fresh database in token mode: 65 without/with a wrong token; deploy-prepare check prints the token (exit 3); the right token applies to head', async (r) => {
    const db = dbName('behind');
    r.database = db;
    // Past the ROW_COPY trio, then tenant data: NOT a proven fresh install (a proven fresh install may apply the whole chain
    // without a token by design, owner rule; locked-migration-runner.ts step 3c), so the per-release token is the gate.
    await partial(db, FAIL_AT.slice(-13), r);
    await withClient(withDb(ctx.admin, db), (c) => c.query(`INSERT INTO core.organisation (id, name, slug) VALUES ($1, 'twa t5 behind tenant', $2)`, [randomUUID(), `twa-t5-behind-${RUN_ID}`]));
    const before = await readState(ctx, db);
    const none = await child(db, { CREWFLOW_MIGRATION_APPROVAL_MODE: 'token' });
    expect(r, JSON.stringify((await readState(ctx, db)).ledger) === JSON.stringify(before.ledger), `token mode WITHOUT a token applied nothing (${none.events.filter((e) => e.event === 'recorded').length} recorded)`);
    expect(r, none.exitCode === EXIT.behind && none.result?.serve === false && (none.result?.pending?.length ?? 0) > 0, `token mode, no approval: exit 65, serve=false, pending listed (${summary(none)})`);
    const wrong = await child(db, { CREWFLOW_MIGRATION_APPROVAL_MODE: 'token', CREWFLOW_MIGRATION_APPROVED: `sha256:${'0'.repeat(64)}` });
    expect(r, wrong.exitCode === EXIT.behind, `token mode, wrong token: exit 65 (${summary(wrong)})`);
    expect(r, JSON.stringify((await readState(ctx, db)).ledger) === JSON.stringify(before.ledger), 'nothing applied by the refused runs');
    let token: string | null = null;
    if (existsSync(DEPLOY_PREPARE)) {
      // Token mode must be set on deploy-prepare's OWN environment (childEnvironment builds a clean one): since BC-11 (owner
      // decision 2026-11-05, Agent 2 d27a371a) an unset mode defaults to `none` and applies (see BEHIND-2).
      const check = await runChild(DEPLOY_PREPARE, childEnvironment(ownerUrl(ctx, db), { CREWFLOW_MIGRATE_ON_START: undefined, CREWFLOW_MIGRATION_APPROVAL_MODE: 'token' }));
      token = check.lines.map((l) => /approval token for exactly this set: (\S+)/.exec(l)?.[1]).find(Boolean) ?? null;
      expect(r, check.exitCode === 3 && token !== null, `deploy-prepare check run: exit 3 and prints the token (exit ${check.exitCode}; ${check.lines.slice(-2).join(' | ').slice(0, 220)})`);
      expect(r, JSON.stringify((await readState(ctx, db)).ledger) === JSON.stringify(before.ledger), 'deploy-prepare check run (token mode, no token) applied nothing');
    } else {
      r.failures.push('FAIL: deploy-prepare.js not built');
    }
    if (token) {
      const ok = await child(db, { CREWFLOW_MIGRATION_APPROVAL_MODE: 'token', CREWFLOW_MIGRATION_APPROVED: token });
      expect(r, ok.exitCode === EXIT.ok && ok.result?.state === 'CHAIN-PARTIAL', `token mode, the right token: exit 0 from CHAIN-PARTIAL (${summary(ok)})`);
      neverLoadedGated(r, ok);
      await assertHeadState(ctx, db, r);
      const check2 = await runChild(DEPLOY_PREPARE, childEnvironment(ownerUrl(ctx, db), { CREWFLOW_MIGRATE_ON_START: undefined, CREWFLOW_MIGRATION_APPROVAL_MODE: 'token' }));
      expect(r, check2.exitCode === 0, `deploy-prepare check run on head: exit 0 (${check2.exitCode}; ${check2.lines.slice(-1).join('').slice(0, 160)})`);
    }
  });

  await step('BEHIND-2', 'BC-11 (owner decision 2026-11-05): deploy-prepare with NO approval mode (default none) on a NON-fresh behind database applies directly: exit 0, head state', async (r) => {
    const db = dbName('behind2');
    r.database = db;
    await partial(db, FAIL_AT.slice(-13), r);
    await withClient(withDb(ctx.admin, db), (c) => c.query(`INSERT INTO core.organisation (id, name, slug) VALUES ($1, 'twa t5 behind2 tenant', $2)`, [randomUUID(), `twa-t5-behind2-${RUN_ID}`]));
    const before = await readState(ctx, db);
    if (!existsSync(DEPLOY_PREPARE)) {
      r.failures.push('FAIL: deploy-prepare.js not built');
      return;
    }
    const run = await runChild(DEPLOY_PREPARE, childEnvironment(ownerUrl(ctx, db), { CREWFLOW_MIGRATE_ON_START: undefined }));
    const after = await readState(ctx, db);
    expect(r, run.exitCode === 0, `deploy-prepare, no mode: exit 0 (${run.exitCode}; ${run.lines.slice(-1).join('').slice(0, 160)})`);
    expect(r, after.ledger.length > before.ledger.length, `deploy-prepare, no mode: applied the pending migrations without a token (${before.ledger.length} -> ${after.ledger.length})`);
    await assertHeadState(ctx, db, r);
  });

  await step('SHIM-1', 'the D3(b) ROW_COPY shim refuses a database that ever held tenant data; nothing applied, the data intact', async (r) => {
    const db = dbName('shim');
    r.database = db;
    await partial(db, STOP_BEFORE, r);
    const org = randomUUID();
    await withClient(withDb(ctx.admin, db), (c) => c.query(`INSERT INTO core.organisation (id, name, slug) VALUES ($1, 'twa t5 tenant', $2)`, [org, `twa-t5-${RUN_ID}`]));
    const before = await readState(ctx, db);
    for (const policy of ['refuse', 'continue']) {
      const c = await child(db, { CREWFLOW_UPGRADE_FAILURE: policy });
      expect(r, c.exitCode !== EXIT.ok && c.exitCode !== EXIT.degraded && c.result?.serve === false, `policy ${policy}: refused, serve=false (${summary(c)}; reason ${(c.result?.reason ?? '').slice(0, 160)})`);
      expect(r, !c.events.some((e) => /^(HwsHistoricalRowsPrivilegedCopy|AiActionProposalActivate|AiAssistantRoundOnly)\d{13}$/.test(e.name)), 'no ROW_COPY migration started');
    }
    const after = await readState(ctx, db);
    expect(r, JSON.stringify(after.ledger) === JSON.stringify(before.ledger), 'ledger unchanged');
    const kept = await withClient(withDb(ctx.admin, db), async (c) => (await c.query(`SELECT 1 FROM core.organisation WHERE id = $1`, [org])).rows.length);
    expect(r, kept === 1, 'the tenant row is intact');
  });

  await step('UPF-0', `an interrupted FIRST install (CHAIN-PARTIAL, still provably fresh) that fails (FAIL_AT=${FAIL_AT}) never serves under any policy (C3: default continue, continue, the alias)`, async (r) => {
    const db = dbName('upf0');
    r.database = db;
    await partial(db, STOP_BEFORE, r);
    for (const extra of [{}, { CREWFLOW_UPGRADE_FAILURE: 'continue' }, { CREWFLOW_UPGRADE_FAILURE_POLICY: 'continue-if-compatible' }] as Array<Record<string, string>>) {
      const c = await child(db, { CREWFLOW_MIGRATION_TEST_FAIL_AT: FAIL_AT, ...extra });
      expect(r, c.exitCode === EXIT.failed && c.result?.serve === false, `${JSON.stringify(extra)}: exit 66, serve=false (${summary(c)}; reason ${(c.result?.reason ?? '').slice(-120)})`);
    }
  });

  await step('UPF-1', `failed UPGRADE of a database holding tenant data (FAIL_AT=${FAIL_AT}): refuse → 66; continue (default, explicit, the alias) → ERROR + 70, serve; then recovery`, async (r) => {
    const db = dbName('upf');
    r.database = db;
    await partial(db, STOP_BEFORE, r);
    // Bring it past the ROW_COPY trio while it is still provably fresh, then make it a real tenant database.
    const pre = await child(db, { CREWFLOW_MIGRATION_TEST_STOP_BEFORE: FAIL_AT.slice(-13) });
    const preLedger = (await readState(ctx, db)).ledger;
    expect(r, (pre.exitCode === EXIT.ok || pre.exitCode === EXIT.postCheck) && preLedger.length === chainMigrationNames().filter((n) => Number(n.slice(-13)) < Number(FAIL_AT.slice(-13))).length, `advanced to just before ${FAIL_AT} (${summary(pre)})`);
    await withClient(withDb(ctx.admin, db), (c) => c.query(`INSERT INTO core.organisation (id, name, slug) VALUES ($1, 'twa t5 upf tenant', $2)`, [randomUUID(), `twa-t5-upf-${RUN_ID}`]));
    const refuse = await child(db, { CREWFLOW_MIGRATION_TEST_FAIL_AT: FAIL_AT, CREWFLOW_UPGRADE_FAILURE_POLICY: 'refuse' });
    expect(r, refuse.exitCode === EXIT.failed && refuse.result?.serve === false, `refuse: exit 66, serve=false (${summary(refuse)})`);
    expect(r, refuse.result?.failedMigration === FAIL_AT, `failedMigration names ${FAIL_AT} (got ${refuse.result?.failedMigration})`);
    const s1 = await readState(ctx, db);
    const ts = Number(FAIL_AT.slice(-13));
    expect(r, !s1.ledger.includes(FAIL_AT) && s1.ledger.some((n) => Number(n.slice(-13)) >= Number(STOP_BEFORE) && Number(n.slice(-13)) < ts), 'the migrations before it committed; the failed one is not recorded');
    expect(r, s1.lockHolders === 0, 'lock released');
    // C3 (owner decision 2026-11-05, Agent 1 76dade62): under continue a failed UPGRADE migration logs an ERROR naming it and
    // exits 70 with serve=true when the deployment identity is OK; the other checks are reported as diagnostics only.
    for (const extra of [{}, { CREWFLOW_UPGRADE_FAILURE: 'continue' }, { CREWFLOW_UPGRADE_FAILURE_POLICY: 'continue-if-compatible' }] as Array<Record<string, string>>) {
      const cont = await child(db, { CREWFLOW_MIGRATION_TEST_FAIL_AT: FAIL_AT, ...extra });
      r.evidence.push(`${JSON.stringify(extra)}: ${summary(cont)}; checks ${checksSummary(cont)}`);
      expect(r, cont.exitCode === EXIT.degraded && cont.result?.serve === true && cont.result?.policy === 'continue', `${JSON.stringify(extra)}: exit 70, serve=true, policy continue (${summary(cont)})`);
      expect(r, cont.result?.failedMigration === FAIL_AT && cont.lines.some((l) => /ERROR/.test(l) && l.includes(FAIL_AT)), `${JSON.stringify(extra)}: an ERROR names ${FAIL_AT}`);
      expect(r, !(await readState(ctx, db)).ledger.includes(FAIL_AT), `${JSON.stringify(extra)}: the failed migration is not recorded`);
    }
    const rec = await child(db, {});
    expect(r, rec.exitCode === EXIT.ok && rec.result?.state === 'CHAIN-PARTIAL', `recovery without the seam: exit 0 (${summary(rec)})`);
    await assertHeadState(ctx, db, r);
  });

  await step('UPF-2', `failed FIRST install (FAIL_AT=${FRESH_FAIL_AT}) never serves under any policy (C3: default continue, the alias); a restart resumes`, async (r) => {
    const db = dbName('upf2');
    r.database = db;
    await createEmptyDatabase(ctx, db);
    await providerStep(ctx, db, r);
    for (const extra of [{}, { CREWFLOW_UPGRADE_FAILURE_POLICY: 'continue-if-compatible' }] as Array<Record<string, string>>) {
      const c = await child(db, { CREWFLOW_MIGRATION_TEST_FAIL_AT: FRESH_FAIL_AT, ...extra });
      expect(r, c.exitCode === EXIT.failed && c.result?.serve === false, `${JSON.stringify(extra)}: exit 66, serve=false (${summary(c)})`);
    }
    const rec = await child(db, {});
    expect(r, rec.exitCode === EXIT.ok, `restart without the seam completes the install (${summary(rec)})`);
    await assertHeadState(ctx, db, r);
  });

  const killCase = async (id: string, title: string, killOn: { event: 'start' | 'recorded'; name: string; delayMs?: number }) =>
    step(id, title, async (r) => {
      const db = dbName(id);
      r.database = db;
      await partial(db, STOP_BEFORE, r);
      const k = await child(db, {}, { killOn });
      expect(r, k.killed && k.exitCode !== 0, `child killed at ${killOn.event} ${killOn.name}${killOn.delayMs ? ` +${killOn.delayMs}ms` : ''} (${summary(k)})`);
      const freedIn = await waitLockFree(ctx, db, 15_000);
      expect(r, freedIn >= 0, `migration lock released ${freedIn >= 0 ? `within ${freedIn} ms` : 'NOT within 15 s'} of the kill`);
      const mid = await readState(ctx, db);
      r.evidence.push(`after the kill: ${killOn.name} ${mid.ledger.includes(killOn.name) ? 'IS' : 'is NOT'} in the ledger (${mid.ledger.length} rows)`);
      expect(r, new Set(mid.ledger).size === mid.ledger.length, 'no duplicate ledger row after the kill');
      const rec = await child(db, {});
      expect(r, rec.exitCode === EXIT.ok, `resume after the kill: exit 0 (${summary(rec)})`);
      expect(r, !rec.events.some((e) => e.event === 'start' && mid.ledger.includes(e.name)), 'the resume never re-runs a recorded migration');
      neverLoadedGated(r, k, rec);
      await assertHeadState(ctx, db, r);
    });
  await killCase('KILL-START', `SIGKILL at "start" of ${KILL_START_TXFALSE} (transaction=false)`, { event: 'start', name: KILL_START_TXFALSE });
  await killCase('KILL-INSIDE', `SIGKILL 400 ms inside ${KILL_INSIDE_TXFALSE} (transaction=false)`, { event: 'start', name: KILL_INSIDE_TXFALSE, delayMs: 400 });
  await killCase('KILL-RECORDED', `SIGKILL at "recorded" of ${KILL_RECORDED} (shimmed ROW_COPY, transactional)`, { event: 'recorded', name: KILL_RECORDED });

  await step('S4', 'three replicas start together on a CHAIN-PARTIAL database: one applies, the others wait; all exit 0, no duplicate', async (r) => {
    const db = dbName('s4');
    r.database = db;
    await partial(db, STOP_BEFORE, r);
    const runs = await Promise.all([1, 2, 3].map(() => child(db, {})));
    runs.forEach((c, i) => r.evidence.push(`replica ${i + 1}: ${summary(c)}`));
    expect(r, runs.every((c) => c.exitCode === EXIT.ok), 'every replica exits 0');
    expect(r, runs.filter((c) => (c.result?.applied?.length ?? 0) > 0).length === 1, 'exactly one replica applied migrations');
    neverLoadedGated(r, ...runs);
    await assertHeadState(ctx, db, r);
  });

  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// UPG-1 (cluster B): a separated-layout database moved to the owner login
// ---------------------------------------------------------------------------------------------------------------------

async function transition(ctx: Ctx, major: number, separatedDb: string): Promise<ScenarioReport[]> {
  const r: ScenarioReport = {
    id: 'UPG-1',
    title: 'separated layout → owner login: the real transition SQL, then pending-only (CURRENT, nothing re-run)',
    status: 'NOT TESTED',
    pgMajor: major,
    database: separatedDb,
    evidence: [],
    failures: [],
  };
  try {
    assertHarnessDatabaseName(separatedDb);
    if (!existsSync(ctx.entrypoint)) throw new Refusal('child not built');
    if (await ownerExists(ctx)) throw new Refusal('crewflow_owner already exists on this cluster: UPG-1 needs a cluster built only in the separated layout');
    const before = await readState(ctx, separatedDb);
    const res = runProviderSql(ctx, TRANSITION_SQL, separatedDb);
    expect(r, res.status === 0, `transition-from-separated.sql ran as the provider admin (psql exit ${res.status}${res.status ? `: ${res.tail}` : ''})`);
    const mem = await withClient(withDb(ctx.admin, separatedDb), async (c) =>
      (await c.query(`SELECT pg_get_userbyid(roleid) AS r, admin_option AS a, inherit_option AS i, set_option AS s FROM pg_auth_members WHERE member = 'crewflow_owner'::regrole ORDER BY 1`)).rows,
    );
    r.evidence.push(`crewflow_owner memberships: ${mem.map((m) => `${m.r}(a=${m.a},i=${m.i},s=${m.s})`).join(' ')}`);
    expect(r, !mem.some((m) => m.r === 'crewflow_app' || m.r === 'crewflow_worker'), 'no membership of crewflow_app or crewflow_worker');
    const c = await runChild(ctx.entrypoint, childEnvironment(ownerUrl(ctx, separatedDb)));
    r.evidence.push(`child: ${summary(c)}`);
    expect(r, c.exitCode === EXIT.ok && c.result?.state === 'CURRENT' && (c.result?.applied ?? ['?']).length === 0, 'exit 0, CURRENT, applied nothing (pending-only)');
    expect(r, c.events.length === 0, `no migration started (${c.events.length} events)`);
    const after = await readState(ctx, separatedDb);
    expect(r, JSON.stringify(after.ledger) === JSON.stringify(before.ledger), 'ledger byte-identical');
    await assertHeadState(ctx, separatedDb, r);
    r.status = r.failures.length ? 'FAIL' : 'PASS';
  } catch (e) {
    r.status = 'FAIL';
    r.failures.push(`threw: ${e instanceof Error ? redact(e.message) : 'unknown'}`);
  }
  log(`${r.id} ${r.status} (${separatedDb})`);
  for (const line of [...r.evidence, ...r.failures]) log(`  ${line}`);

  // MIX-1, revised for BC-17 (owner decision 2026-11-05, Agent 1 80686512 / f91f1038). Roles are cluster-wide, and the
  // transition (UPG-1 above, the provider-admin SQL) has made crewflow / crewflow_app NOLOGIN with no password, so a
  // separated deployment on this cluster can no longer log in: that is the owner-decided mitigation, asserted here as such
  // (before: "crewflow_app still authenticates"). A FRESH owner-login install of a second database on this cluster must then
  // never re-enable a legacy login, whatever its outcome; if it is refused, it creates nothing.
  const m: ScenarioReport = { id: 'MIX-1', title: 'after the transition, legacy logins stay disabled cluster-wide (BC-17); a second fresh install never re-enables them', status: 'NOT TESTED', pgMajor: major, evidence: [], failures: [] };
  try {
    const appPw = process.env.CREWFLOW_APP_BOOTSTRAP_PASSWORD ?? '';
    const appLogin = async () => {
      try {
        await withClient(withDb(ctx.admin, separatedDb, 'crewflow_app', appPw), (c) => c.query('SELECT 1'));
        return true;
      } catch {
        return false;
      }
    };
    expect(m, !(await appLogin()), 'before: crewflow_app can no longer authenticate (NOLOGIN after the transition, BC-17)');
    const before = await legacyLoginProblems(ctx);
    expect(m, before.length === 0, `before: legacy logins disabled (${before.join('; ') || 'clean'})`);
    const db = dbName('mix');
    m.database = db;
    await createEmptyDatabase(ctx, db);
    // sql-injection-reviewed: db passed assertHarnessDatabaseName (createEmptyDatabase) and qi()
    await withClient(withDb(ctx.admin, db), (c) => c.query(`GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${qi(db)} TO crewflow_owner WITH GRANT OPTION`));
    const c = await runChild(ctx.entrypoint, childEnvironment(ownerUrl(ctx, db)));
    m.evidence.push(`child: ${summary(c)}; reason ${(c.result?.reason ?? '').slice(0, 200)}`);
    if (c.exitCode !== EXIT.ok) {
      const s = await readState(ctx, db);
      expect(m, c.result?.serve === false && s.ledger.length === 0 && s.coreTables === 0, `refused, nothing created (ledger ${s.ledger.length}, core tables ${s.coreTables})`);
    }
    const after = await legacyLoginProblems(ctx);
    expect(m, after.length === 0, `after: legacy logins still disabled (${after.join('; ') || 'clean'})`);
    expect(m, !(await appLogin()), 'after: crewflow_app still cannot authenticate');
    m.status = m.failures.length ? 'FAIL' : 'PASS';
  } catch (e) {
    m.status = 'FAIL';
    m.failures.push(`threw: ${e instanceof Error ? redact(e.message) : 'unknown'}`);
  }
  log(`${m.id} ${m.status}`);
  for (const line of [...m.evidence, ...m.failures]) log(`  ${line}`);
  return [r, m];
}

// ---------------------------------------------------------------------------------------------------------------------
// ci-db: the CI test database, built the owner-login way (replaces the separated restricted-migrator build for the suites)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * One EMPTY disposable database → the real provider SQL (01-crewflow-owner.sql, psql as the cluster superuser) → Agent 1's
 * migrate child with PG_DATABASE_URL = crewflow_owner only → the head-state assertions (ledger = chain, 1786721330000 absent,
 * B3, reachability, golden posture) → `OWNER_DB=<name>` written to TWENTY_CI_DB_FILE for the test step, which then runs
 * `eval "$(node twenty-test-env.cjs "$OWNER_DB" --source bootstrap)"` (TEST_DATABASE_URL = crewflow_owner). Any failed
 * assertion fails the step: the suites never run on a database the owner-login install did not build correctly.
 */
async function ciDatabase(ctx: Ctx, major: number): Promise<number> {
  const out = process.env.TWENTY_CI_DB_FILE?.trim();
  if (!out) throw new Refusal('TWENTY_CI_DB_FILE is required');
  const entry = ctx.entrypoint;
  const r: ScenarioReport = { id: 'CI-DB', title: 'owner-login test database for the CI suites', status: 'NOT TESTED', pgMajor: major, evidence: [], failures: [] };
  const db = dbName('ci');
  r.database = db;
  await createEmptyDatabase(ctx, db);
  await providerStep(ctx, db, r);
  const c = await runChild(entry, childEnvironment(ownerUrl(ctx, db)));
  r.evidence.push(`child (${entry === SOURCE_ENTRYPOINT ? 'source via ts-node' : 'dist'}): ${summary(c)}`);
  expect(r, c.exitCode === EXIT.ok && c.result?.state === 'EMPTY' && c.result?.serve === true, 'fresh install: exit 0, EMPTY, serve=true');
  neverLoadedGated(r, c);
  if (c.exitCode === EXIT.ok) await assertHeadState(ctx, db, r);
  else r.failures.push(...c.lines.slice(-8).map((l) => `child: ${l.slice(0, 240)}`));
  r.status = r.failures.length ? 'FAIL' : 'PASS';
  log(`${r.id} ${r.status} (${db})`);
  for (const line of [...r.evidence, ...r.failures]) log(`  ${line}`);
  if (r.status === 'PASS') writeFileSync(out, `OWNER_DB=${db}\n`);
  return r.status === 'PASS' ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------------

const SCENARIO_IDS = ['TW-I1d', 'TW-I1', 'S1', 'ID-2', 'RB-1', 'POST-1', 'LOCK-1', 'ID-1', 'CFG-1', 'SEAM-1', 'TPL', 'BEHIND-1', 'BEHIND-2', 'SHIM-1', 'UPF-0', 'UPF-1', 'UPF-2', 'KILL-START', 'KILL-INSIDE', 'KILL-RECORDED', 'S4', 'UPG-1'];

async function main(argv: string[]): Promise<number> {
  const reportIdx = argv.indexOf('--report');
  const reportFile = reportIdx >= 0 ? argv[reportIdx + 1] : undefined;
  const args = reportIdx >= 0 ? argv.filter((_, i) => i !== reportIdx && i !== reportIdx + 1) : argv;
  const [command, ...rest] = args;
  const write = (reports: ScenarioReport[]) => {
    if (reportFile) writeFileSync(reportFile, JSON.stringify({ runId: RUN_ID, reports }, null, 2));
    return reports.some((x) => x.status === 'FAIL') ? 1 : 0;
  };
  if (command === 'list') {
    for (const id of SCENARIO_IDS) log(id);
    return 0;
  }
  const ctx = context();
  const { major } = await assertDisposableCluster(ctx);
  if (command === 'owner-fixture') {
    await ownerFixture(ctx, rest[0] ?? '');
    return 0;
  }
  if (command === 'lifecycle' || command === 'scenario') return write(await lifecycle(ctx, major));
  if (command === 'transition') return write(await transition(ctx, major, rest[0] ?? ''));
  if (command === 'ci-db') return ciDatabase(ctx, major);
  process.stderr.write('usage: twenty-mode-check.ts list | owner-fixture <db> | lifecycle | transition <separated-db> | ci-db [--report <file>]\n');
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
