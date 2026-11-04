/**
 * Owner-login lifecycle (PR 3): the live proof on a DISPOSABLE PostgreSQL 16 or 18 cluster. Never against anything else.
 *
 *   OWNER_LOGIN_CHECK_ADMIN_URL=<superuser of a disposable loopback cluster started with -c crewflow.disposable_cluster=on>
 *   OWNER_LOGIN_CHECK_SCENARIOS=fresh,lifecycle | transition | unsupported       (one cluster per group: roles are cluster-wide)
 *   ts-node --transpile-only -P packages/rab-server/tsconfig.app.json \
 *     packages/rab-server/src/database/typeorm/scripts/migrate/owner-login/owner-login-lifecycle-check.ts
 *
 * fresh       the provider-admin step (postgres-init/owner-login/01-crewflow-owner.sql), then the migrate-on-start child on
 *             an EMPTY database: bootstrap + the whole chain + the ROW_COPY shim. Then: golden posture (exact), secure-owner
 *             invariants, deploy post-checks as the owner, crewflow_worker has zero members, the rolemaker is gone, nothing
 *             but the five extensions depends on crewflow_owner, RLS coverage gate as crewflow_app, second boot = CURRENT.
 *             GOLDEN EQUIVALENCE: a reference database built the same way but with the three ROW_COPY migrations run by the
 *             SUPERUSER (M0 Agent A replay B) must have an identical catalog snapshot (relations, columns, constraints,
 *             indexes, policies, functions incl. body hashes, triggers, schemas, default ACLs, extensions, sequences,
 *             views, comments, ledger) and both must match the golden posture.
 * lifecycle   pending (CHAIN-PARTIAL resume applies only the rest); interrupted at four kill points (phase A, phase B,
 *             SIGTERM self-cancel, inside the transaction=false ArchiveAndSearchSchema1786719920000 while it waits on a
 *             lock) and then completed, equal to the fresh snapshot; three concurrent children on one EMPTY database;
 *             lock timeout (with refuse, continue-if-compatible without and with a posture hook = exit 70); AHEAD
 *             rollback; FOREIGN refused untouched; wrong role (BYPASSRLS, a reachable predefined role) refused.
 * transition  a database built in the SEPARATED layout (superuser + restricted phase-A migrator, tenant data seeded),
 *             4 migrations short of head; the provider admin runs postgres-init/owner-login/transition-from-separated.sql;
 *             the owner-login child applies ONLY those 4 (not fresh: no shim, N1 path), post-checks and golden posture.
 * unsupported the child refuses the server version before any change (run it on a PostgreSQL 15 or 17 cluster).
 *
 * `--child`: one migrate-on-start run in THIS process for the subprocess scenarios (config from OWNER_LOGIN_CHILD_* vars);
 * prints the result line and exits with the startup exit code. Output: names, counts, states. Never a URL or password.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';
import { DataSource, DataSourceOptions } from 'typeorm';

import { STARTUP_EXIT_CODES } from '../../../../owner-login/runtime-db-config';
import { coreMigrationDataSourceOptions, GuardedMigrationDataSource } from '../../../core/core.datasource';
import { compareWithGolden } from '../../../core/security-posture';
import { secureOwnerInvariantViolations } from '../../../core/secure-owner-invariants';
import { deployPostCheckProblems } from '../deploy-post-checks';
import { runLockedMigrations } from '../locked-migration-runner';
import { MIGRATION_LOCK_KEY } from '../migration-lock';
import { installSigtermSelfCancel, MigrateOnStartResult, RESULT_LINE_PREFIX, runMigrateOnStart, StartupOutcome } from './migrate-on-start';
import { PRIVILEGED_COPY_MIGRATION, SHIMMED_MIGRATIONS } from './row-copy-shim';

/** The startup exit codes of the ONE runtime config module (Agent 2). */
export const EXIT: Readonly<Record<StartupOutcome, number>> = STARTUP_EXIT_CODES;

const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..', '..', '..');
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'core', 'migrations');
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d{13}-[^.]+\.(ts|js)$/.test(f))
  .sort()
  .map((f) => ({ ts: Number(f.slice(0, 13)), name: `${f.slice(14).replace(/\.(ts|js)$/, '')}${f.slice(0, 13)}`, path: join(MIGRATIONS_DIR, f).replace(/\\/g, '/') }));
const GOLDEN = readFileSync(join(__dirname, '..', '..', '..', 'core', 'security-posture.golden.txt'), 'utf8').split('\n').filter(Boolean);
const OWNER_SQL = readFileSync(join(ROOT, 'packages', 'rab-docker', 'postgres-init', 'owner-login', '01-crewflow-owner.sql'), 'utf8');
const TRANSITION_SQL = readFileSync(join(ROOT, 'packages', 'rab-docker', 'postgres-init', 'owner-login', 'transition-from-separated.sql'), 'utf8');

const sanitise = (text: string) => text.replace(/postgres(ql)?:\/\/\S+/g, '<url>').replace(/PASSWORD\s+'[^']*'/gi, "PASSWORD '<redacted>'");
const log = (line: string) => console.log(`[owner-login] ${line}`); // eslint-disable-line no-console
const failures: string[] = [];
function check(ok: boolean, label: string, detail: readonly string[] = []): void {
  log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) {
    for (const d of detail.slice(0, 40)) log(`     ${sanitise(d)}`);
    failures.push(label);
  }
}

// ── Child mode ─────────────────────────────────────────────────────────────────────────────────────────────────────
async function childMain(): Promise<void> {
  let pid: number | null = null;
  installSigtermSelfCancel(process.env, () => pid, (l) => console.log(`[migrate-on-start] ${l}`)); // eslint-disable-line no-console
  const result = await runMigrateOnStart(
    {
      migrationApprovalMode: (process.env.OWNER_LOGIN_CHILD_APPROVAL as 'none' | 'token') ?? 'none',
      upgradeFailurePolicy: (process.env.OWNER_LOGIN_CHILD_POLICY as 'refuse' | 'continue-if-compatible') ?? 'refuse',
    },
    { env: process.env, onSession: (p) => (pid = p) },
  );
  const code = EXIT[result.outcome];
  console.log(`${RESULT_LINE_PREFIX} ${JSON.stringify({ ...result, exitCode: code })}`); // eslint-disable-line no-console
  process.exit(code);
}

