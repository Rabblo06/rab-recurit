import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fixes a real schema/DTO mismatch found during the rab-worker audit:
 * `notification_preference.notification_type`'s CHECK constraint
 * (`SettingsSchema1786666500000`) only ever allowed the 6 `offer_*` values,
 * but `UpdateNotificationPreferenceDto`/the Settings UI validate and render
 * all `NotificationType` values. A user toggling e.g. `shift_reminder_24h`
 * (or any of the worker-originated types) hits `PATCH` → the DTO accepts it
 * → the INSERT/UPDATE against this table 500s with a CHECK-constraint
 * violation. Widened to the full current enum, including the 4 new
 * rab-worker-migration types (`late_clock_in`, `shift_cancelled`,
 * `replacement_required`, `manager_confirmation_timeout`) so this doesn't
 * immediately need a follow-up migration for them too.
 *
 * The original CHECK (`SettingsSchema1786666500000`) was written inline,
 * with no explicit `CONSTRAINT <name>` — Postgres deterministically names
 * that shape `{table}_{column}_check`, so `notification_preference_
 * notification_type_check` is guaranteed correct, not guessed.
 */
export class NotificationPreferenceTypeWiden1786673000000 implements MigrationInterface {
  name = 'NotificationPreferenceTypeWiden1786673000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
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

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.notification_preference DROP CONSTRAINT notification_preference_notification_type_check;`);
    await queryRunner.query(`
      ALTER TABLE core.notification_preference ADD CONSTRAINT notification_preference_notification_type_check
        CHECK (notification_type IN ('offer_sent','offer_expired','offer_accepted','offer_declined','offer_confirmed','offer_rejected'));
    `);
  }
}
