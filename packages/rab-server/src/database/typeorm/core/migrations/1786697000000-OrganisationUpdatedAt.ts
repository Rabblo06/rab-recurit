import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Redis checkpoint — Core Entity Cache. Every other cacheable entity in this schema
 * (`core.user`, `core.manager_profile`, `core.manager_workspace`, `venue`) already carries an
 * `updated_at` column via TypeORM's `@UpdateDateColumn`; `core.organisation` is the one exception
 * — it has `created_at` and a narrow `security_version` (bumped only for the three auth-provider
 * toggles, never for `name`/`logo_file_id`/`settings`/`timezone`). Without a column that changes on
 * every mutation, `OrganisationDisplayCacheKey` would have had no way to bake "this row changed" into
 * the cache key the way every other entity's cache entry does (the same version-in-key pattern
 * `AuthContextCacheService` already established — see its own doc comment for why that pattern
 * closes a concurrent-fill race that bare TTL + explicit delete cannot).
 *
 * Nullable-free, `DEFAULT now()`: every existing row gets a real value immediately, no backfill
 * script needed.
 */
export class OrganisationUpdatedAt1786697000000 implements MigrationInterface {
  name = 'OrganisationUpdatedAt1786697000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.organisation ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.organisation DROP COLUMN updated_at;`);
  }
}
