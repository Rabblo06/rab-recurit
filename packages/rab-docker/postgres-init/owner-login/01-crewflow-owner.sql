-- Owner-login architecture: the ONE-TIME provider-admin step for a NEW database (M0 §5.1), and nothing else. Everything
-- after it is automatic: the first start of the API (CREWFLOW_MIGRATE_ON_START=true) or the release step bootstraps the
-- roles and the schema as crewflow_owner and applies the whole migration chain (scripts/migrate/owner-login/).
--
-- "A URL alone" is NOT enough on any provider: this step is a documented prerequisite.
--
-- Run it with psql (it is a psql script), connected to the EMPTY target database:
--   - bundled PostgreSQL (docker-compose owner-login local-db override): by the image's entrypoint, once, on an empty data
--     volume, as the bootstrap superuser, with ONLY the file /run/secrets/crewflow-owner-password mounted;
--   - any provider: as the provider admin (self-hosted: a superuser; managed: the provider's admin role), over the DIRECT
--     host (never a transaction pooler), by SQL (never a console, CLI or API "create user": those can attach
--     provider-superuser memberships, M0-E F-E3):
--       psql "<admin URL of the target database>" -v owner_password_file=/path/to/secret -f 01-crewflow-owner.sql
--     (default file: /run/secrets/crewflow-owner-password; at least 24 characters, e.g. `openssl rand -hex 32`).
-- The password is read from the file by psql, so it is never on a command line, in an environment variable or in this
-- file. For a superuser session the server log is told to skip this session's statements; a non-superuser provider admin
-- cannot change that setting, so check the provider's log retention for failed statements.
--
-- PostgreSQL 16 or later only (on 15 and earlier CREATEROLE can grant predefined roles such as
-- pg_execute_server_program; the migration child refuses those servers). PostgreSQL 16, 17 and 18 are supported.
--
-- DB-SETUP (database setup like Twenty): this file is now the FALLBACK for operators who create crewflow_owner by hand
-- (then PG_DATABASE_URL names crewflow_owner and it is passed through). By default the stack does this itself on every
-- start: PG_DATABASE_URL is the database ADMIN URL and the one-shot db-setup service's bootstrap child creates
-- crewflow_owner (or resets its password to the one derived from APP_SECRET) and grants it the database.
--
-- Provider extras (M0 §5.1):
--   Cloud SQL: CREATE EXTENSION IF NOT EXISTS btree_gist, citext, pg_trgm, pgcrypto, unaccent WITH SCHEMA public (as admin).
--   Azure:     azure.extensions=BTREE_GIST,CITEXT,PG_TRGM,PGCRYPTO,UNACCENT; REVOKE CREATE ON SCHEMA public FROM PUBLIC.
--   RDS:       keep rds.restrict_password_commands=0.
--   Supabase:  the extensions must not already exist outside schema public.
-- Optional hardening AFTER the first successful install: ALTER ROLE crewflow_owner NOCREATEROLE;
-- (an upgrade that still has role migrations pending then needs it back; the child says so).
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

CREATE ROLE crewflow_owner LOGIN PASSWORD :'owner_pw' NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB CREATEROLE INHERIT;
-- WITH GRANT OPTION: the bootstrap re-grants CREATE on the database to rab_owner, and later migrations re-grant it to
-- rab_secure_owner (Phase 0b preflight).
GRANT CONNECT, CREATE, TEMPORARY ON DATABASE :"DBNAME" TO crewflow_owner WITH GRANT OPTION;

\unset owner_pw
