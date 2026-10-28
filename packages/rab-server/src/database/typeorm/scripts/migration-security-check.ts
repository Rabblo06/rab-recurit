/**
 * M2: proves the core migration chain runs under a RESTRICTED (non-superuser) migration identity, and that no migration
 * after Phase 0b silently changes the privilege boundary of the runtime logins. Disposable PostgreSQL only.
 *
 *   MIGRATION_SECURITY_ADMIN_URL=<superuser of a DISPOSABLE loopback cluster> \
 *   CREWFLOW_BOOTSTRAP_PASSWORD=... CREWFLOW_APP_BOOTSTRAP_PASSWORD=... \
 *   ts-node --transpile-only -P packages/rab-server/tsconfig.app.json \
 *     packages/rab-server/src/database/typeorm/scripts/migration-security-check.ts
 *
 * The admin URL is read only from MIGRATION_SECURITY_ADMIN_URL (never DATABASE_URL or .env), must be a loopback host and a
 * superuser of a cluster MARKED disposable (`crewflow.disposable_cluster = on`: a server option on the CI container, a
 * setting of the `postgres` database on a local disposable cluster), and is used for exactly two things: the one-time cluster bootstrap (create the databases the way
 * postgres-init/01-roles.sql does, create the migrator role) and the 30 historical PRIVILEGED_BOOTSTRAP_MIGRATIONS below. The two
 * bootstrap passwords are needed because those historical migrations set them; on a shared disposable cluster pass the
 * values the roles already have, so nothing changes, and set MIGRATION_SECURITY_ALLOW_EXISTING_ROLES=true (without it the
 * harness refuses a cluster where crewflow / crewflow_app already exist). Every other migration runs as MIGRATOR:
 *   LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE, a fresh random password per run (never printed), and only the
 *   memberships the current stage needs: SET-only rab_owner for phase A; rab_secure_owner + crewflow afterwards.
 *
 * Scenarios, each on its own new database:
 *   fresh    empty database -> head. Every privileged migration is first attempted by the restricted migrator and must be
 *            refused with the ledger unchanged; the CF-41 runner must refuse a superuser in phase A, and the migrator
 *            without memberships, crewflow and crewflow_app after the split.
 *   upgrade  the chain before Phase 0b by the historical bootstrap identity (the state existing databases are in), then
 *            Phase 0b by the restricted migrator (down, up again, re-run) and every later migration by the bootstrap superuser.
 * Every migration after Phase 0b runs one at a time with a catalog drift check (migration-privilege-drift.ts). At the end
 * of each scenario: secure-owner invariants, the migrator left nothing behind, the security posture matches the golden
 * snapshot, and the RLS coverage gate passes as crewflow_app.
 *
 * Output: database names, migration names and counts. Never a URL, user name or password.
 * MIGRATION_SECURITY_KEEP_DATABASES=true keeps the databases (marked disposable) so the integration suites can run on them;
 * their names are written to MIGRATION_SECURITY_DB_FILE when that is set.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';
import { DataSourceOptions } from 'typeorm';

import { coreMigrationDataSourceOptions, GuardedMigrationDataSource } from '../core/core.datasource';
import { MigrationIdentityError } from '../core/migration-identity';
import { postMigrationPrivilegeProblems, privilegeDrift, privilegeDriftSnapshot } from '../core/migration-privilege-drift';
import { PHASE_0B_MIGRATION_TIMESTAMP, PRE_PHASE_0B_MIGRATIONS, prePhase0bMigrationFingerprint } from '../core/migration-source-rules';
import { compareWithGolden } from '../core/security-posture';

export const MIGRATOR = 'rab_ci_migrator';
const ROLE_SPLIT_TIMESTAMP = 1786682000000;
const CREWFLOW_APP_ROLE_TIMESTAMP = 1786687000000;

const ROLES = 'role bootstrap: creates roles / sets passwords, or its guard requires SUPERUSER or CREATEROLE';
const HAND_OVER =
  'hands a new core object to rab_secure_owner before Phase 0b: PostgreSQL requires the new owner to hold CREATE on ' +
  'schema core, which only a superuser bypasses (resolved for later migrations by Phase 0b: rab_secure_owner owns core)';
const ROW_COPY = 'copies or backfills rows across tenants under FORCE RLS: needs SUPERUSER or BYPASSRLS (recurs for any such later backfill)';

/**
 * The EXACT set of historical migrations the restricted migrator cannot run, measured by this harness on 2026-10-28 (fresh
 * scenario, one migration at a time). Not modified and not weakened; each runs as the bootstrap identity, after the
 * restricted attempt has been refused with the ledger unchanged. The list must stay exact in both directions: an unlisted
 * migration that needs privilege fails the run, and so does a listed one that no longer does.
 */
