import { MigrationInterface, QueryRunner } from 'typeorm';

export class StaffProfileExtendedFields1786670800000 implements MigrationInterface {
  name = 'StaffProfileExtendedFields1786670800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.staff_profile
        ADD COLUMN preferred_name text,
        ADD COLUMN employment_type text,
        ADD COLUMN address text,
        ADD COLUMN city text,
        ADD COLUMN postcode text,
        ADD COLUMN other_skills text,
        ADD COLUMN years_experience integer,
        ADD COLUMN available_days text[],
        ADD COLUMN preferred_shift_times text,
        ADD COLUMN max_hours_per_week integer,
        ADD COLUMN right_to_work_status text,
        ADD COLUMN document_type text,
        ADD COLUMN expiry_date date;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.staff_profile
        DROP COLUMN IF EXISTS preferred_name,
        DROP COLUMN IF EXISTS employment_type,
        DROP COLUMN IF EXISTS address,
        DROP COLUMN IF EXISTS city,
        DROP COLUMN IF EXISTS postcode,
        DROP COLUMN IF EXISTS other_skills,
        DROP COLUMN IF EXISTS years_experience,
        DROP COLUMN IF EXISTS available_days,
        DROP COLUMN IF EXISTS preferred_shift_times,
        DROP COLUMN IF EXISTS max_hours_per_week,
        DROP COLUMN IF EXISTS right_to_work_status,
        DROP COLUMN IF EXISTS document_type,
        DROP COLUMN IF EXISTS expiry_date;
    `);
  }
}