// ── Cluster helpers ────────────────────────────────────────────────────────────────────────────────────────────────
function adminBase(): URL {
  const raw = process.env.OWNER_LOGIN_CHECK_ADMIN_URL?.trim();
  if (!raw) throw new Error('OWNER_LOGIN_CHECK_ADMIN_URL is required');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('OWNER_LOGIN_CHECK_ADMIN_URL is not a valid URL');
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Error('OWNER_LOGIN_CHECK_ADMIN_URL must be a loopback disposable cluster. Refusing.');
  return u;
}
const OWNER_PASSWORD = randomBytes(24).toString('hex');
const RUN = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;

function dbUrl(db: string, who: 'admin' | 'owner' | { user: string; password: string; role?: string }): string {
  const u = new URL(adminBase().toString());
  u.pathname = `/${db}`;
  u.search = '';
  if (who === 'owner') {
    u.username = 'crewflow_owner';
    u.password = OWNER_PASSWORD;
  } else if (who !== 'admin') {
    u.username = who.user;
    u.password = encodeURIComponent(who.password);
    if (who.role) u.searchParams.set('options', `-c role=${who.role}`);
  }
  return u.toString();
}

async function withClient<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => undefined);
  }
}
const admin = <T>(db: string, fn: (c: Client) => Promise<T>) => withClient(dbUrl(db, 'admin'), fn);
const rows = async (db: string, sql: string, params: unknown[] = []) => admin(db, async (c) => (await c.query(sql, params)).rows);

async function assertDisposableCluster(): Promise<number> {
  const [r] = await rows('postgres', `SELECT rolsuper, current_setting('crewflow.disposable_cluster', true) AS marker, current_setting('server_version_num')::int AS num FROM pg_roles WHERE rolname = current_user`);
  if (!r?.rolsuper) throw new Error('the admin URL must be a superuser of the disposable cluster');
  if (r.marker !== 'on') throw new Error('the cluster is not marked disposable (crewflow.disposable_cluster = on). Refusing.');
  return Math.floor(Number(r.num) / 10000);
}

/**
 * Runs one of the committed provider-admin SQL files (the file under test). With OWNER_LOGIN_CHECK_CONTAINER (the
 * disposable cluster's container), the REAL psql script runs inside it, the password in a 0600 file written over stdin;
 * otherwise its two statements are extracted and run with the variables substituted (the psql wrapper is then untested).
 */
async function runAdminSql(db: string, sql: string, database: string): Promise<void> {
  const container = process.env.OWNER_LOGIN_CHECK_CONTAINER?.trim();
  if (container) {
    const su = decodeURIComponent(adminBase().username);
    const write = spawnSync('docker', ['exec', '-i', container, 'sh', '-c', 'umask 077; cat > /tmp/owl-owner-pw'], { input: OWNER_PASSWORD, encoding: 'utf8' });
    if (write.status !== 0) throw new Error('could not write the password file in the container');
    const r = spawnSync('docker', ['exec', '-i', container, 'psql', '-X', '-q', '-U', su, '-d', db, '-v', 'owner_password_file=/tmp/owl-owner-pw', '-f', '-'], {
      input: sql,
      encoding: 'utf8',
    });
    spawnSync('docker', ['exec', container, 'rm', '-f', '/tmp/owl-owner-pw']);
    if (r.status !== 0) throw new Error(`the provider-admin psql script failed: ${sanitise(`${r.stdout}${r.stderr}`).slice(0, 400)}`);
    return;
  }
  const statements = sql
    .split('\n')
    .filter((l) => /^(CREATE ROLE|GRANT) /.test(l.trim()))
    .map((l) => l.replace(/:'owner_pw'/g, `'${OWNER_PASSWORD}'`).replace(/:"DBNAME"/g, `"${database.replace(/"/g, '""')}"`).replace(/;\s*$/, ''));
  if (statements.length < 2 || statements.some((t) => /:['"]?[A-Za-z_]+/.test(t.replace(/'[^']*'/g, "''")))) throw new Error('unexpected provider-admin SQL shape');
  await admin(db, async (c) => {
    for (const stmt of statements) await c.query(stmt);
  });
}

async function createEmptyDatabase(db: string): Promise<void> {
  await rows('postgres', `CREATE DATABASE "${db}"`);
}

async function ownerRoleExists(): Promise<boolean> {
  return (await rows('postgres', `SELECT 1 FROM pg_roles WHERE rolname = 'crewflow_owner'`)).length > 0;
}

/** A database prepared by the provider-admin step (the role once per cluster, the grant per database). */
async function providerAdminStep(db: string): Promise<void> {
  await createEmptyDatabase(db);
  if (!(await ownerRoleExists())) await runAdminSql(db, OWNER_SQL, db);
  else await rows(db, `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${db}" TO crewflow_owner WITH GRANT OPTION`);
}

function childEnv(db: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'development', PG_DATABASE_URL: dbUrl(db, 'owner'), ...extra };
  return env;
}

async function inProcess(db: string, config: { approval?: 'none' | 'token'; policy?: 'refuse' | 'continue-if-compatible' } = {}, extra: Record<string, string> = {}, postureCheck?: () => Promise<string[]>): Promise<MigrateOnStartResult> {
  const lines: string[] = [];
  const result = await runMigrateOnStart(
    { migrationApprovalMode: config.approval ?? 'none', upgradeFailurePolicy: config.policy ?? 'refuse' },
    { env: childEnv(db, extra), log: (l) => lines.push(l), postureCheck },
  );
  log(`  ${db}: state=${result.state} outcome=${result.outcome} applied=${result.applied.length} serve=${result.serve}`);
  if (result.outcome !== 'ok') for (const l of lines.slice(-6)) log(`    | ${sanitise(l).slice(0, 300)}`);
  return result;
}

