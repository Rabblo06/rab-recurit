// sql-injection-reviewed-file: SQL definition / check module (database layer). Every interpolation is a code constant of this repository (a policy name and md5 constants); no request or row data reaches these templates.
import { ATTENDANCE_POLICY } from '../../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-staff-scope';

/**
 * DRAFT — NEW SQL, owner SQL review FIRST (M4 design §11 LOW finding). Catalog checks of migration
 * AttendanceStaffScopeRls1786722100000 (core.attendance's `attendance_tenant`). The predicate itself is
 * upgrade-commands/0-7/attendance-staff-scope.ts (one definition for core and, later, every workspace schema).
 */

/**
 * The semantic-posture hashes (posture-drift/semantic-posture.ts: md5 of pg_get_expr with runs of whitespace collapsed) of
 * core.attendance's `attendance_tenant` USING and WITH CHECK expressions, with its shape. No row when the policy is missing.
 */
export const CORE_ATTENDANCE_POLICY_SQL = `SELECT pg_catalog.md5(pg_catalog.regexp_replace(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '\\s+', ' ', 'g')) AS using_hash,
       pg_catalog.md5(pg_catalog.regexp_replace(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '\\s+', ' ', 'g')) AS check_hash,
       p.polpermissive AS permissive, p.polcmd::text AS cmd, p.polroles = ARRAY[0]::pg_catalog.oid[] AS to_public
  FROM pg_catalog.pg_policy p
 WHERE p.polrelid = 'core.attendance'::pg_catalog.regclass AND p.polname = '${ATTENDANCE_POLICY}'`;

/** The tenant-only expression as PostgreSQL deparses it (template and core before this change). */
export const ATTENDANCE_TENANT_DEPARSED = '((organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()))';

/** Hash of the tenant-only expression; equal to the semantic goldens' line before this change. */
export const ATTENDANCE_TENANT_HASH = '1548d58f4dea2a4e9fa16034d67e1638';

/** The new core expression as PostgreSQL deparses it (pg_get_expr, whitespace collapsed); its md5 is the hash below. */
export const CORE_ATTENDANCE_SCOPE_DEPARSED =
  "((organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()) AND ((current_setting('rab.actor_type'::text, true) = 'worker'::text) OR (EXISTS ( SELECT 1 FROM core.staff_profile sp WHERE ((sp.id = attendance.staff_profile_id) AND (sp.user_id = core.current_uid()) AND (sp.organisation_id = core.current_org()) AND (sp.workspace_id = core.current_workspace())))) OR (EXISTS ( SELECT 1 FROM core.manager_profile mp WHERE ((mp.user_id = core.current_uid()) AND (mp.organisation_id = core.current_org()) AND (mp.workspace_id = core.current_workspace()) AND (mp.type <> 'venue'::text)))) OR (EXISTS ( SELECT 1 FROM ((core.shift s JOIN core.manager_venue mv ON ((mv.venue_id = s.venue_id))) JOIN core.manager_profile mp ON ((mp.id = mv.manager_profile_id))) WHERE ((s.id = attendance.shift_id) AND (s.organisation_id = core.current_org()) AND (s.workspace_id = core.current_workspace()) AND (mv.organisation_id = core.current_org()) AND (mv.workspace_id = core.current_workspace()) AND (mp.user_id = core.current_uid()) AND (mp.type = 'venue'::text) AND (mp.organisation_id = core.current_org()) AND (mp.workspace_id = core.current_workspace()))))))";

/** Hash of the new core expression (USING = WITH CHECK); pinned by the semantic goldens. */
export const CORE_ATTENDANCE_SCOPE_HASH = '41773011ff0c57fd977cfa1d2c9c9ba9';

/**
 * The two privilege-drift lines migration-security-check.ts reviews for AttendanceStaffScopeRls1786722100000 (its
 * REVIEWED_MIGRATION_DRIFT entry): the core policy before and after, as that harness prints it. Expected output of a check,
 * not a query.
 */
export const CORE_ATTENDANCE_REVIEWED_DRIFT: readonly string[] = Object.freeze([
  `- policy|attendance|${ATTENDANCE_POLICY}|*|permissive=true|roles=public|using=${ATTENDANCE_TENANT_DEPARSED}|check=${ATTENDANCE_TENANT_DEPARSED}`,
  `+ policy|attendance|${ATTENDANCE_POLICY}|*|permissive=true|roles=public|using=${CORE_ATTENDANCE_SCOPE_DEPARSED}|check=${CORE_ATTENDANCE_SCOPE_DEPARSED}`,
]);
