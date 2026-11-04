-- Owner-login architecture: the ONE-TIME provider-admin step that moves an EXISTING database, built in the separated
-- layout (rab_owner / rab_app / rab_secure_owner / crewflow / crewflow_app / crewflow_worker created by a superuser or
-- the old migrator), to the single owner login. After it, the API (CREWFLOW_MIGRATE_ON_START=true) or the release step
-- runs as crewflow_owner and applies ONLY the migrations still pending. No data is moved, no role is dropped and no
-- object changes owner: the legacy roles stay as SCHEMA roles (historical migrations and SECURITY DEFINER functions
-- need them); crewflow and crewflow_app keep their current passwords until the separated runtime paths are removed (PR #9).
--
-- Take a backup / PITR restore point first. Run it with psql, connected to the database, as the provider admin (a
-- superuser self-hosted; on a managed service the provider's admin role, which must hold ADMIN on the roles below), over
-- the DIRECT host, by SQL only, never a console:
--   psql "<admin URL of the database>" -v owner_password_file=/path/to/secret -f transition-from-separated.sql
--   (default file: /run/secrets/crewflow-owner-password; at least 24 characters)
-- Tested by scripts/migrate/owner-login/owner-login-lifecycle-check.ts (scenario transition) on PostgreSQL 16 and 18.
\set ON_ERROR_STOP on
SELECT pg_catalog.set_config('log_min_error_statement', 'panic', false), pg_catalog.set_config('log_statement', 'none', false)
 WHERE (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user);

\if :{?owner_password_file}
\else
  \set owner_password_file /run/secrets/crewflow-owner-password
\endif
\set owner_pw `cat :owner_password_file 2>/dev/null | tr -d '\r\n'`
SELECT length(:'owner_pw') >= 24 AS crewflow_owner_password_ok \gset
\if :crewflow_owner_password_ok
\else
  \warn 'refused: the crewflow_owner password file is missing or shorter than 24 characters (generate one: openssl rand -hex 32)'
  SELECT 1 / 0 AS refused_missing_crewflow_owner_password;
\endif

-- NOCREATEROLE: an existing database is past the role migrations (1786682000000..1786691000000), so the owner login never
-- needs it here. A database older than those is not a transition candidate: finish its chain with the old path first.
CREATE ROLE crewflow_owner LOGIN PASSWORD :'owner_pw' NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB NOCREATEROLE INHERIT;
-- The owner roles, with INHERIT (privileges) and SET (the phase rules some migrations use). NOT crewflow_app (the runtime
-- role of the separated layout) and NEVER crewflow_worker (Phase D requires it to have zero members).
GRANT rab_owner, rab_app, rab_secure_owner, crewflow TO crewflow_owner WITH INHERIT TRUE, SET TRUE;
GRANT CONNECT, CREATE, TEMPORARY ON DATABASE :"DBNAME" TO crewflow_owner WITH GRANT OPTION;

\unset owner_pw