interface ChildHandle {
  done: Promise<{ code: number | null; result: (MigrateOnStartResult & { exitCode: number }) | null; out: string }>;
  kill: (signal: NodeJS.Signals) => void;
  output: () => string;
}
function spawnChild(db: string, extra: Record<string, string> = {}): ChildHandle {
  const tsNode = require.resolve('ts-node/dist/bin.js');
  const p = spawn(process.execPath, [tsNode, '--transpile-only', '-P', join(ROOT, 'packages', 'rab-server', 'tsconfig.app.json'), __filename, '--child'], {
    cwd: ROOT,
    env: childEnv(db, { OWNER_LOGIN_CHILD_APPROVAL: 'none', OWNER_LOGIN_CHILD_POLICY: 'refuse', ...extra }),
  });
  let out = '';
  p.stdout.on('data', (d) => (out += String(d)));
  p.stderr.on('data', (d) => (out += String(d)));
  const done = new Promise<{ code: number | null; result: (MigrateOnStartResult & { exitCode: number }) | null; out: string }>((resolve) => {
    p.on('exit', (code) => {
      const line = out.split('\n').find((l) => l.startsWith(RESULT_LINE_PREFIX));
      resolve({ code, result: line ? JSON.parse(line.slice(RESULT_LINE_PREFIX.length + 1)) : null, out });
    });
  });
  return { done, kill: (signal) => p.kill(signal), output: () => out };
}

const ledgerCount = async (db: string): Promise<number> => {
  // Two statements: a reference to core.migrations is resolved while the statement is planned, even in an untaken branch.
  const [e] = await rows(db, `SELECT to_regclass('core.migrations') IS NOT NULL AS has`);
  if (!e.has) return 0;
  const [r] = await rows(db, `SELECT count(*)::int AS n FROM core.migrations`);
  return Number(r.n);
};
const lockHolders = async (db: string): Promise<number> => {
  const key = BigInt.asUintN(64, MIGRATION_LOCK_KEY);
  const [r] = await rows(
    db,
    `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND classid = $1::oid AND objid = $2::oid AND objsubid = 1`,
    [(key >> 32n).toString(), (key & 0xffffffffn).toString()],
  );
  return Number(r.n);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => Promise<boolean>, timeoutMs: number, label: string): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await cond()) return true;
    await sleep(100);
  }
  log(`  (timed out waiting for ${label})`);
  return false;
}

// ── Catalog snapshot (golden equivalence) ──────────────────────────────────────────────────────────────────────────
const SNAPSHOT_QUERIES: Record<string, string> = {
  schemas: `SELECT nspname, pg_get_userbyid(nspowner) AS owner, nspacl::text AS acl FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' ORDER BY 1`,
  relations: `SELECT n.nspname, c.relname, c.relkind, pg_get_userbyid(c.relowner) AS owner, c.relacl::text AS acl, c.relrowsecurity, c.relforcerowsecurity, c.reloptions::text, c.relpersistence
                FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' ORDER BY 1, 2`,
  columns: `SELECT n.nspname, c.relname, a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS def,
                   a.attidentity, a.attgenerated, a.attcollation::regcollation::text AS coll, a.attacl::text AS acl
              FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
              LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
             WHERE a.attnum > 0 AND NOT a.attisdropped AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' ORDER BY 1, 2, 3`,
  constraints: `SELECT n.nspname, c.relname, k.conname, k.contype, pg_get_constraintdef(k.oid) AS def, k.convalidated, k.condeferrable
                  FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' ORDER BY 1, 2, 3`,
  indexes: `SELECT schemaname, tablename, indexname, indexdef FROM pg_indexes WHERE schemaname !~ '^pg_' AND schemaname <> 'information_schema' ORDER BY 1, 2, 3`,
  policies: `SELECT schemaname, tablename, policyname, permissive, roles::text, cmd, qual, with_check FROM pg_policies ORDER BY 1, 2, 3`,
  functions: `SELECT p.oid::regprocedure::text AS sig, pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig::text, p.proacl::text AS acl, p.provolatile,
                     p.proleakproof, md5(p.prosrc) AS body, pg_get_function_result(p.oid) AS result
                FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
                 AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e') ORDER BY 1`,
  triggers: `SELECT c.oid::regclass::text AS rel, t.tgname, pg_get_triggerdef(t.oid) AS def, t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND n.nspname !~ '^pg_' ORDER BY 1, 2`,
  defaultAcl: `SELECT pg_get_userbyid(defaclrole) AS role, defaclnamespace::regnamespace::text AS nsp, defaclobjtype, defaclacl::text FROM pg_default_acl ORDER BY 1, 2, 3`,
  extensions: `SELECT extname, extversion, extnamespace::regnamespace::text AS nsp, pg_get_userbyid(extowner) AS owner FROM pg_extension ORDER BY 1`,
  sequences: `SELECT schemaname, sequencename, data_type::text, start_value, increment_by, max_value, cycle FROM pg_sequences ORDER BY 1, 2`,
  views: `SELECT schemaname, viewname, md5(definition) AS def FROM pg_views WHERE schemaname !~ '^pg_' AND schemaname <> 'information_schema' ORDER BY 1, 2`,
  comments: `SELECT d.classoid::regclass::text AS cls, pg_describe_object(d.classoid, d.objoid, d.objsubid) AS obj, md5(d.description) AS text FROM pg_description d
              JOIN pg_class c ON d.classoid = 'pg_class'::regclass AND c.oid = d.objoid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'core' ORDER BY 1, 2`,
  types: `SELECT n.nspname, t.typname, t.typtype, pg_get_userbyid(t.typowner) AS owner, t.typacl::text FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND t.typtype IN ('e', 'd', 'c') AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.reltype = t.oid) ORDER BY 1, 2`,
  databaseAcl: `SELECT replace(coalesce(datacl::text, ''), current_database(), '<db>') AS acl FROM pg_database WHERE datname = current_database()`,
  dbSettings: `SELECT coalesce(pg_get_userbyid(setrole), '') AS role, setconfig::text FROM pg_db_role_setting WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database()) ORDER BY 1`,
  ledger: `SELECT timestamp, name FROM core.migrations ORDER BY id`,
};

