// sql-injection-reviewed-file: SQL definition module (database layer). Every interpolation is a code constant of this repository (the frozen template, the sentinel schema name, policy names and md5 constants); no request or row data reaches these templates.
import { composeServerPathTemplateLevel24 } from './structure-level-24';
import { SERVER_PATH_SENTINEL_SCHEMA } from './v1/server-path-template';
import { ATTENDANCE_TENANT_HASH } from './attendance-staff-scope-sql';
import {
  ATTENDANCE_CORRECTION_POLICY,
  ATTENDANCE_POLICY,
  workspaceAttendanceScopeSql,
} from '../../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-staff-scope';

/**
 * DRAFT — NEW SQL, owner SQL review FIRST (M4 §11 LOW finding, the workspace-schema copies). FROZEN with migration
 * WorkspaceAttendanceStaffScope1786722120000 once approved. Structure level 25:
 *  - `core.provision_workspace(uuid)`: the guarded v3 body over template(20) + levels 21-24 (structure-level-24.ts) with the
 *    level-25 statements appended (ALTER POLICY attendance_tenant and attendance_correction_tenant, the same predicates as the
 *    core copies of AttendanceStaffScopeRls1786722100000 / #305), recording module_version 25 and checking the declared
 *    level-25 v2 fingerprint. In the provisioning transaction both policies were created by the template a few statements
 *    earlier, so the ALTERs only rewrite their expressions.
 *  - `core.verify_workspace_schema_v1(uuid)`: UNCHANGED (it counts policies, not their expressions).
 */
export function composeServerPathTemplateLevel25(): string {
  return [composeServerPathTemplateLevel24(), workspaceAttendanceScopeSql(SERVER_PATH_SENTINEL_SCHEMA)].join(';\n');
}

/**
 * down() guard (same rule as levels 21-24), FAIL CLOSED: counts the workspace schemas whose attendance_tenant OR
 * attendance_correction_tenant USING expression is NOT the known tenant-only form (the tenant-only expression names no
 * schema, so no canonicalisation is needed). Catalog only.
 */
export const LEVEL_25_WORKSPACES_SQL = `SELECT pg_catalog.count(DISTINCT n.oid)::int AS n
  FROM pg_catalog.pg_policy p
  JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname ~ '^workspace_[0-9a-f]{32}$'
   AND ((c.relname = 'attendance' AND p.polname = '${ATTENDANCE_POLICY}')
     OR (c.relname = 'attendance_correction' AND p.polname = '${ATTENDANCE_CORRECTION_POLICY}'))
   AND pg_catalog.md5(pg_catalog.regexp_replace(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '\\s+', ' ', 'g'))
       IS DISTINCT FROM '${ATTENDANCE_TENANT_HASH}'`;
