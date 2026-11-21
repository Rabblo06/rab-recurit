import type { WorkspaceUpgradeCommand } from '../workspace-upgrade-command';

/**
 * Release 0.7.0, workspace structure level 26 (security finding S11 / architecture §5.7, owner decision 2026-11-21: "make
 * attendance_correction insert-only in the database"). DRAFT — NEW SQL, owner SQL review FIRST; never edited after merge once
 * approved. Depends on level 25 (AttendanceStaffScope), #243, #177 and #175.
 *
 * The gap: a correction row is itself audit evidence (architecture §11: "original values are never overwritten in place"),
 * but in every workspace schema the runtime could UPDATE or DELETE it:
 *   - the runtime login crewflow_owner inherits the table owner crewflow, so grants never bound it (owner-login BC-01/BC-13);
 *   - crewflow_app (the schema role the parity guards reproduce) still held UPDATE and DELETE, a grant copied into the
 *     template (THREAT-MODEL "copied-grant drift ... attendance_correction UPDATE/DELETE", open since 1786720020000);
 *   - the policy attendance_correction_tenant is FOR ALL, so RLS admitted both for any tenant row.
 * Nothing in the application updates or deletes a correction (AttendanceService inserts one row per changed field).
 *
 * What it does, for one workspace schema:
 *   1. `REVOKE UPDATE, DELETE ON <schema>.attendance_correction FROM crewflow_app` (the template grant drift closed; the core
 *      copy is revoked by the migration);
 *   2. three statement-level BEFORE triggers, UPDATE / DELETE / TRUNCATE, calling the existing owner-login guard
 *      core.owner_login_grant_parity_guard() (OwnerLoginGrantParityGuards1786721420000, unchanged). It refuses the runtime
 *      login with 42501 per STATEMENT (even one RLS leaves with no row), and lets through only crewflow, rab_secure_owner and
 *      superusers: definers, the workspace migrator (SET LOCAL ROLE crewflow) and foreign-key actions, which run as the table
 *      owner. So an `organisation` / `attendance` CASCADE behaves exactly as before (retention unchanged: this is not a new
 *      business rule), while no statement of the runtime can change or remove a correction.
 *   Trigger names do not match `_%_grant_parity_%` on purpose: those are the frozen PAY-1 set counted by its own checks.
 *   - Idempotent: REVOKE of a privilege not held is a no-op; each trigger is created only when the table has no trigger of
 *     that name (a trigger of that name with another definition is left alone and the post-step fingerprint check refuses
 *     the workspace: fail closed). Additive only (no DROP), so `mayDrop` is not declared.
 *   - Lock: SHARE ROW EXCLUSIVE on this workspace's attendance_correction for the catalog change only (no scan).
 * The same statements on `core.attendance_correction` (the HWS-off copy) and in core.provision_workspace (new workspaces)
 * are in migration AttendanceCorrectionInsertOnly1786722110000. Twenty has no equivalent: a Crewflow addition.
 */
export const ATTENDANCE_CORRECTION_INSERT_ONLY_TIMESTAMP = 1786722110000;

export const ATTENDANCE_CORRECTION_GUARD_FUNCTION = 'core.owner_login_grant_parity_guard';

/** The three guard triggers, in a fixed order. */
export const ATTENDANCE_CORRECTION_INSERT_ONLY_TRIGGERS = [
  { name: 'attendance_correction_insert_only_update', event: 'UPDATE' },
  { name: 'attendance_correction_insert_only_delete', event: 'DELETE' },
  { name: 'attendance_correction_insert_only_truncate', event: 'TRUNCATE' },
] as const;

function checkedSchema(schema: string): string {
  if (schema !== 'core' && !/^workspace_[0-9a-f]{32}$/.test(schema)) throw new Error('Invalid workspace schema');
  return schema;
}

/** The statements for one schema ('core' or a validated workspace schema). */
export function attendanceCorrectionInsertOnlySql(schema: string): string {
  const s = checkedSchema(schema);
  const t = `"${s}".attendance_correction`;
  // sql-injection-reviewed: s is 'core' or a regex-validated `workspace_<32 hex>` name; trigger names, events and the function are constants.
  const creates = ATTENDANCE_CORRECTION_INSERT_ONLY_TRIGGERS.map(
    (g) => `  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = '${t}'::pg_catalog.regclass AND t.tgname = '${g.name}') THEN
    CREATE TRIGGER ${g.name} BEFORE ${g.event} ON ${t} FOR EACH STATEMENT EXECUTE FUNCTION ${ATTENDANCE_CORRECTION_GUARD_FUNCTION}();
  END IF;`,
  ).join('\n');
  return `REVOKE UPDATE, DELETE ON ${t} FROM crewflow_app;
DO $correction_insert_only$
BEGIN
${creates}
END
$correction_insert_only$`;
}

/** down() only (core): the triggers dropped and the copied grant restored (the state before this migration). */
export function attendanceCorrectionInsertOnlyDownSql(schema: string): string {
  const s = checkedSchema(schema);
  const t = `"${s}".attendance_correction`;
  // sql-injection-reviewed: as above.
  return [...ATTENDANCE_CORRECTION_INSERT_ONLY_TRIGGERS.map((g) => `DROP TRIGGER IF EXISTS ${g.name} ON ${t}`), `GRANT UPDATE, DELETE ON ${t} TO crewflow_app`].join(';\n');
}

/**
 * Expected `core.workspace_schema_fingerprint_v2` of a level-26 workspace per PostgreSQL major. Measured, never derived
 * (ws-attendance-correction-insert-only.integration.spec.ts `[l26-fp]`; the per-major fingerprints ci run prints the measured
 * value on a mismatch). An undeclared major makes AttendanceCorrectionInsertOnly1786722110000 refuse (exit 66): fail closed.
 */
export const ATTENDANCE_CORRECTION_INSERT_ONLY_FINGERPRINTS_V2: Readonly<Partial<Record<16 | 17 | 18, string>>> = Object.freeze({
  16: '0000000000000000000000000000000000000000000000000000000000000026',
  17: '0000000000000000000000000000000000000000000000000000000000000027',
  18: '0000000000000000000000000000000000000000000000000000000000000028',
});

export const ATTENDANCE_CORRECTION_INSERT_ONLY_PROVISION_LITERAL = 'db:provision_workspace@AttendanceCorrectionInsertOnly1786722110000';

export const ATTENDANCE_CORRECTION_INSERT_ONLY: WorkspaceUpgradeCommand = Object.freeze({
  kind: 'workspace',
  name: 'AttendanceCorrectionInsertOnly',
  timestamp: ATTENDANCE_CORRECTION_INSERT_ONLY_TIMESTAMP,
  sql: attendanceCorrectionInsertOnlySql,
  structure: Object.freeze({
    level: 26,
    fingerprints: ATTENDANCE_CORRECTION_INSERT_ONLY_FINGERPRINTS_V2,
    provisionFunctionLiteral: ATTENDANCE_CORRECTION_INSERT_ONLY_PROVISION_LITERAL,
  }),
});
