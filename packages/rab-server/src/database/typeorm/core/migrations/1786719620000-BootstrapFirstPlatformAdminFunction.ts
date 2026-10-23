import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Foundation fix P2 (2026-10-22): `bootstrap-admin` cannot create the first Platform Admin as anything but a superuser.
 *
 * Root cause: `BootstrapAdminCommand` predates the role split. It wrote `core.organisation`, `core."user"` and
 * `core.platform_admin` directly, relying on the old `rab_owner` being their table owner (NOT FORCE ⇒ owner bypasses
 * RLS). After `CrewflowSingleCredentialRoleArchitecture1786682000000` those tables belong to the NOLOGIN
 * `rab_secure_owner`, `rab_owner` cannot log in, and `crewflow` is (deliberately) never a member of `rab_secure_owner`.
 * As `crewflow` the command fails at `INSERT INTO core.organisation` ("new row violates row-level security policy"), and
 * the policies that could admit the write (`create_organisation()`, `platform_admin_write`) both require an ALREADY
 * active platform admin — the chicken-and-egg the first admin cannot satisfy. The only working path was an undocumented
 * manual run as the database superuser.
 *
 * Fix: one narrow SECURITY DEFINER function — the same pattern as `create_organisation`/`provision_workspace` — that
 * performs ONLY the first-admin bootstrap, atomically and idempotently, under the command's existing advisory lock:
 *
 *   core.bootstrap_first_platform_admin(p_email, p_first_name, p_last_name, p_org_slug, p_org_name)
 *     → (outcome, user_id, organisation_id, created_user, created_organisation)
 *
 *   1. `pg_advisory_xact_lock(hashtext('rab_bootstrap_platform_admin'))` — the key `BootstrapAdminCommand` already used,
 *      so concurrent boots/replicas serialise and the loser sees the winner's committed admin.
 *   2. ONE-TIME: if an active platform admin exists → ALREADY_BOOTSTRAPPED (returns that admin; changes nothing). If
 *      platform_admin rows exist but none is active → CLOSED (changes nothing). Bootstrap is open only on a database
 *      that has never had a platform admin, so this function can never mint a second or a replacement administrator.
 *   3. Resolution rules are the command's existing ones, moved here verbatim so they run atomically with the writes:
 *      an existing non-deleted user with that email is granted (GRANTED_EXISTING; more than one match → refused, never a
 *      guess); otherwise the organisation is the explicit slug (found or created), else the only organisation, else a new
 *      'platform' organisation when none exists; several organisations without a slug → refused. A new user is created
 *      INVITED with NO password (CREATED_INVITED) — activation stays the existing emailed-token flow.
 *   4. `platform_admin` row inserted (granted_by NULL: there is no human actor at bootstrap).
 *
 * Authorisation: owned by `rab_secure_owner` (the owner of the three NOT-FORCEd tables it writes); PUBLIC EXECUTE revoked;
 * EXECUTE granted to `crewflow` ONLY — the operator/migration identity that already runs every other one-off command.
 * `crewflow_app` (API/Worker runtime) gets NOTHING: a request path can never reach it. No role gains a table privilege,
 * membership, BYPASSRLS or ownership; FORCE RLS everywhere else is unchanged. Everything after the grant (operational
 * CEO role, activation invite, audit) is done by the command as `crewflow` under ordinary FORCE RLS with tenant context
 * bound — see bootstrap-admin.command.ts.
 */
