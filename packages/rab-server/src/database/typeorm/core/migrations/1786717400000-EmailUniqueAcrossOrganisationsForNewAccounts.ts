import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Owner policy (2026-10-15): a NEW account, or an email change, may not use an email address that already belongs to a live account
 * in ANOTHER organisation — until a deliberate multi-organisation identity design exists. Existing (historical) duplicates are left
 * exactly as they are: nothing is deleted, merged, moved, suspended or rewritten, and a row's unrelated updates keep working.
 *
 * Why a trigger, not a UNIQUE index: a global unique index on email cannot be built while historical duplicates exist, and would
 * also forbid updating them. The trigger fires only when an account's email identity is being established or changed (INSERT, or
 * UPDATE of email / organisation_id / un-deleting), so it is the single authoritative control for EVERY creation path — services,
 * member-invitation acceptance, bootstrap and seed CLIs alike — with no per-controller checks to keep in sync.
 *
 * Race safety: `pg_advisory_xact_lock` on the canonical email serialises every transaction establishing that address, and the
 * existence check runs inside a VOLATILE plpgsql function (a fresh snapshot per statement under READ COMMITTED), so the second of
 * two concurrent creations sees the first one's committed row and is refused. "SELECT … then INSERT" in application code alone
 * could not give this guarantee.
 *
 * Privacy: the error carries a fixed message and a fixed constraint name only — never which organisation, role or status holds
 * the address. `AllExceptionsFilter` maps it to one generic 409 (`EMAIL_UNAVAILABLE`).
 *
 * `core.email_registered_in_another_organisation(email)` answers a single boolean for member invitations (so an unusable invite is
 * never sent). The "other" organisation is everything except the CALLER's bound `core.current_org()` — never a parameter — so it
 * cannot be pointed at a chosen organisation; with no tenant bound it answers true (fail closed). Callers must be rate limited.
 *
 * Both functions are SECURITY DEFINER owned by `rab_secure_owner` (the owner of the not-FORCEd `core.user`, the same arrangement as
 * `auth_find_users_by_email`), with a pinned search_path. Canonical form = `@rab/shared` `normalizeEmail` (trim + lowercase); the
 * column is citext. No data is changed by this migration.
 */
export class EmailUniqueAcrossOrganisationsForNewAccounts1786717400000 implements MigrationInterface {
  name = 'EmailUniqueAcrossOrganisationsForNewAccounts1786717400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION core.guard_user_email_unique_across_organisations() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, pg_catalog
      AS $$
      DECLARE
        canonical text;
      BEGIN
        IF NEW.deleted_at IS NOT NULL THEN
          RETURN NEW;
        END IF;
        IF TG_OP = 'UPDATE'
           AND NEW.email IS NOT DISTINCT FROM OLD.email
           AND NEW.organisation_id IS NOT DISTINCT FROM OLD.organisation_id
           AND OLD.deleted_at IS NULL THEN
          -- Not establishing or changing this account's email identity (e.g. any update of a historical duplicate): untouched.
          RETURN NEW;
        END IF;
        canonical := lower(btrim(NEW.email::text));
        NEW.email := canonical;
        PERFORM pg_advisory_xact_lock(hashtextextended('crewflow:core.user.email:' || canonical, 0));
        IF EXISTS (
          SELECT 1 FROM core."user" u
           WHERE u.email OPERATOR(public.=) canonical::public.citext
             AND u.organisation_id <> NEW.organisation_id
             AND u.deleted_at IS NULL
             AND u.id <> NEW.id
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = 'unique_violation',
            CONSTRAINT = 'user_email_registered_in_another_organisation',
            MESSAGE = 'This email address is not available for a new account.';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    await queryRunner.query(`ALTER FUNCTION core.guard_user_email_unique_across_organisations() OWNER TO rab_secure_owner;`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.guard_user_email_unique_across_organisations() FROM PUBLIC;`);
    await queryRunner.query(`
      CREATE TRIGGER user_email_unique_across_organisations
        BEFORE INSERT OR UPDATE OF email, organisation_id, deleted_at ON core."user"
        FOR EACH ROW EXECUTE FUNCTION core.guard_user_email_unique_across_organisations();
    `);

    await queryRunner.query(`
      CREATE FUNCTION core.email_registered_in_another_organisation(p_email text) RETURNS boolean
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, pg_catalog
      AS $$
        SELECT core.current_org() IS NULL OR EXISTS (
          SELECT 1 FROM core."user" u
           WHERE u.email OPERATOR(public.=) lower(btrim(p_email))::public.citext
             AND u.organisation_id <> core.current_org()
             AND u.deleted_at IS NULL
        );
      $$;
    `);
    await queryRunner.query(`ALTER FUNCTION core.email_registered_in_another_organisation(text) OWNER TO rab_secure_owner;`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.email_registered_in_another_organisation(text) FROM PUBLIC;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.email_registered_in_another_organisation(text) TO crewflow, crewflow_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.email_registered_in_another_organisation(text);`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS user_email_unique_across_organisations ON core."user";`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.guard_user_email_unique_across_organisations();`);
  }
}
