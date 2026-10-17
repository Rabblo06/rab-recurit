import { Client } from 'pg';

import { WORKSPACE_SCHEMA_V1_TEMPLATE } from './v1/workspace-schema-v1.template';
import { shiftTeamPolicy } from './v1/shift-team-policy';
import { venueManagerStaffAssignmentSql } from './v1/venue-manager-staff-assignment';

/**
 * Reusable provisioner for a physical workspace schema (Hyper Workspace, Workspace Schema Version 1).
 *
 * Runs as `crewflow` (the privileged provisioner credential, `DATABASE_URL_UNPOOLED`) only. Never
 * reachable from a request path, and never callable by the ordinary runtime role (`crewflow_app`).
 *
 * Lifecycle, fail closed:
 *  1. Trusted workspace record is read via `core.worker_resolve_workspace_organisation` (a narrow
 *     SECURITY DEFINER lookup — `crewflow` cannot satisfy `core.manager_workspace`'s own RLS with no
 *     tenant context bound, and there is nothing to bind it from until this resolves). Its
 *     organisation id is the only one used for context.
 *  2. Committed step: core.register_workspace_schema → registry row PROVISIONING (idempotent).
 *  3. Committed step: core.provision_workspace_schema → empty schema `workspace_<uuid without dashes>` owned by rab_owner, USAGE to rab_app.
 *  4. One transaction, row-locked on the registry: apply the V1 template, bind every table to this workspace with a CHECK,
 *     verify the structure against the V1 counts, then core.mark_workspace_schema_ready(ws, 1). Either all of it commits or none of it does,
 *     so a schema can never be both partially built and READY.
 *  5. On any failure the transaction rolls back and the registry is marked FAILED with a SAFE error: a fixed phase label and a SQLSTATE,
 *     never the driver message (which can echo identifiers or values).
 *
 * Retry: a FAILED or PROVISIONING registry row is re-applied from scratch. Because step 4 is one transaction, a failed attempt leaves no
 * objects behind, so a retry cannot create duplicates. A READY row is returned unchanged after a read-only verification.
 */

export const WORKSPACE_SCHEMA_VERSION = 1;

/** Structural counts of Version 1. Verified in the same transaction before READY. Recomputed from the template by the validation run. */
export const V1_EXPECTED = {
  tables: 15,
  foreignKeys: 89,
  indexes: 71,
  // 19 in the template + staff_profile_shift_team_select (1786718100000) + venue_manager_staff: scope replaced by vm_select,
  // vm_update and owner (1786718200000).
  policies: 22,
} as const;