async function snapshot(db: string): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const [k, sql] of Object.entries(SNAPSHOT_QUERIES)) out[k] = (await rows(db, sql)).map((r) => JSON.stringify(r));
  return out;
}

function diffSnapshots(a: Record<string, string[]>, b: Record<string, string[]>): string[] {
  const out: string[] = [];
  for (const k of Object.keys(SNAPSHOT_QUERIES)) {
    const sa = new Set(a[k]);
    const sb = new Set(b[k]);
    for (const x of a[k] ?? []) if (!sb.has(x)) out.push(`${k} - ${x}`);
    for (const x of b[k] ?? []) if (!sa.has(x)) out.push(`${k} + ${x}`);
  }
  return out;
}

async function goldenDrift(db: string): Promise<string[]> {
  const report = await compareWithGolden(dbUrl(db, 'admin'), GOLDEN);
  return [
    ...report.core.unexpected.map((l) => `+ ${l}`),
    ...report.core.missing.map((l) => `- ${l}`),
    ...report.workspaces.flatMap((d) => [...d.missing.map((l) => `- [${d.schema}] ${l}`), ...d.unexpected.map((l) => `+ [${d.schema}] ${l}`)]),
  ];
}

async function postInstallChecks(db: string, label: string): Promise<void> {
  const drift = await goldenDrift(db);
  check(drift.length === 0, `${label}: security posture matches the golden snapshot exactly`, drift);
  const inv = await admin(db, (c) => secureOwnerInvariantViolations(async (sql) => (await c.query(sql)).rows));
  check(inv.length === 0, `${label}: secure-owner invariants hold`, inv);
  const post = await withClient(dbUrl(db, 'owner'), (c) => deployPostCheckProblems(async (sql, p) => (await c.query(sql, p as unknown[])).rows));
  check(post.length === 0, `${label}: deploy post-checks pass as crewflow_owner`, post);
  const [w] = await rows(db, `SELECT (SELECT count(*)::int FROM pg_auth_members WHERE roleid = 'crewflow_worker'::regrole) AS members,
                                     EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crewflow_rolemaker') AS rolemaker`);
  check(w.members === 0 && w.rolemaker === false, `${label}: crewflow_worker has zero members and no rolemaker remains (B3)`, [JSON.stringify(w)]);
  const deps = (
    await rows(
      db,
      `SELECT pg_describe_object(classid, objid, objsubid) || CASE WHEN deptype = 'o' THEN '' ELSE ' [' || deptype::text || ']' END AS obj FROM pg_shdepend
        WHERE refobjid = 'crewflow_owner'::regrole AND dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) ORDER BY 1`,
    )
  ).map((r) => String(r.obj));
  // The five bootstrap extensions, plus uuid-ossp, which TypeORM's postgres driver creates at DataSource.initialize as the
  // connecting login (entities with uuid generation). All are owner-login-owned by design (the H3 class, M0); nothing else.
  const extOnly = deps.filter((d) => !/^extension (btree_gist|citext|pg_trgm|pgcrypto|unaccent|uuid-ossp)$/.test(d) && !/^database .* \[a\]$/.test(d));
  check(extOnly.length === 0, `${label}: nothing but the extensions (and its database grant) depends on crewflow_owner`, deps);
  const [{ n }] = await rows(db, `SELECT count(*)::int AS n FROM core.migrations`);
  check(Number(n) === MIGRATIONS.length, `${label}: all ${MIGRATIONS.length} migrations in the ledger (${n})`);
}

async function rlsGateAsApp(db: string, label: string): Promise<void> {
  const pw = randomBytes(18).toString('hex');
  await rows('postgres', `ALTER ROLE crewflow_app PASSWORD '${pw}'`);
  try {
    // The child gets the crewflow_app URL it needs and none of the cluster's admin or test secrets.
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: dbUrl(db, { user: 'crewflow_app', password: pw }) };
    for (const k of ['OWNER_LOGIN_CHECK_ADMIN_URL', 'FINGERPRINT_ADMIN_URL', 'MIGRATION_SECURITY_ADMIN_URL', 'PG_DATABASE_URL', 'DATABASE_URL_UNPOOLED',
      'TEST_DATABASE_URL', 'TEST_DATABASE_URL_UNPOOLED', 'TEST_DATABASE_CREWFLOW_URL', 'TEST_DATABASE_WORKER_URL', 'APP_SECRET',
      'CREWFLOW_BOOTSTRAP_PASSWORD', 'CREWFLOW_APP_BOOTSTRAP_PASSWORD', 'CREWFLOW_WORKER_BOOTSTRAP_PASSWORD']) delete env[k];
    const r = spawnSync('yarn', ['check-rls'], { cwd: ROOT, env, encoding: 'utf8', shell: process.platform === 'win32' });
    check(r.status === 0, `${label}: RLS coverage gate passes as crewflow_app`, sanitise(`${r.stdout ?? ''}${r.stderr ?? ''}`).trim().split('\n').slice(-8));
  } finally {
    await rows('postgres', `ALTER ROLE crewflow_app PASSWORD NULL`);
  }
}

