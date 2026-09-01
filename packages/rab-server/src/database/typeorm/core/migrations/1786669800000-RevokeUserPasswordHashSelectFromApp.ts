import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stage 2A final verification — a real, confirmed gap found while proving
 * "User A cannot read User B's private identity/security rows merely
 * because they share an organisation" for `core."user"`.
 *
 * `User.passwordHash` has TypeORM's `select: false` — an ORM-level
 * convention that excludes it from ordinary `find`/`findOne` results, NOT a
 * database-level restriction. `information_schema.column_privileges`
 * confirmed `rab_app` holds plain TABLE-WIDE SELECT on `core."user"`
 * (`GRANT SELECT ON core."user" TO rab_app`, from `IdentitySchema
 * 1786665800000`'s original blanket per-table grants) — and a column-level
 * `REVOKE SELECT (password_hash)` alone does NOT narrow that, confirmed
 * empirically: applying it and re-checking `column_privileges` still showed
 * `rab_app` with SELECT on `password_hash`, because Postgres's table-wide
 * grant is a broader privilege that a column-level REVOKE cannot override —
 * only revoking the table-wide grant and re-granting column-by-column
 * actually restricts it. `user_select`'s RLS policy is also deliberately
 * org-scoped (`organisation_id = current_org()`), not user-scoped —
 * necessary so a Manager creating/administering another user's account can
 * see the row they just created (the same SELECT-precondition-for-writes
 * constraint documented in `SelectPreconditionForWritesRlsFix
 * 1786669300000`). The combination meant a raw, parameterized SQL query
 * (bypassing the ORM's default-select behaviour) bound to any authenticated
 * user's session could read ANY other user's argon2id hash — and, for the
 * same reason, their TOTP secret — within the same organisation.
 *
 * Fix: revoke the table-wide SELECT grant entirely and re-grant it only on
 * every column except `password_hash`/`totp_secret_encrypted` (the two
 * genuinely secret columns on this table). Not currently exploitable — no
 * controller/service in this codebase ever issues such a query; every real
 * read of `passwordHash` goes through `core.auth_find_users_by_email`, a
 * SECURITY DEFINER function that executes with the FUNCTION OWNER's
 * privileges regardless of the calling role's own grants, so this REVOKE
 * has zero effect on it. Every direct `rab_app` touch of these two columns
 * elsewhere in the app is a write (`manager.update(User, id,
 * {passwordHash, ...})` on account creation/password change), which needs
 * UPDATE privilege, not SELECT, and is untouched here. This is
 * defense-in-depth, not a fix for an active exploit: closing the DB-level
 * gap so it can never become exploitable through a future code path
 * without a deliberate, separate grant.
 *
 * A column-level `REVOKE`/`GRANT` is a different Postgres privilege
 * dimension from RLS entirely — this does not touch `user_select` or any
 * other policy, and does not narrow who can see a `user` row, only which
 * columns of it `rab_app` may read directly.
 */
export class RevokeUserPasswordHashSelectFromApp1786669800000 implements MigrationInterface {
  name = 'RevokeUserPasswordHashSelectFromApp1786669800000';

  private readonly safeColumns = [
    'id',
    'organisation_id',
    'email',
    'first_name',
    'last_name',
    'phone',
    'status',
    'last_login_at',
    'totp_enabled',
    'deleted_at',
    'created_at',
    'updated_at',
    'must_reset_password',
    'avatar_key',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`REVOKE SELECT ON core."user" FROM rab_app;`);
    await queryRunner.query(`GRANT SELECT (${this.safeColumns.join(', ')}) ON core."user" TO rab_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`REVOKE SELECT (${this.safeColumns.join(', ')}) ON core."user" FROM rab_app;`);
    await queryRunner.query(`GRANT SELECT ON core."user" TO rab_app;`);
  }
}