export const PRIVILEGED_BOOTSTRAP_MIGRATIONS: Readonly<Record<number, string>> = {
  1786682000000: ROLES, // role split
  1786687000000: ROLES, // crewflow_app
  1786688000000: ROLES,
  1786691000000: ROLES,
  1786693000000: HAND_OVER,
  1786695000000: HAND_OVER,
  1786703000000: HAND_OVER,
  1786704000000: HAND_OVER,
  1786705000000: HAND_OVER,
  1786706000000: HAND_OVER,
  1786707000000: HAND_OVER,
  1786715000000: HAND_OVER,
  1786717400000: HAND_OVER,
  1786717700000: HAND_OVER, // ReconcileCoreOwnershipAndRuntimeGrants re-owns objects to rab_secure_owner
  1786717800000: HAND_OVER,
  1786719520000: ROW_COPY, // HwsHistoricalRowsPrivilegedCopy: own guard requires SUPERUSER or BYPASSRLS
  1786719610000: HAND_OVER,
  1786719620000: HAND_OVER,
  1786719820000: HAND_OVER,
  1786719830000: HAND_OVER,
  1786719900000: HAND_OVER,
  1786719910000: HAND_OVER,
  1786719980000: HAND_OVER,
  1786720010000: HAND_OVER,
  1786720100000: HAND_OVER,
  1786720220000: HAND_OVER,
  1786720230000: HAND_OVER,
  1786720940000: HAND_OVER,
  1786720960000: ROW_COPY, // row_security = off backfill
  1786720990000: ROW_COPY, // row_security = off backfill
};

/**
 * FROZEN residue of the restricted-migrator FRESH install (M2 finding F3, 2026-10-28), accepted until the H3 remediation;
 * any other leftover fails. Existing databases (the upgrade scenario) have none.
 *   F3: ArchiveAndSearchSchema1786719920000 (workspace-schema/v1/search-vectors.ts) creates the unaccent and pg_trgm
 *       extensions, owned by whoever runs it (the superuser on every existing database). Extension ownership is H3.
 * F2 (core.navigation_layout left with the migration login) is FIXED by NavigationLayoutCrewflowOwner1786721110000: the
 * fresh install must now match the golden posture exactly, and lifecycleChecks() proves the cascades work.
 */
export const KNOWN_FRESH_MIGRATOR_LEFTOVERS = ['extension pg_trgm', 'extension unaccent'];
export const KNOWN_FRESH_POSTURE_DELTA: string[] = [];

/** What Phase 0b itself changes in the drift snapshot, exactly: crewflow loses CREATE on core and stops owning it. */
export const PHASE_0B_EXPECTED_DRIFT = [
  '- owner|schema|core|crewflow',
  '- schema-create|core|crewflow|true',
  '+ owner|schema|core|rab_secure_owner',
  '+ schema-create|core|crewflow|false',
];

type Identity = 'phaseA' | 'bootstrap' | 'restricted' | 'crewflow' | 'crewflow_app';

interface MigrationFile {
  ts: number;
  name: string;
  path: string;
}

const MIGRATIONS_DIR = join(__dirname, '..', 'core', 'migrations');
const MIGRATIONS: MigrationFile[] = readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d{13}-[^.]+\.(ts|js)$/.test(f))
  .sort()
  .map((f) => ({ ts: Number(f.slice(0, 13)), name: f.replace(/\.(ts|js)$/, ''), path: join(MIGRATIONS_DIR, f).replace(/\\/g, '/') }));
const GOLDEN = readFileSync(join(__dirname, '..', 'core', 'security-posture.golden.txt'), 'utf8').split('\n').filter(Boolean);

/** Never echo a connection string, whatever a driver or a migration put in an error message. */
const sanitise = (text: string) => text.replace(/postgres(ql)?:\/\/\S+/g, '<url>').replace(/PASSWORD\s+'[^']*'/gi, "PASSWORD '<redacted>'");

const log = (line: string) => console.log(`[m2] ${line}`);

class CheckFailure extends Error {}
const failures: string[] = [];
function check(ok: boolean, label: string, detail: readonly string[] = []): void {
  log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) {
    for (const d of detail.slice(0, 40)) log(`     ${sanitise(d)}`);
    failures.push(label);
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new CheckFailure(`${name} is required`);
  return value;
}

/** Parsed without ever echoing the value: a URL parse error message carries the whole input, password included. */
function parseAdminUrl(): URL {
  let parsed: URL;
  try {
    parsed = new URL(requireEnv('MIGRATION_SECURITY_ADMIN_URL'));
  } catch (e) {
    if (e instanceof CheckFailure) throw e;
    throw new CheckFailure('MIGRATION_SECURITY_ADMIN_URL is not a valid URL');
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new CheckFailure('MIGRATION_SECURITY_ADMIN_URL must be a loopback disposable cluster. Refusing.');
  }
  return parsed;
}
const ADMIN = parseAdminUrl();
const PASSWORDS = {
  crewflow: requireEnv('CREWFLOW_BOOTSTRAP_PASSWORD'),
  crewflow_app: requireEnv('CREWFLOW_APP_BOOTSTRAP_PASSWORD'),
  migrator: randomBytes(24).toString('hex'),
};
/**
 * Discovery mode (local use only): record unlisted migrations that need privilege instead of stopping on them. The run
 * still FAILS when anything is discovered, and the mode is refused under CI.
 */