// ── Scenarios ──────────────────────────────────────────────────────────────────────────────────────────────────────
async function freshScenario(): Promise<Record<string, string[]>> {
  const db = `owl_fresh_${RUN}`;
  await providerAdminStep(db);
  const r = await inProcess(db);
  check(r.outcome === 'ok' && r.state === 'EMPTY' && r.applied.length === MIGRATIONS.length, `fresh: EMPTY -> ${MIGRATIONS.length} applied by crewflow_owner (bootstrap + chain + shim)`, [JSON.stringify({ ...r, applied: r.applied.length })]);
  const shimmed = await rows(db, `SELECT name FROM core.migrations WHERE name = ANY ($1::text[])`, [[...SHIMMED_MIGRATIONS]]);
  check(shimmed.length === 3, 'fresh: the three ROW_COPY migrations are recorded (through the shim)');
  await postInstallChecks(db, 'fresh');
  await rlsGateAsApp(db, 'fresh');
  // Test C (owner gate): repeated deploy — start, stop, start, start. No duplicate role, schema or ledger row; nothing re-run.
  const facts = async () =>
    (
      await rows(
        db,
        `SELECT (SELECT count(*)::int FROM pg_roles WHERE rolname IN ('rab_owner','rab_app','rab_secure_owner','crewflow','crewflow_app','crewflow_worker','crewflow_owner','crewflow_rolemaker')) AS roles,
                (SELECT count(*)::int FROM pg_namespace WHERE nspname = 'core') AS core,
                (SELECT count(*)::int FROM pg_namespace WHERE nspname ~ '^workspace_') AS workspaces,
                (SELECT count(*)::int FROM core.migrations) AS ledger, (SELECT count(DISTINCT name)::int FROM core.migrations) AS names,
                (SELECT max(id)::int FROM core.migrations) AS maxid`,
      )
    )[0];
  const before = await facts();
  const again = await inProcess(db);
  check(again.outcome === 'ok' && again.state === 'CURRENT' && again.applied.length === 0, 'second boot: CURRENT, nothing applied, exit 0');
  const third = await inProcess(db);
  const after = await facts();
  check(
    third.outcome === 'ok' &&
      third.state === 'CURRENT' &&
      JSON.stringify(after) === JSON.stringify(before) &&
      before.roles === 7 &&
      before.core === 1 &&
      before.ledger === before.names &&
      before.ledger === MIGRATIONS.length,
    'Test C repeated deploy (start, start, start): 7 roles, one core schema, no duplicate or re-run ledger row, nothing changed',
    [JSON.stringify({ before, after })],
  );

  // Golden equivalence: the same lifecycle with the ROW_COPY migrations run by the superuser instead of the shim.
  const ref = `owl_ref_${RUN}`;
  await providerAdminStep(ref);
  process.env.CREWFLOW_BOOTSTRAP_PASSWORD = randomBytes(24).toString('hex');
  process.env.CREWFLOW_APP_BOOTSTRAP_PASSWORD = randomBytes(24).toString('hex');
  await runLockedMigrations({
    label: 'reference',
    env: { ...childEnv(ref), DB_TARGET: 'local' },
    log: () => undefined,
    approvalMode: 'none',
    rowCopyOverride: async (name) => {
      const m = MIGRATIONS.find((x) => x.name === name)!;
      // Plain options (M0 Agent A replay B): the superuser applies exactly this one migration and records it.
      const ds = new DataSource({
        type: 'postgres',
        url: dbUrl(ref, 'admin'),
        name: `ref-${name}`,
        synchronize: false,
        logging: false,
        migrations: MIGRATIONS.filter((x) => x.ts <= m.ts).map((x) => x.path),
        migrationsTableName: 'core.migrations',
        migrationsTransactionMode: 'each',
      } as DataSourceOptions);
      await ds.initialize();
      try {
        const ran = await ds.runMigrations({ transaction: 'each' });
        if (ran.length !== 1 || ran[0]!.name !== name) throw new Error(`reference: expected exactly ${name}, ran ${ran.map((x) => x.name).join(',')}`);
      } finally {
        await ds.destroy();
      }
    },
  });
  delete process.env.CREWFLOW_BOOTSTRAP_PASSWORD;
  delete process.env.CREWFLOW_APP_BOOTSTRAP_PASSWORD;
  const a = await snapshot(db);
  const b = await snapshot(ref);
  const d = diffSnapshots(a, b);
  check(d.length === 0, `GOLDEN EQUIVALENCE: shim-installed and superuser-ROW_COPY databases have identical catalogs (${Object.values(a).reduce((x, y) => x + y.length, 0)} facts) and ledgers`, d);
  const refDrift = await goldenDrift(ref);
  check(refDrift.length === 0, 'reference database matches the golden posture too', refDrift);
  return a;
}

