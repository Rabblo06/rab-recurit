import { MigrationInterface, QueryRunner } from 'typeorm';
import { approvedShiftStatementSql } from '../../workspace-schema/v1/approved-shift-statement';

const KINDS_BASE = ['PROFILE_IMAGE', 'ORGANISATION_LOGO', 'WORKSPACE_LOGO', 'SHIFT_ROSTER_PDF', 'FINAL_TIMESHEET_PDF', 'VENUE_PHOTO'];
const kindCheck = (kinds: string[]) => `CHECK (kind IN (${kinds.map((k) => `'${k}'`).join(', ')}))`;
const TYPES_BASE = [
  'offer_sent', 'offer_expired', 'offer_accepted', 'offer_declined', 'offer_confirmed', 'offer_rejected',
  'shift_reminder_24h', 'shift_reminder_2h', 'shift_reminder_30m', 'shift_assignment_no_show', 'attendance_missing_clock_out',
  'shift_request_submitted', 'shift_request_approved', 'shift_request_declined', 'shift_request_staff_removed',
  'late_clock_in', 'shift_cancelled', 'replacement_required', 'manager_confirmation_timeout', 'clock_in_window_open',
];
const typeCheck = (types: string[]) => `CHECK (notification_type IN (${types.map((k) => `'${k}'`).join(', ')}))`;

/**
 * Owner scope update 2026-10-21, on top of PayStatement1786719000000 (neither had reached a persistent database
 * when this was written; both apply in order):
 *  1. The document is the "Approved Shift Statement": file kind PAY_STATEMENT_PDF → APPROVED_SHIFT_STATEMENT_PDF and
 *     notification type pay_statement_ready → shift_statement_ready. Existing rows of the old names (disposable test
 *     data only) are renamed in place, then the CHECKs drop the old names.
 *  2. Durable outbox + BullMQ dispatch states and columns on payroll_record (`approvedShiftStatementSql`, core and every
 *     workspace schema; the provisioner applies the same SQL — V1 counts unchanged: the due-work index is re-created
 *     under the same name, no new FK or policy).
 */
export class ApprovedShiftStatement1786719100000 implements MigrationInterface {
  name = 'ApprovedShiftStatement1786719100000';

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
    await runner.query(`UPDATE core.stored_file SET kind = 'APPROVED_SHIFT_STATEMENT_PDF' WHERE kind = 'PAY_STATEMENT_PDF';`);
    await runner.query(`ALTER TABLE core.stored_file ADD CONSTRAINT stored_file_kind_check ${kindCheck([...KINDS_BASE, 'APPROVED_SHIFT_STATEMENT_PDF'])};`);
    await runner.query(`ALTER TABLE core.notification_preference DROP CONSTRAINT IF EXISTS notification_preference_notification_type_check;`);
    await runner.query(`UPDATE core.notification_preference SET notification_type = 'shift_statement_ready' WHERE notification_type = 'pay_statement_ready';`);
    await runner.query(`ALTER TABLE core.notification_preference ADD CONSTRAINT notification_preference_notification_type_check ${typeCheck([...TYPES_BASE, 'shift_statement_ready'])};`);
    await runner.query(`UPDATE core.notification SET type = 'shift_statement_ready' WHERE type = 'pay_statement_ready';`);
    for (const schema of await this.schemas(runner)) await runner.query(approvedShiftStatementSql(schema));
  }

  /** Failed-rollout only: reverses the names and narrows the statuses (fails by design if a queued/processing row exists). */
  async down(runner: QueryRunner): Promise<void> {
    for (const schema of await this.schemas(runner)) {
      const t = `${schema === 'core' ? 'core' : `"${schema}"`}.payroll_record`;
      await runner.query(`ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS payroll_record_statement_status_check, DROP CONSTRAINT IF EXISTS payroll_record_statement_dispatch_check,
        DROP COLUMN IF EXISTS statement_processing_at, DROP COLUMN IF EXISTS statement_queued_at, DROP COLUMN IF EXISTS statement_dispatch_generation;
        ALTER TABLE ${t} ADD CONSTRAINT payroll_record_statement_status_check CHECK (statement_status IN ('none','pending','generated','failed'));`);
    }
    await runner.query(`ALTER TABLE core.notification_preference DROP CONSTRAINT IF EXISTS notification_preference_notification_type_check;`);
    await runner.query(`UPDATE core.notification_preference SET notification_type = 'pay_statement_ready' WHERE notification_type = 'shift_statement_ready';`);
    await runner.query(`ALTER TABLE core.notification_preference ADD CONSTRAINT notification_preference_notification_type_check ${typeCheck([...TYPES_BASE, 'pay_statement_ready'])};`);
    await runner.query(`ALTER TABLE core.stored_file DROP CONSTRAINT IF EXISTS stored_file_kind_check;`);
    await runner.query(`UPDATE core.stored_file SET kind = 'PAY_STATEMENT_PDF' WHERE kind = 'APPROVED_SHIFT_STATEMENT_PDF';`);
    await runner.query(`ALTER TABLE core.stored_file ADD CONSTRAINT stored_file_kind_check ${kindCheck([...KINDS_BASE, 'PAY_STATEMENT_PDF'])};`);
  }
}
