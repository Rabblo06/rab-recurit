import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Activates the invitation-based account-activation flow: no password at
 * creation, an emailed one-time activation link, the account sets its own
 * password to become ACTIVE. Reuses `UserStatus.INVITED` (already the
 * column's DEFAULT since IdentitySchema, previously always immediately
 * overridden to ACTIVE by `ManagerService.create`/`StaffService.create`) as
 * the pending state — no new "pending" status needed.
 *
 * Three changes to `core."user"`:
 *  - `password_hash` becomes nullable — a pending account genuinely has no
 *    password yet; no fake/temporary hash is ever written for it.
 *  - `email_verified_at` — set once, at activation, alongside `status`
 *    flipping to ACTIVE (proof the account holder received and clicked the
 *    emailed link to the address on file).
 *  - `user_status_check` (confirmed via `pg_constraint` against the live dev
 *    DB, not assumed) gains `'invite_expired'` — the terminal state a
 *    pending account reaches once its 3rd invitation attempt expires with no
 *    activation (see AccountInviteService's own doc comment for why no path
 *    leads back to INVITED).
 *
 * `core.account_invite` is a new entity, not a repurposed
 * `password_reset_token` — the latter has no per-user attempt-counting or
 * distinct-revocation shape, and conflating "prove you're the intended
 * recipient of a fresh account" with "prove you still know an existing
 * account's credentials" would blur two different lifecycles. Every WRITE
 * to this table happens from an authenticated admin/manager action
 * (`AccountInviteService.issue`, always already inside
 * `runInTenantContext`) — but the public activation endpoint's pre-auth
 * READ (below) needs the same NO-FORCE exemption `password_reset_token`
 * already has, for the identical reason. See the RLS block below for why.
 *
 * `core.auth_find_account_invite_org` is the one pre-auth read this feature
 * needs — the public `/auth/activate-account` endpoint has no tenant
 * context yet when it first sees a raw token, exactly the same shape
 * `auth_find_password_reset_token_org` already solves for `/auth/reset-
 * password` (PreAuthLookupFunctions1786667400000). Same template: SQL
 * LANGUAGE, SECURITY DEFINER, explicit `search_path`, PUBLIC EXECUTE
 * revoked and re-granted only to `rab_app` inline (matching the now-current
 * standard set by RevokePublicOnSecurityDefinerFunctions1786669700000,
 * rather than deferring the revoke to a later cleanup pass). Returns only
 * `organisationId`/`userId` — never the token hash, never any other column.
 * The actual validity/expiry/revocation/single-use check still happens
 * afterward, inside `runInTenantContext`, through the normal RLS-enforced
 * path — this function only answers "which org do I bind context to."
 */
export class AccountInviteSchema1786670100000 implements MigrationInterface {
  name = 'AccountInviteSchema1786670100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core."user" ALTER COLUMN password_hash DROP NOT NULL;`);
    await queryRunner.query(`ALTER TABLE core."user" ADD COLUMN email_verified_at timestamptz;`);
    // `rab_app` holds no table-wide SELECT on core.user — only an explicit
    // per-column allowlist (RevokeUserPasswordHashSelectFromApp1786669800000).
    // A new column needs an explicit grant too, or every ordinary TypeORM
    // `find`/`findOne` on User (which selects every non-`select:false`
    // column, including this one) is rejected outright — confirmed live
    // during this migration's own test run, not assumed.
    await queryRunner.query(`GRANT SELECT (email_verified_at) ON core."user" TO rab_app;`);

    await queryRunner.query(`ALTER TABLE core."user" DROP CONSTRAINT user_status_check;`);
    await queryRunner.query(`
      ALTER TABLE core."user" ADD CONSTRAINT user_status_check
        CHECK (status IN ('invited','active','suspended','deactivated','invite_expired'));
    `);

    await queryRunner.query(`
      CREATE TABLE core.account_invite (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        user_id         uuid NOT NULL REFERENCES core."user"(id) ON DELETE CASCADE,
        token_hash      text NOT NULL UNIQUE,
        send_number     integer NOT NULL,
        expires_at      timestamptz NOT NULL,
        accepted_at     timestamptz,
        revoked_at      timestamptz,
        cleanup_at      timestamptz,
        created_by      uuid,
        created_at      timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`CREATE INDEX account_invite_user_idx ON core.account_invite (user_id);`);
    // The cleanup job's own candidate scan — bounded to rows that are both
    // final-expired and past their grace period, never a full-table scan.
    await queryRunner.query(`CREATE INDEX account_invite_cleanup_idx ON core.account_invite (cleanup_at) WHERE cleanup_at IS NOT NULL;`);

    // SECURITY TRADE-OFF — ENABLE only, deliberately NOT FORCEd. Confirmed
    // live (not assumed) during this migration's own verification: a
    // SECURITY DEFINER function executes with its OWNER's privileges, and
    // FORCE ROW LEVEL SECURITY specifically removes the normal
    // owner-bypasses-RLS exemption — so `auth_find_account_invite_org`
    // below, reading this table pre-auth (before any tenant context can
    // exist to satisfy the policy), would see zero rows if this table were
    // FORCEd, exactly the same chicken-and-egg problem
    // PreAuthLookupFunctions1786667400000 already documented for
    // `organisation`/`user`/`login_history`/`refresh_token`, and
    // PasswordResetTokenRlsFix1786669100000 hit for the identical reason on
    // `password_reset_token` — `account_invite` joins that same, now
    // 8-table, allowlist (`tools/check-rls-coverage.ts`'s
    // NOT_FORCED_ALLOWLIST, updated in this same change) for the same
    // structural reason: `/auth/activate-account` is public, so this is the
    // one lookup that must resolve an organisation from a bare token before
    // any tenant context exists. `rab_app` (not the table owner, no
    // BYPASSRLS) is still fully restricted by the policy below regardless —
    // only FORCE (i.e. restricting the owner too) is skipped.
    await queryRunner.query(`ALTER TABLE core.account_invite ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY account_invite_tenant ON core.account_invite
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);

    await queryRunner.query(`
      CREATE FUNCTION core.auth_find_account_invite_org(p_token_hash text)
      RETURNS TABLE ("organisationId" uuid, "userId" uuid)
      LANGUAGE sql SECURITY DEFINER SET search_path = core, pg_catalog
      AS $$
        SELECT organisation_id, user_id FROM core.account_invite WHERE token_hash = p_token_hash;
      $$;
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.auth_find_account_invite_org(text) FROM PUBLIC;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.auth_find_account_invite_org(text) TO rab_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.auth_find_account_invite_org(text);`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.account_invite;`);
    await queryRunner.query(`ALTER TABLE core."user" DROP CONSTRAINT IF EXISTS user_status_check;`);
    await queryRunner.query(`
      ALTER TABLE core."user" ADD CONSTRAINT user_status_check
        CHECK (status IN ('invited','active','suspended','deactivated'));
    `);
    await queryRunner.query(`ALTER TABLE core."user" DROP COLUMN IF EXISTS email_verified_at;`);
    await queryRunner.query(`ALTER TABLE core."user" ALTER COLUMN password_hash SET NOT NULL;`);
  }
}
