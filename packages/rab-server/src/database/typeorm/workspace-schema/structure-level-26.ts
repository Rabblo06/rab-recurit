// sql-injection-reviewed-file: SQL definition module (database layer). Every interpolation is a code constant of this repository (the frozen template, the sentinel schema name, trigger names); no request or row data reaches these templates.
import { composeServerPathTemplateLevel25 } from './structure-level-25';
import { SERVER_PATH_SENTINEL_SCHEMA } from './v1/server-path-template';
import {
  ATTENDANCE_CORRECTION_INSERT_ONLY_TRIGGERS,
  attendanceCorrectionInsertOnlySql,
} from '../../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-correction-insert-only';

/**
 * DRAFT — NEW SQL, owner SQL review FIRST (security finding S11 / architecture §5.7). FROZEN with migration
 * AttendanceCorrectionInsertOnly1786722110000 once approved. Structure level 26 (attendance_correction insert-only):
 *  - `core.provision_workspace(uuid)`: the guarded v3 body over template(20) + levels 21-25 (structure-level-25.ts) with the
 *    level-26 command's statements appended (REVOKE + three guard triggers), recording module_version 26 and checking the
 *    declared level-26 v2 fingerprint.
 *  - `core.verify_workspace_schema_v1(uuid)`: UNCHANGED (it counts tables, foreign keys, policies, indexes, FORCE and owners,
 *    not triggers or grants): the per-level v2 fingerprint is what proves the triggers and the narrower grant.
 */
export function composeServerPathTemplateLevel26(): string {
  return [composeServerPathTemplateLevel25(), attendanceCorrectionInsertOnlySql(SERVER_PATH_SENTINEL_SCHEMA)].join(';\n');
}

const NAMES = ATTENDANCE_CORRECTION_INSERT_ONLY_TRIGGERS.map((g) => `'${g.name}'`).join(', ');

/**
 * The state of the core copy: one row per guard trigger present (name, enabled flag, tgtype, function), plus whether
 * crewflow_app still holds UPDATE / DELETE. tgtype: BEFORE (2) + statement level (ROW bit 1 clear) + UPDATE 16 / DELETE 8 /
 * TRUNCATE 32 = 18 / 10 / 34.
 */
export const CORE_CORRECTION_GUARD_STATE_SQL = `SELECT t.tgname::text AS name, t.tgenabled::text AS enabled, t.tgtype::int AS tgtype, t.tgfoid::pg_catalog.regprocedure::text AS fn
  FROM pg_catalog.pg_trigger t
 WHERE t.tgrelid = 'core.attendance_correction'::pg_catalog.regclass AND NOT t.tgisinternal AND t.tgname IN (${NAMES})
 ORDER BY t.tgname`;

export const CORE_CORRECTION_APP_GRANTS_SQL = `SELECT pg_catalog.has_table_privilege('crewflow_app', 'core.attendance_correction', 'UPDATE') AS can_update,
       pg_catalog.has_table_privilege('crewflow_app', 'core.attendance_correction', 'DELETE') AS can_delete,
       pg_catalog.has_table_privilege('crewflow_app', 'core.attendance_correction', 'INSERT') AS can_insert,
       pg_catalog.has_table_privilege('crewflow_app', 'core.attendance_correction', 'SELECT') AS can_select`;

export const EXPECTED_CORRECTION_GUARDS: ReadonlyArray<{ name: string; tgtype: number }> = Object.freeze([
  { name: 'attendance_correction_insert_only_delete', tgtype: 10 },
  { name: 'attendance_correction_insert_only_truncate', tgtype: 34 },
  { name: 'attendance_correction_insert_only_update', tgtype: 18 },
]);

/** Problems with the core copy after up() (empty = as expected). */
export function coreCorrectionGuardProblems(
  rows: Array<{ name: string; enabled: string; tgtype: number; fn: string }>,
  grants: { can_update: boolean; can_delete: boolean; can_insert: boolean; can_select: boolean } | undefined,
): string[] {
  const p: string[] = [];
  for (const want of EXPECTED_CORRECTION_GUARDS) {
    const r = rows.find((x) => x.name === want.name);
    if (!r) p.push(`core.attendance_correction: trigger ${want.name} missing`);
    else if (r.enabled !== 'O' || r.tgtype !== want.tgtype || r.fn !== 'core.owner_login_grant_parity_guard()') {
      p.push(`core.attendance_correction: ${r.name} enabled=${r.enabled} tgtype=${r.tgtype} fn=${r.fn} (expected O / ${want.tgtype} / core.owner_login_grant_parity_guard())`);
    }
  }
  if (rows.length !== EXPECTED_CORRECTION_GUARDS.length) p.push(`core.attendance_correction: ${rows.length} guard trigger(s), expected ${EXPECTED_CORRECTION_GUARDS.length}`);
  if (!grants) p.push('core.attendance_correction: crewflow_app privileges unreadable');
  else {
    if (grants.can_update || grants.can_delete) p.push(`core.attendance_correction: crewflow_app still holds UPDATE=${grants.can_update} DELETE=${grants.can_delete}`);
    if (!grants.can_insert || !grants.can_select) p.push(`core.attendance_correction: crewflow_app lost INSERT=${grants.can_insert} SELECT=${grants.can_select} (must be kept)`);
  }
  return p;
}

/**
 * down() guard (same rule as levels 21-25): the workspace schemas whose attendance_correction carries any of the level-26
 * guard triggers (catalog only). down() refuses while any remains.
 */
export const LEVEL_26_WORKSPACES_SQL = `SELECT pg_catalog.count(DISTINCT n.oid)::int AS n
  FROM pg_catalog.pg_trigger t
  JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname ~ '^workspace_[0-9a-f]{32}$' AND c.relname = 'attendance_correction' AND NOT t.tgisinternal AND t.tgname IN (${NAMES})`;
