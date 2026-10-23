/**
 * FROZEN with migration MfaTotpRecoveryCodes1786719900000 (never edited after merge; a change is a new file + migration).
 *
 * Waves 4+5 lane DB5 (B1, CREWFLOW_ULTIMATE_PARITY_PHASE0_REPORT.md): the database half of TOTP MFA. Contract:
 * docs/evidence/w45-db5/CONTRACT.md §1. Kept out of the migration file because TypeORM loads every export of a
 * migration file as a migration class.
 *
 * Design:
 *  - `core."user"` keeps the existing `totp_secret_encrypted` (bytea, never written before this wave) and `totp_enabled`;
 *    it gains `totp_last_used_step` (RFC 6238 time step, 30 s, T0 = epoch) and `mfa_enabled_at`.
 *  - The four MFA columns are writable ONLY by the SECURITY DEFINER functions below (owner rab_secure_owner, which owns
 *    core."user") or a superuser: `user_mfa_columns_guard` refuses (42501) any other writer, including crewflow_app with its
 *    table-level UPDATE — so an injection or a bug in the runtime cannot switch MFA off or rewind the replay counter.
 *    For every writer the step only moves forward (it may return to NULL only together with totp_enabled = false).
 *  - Replay protection is ONE conditional UPDATE (`... AND (last IS NULL OR last < p_step)`), so two concurrent
 *    submissions of the same code cannot both succeed (Twenty has no used-step tracking at all).
 *  - Recovery codes: `core.user_mfa_recovery_code`, ENABLE + FORCE RLS (org policy binds the owner too), hashed one-way
 *    (HMAC hex by the MFA lane), NO privilege for crewflow_app/crewflow; consumed atomically through a function, never
 *    read back.
 *  - Every function requires the tenant context (core.current_org()) and scopes the row to it: the login challenge knows
 *    the user and organisation from the verified first factor (server-derived) and binds it with SET LOCAL before calling,
 *    so no NOT-FORCE pre-auth exception is needed. Refusals are `false` / zero rows, indistinguishable.
 *  - SELF-scoped (also require core.current_uid() = p_user_id): stage, enable, accept a step, replace and consume recovery
 *    codes — only the user (enrolling, or answering their own login challenge) can drive their own factor, so a bug or
 *    injection in any other org-bound code path cannot enrol, burn or consume another user's factor. ORG-scoped (an admin
 *    or job acts on another user; the permission check is the service's, layer 2): mfa_totp_state, mfa_disable (admin
 *    reset), mfa_rotate_totp_secret (key rotation).
 */

const STEP_SECONDS = 30;
const MAX_RECOVERY_CODES = 20;

