/**
 * Owner decision D4 (2026-11-04): generate, or verify, the expected workspace fingerprints of one PostgreSQL major
 * (workspace-schema/v1/expected-fingerprints-pg<major>.ts) through the EXISTING fingerprint tooling: the in-database
 * core.workspace_schema_fingerprint(uuid) (FROZEN with WorkspaceSchemaMigrationLedger1786719800000), the pre-ledger v14
 * workspace build of the migrator suite, WorkspaceSchemaMigrator (one module version at a time) and the TypeScript
 * provisioner. DISPOSABLE cluster only (loopback, `crewflow.disposable_cluster = on`), never anything else.
 *
 *   FINGERPRINT_ADMIN_URL=<superuser of the disposable cluster> FINGERPRINT_MODE=generate|append|verify|ci [FINGERPRINT_WRITE=true] \
 *   ts-node --transpile-only -P packages/rab-server/tsconfig.app.json packages/rab-server/src/database/typeorm/scripts/generate-workspace-fingerprints.ts
 *
 * generate  1. The provider-admin step and the owner-login child build a fresh database from migrations. The frozen
 *              migrations refuse without an expected value per module version, so for THIS throwaway build only the
 *              selected major's table is pre-filled with the PostgreSQL 16 values (no workspace exists during the chain,
 *              so nothing is compared; they are only baked into this database's provision_workspace literal, which this
 *              mode never calls). The placeholders are removed right after the chain.
 *           2. A pre-ledger v14 workspace (modules 1..14 + the binding CHECKs, as the pre-wave-2 provisioners built it):
 *              its fingerprint is v14. Then the migrator moves it forward ONE version at a time; after each, the
 *              fingerprint of that version (the migrator records it; nothing to compare against yet).
 *           3. Cross-check in the same run: a NEW workspace built by the TypeScript provisioner at the latest module
 *              must equal the latest value from step 2 (it is now in the table, so the provisioner itself compares).
 *           Prints the table to commit.
 * append    "Only missing versions" (fingerprint-append.ts): the same build and regeneration, with every COMMITTED value loaded,
 *           so the migrator and planAppend refuse the run if any committed value no longer regenerates identically; only
 *           the versions absent from the table are appended (printed; written to the source with FINGERPRINT_WRITE=true).
 * verify    With the committed values: a fresh database built normally (no placeholders); the TypeScript provisioner,
 *           the SERVER path (core.provision_workspace as the owner login, its literal baked from the selected table) and a
 *           pre-ledger v14 workspace migrated forward must all produce exactly the committed latest value, and the v14
 *           build must equal the committed v14 value.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import {
  EXPECTED_WORKSPACE_FINGERPRINTS,
  EXPECTED_WORKSPACE_FINGERPRINTS_PG16,
  EXPECTED_WORKSPACE_FINGERPRINTS_PG17,
  EXPECTED_WORKSPACE_FINGERPRINTS_PG18,
  selectWorkspaceFingerprintMajor,
} from '../workspace-schema/v1/expected-fingerprints';
import { appendToTableSource, buildPlaceholders, missingVersions, planAppend } from '../workspace-schema/v1/fingerprint-append';
import { provisionWorkspaceSchema, WORKSPACE_TABLES } from '../workspace-schema/provision-workspace-schema';
import { pgClientRunner, WorkspaceSchemaMigrator } from '../workspace-schema/workspace-schema-migrator';
import { LATEST_WORKSPACE_MODULE_VERSION, modulesThrough } from '../workspace-schema/workspace-schema-modules';
import { runMigrateOnStart } from './migrate/owner-login/migrate-on-start';
import { scramSha256Verifier } from './setup/migrator-role';

const log = (line: string) => console.log(`[fingerprints] ${line}`); // eslint-disable-line no-console
const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const OWNER_PASSWORD = randomBytes(24).toString('hex');
const RUN = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;

function adminUrl(db: string, user?: { name: string; password: string }): string {
  const raw = process.env.FINGERPRINT_ADMIN_URL?.trim();
  if (!raw) throw new Error('FINGERPRINT_ADMIN_URL is required');
  const u = new URL(raw);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Error('FINGERPRINT_ADMIN_URL must be a loopback disposable cluster. Refusing.');
  u.pathname = `/${db}`;
  u.search = '';
  if (user) {
    u.username = user.name;
    u.password = encodeURIComponent(user.password);
  }
  return u.toString();
}

async function withClient<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => undefined);
  }
}

/** The table of the selected major, mutable for the generation build only. */
function table(major: number): Record<number, string> {
  if (major === 18) return EXPECTED_WORKSPACE_FINGERPRINTS_PG18 as Record<number, string>;
  if (major === 17) return EXPECTED_WORKSPACE_FINGERPRINTS_PG17 as Record<number, string>;
  if (major === 16) return EXPECTED_WORKSPACE_FINGERPRINTS_PG16 as Record<number, string>;
  throw new Error(`no fingerprint table for PostgreSQL ${major}`);
}

