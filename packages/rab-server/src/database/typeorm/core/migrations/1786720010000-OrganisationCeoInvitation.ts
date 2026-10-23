import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Owner correction 2026-10-23 ("CREWFLOW — URGENT CORRECTION TO ORGANISATION CREATION FLOW"): a Platform Administrator
 * invites a new organisation's CEO with an EMAIL ONLY (Settings → Members → Add). The CEO supplies their own first name,
 * last name, organisation name and password when they accept; only then is the organisation created. No organisation,
 * user or placeholder name may exist before that.
 *
 * Until now a CEO invitation needed an organisation (and a `core.user` row with the CEO's name) to exist first —
 * `account_invite` and `member_invitation` are both bound to an organisation (and `member_invitation` to a workspace and a
 * custom role). The smallest safe adjustment is ONE platform-level row for the pending invitation, holding only the email,
 * the token hash, the lifecycle timestamps and who invited. Nothing else changes: the organisation and the CEO account are
 * still created by the existing `core.create_organisation()` + `ManagerService.createWithin()` path, inside the
 * acceptance transaction, under the INVITING administrator's authority re-verified at that moment (same pattern as
 * email-first member invitations).
 *
 * `core.organisation_invitation`
 *   - no `organisation_id` tenant column: it is not tenant data (like `platform_admin`); `inviter_organisation_id` is the
 *     organisation whose email outbox carries the invitation email, `accepted_organisation_id` the organisation the
 *     acceptance created.
 *   - owned by `rab_secure_owner` (NOLOGIN). `crewflow` and `crewflow_app` hold NO privilege on it: every read and write
 *     goes through the SECURITY DEFINER functions below, each of which re-checks `core.is_active_platform_admin()` for the
 *     bound user (issue / resend / revoke / list) or is a narrow pre-auth token operation (peek / complete) or a state probe
 *     for the worker (state).
 *   - RLS ENABLED with a platform-admin policy, NOT FORCED. SECURITY TRADE-OFF: `organisation_invitation_peek` and
 *     `organisation_invitation_complete` are PRE-AUTH lookups by token hash (the invited CEO has no account, no session and
 *     no organisation yet — establishing them is the purpose), and they run as the table owner; FORCE would bind the owner
 *     to the platform-admin policy and hide the row from them. Same reasoning as `account_invite`, `member_invitation` and
 *     `login_handoff` (tools/check-rls-coverage.ts NOT_FORCED_ALLOWLIST). The runtime roles cannot reach the table at all.
 *   - one live (not accepted / revoked / superseded) invitation per email (partial unique index); at most 3 sends; history
 *     is never deleted (no DELETE anywhere).
 *
 * `core.email_outbox` gains job type `ORGANISATION_INVITATION` and a link column `organisation_invitation_id`
 * (CHECK: the job type and the link go together, as for MEMBER_INVITATION). The secret-body scrub trigger (F1) treats the
 * new type as token-bearing, like the other invitation types.
 *
 * Not production-approved (N1, production-migration-approval.ts).
 */
const SCRUB_TYPES_BEFORE = `'ACCOUNT_INVITATION', 'PASSWORD_RESET', 'MEMBER_INVITATION'`;
const SCRUB_TYPES_AFTER = `'ACCOUNT_INVITATION', 'PASSWORD_RESET', 'MEMBER_INVITATION', 'ORGANISATION_INVITATION'`;
const JOB_TYPES_BEFORE = `'ACCOUNT_INVITATION', 'PASSWORD_RESET', 'PASSWORD_UPDATED', 'WELCOME', 'ACCOUNT_SUSPENDED', 'NOTIFICATION', 'MEMBER_INVITATION'`;
const JOB_TYPES_AFTER = `${JOB_TYPES_BEFORE}, 'ORGANISATION_INVITATION'`;

function scrubFunction(types: string): string {
  return `
      CREATE OR REPLACE FUNCTION core.email_outbox_scrub_secret_body()
      RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, pg_temp
      AS $scrub$
      BEGIN
        IF (NEW.rendered_html IS NOT NULL OR NEW.rendered_text IS NOT NULL)
           AND (NEW.job_type IN (${types})
                OR coalesce(NEW.rendered_html, '') ~* '[?&;]token='
                OR coalesce(NEW.rendered_text, '') ~* '[?&;]token=') THEN
          NEW.rendered_html := NULL;
          NEW.rendered_text := NULL;
        END IF;
        RETURN NEW;
      END;
      $scrub$;`;
}

