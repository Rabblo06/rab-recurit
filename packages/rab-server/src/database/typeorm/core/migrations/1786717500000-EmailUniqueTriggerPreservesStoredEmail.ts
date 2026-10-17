import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Follow-up to `EmailUniqueAcrossOrganisationsForNewAccounts1786717400000` (which must not be edited once applied): the guard must
 * ONLY decide, never rewrite. The first version also lower-cased/trimmed `NEW.email`, silently changing what a writer stored. Every
 * application path already stores the canonical form (`@rab/shared` `normalizeEmail`), the comparison is case- and
 * whitespace-insensitive (citext + btrim), and the advisory-lock key is still the canonical form — so the policy, its race safety
 * and its privacy properties are unchanged; only the side effect is removed. No data is changed.
 */
const body = (rewrite: boolean) => `
  CREATE OR REPLACE FUNCTION core.guard_user_email_unique_across_organisations() RETURNS trigger
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
      RETURN NEW;
    END IF;
    canonical := lower(btrim(NEW.email::text));
    ${rewrite ? 'NEW.email := canonical;' : ''}
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
`;

export class EmailUniqueTriggerPreservesStoredEmail1786717500000 implements MigrationInterface {
  name = 'EmailUniqueTriggerPreservesStoredEmail1786717500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(body(false));
    await queryRunner.query(`ALTER FUNCTION core.guard_user_email_unique_across_organisations() OWNER TO rab_secure_owner;`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.guard_user_email_unique_across_organisations() FROM PUBLIC;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(body(true));
    await queryRunner.query(`ALTER FUNCTION core.guard_user_email_unique_across_organisations() OWNER TO rab_secure_owner;`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.guard_user_email_unique_across_organisations() FROM PUBLIC;`);
  }
}
