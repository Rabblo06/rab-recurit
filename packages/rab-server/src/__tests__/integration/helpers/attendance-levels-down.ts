import { Client } from 'pg';

import { AttendanceCorrectionInsertOnly1786722110000 } from '../../../database/typeorm/core/migrations/1786722110000-AttendanceCorrectionInsertOnly';
import { AttendanceStaffScopeRls1786722100000 } from '../../../database/typeorm/core/migrations/1786722100000-AttendanceStaffScopeRls';
import { attendanceCorrectionInsertOnlyDownSql } from '../../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-correction-insert-only';
import { attendanceTenantOnlySql } from '../../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-staff-scope';

/**
 * Test-only (inside a transaction the caller rolls back): takes the attendance structure levels ABOVE `level` down, newest
 * first, the way an owner-run rollback would: every workspace schema back to the previous form, then the migration's own
 * down(). A spec of an older level uses it before calling its own migration's down(), which needs its own body installed.
 * Levels: 26 = AttendanceCorrectionInsertOnly1786722110000, 25 = AttendanceStaffScopeRls1786722100000.
 */
export async function takeAttendanceLevelsDownTo(admin: Client, level: number): Promise<void> {
  const runner = { isTransactionActive: true, query: async (sql: string, params?: unknown[]) => (await admin.query(sql, params as unknown[])).rows } as never;
  const applied = async (name: string) => (await admin.query(`SELECT 1 FROM core.migrations WHERE name = $1`, [name])).rows.length === 1;
  const schemas = async (table: string) =>
    (
      await admin.query(
        `SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname ~ '^workspace_[0-9a-f]{32}$' AND c.relname = $1 AND c.relkind = 'r'`,
        [table],
      )
    ).rows.map((r) => String(r.nspname));
  if (level < 26 && (await applied('AttendanceCorrectionInsertOnly1786722110000'))) {
    for (const s of await schemas('attendance_correction')) await admin.query(attendanceCorrectionInsertOnlyDownSql(s));
    await new AttendanceCorrectionInsertOnly1786722110000().down(runner);
  }
  if (level < 25 && (await applied('AttendanceStaffScopeRls1786722100000'))) {
    for (const s of await schemas('attendance')) await admin.query(attendanceTenantOnlySql(s));
    await new AttendanceStaffScopeRls1786722100000().down(runner);
  }
}
