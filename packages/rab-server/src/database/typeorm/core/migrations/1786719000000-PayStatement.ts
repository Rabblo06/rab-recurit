import { MigrationInterface, QueryRunner } from 'typeorm';
import { payStatementSql } from '../../workspace-schema/v1/pay-statement';
import { payrollRecordPredicates } from '../../workspace-schema/v1/payroll-record';

const KINDS_BEFORE = ['PROFILE_IMAGE', 'ORGANISATION_LOGO', 'WORKSPACE_LOGO', 'SHIFT_ROSTER_PDF', 'FINAL_TIMESHEET_PDF', 'VENUE_PHOTO'];
const KINDS_AFTER = [...KINDS_BEFORE, 'PAY_STATEMENT_PDF'];
const kindCheck = (kinds: string[]) => `CHECK (kind IN (${kinds.map((k) => `'${k}'`).join(', ')}))`;

const NOTIFICATION_TYPES_BEFORE = [
  'offer_sent', 'offer_expired', 'offer_accepted', 'offer_declined', 'offer_confirmed', 'offer_rejected',
  'shift_reminder_24h', 'shift_reminder_2h', 'shift_reminder_30m', 'shift_assignment_no_show', 'attendance_missing_clock_out',
  'shift_request_submitted', 'shift_request_approved', 'shift_request_declined', 'shift_request_staff_removed',
  'late_clock_in', 'shift_cancelled', 'replacement_required', 'manager_confirmation_timeout', 'clock_in_window_open',
];
const NOTIFICATION_TYPES_AFTER = [...NOTIFICATION_TYPES_BEFORE, 'pay_statement_ready'];
const typeCheck = (types: string[]) => `CHECK (notification_type IN (${types.map((k) => `'${k}'`).join(', ')}))`;

/**
 * Pay statement on payroll approval (owner decision 2026-10-21). Additive only:
 *  1. `core.stored_file.kind` admits PAY_STATEMENT_PDF (CHECK replaced; no stored row changes). The file is stored with
 *     the payroll record's own non-NULL workspace_id, so it sits inside the existing `stored_file_tenant` workspace
 *     branch; the per-caller rule is PayStatementFilePolicy (owner staff member with payslip.view_own, or a non-venue
 *     payroll.view manager of that workspace), 404 otherwise.
 *  2. `payroll_record` document / notification state columns, the statement file FK, a due-work index, the human update
 *     policy tightened and two worker-only policies, in core and every workspace schema (`payStatementSql`; the
 *     provisioner applies the same SQL — V1_EXPECTED 104 FKs / 79 indexes / 29 policies).
 *  3. `notification_preference.notification_type` admits 'pay_statement_ready' (NotificationType.PAY_STATEMENT_READY).
 * Existing approved records keep statement_status 'none' (no back-fill: a statement is requested by an approval).
 */
export class PayStatement1786719000000 implements MigrationInterface {
  name = 'PayStatement1786719000000';

  private async schemas(runner: QueryRunner): Promise<string[]> {
    const rows: Array<{ schema_name: string }> = await runner.query(`
      SELECT n.nspname AS schema_name FROM pg_namespace n
      JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = 'payroll_record' AND c.relkind = 'r'
      WHERE n.nspname = 'core' OR n.nspname ~ '^workspace_[0-9a-f]{32}$'
    `);
    return rows.map((row) => row.schema_name);
  }

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE core.stored_file DROP CONSTRAINT IF EXISTS stored_file_kind_check;`);
    await runner.query(`ALTER TABLE core.stored_file ADD CONSTRAINT stored_file_kind_check ${kindCheck(KINDS_AFTER)};`);
    await runner.query(`ALTER TABLE core.notification_preference DROP CONSTRAINT IF EXISTS notification_preference_notification_type_check;`);
    await runner.query(`ALTER TABLE core.notification_preference ADD CONSTRAINT notification_preference_notification_type_check ${typeCheck(NOTIFICATION_TYPES_AFTER)};`);
    for (const schema of await this.schemas(runner)) await runner.query(payStatementSql(schema));
  }

  /** For a failed rollout only: fails (by design) if any PAY_STATEMENT_PDF file or pay_statement_ready preference exists. */
  async down(runner: QueryRunner): Promise<void> {
    for (const schema of await this.schemas(runner)) {
      const q = schema === 'core' ? 'core' : `"${schema}"`;
      const t = `${q}.payroll_record`;
      const { tenant, payrollManager, notOwnHours } = payrollRecordPredicates(q);
      await runner.query(`DROP POLICY IF EXISTS payroll_record_worker_select ON ${t}; DROP POLICY IF EXISTS payroll_record_worker_update ON ${t};
        DROP POLICY IF EXISTS payroll_record_update ON ${t};
        CREATE POLICY payroll_record_update ON ${t} AS PERMISSIVE FOR UPDATE TO PUBLIC USING (${tenant} AND ${payrollManager})
          WITH CHECK (${tenant} AND ${payrollManager} AND ${notOwnHours});`);
      await runner.query(`ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS payroll_record_statement_file_id_fkey, DROP CONSTRAINT IF EXISTS payroll_record_statement_state_check,
        DROP CONSTRAINT IF EXISTS payroll_record_statement_status_check, DROP COLUMN IF EXISTS statement_error, DROP COLUMN IF EXISTS statement_attempts,
        DROP COLUMN IF EXISTS statement_notified_at, DROP COLUMN IF EXISTS statement_generated_at, DROP COLUMN IF EXISTS statement_file_id, DROP COLUMN IF EXISTS statement_status;`);
    }
    await runner.query(`ALTER TABLE core.notification_preference DROP CONSTRAINT IF EXISTS notification_preference_notification_type_check;`);
    await runner.query(`ALTER TABLE core.notification_preference ADD CONSTRAINT notification_preference_notification_type_check ${typeCheck(NOTIFICATION_TYPES_BEFORE)};`);
    await runner.query(`ALTER TABLE core.stored_file DROP CONSTRAINT IF EXISTS stored_file_kind_check;`);
    await runner.query(`ALTER TABLE core.stored_file ADD CONSTRAINT stored_file_kind_check ${kindCheck(KINDS_BEFORE)};`);
  }
}
