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
-- (never a transaction pooler), with TLS, AS A FILE (never pasted into an interactive session):
--
--   openssl rand -hex 32          # the crewflow_owner password: 64 hex characters, URL-safe; keep it in your secret store
--   psql "postgresql://<admin>@<direct-host>:5432/<database>?sslmode=verify-full" -X -v ON_ERROR_STOP=1 \
--     -f own-database-app-login.sql
--
-- Everything that changes the database runs in ONE transaction: the checks, CREATE ROLE, the GRANT, the password and the
-- final re-check. Any failure (a refused check, a missing privilege, mismatched passwords) leaves nothing behind.
-- psql asks for the new password twice (`\password`), turns it into a SCRAM-SHA-256 verifier on YOUR machine and sends
-- only the verifier. Afterwards the runbook's login test (section 4a, step 3) is REQUIRED before you set any variable or
-- deploy; if it fails, drop the role (runbook section 4a) and run this file again. After the first start has completed,
-- removing CREATEROLE (step 10 below, runbook step 6) is REQUIRED too.
--
-- Every statement is annotated with:
--   NEEDS    the privilege the admin running it needs;
--   WHY      why Crewflow needs it;
--   NO-CR    whether it can be done by an admin WITHOUT the CREATEROLE attribute.
--
-- It never alters a role that already exists, and no statement takes a value from outside the file (the password goes
-- only through \password).
-- =====================================================================================================================

-- psql settings that make the transaction below all-or-nothing whatever your ~/.psqlrc says:
--   ON_ERROR_STOP     stop at the first error (a refused check, a missing privilege, mismatched passwords);
--   ON_ERROR_ROLLBACK off: never wrap a statement in a savepoint, so a failed check aborts the whole transaction;
--   AUTOCOMMIT on     BEGIN / COMMIT below are the only transaction boundaries.
\set ON_ERROR_STOP on
\set ON_ERROR_ROLLBACK off
\set AUTOCOMMIT on

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

-- (3) db-setup's Q1, verbatim: a superuser session stops logging this session's statements (so the password verifier
--     sent in step 7 is not written to the server log). For a non-superuser admin it is a no-op (zero rows): those
--     settings are superuser-only. See the NOTE at step 7.
--     NEEDS  nothing (a superuser changes the settings; anyone else gets zero rows).
--     WHY    keep the verifier out of the server log where the admin is allowed to.
--     NO-CR  yes.
SELECT pg_catalog.set_config('log_statement', 'none', false),
       pg_catalog.set_config('log_min_error_statement', 'panic', false),
       pg_catalog.set_config('log_parameter_max_length', '0', false)
  FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper;

BEGIN;

-- (4) Read-only checks, INSIDE the transaction: a failed check aborts it, so even if psql went on (a pasted session),
--     every later statement fails and COMMIT becomes ROLLBACK. Each check is a refusal db-setup or the first API start
--     would otherwise give later.
--     NEEDS  nothing beyond CONNECT (catalog reads only).
--     WHY    see each message.
--     NO-CR  yes.
DO $preflight$
DECLARE
  v_admin pg_catalog.pg_roles%ROWTYPE;
BEGIN
  IF pg_catalog.current_setting('server_version_num')::int < 160000 THEN
    RAISE EXCEPTION 'refused: PostgreSQL 15 and earlier are not supported. There, CREATEROLE lets crewflow_owner grant itself predefined roles such as pg_execute_server_program (run programs on the database server) and pg_read_server_files, so Crewflow refuses these servers everywhere. Use PostgreSQL 16 or later. Nothing was changed.';
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
    RAISE EXCEPTION 'refused: crewflow_owner already exists. Use its URL as it is (db-setup checks it), or drop it first (runbook section 4a). This script never changes an existing role. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles
              WHERE rolname IN ('rab_owner', 'rab_app', 'rab_secure_owner', 'crewflow', 'crewflow_app', 'crewflow_worker', 'crewflow_rolemaker')) THEN
    RAISE EXCEPTION 'refused: Crewflow schema roles already exist on this PostgreSQL cluster (roles are cluster-wide: one Crewflow deployment per cluster). A new crewflow_owner could not adopt them. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s
               JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase AND d.datname = pg_catalog.current_database()
              CROSS JOIN LATERAL pg_catalog.unnest(s.setconfig) AS c(setting)
              WHERE s.setrole = 0 AND pg_catalog.lower(pg_catalog.split_part(c.setting, '=', 1)) = 'search_path') THEN
    RAISE EXCEPTION 'refused: this database has a database-wide search_path default (ALTER DATABASE ... SET search_path). db-setup''s admin-URL path refuses such a database (security review H1). Remove it first (ALTER DATABASE <db> RESET search_path). Nothing was changed.';
  END IF;
  IF pg_catalog.current_setting('password_encryption') <> 'scram-sha-256' THEN
    RAISE EXCEPTION 'refused: password_encryption is not scram-sha-256 here, so \password would store an md5 hash. Run psql again with PGOPTIONS=''-c password_encryption=scram-sha-256''. Nothing was changed.';
  END IF;
