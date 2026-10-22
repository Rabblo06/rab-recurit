import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Foundation fix P3 (2026-10-22): a fresh install left `core.navigation_layout` owned by the bootstrap SUPERUSER.
 *
 * Root cause: every migration after the role split (`CrewflowSingleCredentialRoleArchitecture1786682000000`) runs in
 * phase B as the bootstrap superuser (the only identity that may act as `rab_secure_owner`). PostgreSQL makes the
 * connecting role the owner of anything it creates, so a phase-B migration that creates an object without an explicit
 * `OWNER TO` hands that object to the superuser. `ReconcileCoreOwnershipAndRuntimeGrants1786717700000` repaired every
 * object that existed when it ran, but `NavigationLayout1786718600000` (created later, no `OWNER TO`) reintroduced the
 * defect. The table worked only because `crewflow`/`crewflow_app` had explicit grants; `crewflow` lacked the owner's
 * DELETE/TRUNCATE/REFERENCES/TRIGGER and the security-posture golden snapshot drifted until someone ran
 * `ALTER TABLE core.navigation_layout OWNER TO crewflow` by hand after every fresh install.
 *
 * This migration does NOT edit the applied migration. It applies the same ownership model the reconcile migration
 * documents, but ONLY to objects in schema `core` that a superuser currently owns, so on a database where the manual
 * ALTER was already run (rab-devdb, the long-lived test database) it is a no-op:
 *   - tables, partitioned tables, views, materialized views and stand-alone sequences → `crewflow`
 *     (identity/serial sequences and indexes follow their table automatically);
 *   - non-SECURITY-DEFINER functions and stand-alone types → `crewflow`;
 *   - schema `core` itself → `crewflow`.
 * It never guesses where a guess could weaken RLS, and refuses (rolling back) instead:
 *   - a superuser-owned table that has RLS enabled WITHOUT FORCE (a pre-auth table): `crewflow` owning it would bypass
 *     its policies, so it must be assigned to `rab_secure_owner` deliberately, in its own reviewed migration;
 *   - a superuser-owned SECURITY DEFINER function: its owner decides what it can bypass, so it needs an explicit owner.
 * Ownership transfer keeps every existing grant (PostgreSQL re-grants the old owner's ACL entries from the new owner),
 * so `crewflow_app`'s narrower privileges (e.g. SELECT/INSERT/UPDATE only on navigation_layout) are unchanged.
 *
 * Verification: after the changes it re-reads the catalog and RAISES if any `core` object is still owned by a superuser.
 * Never grants anything, never touches RLS policies, never adds BYPASSRLS. Idempotent.
 *
 * Authority: only the bootstrap superuser (phase B) can act as a superuser-owned object's owner, which is also the only
 * way such an object can exist. On a database with nothing to fix it runs under any identity, because it changes nothing.
 *
 * down(): intentionally a no-op — handing objects back to a superuser would re-create the defect.
 */
export class ReconcileSuperuserOwnedCoreObjects1786719600000 implements MigrationInterface {
  name = 'ReconcileSuperuserOwnedCoreObjects1786719600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $reconcile$
      DECLARE
        r record;
        v_refused text;
      BEGIN
        -- Refuse what must not be guessed (see the header). Nothing has changed yet, so the raise rolls back cleanly.
        SELECT string_agg(x, '; ' ORDER BY x) INTO v_refused FROM (
          SELECT format('table %s has RLS enabled without FORCE (a pre-auth table needs rab_secure_owner, decided explicitly)', c.oid::regclass) AS x
            FROM pg_class c JOIN pg_roles o ON o.oid = c.relowner
           WHERE c.relnamespace = 'core'::regnamespace AND c.relkind IN ('r', 'p') AND o.rolsuper
             AND c.relrowsecurity AND NOT c.relforcerowsecurity
          UNION ALL
          SELECT format('function %s is SECURITY DEFINER (its owner must be chosen explicitly)', p.oid::regprocedure)
            FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
           WHERE p.pronamespace = 'core'::regnamespace AND p.prosecdef AND o.rolsuper
        ) refused;
        IF v_refused IS NOT NULL THEN
          RAISE EXCEPTION 'ReconcileSuperuserOwnedCoreObjects1786719600000 refuses to guess an owner for: %', v_refused
            USING ERRCODE = 'insufficient_privilege';
        END IF;

        -- Schema first: a non-owner can only hand an object to a role that has CREATE on its schema.
        IF (SELECT r2.rolsuper FROM pg_namespace n JOIN pg_roles r2 ON r2.oid = n.nspowner WHERE n.nspname = 'core') THEN
          ALTER SCHEMA core OWNER TO crewflow;
        END IF;

        FOR r IN
          SELECT c.oid::regclass AS rel, c.relkind
            FROM pg_class c JOIN pg_roles o ON o.oid = c.relowner
           WHERE c.relnamespace = 'core'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S') AND o.rolsuper
             -- An identity/serial sequence follows its table's owner automatically.
             AND NOT (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i')))
        LOOP
          EXECUTE format('ALTER %s %s OWNER TO crewflow',
            CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END, r.rel);
        END LOOP;

        FOR r IN
          SELECT p.oid::regprocedure AS fn, p.prokind
            FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
           WHERE p.pronamespace = 'core'::regnamespace AND NOT p.prosecdef AND o.rolsuper
             AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
        LOOP
          EXECUTE format('ALTER %s %s OWNER TO crewflow', CASE r.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END, r.fn);
        END LOOP;

        -- Stand-alone types only (enums, domains, ranges, composites not backing a table); array types follow their element.
        FOR r IN
          SELECT t.oid::regtype AS typ, t.typtype
            FROM pg_type t JOIN pg_roles o ON o.oid = t.typowner
           WHERE t.typnamespace = 'core'::regnamespace AND o.rolsuper
             AND (t.typrelid = 0 OR (SELECT c.relkind FROM pg_class c WHERE c.oid = t.typrelid) = 'c')
             AND t.typelem = 0
             AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = t.oid AND d.deptype = 'e')
        LOOP
          EXECUTE format('ALTER %s %s OWNER TO crewflow', CASE r.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END, r.typ);
        END LOOP;

        -- Verification: refuse to be recorded as applied unless nothing in core is superuser-owned any more.
        SELECT string_agg(x, '; ' ORDER BY x) INTO v_refused FROM (
          SELECT format('%s owned by superuser %s', c.oid::regclass, pg_get_userbyid(c.relowner)) AS x
            FROM pg_class c JOIN pg_roles o ON o.oid = c.relowner
           WHERE c.relnamespace = 'core'::regnamespace AND o.rolsuper
          UNION ALL
          SELECT format('%s owned by superuser %s', p.oid::regprocedure, pg_get_userbyid(p.proowner))
            FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
           WHERE p.pronamespace = 'core'::regnamespace AND o.rolsuper
             AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
          UNION ALL
          SELECT 'schema core owned by a superuser' FROM pg_namespace n JOIN pg_roles o ON o.oid = n.nspowner
           WHERE n.nspname = 'core' AND o.rolsuper
        ) left_over;
        IF v_refused IS NOT NULL THEN
          RAISE EXCEPTION 'ReconcileSuperuserOwnedCoreObjects1786719600000 verification failed: %', v_refused;
        END IF;
      END
      $reconcile$;
    `);
  }

  public async down(): Promise<void> {
    // Intentionally a no-op: see the header.
  }
}