/** Database names are generated here (`fp_gen_<run>` / `fp_verify_<run>`); anything else is refused before any DDL. */
function assertGeneratedDatabaseName(db: string): string {
  if (!/^fp_(gen|verify)_[a-z0-9]{6,32}$/.test(db)) throw new Error('refusing an unexpected database name');
  return db;
}

/**
 * The owner login's password reaches the server only as a SCRAM-SHA-256 verifier computed here (never the plaintext in
 * SQL text); its shape is checked before it is placed in the utility statement, which cannot take a bound parameter.
 */
function ownerPasswordVerifier(): string {
  const v = scramSha256Verifier(OWNER_PASSWORD);
  if (!/^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(v)) throw new Error('unexpected SCRAM verifier shape');
  return v;
}

async function buildDatabase(db: string): Promise<void> {
  assertGeneratedDatabaseName(db);
  const verifier = ownerPasswordVerifier();
  await withClient(adminUrl('postgres'), async (c) => {
    // sql-injection-reviewed: db is a generated fp_gen_/fp_verify_ name validated by assertGeneratedDatabaseName above
    await c.query(`CREATE DATABASE "${db}"`);
    const exists = (await c.query(`SELECT 1 FROM pg_roles WHERE rolname = 'crewflow_owner'`)).rows.length > 0;
    if (!exists) {
      // The two statements of the committed provider-admin file (its psql wrapper reads a secret file; here the values are
      // substituted directly, exactly as owner-login-lifecycle-check.ts does without a container).
      const statements = readFileSync(join(ROOT, 'packages', 'rab-docker', 'postgres-init', 'owner-login', '01-crewflow-owner.sql'), 'utf8')
        .split('\n')
        .filter((l) => /^(CREATE ROLE|GRANT) /.test(l.trim()))
        .map((l) => l.replace(/:'owner_pw'/g, `'${verifier}'`).replace(/:"DBNAME"/g, `"${db}"`).replace(/;\s*$/, '')); // sql-injection-reviewed: the committed admin SQL with a shape-checked SCRAM verifier and a validated generated database name
      for (const s of statements) await c.query(s);
    } else {
      // sql-injection-reviewed: a shape-checked SCRAM verifier (ownerPasswordVerifier), never the plaintext password
      await c.query(`ALTER ROLE crewflow_owner PASSWORD '${verifier}'`);
      // sql-injection-reviewed: db is a generated fp_gen_/fp_verify_ name validated by assertGeneratedDatabaseName above
      await c.query(`GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${db}" TO crewflow_owner WITH GRANT OPTION`);
    }
  });
  const result = await runMigrateOnStart(
    { migrationApprovalMode: 'none' },
    { env: { PATH: process.env.PATH, NODE_ENV: 'development', PG_DATABASE_URL: adminUrl(db, { name: 'crewflow_owner', password: OWNER_PASSWORD }) }, log: () => undefined },
  );
  if (result.outcome !== 'ok') throw new Error(`the chain build failed: ${result.outcome} ${result.reason}`);
  log(`${db}: chain built (${result.applied.length} migrations, state ${result.state})`);
}

interface Ws {
  id: string;
  org: string;
  owner: string;
  schema: string;
}

async function seedWorkspace(c: Client, label: string): Promise<Ws> {
  const r = await c.query(
    `WITH o AS (INSERT INTO core.organisation(name, slug) VALUES ($1::text, $1::text) RETURNING id),
          u AS (INSERT INTO core."user"(organisation_id, email, first_name, last_name, status)
                SELECT id, $1::text || '@fp.invalid', 'FP', 'Owner', 'active' FROM o RETURNING id, organisation_id)
     INSERT INTO core.manager_workspace(organisation_id, owner_user_id, name, subdomain, status, schema_status)
     SELECT organisation_id, id, $1::text, $1::text, 'active', 'CREATING' FROM u RETURNING id, organisation_id, owner_user_id`,
    [label],
  );
  const row = r.rows[0];
  return { id: row.id, org: row.organisation_id, owner: row.owner_user_id, schema: `workspace_${String(row.id).replace(/-/g, '')}` };
}