END
$preflight$;

-- (5) The app login, with EXACTLY db-setup's attributes (OWNER_BOOTSTRAP_Q4C_DO), no password yet (step 7 sets it, in
--     this same transaction), no VALID UNTIL, no membership in any role.
--     NEEDS  CREATEROLE (or SUPERUSER). Giving the new role CREATEROLE also needs the admin to have CREATEROLE itself.
--     WHY    LOGIN: the API, the Worker and the migration child all connect as it, through one PG_DATABASE_URL.
--            NOSUPERUSER, NOBYPASSRLS: row-level security must bind it (tenant isolation).
--            NOREPLICATION, NOCREATEDB: not needed; the posture check refuses them.
--            INHERIT: it uses the privileges of the schema roles it creates and so owns every table through them.
--            CREATEROLE: on the FIRST start crewflow_owner creates its six schema roles, the role migrations set and then
--            remove their passwords (BC-17). After that first start has completed you MUST remove it (step 10, REQUIRED).
--     NO-CR  NO. Without CREATEROLE nothing can create a role. On a provider that does not allow CREATEROLE at all,
--            Crewflow can not be installed (see the runbook, section 4a).
CREATE ROLE crewflow_owner LOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB CREATEROLE INHERIT;
-- (5b) Owner decision 2026-11-18: the CREATEROLE mark, the same statement db-setup sends (OWNER_HARDEN_H3_MARK_PENDING). In
--     production rab-api, rab-worker and the CLI refuse a CREATEROLE crewflow_owner at boot UNLESS it carries exactly this
--     comment, which says "CREATEROLE until the schema is current" (database-boot-gate-rules.ts assertCreateRoleGate), and
--     db-setup (without PG_ADMIN_URL) refuses an unmarked CREATEROLE crewflow_owner before the first start for the same
--     reason. Step 10 removes the attribute and the mark together.
--     NEEDS  SUPERUSER, or CREATEROLE plus the ADMIN option on crewflow_owner (step 5 gave the creating admin that).
--     WHY    crewflow_owner itself can not set or clear it (it has no ADMIN option on itself), so the mark records the
--            admin's intent: an admin who later re-grants CREATEROLE without it is refused at the next boot.
--     NO-CR  NO.
COMMENT ON ROLE crewflow_owner IS 'crewflow:createrole-until-schema-current';

