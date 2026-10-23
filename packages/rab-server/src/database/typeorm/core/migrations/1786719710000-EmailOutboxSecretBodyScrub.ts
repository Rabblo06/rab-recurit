import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wave 1 lane S, finding F1 (owner-approved for the development TEST database: "null token-bearing bodies now; retention
 * periods later (G6)". NOT approved for production — deliberately absent from production-migration-approval.ts).
 *
 * F1: `core.email_outbox` kept the fully rendered body of every email forever. For password-reset, account-activation /
 * invitation, member-invitation and email-change-verification emails that body contains a live bearer link
 * (`...?token=<raw token>`). Anyone who can read the table (a backup, a replica, a future SQL-read bug) could take over an
 * account while the token is unused and unexpired.
 *
 * Fix, in the existing outbox (no new mailer, no new table, no new grant):
 *  1. `core.email_outbox_scrub_secret_body()` + trigger `email_outbox_scrub_secret_body`, BEFORE INSERT OR UPDATE, fires only
 *     when the row is in a TERMINAL state (SENT, FAILED, CANCELLED). If the row carries a secret it sets `rendered_html` and
 *     `rendered_text` to NULL. It runs for every writer and every role (worker processor, dispatcher recovery, the user
 *     deletion / invite-supersede cancellations, ad-hoc SQL, and the currently deployed older images), so no path can leave
 *     a terminal row holding a token — and no one can put a body back on one.
 *  2. Unsent mail is untouched: PENDING / QUEUED / PROCESSING / RETRY rows keep their body, so retries still send.
 *     Delivery metadata (status, timestamps, provider ids, attempt counts, sanitized error) and the subject are kept, and
 *     audit rows are never touched.
 *  3. Existing terminal rows are reconciled here, per organisation under the real RLS policy (organisations listed through
 *     the existing `core.worker_list_organisations` SECURITY DEFINER keyset function), so it works as the bootstrap
 *     superuser and as `crewflow` alike. Only counts are reported, never a body or token.
 *
 * The rule (mirrored in TypeScript as `emailBodyCarriesSecret`, email-outbox.service.ts — the worker processor applies it
 * itself at the terminal write; this trigger is the database-layer backstop):
 *   job_type IN ('ACCOUNT_INVITATION', 'PASSWORD_RESET', 'MEMBER_INVITATION')   -- every one of these carries a link token
 *   OR the html/text body contains a `token=` query parameter                   -- e.g. the email-change verification,
 *                                                                                  which is a NOTIFICATION
 * Every token link this codebase renders uses `?token=` (auth.service.ts, account-lifecycle.service.ts,
 * email-change.service.ts, member-invitation.service.ts).
 *
 * SECURITY: the trigger function is SECURITY INVOKER, owned by crewflow, `search_path` pinned, EXECUTE revoked from PUBLIC
 * (PostgreSQL does not check EXECUTE when firing a trigger, so no role gains anything). It only ever removes data.
 *
 * down(): drops the trigger and the function. Scrubbed bodies are NOT restored — that is the point of the change and the
 * data is gone (irreversible data minimisation, owner-approved).
 */
export class EmailOutboxSecretBodyScrub1786719710000 implements MigrationInterface {
  name = 'EmailOutboxSecretBodyScrub1786719710000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $authority$
      BEGIN
        IF NOT pg_has_role(current_user, 'crewflow', 'USAGE') THEN
          RAISE EXCEPTION 'EmailOutboxSecretBodyScrub1786719710000 must run as crewflow or the bootstrap identity (it creates a trigger on a crewflow-owned table); refusing as %', current_user
            USING ERRCODE = 'insufficient_privilege';
        END IF;
      END
      $authority$;
    `);

    await queryRunner.query(`
      CREATE FUNCTION core.email_outbox_scrub_secret_body()
      RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, pg_temp
      AS $scrub$
      BEGIN
        IF (NEW.rendered_html IS NOT NULL OR NEW.rendered_text IS NOT NULL)
           AND (NEW.job_type IN ('ACCOUNT_INVITATION', 'PASSWORD_RESET', 'MEMBER_INVITATION')
                OR coalesce(NEW.rendered_html, '') ~* '[?&;]token='
                OR coalesce(NEW.rendered_text, '') ~* '[?&;]token=') THEN
          NEW.rendered_html := NULL;
          NEW.rendered_text := NULL;
        END IF;
        RETURN NEW;
      END;
      $scrub$;
    `);
    await queryRunner.query(`ALTER FUNCTION core.email_outbox_scrub_secret_body() OWNER TO crewflow;`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.email_outbox_scrub_secret_body() FROM PUBLIC;`);
    await queryRunner.query(`
      CREATE TRIGGER email_outbox_scrub_secret_body
      BEFORE INSERT OR UPDATE ON core.email_outbox
      FOR EACH ROW
      WHEN (NEW.status IN ('SENT', 'FAILED', 'CANCELLED'))
      EXECUTE FUNCTION core.email_outbox_scrub_secret_body();
    `);

    // Reconcile rows that are already terminal. A no-op self-assignment fires the trigger, so the rule lives in ONE place.
    await queryRunner.query(`
      DO $reconcile$
      DECLARE
        o record;
        v_after uuid := NULL;
        v_page integer;
        v_orgs integer := 0;
        v_rows integer;
        v_scrubbed integer := 0;
        v_left integer;
      BEGIN
        LOOP
          v_page := 0;
          FOR o IN SELECT l.organisation_id FROM core.worker_list_organisations(v_after, 100) l LOOP
            v_page := v_page + 1;
            v_orgs := v_orgs + 1;
            v_after := o.organisation_id;
            PERFORM set_config('rab.organisation_id', o.organisation_id::text, true);
            UPDATE core.email_outbox
               SET rendered_html = rendered_html
             WHERE organisation_id = o.organisation_id
               AND status IN ('SENT', 'FAILED', 'CANCELLED')
               AND (rendered_html IS NOT NULL OR rendered_text IS NOT NULL)
               AND (job_type IN ('ACCOUNT_INVITATION', 'PASSWORD_RESET', 'MEMBER_INVITATION')
                    OR coalesce(rendered_html, '') ~* '[?&;]token='
                    OR coalesce(rendered_text, '') ~* '[?&;]token=');
            GET DIAGNOSTICS v_rows = ROW_COUNT;
            v_scrubbed := v_scrubbed + v_rows;
            SELECT count(*) INTO v_left FROM core.email_outbox
             WHERE organisation_id = o.organisation_id
               AND status IN ('SENT', 'FAILED', 'CANCELLED')
               AND (rendered_html IS NOT NULL OR rendered_text IS NOT NULL)
               AND (job_type IN ('ACCOUNT_INVITATION', 'PASSWORD_RESET', 'MEMBER_INVITATION')
                    OR coalesce(rendered_html, '') ~* '[?&;]token='
                    OR coalesce(rendered_text, '') ~* '[?&;]token=');
            IF v_left <> 0 THEN
              RAISE EXCEPTION 'EmailOutboxSecretBodyScrub1786719710000: % terminal secret-bearing row(s) still hold a body in one organisation', v_left;
            END IF;
          END LOOP;
          EXIT WHEN v_page < 100;
        END LOOP;
        PERFORM set_config('rab.organisation_id', '', true);
        RAISE NOTICE 'EmailOutboxSecretBodyScrub1786719710000: % organisation(s) checked, % terminal secret-bearing body/bodies scrubbed', v_orgs, v_scrubbed;
      END
      $reconcile$;
    `);

    // Refuse to be recorded unless the trigger is enabled exactly as intended and the function has the expected shape.
    await queryRunner.query(`
      DO $verify$
      DECLARE v text;
      BEGIN
        SELECT string_agg(x, '; ') INTO v FROM (
          SELECT 'trigger missing or disabled' AS x
           WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'core.email_outbox'::regclass
                               AND t.tgname = 'email_outbox_scrub_secret_body' AND t.tgenabled = 'O' AND NOT t.tgisinternal)
          UNION ALL
          SELECT 'function is not a crewflow-owned SECURITY INVOKER with a pinned search_path'
            FROM pg_proc p WHERE p.oid = 'core.email_outbox_scrub_secret_body()'::regprocedure
             AND NOT (NOT p.prosecdef AND pg_get_userbyid(p.proowner) = 'crewflow'
                      AND 'search_path=pg_catalog, pg_temp' = ANY (coalesce(p.proconfig, ARRAY[]::text[])))
          UNION ALL
          SELECT 'PUBLIC may EXECUTE core.email_outbox_scrub_secret_body'
           WHERE EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                          WHERE p.oid = 'core.email_outbox_scrub_secret_body()'::regprocedure AND a.grantee = 0)
        ) problems;
        IF v IS NOT NULL THEN
          RAISE EXCEPTION 'EmailOutboxSecretBodyScrub1786719710000 verification failed: %', v;
        END IF;
      END
      $verify$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS email_outbox_scrub_secret_body ON core.email_outbox;`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.email_outbox_scrub_secret_body();`);
  }
}
