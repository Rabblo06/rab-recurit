import type { WorkspaceUpgradeCommand } from '../workspace-upgrade-command';

/**
 * Security finding S11 / architecture §5.7 (owner decision 2026-11-21: "make attendance_correction insert-only in the
 * database"). DRAFT — NEW SQL, owner SQL review FIRST; never edited after merge once approved.
 *
 * THE statements, in one place, for every copy of `attendance_correction`:
 *   - `core.attendance_correction` (HWS off: production today): migration AttendanceCorrectionInsertOnly1786722110000;
 *   - every `workspace_<hex>.attendance_correction` (HWS on): the 0.7.0 workspace command that follows the 0.7.0 release
 *     chain (#175 / #177 / #243), the level-26 command object at the end of this file.
 *
 * The gap: a correction row is itself audit evidence (architecture §11: "original values are never overwritten in place"),
 * but the runtime could UPDATE or DELETE it:
 *   - the runtime login crewflow_owner inherits the table owner crewflow, so grants never bound it (owner-login BC-01 / BC-13);
 *   - crewflow_app (the schema role the owner-login parity guards reproduce) still holds UPDATE and DELETE (the copied-grant
 *     drift recorded in THREAT-MODEL since CrewflowAppCopiedWriteGrantRevoke1786720020000);
 *   - the policy attendance_correction_tenant is FOR ALL, so RLS admitted both for any tenant row.
 * Nothing in the application updates or deletes a correction (AttendanceService inserts one row per changed field).
 *
 * What it does, for one schema: three statement-level BEFORE triggers, UPDATE / DELETE / TRUNCATE, calling the existing
 * owner-login guard core.owner_login_grant_parity_guard() (OwnerLoginGrantParityGuards1786721420000, unchanged). It refuses the
 * runtime login with 42501 per STATEMENT (even one that RLS leaves with no row) and lets through only crewflow,
 * rab_secure_owner and superusers: definers, the workspace migrator (SET LOCAL ROLE crewflow) and foreign-key actions, which
 * run as the table owner. The attendance foreign key is turned into RESTRICT separately (AttendanceCorrectionEvidenceRestrict
 * 1786722115000, owner decision 46), so deleting the parent attendance can no longer cascade the corrections away; the
 * organisation CASCADE (tenant offboarding, LC-2) is unchanged.
 * Trigger names deliberately do not match `_%_grant_parity_%`: that is the frozen PAY-1 set, counted by its own checks.
 * Idempotent: each trigger is created only when the table has no trigger of that name. Additive only (no DROP).
 *
 * Not here (with the workspace copies, in the same release): `REVOKE UPDATE, DELETE ... FROM crewflow_app` on core AND every
 * workspace schema together. tools/check-rls-coverage.ts requires a workspace table's grants to equal its core counterpart's,
 * so that (cosmetic) schema-role grant can only move together with the workspace command. The runtime login is not bound by
 * it anyway (it inherits the owner); the triggers are the enforcement.
 */
export const ATTENDANCE_CORRECTION_GUARD_FUNCTION = 'core.owner_login_grant_parity_guard';

/** The three guard triggers, in a fixed order. tgtype = BEFORE (2) + statement level + UPDATE 16 / DELETE 8 / TRUNCATE 32. */
export const ATTENDANCE_CORRECTION_INSERT_ONLY_TRIGGERS = [
  { name: 'attendance_correction_insert_only_update', event: 'UPDATE', tgtype: 18 },
  { name: 'attendance_correction_insert_only_delete', event: 'DELETE', tgtype: 10 },
  { name: 'attendance_correction_insert_only_truncate', event: 'TRUNCATE', tgtype: 34 },
] as const;

function checkedSchema(schema: string): string {
  if (schema !== 'core' && !/^workspace_[0-9a-f]{32}$/.test(schema)) throw new Error('Invalid workspace schema');
  return schema;
}

/** The guard triggers for one schema ('core' or a validated workspace schema). */
export function attendanceCorrectionInsertOnlySql(schema: string): string {
  const s = checkedSchema(schema);
  const t = `"${s}".attendance_correction`;
  // sql-injection-reviewed: s is 'core' or a regex-validated `workspace_<32 hex>` name; trigger names, events and the function are constants.
  const creates = ATTENDANCE_CORRECTION_INSERT_ONLY_TRIGGERS.map(
    // sql-injection-reviewed: t is built from the validated schema above; g.name / g.event are constants of this file.
    (g) => `  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = '${t}'::pg_catalog.regclass AND t.tgname = '${g.name}') THEN
    CREATE TRIGGER ${g.name} BEFORE ${g.event} ON ${t} FOR EACH STATEMENT EXECUTE FUNCTION ${ATTENDANCE_CORRECTION_GUARD_FUNCTION}();
  END IF;`,
  ).join('\n');
  return `DO $correction_insert_only$
BEGIN
${creates}
END
$correction_insert_only$`;
}

