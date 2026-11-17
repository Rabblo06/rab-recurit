-- =====================================================================================================================
-- Your own database, app login created by you: the ONE step a database admin runs by hand (OWNER SQL REVIEW).
--
-- Use it when you do not want to hand Crewflow an admin URL. You create the app login `crewflow_owner` yourself, then put
-- ITS URL (never the admin URL) in PG_DATABASE_URL. Twenty has the same option: an external database with no admin login
-- and no setup step. Runbook: packages/rab-docker/docs/release/OWNER-LOGIN-DEPLOYMENT.md, section 4a.
--
-- What it produces is IDENTICAL to what db-setup's bootstrap child ("owner-bootstrap") produces with an admin URL
-- (scripts/owner-login/owner-bootstrap-sql.ts, OWNER_BOOTSTRAP_Q4C_DO):
--   CREATE ROLE crewflow_owner LOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB CREATEROLE INHERIT PASSWORD <SCRAM verifier>
--   GRANT CONNECT, CREATE, TEMPORARY ON DATABASE <this database> TO crewflow_owner WITH GRANT OPTION
-- and nothing else. In particular, this script does NOT create the schema roles (rab_owner, rab_app, rab_secure_owner,
-- crewflow, crewflow_app, crewflow_worker), the `core` schema, the extensions or the default privileges: neither does
-- db-setup. crewflow_owner creates them itself on the first API start (migrate-on-start, scripts/migrate/owner-login/
-- bootstrap.ts), because on PostgreSQL 16+ the role that creates a role becomes its ADMIN member, and the boot posture
-- check (database/boot-checks/owner-login-posture.ts, rule 3) accepts no member of an owner role other than
-- crewflow_owner. If you created them here, the first start would refuse ("unexpected member").
--
-- Run it with psql, as the provider admin (a superuser, or a NOSUPERUSER role with CREATEROLE that holds CONNECT, CREATE
-- and TEMPORARY on the database WITH GRANT OPTION, typically the database owner: neondb_owner, the RDS master user,
-- doadmin, avnadmin, postgres on Supabase / Cloud SQL / Azure), connected to the EMPTY target database, over the DIRECT host
-- (never a transaction pooler), with TLS:
--
--   openssl rand -hex 32          # the crewflow_owner password: 64 hex characters, URL-safe; keep it in your secret store
--   psql "postgresql://<admin>@<direct-host>:5432/<database>?sslmode=verify-full" -X -f own-database-app-login.sql
--
-- At the end psql asks for the new password twice (`\password`). psql turns it into a SCRAM-SHA-256 verifier on YOUR
-- machine and sends only the verifier: the password itself never reaches the server, a log or this file. Non-interactive
-- (no terminal): psql reads the two lines from standard input instead.
--
-- Then: PG_DATABASE_URL=postgresql://crewflow_owner:<password>@<direct-host>:5432/<database>?sslmode=verify-full,
-- CREWFLOW_BUNDLED_DB=0, and no PG_ADMIN_URL. db-setup only checks the login (read-only) and copies the password into its
-- password file (/run/crewflow/db-target/owner-password, mode 0400, on the crewflow-db-target volume).
--
-- Every statement is annotated with:
--   NEEDS    the privilege the admin running it needs;
--   WHY      why Crewflow needs it;
--   NO-CR    whether it can be done by an admin WITHOUT the CREATEROLE attribute.
--
-- It changes nothing until every check has passed, and it never alters a role that already exists. It is safe to read
-- before you run it: no statement here takes a value from outside the file (the password goes only through \password).
-- =====================================================================================================================

-- psql: stop at the first error (a failed check, a missing privilege): nothing after it runs.
\set ON_ERROR_STOP on

-- (1) Pin the session's search path to the system catalog, as db-setup does (Q0, security review H1).
--     NEEDS  nothing (any login may set its own session settings).
--     WHY    no unqualified name below can resolve to an object someone planted in another schema (CVE-2018-1058 class).
--     NO-CR  yes.
SET search_path TO pg_catalog, pg_temp;

-- (2) PostgreSQL 16+ default for what the creator of a new role gets: ADMIN only, no INHERIT, no SET.
--     NEEDS  nothing (a user-settable session setting).
--     WHY    the creating admin becomes an ADMIN member of crewflow_owner. The boot posture check accepts exactly that
--            ("ADMIN-only creator row") and refuses any member that can act as crewflow_owner (INHERIT or SET). Some
--            providers change this default; setting it here makes the result the same on every provider.
--     NO-CR  yes (it only matters for CREATE ROLE, below).
SET createrole_self_grant = '';

-- (3) Read-only checks. Each one is a refusal db-setup or the first API start would otherwise give later. Nothing is
--     changed yet; a failed check stops the script here.
--     NEEDS  nothing beyond CONNECT (catalog reads only).
--     WHY    see each message.
--     NO-CR  yes.
DO $preflight$
DECLARE
  v_admin pg_catalog.pg_roles%ROWTYPE;
