import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A Manager may optionally set or generate an initial "temporary" credential
 * when creating a Staff member (Create Staff drawer) — purely for their own
 * reference. Deliberately a SEPARATE column from `password_hash`, never the
 * same one: `AuthService.login()`'s first-login-activation check matches
 * `status === INVITED && passwordHash !== null` — if a temporary password
 * were written into `password_hash` instead, the staff member could log in
 * with the Manager's own credential and self-activate immediately, exactly
 * the "admin temp password → force change" flow this account lifecycle was
 * built to prevent. Nullable — most existing/future Staff creations never
 * set one at all.
 */
export class UserTemporaryPasswordHash1786670700000 implements MigrationInterface {
  name = 'UserTemporaryPasswordHash1786670700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core."user"
        ADD COLUMN temporary_password_hash text;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core."user" DROP COLUMN IF EXISTS temporary_password_hash;`);
  }
}
