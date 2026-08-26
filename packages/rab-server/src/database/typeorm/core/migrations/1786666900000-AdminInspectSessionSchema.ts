import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `admin_inspect_session` — server-side state for "Admin Inspect" (view the
 * app as another user, read-only). Not a FORCE-exemption candidate — every
 * read/write happens after a session is already authenticated (the admin's
 * own real token), exactly like `platform_admin_claim`/`organisation_member`.
 * No backfill: this is a brand-new capability with no prior data to recover.
 */
export class AdminInspectSessionSchema1786666900000 implements MigrationInterface {
  name = 'AdminInspectSessionSchema1786666900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE core.admin_inspect_session (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id   uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        admin_user_id     uuid NOT NULL REFERENCES core."user"(id) ON DELETE CASCADE,
        target_user_id    uuid NOT NULL REFERENCES core."user"(id) ON DELETE CASCADE,
        started_at        timestamptz NOT NULL DEFAULT now(),
        ended_at          timestamptz
      );
    `);
    // Partial index — the only lookup this table ever needs is "does this
    // admin currently have a live session", so index just that slice.
    await queryRunner.query(`
      CREATE INDEX admin_inspect_session_active_idx ON core.admin_inspect_session (admin_user_id, organisation_id)
        WHERE ended_at IS NULL;
    `);
    await queryRunner.query(`ALTER TABLE core.admin_inspect_session ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.admin_inspect_session FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY admin_inspect_session_tenant ON core.admin_inspect_session
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS core.admin_inspect_session`);
  }
}
