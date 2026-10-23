/**
 * FROZEN with migration MfaHandoffFollowups1786719980000 (never edited after merge; a change is a new file + migration).
 *
 * Waves 4+5 lane DB5, additive follow-ups requested by the MFA lane (WAVE4_LANE_MFA_REPORT.md §10). Contract v3:
 * docs/evidence/w45-db5/CONTRACT.md §1.4 and §2.
 *
 * 1. `core.login_handoff_peek(token_hash, host_label)`: pre-auth, READ-ONLY (STABLE: PostgreSQL itself refuses any
 *    INSERT/UPDATE/DELETE inside it, so it can never consume, extend or otherwise touch a handoff), for a "Continue as …"
 *    confirmation page. Returns only display fields — the target workspace's display name, a MASKED email and the expiry —
 *    and only when consume would currently succeed (same checks: unconsumed, unexpired, audience = presenting host, the
 *    workspace still carries that label and is active/READY/routable, organisation not suspended, user active with the
 *    snapshotted security_version, source session live). Zero rows otherwise, indistinguishable. No id is returned.
 *    Token guessing is infeasible (256-bit secret, only SHA-256 stored); a leaked token is already redeemable by consume,
 *    so peek adds no capability beyond a masked email and a workspace name the host page already shows.
 *
 * 2. `user_session.mfa_verified_at` at INSERT: a column-level `GRANT INSERT (mfa_verified_at)` to crewflow_app (no UPDATE —
 *    it stays unwritable after creation for the runtime role, and no other new privilege), plus a BEFORE INSERT guard: a
 *    non-NULL value must not be in the future (5 s skew) and the session's user must hold an ENABLED TOTP factor at that
 *    moment, so a session can never claim a second factor its user does not have. (No minimum age: a cross-host handoff
 *    legitimately carries the source session's original verification time.)
 *
 * 3. The OPS-requested `core.mfa_rotate_totp_secret` already ships in MfaTotpRecoveryCodes1786719900000 (contract §1.3).
 */

export const MFA_HANDOFF_FOLLOWUPS_UP_SQL = `
CREATE FUNCTION core.login_handoff_peek(p_token_hash text, p_host_label text)
RETURNS TABLE (workspace_display_name text, masked_email text, expires_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $f$
#variable_conflict use_column
DECLARE
  h       core.login_handoff%ROWTYPE;
  v_label text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_host_label, '')));
  v_name  text;
  v_email text;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN RETURN; END IF;
  SELECT x.* INTO h FROM core.login_handoff x
   WHERE x.token_hash = p_token_hash AND x.consumed_at IS NULL AND x.expires_at > pg_catalog.clock_timestamp();
  IF NOT FOUND OR v_label <> h.audience_label THEN RETURN; END IF;
  SELECT w.name::text INTO v_name FROM core.manager_workspace w
   WHERE w.id = h.workspace_id AND w.organisation_id = h.organisation_id AND w.status = 'active'
     AND w.schema_status = 'READY' AND pg_catalog.lower(w.subdomain::text) = h.audience_label;
  IF NOT FOUND OR NOT coalesce(core.workspace_schema_routable(h.workspace_id), false)
     OR coalesce(core.organisation_is_suspended(h.organisation_id), true) THEN
    RETURN;
  END IF;
  SELECT u.email::text INTO v_email FROM core."user" u
   WHERE u.id = h.user_id AND u.organisation_id = h.organisation_id AND u.status = 'active'
     AND u.deleted_at IS NULL AND u.security_version = h.security_version;
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM core.user_session s
                  WHERE s.id = h.source_session_id AND s.user_id = h.user_id AND s.revoked_at IS NULL
                    AND s.absolute_expires_at > pg_catalog.now()
                    AND (s.idle_expires_at IS NULL OR s.idle_expires_at > pg_catalog.now())) THEN
    RETURN;
  END IF;
  -- j***@example.com : first character of the local part only.
  RETURN QUERY SELECT v_name,
                      pg_catalog.left(pg_catalog.split_part(v_email, '@', 1), 1) || '***@' || pg_catalog.split_part(v_email, '@', 2),
                      h.expires_at;
END;
$f$;
ALTER FUNCTION core.login_handoff_peek(text, text) OWNER TO rab_secure_owner;
REVOKE ALL ON FUNCTION core.login_handoff_peek(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.login_handoff_peek(text, text) TO crewflow_app;

CREATE FUNCTION core.guard_user_session_mfa_verified_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $g$
BEGIN
  IF NEW.mfa_verified_at > pg_catalog.clock_timestamp() + interval '5 seconds' THEN
    RAISE EXCEPTION 'user_session: mfa_verified_at cannot be in the future' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core."user" u
                  WHERE u.id = NEW.user_id AND u.organisation_id = NEW.organisation_id AND u.totp_enabled) THEN
    RAISE EXCEPTION 'user_session: mfa_verified_at requires an enabled second factor' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$g$;
ALTER FUNCTION core.guard_user_session_mfa_verified_at() OWNER TO rab_secure_owner;
REVOKE ALL ON FUNCTION core.guard_user_session_mfa_verified_at() FROM PUBLIC;
CREATE TRIGGER user_session_mfa_verified_guard
  BEFORE INSERT ON core.user_session
  FOR EACH ROW WHEN (NEW.mfa_verified_at IS NOT NULL)
  EXECUTE FUNCTION core.guard_user_session_mfa_verified_at();

GRANT INSERT (mfa_verified_at) ON core.user_session TO crewflow_app;
`;

export const MFA_HANDOFF_FOLLOWUPS_DOWN_SQL = `
REVOKE INSERT (mfa_verified_at) ON core.user_session FROM crewflow_app;
DROP TRIGGER IF EXISTS user_session_mfa_verified_guard ON core.user_session;
DROP FUNCTION IF EXISTS core.guard_user_session_mfa_verified_at();
DROP FUNCTION IF EXISTS core.login_handoff_peek(text, text);
`;