async function lifecycleScenario(freshSnapshot: Record<string, string[]>): Promise<void> {
  // Pending: a database with the chain applied up to just before ArchiveAndSearchSchema, then resumed by the child.
  const cut = 1786719920000;
  const p = `owl_pending_${RUN}`;
  await providerAdminStep(p);
  await runLockedMigrations({
    label: 'partial',
    env: { ...childEnv(p), DB_TARGET: 'local' },
    log: () => undefined,
    approvalMode: 'none',
    dataSourceOverrides: { migrations: MIGRATIONS.filter((m) => m.ts < cut).map((m) => m.path) },
  }).catch((e: Error) => check(false, 'partial build', [e.message]));
  const before = await ledgerCount(p);
  const resumed = await inProcess(p);
  check(
    resumed.outcome === 'ok' && resumed.state === 'CHAIN-PARTIAL' && resumed.applied.length === MIGRATIONS.length - before,
    `pending: CHAIN-PARTIAL resume applied exactly the ${MIGRATIONS.length - before} pending migration(s)`,
    [JSON.stringify({ before, state: resumed.state, applied: resumed.applied.length })],
  );
  check(diffSnapshots(freshSnapshot, await snapshot(p)).length === 0, 'pending: the resumed database equals the fresh install');

  // Kill points (subprocess children), then completion.
  const k = `owl_kill_${RUN}`;
  await providerAdminStep(k);
  const killAt = async (label: string, threshold: number, signal: NodeJS.Signals) => {
    const child = spawnChild(k);
    const reached = await waitFor(async () => (await ledgerCount(k)) >= threshold, 240_000, `ledger >= ${threshold}`);
    child.kill(signal);
    const { code } = await child.done;
    const freed = await waitFor(async () => (await lockHolders(k)) === 0, 15_000, 'lock release');
    check(reached && freed, `kill point ${label}: child killed (${signal}, exit ${code}) at ledger ${await ledgerCount(k)}; the migration lock is free again`);
  };
  await killAt('phase A', 40, 'SIGKILL');
  await killAt('phase B', 140, 'SIGKILL');
  await killAt('phase B (SIGTERM self-cancel)', 175, 'SIGTERM');
  // Inside the transaction=false ArchiveAndSearchSchema: hold a lock it needs, wait until it is blocked, kill it.
  const blocker = new Client({ connectionString: dbUrl(k, 'admin') });
  await blocker.connect();
  try {
    // The lock is taken BEFORE the child starts (the gap between two migrations is milliseconds); the child's own
    // MIGRATION_EVENT lines then prove WHICH migration it is blocked in.
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE core.manager_profile IN ACCESS SHARE MODE');
    const child = spawnChild(k);
    const waiting = await waitFor(
      async () =>
        (await rows(k, `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'crewflow-migrate' AND wait_event_type = 'Lock'`))[0].n > 0,
      240_000,
      'the child blocked on the lock',
    );
    const starts = [...child.output().matchAll(/MIGRATION_EVENT (\{[^\n]*\})/g)].map((m) => JSON.parse(m[1]!) as { event: string; name: string });
    const lastStart = [...starts].reverse().find((e) => e.event === 'start')?.name;
    const blocked = waiting && lastStart === 'ArchiveAndSearchSchema1786719920000';
    if (!blocked) log(`  blocked in ${lastStart ?? '(no MIGRATION_EVENT seen)'}`);
    const ledgerAt = await ledgerCount(k);
    child.kill('SIGKILL');
    await child.done;
    await blocker.query('ROLLBACK');
    const freed = await waitFor(async () => (await lockHolders(k)) === 0, 15_000, 'lock release');
    check(blocked && freed, `kill point inside the transaction=false ArchiveAndSearchSchema1786719920000 (ledger ${ledgerAt}); lock free`);
  } finally {
    await blocker.end().catch(() => undefined);
  }
  const finish = await inProcess(k);
  check(finish.outcome === 'ok' && finish.state === 'CHAIN-PARTIAL', 'after four interruptions the next start completes the chain');
  const killDiff = diffSnapshots(freshSnapshot, await snapshot(k));
  check(killDiff.length === 0, 'the interrupted-then-completed database equals the fresh install', killDiff);
  check((await goldenDrift(k)).length === 0, 'interrupted-then-completed: golden posture');

  // Concurrent: three children on one EMPTY database.
  const c3 = `owl_conc_${RUN}`;
  await providerAdminStep(c3);
  const kids = [spawnChild(c3), spawnChild(c3), spawnChild(c3)];
  const res = await Promise.all(kids.map((x) => x.done));
  const appliedCounts = res.map((x) => x.result?.applied.length ?? -1).sort((x, y) => x - y);
  check(
    res.every((x) => x.code === 0) && JSON.stringify(appliedCounts) === JSON.stringify([0, 0, MIGRATIONS.length]),
    `three concurrent children: all exit 0, exactly one applied the chain (applied ${appliedCounts.join('/')})`,
    res.map((x) => `${x.code} ${x.result?.state} ${x.result?.reason ?? sanitise(x.out.slice(-300))}`),
  );
  check((await ledgerCount(c3)) === MIGRATIONS.length, 'concurrent: complete ledger');

  // Lock timeout on a CURRENT database, then the upgrade-failure policy.
  const f = `owl_fresh_${RUN}`;
  const holder = new Client({ connectionString: dbUrl(f, 'admin') });
  await holder.connect();
  try {
    await holder.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY.toString()]);
    const refuse = await inProcess(f, { policy: 'refuse' }, { CREWFLOW_MIGRATION_LOCK_WAIT_SECONDS: '2' });
    check(refuse.outcome === 'lockTimeout' && !refuse.serve, 'lock timeout (refuse): exit 69, not serving');
    const noPosture = await inProcess(f, { policy: 'continue-if-compatible' }, { CREWFLOW_MIGRATION_LOCK_WAIT_SECONDS: '2' });
    check(
      noPosture.outcome === 'lockTimeout' && !noPosture.serve && noPosture.checks.find((c) => c.name === 'posture')?.ok === false,
      'lock timeout (continue-if-compatible, no posture monitor): fails closed, exit 69',
      noPosture.checks.map((c) => `${c.name} ${c.ok} ${c.detail}`),
    );
    const degraded = await inProcess(f, { policy: 'continue-if-compatible' }, { CREWFLOW_MIGRATION_LOCK_WAIT_SECONDS: '2' }, async () => []);
    check(
      degraded.outcome === 'degradedContinue' && degraded.serve && degraded.checks.every((c) => c.ok),
      'lock timeout (continue-if-compatible, every check passes): exit 70, serving DEGRADED',
      degraded.checks.map((c) => `${c.name} ${c.ok} ${c.detail}`),
    );
  } finally {
    await holder.end().catch(() => undefined);
  }

  // AHEAD (image rollback): a newer ledger name, nothing pending -> warn and serve.
  await rows(f, `INSERT INTO core.migrations("timestamp", name) VALUES (1799999999999, 'FutureRelease1799999999999')`);
  const ahead = await inProcess(f);
  check(ahead.outcome === 'ok' && ahead.state === 'AHEAD', 'AHEAD (rollback): warned, not refused, exit 0 (C-1)');
  await rows(f, `DELETE FROM core.migrations WHERE name = 'FutureRelease1799999999999'`);

  // FOREIGN: someone else's database is refused untouched.
  const foreign = `owl_foreign_${RUN}`;
  await providerAdminStep(foreign);
  await rows(foreign, `CREATE TABLE public.someone_elses (id int)`);
  const fr = await inProcess(foreign);
  const [untouched] = await rows(foreign, `SELECT NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'core') AS ok`);
  check(fr.outcome === 'identity' && fr.state === 'FOREIGN' && untouched.ok === true, 'FOREIGN: refused (exit 67), nothing created');

  // Wrong role shapes, refused before anything changes.
  for (const [label, on, off] of [
    ['BYPASSRLS', 'ALTER ROLE crewflow_owner BYPASSRLS', 'ALTER ROLE crewflow_owner NOBYPASSRLS'],
    ['a reachable predefined role', 'GRANT pg_read_all_data TO crewflow_owner', 'REVOKE pg_read_all_data FROM crewflow_owner'],
    ['a reachable BYPASSRLS role via ADMIN only', 'CREATE ROLE owl_bypass NOLOGIN BYPASSRLS; GRANT owl_bypass TO crewflow_owner WITH ADMIN TRUE, INHERIT FALSE, SET FALSE', 'DROP ROLE owl_bypass'],
  ] as const) {
    for (const s of on.split(';')) await rows('postgres', s);
    try {
      const wr = await inProcess(f);
      check(wr.outcome === 'identity', `wrong role (${label}): refused, exit 67`);
    } finally {
      for (const s of off.split(';')) await rows('postgres', s);
    }
  }
  await rows('postgres', 'ALTER ROLE crewflow_owner SUPERUSER');
  try {
    const sup = await inProcess(f);
    check(sup.outcome === 'identity', 'wrong role (crewflow_owner made SUPERUSER): refused, exit 67');
  } finally {
    await rows('postgres', 'ALTER ROLE crewflow_owner NOSUPERUSER');
  }

  // Test D: a superuser (or any other) login handed to the migrate-on-start child: refused, no legacy fallback.
  const asSuper = await runMigrateOnStart(
    { migrationApprovalMode: 'none', upgradeFailurePolicy: 'refuse' },
    { env: { ...childEnv(f), PG_DATABASE_URL: dbUrl(f, 'admin') }, log: () => undefined },
  );
  check(asSuper.outcome === 'identity', 'wrong identity (a superuser login): the child refuses, exit 67 (no legacy fallback)', [asSuper.reason]);

  // Test D: a partially initialised database (bootstrap committed, chain never started) completes and equals the fresh one.
  const bp = `owl_bpartial_${RUN}`;
  await providerAdminStep(bp);
  await rows(bp, 'CREATE SCHEMA core AUTHORIZATION rab_owner');
  const bpr = await inProcess(bp);
  check(bpr.outcome === 'ok' && bpr.state === 'BOOTSTRAP-PARTIAL' && bpr.applied.length === MIGRATIONS.length, 'BOOTSTRAP-PARTIAL: bootstrap re-run (idempotent) and the whole chain applied');
  const bpDiff = diffSnapshots(freshSnapshot, await snapshot(bp));
  check(bpDiff.length === 0, 'BOOTSTRAP-PARTIAL: the completed database equals the fresh install', bpDiff);

  // Test D: insufficient privileges, refused before anything is created.
  const noRole = `owl_nocreaterole_${RUN}`;
  await providerAdminStep(noRole);
  await rows('postgres', 'ALTER ROLE crewflow_owner NOCREATEROLE');
  try {
    const r = await inProcess(noRole);
    const [u] = await rows(noRole, `SELECT NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'core') AS ok`);
    check(r.outcome === 'identity' && u.ok === true, 'insufficient privileges (NOCREATEROLE on a fresh install): refused, exit 67, nothing created', [r.reason]);
  } finally {
    await rows('postgres', 'ALTER ROLE crewflow_owner CREATEROLE');
  }
  const noGrantOption = `owl_nograntopt_${RUN}`;
  await createEmptyDatabase(noGrantOption);
  await rows(noGrantOption, `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${noGrantOption}" TO crewflow_owner`);
  const ng = await inProcess(noGrantOption);
  const [ngu] = await rows(noGrantOption, `SELECT NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'core') AS ok`);
  check(ng.outcome === 'identity' && ngu.ok === true, 'insufficient privileges (database grant without GRANT OPTION): refused, exit 67, nothing created', [ng.reason]);

  // Test D: an extension installed where the chain cannot use it (outside schema public): refused, nothing created.
  const ext = `owl_ext_${RUN}`;
  await providerAdminStep(ext);
  await rows(ext, 'CREATE SCHEMA extensions');
  await rows(ext, 'CREATE EXTENSION citext WITH SCHEMA extensions');
  const er = await inProcess(ext);
  const [eu] = await rows(ext, `SELECT NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'core') AS ok`);
  check(er.outcome === 'identity' && eu.ok === true, 'extension outside schema public: refused (exit 67), nothing created', [er.state, er.reason]);
}