export class BootstrapFirstPlatformAdminFunction1786719620000 implements MigrationInterface {
  name = 'BootstrapFirstPlatformAdminFunction1786719620000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION core.bootstrap_first_platform_admin(
        p_email public.citext, p_first_name text, p_last_name text, p_org_slug public.citext, p_org_name text
      )
      RETURNS TABLE (outcome text, user_id uuid, organisation_id uuid, created_user boolean, created_organisation boolean)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
      AS $$
      DECLARE
        v_email text := lower(btrim(coalesce(p_email::text, '')));
        v_slug text := nullif(lower(btrim(coalesce(p_org_slug::text, ''))), '');
        v_first text := coalesce(nullif(btrim(coalesce(p_first_name, '')), ''), 'Admin');
        v_last text := btrim(coalesce(p_last_name, ''));
        v_org_name text := coalesce(nullif(btrim(coalesce(p_org_name, '')), ''), 'Platform');
        v_user uuid;
        v_org uuid;
        v_matches integer;
        v_created_user boolean := false;
        v_created_org boolean := false;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('rab_bootstrap_platform_admin'));

        -- One-time: never a second, never a replacement administrator.
        SELECT pa.user_id, u.organisation_id INTO v_user, v_org
          FROM core.platform_admin pa JOIN core."user" u ON u.id = pa.user_id
         WHERE pa.revoked_at IS NULL
         ORDER BY pa.granted_at, pa.user_id
         LIMIT 1;
        IF v_user IS NOT NULL THEN
          RETURN QUERY SELECT 'ALREADY_BOOTSTRAPPED'::text, v_user, v_org, false, false;
          RETURN;
        END IF;
        IF EXISTS (SELECT 1 FROM core.platform_admin) THEN
          RETURN QUERY SELECT 'CLOSED'::text, NULL::uuid, NULL::uuid, false, false;
          RETURN;
        END IF;

        IF v_email = '' OR length(v_email) > 320 OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' THEN
          RAISE EXCEPTION 'bootstrap_first_platform_admin: a valid email address is required' USING ERRCODE = 'invalid_parameter_value';
        END IF;
        IF length(v_first) > 200 OR length(v_last) > 200 OR length(v_org_name) > 200 THEN
          RAISE EXCEPTION 'bootstrap_first_platform_admin: name too long' USING ERRCODE = 'invalid_parameter_value';
        END IF;
        IF v_slug IS NOT NULL AND v_slug !~ '^[a-z0-9][a-z0-9-]{0,62}$' THEN
          RAISE EXCEPTION 'bootstrap_first_platform_admin: organisation slug must be lowercase letters, digits and hyphens' USING ERRCODE = 'invalid_parameter_value';
        END IF;

        -- An existing account with this email is granted, never duplicated; more than one match is never guessed.
        SELECT count(*) INTO v_matches FROM core."user" u WHERE u.email OPERATOR(public.=) v_email::public.citext AND u.deleted_at IS NULL;
        IF v_matches > 1 THEN
          RETURN QUERY SELECT 'REFUSED_AMBIGUOUS_EMAIL'::text, NULL::uuid, NULL::uuid, false, false;
          RETURN;
        END IF;
        IF v_matches = 1 THEN
          SELECT u.id, u.organisation_id INTO v_user, v_org FROM core."user" u WHERE u.email OPERATOR(public.=) v_email::public.citext AND u.deleted_at IS NULL;
        ELSE
          IF v_slug IS NOT NULL THEN
            SELECT o.id INTO v_org FROM core.organisation o WHERE o.slug OPERATOR(public.=) v_slug::public.citext;
            IF v_org IS NULL THEN
              INSERT INTO core.organisation (name, slug) VALUES (v_org_name, v_slug::public.citext) RETURNING id INTO v_org;
              v_created_org := true;
            END IF;
          ELSE
            SELECT count(*) INTO v_matches FROM core.organisation;
            IF v_matches = 0 THEN
              INSERT INTO core.organisation (name, slug) VALUES ('Platform', 'platform'::public.citext) RETURNING id INTO v_org;
              v_created_org := true;
            ELSIF v_matches = 1 THEN
              SELECT o.id INTO v_org FROM core.organisation o;
            ELSE
              RETURN QUERY SELECT 'REFUSED_AMBIGUOUS_ORGANISATION'::text, NULL::uuid, NULL::uuid, false, false;
              RETURN;
            END IF;
          END IF;
          -- INVITED with no password: cannot authenticate until the emailed activation link is used.
          INSERT INTO core."user" (organisation_id, email, first_name, last_name, status)
          VALUES (v_org, v_email::public.citext, v_first, v_last, 'invited')
          RETURNING id INTO v_user;
          v_created_user := true;
        END IF;

        INSERT INTO core.platform_admin (user_id, granted_by) VALUES (v_user, NULL);

        RETURN QUERY SELECT CASE WHEN v_created_user THEN 'CREATED_INVITED' ELSE 'GRANTED_EXISTING' END,
                            v_user, v_org, v_created_user, v_created_org;
      END
      $$;
    `);
    await queryRunner.query(`ALTER FUNCTION core.bootstrap_first_platform_admin(public.citext, text, text, public.citext, text) OWNER TO rab_secure_owner;`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.bootstrap_first_platform_admin(public.citext, text, text, public.citext, text) FROM PUBLIC;`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.bootstrap_first_platform_admin(public.citext, text, text, public.citext, text) FROM crewflow_app;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.bootstrap_first_platform_admin(public.citext, text, text, public.citext, text) TO crewflow;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.bootstrap_first_platform_admin(public.citext, text, text, public.citext, text);`);
  }
}
