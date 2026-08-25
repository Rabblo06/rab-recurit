import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `organisation_member` — Increment 1 of the User/membership decoupling.
 * Purely additive: no existing column, FK, or query is touched.
 * `StaffProfile.userId`, `ManagerProfile.userId`, `UserRole.userId` and
 * `AuthContext.userId` all still resolve against `core."user"` directly,
 * unchanged.
 *
 * Not a FORCE-exemption candidate — no pre-auth read path touches this
 * table (it's only ever read/written after a session is authenticated),
 * exactly like `role`/`user_role`. ENABLE + FORCE + one tenant policy,
 * same as every other post-auth-only table in this schema.
 *
 * Backfill covers EVERY row in core."user", including soft-deleted ones —
 * unlike `platform_admin_claim`'s backfill (which deliberately picks one
 * "earliest active user" per org as an owner proxy), this is a neutral
 * 1:1 structural mapping with no selection semantics, so it must be
 * total, not filtered.
 */
export class OrganisationMemberSchema1786666600000 implements MigrationInterface {
  name = 'OrganisationMemberSchema1786666600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE core.organisation_member (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id   uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        user_id           uuid NOT NULL REFERENCES core."user"(id) ON DELETE CASCADE,
        status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        UNIQUE (user_id, organisation_id)
      );
    `);
    await queryRunner.query(`CREATE INDEX organisation_member_org_idx ON core.organisation_member (organisation_id);`);
    await queryRunner.query(`ALTER TABLE core.organisation_member ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.organisation_member FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY organisation_member_tenant ON core.organisation_member
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);

    // Backfill — same DISABLE/ENABLE+FORCE bracket as SettingsSchema
    // 1786666500000's platform_admin_claim backfill: this migration runs
    // with no tenant context bound, and rab_owner is NOBYPASSRLS, so a
    // plain cross-tenant INSERT against a FORCEd table would violate
    // WITH CHECK for every row (current_org() is NULL). Table ownership
    // still allows toggling RLS itself; do that for this one backfill,
    // then restore FORCE immediately, in the same migration transaction.
    await queryRunner.query(`ALTER TABLE core.organisation_member DISABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      INSERT INTO core.organisation_member (organisation_id, user_id)
      SELECT organisation_id, id FROM core."user"
      ON CONFLICT (user_id, organisation_id) DO NOTHING;
    `);
    await queryRunner.query(`ALTER TABLE core.organisation_member ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.organisation_member FORCE ROW LEVEL SECURITY;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS core.organisation_member`);
  }
}