async function transitionScenario(): Promise<void> {
  const db = `owl_sep_${RUN}`;
  const migratorPw = randomBytes(18).toString('hex');
  // The separated layout, exactly as postgres-init/01-roles.sql + the CI harness prepare it (superuser-created roles).
  for (const s of [
    `CREATE ROLE rab_owner NOLOGIN NOBYPASSRLS`,
    `CREATE ROLE rab_app NOLOGIN NOBYPASSRLS`,
    `CREATE ROLE owl_phasea LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${migratorPw}'`,
    `GRANT rab_owner TO owl_phasea WITH INHERIT FALSE, SET TRUE`,
    `CREATE DATABASE "${db}" OWNER rab_owner`,
  ]) {
    await rows('postgres', s);
  }
  await admin(db, async (c) => {
    await c.query('CREATE SCHEMA IF NOT EXISTS core AUTHORIZATION rab_owner');
    await c.query('GRANT USAGE ON SCHEMA core TO rab_app');
    await c.query('ALTER DEFAULT PRIVILEGES FOR ROLE rab_owner IN SCHEMA core GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rab_app');
    await c.query('ALTER DEFAULT PRIVILEGES FOR ROLE rab_owner IN SCHEMA core GRANT USAGE, SELECT ON SEQUENCES TO rab_app');
    await c.query('ALTER DEFAULT PRIVILEGES FOR ROLE rab_owner IN SCHEMA core GRANT EXECUTE ON FUNCTIONS TO rab_app');
  });
  process.env.CREWFLOW_BOOTSTRAP_PASSWORD = randomBytes(24).toString('hex');
  process.env.CREWFLOW_APP_BOOTSTRAP_PASSWORD = randomBytes(24).toString('hex');
  const legacy = async (url: string, upTo: number) => {
    process.env.DB_TARGET = 'test';
    process.env.DATABASE_URL = url;
    process.env.DATABASE_URL_UNPOOLED = url;
    const ds = new GuardedMigrationDataSource({ ...coreMigrationDataSourceOptions, url, name: `sep-${upTo}`, migrations: MIGRATIONS.filter((m) => m.ts <= upTo).map((m) => m.path), logging: false } as DataSourceOptions);
    await ds.initialize();
    try {
      return (await ds.runMigrations({ transaction: 'each' })).length;
    } finally {
      await ds.destroy();
      delete process.env.DATABASE_URL;
      delete process.env.DATABASE_URL_UNPOOLED;
      delete process.env.DB_TARGET;
    }
  };
  const lastA = Math.max(...MIGRATIONS.filter((m) => m.ts < 1786682000000).map((m) => m.ts));
  const a = await legacy(dbUrl(db, { user: 'owl_phasea', password: migratorPw, role: 'rab_owner' }), lastA);
  const b1 = await legacy(dbUrl(db, 'admin'), 1786721299999);
  await rows('postgres', `CREATE ROLE crewflow_worker LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT`);
  await rows('postgres', `GRANT crewflow_app TO crewflow_worker WITH INHERIT TRUE, SET FALSE`);
  const cutoff = 1786721300000;
  const b2 = await legacy(dbUrl(db, 'admin'), cutoff);
  delete process.env.CREWFLOW_BOOTSTRAP_PASSWORD;
  delete process.env.CREWFLOW_APP_BOOTSTRAP_PASSWORD;
  // Tenant data exists (an existing database is never "fresh").
  await rows(db, `INSERT INTO core.organisation(name, slug) VALUES ('Transition Org', 'owl-transition-${RUN}')`);
  const pendingNames = MIGRATIONS.filter((m) => m.ts > cutoff).map((m) => m.name);
  log(`transition: separated build applied ${a + b1 + b2}; ${pendingNames.length} pending: ${pendingNames.join(', ')}`);

  await runAdminSql(db, TRANSITION_SQL, db);
  const r = await inProcess(db);
  check(
    r.outcome === 'ok' && r.state === 'CHAIN-PARTIAL' && JSON.stringify([...r.applied].sort()) === JSON.stringify([...pendingNames].sort()),
    `transition: the owner login applied ONLY the ${pendingNames.length} pending migration(s) (not fresh: no shim, N1 path)`,
    [JSON.stringify({ state: r.state, outcome: r.outcome, applied: r.applied, reason: r.reason })],
  );
  check(!r.applied.some((n) => SHIMMED_MIGRATIONS.includes(n)) && !r.applied.includes(PRIVILEGED_COPY_MIGRATION), 'transition: no ROW_COPY migration ran');
  const drift = await goldenDrift(db);
  check(drift.length === 0, 'transition: security posture matches the golden snapshot exactly', drift);
  const post = await withClient(dbUrl(db, 'owner'), (c) => deployPostCheckProblems(async (sql, p) => (await c.query(sql, p as unknown[])).rows));
  check(post.length === 0, 'transition: deploy post-checks pass as crewflow_owner', post);
  const again = await inProcess(db);
  check(again.outcome === 'ok' && again.state === 'CURRENT', 'transition: second boot CURRENT');
}