BEGIN
  IF pg_catalog.current_setting('server_version_num')::int < 160000 THEN
    RAISE EXCEPTION 'refused: PostgreSQL 16 or later is required (on 15 and earlier CREATEROLE can grant pg_execute_server_program). Nothing was changed.';
  END IF;
  SELECT * INTO v_admin FROM pg_catalog.pg_roles WHERE rolname = current_user;
  IF session_user::text <> current_user::text THEN
    RAISE EXCEPTION 'refused: run this as the admin login itself, not after SET ROLE. Nothing was changed.';
  END IF;
  IF current_user::text = 'crewflow_owner' THEN
    RAISE EXCEPTION 'refused: run this as the provider admin, not as crewflow_owner. Nothing was changed.';
  END IF;
  IF NOT (v_admin.rolsuper OR v_admin.rolcreaterole) THEN
    RAISE EXCEPTION 'refused: this login can not create roles (it needs CREATEROLE or SUPERUSER). Crewflow needs a provider that allows CREATEROLE. Nothing was changed.';
  END IF;
  IF NOT (pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'CONNECT WITH GRANT OPTION')
      AND pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'CREATE WITH GRANT OPTION')
      AND pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'TEMPORARY WITH GRANT OPTION')) THEN
    RAISE EXCEPTION 'refused: this login can not grant CONNECT, CREATE and TEMPORARY on this database (connect as the database owner). Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'crewflow_owner') THEN
    RAISE EXCEPTION 'refused: crewflow_owner already exists. Use its URL as it is (db-setup checks it), or drop it first. This script never changes an existing role. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles
              WHERE rolname IN ('rab_owner', 'rab_app', 'rab_secure_owner', 'crewflow', 'crewflow_app', 'crewflow_worker', 'crewflow_rolemaker')) THEN
    RAISE EXCEPTION 'refused: Crewflow schema roles already exist on this PostgreSQL cluster (roles are cluster-wide: one Crewflow deployment per cluster). A new crewflow_owner could not adopt them. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s
               JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase AND d.datname = pg_catalog.current_database()
              CROSS JOIN LATERAL pg_catalog.unnest(s.setconfig) AS c(setting)
              WHERE s.setrole = 0 AND pg_catalog.lower(pg_catalog.split_part(c.setting, '=', 1)) = 'search_path') THEN
    RAISE EXCEPTION 'refused: this database has a database-wide search_path default (ALTER DATABASE ... SET search_path); db-setup refuses such a database (security review H1). Remove it first. Nothing was changed.';
  END IF;
  IF pg_catalog.current_setting('password_encryption') <> 'scram-sha-256' THEN
    RAISE EXCEPTION 'refused: password_encryption is not scram-sha-256, so \password would store an md5 hash. Set it for this session (SET password_encryption = ''scram-sha-256'') and run again. Nothing was changed.';
  END IF;
END
$preflight$;

BEGIN;

-- (4) The app login, with EXACTLY db-setup's attributes (OWNER_BOOTSTRAP_Q4C_DO), no password yet (step 7 sets it), no
--     VALID UNTIL, no membership in any role.
--     NEEDS  CREATEROLE (or SUPERUSER). Giving the new role CREATEROLE also needs the admin to have CREATEROLE itself.
--     WHY    LOGIN: the API, the Worker and the migration child all connect as it, through one PG_DATABASE_URL.
--            NOSUPERUSER, NOBYPASSRLS: row-level security must bind it (tenant isolation).
--            NOREPLICATION, NOCREATEDB: not needed; the posture check refuses them.
--            INHERIT: it uses the privileges of the schema roles it creates and so owns every table through them.
--            CREATEROLE: on the FIRST start crewflow_owner creates its six schema roles, the role migrations set and then
--            remove their passwords (BC-17). After that first successful start you may remove it (step 9, optional).
--     NO-CR  NO. Without CREATEROLE nothing can create a role. On a provider that does not allow CREATEROLE at all,
--            Crewflow can not be installed (see the runbook, section 4a).
CREATE ROLE crewflow_owner LOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB CREATEROLE INHERIT;

-- (5) Its database rights, on THIS database only (the one psql is connected to; the name comes from the server, never
--     typed by you). The same statement as db-setup's.
--     NEEDS  CONNECT, CREATE and TEMPORARY on this database WITH GRANT OPTION (the database owner, or a superuser).
--     WHY    CONNECT: to log in to it. CREATE: the `core` and `workspace_*` schemas and the five extensions.
--            TEMPORARY: temporary tables in migrations. WITH GRANT OPTION: the first start re-grants CREATE on the database
--            to the schema role rab_owner, and a later migration to rab_secure_owner (Phase 0b preflight).
--     NO-CR  yes (a database privilege, not a role attribute).
DO $grant$
BEGIN
  EXECUTE pg_catalog.format('GRANT CONNECT, CREATE, TEMPORARY ON DATABASE %I TO crewflow_owner WITH GRANT OPTION',
                            pg_catalog.current_database());
