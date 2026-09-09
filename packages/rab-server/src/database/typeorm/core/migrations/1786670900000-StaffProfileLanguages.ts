import { MigrationInterface, QueryRunner } from 'typeorm';

export class StaffProfileLanguages1786670900000 implements MigrationInterface {
  name = 'StaffProfileLanguages1786670900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.staff_profile
        ADD COLUMN languages text[];
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.staff_profile DROP COLUMN IF EXISTS languages;`);
  }
}
