import { resolveHwsRuntimeEnabled } from '../../../engine/core-modules/environment/hws-runtime-default';
import { workspaceSchemaName } from '../../../engine/core-modules/tenant/schema-resolver.service';

/**
 * Part C1 fixture helpers: HWS runtime routing is ON by default outside production, so a business row a suite seeds must land
 * where the application reads it — the workspace's own schema with HWS on, the `core` copy with HWS off (the OFF CI job).
 *
 * Prefer seeding through the tenant context with UNQUALIFIED table names (the product's own routing). Use `businessTable`
 * only where a fixture must write through the superuser fixture connection (adminDataSource, search_path core), e.g. to
 * bypass an RLS WITH CHECK that the product satisfies through a flow the suite does not replay.
 */

/** The 21 workspace business tables (the same set as WORKSPACE_TABLE_NAMES + venue_manager_staff). */
const BUSINESS_TABLES = new Set([
  'attendance', 'attendance_correction', 'job_offer', 'job_role', 'manager_venue', 'payroll_record', 'payroll_run',
  'payroll_run_line', 'payslip', 'payslip_document', 'replacement_request', 'shift', 'shift_assignment', 'shift_report',
  'shift_request_staff', 'shift_staff_review', 'staff_profile', 'user_note', 'venue', 'venue_manager_staff', 'venue_role_rate',
]);

/** The effective mode of THIS test process, by the same rule as the environment class (unset = on outside production). */
export function hwsRuntimeOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveHwsRuntimeEnabled(env.HWS_RUNTIME_ENABLED, { ...env, NODE_ENV: env.NODE_ENV ?? 'test' }) === true;
}

/** The schema that holds `workspaceId`'s business rows in this mode: `workspace_<32 hex>` (HWS on) or `core` (HWS off). */
export function businessSchema(workspaceId: string): string {
  return hwsRuntimeOn() ? workspaceSchemaName(workspaceId) : 'core';
}

/** `"<schema>"."<table>"` for a fixture statement. Only the 21 business tables; the schema name is derived, never input. */
export function businessTable(workspaceId: string, table: string): string {
  if (!BUSINESS_TABLES.has(table)) throw new Error(`businessTable: "${table}" is not a workspace business table`);
  return `"${businessSchema(workspaceId)}"."${table}"`;
}

/** The minimal query surface of the superuser fixture connection (a TypeORM DataSource or EntityManager: rows as an array). */
export interface FixtureQueryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/**
 * For a superuser fixture statement that knows only a row id (not its workspace): the qualified table that holds the row in
 * this mode. HWS off → `core.<table>`. HWS on → the READY workspace schema that contains the id, newest workspace first (the
 * fixture usually just created it); `core.<table>` when no schema has it (a pre-cutover-only row). The schema name comes from
 * the registry and must match the derived `workspace_<32 hex>` form.
 */
export async function businessTableOf(admin: FixtureQueryable, table: string, id: string | null | undefined): Promise<string> {
  if (!BUSINESS_TABLES.has(table)) throw new Error(`businessTableOf: "${table}" is not a workspace business table`);
  if (!hwsRuntimeOn() || !id) return `"core"."${table}"`;
  const schemas = (await admin.query(
    `SELECT schema_name FROM core.workspace_schema_registry WHERE status = 'READY' ORDER BY created_at DESC`,
  )) as Array<{ schema_name: string }>;
  for (const { schema_name: schema } of schemas) {
    if (!/^workspace_[0-9a-f]{32}$/.test(schema)) continue;
    const hit = (await admin.query(`SELECT 1 FROM "${schema}"."${table}" WHERE id = $1`, [id])) as unknown[];
    if (hit.length) return `"${schema}"."${table}"`;
  }
  return `"core"."${table}"`;
}

/** The schema part of a `"<schema>"."<table>"` returned above, re-quoted (for a sibling table in the same workspace). */
export function siblingTable(qualified: string, table: string): string {
  if (!BUSINESS_TABLES.has(table)) throw new Error(`siblingTable: "${table}" is not a workspace business table`);
  const m = /^"(core|workspace_[0-9a-f]{32})"\."[a-z_]+"$/.exec(qualified);
  if (!m) throw new Error('siblingTable: not a qualified business table');
  return `"${m[1]}"."${table}"`;
}

/**
 * Part C1 (C1b): tears down a fixture workspace's schema so the suite can delete the workspace (or its owner) afterwards, or
 * free the catalogue at the end of a suite. The superuser fixture connection only (DROP SCHEMA ... CASCADE, then the
 * registry row, whose RESTRICT foreign key otherwise refuses deleting `core.manager_workspace`). The append-only migration
 * ledger keeps its rows (it has no foreign key to the workspace). The schema name is derived and validated, never input.
 * Never product code: the product has no deprovisioning path yet (C4/C5).
 */
export async function dropFixtureWorkspaceSchema(admin: FixtureQueryable, workspaceId: string): Promise<void> {
  const schema = workspaceSchemaName(workspaceId);
  if (!/^workspace_[0-9a-f]{32}$/.test(schema)) throw new Error('dropFixtureWorkspaceSchema: not a workspace schema name');
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.query(`DELETE FROM core.workspace_schema_registry WHERE workspace_id = $1`, [workspaceId]);
}
