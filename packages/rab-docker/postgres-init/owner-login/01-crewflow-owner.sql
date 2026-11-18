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
-- PostgreSQL 16, 17 and 18 only: this script refuses any other major before it creates anything (on 15 and earlier
-- CREATEROLE can grant predefined roles such as pg_execute_server_program; the migration child refuses those servers too).
--
-- DB-SETUP (database setup the Twenty way, owner decision 2026-11-18): this file is the FALLBACK for operators who create
-- crewflow_owner by hand (mode c: PG_DATABASE_URL names crewflow_owner, no PG_ADMIN_URL; db-setup only checks it). By
-- default the stack does this itself: the one-shot db-setup service, holding the admin login (PG_ADMIN_URL, or the bundled
-- db's superuser), creates crewflow_owner with the password inside PG_DATABASE_URL and grants it the database.
--
-- Provider extras (M0 §5.1):
--   Cloud SQL: CREATE EXTENSION IF NOT EXISTS btree_gist, citext, pg_trgm, pgcrypto, unaccent WITH SCHEMA public (as admin).
--   Azure:     azure.extensions=BTREE_GIST,CITEXT,PG_TRGM,PGCRYPTO,UNACCENT; REVOKE CREATE ON SCHEMA public FROM PUBLIC.
--   RDS:       keep rds.restrict_password_commands=0.
--   Supabase:  the extensions must not already exist outside schema public.
-- REQUIRED AFTER the first successful install (enforced since owner decision 2026-11-18: db-setup and, in production, the
-- boot check refuse a CREATEROLE crewflow_owner once the schema is complete):
--   ALTER ROLE crewflow_owner NOCREATEROLE; COMMENT ON ROLE crewflow_owner IS NULL;
-- (an upgrade that still has role migrations pending then needs it back, with the mark; the child says so).
\set ON_ERROR_STOP on
-- PR #227 (security review L2): only the supported PostgreSQL majors, 16-18 (database/postgres/supported-majors.ts; a spec
-- keeps the two in step). Refused before anything is created: on 15 and earlier CREATEROLE can grant predefined roles such
-- as pg_execute_server_program, and a newer major has no reviewed workspace fingerprints or posture goldens.
SELECT pg_catalog.current_setting('server_version_num')::int / 10000 AS crewflow_pg_major,
       pg_catalog.current_setting('server_version_num')::int / 10000 BETWEEN 16 AND 18 AS crewflow_pg_supported \gset
\if :crewflow_pg_supported
\else
  \warn 'refused: PostgreSQL' :crewflow_pg_major 'is not supported; use 16-18 (PostgreSQL 16, 17 or 18). Nothing was created.'
  SELECT 1 / 0 AS refused_unsupported_postgresql_version;
\endif
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
-- Owner decision 2026-11-18: the CREATEROLE mark (db-setup's OWNER_HARDEN_H3_MARK_PENDING). In production rab-api,
-- rab-worker and the CLI refuse a CREATEROLE crewflow_owner at boot unless it carries exactly this comment
-- (database-boot-gate-rules.ts assertCreateRoleGate); only an admin can set or clear it. Remove both after the first start.
COMMENT ON ROLE crewflow_owner IS 'crewflow:createrole-until-schema-current';
-- WITH GRANT OPTION: the bootstrap re-grants CREATE on the database to rab_owner, and later migrations re-grant it to
-- rab_secure_owner (Phase 0b preflight).
GRANT CONNECT, CREATE, TEMPORARY ON DATABASE :"DBNAME" TO crewflow_owner WITH GRANT OPTION;

\unset owner_pw