-- (6) Its database rights, on THIS database only (the one psql is connected to; the name comes from the server, never
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

-- (7) The password, inside the transaction. psql asks twice, computes the SCRAM-SHA-256 verifier locally and sends
--     ALTER ROLE crewflow_owner PASSWORD '<verifier>' (never the password itself). Mismatched entries stop psql here and
--     the whole transaction is rolled back.
--     NEEDS  SUPERUSER, or CREATEROLE plus the ADMIN option on crewflow_owner (step 5 gave the creating admin that; it is
--            visible inside this transaction).
--     WHY    PG_DATABASE_URL carries this password; db-setup copies it into its password file and the API and the Worker
--            log in with it. Use a long random value (openssl rand -hex 32): 1-1024 characters, no control characters;
--            percent-encode anything that is not URL-safe when you put it in the URL.
--     NO-CR  NO (changing another role's password needs CREATEROLE in PostgreSQL 16+).
--     NOTE   the verifier (not the password) can appear in server logs (log_statement ddl/all, or any failed ALTER),
--            pg_stat_statements and audit logs (pgaudit, provider audit). With verify-full TLS it is only an
--            offline-guessing target, which a 32-byte random password defeats. Step 3 keeps it out of the server log
--            only for a superuser admin.
--     NOTE   an EMPTY entry (two empty lines, or end of input) is accepted by psql, and the server then clears the
--            password (NOTICE "empty string is not a valid password, clearing password"). A superuser admin is refused
--            at step 8; a non-superuser admin can not read whether a password is set, so the runbook's login check
--            (step 3) catches it: drop the role and run this file again.
\password crewflow_owner

-- (8) Re-check the result exactly, inside the transaction (db-setup's Q4d plus its owner-URL refusals). If anything
--     differs the transaction is rolled back and nothing is left behind.
--     NEEDS  nothing (catalog reads); the password check reads pg_authid, which only a superuser can.
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
  -- crewflow_owner must never own the database (db-setup's admin-URL path refuses such a database: security review H1).
  IF pg_catalog.pg_has_role(r.oid, (SELECT datdba FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()), 'MEMBER') THEN
    RAISE EXCEPTION 'refused: crewflow_owner owns this database, which db-setup''s admin-URL path refuses. Rolled back.';
  END IF;
  -- The password is set, as a SCRAM-SHA-256 verifier. Only a superuser can read pg_authid; for any other admin the
  -- runbook's login check (step 3) is the proof.
  IF (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_authid
                    WHERE rolname = 'crewflow_owner' AND rolpassword OPERATOR(pg_catalog.~~) 'SCRAM-SHA-256$%') THEN
      RAISE EXCEPTION 'refused: crewflow_owner has no SCRAM-SHA-256 password (an empty entry clears it). Rolled back.';
    END IF;
  END IF;
END
$verify$;

COMMIT;

\echo 'Next: run step 3 of runbook section 4a now (log in as crewflow_owner). If it fails, drop the role and run this file again.'

-- (9) What you created (read-only). Expected: one row
--       crewflow_owner | t | f | f | f | f | t | t | f | t
--     Then check the login from where Crewflow will run (runbook section 4a, step 3).
SELECT r.rolname, r.rolcanlogin AS login, r.rolsuper AS superuser, r.rolbypassrls AS bypassrls,
       r.rolreplication AS replication, r.rolcreatedb AS createdb, r.rolcreaterole AS createrole, r.rolinherit AS inherit,
       r.rolvaliduntil IS NOT NULL AS expires,
       pg_catalog.has_database_privilege(r.oid, pg_catalog.current_database(), 'CREATE WITH GRANT OPTION') AS db_grant
  FROM pg_catalog.pg_roles r WHERE r.rolname = 'crewflow_owner';

-- (10) REQUIRED, after the first start has completed: the rab-api log shows the migrate result with serve=true, or a
--     restart reports state CURRENT (/healthz 200 alone is a loose signal). Not before: the first start needs
--     CREATEROLE to create the schema roles. Not run by this script (runbook section 4a,
--     step 6; owner decision 2026-11-17: like Twenty, the app login never keeps CREATEROLE). Since owner decision
--     2026-11-18 it is ENFORCED: once the schema is complete, db-setup (without PG_ADMIN_URL) and, in production, the boot
--     check refuse a CREATEROLE crewflow_owner until this step ran (the mark of step 5b only covers the first start).
--       ALTER ROLE crewflow_owner NOCREATEROLE;
--       COMMENT ON ROLE crewflow_owner IS NULL;
--     NEEDS  SUPERUSER, or CREATEROLE plus the ADMIN option on crewflow_owner (the creating admin has it).
--     WHY    afterwards a leaked crewflow_owner URL can no longer create roles or change the passwords of the schema roles.
--            It still holds the ADMIN option on the schema roles it created, so it can still GRANT those roles to
--            existing roles; the posture check refuses any such extra member at the next boot.
--     NO-CR  NO.
--     A later release whose migrations create or alter roles would need CREATEROLE back for that one upgrade: its release
--     notes must say so, the migration child refuses with exit 67 and names it, and the admin removes it again afterwards.
