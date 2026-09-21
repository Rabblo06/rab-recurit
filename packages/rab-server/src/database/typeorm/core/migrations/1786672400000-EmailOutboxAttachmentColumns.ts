import { MigrationInterface, QueryRunner } from 'typeorm';

/** Attachment support for the pre-shift roster and final Timesheet PDFs — see `EmailOutbox`'s own doc comment. */
export class EmailOutboxAttachmentColumns1786672400000 implements MigrationInterface {
  name = 'EmailOutboxAttachmentColumns1786672400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.email_outbox
        ADD COLUMN attachment_key text,
        ADD COLUMN attachment_filename text;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.email_outbox DROP COLUMN attachment_key, DROP COLUMN attachment_filename;`);
  }
}
