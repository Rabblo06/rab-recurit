/**
 * Owner decision D4 (2026-11-04): generate, or verify, the expected workspace fingerprints of one PostgreSQL major
 * (workspace-schema/v1/expected-fingerprints-pg<major>.ts) through the EXISTING fingerprint tooling: the in-database
 * core.workspace_schema_fingerprint(uuid) (FROZEN with WorkspaceSchemaMigrationLedger1786719800000), the pre-ledger v14
 * workspace build of the migrator suite, WorkspaceSchemaMigrator (one module version at a time) and the TypeScript
 * provisioner. DISPOSABLE cluster only (loopback, `crewflow.disposable_cluster = on`), never anything else.
 *
 *   FINGERPRINT_ADMIN_URL=<superuser of the disposable cluster> FINGERPRINT_MODE=generate|verify \
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
 * verify    With the committed values: a fresh database built normally (no placeholders); the TypeScript provisioner,
 *           the SERVER path (core.provision_workspace as crewflow_app, its literal baked from the selected table) and a
 *           pre-ledger v14 workspace migrated forward must all produce exactly the committed latest value, and the v14
 *           build must equal the committed v14 value.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import {
  EXPECTED_WORKSPACE_FINGERPRINTS,
  EXPECTED_WORKSPACE_FINGERPRINTS_PG16,
  EXPECTED_WORKSPACE_FINGERPRINTS_PG18,
  selectWorkspaceFingerprintMajor,
} from '../workspace-schema/v1/expected-fingerprints';
import { provisionWorkspaceSchema, WORKSPACE_TABLES } from '../workspace-schema/provision-workspace-schema';
import { pgClientRunner, WorkspaceSchemaMigrator } from '../workspace-schema/workspace-schema-migrator';
import { LATEST_WORKSPACE_MODULE_VERSION, modulesThrough } from '../workspace-schema/workspace-schema-modules';
import { runMigrateOnStart } from './migrate/owner-login/migrate-on-start';

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
  if (major === 16) return EXPECTED_WORKSPACE_FINGERPRINTS_PG16 as Record<number, string>;
  throw new Error(`no fingerprint table for PostgreSQL ${major}`);
}

async function buildDatabase(db: string): Promise<void> {
  await withClient(adminUrl('postgres'), async (c) => {
    await c.query(`CREATE DATABASE "${db}"`);
    const exists = (await c.query(`SELECT 1 FROM pg_roles WHERE rolname = 'crewflow_owner'`)).rows.length > 0;
    if (!exists) {
      const sql = readFileSync(join(ROOT, 'packages', 'rab-docker', 'postgres-init', 'owner-login', '01-crewflow-owner.sql'), 'utf8')
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n')
        .replace(/:'owner_password'/g, `'${OWNER_PASSWORD}'`)
        .replace(/:"database"/g, `"${db}"`);
      for (const s of sql.split(';').map((x) => x.trim()).filter(Boolean)) await c.query(s);
    } else {
      await c.query(`ALTER ROLE crewflow_owner PASSWORD '${OWNER_PASSWORD}'`);
      await c.query(`GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${db}" TO crewflow_owner WITH GRANT OPTION`);
    }
  });
  const result = await runMigrateOnStart(
    { migrationApprovalMode: 'none', upgradeFailurePolicy: 'refuse' },
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
    for (const t of WORKSPACE_TABLES) {
      await c.query(`ALTER TABLE ${ws.schema}.${t} ADD CONSTRAINT ${t}_workspace_bound CHECK (workspace_id IS NOT NULL AND workspace_id = '${ws.id}'::uuid)`);
    }
    await c.query('SELECT core.mark_workspace_schema_ready($1, 1)', [ws.id]);
    await c.query('COMMIT');
  } finally {
    await c.query('RESET ROLE');
  }
}

const fingerprint = async (c: Client, id: string) => (await c.query('SELECT core.workspace_schema_fingerprint($1) AS f', [id])).rows[0].f as string;

async function generate(major: number): Promise<void> {
  const t = table(major);
  if (Object.keys(t).length) throw new Error(`the PostgreSQL ${major} table is not empty; use FINGERPRINT_MODE=verify`);
  Object.assign(t, EXPECTED_WORKSPACE_FINGERPRINTS_PG16); // throwaway build only (see the header)
  const db = `fp_gen_${RUN}`;
  await buildDatabase(db);
  for (const k of Object.keys(t)) delete t[Number(k)];

  const out: Record<number, string> = {};
  await withClient(adminUrl(db), async (c) => {
    const ws = await seedWorkspace(c, `fp-legacy-${RUN}`);
    await legacyV14(c, ws);
    out[14] = await fingerprint(c, ws.id);
    t[14] = out[14]; // the migrator adopts a pre-ledger schema only at a known value
    await c.query('SET ROLE crewflow');
    const migrator = new WorkspaceSchemaMigrator(pgClientRunner(c));
    for (let v = 15; v <= LATEST_WORKSPACE_MODULE_VERSION; v++) {
      const [o] = await migrator.migrateAll({ workspaceIds: [ws.id], throughVersion: v, appVersion: 'fingerprint-generation' });
      if (!o || !['MIGRATED', 'BASELINED'].includes(o.status)) throw new Error(`module ${v}: ${JSON.stringify(o)}`);
      out[v] = await fingerprint(c, ws.id);
      t[v] = out[v];
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
  log(`PostgreSQL ${major} expected fingerprints (generated on ${db}):`);
  for (const [v, f] of Object.entries(out)) log(`  ${v}: '${f}',`);
  for (const [v, f] of Object.entries(out)) log(`  v${v} ${f === EXPECTED_WORKSPACE_FINGERPRINTS_PG16[Number(v)] ? 'EQUALS' : 'differs from'} PostgreSQL 16`);
}

async function verify(major: number): Promise<void> {
  const t = table(major);
  const L = LATEST_WORKSPACE_MODULE_VERSION;
  if (!t[14] || !t[L]) throw new Error(`the PostgreSQL ${major} table has no committed values to verify`);
  const db = `fp_verify_${RUN}`;
  await buildDatabase(db);
  const appPw = randomBytes(18).toString('hex');
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

    const srv = await seedWorkspace(c, `fpv-srv-${RUN}`);
    await c.query(`ALTER ROLE crewflow_app PASSWORD '${appPw}'`);
    try {
      const outcome = await withClient(adminUrl(db, { name: 'crewflow_app', password: appPw }), async (app) => {
        await app.query('BEGIN');
        await app.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true)`, [srv.org, srv.owner]);
        const { rows } = await app.query('SELECT core.provision_workspace($1) AS o', [srv.id]);
        await app.query('COMMIT');
        return rows[0].o as string;
      });
      results.push(`server path ${outcome} ${(await fingerprint(c, srv.id)) === t[L] ? 'OK' : 'MISMATCH'}`);
    } finally {
      await c.query(`ALTER ROLE crewflow_app PASSWORD NULL`);
    }
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
  if (process.env.FINGERPRINT_MODE === 'generate') await generate(major);
  else if (process.env.FINGERPRINT_MODE === 'verify') await verify(major);
  else throw new Error('FINGERPRINT_MODE must be generate or verify');
}

main().catch((e: Error) => {
  console.error(`[fingerprints] FAILED: ${e.message.replace(/postgres(ql)?:\/\/\S+/g, '<url>')}`); // eslint-disable-line no-console
  process.exit(1);
});
