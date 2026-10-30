-- =====================================================================================================================
-- crewflow_migrator: the migration-only login of the one-off `rab-migrate` process (Phase B, P7).
--
-- DISPOSABLE DATABASES ONLY. Reviewed for disposable/test clusters (marked `crewflow.disposable_cluster = on`) and
-- refuses anything else, here and in its runner (migrator-role.ts). Creating this role on ANY real environment (staging,
-- production, a managed DigitalOcean/Neon cluster) is a SEPARATE OWNER APPROVAL: it is not authorised by this file, by the
-- Phase B plan approval, or by any migration. Migrations never create roles (CI's M2 harness runs every post-Phase-0b
-- migration as a NOCREATEROLE identity, so they cannot).
--
-- Shape (the same as CI's rab_ci_migrator, scripts/migration-security-check.ts):
--   LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT, owns nothing,
--   member of rab_secure_owner and crewflow (INHERIT TRUE, SET TRUE) -- exactly what CF-41 (migration-identity.ts) requires
--   of a non-superuser that runs migrations after the role split.
-- The password is NOT in this file: the runner sets it afterwards as a client-computed SCRAM-SHA-256 verifier, so the
-- plaintext never reaches the server, its logs or this file.
--
-- Run only through migrator-role.ts (it checks the target first). Idempotent.
-- Prerequisite: rab_secure_owner and crewflow exist (created by the role-split migrations); refused otherwise.
-- =====================================================================================================================
DO $migrator$
BEGIN
  -- Security review L-1: the marker must be a SERVER-side fact a session cannot set (current_setting() is not proof: a
  -- session's startup options can set it). Same three facts as migrator-role.ts DISPOSABLE_MARKER_SQL.
  IF NOT (
    EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s
             WHERE s.setrole = 0
               AND s.setdatabase IN (0, (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()))
               AND 'crewflow.disposable_cluster=on' = ANY (s.setconfig))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_file_settings f
                WHERE f.name = 'crewflow.disposable_cluster' AND f.setting = 'on' AND f.error IS NULL)
    OR coalesce(pg_catalog.pg_read_file('postmaster.opts', true), '') ~ '"-c" "crewflow[.]disposable_cluster=on"'
  ) THEN
    RAISE EXCEPTION 'refusing: this cluster is not marked disposable server-side (crewflow.disposable_cluster = on). crewflow_migrator on a real environment needs its own owner approval.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'rab_secure_owner')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'crewflow') THEN
    RAISE EXCEPTION 'refusing: rab_secure_owner and crewflow must exist first (apply the role-split migrations).';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'crewflow_migrator') THEN
    CREATE ROLE crewflow_migrator NOLOGIN;
  END IF;
  ALTER ROLE crewflow_migrator NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;
  IF pg_catalog.current_setting('server_version_num')::int >= 160000 THEN
    EXECUTE 'GRANT rab_secure_owner TO crewflow_migrator WITH INHERIT TRUE, SET TRUE';
    EXECUTE 'GRANT crewflow TO crewflow_migrator WITH INHERIT TRUE, SET TRUE';
  ELSE
    EXECUTE 'GRANT rab_secure_owner TO crewflow_migrator';
    EXECUTE 'GRANT crewflow TO crewflow_migrator';
  END IF;
  -- Never an admin of either role, and no other membership.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid = m.roleid
              WHERE m.member = 'crewflow_migrator'::regrole AND (m.admin_option OR r.rolname NOT IN ('rab_secure_owner', 'crewflow'))) THEN
    RAISE EXCEPTION 'refusing: crewflow_migrator has an unexpected membership or ADMIN OPTION; fix it by hand and re-run.';
  END IF;
END
$migrator$;
