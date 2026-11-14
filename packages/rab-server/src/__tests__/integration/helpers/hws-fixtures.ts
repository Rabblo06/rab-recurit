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
  return resolveHwsRuntimeEnabled(env.HWS_RUNTIME_ENABLED, env.NODE_ENV ?? 'test') === true;
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
