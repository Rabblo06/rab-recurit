import { attendanceMoneyChecksSql } from './attendance-money-checks';
import { SERVER_PATH_SENTINEL_SCHEMA } from './server-path-template';
import { composeServerPathTemplateV1PayrollRestrict } from './server-path-template-payroll-restrict';

/**
 * FROZEN with migration AttendanceMoneyChecks1786719810000 (never edited after merge). The composition
 * `core.provision_workspace(uuid)` embeds from that migration on: the 1786719700000 composition, unchanged and in the same
 * order, followed by workspace module 15 (`attendanceMoneyChecksSql`). Structural counts are unchanged (two CHECKs that
 * are not `_workspace_bound`), so `core.verify_workspace_schema_v1` still holds.
 *
 * Drift guard: `workspace-schema-modules.spec.ts` asserts that the module list (and therefore the TypeScript provisioner's
 * `WORKSPACE_TEMPLATE_STEPS`) composes to exactly this text for the sentinel schema.
 */
export function composeServerPathTemplateV1AttendanceMoney(): string {
  return [composeServerPathTemplateV1PayrollRestrict(), attendanceMoneyChecksSql(SERVER_PATH_SENTINEL_SCHEMA)].join(';\n');
}
