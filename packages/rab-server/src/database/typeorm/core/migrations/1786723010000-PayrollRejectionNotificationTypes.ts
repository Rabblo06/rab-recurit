import { MigrationInterface, QueryRunner } from 'typeorm';

/** The notification types the preference CHECK allowed after PayrollCalendarRunsPayslips1786719200000 (unchanged list). */
export const NOTIFICATION_PREFERENCE_TYPES_BEFORE_1786723010000: readonly string[] = Object.freeze([
  'offer_sent', 'offer_expired', 'offer_accepted', 'offer_declined', 'offer_confirmed', 'offer_rejected',
  'shift_reminder_24h', 'shift_reminder_2h', 'shift_reminder_30m', 'shift_assignment_no_show', 'attendance_missing_clock_out',
  'shift_request_submitted', 'shift_request_approved', 'shift_request_declined', 'shift_request_staff_removed',
  'late_clock_in', 'shift_cancelled', 'replacement_required', 'manager_confirmation_timeout', 'clock_in_window_open',
  'shift_statement_ready', 'payslip_available', 'payroll_period_attention',
]);

/** Owner decision 6: the two notices of a rejected payroll record. */
export const PAYROLL_REJECTION_NOTIFICATION_TYPES: readonly string[] = Object.freeze(['payroll_record_rejected', 'payroll_hours_rechecked']);

const typeCheck = (types: readonly string[]) => `CHECK (notification_type IN (${types.map((k) => `'${k}'`).join(', ')}))`;

/**
 * DRAFT — NEW SQL, owner SQL review FIRST (owner decision 6, 2026-11-21). A rejected payroll record notifies the manager who
 * finalised those hours (`payroll_record_rejected`, in-app + email, with the reason) and the staff member (`payroll_hours_rechecked`,
 * a neutral in-app notice without the reason). `core.notification.type` has no CHECK; only the per-user preference table
 * does, so a preference for the two new types could not be saved without widening it. Same mechanism as
 * PayrollCalendarRunsPayslips1786719200000. No grant, policy, table or data change.
 */
export class PayrollRejectionNotificationTypes1786723010000 implements MigrationInterface {
  name = 'PayrollRejectionNotificationTypes1786723010000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE core.notification_preference DROP CONSTRAINT IF EXISTS notification_preference_notification_type_check;`);
    await runner.query(
      `ALTER TABLE core.notification_preference ADD CONSTRAINT notification_preference_notification_type_check ${typeCheck([...NOTIFICATION_PREFERENCE_TYPES_BEFORE_1786723010000, ...PAYROLL_REJECTION_NOTIFICATION_TYPES])};`,
    );
  }

  /** Fails loudly (23514) while a saved preference for one of the two types exists; it never deletes a user's preference. */
  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE core.notification_preference DROP CONSTRAINT IF EXISTS notification_preference_notification_type_check;`);
    await runner.query(`ALTER TABLE core.notification_preference ADD CONSTRAINT notification_preference_notification_type_check ${typeCheck(NOTIFICATION_PREFERENCE_TYPES_BEFORE_1786723010000)};`);
  }
}
