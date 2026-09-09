import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wires `staff_profile` up to the `job_role` entity that already exists
 * (built for Shift creation — `SchedulingService.listJobRoles`/
 * `createJobRole`, `GET/POST /job-roles`) rather than inventing a second,
 * free-text "job role" concept for the Staff Detail/Create panels — see
 * CLAUDE.md's "don't create duplicate sources of truth." Nullable: not
 * every org will have set up job roles before hiring someone, and no
 * existing `staff_profile` row can be backfilled with a guessed value.
 */
export class StaffProfileJobRoleFk1786670600000 implements MigrationInterface {
  name = 'StaffProfileJobRoleFk1786670600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.staff_profile
        ADD COLUMN job_role_id uuid REFERENCES core.job_role(id) ON DELETE SET NULL;
    `);
    await queryRunner.query(`CREATE INDEX staff_profile_job_role_idx ON core.staff_profile (job_role_id);`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.staff_profile DROP COLUMN IF EXISTS job_role_id;`);
  }
}