END
$grant$;

-- (6) Re-check the result exactly, inside the transaction (db-setup's Q4d plus its owner-URL refusals). If anything
--     differs the transaction is rolled back and nothing is left behind.
--     NEEDS  nothing (catalog reads).
--     WHY    fail closed: what you commit is exactly what db-setup would have created.
--     NO-CR  yes.
DO $verify$
DECLARE
  r pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO r FROM pg_catalog.pg_roles WHERE rolname = 'crewflow_owner';
  IF NOT (r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolreplication AND NOT r.rolcreatedb
          AND r.rolcreaterole AND r.rolinherit AND r.rolvaliduntil IS NULL) THEN
    RAISE EXCEPTION 'refused: crewflow_owner does not have the expected attributes. Rolled back.';
  END IF;
  IF NOT (pg_catalog.has_database_privilege(r.oid, pg_catalog.current_database(), 'CONNECT WITH GRANT OPTION')
      AND pg_catalog.has_database_privilege(r.oid, pg_catalog.current_database(), 'CREATE WITH GRANT OPTION')
      AND pg_catalog.has_database_privilege(r.oid, pg_catalog.current_database(), 'TEMPORARY WITH GRANT OPTION')) THEN
    RAISE EXCEPTION 'refused: crewflow_owner did not get CONNECT, CREATE, TEMPORARY WITH GRANT OPTION on this database. Rolled back.';
  END IF;
  -- crewflow_owner is a member of no role at all (the schema roles come later, from crewflow_owner itself).
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = r.oid) THEN
    RAISE EXCEPTION 'refused: crewflow_owner is a member of a role. Rolled back.';
  END IF;
  -- Its only members are ADMIN-only creator rows (the posture check refuses anyone who can act as crewflow_owner).
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid = r.oid AND (inherit_option OR set_option OR NOT admin_option)) THEN
    RAISE EXCEPTION 'refused: a role can act as crewflow_owner (INHERIT or SET). Rolled back.';
  END IF;
  -- crewflow_owner must never own the database (db-setup refuses that database: security review H1).
  IF pg_catalog.pg_has_role(r.oid, (SELECT datdba FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()), 'MEMBER') THEN
    RAISE EXCEPTION 'refused: crewflow_owner owns this database. Rolled back.';
  END IF;
END
$verify$;

COMMIT;

-- (7) The password. psql asks twice, computes the SCRAM-SHA-256 verifier locally and sends
--     ALTER ROLE crewflow_owner PASSWORD '<verifier>' (never the password itself). Until this succeeds crewflow_owner
--     has no password and can not log in. If it fails, run only: \password crewflow_owner
--     NEEDS  SUPERUSER, or CREATEROLE plus the ADMIN option on crewflow_owner (step 4 gave the creating admin that).
--     WHY    PG_DATABASE_URL carries this password; db-setup copies it into its password file and the API and the Worker
--            log in with it. Use a long random value (openssl rand -hex 32): 1-1024 characters, no control characters;
--            percent-encode anything that is not URL-safe when you put it in the URL.
--     NO-CR  NO (changing another role's password needs CREATEROLE in PostgreSQL 16+).
--     NOTE   with log_statement = ddl or all the server log records the verifier (not the password). A verifier of a
--            32-byte random password can not be reversed in practice; check your provider's log retention anyway.
\password crewflow_owner

-- (8) What you created (read-only). Expected: one row
--       crewflow_owner | t | f | f | f | f | t | t | f | t
--     Then check the login from where Crewflow will run:
--       psql "postgresql://crewflow_owner@<direct-host>:5432/<database>?sslmode=verify-full" -X -c 'SELECT session_user'
SELECT r.rolname, r.rolcanlogin AS login, r.rolsuper AS superuser, r.rolbypassrls AS bypassrls,
       r.rolreplication AS replication, r.rolcreatedb AS createdb, r.rolcreaterole AS createrole, r.rolinherit AS inherit,
       r.rolvaliduntil IS NOT NULL AS expires,
       pg_catalog.has_database_privilege(r.oid, pg_catalog.current_database(), 'CREATE WITH GRANT OPTION') AS db_grant
  FROM pg_catalog.pg_roles r WHERE r.rolname = 'crewflow_owner';

-- (9) OPTIONAL hardening, ONLY after the first successful start (the API has migrated: `core` exists and /healthz is 200).
--     Not run by this script. The boot posture check accepts it, and db-setup logs one line about it.
--       ALTER ROLE crewflow_owner NOCREATEROLE;
--     NEEDS  SUPERUSER, or CREATEROLE plus the ADMIN option on crewflow_owner (the creating admin has it).
--     WHY    afterwards a leaked crewflow_owner URL can no longer create roles or change the passwords of the schema roles.
--     NO-CR  NO.
--     A later release whose migrations create or alter roles would need CREATEROLE back: check the release notes first
--     (the migration child refuses with exit 67 and says so).