/** down() only: the triggers dropped (the state before). */
export function attendanceCorrectionInsertOnlyDownSql(schema: string): string {
  const s = checkedSchema(schema);
  const t = `"${s}".attendance_correction`;
  return ATTENDANCE_CORRECTION_INSERT_ONLY_TRIGGERS.map(
    // sql-injection-reviewed: t is built from the validated schema above; g.name is a constant of this file.
    (g) => `DROP TRIGGER IF EXISTS ${g.name} ON ${t}`).join(';\n');
}

// ---------------------------------------------------------------------------------------------------------------------
// Release 0.7.0, workspace structure level 26 (lead allocation). DRAFT — NEW SQL, owner SQL review FIRST. The core copy got
// the triggers (AttendanceCorrectionInsertOnly1786722110000, #306) and the RESTRICT key (AttendanceCorrectionEvidenceRestrict
// 1786722115000, owner decision 46). This command applies to every existing READY workspace schema, in order:
//   1. `REVOKE UPDATE, DELETE ... FROM crewflow_app` (the copied-grant drift; core is revoked in the same release by
//      WorkspaceAttendanceCorrectionInsertOnly1786722130000, so check-rls-coverage's "workspace grants = core grants" holds);
//   2. the same three guard triggers as core (created only when missing);
//   3. `attendance_correction_attendance_id_fkey` ON DELETE CASCADE -> RESTRICT (only when it is still CASCADE).
// It drops and re-adds a constraint, so `mayDrop` is declared. Idempotent: REVOKE of a privilege not held is a no-op, the
// triggers and the key change are guarded. WorkspaceAttendanceCorrectionInsertOnly1786722130000 folds the same SQL into
// core.provision_workspace so new workspaces are built at level 26.

export const ATTENDANCE_CORRECTION_INSERT_ONLY_TIMESTAMP = 1786722130000;

/** The level-26 statements for one workspace schema. */
export function workspaceCorrectionInsertOnlySql(schema: string): string {
  const s = checkedSchema(schema);
  const t = `"${s}".attendance_correction`;
  // sql-injection-reviewed: s is a regex-validated schema name; the constraint, column and table names are constants.
  const restrict = `DO $correction_restrict$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = '${t}'::pg_catalog.regclass
              AND k.conname = 'attendance_correction_attendance_id_fkey' AND k.contype = 'f' AND k.confdeltype = 'c') THEN
    ALTER TABLE ${t}
      DROP CONSTRAINT attendance_correction_attendance_id_fkey,
      ADD CONSTRAINT attendance_correction_attendance_id_fkey FOREIGN KEY (attendance_id) REFERENCES "${s}".attendance(id) ON DELETE RESTRICT;
  END IF;
END
$correction_restrict$`;
  // sql-injection-reviewed: t is built from the validated schema s; the REVOKE names constants only.
  return [`REVOKE UPDATE, DELETE ON ${t} FROM crewflow_app`, attendanceCorrectionInsertOnlySql(s), restrict].join(';\n');
}

/**
 * Expected `core.workspace_schema_fingerprint_v2` of a level-26 workspace per PostgreSQL major. Measured, never derived
 * (ws-attendance-correction-insert-only.integration.spec.ts `[l26-fp]`; the fingerprints ci run prints `MISMATCH (measured …)`).
 * PLACEHOLDERS until CI measures them (fail closed).
 */
export const ATTENDANCE_CORRECTION_INSERT_ONLY_FINGERPRINTS_V2: Readonly<Partial<Record<16 | 17 | 18, string>>> = Object.freeze({
  16: '0000000000000000000000000000000000000000000000000000000000000026',
  17: '0000000000000000000000000000000000000000000000000000000000000027',
  18: '0000000000000000000000000000000000000000000000000000000000000028',
});

export const ATTENDANCE_CORRECTION_INSERT_ONLY_PROVISION_LITERAL = 'db:provision_workspace@WorkspaceAttendanceCorrectionInsertOnly1786722130000';

export const ATTENDANCE_CORRECTION_INSERT_ONLY: WorkspaceUpgradeCommand = Object.freeze({
  kind: 'workspace',
  name: 'AttendanceCorrectionInsertOnly',
  timestamp: ATTENDANCE_CORRECTION_INSERT_ONLY_TIMESTAMP,
  sql: workspaceCorrectionInsertOnlySql,
  structure: Object.freeze({
    level: 26,
    mayDrop: true,
    fingerprints: ATTENDANCE_CORRECTION_INSERT_ONLY_FINGERPRINTS_V2,
    provisionFunctionLiteral: ATTENDANCE_CORRECTION_INSERT_ONLY_PROVISION_LITERAL,
  }),
});
