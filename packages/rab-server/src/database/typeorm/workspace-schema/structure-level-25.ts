// sql-injection-reviewed-file: SQL definition module (database layer). Every interpolation is a code constant of this repository (the frozen template, the sentinel schema name, a policy name and md5 constants); no request or row data reaches these templates.
import { composeServerPathTemplateLevel24 } from './structure-level-24';
import { SERVER_PATH_SENTINEL_SCHEMA } from './v1/server-path-template';
import { ATTENDANCE_POLICY, attendanceStaffScopeSql } from '../../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-staff-scope';

/**
 * DRAFT — NEW SQL, owner SQL review FIRST (M4 §11 LOW finding). FROZEN with migration AttendanceStaffScopeRls1786722100000 once
 * approved. Structure level 25 (attendance: a staff-own-or-manager predicate as well as the tenant binding):
 *  - `core.provision_workspace(uuid)`: the guarded v3 body over template(20) + levels 21-24 (structure-level-24.ts) with the
 *    level-25 command's ALTER POLICY appended, recording module_version 25 and checking the declared level-25 v2 fingerprint.
 *    In the provisioning transaction the policy was created by the template a few statements earlier, so the ALTER only
 *    rewrites its two expressions.
 *  - `core.verify_workspace_schema_v1(uuid)`: UNCHANGED (it counts policies, not their expressions): the per-level v2
 *    fingerprint is what proves the new predicate.
 */
export function composeServerPathTemplateLevel25(): string {
  return [composeServerPathTemplateLevel24(), attendanceStaffScopeSql(SERVER_PATH_SENTINEL_SCHEMA)].join(';\n');
}

/**
 * The semantic-posture hashes (posture-drift/semantic-posture.ts: md5 of pg_get_expr with runs of whitespace collapsed) of
 * core.attendance's `attendance_tenant` USING and WITH CHECK expressions, with its shape. No row when the policy is missing.
 */
export const CORE_ATTENDANCE_POLICY_SQL = `SELECT pg_catalog.md5(pg_catalog.regexp_replace(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '\\s+', ' ', 'g')) AS using_hash,
       pg_catalog.md5(pg_catalog.regexp_replace(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '\\s+', ' ', 'g')) AS check_hash,
       p.polpermissive AS permissive, p.polcmd::text AS cmd, p.polroles = ARRAY[0]::pg_catalog.oid[] AS to_public
  FROM pg_catalog.pg_policy p
 WHERE p.polrelid = 'core.attendance'::pg_catalog.regclass AND p.polname = '${ATTENDANCE_POLICY}'`;

/** Hash of the tenant-only expression (template and core before level 25); equal to the semantic goldens' line before. */
export const ATTENDANCE_TENANT_HASH = '1548d58f4dea2a4e9fa16034d67e1638';

/** The level-25 core expression as PostgreSQL deparses it (pg_get_expr, whitespace collapsed); its md5 is the hash below. */
export const CORE_ATTENDANCE_SCOPE_DEPARSED =
  "((organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()) AND ((current_setting('rab.actor_type'::text, true) = 'worker'::text) OR (EXISTS ( SELECT 1 FROM core.staff_profile sp WHERE ((sp.id = attendance.staff_profile_id) AND (sp.user_id = core.current_uid()) AND (sp.organisation_id = core.current_org()) AND (sp.workspace_id = core.current_workspace())))) OR (EXISTS ( SELECT 1 FROM core.manager_profile mp WHERE ((mp.user_id = core.current_uid()) AND (mp.organisation_id = core.current_org()) AND (mp.workspace_id = core.current_workspace()) AND (mp.type <> 'venue'::text)))) OR (EXISTS ( SELECT 1 FROM ((core.shift s JOIN core.manager_venue mv ON ((mv.venue_id = s.venue_id))) JOIN core.manager_profile mp ON ((mp.id = mv.manager_profile_id))) WHERE ((s.id = attendance.shift_id) AND (s.organisation_id = core.current_org()) AND (s.workspace_id = core.current_workspace()) AND (mv.organisation_id = core.current_org()) AND (mv.workspace_id = core.current_workspace()) AND (mp.user_id = core.current_uid()) AND (mp.type = 'venue'::text) AND (mp.organisation_id = core.current_org()) AND (mp.workspace_id = core.current_workspace()))))))";

/** Hash of the level-25 core expression (USING = WITH CHECK); pinned by the semantic goldens. */
export const CORE_ATTENDANCE_SCOPE_HASH = '41773011ff0c57fd977cfa1d2c9c9ba9';

/**
 * down() guard (same rule as levels 21-24), FAIL CLOSED: counts the workspace schemas whose attendance_tenant USING expression
 * is NOT the known tenant-only form, whatever it is instead (the level-25 predicate, a hand-altered one, or the same predicate
 * deparsed differently by a future major). The tenant-only expression names no schema, so no canonicalisation is needed.
 * Catalog only (core.workspace_schema_registry is FORCE RLS: a migrator with no tenant bound would count 0 there).
 */
export const LEVEL_25_WORKSPACES_SQL = `SELECT pg_catalog.count(*)::int AS n
  FROM pg_catalog.pg_policy p
  JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname ~ '^workspace_[0-9a-f]{32}$' AND c.relname = 'attendance' AND p.polname = '${ATTENDANCE_POLICY}'
   AND pg_catalog.md5(pg_catalog.regexp_replace(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '\\s+', ' ', 'g'))
       IS DISTINCT FROM '${ATTENDANCE_TENANT_HASH}'`;

const TENANT_DEPARSED = '((organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()))';

/**
 * The two privilege-drift lines migration-security-check.ts reviews for AttendanceStaffScopeRls1786722100000 (its
 * REVIEWED_MIGRATION_DRIFT entry): the core policy before and after, as that harness prints it. Expected output of a check,
 * not a query; kept here because it quotes the deparsed core.staff_profile / core.shift references, and workspace-schema/**
 * is outside the workspace-table qualification ratchet.
 */
export const CORE_ATTENDANCE_REVIEWED_DRIFT: readonly string[] = Object.freeze([
  `- policy|attendance|${ATTENDANCE_POLICY}|*|permissive=true|roles=public|using=${TENANT_DEPARSED}|check=${TENANT_DEPARSED}`,
  `+ policy|attendance|${ATTENDANCE_POLICY}|*|permissive=true|roles=public|using=${CORE_ATTENDANCE_SCOPE_DEPARSED}|check=${CORE_ATTENDANCE_SCOPE_DEPARSED}`,
]);
