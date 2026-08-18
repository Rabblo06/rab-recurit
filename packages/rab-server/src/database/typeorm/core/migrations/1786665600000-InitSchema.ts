import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the `core` schema and the extensions later migrations depend on:
 * - pgcrypto  → gen_random_uuid() for every PK
 * - citext    → case-insensitive `user.email`
 * - btree_gist → the GiST exclusion constraint that enforces "no double
 *   booking" on shift_assignment at the database level (§11)
 */
export class InitSchema1786665600000 implements MigrationInterface {
  name = 'InitSchema1786665600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "core"`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "citext"`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "btree_gist"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP SCHEMA IF EXISTS "core" CASCADE`);
    // Extensions are intentionally left installed on down — other schemas
    // in the same database may depend on them.
  }
}
