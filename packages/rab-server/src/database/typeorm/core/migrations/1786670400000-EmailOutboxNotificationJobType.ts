import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Part of the multi-job worker architecture — `NotificationService.notify()`
 * previously sent its (preference-gated) email inline, synchronously,
 * inside the same request/transaction as the state change it's about
 * (offer sent/accepted/etc.), best-effort try/catch swallowed. That's
 * exactly the "external call inside a critical HTTP path" pattern the
 * durable-outbox architecture exists to remove — see
 * `notification.service.ts`'s own prior doc comment, which already
 * anticipated this exact upgrade ("the correct on-ramp for a future
 * outbox-based dispatcher — the call site doesn't change, only what wraps
 * it"). Adds the one new `job_type` value notification emails need to flow
 * through the same outbox/dispatcher/worker path every other email type
 * already uses.
 */
export class EmailOutboxNotificationJobType1786670400000 implements MigrationInterface {
  name = 'EmailOutboxNotificationJobType1786670400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.email_outbox DROP CONSTRAINT email_outbox_job_type_check;`);
    await queryRunner.query(`
      ALTER TABLE core.email_outbox ADD CONSTRAINT email_outbox_job_type_check CHECK (job_type IN (
        'ACCOUNT_INVITATION', 'PASSWORD_RESET', 'PASSWORD_UPDATED', 'WELCOME', 'ACCOUNT_SUSPENDED', 'NOTIFICATION'
      ));
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.email_outbox DROP CONSTRAINT email_outbox_job_type_check;`);
    await queryRunner.query(`
      ALTER TABLE core.email_outbox ADD CONSTRAINT email_outbox_job_type_check CHECK (job_type IN (
        'ACCOUNT_INVITATION', 'PASSWORD_RESET', 'PASSWORD_UPDATED', 'WELCOME', 'ACCOUNT_SUSPENDED'
      ));
    `);
  }
}
