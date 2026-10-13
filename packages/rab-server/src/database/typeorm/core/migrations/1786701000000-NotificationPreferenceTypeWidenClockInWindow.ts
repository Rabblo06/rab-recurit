import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Widens `notification_preference.notification_type`'s CHECK constraint
 * (`NotificationPreferenceTypeWiden1786673000000`) to include the new
 * `clock_in_window_open` value (Staff Shift Reminders completion —
 * `shift-monitor.job.ts`'s new 4th reminder window). Same reason as that
 * migration's own doc comment: `UpdateNotificationPreferenceDto` validates
 * against the full `NotificationType` enum via `@IsIn(Object.values(...))`,
 * so the FIRST user to customize a preference for this type would hit a
 * CHECK-constraint 500 if this value weren't added here, in the same change
 * that introduces the type — not as a follow-up.
 *
 * `core.notification.type` itself needs no migration — it's a plain `text`
 * column with no CHECK constraint or enum (confirmed: `@Column({type:
 * 'text'})`, notification.entity.ts), so a new `NotificationType` string
 * value is always valid there without a schema change.
 */
export class NotificationPreferenceTypeWidenClockInWindow1786701000000 implements MigrationInterface {
  name = 'NotificationPreferenceTypeWidenClockInWindow1786701000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.notification_preference DROP CONSTRAINT notification_preference_notification_type_check;`);
    await queryRunner.query(`
      ALTER TABLE core.notification_preference ADD CONSTRAINT notification_preference_notification_type_check
        CHECK (notification_type IN (
          'offer_sent', 'offer_expired', 'offer_accepted', 'offer_declined', 'offer_confirmed', 'offer_rejected',
          'shift_reminder_24h', 'shift_reminder_2h', 'shift_reminder_30m',
          'shift_assignment_no_show', 'attendance_missing_clock_out',
          'shift_request_submitted', 'shift_request_approved', 'shift_request_declined', 'shift_request_staff_removed',
          'late_clock_in', 'shift_cancelled', 'replacement_required', 'manager_confirmation_timeout',
          'clock_in_window_open'
        ));
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.notification_preference DROP CONSTRAINT notification_preference_notification_type_check;`);
    await queryRunner.query(`
      ALTER TABLE core.notification_preference ADD CONSTRAINT notification_preference_notification_type_check
        CHECK (notification_type IN (
          'offer_sent', 'offer_expired', 'offer_accepted', 'offer_declined', 'offer_confirmed', 'offer_rejected',
          'shift_reminder_24h', 'shift_reminder_2h', 'shift_reminder_30m',
          'shift_assignment_no_show', 'attendance_missing_clock_out',
          'shift_request_submitted', 'shift_request_approved', 'shift_request_declined', 'shift_request_staff_removed',
          'late_clock_in', 'shift_cancelled', 'replacement_required', 'manager_confirmation_timeout'
        ));
    `);
  }
}
