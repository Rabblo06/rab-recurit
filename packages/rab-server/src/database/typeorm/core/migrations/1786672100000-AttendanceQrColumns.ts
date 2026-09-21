import { MigrationInterface, QueryRunner } from 'typeorm';

/** `Shift.qrVersion` — see `AttendanceQrService`/`shift.entity.ts`. */
export class AttendanceQrColumns1786672100000 implements MigrationInterface {
  name = 'AttendanceQrColumns1786672100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.shift ADD COLUMN qr_version integer NOT NULL DEFAULT 1;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.shift DROP COLUMN qr_version;`);
  }
}
