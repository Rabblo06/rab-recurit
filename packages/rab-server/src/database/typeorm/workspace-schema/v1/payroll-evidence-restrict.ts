/**
 * Frozen SQL shipped with migration PayrollEvidenceRestrict1786719700000 (and applied by both workspace provisioners after
 * the earlier V1 add-ons — see `WORKSPACE_TEMPLATE_STEPS` in provision-workspace-schema.ts and
 * `composeServerPathTemplateV1PayrollRestrict()` in server-path-template-payroll-restrict.ts). Never edited after merge:
 * a later change adds its own module and migration.
 *
 * Finding F3 (CREWFLOW_TWENTY_FULL_ENGINE_PARITY_REPORT.md §2, Medium, integrity): `payroll_record` referenced its
 * attendance, shift and staff profile with `ON DELETE CASCADE`. Deleting a `staff_profile` (directly, or through the
 * `core."user"` → `staff_profile` CASCADE), a `shift`, a `shift_assignment` or an `attendance` row therefore silently
 * deleted approved payroll records. Only `UserDeletionService.assertCanDelete` (layer 2) stood in the way; the database
 * layer had no protection for financial records.
 *
 * Fix: the three parent FKs become `ON DELETE RESTRICT`. Any delete — from any role, any code path, any CLI or ad-hoc SQL,
 * including one reached through another table's CASCADE — that would remove a row a payroll record points at now fails
 * with SQLSTATE 23503 and nothing is deleted. Nothing else changes: same names, same columns, same referenced keys; the
 * organisation FK (tenant offboarding) is deliberately untouched (owner decision, see WAVE1_LANE_S_REPORT.md).
 *
 * The rest of the payroll family needed no change and was checked: `payroll_run_line` → `payroll_record` / `payroll_run` /
 * `staff_profile`, `payslip` → `payroll_run` / `staff_profile` and `payslip_document` → `payslip` are already
 * no-ON-DELETE (NO ACTION) FKs, i.e. they already refuse such a delete.
 */

/** The three payroll_record parent FKs this module changes, in a fixed order. */
export const PAYROLL_EVIDENCE_FKS = [
  { name: 'payroll_record_attendance_id_fkey', columns: 'attendance_id', parent: 'attendance', parentColumns: 'id' },
  { name: 'payroll_record_shift_workspace_fkey', columns: 'shift_id, workspace_id', parent: 'shift', parentColumns: 'id, workspace_id' },
  { name: 'payroll_record_staff_workspace_fkey', columns: 'staff_profile_id, workspace_id', parent: 'staff_profile', parentColumns: 'id, workspace_id' },
] as const;

export type PayrollEvidenceDeleteAction = 'RESTRICT' | 'CASCADE';

function quoted(schema: string): string {
  if (schema !== 'core' && !/^workspace_[0-9a-f]{32}$/.test(schema)) throw new Error('Invalid workspace schema');
  return schema === 'core' ? 'core' : `"${schema}"`;
}

/**
 * One ALTER TABLE (one lock, one validation pass) that drops and re-adds the three FKs with the given delete action.
 * Strict on purpose: `DROP CONSTRAINT` without IF EXISTS, so a schema that is not shaped as expected fails loudly.
 * `CASCADE` exists only for the migration's down().
 */
export function payrollEvidenceFksSql(schema: string, action: PayrollEvidenceDeleteAction): string {
  const q = quoted(schema);
  const parts = PAYROLL_EVIDENCE_FKS.flatMap((fk) => [
    `DROP CONSTRAINT ${fk.name}`,
    `ADD CONSTRAINT ${fk.name} FOREIGN KEY (${fk.columns}) REFERENCES ${q}.${fk.parent}(${fk.parentColumns}) ON DELETE ${action}`,
  ]);
  return `ALTER TABLE ${q}.payroll_record\n  ${parts.join(',\n  ')};`;
}

/** The template step: payroll evidence can never be removed by deleting what it points at. */
export function payrollEvidenceRestrictSql(schema: string): string {
  return payrollEvidenceFksSql(schema, 'RESTRICT');
}
