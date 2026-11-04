-- Owner-login architecture: the ONE-TIME provider-admin step that moves an EXISTING database, built in the separated
-- layout (rab_owner / rab_app / rab_secure_owner / crewflow / crewflow_app / crewflow_worker created by a superuser or
-- the old migrator), to the single owner login. After it, the API (CREWFLOW_MIGRATE_ON_START=true) or the release step
-- runs as crewflow_owner and applies ONLY the migrations still pending. No data is moved, no role is dropped and no
-- object changes owner: the legacy roles stay as SCHEMA roles (historical migrations and SECURITY DEFINER functions
-- need them); crewflow and crewflow_app keep their current passwords until the separated runtime paths are removed (PR #9).
--
-- Run it as the provider admin (a superuser self-hosted; the provider's admin role on a managed service, which must hold
-- ADMIN on the roles below), over the DIRECT host, with SQL only, never a console:
--   psql "<admin URL of the database>" -v ON_ERROR_STOP=1 \
--        -v database=<database> -v owner_password="$(cat /run/secrets/crewflow_owner_password)" \
--        -f transition-from-separated.sql
--
-- Take a backup / PITR restore point first. Tested by scripts/migrate/owner-login/owner-login-lifecycle-check.ts
-- (scenario transition) on PostgreSQL 16 and 18.

CREATE ROLE crewflow_owner LOGIN PASSWORD :'owner_password'
  NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB NOCREATEROLE INHERIT;
-- NOCREATEROLE: an existing database is past the role migrations (1786682000000..1786691000000), so the owner login never
-- needs it here. A database older than those is not a transition candidate: finish its chain with the old path first.

-- The owner roles, with INHERIT (privileges) and SET (the phase rules some migrations use). NOT crewflow_app (the runtime
-- role of the separated layout) and NEVER crewflow_worker (Phase D requires it to have zero members).
GRANT rab_owner, rab_app, rab_secure_owner, crewflow TO crewflow_owner WITH INHERIT TRUE, SET TRUE;

GRANT CONNECT, CREATE, TEMPORARY ON DATABASE :"database" TO crewflow_owner WITH GRANT OPTION;
