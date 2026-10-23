/**
 * FROZEN with migration AttendanceMoneyChecks1786719810000 (never edited after merge; a later change is a new module).
 *
 * Wave 2 lane S2 (C1/C2, CREWFLOW_TWENTY_FULL_ENGINE_PARITY_REPORT.md §3.10): `attendance.earned_pence` and
 * `attendance.worked_minutes` were the only money/duration columns on the pay path with no database CHECK. Every other
 * pence column (rates, snapshots, payroll_record figures, run lines, payslips) is already `>= 0`. A negative value could
 * only come from a bug or hand SQL today (the service computes both from `duration.ts` / `payForMinutes`), but the
 * database is the last layer and it was missing.
 *
 * Shape: the two CHECKs are added `NOT VALID` (no table scan under the ACCESS EXCLUSIVE lock) and then `VALIDATE`d (a scan
 * under SHARE UPDATE EXCLUSIVE, which does not block reads or writes). NULL still passes (an attendance that has not been
 * clocked out has neither value yet). The caller runs `attendanceMoneyPrecheckSql` first and refuses on any violating row,
 * so VALIDATE never fails half way and no existing row is ever silently "fixed".
 *
 * Applied to `core` by the migration itself and to every `workspace_<32 hex>` schema as workspace module
 * `v1.015-attendance-money-checks` through the WorkspaceSchemaMigrator (and by both provisioning paths for new schemas).
 */
export const ATTENDANCE_MONEY_CHECKS = [
  { name: 'attendance_earned_pence_non_negative', expression: 'earned_pence >= 0' },
  { name: 'attendance_worked_minutes_non_negative', expression: 'worked_minutes >= 0' },
] as const;

export function attendanceMoneyChecksSql(schema: string): string {
  return [
    ...ATTENDANCE_MONEY_CHECKS.map((c) => `ALTER TABLE ${schema}.attendance ADD CONSTRAINT ${c.name} CHECK (${c.expression}) NOT VALID`),
    ...ATTENDANCE_MONEY_CHECKS.map((c) => `ALTER TABLE ${schema}.attendance VALIDATE CONSTRAINT ${c.name}`),
  ].join(';\n');
}

/** Returns one row `{ n }`: the number of rows that would violate either CHECK. Must be 0 before applying. */
export function attendanceMoneyPrecheckSql(schema: string): string {
  return `SELECT count(*)::int AS n FROM ${schema}.attendance WHERE earned_pence < 0 OR worked_minutes < 0`;
}
