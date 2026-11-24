// sql-injection-reviewed-file: SQL definition / check module (database layer). Every interpolation is a code constant of this repository (a validated schema name, a constraint name and a delete action from a closed set); no request or row data reaches these templates.

/**
 * DRAFT — NEW SQL, owner SQL review FIRST (security review of #306, Medium; tied to owner decision 46: the pay-evidence
 * principle approved for breaks and receipts in DESIGN §A.7). `attendance_correction.attendance_id` becomes ON DELETE
 * RESTRICT: deleting an attendance that has a correction now fails (23503, or 23001 restrict_violation on PostgreSQL 18)
 * instead of silently removing the correction rows through the cascade (the FK action runs as the table owner, so the
 * insert-only guard of AttendanceCorrectionInsertOnly1786722110000 lets it through).
 *
 * One ALTER TABLE (one lock, one validation pass): drop and re-add the same constraint, same name, same column, same
 * referenced key; only the delete action changes. Strict: DROP CONSTRAINT without IF EXISTS, so an unexpected shape fails.
 */
export const CORRECTION_ATTENDANCE_FK = 'attendance_correction_attendance_id_fkey';

export type CorrectionFkAction = 'RESTRICT' | 'CASCADE';

export function correctionAttendanceFkSql(schema: string, action: CorrectionFkAction): string {
  if (schema !== 'core' && !/^workspace_[0-9a-f]{32}$/.test(schema)) throw new Error('Invalid workspace schema');
  if (action !== 'RESTRICT' && action !== 'CASCADE') throw new Error('Invalid delete action');
  return `ALTER TABLE "${schema}".attendance_correction
  DROP CONSTRAINT ${CORRECTION_ATTENDANCE_FK},
  ADD CONSTRAINT ${CORRECTION_ATTENDANCE_FK} FOREIGN KEY (attendance_id) REFERENCES "${schema}".attendance(id) ON DELETE ${action}`;
}

/** Catalog facts of the constraint on core (compared column by column, never through search_path-dependent text). */
export const CORE_CORRECTION_FK_STATE_SQL = `SELECT k.confdeltype::text AS deltype, k.confupdtype::text AS updtype, k.convalidated AS validated,
       k.confrelid = 'core.attendance'::pg_catalog.regclass AS parent_ok,
       (SELECT pg_catalog.array_agg(a.attname::text ORDER BY a.attnum) FROM pg_catalog.pg_attribute a
         WHERE a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)) AS cols
  FROM pg_catalog.pg_constraint k
 WHERE k.conrelid = 'core.attendance_correction'::pg_catalog.regclass AND k.conname = '${CORRECTION_ATTENDANCE_FK}' AND k.contype = 'f'`;

export interface CorrectionFkRow {
  deltype: string;
  updtype: string;
  validated: boolean;
  parent_ok: boolean;
  cols: string[] | null;
}

/** Problems with the constraint for the expected delete action ('r' RESTRICT, 'c' CASCADE). Pure. */
export function correctionFkProblems(row: CorrectionFkRow | undefined, want: 'r' | 'c'): string[] {
  if (!row) return [`core.attendance_correction: ${CORRECTION_ATTENDANCE_FK} missing`];
  const p: string[] = [];
  if (row.deltype !== want) p.push(`ON DELETE action ${row.deltype}, expected ${want}`);
  if (row.updtype !== 'a') p.push(`ON UPDATE action ${row.updtype}, expected a (no action)`);
  if (!row.validated) p.push('not validated');
  if (!row.parent_ok) p.push('does not reference core.attendance');
  if (JSON.stringify(row.cols) !== JSON.stringify(['attendance_id'])) p.push(`columns ${JSON.stringify(row.cols)}, expected ["attendance_id"]`);
  return p.map((x) => `core.attendance_correction ${CORRECTION_ATTENDANCE_FK}: ${x}`);
}
