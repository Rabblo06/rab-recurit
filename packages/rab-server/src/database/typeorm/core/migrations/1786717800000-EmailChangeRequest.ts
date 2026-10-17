import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CF-04 (October 15 audit): changing another user's login email must not be an account takeover. Before this, an
 * administrator's PATCH wrote `user.email` directly; a password reset then mailed a link to the NEW address, the victim's
 * sessions stayed alive and the old owner was never told.
 *
 * `core.email_change_request` holds a pending change for an ACTIVE account. The old address stays authoritative until the
 * new address proves control by redeeming a single-use, hashed, expiring token (EmailChangeService). Only the SHA-256 of
 * the token is stored; the raw token exists only in the email to the new address.
 *
 * Isolation: organisation_id + composite FK (user_id, organisation_id) → user(id, organisation_id), so a request can only
 * name a user of its own organisation. ENABLE RLS with USING/WITH CHECK on organisation_id = current_org(). At most one
 * open request per user (partial unique index). No DELETE grant: history is kept (cancelled_at / confirmed_at).
 *
 * SECURITY TRADE-OFF (same class as password_reset_token / account_invite, recorded in tools/check-rls-coverage.ts
 * NOT_FORCED_ALLOWLIST): the confirmation endpoint is pre-auth. It must learn which organisation a bare presented token
 * belongs to before any tenant context can exist, through the SECURITY DEFINER `core.auth_find_email_change_request(hash)`.
 * FORCE would bind the owner inside that function too, so the table is owned by `rab_secure_owner` and NOT forced.
 * `crewflow_app` is never the owner and stays fully bound by the policy.
 *
 * Needs the privileged bootstrap identity (it assigns ownership to rab_secure_owner), like every post-split migration.
 */
export class EmailChangeRequest1786717800000 implements MigrationInterface {
  name = 'EmailChangeRequest1786717800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE core.email_change_request (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        user_id         uuid NOT NULL,
        new_email       citext NOT NULL,
        token_hash      text NOT NULL UNIQUE,
        requested_by    uuid REFERENCES core."user"(id) ON DELETE SET NULL,
        created_at      timestamptz NOT NULL DEFAULT now(),
        expires_at      timestamptz NOT NULL,
        confirmed_at    timestamptz,
        cancelled_at    timestamptz,
        cancel_reason   text,
        CONSTRAINT email_change_request_user_fkey FOREIGN KEY (user_id, organisation_id)
          REFERENCES core."user"(id, organisation_id) ON DELETE CASCADE,
        CONSTRAINT email_change_request_expiry_check CHECK (expires_at > created_at),
        CONSTRAINT email_change_request_single_outcome CHECK (NOT (confirmed_at IS NOT NULL AND cancelled_at IS NOT NULL)),
        CONSTRAINT email_change_request_token_hash_shape CHECK (token_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT email_change_request_cancel_reason_length CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 64)
      );
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX email_change_request_one_open_per_user ON core.email_change_request (user_id)
        WHERE confirmed_at IS NULL AND cancelled_at IS NULL;
    `);
    await queryRunner.query(`ALTER TABLE core.email_change_request ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY email_change_request_tenant ON core.email_change_request
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);
    await queryRunner.query(`ALTER TABLE core.email_change_request OWNER TO rab_secure_owner;`);
    await queryRunner.query(`REVOKE ALL ON core.email_change_request FROM PUBLIC;`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON core.email_change_request TO crewflow, crewflow_app;`);

    await queryRunner.query(`
      CREATE FUNCTION core.auth_find_email_change_request(p_token_hash text)
      RETURNS TABLE ("requestId" uuid, "organisationId" uuid, "userId" uuid)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
      AS $function$
        SELECT r.id, r.organisation_id, r.user_id
          FROM core.email_change_request r
         WHERE r.token_hash = p_token_hash
      $function$;
    `);
    await queryRunner.query(`ALTER FUNCTION core.auth_find_email_change_request(text) OWNER TO rab_secure_owner;`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.auth_find_email_change_request(text) FROM PUBLIC;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.auth_find_email_change_request(text) TO crewflow, crewflow_app;`);

    // On a confirmed email change, Google/Microsoft links bound to the old identity are removed: they re-link only through a
    // provider-verified match of the NEW address (a provider subject is never transferred silently). `crewflow_app` has no
    // DELETE on core.user_auth_identity, by design; this narrow function is the one removal path, and only for a user of
    // the caller's own bound organisation (fails closed without one).
    await queryRunner.query(`
      CREATE FUNCTION core.unlink_provider_identities_for_user(p_user_id uuid)
      RETURNS integer
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
      AS $function$
      DECLARE
        v_org uuid := nullif(current_setting('rab.organisation_id', true), '')::uuid;
        v_count integer;
      BEGIN
        IF v_org IS NULL THEN
          RAISE EXCEPTION 'organisation context required' USING ERRCODE = 'insufficient_privilege';
        END IF;
        DELETE FROM core.user_auth_identity WHERE user_id = p_user_id AND organisation_id = v_org;
        GET DIAGNOSTICS v_count = ROW_COUNT;
        RETURN v_count;
      END
      $function$;
    `);
    await queryRunner.query(`ALTER FUNCTION core.unlink_provider_identities_for_user(uuid) OWNER TO rab_secure_owner;`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.unlink_provider_identities_for_user(uuid) FROM PUBLIC;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.unlink_provider_identities_for_user(uuid) TO crewflow, crewflow_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.unlink_provider_identities_for_user(uuid);`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.auth_find_email_change_request(text);`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.email_change_request;`);
  }
}