export const MFA_SCHEMA_UP_SQL = `
-- 1. core."user" columns -------------------------------------------------------------------------------------------
ALTER TABLE core."user"
  ADD COLUMN totp_last_used_step bigint,
  ADD COLUMN mfa_enabled_at timestamptz,
  ADD CONSTRAINT user_totp_last_used_step_check CHECK (totp_last_used_step IS NULL OR totp_last_used_step >= 0),
  ADD CONSTRAINT user_mfa_state_check CHECK (NOT totp_enabled OR (totp_secret_encrypted IS NOT NULL AND mfa_enabled_at IS NOT NULL));

-- Display only (settings: "two-factor on since ..."). The secret and the step stay unreadable to the runtime roles.
GRANT SELECT (mfa_enabled_at) ON core."user" TO crewflow_app, crewflow;

CREATE FUNCTION core.guard_user_mfa_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
DECLARE
  v_privileged boolean := current_user::text = 'rab_secure_owner'
                          OR coalesce((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false);
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT v_privileged AND (NEW.totp_enabled OR NEW.totp_secret_encrypted IS NOT NULL OR NEW.totp_last_used_step IS NOT NULL
                             OR NEW.mfa_enabled_at IS NOT NULL) THEN
      RAISE EXCEPTION 'user_mfa_columns_guard: MFA columns are written only by the core.mfa_* functions'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT v_privileged AND (NEW.totp_enabled IS DISTINCT FROM OLD.totp_enabled
                           OR NEW.totp_secret_encrypted IS DISTINCT FROM OLD.totp_secret_encrypted
                           OR NEW.totp_last_used_step IS DISTINCT FROM OLD.totp_last_used_step
                           OR NEW.mfa_enabled_at IS DISTINCT FROM OLD.mfa_enabled_at) THEN
    RAISE EXCEPTION 'user_mfa_columns_guard: MFA columns are written only by the core.mfa_* functions'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Replay counter: forward only, for every writer. NULL again only when TOTP is switched off (disable / admin reset).
  IF OLD.totp_last_used_step IS NOT NULL AND (
       (NEW.totp_last_used_step IS NULL AND NEW.totp_enabled)
       OR NEW.totp_last_used_step < OLD.totp_last_used_step) THEN
    RAISE EXCEPTION 'user_mfa_columns_guard: totp_last_used_step may only increase'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$guard$;
ALTER FUNCTION core.guard_user_mfa_columns() OWNER TO rab_secure_owner;
REVOKE ALL ON FUNCTION core.guard_user_mfa_columns() FROM PUBLIC;

CREATE TRIGGER user_mfa_columns_guard
  BEFORE INSERT OR UPDATE ON core."user"
  FOR EACH ROW EXECUTE FUNCTION core.guard_user_mfa_columns();

-- 2. Recovery codes ----------------------------------------------------------------------------------------------------
CREATE TABLE core.user_mfa_recovery_code (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid        NOT NULL,
  user_id         uuid        NOT NULL,
  code_hash       text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  used_at         timestamptz,
  CONSTRAINT user_mfa_recovery_code_user_fkey FOREIGN KEY (user_id, organisation_id)
    REFERENCES core."user" (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT user_mfa_recovery_code_hash_check CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT user_mfa_recovery_code_used_check CHECK (used_at IS NULL OR used_at >= created_at),
  CONSTRAINT user_mfa_recovery_code_user_hash_key UNIQUE (user_id, code_hash)
);
CREATE INDEX user_mfa_recovery_code_org_idx ON core.user_mfa_recovery_code (organisation_id);
ALTER TABLE core.user_mfa_recovery_code OWNER TO rab_secure_owner;
ALTER TABLE core.user_mfa_recovery_code ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.user_mfa_recovery_code FORCE ROW LEVEL SECURITY;
CREATE POLICY user_mfa_recovery_code_tenant ON core.user_mfa_recovery_code AS PERMISSIVE FOR ALL TO PUBLIC
  USING (organisation_id = core.current_org()) WITH CHECK (organisation_id = core.current_org());
REVOKE ALL ON core.user_mfa_recovery_code FROM PUBLIC;
REVOKE ALL ON core.user_mfa_recovery_code FROM crewflow_app;
REVOKE ALL ON core.user_mfa_recovery_code FROM crewflow;

-- 3. Functions ------------------------------------------------------------------------------------------------------------
CREATE FUNCTION core.mfa_step_in_range(p_step bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $f$
  SELECT p_step IS NOT NULL AND p_step >= 0
     AND p_step <= pg_catalog.floor(pg_catalog.date_part('epoch', pg_catalog.now()) / ${STEP_SECONDS})::bigint + 1
$f$;

CREATE FUNCTION core.mfa_totp_state(p_user_id uuid)
RETURNS TABLE (totp_enabled boolean, totp_secret_encrypted bytea, totp_last_used_step bigint, mfa_enabled_at timestamptz,
               recovery_codes_remaining integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $f$
  SELECT u.totp_enabled, u.totp_secret_encrypted, u.totp_last_used_step, u.mfa_enabled_at,
         (SELECT count(*)::integer FROM core.user_mfa_recovery_code c WHERE c.user_id = u.id AND c.used_at IS NULL)
    FROM core."user" u
   WHERE core.current_org() IS NOT NULL AND u.id = p_user_id AND u.organisation_id = core.current_org()
     AND u.deleted_at IS NULL
$f$;

CREATE FUNCTION core.mfa_stage_totp_secret(p_user_id uuid, p_secret_encrypted bytea)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $f$
BEGIN
  IF core.current_org() IS NULL OR core.current_uid() IS DISTINCT FROM p_user_id OR p_secret_encrypted IS NULL THEN RETURN false; END IF;
  UPDATE core."user" u
     SET totp_secret_encrypted = p_secret_encrypted, totp_last_used_step = NULL
   WHERE u.id = p_user_id AND u.organisation_id = core.current_org() AND u.deleted_at IS NULL AND NOT u.totp_enabled;
  RETURN FOUND;
END;
$f$;

CREATE FUNCTION core.mfa_enable_totp(p_user_id uuid, p_step bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $f$
BEGIN
  IF NOT core.mfa_step_in_range(p_step) THEN
    RAISE EXCEPTION 'mfa: time step out of range' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF core.current_org() IS NULL OR core.current_uid() IS DISTINCT FROM p_user_id THEN RETURN false; END IF;
  UPDATE core."user" u
     SET totp_enabled = true, mfa_enabled_at = pg_catalog.now(), totp_last_used_step = p_step
   WHERE u.id = p_user_id AND u.organisation_id = core.current_org() AND u.deleted_at IS NULL
     AND NOT u.totp_enabled AND u.totp_secret_encrypted IS NOT NULL;
  RETURN FOUND;
END;
$f$;

CREATE FUNCTION core.mfa_accept_totp_step(p_user_id uuid, p_step bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $f$
BEGIN
  IF NOT core.mfa_step_in_range(p_step) THEN
    RAISE EXCEPTION 'mfa: time step out of range' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF core.current_org() IS NULL OR core.current_uid() IS DISTINCT FROM p_user_id THEN RETURN false; END IF;
  -- One statement: the row lock serialises concurrent submissions; the loser re-evaluates "last < p_step" and fails.
  UPDATE core."user" u
     SET totp_last_used_step = p_step
   WHERE u.id = p_user_id AND u.organisation_id = core.current_org() AND u.deleted_at IS NULL AND u.totp_enabled
     AND (u.totp_last_used_step IS NULL OR u.totp_last_used_step < p_step);
  RETURN FOUND;
END;
$f$;

CREATE FUNCTION core.mfa_disable(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $f$
DECLARE
  v_found boolean;
BEGIN
  IF core.current_org() IS NULL THEN RETURN false; END IF;
  UPDATE core."user" u
     SET totp_enabled = false, totp_secret_encrypted = NULL, totp_last_used_step = NULL, mfa_enabled_at = NULL
   WHERE u.id = p_user_id AND u.organisation_id = core.current_org() AND u.deleted_at IS NULL
     AND (u.totp_enabled OR u.totp_secret_encrypted IS NOT NULL);
  v_found := FOUND;
  DELETE FROM core.user_mfa_recovery_code c WHERE c.user_id = p_user_id AND c.organisation_id = core.current_org();
  RETURN v_found;
END;
$f$;

CREATE FUNCTION core.mfa_replace_recovery_codes(p_user_id uuid, p_code_hashes text[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $f$
DECLARE
  v_org uuid := core.current_org();
  v_n   integer := coalesce(pg_catalog.cardinality(p_code_hashes), 0);
BEGIN
  IF v_n < 1 OR v_n > ${MAX_RECOVERY_CODES}
     OR EXISTS (SELECT 1 FROM pg_catalog.unnest(p_code_hashes) h WHERE h IS NULL OR h !~ '^[0-9a-f]{64}$')
     OR (SELECT count(DISTINCT h) FROM pg_catalog.unnest(p_code_hashes) h) <> v_n THEN
    RAISE EXCEPTION 'mfa: recovery code set must be 1..${MAX_RECOVERY_CODES} distinct lowercase hex64 hashes'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_org IS NULL OR core.current_uid() IS DISTINCT FROM p_user_id THEN RETURN 0; END IF;
  PERFORM 1 FROM core."user" u
    WHERE u.id = p_user_id AND u.organisation_id = v_org AND u.deleted_at IS NULL AND u.totp_secret_encrypted IS NOT NULL
    FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  DELETE FROM core.user_mfa_recovery_code c WHERE c.user_id = p_user_id AND c.organisation_id = v_org;
  INSERT INTO core.user_mfa_recovery_code (organisation_id, user_id, code_hash)
    SELECT v_org, p_user_id, h FROM pg_catalog.unnest(p_code_hashes) h;
  RETURN v_n;
END;
$f$;

CREATE FUNCTION core.mfa_consume_recovery_code(p_user_id uuid, p_code_hash text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $f$
BEGIN
  IF core.current_org() IS NULL OR core.current_uid() IS DISTINCT FROM p_user_id
     OR p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' THEN RETURN false; END IF;
  UPDATE core.user_mfa_recovery_code c
     SET used_at = pg_catalog.now()
   WHERE c.user_id = p_user_id AND c.code_hash = p_code_hash AND c.used_at IS NULL
     AND c.organisation_id = core.current_org()
     AND EXISTS (SELECT 1 FROM core."user" u
                  WHERE u.id = c.user_id AND u.organisation_id = c.organisation_id AND u.deleted_at IS NULL AND u.totp_enabled);
  RETURN FOUND;
END;
$f$;

-- Key rotation (requested by the OPS lane's secret:rotate): re-encrypt a staged or enabled secret under a new key
-- WITHOUT touching enabled / step / mfa_enabled_at. Compare-and-set on the old ciphertext, so a concurrent re-enrolment or
-- disable wins and the rotation of that row is reported as "changed underneath" (false), never overwritten.
CREATE FUNCTION core.mfa_rotate_totp_secret(p_user_id uuid, p_expected bytea, p_new bytea)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $f$
BEGIN
  IF core.current_org() IS NULL OR p_expected IS NULL OR p_new IS NULL THEN RETURN false; END IF;
  UPDATE core."user" u
     SET totp_secret_encrypted = p_new
   WHERE u.id = p_user_id AND u.organisation_id = core.current_org() AND u.deleted_at IS NULL
     AND u.totp_secret_encrypted = p_expected;
  RETURN FOUND;
END;
$f$;

DO $grants$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'core.mfa_step_in_range(bigint)',
    'core.mfa_totp_state(uuid)',
    'core.mfa_stage_totp_secret(uuid, bytea)',
    'core.mfa_enable_totp(uuid, bigint)',
    'core.mfa_accept_totp_step(uuid, bigint)',
    'core.mfa_disable(uuid)',
    'core.mfa_replace_recovery_codes(uuid, text[])',
    'core.mfa_consume_recovery_code(uuid, text)',
    'core.mfa_rotate_totp_secret(uuid, bytea, bytea)'
  ] LOOP
    EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO rab_secure_owner', f);
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF f <> 'core.mfa_step_in_range(bigint)' THEN
      EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO crewflow_app', f);
    END IF;
  END LOOP;
END
$grants$;
`;

