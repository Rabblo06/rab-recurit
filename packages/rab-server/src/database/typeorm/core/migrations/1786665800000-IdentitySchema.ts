import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Identity schema (rab-workforce-architecture.md §11 "IDENTITY", §5.7).
 * Every organisation-scoped table gets RLS `ENABLE` + a policy in this same
 * migration — no follow-up PR (CLAUDE.md). `permission` is global reference
 * data (no `organisation_id`, no RLS — every tenant reads the same
 * catalogue). `organisation` itself has no `organisation_id` column (it IS
 * the tenant) but still gets RLS keyed on its own `id`.
 *
 * SECURITY TRADE-OFF — `organisation`, `user`, `login_history` and
 * `refresh_token` are NOT `FORCE`d.
 * Decision:   Skip FORCE ROW LEVEL SECURITY on these four tables only.
 * Reason:     Login and refresh are both chicken-and-egg problems: verifying
 *             credentials requires reading the `user` row (and resolving
 *             `organisation` by slug, and counting recent failures in
 *             `login_history` for lockout); rotating a refresh token
 *             requires looking `refresh_token` up BY HASH. Both happen
 *             BEFORE any tenant context exists to satisfy a forced policy —
 *             there is no `organisation_id` to bind yet; finding it out is
 *             the whole point of the lookup. Every other table is only ever
 *             touched after a session is established, so FORCE applies to
 *             all of them.
 * Risk:       `rab_owner` (table owner, NOBYPASSRLS but no FORCE) can read
 *             across every organisation's rows on these four tables. A
 *             compromised `rab_owner` credential already has full DDL
 *             control of the whole schema (it runs migrations), so this
 *             doesn't materially widen that blast radius.
 * Mitigation: `rab_owner` credentials are used ONLY for migrations and the
 *             pre-auth login/refresh lookups (`AuthService`) — never for
 *             ordinary per-request handling, which always runs as `rab_app`
 *             (NOBYPASSRLS, and RLS applies to it fully regardless of FORCE,
 *             since FORCE only changes behaviour for the table owner).
 *             `login_history` and `refresh_token` still carry their own
 *             tenant-scoped policy (meaningful for any future non-owner
 *             reader, e.g. a "my devices" endpoint reading `refresh_token`
 *             as `rab_app`).
 * Reversal:   Once a slug/subdomain-based org resolution step exists that
 *             can run through a narrower, purpose-built lookup path (e.g. a
 *             `SECURITY DEFINER` function scoped to exactly one query), FORCE
 *             can be added back here and that path used instead.
 */