const DISCOVER = process.env.MIGRATION_SECURITY_DISCOVER === 'true';
if (DISCOVER && process.env.CI) throw new CheckFailure('MIGRATION_SECURITY_DISCOVER is refused under CI');
/**
 * Set only on a cluster that already has crewflow / crewflow_app (a shared disposable test cluster): the role bootstrap
 * migrations then re-set those roles' passwords, so the two bootstrap passwords MUST be the values they already have.
 */
const EXISTING_ROLES_OK = process.env.MIGRATION_SECURITY_ALLOW_EXISTING_ROLES === 'true';
const RUN_ID =`${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;

function url(db: string, identity: Identity | 'admin'): string {
  const u = new URL(ADMIN.toString());
  u.pathname = `/${db}`;
  u.search = '';
  if (identity === 'phaseA' || identity === 'restricted') {
    u.username = MIGRATOR;
    u.password = PASSWORDS.migrator;
    if (identity === 'phaseA') u.searchParams.set('options', '-c role=rab_owner');
  } else if (identity === 'crewflow' || identity === 'crewflow_app') {
    u.username = identity;
    u.password = encodeURIComponent(PASSWORDS[identity]);
  }
  return u.toString();
}

async function withClient<T>(connectionString: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString, connectionTimeoutMillis: 15_000 });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => undefined);
  }
}
const admin = <T>(db: string, fn: (c: Client) => Promise<T>) => withClient(url(db, 'admin'), fn);
const rowsOf = (db: string) => async (sql: string) => admin(db, async (c) => (await c.query(sql)).rows);

/** Membership grants are cluster-wide; every stage sets exactly the set it needs and nothing else. */
async function setMigratorMemberships(stage: 'none' | 'phaseA' | 'restricted'): Promise<void> {
  await admin('postgres', async (c) => {
    const { rows } = await c.query(
      `SELECT pg_get_userbyid(roleid) AS role FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = $1)`,
      [MIGRATOR],
    );
    for (const r of rows) await c.query(`REVOKE "${r.role}" FROM ${MIGRATOR}`);
    if (stage === 'phaseA') await c.query(`GRANT rab_owner TO ${MIGRATOR} WITH INHERIT FALSE, SET TRUE`);
    if (stage === 'restricted') {
      const { rows: present } = await c.query(`SELECT rolname FROM pg_roles WHERE rolname IN ('rab_secure_owner', 'crewflow') ORDER BY 1`);
      for (const r of present) await c.query(`GRANT "${r.rolname}" TO ${MIGRATOR} WITH INHERIT TRUE, SET TRUE`);
    }
  });
}

async function ensureMigratorRole(): Promise<void> {
  await admin('postgres', async (c) => {
    const { rows } = await c.query(
      `SELECT rolsuper, current_setting('crewflow.disposable_cluster', true) AS marker,
              EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('crewflow', 'crewflow_app')) AS roles_exist
         FROM pg_roles WHERE rolname = current_user`,
    );
    if (!rows[0]?.rolsuper) throw new CheckFailure('MIGRATION_SECURITY_ADMIN_URL must be a superuser of the disposable cluster');
    // Loopback is not proof of disposable (a tunnel or port-forward is loopback too). The CI container is started with
    // `-c crewflow.disposable_cluster=on`; a local disposable cluster carries it as a setting of its `postgres` database.
    if (rows[0].marker !== 'on') {
      throw new CheckFailure('the cluster is not marked disposable (crewflow.disposable_cluster = on). Refusing.');
    }
    if (rows[0].roles_exist && !EXISTING_ROLES_OK) {
      throw new CheckFailure(
        'crewflow / crewflow_app already exist on this cluster: the role bootstrap migrations would reset their passwords. ' +
          'Refusing unless MIGRATION_SECURITY_ALLOW_EXISTING_ROLES=true and the bootstrap passwords are their current values.',
      );
    }
    await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${MIGRATOR}') THEN CREATE ROLE ${MIGRATOR}; END IF; END $$`);
    await c.query(`ALTER ROLE ${MIGRATOR} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${PASSWORDS.migrator}'`);
    // A fresh CI cluster has no historical roles yet: create them as 01-roles.sql does, but NOLOGIN and without a password.
    for (const role of ['rab_owner', 'rab_app']) {
      await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN NOBYPASSRLS; END IF; END $$`);
    }
  });
  const attrs = await rowsOf('postgres')(
    `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin FROM pg_roles WHERE rolname = '${MIGRATOR}'`,
  );
  check(
    JSON.stringify(attrs[0]) ===
      JSON.stringify({ rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolcanlogin: true }),
    `migrator role is LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
  );
}

