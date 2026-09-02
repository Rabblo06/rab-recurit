import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `core.user` had no uniqueness enforcement on `(organisation_id, email)`
 * at all — only the `id` primary key. `email` is already `citext`, so this
 * index is case-insensitive automatically (citext's own equality operator),
 * but without a real constraint two rows differing only by case — or an
 * exact duplicate — could still coexist as "different" users within the
 * same organisation. Found while inspecting the identity schema for the
 * Platform Admin env-bootstrap work; fixed here since it's a real,
 * pre-existing gap, not something specific to that feature.
 */
export class UserEmailOrgUniqueConstraint1786670000000 implements MigrationInterface {
  name = 'UserEmailOrgUniqueConstraint1786670000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX user_organisation_id_email_key ON core."user" (organisation_id, email);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS core.user_organisation_id_email_key;`);
  }
}