/** The pre-ledger v14 build (same steps as the migrator suite's provisionLegacyV14), as crewflow. */
async function legacyV14(c: Client, ws: Ws): Promise<void> {
  await c.query('SET ROLE crewflow');
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('rab.organisation_id', $1, true)`, [ws.org]);
    await c.query('SELECT core.begin_workspace_schema_attempt($1)', [ws.id]);
    await c.query('SELECT core.register_workspace_schema($1)', [ws.id]);
    await c.query('SELECT core.provision_workspace_schema($1)', [ws.id]);
    await c.query('COMMIT');
    await c.query('BEGIN');
    await c.query(`SELECT set_config('rab.organisation_id', $1, true)`, [ws.org]);
    for (const m of modulesThrough(14)) await c.query(m.sql(ws.schema));
    if (!/^workspace_[0-9a-f]{32}$/.test(ws.schema) || ws.schema !== `workspace_${ws.id.replace(/-/g, '')}`) throw new Error('unexpected workspace schema name');
    for (const t of WORKSPACE_TABLES) {
      // sql-injection-reviewed: ws.schema is validated just above (workspace_<32 hex> of this uuid); t is the frozen WORKSPACE_TABLES constant
      await c.query(`ALTER TABLE ${ws.schema}.${t} ADD CONSTRAINT ${t}_workspace_bound CHECK (workspace_id IS NOT NULL AND workspace_id = '${ws.id}'::uuid)`);
    }
    await c.query('SELECT core.mark_workspace_schema_ready($1, 1)', [ws.id]);
    await c.query('COMMIT');
  } finally {
    await c.query('RESET ROLE');
  }
}

const fingerprint = async (c: Client, id: string) => (await c.query('SELECT core.workspace_schema_fingerprint($1) AS f', [id])).rows[0].f as string;

/**
 * Regenerates EVERY version 14..LATEST on one throwaway database. The build loads the committed values plus
 * placeholders for the missing ones (fingerprint-append.ts buildPlaceholders); right after the chain the table holds the
 * committed values only, so for every COMMITTED version the migrator itself compares (BASELINE_MISMATCH /
 * FINGERPRINT_MISMATCH refuses the run — a committed value is never silently replaced), and each MISSING version is
 * recorded as generated. Returns all regenerated values.
 */
async function regenerate(major: number, committed: Readonly<Record<number, string>>): Promise<{ db: string; out: Record<number, string> }> {
  const t = table(major);
  const L = LATEST_WORKSPACE_MODULE_VERSION;
  Object.assign(t, buildPlaceholders(committed, L)); // throwaway build only (see the header)
  const db = `fp_gen_${RUN}`;
  try {
    await buildDatabase(db);
  } finally {
    for (const k of Object.keys(t)) delete t[Number(k)];
    Object.assign(t, committed);
  }

  const out: Record<number, string> = {};
  await withClient(adminUrl(db), async (c) => {
    const ws = await seedWorkspace(c, `fp-legacy-${RUN}`);
    await legacyV14(c, ws);
    out[14] = await fingerprint(c, ws.id);
    if (t[14] === undefined) t[14] = out[14]; // the migrator adopts a pre-ledger schema only at a known value
    await c.query('SET ROLE crewflow');
    const migrator = new WorkspaceSchemaMigrator(pgClientRunner(c));
    for (let v = 15; v <= L; v++) {
      const [o] = await migrator.migrateAll({ workspaceIds: [ws.id], throughVersion: v, appVersion: 'fingerprint-generation' });
      if (!o || !['MIGRATED', 'BASELINED'].includes(o.status)) {
        throw new Error(`module ${v}: ${JSON.stringify(o)} (a committed value that no longer regenerates is refused, never replaced)`);
      }
      out[v] = await fingerprint(c, ws.id);
      if (t[v] === undefined) t[v] = out[v];
    }
    await c.query('RESET ROLE');
    // Cross-check: a fresh TypeScript-provisioned workspace at the latest module equals the forward-migrated one.
    const fresh = await seedWorkspace(c, `fp-ts-${RUN}`);
    await c.query('SET ROLE crewflow');
    const res = await provisionWorkspaceSchema(c, fresh.id);
    await c.query('RESET ROLE');
    const tsFp = await fingerprint(c, fresh.id);
    if (res.outcome !== 'READY' || tsFp !== out[LATEST_WORKSPACE_MODULE_VERSION]) {
      throw new Error(`cross-check failed: TypeScript provisioner ${res.outcome} ${tsFp} vs migrated ${out[LATEST_WORKSPACE_MODULE_VERSION]}`);
    }
    log(`cross-check: the TypeScript provisioner at module ${LATEST_WORKSPACE_MODULE_VERSION} equals the v14 workspace migrated forward`);
  });
  return { db, out };
}

/** Every version, on a major with an EMPTY table (the original D4 run). */
async function generate(major: number): Promise<void> {
  if (Object.keys(table(major)).length) throw new Error(`the PostgreSQL ${major} table is not empty; use FINGERPRINT_MODE=append or verify`);
  const { db, out } = await regenerate(major, {});
  console.log(`FINGERPRINTS_JSON ${JSON.stringify({ major, generatedOn: db, values: out })}`); // eslint-disable-line no-console
  log(`PostgreSQL ${major} expected fingerprints (generated on ${db}):`);
  for (const [v, f] of Object.entries(out)) log(`  ${v}: '${f}',`);
  for (const [v, f] of Object.entries(out)) log(`  v${v} ${f === EXPECTED_WORKSPACE_FINGERPRINTS_PG16[Number(v)] ? 'EQUALS' : 'differs from'} PostgreSQL 16`);
}

const TABLE_FILES: Readonly<Record<number, { file: string; exportName: string }>> = {
  16: { file: 'expected-fingerprints.ts', exportName: 'EXPECTED_WORKSPACE_FINGERPRINTS_PG16' },
  17: { file: 'expected-fingerprints-pg17.ts', exportName: 'EXPECTED_WORKSPACE_FINGERPRINTS_PG17' },
  18: { file: 'expected-fingerprints-pg18.ts', exportName: 'EXPECTED_WORKSPACE_FINGERPRINTS_PG18' },
};

/**
 * "Only missing versions" (PAY-1 module 20 and every later module): regenerates everything (committed versions are
 * compared by the migrator and by planAppend; any difference refuses), appends ONLY the missing versions. Prints
 * FINGERPRINTS_APPEND_JSON; with FINGERPRINT_WRITE=true also appends the lines to the table's source file for review.
 */
async function append(major: number): Promise<Record<number, string>> {
  const committed = { ...table(major) };
  const missing = missingVersions(committed, LATEST_WORKSPACE_MODULE_VERSION);
  if (!missing.length) {
    log(`PostgreSQL ${major}: every module through ${LATEST_WORKSPACE_MODULE_VERSION} already has a committed value; nothing to append`);
    return {};
  }
  log(`PostgreSQL ${major}: generating module version(s) ${missing.join(', ')}; ${Object.keys(committed).length} committed value(s) must regenerate identically`);
  const { db, out } = await regenerate(major, committed);
  const entries = planAppend(committed, out, LATEST_WORKSPACE_MODULE_VERSION);
  console.log(`FINGERPRINTS_APPEND_JSON ${JSON.stringify({ major, generatedOn: db, values: entries })}`); // eslint-disable-line no-console
  for (const [v, f] of Object.entries(entries)) log(`  append ${v}: '${f}',`);
  if (process.env.FINGERPRINT_WRITE === 'true') {
    const target = TABLE_FILES[major];
    if (!target) throw new Error(`no table source file for PostgreSQL ${major}`);
    const path = join(__dirname, '..', 'workspace-schema', 'v1', target.file);
    writeFileSync(path, appendToTableSource(readFileSync(path, 'utf8'), target.exportName, entries, `generated ${new Date().toISOString().slice(0, 10)} on ${db}`));
    log(`appended ${Object.keys(entries).length} line(s) to workspace-schema/v1/${target.file} (review and commit)`);
  }
  return entries;
}

async function verify(major: number): Promise<void> {
  const t = table(major);
  const L = LATEST_WORKSPACE_MODULE_VERSION;
  if (!t[14] || !t[L]) throw new Error(`the PostgreSQL ${major} table has no committed values to verify`);
  const db = `fp_verify_${RUN}`;
  await buildDatabase(db);
  await withClient(adminUrl(db), async (c) => {
    const results: string[] = [];
    const legacy = await seedWorkspace(c, `fpv-legacy-${RUN}`);
    await legacyV14(c, legacy);
    results.push(`v14 build ${(await fingerprint(c, legacy.id)) === t[14] ? 'OK' : 'MISMATCH'}`);
    await c.query('SET ROLE crewflow');
    const [o] = await new WorkspaceSchemaMigrator(pgClientRunner(c)).migrateAll({ workspaceIds: [legacy.id], appVersion: 'fingerprint-verify' });
    await c.query('RESET ROLE');
    results.push(`v14 -> ${L} ${o?.status} ${(await fingerprint(c, legacy.id)) === t[L] ? 'OK' : 'MISMATCH'}`);

    const ts = await seedWorkspace(c, `fpv-ts-${RUN}`);
    await c.query('SET ROLE crewflow');
    const tsRes = await provisionWorkspaceSchema(c, ts.id);
    await c.query('RESET ROLE');
    results.push(`typescript ${tsRes.outcome} ${(await fingerprint(c, ts.id)) === t[L] ? 'OK' : 'MISMATCH'}`);

    // The server path as the RUNTIME login, which is the owner login (owner-login architecture); no other role is unlocked.
    const srv = await seedWorkspace(c, `fpv-srv-${RUN}`);
    const outcome = await withClient(adminUrl(db, { name: 'crewflow_owner', password: OWNER_PASSWORD }), async (owner) => {
      await owner.query('BEGIN');
      await owner.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true)`, [srv.org, srv.owner]);
      const { rows } = await owner.query('SELECT core.provision_workspace($1) AS o', [srv.id]);
      await owner.query('COMMIT');
      return rows[0].o as string;
    });
    results.push(`server path ${outcome} ${(await fingerprint(c, srv.id)) === t[L] ? 'OK' : 'MISMATCH'}`);
    for (const r of results) log(`  ${r}`);
    if (results.some((r) => !/ OK$/.test(r) || /FAILED|REFUSED/.test(r))) throw new Error('verification FAILED');
    log(`PostgreSQL ${major}: every provisioning path produces the committed fingerprints (v14 and v${L})`);
  });
}

