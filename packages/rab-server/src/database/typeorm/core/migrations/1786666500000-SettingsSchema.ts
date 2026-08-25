import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Settings module (Profile/Experience/Account/Workspace/Roles/Admin Panel).
 *
 * `platform_admin_claim` is the "first legitimate owner" mechanism: its
 * primary key IS `organisation_id`, so `INSERT ... ON CONFLICT
 * (organisation_id) DO NOTHING` is race-safe by construction (exactly one
 * concurrent claim attempt ever wins, enforced by Postgres itself, not by an
 * application-level count/id check) and — because the row is only ever
 * revoked (`revoked_at` set), never deleted — a removed owner can never be
 * silently re-promoted by a later claim attempt hitting the same conflict.
 * Deliberately not a `PermissionFlag`: making it grantable through the
 * existing `user_permission_override` path would let any
 * `user.manage_permissions` holder self-grant it, defeating the entire
 * point of a protected, non-reassignable single owner. Checked only by
 * `PlatformAdminGuard` against this table.
 *
 * `user_preference`, `notification_preference` and `platform_config` are all
 * genuinely tenant-scoped (no pre-auth read path touches any of them), so
 * unlike `organisation`/`user`/`refresh_token`/`login_history`/
 * `password_reset_token`, none of them join the RLS FORCE allowlist — all
 * three get ENABLE + FORCE like every other post-auth-only table in this
 * schema.
 */
