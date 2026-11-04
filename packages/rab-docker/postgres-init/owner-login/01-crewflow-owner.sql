-- Owner-login architecture: the ONE-TIME provider-admin step for a NEW database (M0 §5.1). Everything after it is
-- automatic: the first start of the API (CREWFLOW_MIGRATE_ON_START=true) or the release step bootstraps the roles and
-- schema as crewflow_owner and applies the whole migration chain (scripts/migrate/owner-login/).
--
-- "A URL alone" is NOT enough on any provider: this step is a documented prerequisite.
--
-- Run it:
--   - as the provider admin (self-hosted: a superuser; managed: the provider's admin role), over the DIRECT host (never a
--     transaction pooler), with SQL (never a console, CLI or API "create user": those can attach provider-superuser
--     memberships, M0-E F-E3);
--   - against an EMPTY database (create it first: self-hosted `CREATE DATABASE crewflow;`, managed: the console's
--     database, or `CREATE DATABASE` as the admin);
--   - with psql variables, so the password never appears in the file or the shell history:
--       psql "<admin URL of the target database>" -v ON_ERROR_STOP=1 \
--            -v database=crewflow -v owner_password="$(cat /run/secrets/crewflow_owner_password)" \
--            -f 01-crewflow-owner.sql
--
-- PostgreSQL 16 or later only (on 15 and earlier CREATEROLE can grant predefined roles such as
-- pg_execute_server_program; the migration child refuses those servers). PostgreSQL 16 and 18 are supported.
--
-- Provider extras (M0 §5.1):
--   Cloud SQL: CREATE EXTENSION IF NOT EXISTS btree_gist, citext, pg_trgm, pgcrypto, unaccent WITH SCHEMA public (as admin).
--   Azure:     azure.extensions=BTREE_GIST,CITEXT,PG_TRGM,PGCRYPTO,UNACCENT; REVOKE CREATE ON SCHEMA public FROM PUBLIC.
--   RDS:       keep rds.restrict_password_commands=0.
--   Supabase:  the extensions must not already exist outside schema public.
-- Optional hardening AFTER the first successful install: ALTER ROLE crewflow_owner NOCREATEROLE;
-- (an upgrade that still has role migrations pending then needs it back; the child says so).

CREATE ROLE crewflow_owner LOGIN PASSWORD :'owner_password'
  NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB CREATEROLE INHERIT;

-- WITH GRANT OPTION: the bootstrap re-grants CREATE on the database to rab_owner, and later migrations re-grant it to
-- rab_secure_owner (Phase 0b preflight).
GRANT CONNECT, CREATE, TEMPORARY ON DATABASE :"database" TO crewflow_owner WITH GRANT OPTION;