async function unsupportedScenario(major: number): Promise<void> {
  const db = `owl_unsup_${RUN}`;
  await providerAdminStep(db);
  const r = await inProcess(db);
  const [untouched] = await rows(db, `SELECT NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'core') AS ok`);
  check(r.outcome === 'config' && untouched.ok === true, `PostgreSQL ${major}: refused before any change (exit 64), nothing created`, [r.reason]);
}

async function main(): Promise<void> {
  const major = await assertDisposableCluster();
  const scenarios = (process.env.OWNER_LOGIN_CHECK_SCENARIOS ?? 'fresh,lifecycle').split(',').map((s) => s.trim());
  log(`PostgreSQL ${major}; ${MIGRATIONS.length} core migrations; scenarios ${scenarios.join(', ')}; run ${RUN}`);
  if (scenarios.includes('unsupported')) await unsupportedScenario(major);
  if (scenarios.includes('fresh')) {
    const snap = await freshScenario();
    if (scenarios.includes('lifecycle')) await lifecycleScenario(snap);
  }
  if (scenarios.includes('transition')) await transitionScenario();
  if (failures.length) {
    console.error(`[owner-login] ${failures.length} check(s) FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}`); // eslint-disable-line no-console
    process.exit(1);
  }
  log('all checks passed');
}

if (require.main === module) {
  const entry = process.argv.includes('--child') ? childMain() : main();
  entry.catch((error: Error) => {
    console.error(`[owner-login] aborted: ${sanitise(`${error.name}: ${error.message}`)}`); // eslint-disable-line no-console
    process.exit(2);
  });
}