export class IdentitySchema1786665800000 implements MigrationInterface {
  name = 'IdentitySchema1786665800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE core.organisation (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name        text NOT NULL,
        slug        citext NOT NULL UNIQUE,
        legal_name  text,
        address     jsonb NOT NULL DEFAULT '{}',
        contact     jsonb NOT NULL DEFAULT '{}',
        logo_key    text,
        timezone    text NOT NULL DEFAULT 'Europe/London',
        settings    jsonb NOT NULL DEFAULT '{}',
        created_at  timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`ALTER TABLE core.organisation ENABLE ROW LEVEL SECURITY;`);
    // Not FORCEd — see the SECURITY TRADE-OFF note above this class.
    await queryRunner.query(`
      CREATE POLICY organisation_self ON core.organisation
        USING (id = core.current_org())
        WITH CHECK (id = core.current_org());
    `);

    await queryRunner.query(`
      CREATE TABLE core."user" (
        id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id         uuid NOT NULL REFERENCES core.organisation(id) ON DELETE RESTRICT,
        email                   citext NOT NULL,
        password_hash           text NOT NULL,
        first_name              text NOT NULL,
        last_name               text NOT NULL,
        phone                   text,
        status                  text NOT NULL DEFAULT 'invited'
                                CHECK (status IN ('invited','active','suspended','deactivated')),
        last_login_at           timestamptz,
        totp_secret_encrypted   bytea,
        totp_enabled            boolean NOT NULL DEFAULT false,
        deleted_at              timestamptz,
        created_at              timestamptz NOT NULL DEFAULT now(),
        updated_at              timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX user_org_email_idx ON core."user" (organisation_id, email) WHERE deleted_at IS NULL;
      CREATE INDEX user_org_idx ON core."user" (organisation_id);
    `);
    await queryRunner.query(`ALTER TABLE core."user" ENABLE ROW LEVEL SECURITY;`);
    // Not FORCEd — see the SECURITY TRADE-OFF note above this class.
    await queryRunner.query(`
      CREATE POLICY user_tenant ON core."user"
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);

    await queryRunner.query(`
      CREATE TABLE core.role (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id   uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        key               text NOT NULL,
        name              text NOT NULL,
        is_system         boolean NOT NULL DEFAULT false,
        UNIQUE (organisation_id, key)
      );
    `);
    await queryRunner.query(`ALTER TABLE core.role ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.role FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY role_tenant ON core.role
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);

    // Global reference data — no organisation_id, no RLS. Every tenant
    // reads the same permission catalogue.
    await queryRunner.query(`
      CREATE TABLE core.permission (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        key           text NOT NULL UNIQUE,
        resource      text NOT NULL,
        action        text NOT NULL,
        description   text
      );
    `);

    await queryRunner.query(`
      CREATE TABLE core.role_permission (
        role_id           uuid NOT NULL REFERENCES core.role(id) ON DELETE CASCADE,
        permission_id     uuid NOT NULL REFERENCES core.permission(id) ON DELETE CASCADE,
        organisation_id   uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        PRIMARY KEY (role_id, permission_id)
      );
    `);
    await queryRunner.query(`ALTER TABLE core.role_permission ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.role_permission FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY role_permission_tenant ON core.role_permission
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);

    await queryRunner.query(`
      CREATE TABLE core.user_role (
        user_id           uuid NOT NULL REFERENCES core."user"(id) ON DELETE CASCADE,
        role_id           uuid NOT NULL REFERENCES core.role(id) ON DELETE CASCADE,
        organisation_id   uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, role_id)
      );
    `);
    await queryRunner.query(`ALTER TABLE core.user_role ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.user_role FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY user_role_tenant ON core.user_role
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);

    await queryRunner.query(`
      CREATE TABLE core.user_permission_override (
        user_id           uuid NOT NULL REFERENCES core."user"(id) ON DELETE CASCADE,
        permission_id     uuid NOT NULL REFERENCES core.permission(id) ON DELETE CASCADE,
        organisation_id   uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        effect            text NOT NULL CHECK (effect IN ('grant','revoke')),
        PRIMARY KEY (user_id, permission_id)
      );
    `);
    await queryRunner.query(`ALTER TABLE core.user_permission_override ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.user_permission_override FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY user_permission_override_tenant ON core.user_permission_override
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);

    await queryRunner.query(`
      CREATE TABLE core.refresh_token (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id   uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        user_id           uuid NOT NULL REFERENCES core."user"(id) ON DELETE CASCADE,
        token_hash        text NOT NULL UNIQUE,
        family_id         uuid NOT NULL,
        device_id         text,
        user_agent        text,
        ip                inet,
        expires_at        timestamptz NOT NULL,
        revoked_at        timestamptz,
        replaced_by       uuid REFERENCES core.refresh_token(id),
        created_at        timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX refresh_token_user_expires_idx ON core.refresh_token (user_id, expires_at);
      CREATE INDEX refresh_token_family_idx ON core.refresh_token (family_id);
    `);
    // Not FORCEd — same root cause as organisation/user/login_history above.
    // RefreshTokenService.rotate() looks a presented token up BY HASH, and
    // the caller doesn't know which organisation it belongs to until that
    // lookup returns (that's the whole point of the lookup) — a forced
    // policy would filter it to zero rows before the org is ever known.
    // AuthService.refresh() therefore calls rotate() against the unscoped
    // owner connection, same as the pre-auth user lookup in login().
    await queryRunner.query(`ALTER TABLE core.refresh_token ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY refresh_token_tenant ON core.refresh_token
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);

    await queryRunner.query(`
      CREATE TABLE core.login_history (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id   uuid REFERENCES core.organisation(id) ON DELETE SET NULL,
        user_id           uuid REFERENCES core."user"(id) ON DELETE SET NULL,
        email             text NOT NULL,
        ip                inet,
        user_agent        text,
        success           boolean NOT NULL,
        created_at        timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX login_history_org_time_idx ON core.login_history (organisation_id, created_at DESC);
    `);
    // Split INSERT from SELECT deliberately. A login attempt must always be
    // recordable — including a wrong email that matches no organisation at
    // all (organisation_id NULL), written from a connection with no tenant
    // context bound yet, since login itself is what establishes that
    // context. A single combined USING+WITH CHECK policy would reject every
    // such insert (NULL = current_org() is NULL, which RLS treats as
    // "check failed", not "check passed").
    //
    // Also NOT FORCEd — same SECURITY TRADE-OFF as `organisation`/`user`
    // above: the login lockout check (AuthService) counts recent failed
    // attempts for an email BEFORE any tenant context can be bound, which
    // needs the owner-role bypass same as the credential lookup itself. A
    // bound session (rab_app, never the owner) still only ever sees its own
    // organisation's history through the SELECT policy below.
    await queryRunner.query(`ALTER TABLE core.login_history ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY login_history_insert ON core.login_history
        FOR INSERT WITH CHECK (true);
    `);
    await queryRunner.query(`
      CREATE POLICY login_history_select ON core.login_history
        FOR SELECT USING (organisation_id = core.current_org());
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS core.login_history`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.refresh_token`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.user_permission_override`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.user_role`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.role_permission`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.permission`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.role`);
    await queryRunner.query(`DROP TABLE IF EXISTS core."user"`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.organisation`);
  }
}
