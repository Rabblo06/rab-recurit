import { Client } from 'pg';

import { WorkspaceAttendanceBreaksReceipts1786722150000 } from '../../../database/typeorm/core/migrations/1786722150000-WorkspaceAttendanceBreaksReceipts';
import { WorkspaceAttendanceCorrectionInsertOnly1786722130000 } from '../../../database/typeorm/core/migrations/1786722130000-WorkspaceAttendanceCorrectionInsertOnly';
import { WorkspaceAttendanceStaffScope1786722120000 } from '../../../database/typeorm/core/migrations/1786722120000-WorkspaceAttendanceStaffScope';
import { correctionAttendanceFkSql } from '../../../database/typeorm/workspace-schema/attendance-correction-evidence-restrict-sql';
import { attendanceCorrectionInsertOnlyDownSql } from '../../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-correction-insert-only';
import { attendanceCorrectionTenantOnlySql, attendanceTenantOnlySql } from '../../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-staff-scope';

/**
 * Test-only (inside a transaction the caller rolls back): takes the attendance workspace structure levels ABOVE `level` down,
 * newest first, the way an owner-run rollback would: every workspace schema back to the previous form, then the migration's own
 * down(). A spec of an older level uses it before calling its own migration's down(), which needs its own body installed.
 * Levels: 27 = WorkspaceAttendanceBreaksReceipts1786722150000, 26 = WorkspaceAttendanceCorrectionInsertOnly1786722130000,
 * 25 = WorkspaceAttendanceStaffScope1786722120000. The core copies (#305 / #306 / AttendanceBreaksReceipts1786722140000) are
 * not touched: they are not structure levels.
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
  if (level < 27 && (await applied('WorkspaceAttendanceBreaksReceipts1786722150000'))) {
    for (const s of await schemas('attendance')) {
      const q = `"${s}"`;
      await admin.query(`DROP TABLE IF EXISTS ${q}.attendance_sync_receipt`);
      await admin.query(`DROP TABLE IF EXISTS ${q}.attendance_break`);
      await admin.query(`DROP INDEX IF EXISTS ${q}.attendance_offline_idx`);
      await admin.query(`ALTER TABLE ${q}.attendance DROP CONSTRAINT IF EXISTS attendance_time_source_check`);
      await admin.query(
        `ALTER TABLE ${q}.attendance DROP COLUMN IF EXISTS offline_recorded, DROP COLUMN IF EXISTS clock_in_time_source, DROP COLUMN IF EXISTS clock_out_time_source, DROP COLUMN IF EXISTS clock_in_claimed_at, DROP COLUMN IF EXISTS clock_out_claimed_at`,
      );
      await admin.query(`ALTER TABLE ${q}.shift_assignment DROP CONSTRAINT IF EXISTS shift_assignment_check_in_offline_check`);
      await admin.query(`ALTER TABLE ${q}.shift_assignment DROP COLUMN IF EXISTS check_in_offline`);
      await admin.query(`ALTER TABLE ${q}.venue DROP COLUMN IF EXISTS offline_attendance_enabled`);
    }
    await new WorkspaceAttendanceBreaksReceipts1786722150000().down(runner);
  }
  if (level < 26 && (await applied('WorkspaceAttendanceCorrectionInsertOnly1786722130000'))) {
    for (const s of await schemas('attendance_correction')) {
      await admin.query(attendanceCorrectionInsertOnlyDownSql(s));
      await admin.query(`GRANT UPDATE, DELETE ON "${s}".attendance_correction TO crewflow_app`);
      const [fk] = (await admin.query(`SELECT confdeltype::text AS d FROM pg_constraint WHERE conrelid = ('"' || $1 || '".attendance_correction')::regclass AND conname = 'attendance_correction_attendance_id_fkey'`, [s])).rows;
      if (fk?.d === 'r') await admin.query(correctionAttendanceFkSql(s, 'CASCADE'));
    }
    await new WorkspaceAttendanceCorrectionInsertOnly1786722130000().down(runner);
  }
  if (level < 25 && (await applied('WorkspaceAttendanceStaffScope1786722120000'))) {
    for (const s of await schemas('attendance')) {
      await admin.query(attendanceTenantOnlySql(s));
      await admin.query(attendanceCorrectionTenantOnlySql(s));
    }
    await new WorkspaceAttendanceStaffScope1786722120000().down(runner);
  }
}
