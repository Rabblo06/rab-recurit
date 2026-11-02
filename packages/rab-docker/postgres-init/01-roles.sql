-- Runs once, automatically, the first time the Postgres data volume is
-- initialized (docker-entrypoint-initdb.d convention — see docker-compose.yml).
-- Local dev only: plaintext dev credentials, matching the POSTGRES_USER/
-- POSTGRES_PASSWORD already in docker-compose.yml. Production (Railway)
-- provisions rab_owner/rab_app separately, out of band, with real secrets.
--
-- See rab-workforce-architecture.md §5.7 for why two roles exist:
-- rab_owner runs migrations; rab_app (NOBYPASSRLS, not the table owner) is
-- the only role the running server ever connects as, so RLS policies can
-- never be silently bypassed by a query the app tier forgot to scope.

CREATE ROLE rab_owner LOGIN PASSWORD 'rab_owner_dev_only';
CREATE ROLE rab_app LOGIN PASSWORD 'rab_app_dev_only' NOBYPASSRLS;

-- Postgres 15+ removed the implicit CREATE-on-database privilege for
-- non-owners — even `CREATE SCHEMA IF NOT EXISTS` fails for a role that
-- isn't the database owner and lacks an explicit CREATE grant, regardless
-- of whether the schema already exists (the privilege check happens before
-- IF NOT EXISTS is evaluated). Making rab_owner the actual owner of this
-- database is the correct fix, not a workaround — it's the role that runs
-- migrations, so it should own what migrations create. `current_database()`
-- keeps this portable across environments with different DB names.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I OWNER TO rab_owner', current_database());
END
$$;

CREATE SCHEMA IF NOT EXISTS core AUTHORIZATION rab_owner;

GRANT USAGE ON SCHEMA core TO rab_app;

-- Tables rab_owner creates via migration land with these privileges for
-- rab_app automatically — no per-migration GRANT boilerplate. Explicit
-- REVOKEs (audit_log, attendance_correction — see CLAUDE.md) still apply on
-- top, per table, in the migration that creates each of those tables.
ALTER DEFAULT PRIVILEGES FOR ROLE rab_owner IN SCHEMA core
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rab_app;
ALTER DEFAULT PRIVILEGES FOR ROLE rab_owner IN SCHEMA core
  GRANT USAGE, SELECT ON SEQUENCES TO rab_app;
ALTER DEFAULT PRIVILEGES FOR ROLE rab_owner IN SCHEMA core
  GRANT EXECUTE ON FUNCTIONS TO rab_app;

-- Phase D (D2; SQL owner-approved 2026-11-01; dev init only): the Worker's own login, `crewflow_worker`.
-- Owner decision D2: an operator / bootstrap script creates it, never a migration — migration
-- WorkerDispatchPointer1786721300000 only ASSERTS its reviewed shape and refuses to run without it:
--   LOGIN, INHERIT, a member of exactly crewflow_app WITH INHERIT TRUE, SET FALSE (no ADMIN), no member of its own,
--   owns nothing, no SUPERUSER / BYPASSRLS / CREATEROLE / CREATEDB / REPLICATION.
-- crewflow_app is normally created later, by CrewflowAppRestrictedRuntimeRole1786687000000, which accepts an existing
-- role (IF NOT EXISTS ... ELSE ALTER ROLE ... PASSWORD): it is pre-created here with exactly that migration's attributes
-- and a throwaway dev-only password the migration replaces with CREWFLOW_APP_BOOTSTRAP_PASSWORD, so that the membership
-- can be granted at init time, before any migration runs. Production / staging / CI: the reviewed operator runbook step
-- (packages/rab-docker/docs/phase-d-deployment-runbook.md §3), with a secret-store password — never this file.
CREATE ROLE crewflow_app LOGIN PASSWORD 'crewflow_app_dev_placeholder_replaced_by_migration' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE crewflow_worker LOGIN PASSWORD 'crewflow_worker_dev_only'
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;
GRANT crewflow_app TO crewflow_worker WITH INHERIT TRUE, SET FALSE;