/** The 15 business tables. Every one carries workspace_id (checked against the template). */
export const WORKSPACE_TABLES = [
  'staff_profile', 'user_note', 'venue', 'venue_manager_staff', 'job_role', 'venue_role_rate', 'manager_venue', 'shift',
  'shift_request_staff', 'shift_assignment', 'job_offer', 'replacement_request', 'attendance', 'attendance_correction', 'shift_report',
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class WorkspaceSchemaProvisioningError extends Error {
  constructor(
    readonly safeError: string,
    readonly phase: string,
  ) {
    super(safeError);
    this.name = 'WorkspaceSchemaProvisioningError';
  }
}

export interface ProvisionOptions {
  /**
   * Test seam only. Runs inside the apply transaction after the template and CHECKs exist and before verification and READY.
   * Throwing here must roll everything back. Production callers never pass it.
   */
  afterApply?: (schemaName: string) => Promise<void>;
}

export interface ProvisionResult {
  workspaceId: string;
  schemaName: string;
  outcome: 'READY' | 'ALREADY_READY';
  schemaVersion: number;
}

/** Derives the physical schema name. Same derivation as core.register_workspace_schema / core.provision_workspace_schema. */
export function workspaceSchemaName(workspaceId: string): string {
  if (!UUID_RE.test(workspaceId)) throw new WorkspaceSchemaProvisioningError('workspace id is not a canonical uuid', 'input');
  return 'workspace_' + workspaceId.replace(/-/g, '');
}

export async function provisionWorkspaceSchema(
  client: Client,
  workspaceId: string,
  options: ProvisionOptions = {},
): Promise<ProvisionResult> {
  const schemaName = workspaceSchemaName(workspaceId);

  // core.worker_resolve_workspace_organisation (WorkerResolveWorkspaceOrganisation1786695000000):
  // a raw `SELECT ... FROM core.manager_workspace` here is unsatisfiable by `crewflow` with no
  // tenant context bound — and there is nothing to bind it FROM until this very query returns the
  // organisation id. A narrow SECURITY DEFINER function breaks that chicken-and-egg problem the
  // same way the other two worker-discovery functions do; this function's own signature and every
  // existing caller of it are unchanged.
  const ws = await client.query<{ worker_resolve_workspace_organisation: string | null }>(
    'SELECT core.worker_resolve_workspace_organisation($1) AS worker_resolve_workspace_organisation',
    [workspaceId],
  );
  const organisationId = ws.rows[0]?.worker_resolve_workspace_organisation;
  if (!organisationId) throw new WorkspaceSchemaProvisioningError('workspace not found', 'input');

  // Committed step: attempt start, registry row and empty schema. Every lifecycle change goes through a database function
  // (core.begin_workspace_schema_attempt, core.register_workspace_schema, core.provision_workspace_schema). No direct UPDATE of
  // lifecycle columns happens in this file.
  await client.query('BEGIN');
  try {
    await client.query('SELECT set_config($1, $2, true)', ['rab.organisation_id', organisationId]);
    await client.query('SELECT core.begin_workspace_schema_attempt($1)', [workspaceId]);
    await client.query('SELECT core.register_workspace_schema($1)', [workspaceId]);
    const created = await client.query<{ name: string }>('SELECT core.provision_workspace_schema($1) AS name', [workspaceId]);
    if (created.rows[0]?.name !== schemaName) throw new WorkspaceSchemaProvisioningError('derived schema name mismatch', 'register');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    const safe = toSafe(error, 'register');
    await recordFailure(client, organisationId, workspaceId, safe);
    throw safe;
  }

  // Apply transaction. The registry row lock serialises concurrent provisioners for the same workspace.
  await client.query('BEGIN');
  try {
    await client.query('SELECT set_config($1, $2, true)', ['rab.organisation_id', organisationId]);
    const reg = await client.query<{ status: string }>(
      'SELECT status FROM core.workspace_schema_registry WHERE workspace_id = $1 FOR UPDATE',
      [workspaceId],
    );
    if (reg.rows.length !== 1) throw new WorkspaceSchemaProvisioningError('registry row missing', 'lock');
    const statusBefore = reg.rows[0]!.status;

    if (statusBefore === 'READY') {
      await verifyStructure(client, schemaName, workspaceId);
      await client.query('COMMIT');
      return { workspaceId, schemaName, outcome: 'ALREADY_READY', schemaVersion: WORKSPACE_SCHEMA_VERSION };
    }
    if (statusBefore !== 'PROVISIONING' && statusBefore !== 'FAILED') {
      throw new WorkspaceSchemaProvisioningError('registry status is not provisionable', 'lock');
    }

    const existing = await client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1',
      [schemaName],
    );
    if (existing.rows[0]!.n !== 0) throw new WorkspaceSchemaProvisioningError('schema is not empty; refusing to apply', 'precheck');

    await applyTemplate(client, schemaName);
    await bindWorkspace(client, schemaName, workspaceId);
    if (options.afterApply) await options.afterApply(schemaName);
    await verifyStructure(client, schemaName, workspaceId);

    // One call moves the registry and manager_workspace to READY together.
    await client.query('SELECT core.mark_workspace_schema_ready($1, $2)', [workspaceId, WORKSPACE_SCHEMA_VERSION]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    const safe = toSafe(error, 'apply');
    await recordFailure(client, organisationId, workspaceId, safe);
    throw safe;
  }

  return { workspaceId, schemaName, outcome: 'READY', schemaVersion: WORKSPACE_SCHEMA_VERSION };
}

async function applyTemplate(client: Client, schemaName: string): Promise<void> {
  // The schema name is derived from a validated uuid and matches ^workspace_[0-9a-f]{32}$, so it is safe to inline unquoted.
  const sql = WORKSPACE_SCHEMA_V1_TEMPLATE.split('__WS__').join(schemaName);
  await client.query(sql);
  await client.query(shiftTeamPolicy(schemaName));
  await client.query(venueManagerStaffAssignmentSql(schemaName));
}

/**
 * workspace_id IS NOT NULL is part of the CHECK on purpose. A bare `workspace_id = X` passes for NULL, and 13 of the 15 V1 tables still
 * allow NULL workspace_id (legacy shared-core nullability). RLS rejects NULL today, but the schema binding must not depend on RLS alone.
 */
async function bindWorkspace(client: Client, schemaName: string, workspaceId: string): Promise<void> {
  for (const table of WORKSPACE_TABLES) {
    await client.query(
      `ALTER TABLE ${schemaName}.${table} ADD CONSTRAINT ${table}_workspace_bound CHECK (workspace_id IS NOT NULL AND workspace_id = '${workspaceId}'::uuid)`,
    );
  }
}

async function verifyStructure(client: Client, schemaName: string, workspaceId: string): Promise<void> {
  const count = async (sql: string): Promise<number> => (await client.query<{ n: number }>(sql, [schemaName])).rows[0]!.n;
  const fail = (what: string): never => {
    throw new WorkspaceSchemaProvisioningError(`verification failed: ${what}`, 'verify');
  };

  const tables = await client.query<{ n: number; forced: number }>(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE c.relrowsecurity AND c.relforcerowsecurity)::int AS forced
       FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = $1 AND c.relkind = 'r'`,
    [schemaName],
  );
  if (tables.rows[0]!.n !== V1_EXPECTED.tables) fail('table count');
  if (tables.rows[0]!.forced !== V1_EXPECTED.tables) fail('FORCE RLS');
  if (await count(`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = $1`) !== V1_EXPECTED.indexes) fail('index count');
  if (await count(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = $1`) !== V1_EXPECTED.policies) fail('policy count');
  if (await count(`SELECT count(*)::int AS n FROM pg_constraint k JOIN pg_namespace ns ON ns.oid = k.connamespace
                    WHERE ns.nspname = $1 AND k.contype = 'f'`) !== V1_EXPECTED.foreignKeys) fail('foreign key count');
  if (await count(`SELECT count(*)::int AS n FROM pg_constraint k JOIN pg_namespace ns ON ns.oid = k.connamespace
                    WHERE ns.nspname = $1 AND k.contype = 'c' AND k.conname LIKE '%\\_workspace\\_bound'`) !== WORKSPACE_TABLES.length) fail('workspace CHECK count');
  const bound = await client.query<{ def: string }>(
    `SELECT pg_get_constraintdef(k.oid) AS def FROM pg_constraint k JOIN pg_namespace ns ON ns.oid = k.connamespace
      WHERE ns.nspname = $1 AND k.contype = 'c' AND k.conname LIKE '%\\_workspace\\_bound'`,
    [schemaName],
  );
  if (bound.rows.some((r) => !r.def.includes(`'${workspaceId}'::uuid`) || !r.def.includes('workspace_id IS NOT NULL'))) {
    fail('workspace CHECK value or NULL exclusion');
  }
  const owner = await client.query<{ o: string }>(
    'SELECT pg_get_userbyid(nspowner) AS o FROM pg_namespace WHERE nspname = $1',
    [schemaName],
  );
  // P1C.2: core.provision_workspace_schema creates new schemas AUTHORIZATION rab_secure_owner, not
  // rab_owner — rab_owner is retired (NOLOGIN, zero grants). See docs/P1-MASTER-EXECUTION-STATUS.md's
  // P1C.2 entry. This check was stale after that migration and would have failed every NEW workspace
  // provisioned since, even though the actual schema (correctly) came back owned by rab_secure_owner.
  if (owner.rows[0]?.o !== 'rab_secure_owner') fail('schema owner');
  const nn = await client.query<{ nn: boolean }>(
    `SELECT a.attnotnull AS nn FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = $1 AND c.relname = 'user_note' AND a.attname = 'workspace_id'`,
    [schemaName],
  );
  if (nn.rows[0]?.nn !== true) fail('user_note workspace_id NOT NULL');
}

/**
 * Records a failed attempt through core.mark_workspace_schema_failed, which updates the registry and manager_workspace together and is
 * idempotent (FAILED -> FAILED). If recording itself fails, the workspace keeps the non-routable CREATING state written by
 * core.begin_workspace_schema_attempt, so it still fails closed. The original safe error is what the caller receives.
 */
async function recordFailure(
  client: Client,
  organisationId: string,
  workspaceId: string,
  safe: WorkspaceSchemaProvisioningError,
): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query('SELECT set_config($1, $2, true)', ['rab.organisation_id', organisationId]);
    await client.query('SELECT core.mark_workspace_schema_failed($1, $2)', [workspaceId, safe.safeError]);
    await client.query('COMMIT');
  } catch {
    await client.query('ROLLBACK');
  }
}

/** Maps any error to a safe, fixed message. The driver message is never stored or returned. */
function toSafe(error: unknown, phase: string): WorkspaceSchemaProvisioningError {
  if (error instanceof WorkspaceSchemaProvisioningError) return error;
  const code = (error as { code?: string })?.code ?? 'no-sqlstate';
  return new WorkspaceSchemaProvisioningError(`V1 provisioning failed at ${phase} (SQLSTATE ${code})`, phase);
}
