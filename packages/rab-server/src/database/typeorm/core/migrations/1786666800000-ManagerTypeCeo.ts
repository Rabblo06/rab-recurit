import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `'ceo'` to `manager_profile.type`'s allowed values — a CEO is a
 * third `ManagerType`, created through the existing `POST /managers` flow
 * (`ManagerService.create`/`ROLE_DEFS`), not a parallel identity system.
 * Constraint name confirmed against a live database before writing this
 * (`SELECT conname FROM pg_constraint WHERE conrelid =
 * 'core.manager_profile'::regclass AND contype = 'c'` ->
 * `manager_profile_type_check`) rather than assumed from Postgres's default
 * auto-naming convention.
 */
export class ManagerTypeCeo1786666800000 implements MigrationInterface {
  name = 'ManagerTypeCeo1786666800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.manager_profile DROP CONSTRAINT manager_profile_type_check;`);
    await queryRunner.query(
      `ALTER TABLE core.manager_profile ADD CONSTRAINT manager_profile_type_check CHECK (type IN ('internal','venue','ceo'));`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.manager_profile DROP CONSTRAINT manager_profile_type_check;`);
    await queryRunner.query(
      `ALTER TABLE core.manager_profile ADD CONSTRAINT manager_profile_type_check CHECK (type IN ('internal','venue'));`,
    );
  }
}