export class SettingsSchema1786666500000 implements MigrationInterface {
  name = 'SettingsSchema1786666500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core."user" ADD COLUMN avatar_key text;
    `);

    await queryRunner.query(`
      CREATE TABLE core.platform_admin_claim (
        organisation_id   uuid PRIMARY KEY REFERENCES core.organisation(id) ON DELETE CASCADE,
        user_id           uuid NOT NULL REFERENCES core."user"(id) ON DELETE RESTRICT,
        claimed_at        timestamptz NOT NULL DEFAULT now(),
        revoked_at        timestamptz,
        revoked_by        uuid REFERENCES core."user"(id) ON DELETE SET NULL
      );
    `);
    await queryRunner.query(`ALTER TABLE core.platform_admin_claim ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.platform_admin_claim FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY platform_admin_claim_tenant ON core.platform_admin_claim
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);

    await queryRunner.query(`
      CREATE TABLE core.user_preference (
        user_id             uuid PRIMARY KEY REFERENCES core."user"(id) ON DELETE CASCADE,
        organisation_id     uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        theme               text NOT NULL DEFAULT 'system'
                            CHECK (theme IN ('light','dark','system')),
        nav_preference      text NOT NULL DEFAULT 'side_panel'
                            CHECK (nav_preference IN ('side_panel','full_page')),
        timezone            text,
        date_format         text NOT NULL DEFAULT 'DD/MM/YYYY'
                            CHECK (date_format IN ('DD/MM/YYYY','MM/DD/YYYY','YYYY-MM-DD')),
        time_format         text NOT NULL DEFAULT '24h' CHECK (time_format IN ('12h','24h')),
        first_day_of_week   text NOT NULL DEFAULT 'monday' CHECK (first_day_of_week IN ('monday','sunday')),
        updated_at          timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`ALTER TABLE core.user_preference ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.user_preference FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY user_preference_tenant ON core.user_preference
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);

    // notification_type is CHECK-constrained to the real notify() call
    // sites that exist today (all in offer.service.ts) — not an invented
    // category list.
    await queryRunner.query(`
      CREATE TABLE core.notification_preference (
        user_id             uuid NOT NULL REFERENCES core."user"(id) ON DELETE CASCADE,
        organisation_id     uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        notification_type   text NOT NULL
                            CHECK (notification_type IN
                              ('offer_sent','offer_expired','offer_accepted','offer_declined','offer_confirmed','offer_rejected')),
        in_app_enabled       boolean NOT NULL DEFAULT true,
        email_enabled         boolean NOT NULL DEFAULT false,
        PRIMARY KEY (user_id, notification_type)
      );
    `);
    await queryRunner.query(`ALTER TABLE core.notification_preference ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.notification_preference FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY notification_preference_tenant ON core.notification_preference
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);

    // One row per organisation — SMTP override columns are typed/validated
    // rather than folded into organisation.settings jsonb because they feed
    // directly into nodemailer's transport options, where a malformed value
    // is a send-time failure, not a display bug. smtp_password_encrypted is
    // AES-256-GCM via SecretEncryptionService (same primitive already used
    // for bank details/NI number/TOTP secret), select:false at the entity
    // layer, never returned to the client — only a hasPassword boolean is.
    await queryRunner.query(`
      CREATE TABLE core.platform_config (
        organisation_id            uuid PRIMARY KEY REFERENCES core.organisation(id) ON DELETE CASCADE,
        smtp_host                  text,
        smtp_port                  integer,
        smtp_encryption            text CHECK (smtp_encryption IN ('none','starttls','tls')),
        smtp_username               text,
        smtp_password_encrypted    bytea,
        smtp_from_name              text,
        smtp_from_email             text,
        maintenance_mode_enabled   boolean NOT NULL DEFAULT false,
        maintenance_mode_message   text,
        updated_at                 timestamptz NOT NULL DEFAULT now(),
        updated_by                 uuid REFERENCES core."user"(id) ON DELETE SET NULL
      );
    `);
    await queryRunner.query(`ALTER TABLE core.platform_config ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.platform_config FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY platform_config_tenant ON core.platform_config
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);

    // The seeded "super_admin" role's display name is the literal source of
    // the "Super Admin" string this feature must stop showing anywhere in
    // the UI — the moment Workspace → Roles lists real Role.name values,
    // it would otherwise appear verbatim. `key` is untouched (stable,
    // internal, never renamed).
    await queryRunner.query(`
      UPDATE core.role SET name = 'Administrator' WHERE key = 'super_admin' AND name = 'Super Admin';
    `);

    // Backfill: `PlatformAdminService.tryClaim` only ever fires at
    // user-creation time going forward — an organisation whose users all
    // predate this migration would otherwise end up with NO platform admin
    // at all, permanently, since nothing ever creates a "first user" event
    // for it again. The earliest-created active user per organisation is
    // the most legitimate stand-in for "the first owner" retroactively.
    // Idempotent (ON CONFLICT DO NOTHING) and harmless to re-run; a fresh
    // deployment with zero existing users backfills nothing, and every
    // future organisation gets its owner the normal way, via tryClaim.
    //
    // Same DISABLE/ENABLE+FORCE bracket as OfferConfirmationSchema's status
    // remap: rab_owner is NOBYPASSRLS and this DDL migration runs with no
    // tenant context bound, so a plain cross-tenant INSERT against a FORCEd
    // table would violate WITH CHECK for every row (current_org() is NULL).
    // Table ownership still allows toggling RLS itself; do that for this
    // one backfill, then restore FORCE immediately, in the same migration
    // transaction — every other writer of this table (tryClaim onward)
    // still goes through the normal RLS-scoped path.
    await queryRunner.query(`ALTER TABLE core.platform_admin_claim DISABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      INSERT INTO core.platform_admin_claim (organisation_id, user_id)
      SELECT DISTINCT ON (organisation_id) organisation_id, id
        FROM core."user"
       WHERE deleted_at IS NULL
       ORDER BY organisation_id, created_at ASC
      ON CONFLICT (organisation_id) DO NOTHING;
    `);
    await queryRunner.query(`ALTER TABLE core.platform_admin_claim ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.platform_admin_claim FORCE ROW LEVEL SECURITY;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS core.platform_config`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.notification_preference`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.user_preference`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.platform_admin_claim`);
    await queryRunner.query(`ALTER TABLE core."user" DROP COLUMN avatar_key;`);
  }
}
