// sql-injection-reviewed-file: SQL definition / check module (database layer). Every interpolation is a code constant of this repository (trigger names); no request or row data reaches these templates.
import { ATTENDANCE_CORRECTION_INSERT_ONLY_TRIGGERS } from '../../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-correction-insert-only';

/**
 * DRAFT — NEW SQL, owner SQL review FIRST (security finding S11). Catalog checks of migration
 * AttendanceCorrectionInsertOnly1786722110000 (core.attendance_correction). The statements themselves are
 * upgrade-commands/0-7/attendance-correction-insert-only.ts (one definition for core and, later, every workspace schema).
 */
const NAMES = ATTENDANCE_CORRECTION_INSERT_ONLY_TRIGGERS.map((g) => `'${g.name}'`).join(', ');

/** One row per guard trigger present on core.attendance_correction (name, enabled flag, tgtype, function). */
export const CORE_CORRECTION_GUARD_STATE_SQL = `SELECT t.tgname::text AS name, t.tgenabled::text AS enabled, t.tgtype::int AS tgtype, t.tgfoid::pg_catalog.regprocedure::text AS fn
  FROM pg_catalog.pg_trigger t
 WHERE t.tgrelid = 'core.attendance_correction'::pg_catalog.regclass AND NOT t.tgisinternal AND t.tgname IN (${NAMES})
 ORDER BY t.tgname`;

/** crewflow_app's privileges on core.attendance_correction: SELECT and INSERT must stay (the grant itself is unchanged here). */
export const CORE_CORRECTION_APP_GRANTS_SQL = `SELECT pg_catalog.has_table_privilege('crewflow_app', 'core.attendance_correction', 'UPDATE') AS can_update,
       pg_catalog.has_table_privilege('crewflow_app', 'core.attendance_correction', 'DELETE') AS can_delete,
       pg_catalog.has_table_privilege('crewflow_app', 'core.attendance_correction', 'INSERT') AS can_insert,
       pg_catalog.has_table_privilege('crewflow_app', 'core.attendance_correction', 'SELECT') AS can_select`;

export interface CorrectionGuardRow {
  name: string;
  enabled: string;
  tgtype: number;
  fn: string;
}
export interface CorrectionAppGrants {
  can_update: boolean;
  can_delete: boolean;
  can_insert: boolean;
  can_select: boolean;
}

/** Problems with the core copy after up() (empty = as expected). Pure. */
export function coreCorrectionGuardProblems(rows: readonly CorrectionGuardRow[], grants: CorrectionAppGrants | undefined): string[] {
  const p: string[] = [];
  for (const want of ATTENDANCE_CORRECTION_INSERT_ONLY_TRIGGERS) {
    const r = rows.find((x) => x.name === want.name);
    if (!r) p.push(`core.attendance_correction: trigger ${want.name} missing`);
    else if (r.enabled !== 'O' || r.tgtype !== want.tgtype || r.fn !== 'core.owner_login_grant_parity_guard()') {
      p.push(`core.attendance_correction: ${r.name} enabled=${r.enabled} tgtype=${r.tgtype} fn=${r.fn} (expected O / ${want.tgtype} / core.owner_login_grant_parity_guard())`);
    }
  }
  if (rows.length !== ATTENDANCE_CORRECTION_INSERT_ONLY_TRIGGERS.length) {
    p.push(`core.attendance_correction: ${rows.length} guard trigger(s), expected ${ATTENDANCE_CORRECTION_INSERT_ONLY_TRIGGERS.length}`);
  }
  if (!grants) p.push('core.attendance_correction: crewflow_app privileges unreadable');
  else if (!grants.can_insert || !grants.can_select) {
    p.push(`core.attendance_correction: crewflow_app lost INSERT=${grants.can_insert} SELECT=${grants.can_select} (must be kept)`);
  }
  return p;
}