const FUNCTIONS = [
  'organisation_invitation_issue(text,text,timestamptz)',
  'organisation_invitation_resend(uuid,text,timestamptz,integer)',
  'organisation_invitation_revoke(uuid)',
  'organisation_invitation_list(integer,integer)',
  'organisation_invitation_peek(text)',
  'organisation_invitation_complete(text,uuid,uuid)',
  'organisation_invitation_state(uuid)',
];

export class OrganisationCeoInvitation1786720010000 implements MigrationInterface {
  name = 'OrganisationCeoInvitation1786720010000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE core.organisation_invitation (
        id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        email                    text        NOT NULL,
        token_hash               text        NOT NULL,
        send_count               integer     NOT NULL DEFAULT 1,
        expires_at               timestamptz NOT NULL,
        last_sent_at             timestamptz NOT NULL DEFAULT now(),
        invited_by               uuid        REFERENCES core."user"(id) ON DELETE SET NULL,
        inviter_organisation_id  uuid        REFERENCES core.organisation(id) ON DELETE SET NULL,
        accepted_at              timestamptz,
        accepted_organisation_id uuid        REFERENCES core.organisation(id) ON DELETE SET NULL,
        accepted_user_id         uuid        REFERENCES core."user"(id) ON DELETE SET NULL,
        revoked_at               timestamptz,
        revoked_by               uuid,
        superseded_at            timestamptz,
        created_at               timestamptz NOT NULL DEFAULT now(),
        updated_at               timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT organisation_invitation_email_check CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 320),
        CONSTRAINT organisation_invitation_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT organisation_invitation_token_hash_key UNIQUE (token_hash),
        CONSTRAINT organisation_invitation_send_count_check CHECK (send_count BETWEEN 1 AND 3),
        CONSTRAINT organisation_invitation_accepted_links CHECK (accepted_at IS NOT NULL OR (accepted_organisation_id IS NULL AND accepted_user_id IS NULL))
      );
    `);
    await runner.query(`
      CREATE UNIQUE INDEX organisation_invitation_one_live_per_email ON core.organisation_invitation (email)
        WHERE accepted_at IS NULL AND revoked_at IS NULL AND superseded_at IS NULL;
    `);
    await runner.query(`ALTER TABLE core.organisation_invitation OWNER TO rab_secure_owner;`);
    // SECURITY TRADE-OFF (see the class comment): ENABLE, deliberately NOT FORCE — the pre-auth token functions run as the
    // owner. crewflow / crewflow_app hold no privilege on the table, so the policy below binds every other path.
    await runner.query(`ALTER TABLE core.organisation_invitation ENABLE ROW LEVEL SECURITY;`);
    await runner.query(`
      CREATE POLICY organisation_invitation_platform_admin ON core.organisation_invitation AS PERMISSIVE FOR ALL TO PUBLIC
        USING (core.is_active_platform_admin(core.current_uid()))
        WITH CHECK (core.is_active_platform_admin(core.current_uid()));
    `);
    await runner.query(`REVOKE ALL ON core.organisation_invitation FROM PUBLIC;`);
    await runner.query(`REVOKE ALL ON core.organisation_invitation FROM crewflow, crewflow_app;`);

    // ── Platform-admin operations (the bound user must be an ACTIVE platform administrator) ──────────────────────────
    await runner.query(`
      CREATE FUNCTION core.organisation_invitation_issue(p_email text, p_token_hash text, p_expires_at timestamptz)
      RETURNS TABLE ("outcome" text, "invitationId" uuid, "sendCount" integer, "expiresAt" timestamptz, "inviterOrganisationId" uuid)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_actor uuid := core.current_uid();
        v_email text := lower(btrim(p_email));
        v_org uuid;
        v_row core.organisation_invitation%ROWTYPE;
      BEGIN
        IF v_actor IS NULL OR NOT core.is_active_platform_admin(v_actor) THEN
          RAISE EXCEPTION 'organisation invitation: an active platform administrator is required' USING ERRCODE = '42501';
        END IF;
        IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR p_expires_at IS NULL OR p_expires_at <= now() THEN
          RAISE EXCEPTION 'organisation invitation: invalid arguments' USING ERRCODE = '22023';
        END IF;
        SELECT u.organisation_id INTO v_org FROM core."user" u WHERE u.id = v_actor;
        -- An address that already has an account anywhere never gets a second one through this flow.
        IF EXISTS (SELECT 1 FROM core."user" u WHERE lower(u.email) = v_email) THEN
          RETURN QUERY SELECT 'account_exists'::text, NULL::uuid, NULL::integer, NULL::timestamptz, NULL::uuid;
          RETURN;
        END IF;
        -- An expired, still-open invitation for this address is superseded so a new one can be issued.
        UPDATE core.organisation_invitation oi SET superseded_at = now(), updated_at = now()
         WHERE oi.email = v_email AND oi.accepted_at IS NULL AND oi.revoked_at IS NULL AND oi.superseded_at IS NULL AND oi.expires_at <= now();
        SELECT * INTO v_row FROM core.organisation_invitation oi
         WHERE oi.email = v_email AND oi.accepted_at IS NULL AND oi.revoked_at IS NULL AND oi.superseded_at IS NULL;
        IF FOUND THEN
          RETURN QUERY SELECT 'already_invited'::text, v_row.id, v_row.send_count, v_row.expires_at, v_row.inviter_organisation_id;
          RETURN;
        END IF;
        INSERT INTO core.organisation_invitation (email, token_hash, send_count, expires_at, invited_by, inviter_organisation_id)
        VALUES (v_email, p_token_hash, 1, p_expires_at, v_actor, v_org)
        RETURNING * INTO v_row;
        RETURN QUERY SELECT 'invited'::text, v_row.id, v_row.send_count, v_row.expires_at, v_row.inviter_organisation_id;
      EXCEPTION WHEN unique_violation THEN
        -- A concurrent issue for the same address won (one live invitation per email).
        RETURN QUERY SELECT 'already_invited'::text, NULL::uuid, NULL::integer, NULL::timestamptz, NULL::uuid;
      END;
      $fn$;
    `);

    await runner.query(`
      CREATE FUNCTION core.organisation_invitation_resend(p_id uuid, p_token_hash text, p_expires_at timestamptz, p_max_sends integer)
      RETURNS TABLE ("outcome" text, "email" text, "sendCount" integer, "expiresAt" timestamptz, "inviterOrganisationId" uuid)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_actor uuid := core.current_uid();
        v_row core.organisation_invitation%ROWTYPE;
      BEGIN
        IF v_actor IS NULL OR NOT core.is_active_platform_admin(v_actor) THEN
          RAISE EXCEPTION 'organisation invitation: an active platform administrator is required' USING ERRCODE = '42501';
        END IF;
        IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR p_expires_at IS NULL OR p_expires_at <= now() THEN
          RAISE EXCEPTION 'organisation invitation: invalid arguments' USING ERRCODE = '22023';
        END IF;
        SELECT * INTO v_row FROM core.organisation_invitation oi WHERE oi.id = p_id FOR UPDATE;
        IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::integer, NULL::timestamptz, NULL::uuid; RETURN; END IF;
        IF v_row.accepted_at IS NOT NULL THEN RETURN QUERY SELECT 'accepted'::text, v_row.email, v_row.send_count, v_row.expires_at, v_row.inviter_organisation_id; RETURN; END IF;
        IF v_row.revoked_at IS NOT NULL OR v_row.superseded_at IS NOT NULL THEN
          RETURN QUERY SELECT 'not_pending'::text, v_row.email, v_row.send_count, v_row.expires_at, v_row.inviter_organisation_id; RETURN;
        END IF;
        IF v_row.send_count >= LEAST(GREATEST(coalesce(p_max_sends, 3), 1), 3) THEN
          RETURN QUERY SELECT 'max_sends'::text, v_row.email, v_row.send_count, v_row.expires_at, v_row.inviter_organisation_id; RETURN;
        END IF;
        UPDATE core.organisation_invitation oi
           SET token_hash = p_token_hash, send_count = oi.send_count + 1, expires_at = p_expires_at, last_sent_at = now(), updated_at = now()
         WHERE oi.id = p_id
        RETURNING * INTO v_row;
        RETURN QUERY SELECT 'resent'::text, v_row.email, v_row.send_count, v_row.expires_at, v_row.inviter_organisation_id;
      END;
      $fn$;
    `);

    await runner.query(`
      CREATE FUNCTION core.organisation_invitation_revoke(p_id uuid)
      RETURNS TABLE ("outcome" text, "email" text, "inviterOrganisationId" uuid)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_actor uuid := core.current_uid();
        v_row core.organisation_invitation%ROWTYPE;
      BEGIN
        IF v_actor IS NULL OR NOT core.is_active_platform_admin(v_actor) THEN
          RAISE EXCEPTION 'organisation invitation: an active platform administrator is required' USING ERRCODE = '42501';
        END IF;
        SELECT * INTO v_row FROM core.organisation_invitation oi WHERE oi.id = p_id FOR UPDATE;
        IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::uuid; RETURN; END IF;
        IF v_row.accepted_at IS NOT NULL THEN RETURN QUERY SELECT 'accepted'::text, v_row.email, v_row.inviter_organisation_id; RETURN; END IF;
        IF v_row.revoked_at IS NOT NULL OR v_row.superseded_at IS NOT NULL THEN
          RETURN QUERY SELECT 'not_pending'::text, v_row.email, v_row.inviter_organisation_id; RETURN;
        END IF;
        UPDATE core.organisation_invitation oi SET revoked_at = now(), revoked_by = v_actor, updated_at = now() WHERE oi.id = p_id;
        RETURN QUERY SELECT 'revoked'::text, v_row.email, v_row.inviter_organisation_id;
      END;
      $fn$;
    `);

    await runner.query(`
      CREATE FUNCTION core.organisation_invitation_list(p_limit integer, p_offset integer)
      RETURNS TABLE ("id" uuid, "email" text, "status" text, "sendCount" integer, "expiresAt" timestamptz, "lastSentAt" timestamptz,
                     "createdAt" timestamptz, "acceptedAt" timestamptz, "acceptedOrganisationId" uuid, "total" bigint)
      LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_actor uuid := core.current_uid();
      BEGIN
        IF v_actor IS NULL OR NOT core.is_active_platform_admin(v_actor) THEN
          RAISE EXCEPTION 'organisation invitation: an active platform administrator is required' USING ERRCODE = '42501';
        END IF;
        RETURN QUERY
          SELECT oi.id, oi.email,
                 CASE WHEN oi.accepted_at IS NOT NULL THEN 'accepted'
                      WHEN oi.revoked_at IS NOT NULL THEN 'revoked'
                      WHEN oi.superseded_at IS NOT NULL THEN 'superseded'
                      WHEN oi.expires_at <= now() THEN 'expired'
                      ELSE 'pending' END,
                 oi.send_count, oi.expires_at, oi.last_sent_at, oi.created_at, oi.accepted_at, oi.accepted_organisation_id,
                 count(*) OVER ()
            FROM core.organisation_invitation oi
           WHERE oi.superseded_at IS NULL
           ORDER BY oi.created_at DESC, oi.id
           LIMIT LEAST(GREATEST(coalesce(p_limit, 25), 1), 100) OFFSET GREATEST(coalesce(p_offset, 0), 0);
      END;
      $fn$;
    `);

    // ── Pre-auth token operations (the invited CEO has no account or session yet) ────────────────────────────────────
    // Returns a LIVE invitation only; every invalid, expired, revoked, superseded or used token returns nothing.
    await runner.query(`
      CREATE FUNCTION core.organisation_invitation_peek(p_token_hash text)
      RETURNS TABLE ("invitationId" uuid, "email" text, "expiresAt" timestamptz, "invitedBy" uuid)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
      AS $fn$
        SELECT oi.id, oi.email, oi.expires_at, oi.invited_by
          FROM core.organisation_invitation oi
         WHERE oi.token_hash = p_token_hash
           AND oi.accepted_at IS NULL AND oi.revoked_at IS NULL AND oi.superseded_at IS NULL
           AND oi.expires_at > now() AND oi.invited_by IS NOT NULL;
      $fn$;
    `);
    // Single use, race safe: consumes the LIVE invitation (row lock) and links it to the organisation and CEO account the
    // same transaction just created — but only when that account carries the invited email and belongs to that
    // organisation. Returns the invitation id, or NULL (the caller rolls the whole acceptance back).
    await runner.query(`
      CREATE FUNCTION core.organisation_invitation_complete(p_token_hash text, p_organisation_id uuid, p_user_id uuid)
      RETURNS uuid
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_row core.organisation_invitation%ROWTYPE;
      BEGIN
        SELECT * INTO v_row FROM core.organisation_invitation oi
         WHERE oi.token_hash = p_token_hash AND oi.accepted_at IS NULL AND oi.revoked_at IS NULL AND oi.superseded_at IS NULL
           AND oi.expires_at > now()
         FOR UPDATE;
        IF NOT FOUND THEN RETURN NULL; END IF;
        IF NOT EXISTS (SELECT 1 FROM core."user" u WHERE u.id = p_user_id AND u.organisation_id = p_organisation_id AND lower(u.email) = v_row.email) THEN
          RETURN NULL;
        END IF;
        UPDATE core.organisation_invitation oi
           SET accepted_at = now(), accepted_organisation_id = p_organisation_id, accepted_user_id = p_user_id, updated_at = now()
         WHERE oi.id = v_row.id;
        RETURN v_row.id;
      END;
      $fn$;
    `);
    // Worker pre-delivery revalidation: the state of one invitation by id (an unguessable uuid it read from its own outbox row).
    await runner.query(`
      CREATE FUNCTION core.organisation_invitation_state(p_id uuid)
      RETURNS text
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
      AS $fn$
        SELECT coalesce((
          SELECT CASE WHEN oi.accepted_at IS NOT NULL THEN 'accepted'
                      WHEN oi.revoked_at IS NOT NULL THEN 'revoked'
                      WHEN oi.superseded_at IS NOT NULL THEN 'superseded'
                      WHEN oi.expires_at <= now() THEN 'expired'
                      ELSE 'live' END
            FROM core.organisation_invitation oi WHERE oi.id = p_id), 'missing');
      $fn$;
    `);
    // Owner stated explicitly per object (migration-object-ownership.spec.ts reads these literally).
    await runner.query(`ALTER FUNCTION core.organisation_invitation_issue(text,text,timestamptz) OWNER TO rab_secure_owner;`);
    await runner.query(`ALTER FUNCTION core.organisation_invitation_resend(uuid,text,timestamptz,integer) OWNER TO rab_secure_owner;`);
    await runner.query(`ALTER FUNCTION core.organisation_invitation_revoke(uuid) OWNER TO rab_secure_owner;`);
    await runner.query(`ALTER FUNCTION core.organisation_invitation_list(integer,integer) OWNER TO rab_secure_owner;`);
    await runner.query(`ALTER FUNCTION core.organisation_invitation_peek(text) OWNER TO rab_secure_owner;`);
    await runner.query(`ALTER FUNCTION core.organisation_invitation_complete(text,uuid,uuid) OWNER TO rab_secure_owner;`);
    await runner.query(`ALTER FUNCTION core.organisation_invitation_state(uuid) OWNER TO rab_secure_owner;`);
    for (const fn of FUNCTIONS) {
      await runner.query(`REVOKE ALL ON FUNCTION core.${fn} FROM PUBLIC;`);
      await runner.query(`GRANT EXECUTE ON FUNCTION core.${fn} TO crewflow, crewflow_app;`);
    }

    // ── Email outbox linkage ─────────────────────────────────────────────────────────────────────────────────────────
    await runner.query(`ALTER TABLE core.email_outbox ADD COLUMN organisation_invitation_id uuid REFERENCES core.organisation_invitation(id) ON DELETE RESTRICT;`);
    await runner.query(`CREATE INDEX email_outbox_organisation_invitation_idx ON core.email_outbox (organisation_invitation_id) WHERE organisation_invitation_id IS NOT NULL;`);
    await runner.query(`ALTER TABLE core.email_outbox DROP CONSTRAINT email_outbox_job_type_check;`);
    await runner.query(`ALTER TABLE core.email_outbox ADD CONSTRAINT email_outbox_job_type_check CHECK (job_type IN (${JOB_TYPES_AFTER}));`);
    await runner.query(`
      ALTER TABLE core.email_outbox ADD CONSTRAINT email_outbox_organisation_invitation_link CHECK (
        (job_type = 'ORGANISATION_INVITATION') = (organisation_invitation_id IS NOT NULL)
      );
    `);
    await runner.query(scrubFunction(SCRUB_TYPES_AFTER));
    // CREATE OR REPLACE keeps the owner; stated anyway (unchanged: crewflow, as EmailOutboxSecretBodyScrub1786719710000).
    await runner.query(`ALTER FUNCTION core.email_outbox_scrub_secret_body() OWNER TO crewflow;`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(scrubFunction(SCRUB_TYPES_BEFORE));
    await runner.query(`ALTER FUNCTION core.email_outbox_scrub_secret_body() OWNER TO crewflow;`);
    await runner.query(`ALTER TABLE core.email_outbox DROP CONSTRAINT IF EXISTS email_outbox_organisation_invitation_link;`);
    await runner.query(`DELETE FROM core.email_outbox WHERE job_type = 'ORGANISATION_INVITATION';`);
    await runner.query(`ALTER TABLE core.email_outbox DROP CONSTRAINT email_outbox_job_type_check;`);
    await runner.query(`ALTER TABLE core.email_outbox ADD CONSTRAINT email_outbox_job_type_check CHECK (job_type IN (${JOB_TYPES_BEFORE}));`);
    await runner.query(`DROP INDEX IF EXISTS core.email_outbox_organisation_invitation_idx;`);
    await runner.query(`ALTER TABLE core.email_outbox DROP COLUMN IF EXISTS organisation_invitation_id;`);
    for (const fn of FUNCTIONS) await runner.query(`DROP FUNCTION IF EXISTS core.${fn};`);
    await runner.query(`DROP TABLE IF EXISTS core.organisation_invitation;`);
  }
}