export const MFA_SCHEMA_DOWN_SQL = `
DROP FUNCTION IF EXISTS core.mfa_rotate_totp_secret(uuid, bytea, bytea);
DROP FUNCTION IF EXISTS core.mfa_consume_recovery_code(uuid, text);
DROP FUNCTION IF EXISTS core.mfa_replace_recovery_codes(uuid, text[]);
DROP FUNCTION IF EXISTS core.mfa_disable(uuid);
DROP FUNCTION IF EXISTS core.mfa_accept_totp_step(uuid, bigint);
DROP FUNCTION IF EXISTS core.mfa_enable_totp(uuid, bigint);
DROP FUNCTION IF EXISTS core.mfa_stage_totp_secret(uuid, bytea);
DROP FUNCTION IF EXISTS core.mfa_totp_state(uuid);
DROP FUNCTION IF EXISTS core.mfa_step_in_range(bigint);
DROP TABLE IF EXISTS core.user_mfa_recovery_code;
DROP TRIGGER IF EXISTS user_mfa_columns_guard ON core."user";
DROP FUNCTION IF EXISTS core.guard_user_mfa_columns();
REVOKE SELECT (mfa_enabled_at) ON core."user" FROM crewflow_app, crewflow;
ALTER TABLE core."user"
  DROP CONSTRAINT IF EXISTS user_mfa_state_check,
  DROP CONSTRAINT IF EXISTS user_totp_last_used_step_check,
  DROP COLUMN IF EXISTS mfa_enabled_at,
  DROP COLUMN IF EXISTS totp_last_used_step;
`;
