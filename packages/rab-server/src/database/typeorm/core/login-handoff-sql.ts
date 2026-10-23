/**
 * FROZEN with migration LoginHandoff1786719910000 (never edited after merge; a change is a new file + migration).
 *
 * Waves 4+5 lane DB5: the cross-host login handoff for the MFA/auth lane (apex/default host → the user's own workspace
 * host, C8). Contract: docs/evidence/w45-db5/CONTRACT.md §2.
 *
 * A handoff is created POST-auth on the source host from a live session and consumed PRE-auth on the target host:
 *  - single use: consumption is one conditional UPDATE (`consumed_at IS NULL AND expires_at > now()`), so two concurrent
 *    redemptions of the same token cannot both win; a presented live token is burned even when a later check fails;
 *  - short-lived: `expires_at <= created_at + 60 s` is a table CHECK, the TTL parameter is clamped to 1..60 s;
 *  - audience-bound: the row records the target workspace's canonical host label at creation; consumption requires the
 *    presenting host's label to equal it AND the workspace to still carry it (a rename in between invalidates it);
 *  - hashed: only SHA-256 hex of the secret is stored; the secret itself is never in the database;
 *  - nothing is taken from parameters that matters: organisation, user, workspace, application target, auth provider and
 *    MFA time are copied from the bound tenant context and the source session row; the user's security_version is
 *    snapshotted and must be unchanged at consumption (password change, sign-out-everywhere, role change invalidate it);
 *    the source session must still be live (revoking it kills the handoff).
 *
 * SECURITY TRADE-OFF — core.login_handoff is ENABLE ROW LEVEL SECURITY but NOT FORCE (NOT_FORCED_ALLOWLIST entry):
 *   Why: `core.login_handoff_consume` is a pre-auth lookup on the target host — it must find the row by token hash before
 *   any tenant context can exist (establishing that context is what it is for). It runs as the table owner
 *   rab_secure_owner (NOLOGIN); FORCE would bind the owner to the tenant policy and hide the row. Same reasoning as
 *   account_invite / member_invitation / user_session.
 *   Bound: crewflow_app AND crewflow hold NO privilege on the table (not even SELECT); the only access is the three
 *   functions below; the tenant policy still exists and binds every non-owner. Rows hold ids, a label, a hash and
 *   timestamps — no secret. Cleanup deletes rows one hour after expiry or consumption.
 *   Veto option: FORCE + a policy keyed on a definer-set GUC (more moving parts, same effective trust).
 */

export const LOGIN_HANDOFF_MAX_TTL_SECONDS = 60;
export const LOGIN_HANDOFF_MAX_LIVE_PER_USER = 5;

