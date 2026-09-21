import { MigrationInterface, QueryRunner } from 'typeorm';

export class AuthenticationApplicationTarget1786671700000 implements MigrationInterface {
  name = 'AuthenticationApplicationTarget1786671700000';
  async up(queryRunner: QueryRunner): Promise<void> {
    // Existing RLS and grants remain intact. Legacy refresh sessions must
    // reauthenticate once because they have no authenticated application binding.
    await queryRunner.query(`ALTER TABLE core.refresh_token ADD COLUMN application_target text CHECK (application_target IN ('manager_web', 'venue_manager_app', 'staff_app'))`);
    await queryRunner.query(`UPDATE core.refresh_token SET revoked_at = now() WHERE revoked_at IS NULL`);
    await queryRunner.query(`ALTER TABLE core.password_reset_token ADD COLUMN application_target text CHECK (application_target IN ('manager_web', 'venue_manager_app', 'staff_app'))`);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.password_reset_token DROP COLUMN application_target`);
    await queryRunner.query(`ALTER TABLE core.refresh_token DROP COLUMN application_target`);
  }
}
