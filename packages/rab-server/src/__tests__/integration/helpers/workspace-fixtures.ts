import { Client } from 'pg';

import { provisionWorkspaceSchema, WORKSPACE_TABLES } from '../../../database/typeorm/workspace-schema/provision-workspace-schema';
import { modulesThrough } from '../../../database/typeorm/workspace-schema/workspace-schema-modules';

/**
 * Wave 2 lane S2: shared fixtures for the workspace-schema migrator, namespace and constraint suites. Every helper takes
 * the disposable database's bootstrap-superuser client (`admin`) or URLs resolved through resolveIntegrationTestDatabase.
 */
export interface SeededWorkspace {
  id: string;
  org: string;
  owner: string;
  schema: string;
  label: string;
}

/** Organisation + active owner user + a CREATING workspace whose subdomain (and org slug) is `label`. */
export async function seedWorkspace(admin: Client, label: string, opts: { orgSlug?: string } = {}): Promise<SeededWorkspace> {
  const r = await admin.query(
    `WITH o AS (INSERT INTO core.organisation(name, slug) VALUES ($1::text, $2::text) RETURNING id),
          u AS (INSERT INTO core."user"(organisation_id, email, first_name, last_name, status)
                SELECT id, $1::text || '@s2.invalid', 'S2', 'Owner', 'active' FROM o RETURNING id, organisation_id)
     INSERT INTO core.manager_workspace(organisation_id, owner_user_id, name, subdomain, status, schema_status)
     SELECT organisation_id, id, $1::text, $1::text, 'active', 'CREATING' FROM u RETURNING id, organisation_id, owner_user_id`,
    [label, opts.orgSlug ?? label],
  );
  const row = r.rows[0];
  return { id: row.id, org: row.organisation_id, owner: row.owner_user_id, schema: `workspace_${String(row.id).replace(/-/g, '')}`, label };
}

/** Server path: core.provision_workspace as crewflow_app with the server-bound GUCs. Returns the function's outcome. */
export async function provisionServerPath(appUrl: string, ws: SeededWorkspace): Promise<string> {
  const app = new Client({ connectionString: appUrl });
  await app.connect();
  try {
    await app.query('BEGIN');
    await app.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true)`, [ws.org, ws.owner]);
    const { rows } = await app.query('SELECT core.provision_workspace($1) AS o', [ws.id]);
    await app.query('COMMIT');
    return rows[0].o;
  } finally {
    await app.end();
  }
}

/** TypeScript provisioner as crewflow (the Worker reconciler path). */
export async function provisionTypeScript(adminUrl: string, ws: SeededWorkspace): Promise<string> {
  const c = new Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query('SET ROLE crewflow');
    return (await provisionWorkspaceSchema(c, ws.id)).outcome;
  } finally {
    await c.end();
  }
}

/**
 * Reproduces a workspace built BEFORE the ledger existed (the pre-wave-2 provisioners): modules 1..14, the binding
 * CHECKs, READY at schema_version 1 — and no ledger row, module_version 0. Runs as crewflow like the real provisioner.
 */
export async function provisionLegacyV14(adminUrl: string, ws: SeededWorkspace): Promise<void> {
  const c = new Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query('SET ROLE crewflow');
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
      await c.query(
        `ALTER TABLE ${ws.schema}.${t} ADD CONSTRAINT ${t}_workspace_bound CHECK (workspace_id IS NOT NULL AND workspace_id = '${ws.id}'::uuid)`,
      );
    }
    await c.query('SELECT core.mark_workspace_schema_ready($1, 1)', [ws.id]);
    await c.query('COMMIT');
  } catch (error) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await c.end();
  }
}

export async function sqlstateOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ACCEPTED';
  } catch (e) {
    return (e as { code?: string }).code ?? 'NO-CODE';
  }
}

/** Full error facts (SQLSTATE + constraint name) of a refused statement. */
export async function refusalOf(p: Promise<unknown>): Promise<{ code: string; constraint?: string }> {
  try {
    await p;
    return { code: 'ACCEPTED' };
  } catch (e) {
    const err = e as { code?: string; constraint?: string };
    return { code: err.code ?? 'NO-CODE', constraint: err.constraint };
  }
}

/** Registry facts read as superuser (no RLS). */
export async function registryOf(admin: Client, workspaceId: string) {
  const { rows } = await admin.query(
    `SELECT status, schema_version, module_version, expected_fingerprint, observed_fingerprint, drift_status, drift_detail, migration_error
       FROM core.workspace_schema_registry WHERE workspace_id = $1`,
    [workspaceId],
  );
  return rows[0];
}

export async function ledgerOf(admin: Client, workspaceId: string) {
  const { rows } = await admin.query(
    `SELECT module_id, version, status, attempt, error_class, previous_version, target_version
       FROM core.workspace_schema_migration WHERE workspace_id = $1 ORDER BY version, attempt`,
    [workspaceId],
  );
  return rows as Array<{ module_id: string; version: number; status: string; attempt: number; error_class: string | null; previous_version: number; target_version: number }>;
}

/** Drops a schema left by a test (superuser), plus the registry/ledger-free workspace rows are left (harmless). */
export async function dropWorkspaceSchema(admin: Client, schema: string): Promise<void> {
  if (!/^workspace_[0-9a-f]{32}$/.test(schema)) throw new Error('refusing to drop a non-workspace schema');
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
}