async function main(): Promise<void> {
  const [{ num, marker, su }] = await withClient(adminUrl('postgres'), async (c) =>
    (await c.query(`SELECT current_setting('server_version_num') AS num, current_setting('crewflow.disposable_cluster', true) AS marker, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su`)).rows,
  );
  if (marker !== 'on' || !su) throw new Error('not a disposable cluster superuser (crewflow.disposable_cluster = on). Refusing.');
  const major = Math.floor(Number(num) / 10000);
  selectWorkspaceFingerprintMajor(major);
  log(`PostgreSQL ${major} (${num}); latest module ${LATEST_WORKSPACE_MODULE_VERSION}; selected table has ${Object.keys(EXPECTED_WORKSPACE_FINGERPRINTS).filter((k) => EXPECTED_WORKSPACE_FINGERPRINTS[Number(k)]).length} value(s)`);
  const mode = process.env.FINGERPRINT_MODE;
  if (mode === 'generate') await generate(major);
  else if (mode === 'append') await append(major);
  else if (mode === 'verify') await verify(major);
  else if (mode === 'ci') {
    // CI: verify committed values; when versions are missing, generate ONLY those (committed ones must regenerate
    // identically), print them, and FAIL (never a silent pass).
    const missing = missingVersions(table(major), LATEST_WORKSPACE_MODULE_VERSION);
    if (!missing.length) await verify(major);
    else {
      await append(major);
      throw new Error(
        `PostgreSQL ${major}: module version(s) ${missing.join(', ')} have no committed fingerprint: review the FINGERPRINTS_APPEND_JSON line above and commit them`,
      );
    }
  } else throw new Error('FINGERPRINT_MODE must be generate, append, verify or ci');
}

main().catch((e: Error) => {
  console.error(`[fingerprints] FAILED: ${e.message.replace(/postgres(ql)?:\/\/\S+/g, '<url>')}`); // eslint-disable-line no-console
  process.exit(1);
});