/** A new database prepared exactly like packages/rab-docker/postgres-init/01-roles.sql, marked disposable. */
async function createDatabase(db: string): Promise<void> {
  await admin('postgres', async (c) => {
    await c.query(`CREATE DATABASE "${db}" OWNER rab_owner`);
    await c.query(`ALTER DATABASE "${db}" SET crewflow.disposable_test_database = 'true'`);
  });
  await admin(db, async (c) => {
    await c.query('CREATE SCHEMA IF NOT EXISTS core AUTHORIZATION rab_owner');
    await c.query('GRANT USAGE ON SCHEMA core TO rab_app');
    await c.query('ALTER DEFAULT PRIVILEGES FOR ROLE rab_owner IN SCHEMA core GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rab_app');
    await c.query('ALTER DEFAULT PRIVILEGES FOR ROLE rab_owner IN SCHEMA core GRANT USAGE, SELECT ON SEQUENCES TO rab_app');
    await c.query('ALTER DEFAULT PRIVILEGES FOR ROLE rab_owner IN SCHEMA core GRANT EXECUTE ON FUNCTIONS TO rab_app');
  });
  log(`created ${db}`);
}

async function appliedCount(db: string): Promise<number> {
  return admin(db, async (c) => {
    const { rows } = await c.query(`SELECT to_regclass('core.migrations') IS NOT NULL AS has`);
    if (!rows[0].has) return 0;
    return Number((await c.query('SELECT count(*) AS n FROM core.migrations')).rows[0].n);
  });
}

/** Runs every pending migration with timestamp <= upTo, through the real guarded runner, as `identity`. */
async function migrate(db: string, identity: Identity, upTo: number): Promise<string[]> {
  const connection = url(db, identity);
  process.env.DB_TARGET = 'test';
  process.env.DATABASE_URL = connection;
  process.env.DATABASE_URL_UNPOOLED = connection;
  const ds = new GuardedMigrationDataSource({
    ...coreMigrationDataSourceOptions,
    url: connection,
    name: `m2-${db}-${identity}`,
    migrations: MIGRATIONS.filter((m) => m.ts <= upTo).map((m) => m.path),
    logging: false,
  } as DataSourceOptions);
  await ds.initialize();
  try {
    return (await ds.runMigrations({ transaction: 'each' })).map((m) => m.name);
  } finally {
    await ds.destroy();
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_URL_UNPOOLED;
  }
}

/** Phase 0b revert through the real guarded runner (undoLastMigration requires the bootstrap-capable identity). */
async function revertLast(db: string, identity: Identity, upTo: number): Promise<void> {
  const connection = url(db, identity);
  process.env.DB_TARGET = 'test';
  process.env.DATABASE_URL = connection;
  process.env.DATABASE_URL_UNPOOLED = connection;
  const ds = new GuardedMigrationDataSource({
    ...coreMigrationDataSourceOptions,
    url: connection,
    name: `m2-${db}-${identity}-revert`,
    migrations: MIGRATIONS.filter((m) => m.ts <= upTo).map((m) => m.path),
    logging: false,
  } as DataSourceOptions);
  await ds.initialize();
  try {
    await ds.undoLastMigration({ transaction: 'each' });
  } finally {
    await ds.destroy();
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_URL_UNPOOLED;
  }
}

/**
 * The attempt must fail for the right reason and leave the ledger exactly as it was: 'identity' = the CF-41
 * MigrationIdentityError; 'refusal' = that, or a privilege refusal (a connection or authentication failure never counts).
 */
async function expectRefused(db: string, identity: Identity, upTo: number, label: string, expected: 'identity' | 'refusal'): Promise<void> {
  const before = await appliedCount(db);
  let error: unknown = null;
  try {
    await migrate(db, identity, upTo);
  } catch (e) {
    error = e;
  }
  const after = await appliedCount(db);
  const kindOk =
    error instanceof MigrationIdentityError || (expected === 'refusal' && error instanceof Error && isPrivilegeRefusal(error));
  const how = error ? `${(error as Error).name}: ${sanitise((error as Error).message).slice(0, 90)}` : '';
  check(kindOk && after === before, `${label} is refused, ledger unchanged (${before}) [${how}]`, [
    error ? `${(error as Error).name}: ${sanitise((error as Error).message).slice(0, 300)}` : 'it ran',
    `ledger ${before} -> ${after}`,
  ]);
}

/**
 * Every migration after Phase 0b, one at a time, each followed by the drift check. The fresh scenario runs them as the
 * restricted migrator and the upgrade scenario as the bootstrap superuser, so a migration that branches on the identity
 * (`IF rolsuper THEN ...`) is measured under both.
 */