export const LOGIN_HANDOFF_UP_SQL = `
CREATE TABLE core.login_handoff (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id    uuid        NOT NULL REFERENCES core.organisation (id) ON DELETE CASCADE,
  user_id            uuid        NOT NULL,
  source_session_id  uuid        NOT NULL REFERENCES core.user_session (id) ON DELETE CASCADE,
  workspace_id       uuid        NOT NULL,
  audience_label     text        NOT NULL,
  application_target text        NOT NULL,
  auth_provider      text,
  mfa_verified_at    timestamptz,
  security_version   bigint      NOT NULL,
  token_hash         text        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  consumed_at        timestamptz,
  CONSTRAINT login_handoff_user_fkey FOREIGN KEY (user_id, organisation_id)
    REFERENCES core."user" (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT login_handoff_workspace_fkey FOREIGN KEY (workspace_id, organisation_id)
    REFERENCES core.manager_workspace (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT login_handoff_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT login_handoff_token_hash_key UNIQUE (token_hash),
  CONSTRAINT login_handoff_audience_check CHECK (audience_label = pg_catalog.lower(audience_label) AND pg_catalog.length(audience_label) BETWEEN 1 AND 63),
  CONSTRAINT login_handoff_application_target_check CHECK (application_target IN ('manager_web', 'venue_manager_app', 'staff_app')),
  CONSTRAINT login_handoff_auth_provider_check CHECK (auth_provider IS NULL OR auth_provider IN ('password', 'google', 'microsoft')),
  CONSTRAINT login_handoff_lifetime_check CHECK (expires_at > created_at AND expires_at <= created_at + interval '${LOGIN_HANDOFF_MAX_TTL_SECONDS} seconds'),
  CONSTRAINT login_handoff_consumed_check CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);
CREATE INDEX login_handoff_user_live_idx ON core.login_handoff (user_id, expires_at) WHERE consumed_at IS NULL;
CREATE INDEX login_handoff_cleanup_idx ON core.login_handoff (expires_at);
CREATE INDEX login_handoff_org_idx ON core.login_handoff (organisation_id);
ALTER TABLE core.login_handoff OWNER TO rab_secure_owner;
ALTER TABLE core.login_handoff ENABLE ROW LEVEL SECURITY;
CREATE POLICY login_handoff_tenant ON core.login_handoff AS PERMISSIVE FOR ALL TO PUBLIC
  USING (organisation_id = core.current_org()) WITH CHECK (organisation_id = core.current_org());
REVOKE ALL ON core.login_handoff FROM PUBLIC;
REVOKE ALL ON core.login_handoff FROM crewflow_app;
REVOKE ALL ON core.login_handoff FROM crewflow;

CREATE FUNCTION core.login_handoff_create(p_source_session_id uuid, p_token_hash text, p_ttl_seconds integer DEFAULT 30)
RETURNS TABLE (handoff_id uuid, audience_label text, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $f$
#variable_conflict use_column
DECLARE
  v_org   uuid := core.current_org();
  v_uid   uuid := core.current_uid();
  v_ttl   integer := LEAST(GREATEST(coalesce(p_ttl_seconds, 30), 1), ${LOGIN_HANDOFF_MAX_TTL_SECONDS});
  v_ws    uuid;
  v_label text;
  v_app   text;
  v_prov  text;
  v_mfa   timestamptz;
  v_sv    bigint;
  v_live  integer;
  v_id    uuid;
  v_exp   timestamptz;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'login_handoff: token hash must be lowercase hex64' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_org IS NULL OR v_uid IS NULL THEN RETURN; END IF;

  SELECT s.workspace_id, s.application_target, s.auth_provider, s.mfa_verified_at
    INTO v_ws, v_app, v_prov, v_mfa
    FROM core.user_session s
   WHERE s.id = p_source_session_id AND s.organisation_id = v_org AND s.user_id = v_uid AND s.revoked_at IS NULL
     AND s.absolute_expires_at > pg_catalog.now() AND (s.idle_expires_at IS NULL OR s.idle_expires_at > pg_catalog.now())
     AND s.workspace_id IS NOT NULL;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT u.security_version INTO v_sv FROM core."user" u
   WHERE u.id = v_uid AND u.organisation_id = v_org AND u.status = 'active' AND u.deleted_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT pg_catalog.lower(w.subdomain::text) INTO v_label FROM core.manager_workspace w
   WHERE w.id = v_ws AND w.organisation_id = v_org AND w.status = 'active' AND w.schema_status = 'READY';
  IF NOT FOUND OR NOT coalesce(core.workspace_schema_routable(v_ws), false)
     OR coalesce(core.organisation_is_suspended(v_org), true) THEN
    RETURN;
  END IF;

  SELECT count(*)::int INTO v_live FROM core.login_handoff h
   WHERE h.user_id = v_uid AND h.consumed_at IS NULL AND h.expires_at > pg_catalog.now();
  IF v_live >= ${LOGIN_HANDOFF_MAX_LIVE_PER_USER} THEN
    RAISE EXCEPTION 'login_handoff: too many live handoffs for this user' USING ERRCODE = 'CWH01';
  END IF;

  INSERT INTO core.login_handoff (organisation_id, user_id, source_session_id, workspace_id, audience_label,
                                  application_target, auth_provider, mfa_verified_at, security_version, token_hash,
                                  created_at, expires_at)
  VALUES (v_org, v_uid, p_source_session_id, v_ws, v_label, v_app, v_prov, v_mfa, v_sv, p_token_hash,
          pg_catalog.now(), pg_catalog.now() + pg_catalog.make_interval(secs => v_ttl))
  RETURNING id, login_handoff.expires_at INTO v_id, v_exp;

  RETURN QUERY SELECT v_id, v_label, v_exp;
END;
$f$;

CREATE FUNCTION core.login_handoff_consume(p_token_hash text, p_host_label text)
RETURNS TABLE (organisation_id uuid, user_id uuid, workspace_id uuid, application_target text, auth_provider text,
               mfa_verified_at timestamptz, source_session_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $f$
#variable_conflict use_column
DECLARE
  h       core.login_handoff%ROWTYPE;
  v_label text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_host_label, '')));
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN RETURN; END IF;

  -- Burn first: any live token presented is single-use from here on, whatever the outcome below.
  UPDATE core.login_handoff x SET consumed_at = pg_catalog.clock_timestamp()
   WHERE x.token_hash = p_token_hash AND x.consumed_at IS NULL AND x.expires_at > pg_catalog.clock_timestamp()
  RETURNING x.* INTO h;
  IF NOT FOUND THEN RETURN; END IF;

  IF v_label <> h.audience_label THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM core.manager_workspace w
                  WHERE w.id = h.workspace_id AND w.organisation_id = h.organisation_id AND w.status = 'active'
                    AND w.schema_status = 'READY' AND pg_catalog.lower(w.subdomain::text) = h.audience_label) THEN
    RETURN;
  END IF;
  IF NOT coalesce(core.workspace_schema_routable(h.workspace_id), false)
     OR coalesce(core.organisation_is_suspended(h.organisation_id), true) THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core."user" u
                  WHERE u.id = h.user_id AND u.organisation_id = h.organisation_id AND u.status = 'active'
                    AND u.deleted_at IS NULL AND u.security_version = h.security_version) THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.user_session s
                  WHERE s.id = h.source_session_id AND s.user_id = h.user_id AND s.revoked_at IS NULL
                    AND s.absolute_expires_at > pg_catalog.now()
                    AND (s.idle_expires_at IS NULL OR s.idle_expires_at > pg_catalog.now())) THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT h.organisation_id, h.user_id, h.workspace_id, h.application_target, h.auth_provider,
                      h.mfa_verified_at, h.source_session_id;
END;
$f$;

CREATE FUNCTION core.login_handoff_cleanup(p_batch integer)
RETURNS TABLE (rows_deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $f$
#variable_conflict use_column
DECLARE
  v_batch   integer := LEAST(GREATEST(coalesce(p_batch, 1000), 1), 10000);
  v_deleted integer;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('crewflow_login_handoff_cleanup'));
  DELETE FROM core.login_handoff
   WHERE id IN (SELECT x.id FROM core.login_handoff x
                 WHERE x.expires_at < pg_catalog.now() - interval '1 hour'
                    OR (x.consumed_at IS NOT NULL AND x.consumed_at < pg_catalog.now() - interval '1 hour')
                 LIMIT v_batch);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  rows_deleted := v_deleted;
  RETURN NEXT;
END;
$f$;

DO $grants$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'core.login_handoff_create(uuid, text, integer)',
    'core.login_handoff_consume(text, text)',
    'core.login_handoff_cleanup(integer)'
  ] LOOP
    EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO rab_secure_owner', f);
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO crewflow_app', f);
  END LOOP;
END
$grants$;
`;

export const LOGIN_HANDOFF_DOWN_SQL = `
DROP FUNCTION IF EXISTS core.login_handoff_cleanup(integer);
DROP FUNCTION IF EXISTS core.login_handoff_consume(text, text);
DROP FUNCTION IF EXISTS core.login_handoff_create(uuid, text, integer);
DROP TABLE IF EXISTS core.login_handoff;
`;
