import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Account/password lifecycle (rab-workforce-architecture.md §5.7, CLAUDE.md
 * audit_log rule): `must_reset_password` forces a password change before a
 * new account (or an admin-reset one) can do anything else —
 * `MustResetPasswordGuard` is the server-side enforcement, this column is
 * what it reads. `password_reset_token` backs three flows off one
 * mechanism (initial setup, forgot-password, admin reset) rather than
 * three separate token tables. `audit_log` is the first general-purpose
 * audit trail in this schema (login_history only ever covered login
 * attempts).
 *
 * SECURITY TRADE-OFF — `password_reset_token` is NOT FORCEd.
 * Decision:   Same exception as `refresh_token` (IdentitySchema1786665800000).
 * Reason:     The forgot-password flow's token-consume step looks a
 *             presented token up BY HASH before any tenant context can be
 *             bound — the token is what tells the caller which
 *             organisation it belongs to, so a forced policy would filter
 *             it to zero rows before that's known. `AuthService`
 *             deliberately runs that one lookup against the unscoped
 *             owner connection, same as refresh-token rotation.
 * Mitigation: Every other read/write of this table (issuing a token at
 *             account-creation or admin-reset time) already has a bound
 *             tenant context and goes through the normal RLS-scoped path;
 *             only the anonymous forgot-password consume step is
 *             pre-auth.
 */
export class AccountLifecycleSchema1786666200000 implements MigrationInterface {
  name = 'AccountLifecycleSchema1786666200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core."user" ADD COLUMN must_reset_password boolean NOT NULL DEFAULT false;
    `);

    await queryRunner.query(`
      CREATE TABLE core.password_reset_token (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id   uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        user_id           uuid NOT NULL REFERENCES core."user"(id) ON DELETE CASCADE,
        token_hash        text NOT NULL UNIQUE,
        purpose           text NOT NULL
                          CHECK (purpose IN ('initial_setup','forgot_password','admin_reset')),
        expires_at        timestamptz NOT NULL,
        used_at           timestamptz,
        created_at        timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX password_reset_token_user_idx ON core.password_reset_token (user_id);
    `);
    // Not FORCEd — see the SECURITY TRADE-OFF note above this class.
    await queryRunner.query(`ALTER TABLE core.password_reset_token ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY password_reset_token_tenant ON core.password_reset_token
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);

    await queryRunner.query(`
      CREATE TABLE core.audit_log (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id   uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        actor_user_id     uuid REFERENCES core."user"(id) ON DELETE SET NULL,
        target_user_id    uuid REFERENCES core."user"(id) ON DELETE SET NULL,
        action            text NOT NULL,
        metadata          jsonb NOT NULL DEFAULT '{}',
        created_at        timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX audit_log_org_time_idx ON core.audit_log (organisation_id, created_at DESC);
      CREATE INDEX audit_log_target_idx ON core.audit_log (target_user_id) WHERE target_user_id IS NOT NULL;
    `);
    await queryRunner.query(`ALTER TABLE core.audit_log ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.audit_log FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY audit_log_tenant ON core.audit_log
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);
    // Insert-only at the grant level, not just convention (CLAUDE.md) — no
    // update/delete route is ever added for this table at the application
    // layer either.
    await queryRunner.query(`REVOKE UPDATE, DELETE ON core.audit_log FROM rab_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS core.audit_log`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.password_reset_token`);
    await queryRunner.query(`ALTER TABLE core."user" DROP COLUMN must_reset_password;`);
  }
}