async function laterMigrationsWithDriftCheck(db: string, identity: 'restricted' | 'bootstrap'): Promise<number> {
  const later = MIGRATIONS.filter((m) => m.ts > PHASE_0B_MIGRATION_TIMESTAMP);
  for (const m of later) {
    const before = await privilegeDriftSnapshot(rowsOf(db));
    const ran = await migrate(db, identity, m.ts);
    const problems = await postMigrationPrivilegeProblems(rowsOf(db), before);
    check(problems.length === 0, `${db}: ${m.name} (${ran.length} applied as ${identity}) changes no runtime privilege`, problems);
  }
  return later.length;
}

async function finalChecks(db: string, scenario: 'fresh' | 'upgrade'): Promise<void> {
  const query = rowsOf(db);
  const absolute = await postMigrationPrivilegeProblems(query, await privilegeDriftSnapshot(query));
  check(absolute.length === 0, `${db}: secure-owner invariants hold and crewflow has no CREATE on core`, absolute);

  // Everything in this database that still depends on the migrator role: owned objects, ACL entries, policy roles.
  const leftovers = (
    await query(
      `SELECT pg_catalog.pg_describe_object(classid, objid, objsubid) || CASE WHEN deptype = 'o' THEN '' ELSE ' [' || deptype::text || ']' END AS obj
         FROM pg_catalog.pg_shdepend
        WHERE refobjid = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATOR}')
          AND dbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())
        ORDER BY 1`,
    )
  ).map((r) => String(r.obj));
  const knownLeftovers = scenario === 'fresh' ? KNOWN_FRESH_MIGRATOR_LEFTOVERS : [];
  check(
    JSON.stringify(leftovers) === JSON.stringify(knownLeftovers),
    `${db}: the migrator leaves nothing behind${knownLeftovers.length ? ` except the frozen F2/F3 residue (${knownLeftovers.join(', ')})` : ''}`,
    leftovers.length ? leftovers : ['(none)'],
  );

  const report = await compareWithGolden(url(db, 'admin'), GOLDEN);
  const coreDrift = [...report.core.unexpected.map((l) => `+ ${l}`), ...report.core.missing.map((l) => `- ${l}`)].sort();
  const wsDrift = report.workspaces.flatMap((d) => [...d.missing.map((l) => `- [${d.schema}] ${l}`), ...d.unexpected.map((l) => `+ [${d.schema}] ${l}`)]);
  const knownDelta = scenario === 'fresh' ? KNOWN_FRESH_POSTURE_DELTA : [];
  check(
    JSON.stringify(coreDrift) === JSON.stringify(knownDelta) && wsDrift.length === 0,
    `${db}: security posture matches the golden snapshot (${report.lines} lines${knownDelta.length ? `, apart from the ${knownDelta.length} frozen F2 lines` : ''})`,
    [...coreDrift, ...wsDrift],
  );

  const repoRoot = join(__dirname, '..', '..', '..', '..', '..', '..');
  await lifecycleChecks(db);

  // The child gets the crewflow_app URL it needs and none of the bootstrap secrets.
  const childEnv: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: url(db, 'crewflow_app') };
  for (const k of ['MIGRATION_SECURITY_ADMIN_URL', 'CREWFLOW_BOOTSTRAP_PASSWORD', 'CREWFLOW_APP_BOOTSTRAP_PASSWORD', 'DATABASE_URL_UNPOOLED',
    'TEST_DATABASE_URL', 'TEST_DATABASE_URL_UNPOOLED', 'TEST_DATABASE_CREWFLOW_URL', 'APP_SECRET']) delete childEnv[k];
  const rls = spawnSync('yarn', ['check-rls'], {
    cwd: repoRoot,
    env: childEnv,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const tail = sanitise(`${rls.stdout ?? ''}${rls.stderr ?? ''}`).trim().split('\n').slice(-8);
  check(rls.status === 0, `${db}: RLS coverage gate passes as crewflow_app`, tail);
}

/**
 * F2 lifecycle: deleting a workspace and deleting a user cascade through core.navigation_layout (the cascade runs as that
 * table's owner), and an organisation hard delete is refused by design (user foreign key / insert-only audit_log), never by
 * navigation_layout.
 * Synthetic rows only, in a transaction that is always rolled back (a savepoint per step).
 */
async function lifecycleChecks(db: string): Promise<void> {
  // The real failure needs the migration login's memberships narrowed (as after a run): with them, a migrator-owned table
  // would still cascade and the check would pass on the defect itself (independent review). Narrow first.
  await setMigratorMemberships('none');
  await admin(db, async (c) => {
    const step = async (sql: string, params: unknown[] = []): Promise<string | null> => {
      await c.query('SAVEPOINT step');
      try {
        await c.query(sql, params);
        await c.query('RELEASE SAVEPOINT step');
        return null;
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT step');
        return (e as Error).message;
      }
    };
    await c.query('BEGIN');
    try {
      const seed = async (tag: string) =>
        (await c.query(
          `WITH o AS (INSERT INTO core.organisation(name, slug) VALUES ($1::text, $1::text) RETURNING id),
                u AS (INSERT INTO core."user"(organisation_id, email, first_name, last_name, status)
                      SELECT id, $1::text || '@m2-lifecycle.invalid', 'M2', 'Lifecycle', 'active' FROM o RETURNING id, organisation_id),
                w AS (INSERT INTO core.manager_workspace(organisation_id, owner_user_id, name, subdomain, status, schema_status)
                      SELECT organisation_id, id, $1::text, $1::text, 'active', 'CREATING' FROM u RETURNING id, organisation_id, owner_user_id)
           INSERT INTO core.navigation_layout(organisation_id, workspace_id, user_id)
           SELECT organisation_id, id, owner_user_id FROM w RETURNING organisation_id AS org, workspace_id AS ws, user_id AS uid`,
          [`m2lc-${tag}-${RUN_ID}`],
        )).rows[0] as { org: string; ws: string; uid: string };
      const layouts = async (org: string) =>
        Number((await c.query('SELECT count(*) AS n FROM core.navigation_layout WHERE organisation_id = $1', [org])).rows[0].n);

      const a = await seed('ws');
      const wsErr = await step('DELETE FROM core.manager_workspace WHERE id = $1', [a.ws]);
      check(wsErr === null && (await layouts(a.org)) === 0, `${db}: deleting a workspace cascades through navigation_layout`, [wsErr ?? '']);

      // A second member of the organisation with only a layout row in the owner's workspace.
      const b = await seed('user');
      const member = (await c.query(
        `INSERT INTO core."user"(organisation_id, email, first_name, last_name, status)
         VALUES ($1, $2, 'M2', 'Member', 'active') RETURNING id`,
        [b.org, `m2lc-member-${RUN_ID}@m2-lifecycle.invalid`],
      )).rows[0].id as string;
      await c.query('INSERT INTO core.navigation_layout(organisation_id, workspace_id, user_id) VALUES ($1, $2, $3)', [b.org, b.ws, member]);
      const userErr = await step('DELETE FROM core."user" WHERE id = $1', [member]);
      const memberLayouts = Number((await c.query('SELECT count(*) AS n FROM core.navigation_layout WHERE user_id = $1', [member])).rows[0].n);
      check(userErr === null && memberLayouts === 0 && (await layouts(b.org)) === 1, `${db}: deleting a user cascades through navigation_layout (and only their rows)`, [userErr ?? '']);

      // Self-test: the same workspace delete must FAIL when the table is left with the (narrowed) migration login, i.e.
      // this check would have caught the original F2 defect.
      await c.query('SAVEPOINT selftest');
      await c.query(`ALTER TABLE core.navigation_layout OWNER TO ${MIGRATOR}`);
      const d = await seed('selftest');
      const defectErr = await step('DELETE FROM core.manager_workspace WHERE id = $1', [d.ws]);
      await c.query('ROLLBACK TO SAVEPOINT selftest');
      check(
        defectErr !== null && /permission denied/.test(defectErr),
        `${db}: self-test - with the table left to the migration login the same delete fails (the check detects F2)`,
        [defectErr ?? 'the delete succeeded'],
      );

      const o = await seed('org');
      const orgErr = await step('DELETE FROM core.organisation WHERE id = $1', [o.org]);
      // By design an organisation is never hard-deleted while it has users (user_organisation_id_fkey is RESTRICT); an
      // empty one is still refused because its cascade would delete insert-only audit_log rows. Never by navigation_layout.
      check(
        orgErr !== null && /user_organisation_id_fkey|audit_log/.test(orgErr) && !/navigation_layout/.test(orgErr),
        `${db}: an organisation hard delete is refused by design (user foreign key / insert-only audit_log), not by navigation_layout`,
        [orgErr ?? 'the delete succeeded'],
      );
    } finally {
      await c.query('ROLLBACK');
    }
  });
}

/** The frozen pre-0b chain and an exact privileged list: both must hold before any database is touched. */
function staticChecks(): void {
  const fp = prePhase0bMigrationFingerprint(MIGRATIONS.map((m) => m.name));
  check(
    fp.count === PRE_PHASE_0B_MIGRATIONS.count && fp.sha256 === PRE_PHASE_0B_MIGRATIONS.sha256,
    `the ${PRE_PHASE_0B_MIGRATIONS.count} migrations up to Phase 0b are exactly the frozen set (none back-dated before it)`,
    [`found ${fp.count} with fingerprint ${fp.sha256}`],
  );
  const inRange = new Set(MIGRATIONS.filter((m) => m.ts >= ROLE_SPLIT_TIMESTAMP && m.ts < PHASE_0B_MIGRATION_TIMESTAMP).map((m) => m.ts));
  const stray = Object.keys(PRIVILEGED_BOOTSTRAP_MIGRATIONS).filter((k) => !inRange.has(Number(k)));
  check(stray.length === 0, `every PRIVILEGED_BOOTSTRAP_MIGRATIONS key names a migration between the role split and Phase 0b`, stray);
}

/** A refusal counts only as a privilege refusal (SQLSTATE 42501) or a migration's own bootstrap guard, not any error. */
function isPrivilegeRefusal(error: Error): boolean {
  const code = (error as { code?: string; driverError?: { code?: string } }).code ?? (error as { driverError?: { code?: string } }).driverError?.code;
  return code === '42501' || /refuses to run|must run as the bootstrap identity/.test(error.message);
}

async function freshScenario(db: string): Promise<void> {
  await createDatabase(db);
  const lastPhaseA = Math.max(...MIGRATIONS.filter((m) => m.ts < ROLE_SPLIT_TIMESTAMP).map((m) => m.ts));
  await setMigratorMemberships('phaseA');
  await expectRefused(db, 'bootstrap', lastPhaseA, 'CF-41: phase A as a superuser', 'identity');
  const [ledger] = await rowsOf(db)(`SELECT to_regclass('core.migrations') IS NULL AS absent`);
  check(ledger.absent === true, `${db}: the refused superuser run left no ledger table behind`);
  const phaseA = await migrate(db, 'phaseA', lastPhaseA);
  check(phaseA.length > 0, `${db}: phase A (${phaseA.length} migrations) ran as rab_owner through the restricted migrator`);

  // From the role split to Phase 0b, one migration at a time: every one is first tried by the restricted migrator. It must
  // succeed exactly when the migration is NOT on the privileged list, so the list stays exact in both directions.
  let restrictedCount = 0;
  const discovered: string[] = [];
  await setMigratorMemberships('restricted');
  for (const m of MIGRATIONS.filter((x) => x.ts >= ROLE_SPLIT_TIMESTAMP && x.ts <= PHASE_0B_MIGRATION_TIMESTAMP)) {
    const reason = PRIVILEGED_BOOTSTRAP_MIGRATIONS[m.ts];
    const before = await appliedCount(db);
    let error: Error | null = null;
    try {
      await migrate(db, 'restricted', m.ts);
    } catch (e) {
      error = e as Error;
    }
    const after = await appliedCount(db);
    if (!error) {
      restrictedCount += 1;
      if (reason) check(false, `${m.name} is listed as privileged but the restricted migrator ran it: remove it from the list`);
      continue;
    }
    if (after !== before) check(false, `${m.name}: the failed restricted attempt changed the ledger (${before} -> ${after})`);
    const why = sanitise(error.message).slice(0, 160);
    if (reason) {
      check(isPrivilegeRefusal(error), `privileged ${m.name} is refused to the restricted migrator (${why})`);
    } else if (DISCOVER) {
      discovered.push(`${m.ts}: ${why}`);
    } else {
      check(false, `${m.name} failed under the restricted migrator and is not on the privileged list`, [why]);
    }
    const ran = await migrate(db, 'bootstrap', m.ts);
    check(ran.length === 1, `${db}: ${m.name} ran as the privileged bootstrap identity`);
    if (m.ts === ROLE_SPLIT_TIMESTAMP) {
      // CF-41 refusals need pending work to refuse: right after the split, every later migration is still pending.
      await setMigratorMemberships('none');
      await expectRefused(db, 'restricted', Number.MAX_SAFE_INTEGER, 'CF-41: the migrator without owner-role memberships', 'refusal');
      await expectRefused(db, 'crewflow', Number.MAX_SAFE_INTEGER, 'CF-41: the ordinary crewflow login', 'identity');
      await setMigratorMemberships('restricted');
    }
    if (m.ts === CREWFLOW_APP_ROLE_TIMESTAMP) {
      // crewflow_app exists only from here on (a fresh cluster cannot even authenticate it earlier).
      await expectRefused(db, 'crewflow_app', Number.MAX_SAFE_INTEGER, 'CF-41: the crewflow_app runtime login', 'refusal');
    }
  }
  log(`${db}: ${restrictedCount} migration(s) between the role split and Phase 0b (inclusive) ran as the restricted migrator`);
  for (const d of discovered) log(`DISCOVERED privileged ${d}`);
  check(discovered.length === 0, `${db}: no unlisted migration needed privilege`, discovered);

  const later = await laterMigrationsWithDriftCheck(db, 'restricted');
  const total = await appliedCount(db);
  check(total === MIGRATIONS.length, `${db}: all ${MIGRATIONS.length} migrations applied (phase A ${phaseA.length}, privileged ${Object.keys(PRIVILEGED_BOOTSTRAP_MIGRATIONS).length}, restricted ${restrictedCount + later})`);
  await finalChecks(db, 'fresh');
}

async function upgradeScenario(db: string): Promise<void> {
  await createDatabase(db);
  const lastPhaseA = Math.max(...MIGRATIONS.filter((m) => m.ts < ROLE_SPLIT_TIMESTAMP).map((m) => m.ts));
  await setMigratorMemberships('phaseA');
  await migrate(db, 'phaseA', lastPhaseA);
  // The state of every existing database: the chain before Phase 0b, run by the historical bootstrap identity.
  const beforePhase0b = await migrate(db, 'bootstrap', PHASE_0B_MIGRATION_TIMESTAMP - 1);
  log(`${db}: ${beforePhase0b.length} migration(s) up to before Phase 0b ran as the historical bootstrap identity`);

  await setMigratorMemberships('restricted');
  const s0 = await privilegeDriftSnapshot(rowsOf(db));
  const up = await migrate(db, 'restricted', PHASE_0B_MIGRATION_TIMESTAMP);
  const s1 = await privilegeDriftSnapshot(rowsOf(db));
  check(up.length === 1, `${db}: Phase 0b applied by the restricted migrator`);
  check(JSON.stringify(privilegeDrift(s0, s1)) === JSON.stringify(PHASE_0B_EXPECTED_DRIFT), `${db}: Phase 0b changes exactly the four expected privilege lines`, privilegeDrift(s0, s1));

  await revertLast(db, 'restricted', PHASE_0B_MIGRATION_TIMESTAMP);
  const s2 = await privilegeDriftSnapshot(rowsOf(db));
  check(privilegeDrift(s0, s2).length === 0, `${db}: Phase 0b down() by the restricted migrator restores the prior privileges exactly`, privilegeDrift(s0, s2));

  const again = await migrate(db, 'restricted', PHASE_0B_MIGRATION_TIMESTAMP);
  const s3 = await privilegeDriftSnapshot(rowsOf(db));
  check(again.length === 1 && privilegeDrift(s1, s3).length === 0, `${db}: Phase 0b up() again gives the same privileges`, privilegeDrift(s1, s3));
  const rerun = await migrate(db, 'restricted', PHASE_0B_MIGRATION_TIMESTAMP);
  check(rerun.length === 0 && privilegeDrift(s1, await privilegeDriftSnapshot(rowsOf(db))).length === 0, `${db}: a re-run applies nothing and changes nothing`);

  const later = await laterMigrationsWithDriftCheck(db, 'bootstrap');
  log(`${db}: ${later} migration(s) after Phase 0b checked one by one as the bootstrap superuser`);
  check((await appliedCount(db)) === MIGRATIONS.length, `${db}: all ${MIGRATIONS.length} migrations applied`);
  await finalChecks(db, 'upgrade');
}

async function main(): Promise<void> {
  const prefix = (process.env.MIGRATION_SECURITY_DB_PREFIX ?? 'm2sec').replace(/[^a-z0-9_]/g, '');
  const fresh = `${prefix}_fresh_${RUN_ID}`;
  const upgrade = `${prefix}_upgrade_${RUN_ID}`;
  log(`${MIGRATIONS.length} core migrations; Phase 0b = ${PHASE_0B_MIGRATION_TIMESTAMP}; ${MIGRATIONS.filter((m) => m.ts > PHASE_0B_MIGRATION_TIMESTAMP).length} after it`);
  // `fresh,upgrade` (default, the migration-security job) or `fresh` alone (ci-server / rls-coverage build their test
  // database through the restricted path this way). Anything else is refused: a typo must not silently run less.
  const scenarios = (process.env.MIGRATION_SECURITY_SCENARIOS ?? 'fresh,upgrade').trim();
  if (!['fresh,upgrade', 'fresh'].includes(scenarios)) throw new CheckFailure(`MIGRATION_SECURITY_SCENARIOS must be "fresh,upgrade" or "fresh"`);
  staticChecks();
  await ensureMigratorRole();
  try {
    await freshScenario(fresh);
    if (scenarios === 'fresh,upgrade') await upgradeScenario(upgrade);
    else log('upgrade scenario not requested (MIGRATION_SECURITY_SCENARIOS=fresh)');
  } finally {
    await setMigratorMemberships('none').catch(() => undefined);
    await admin('postgres', (c) => c.query(`ALTER ROLE ${MIGRATOR} NOLOGIN PASSWORD NULL`)).catch(() => undefined);
    if (process.env.MIGRATION_SECURITY_DB_FILE) writeFileSync(process.env.MIGRATION_SECURITY_DB_FILE, `FRESH_DB=${fresh}\nUPGRADE_DB=${upgrade}\n`);
    if (process.env.MIGRATION_SECURITY_KEEP_DATABASES !== 'true') {
      for (const db of [fresh, upgrade]) await admin('postgres', (c) => c.query(`DROP DATABASE IF EXISTS "${db}"`)).catch(() => undefined);
    }
  }
  if (failures.length) {
    console.error(`[m2] ${failures.length} check(s) FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
  log('all checks passed');
}

main().catch((error: Error) => {
  console.error(`[m2] migration security check aborted: ${sanitise(error.message)}`);
  process.exit(2);
});
