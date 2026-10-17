import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Database defence in depth (October 15 audit: CF-13 in-function authorisation, CF-12 / CF-58 search_path, CF-30).
 * Every change narrows what a caller holding an application role could do with SQL it should never be able to run
 * (an injection or an application bug). None changes a legitimate caller's result.
 *
 * CF-13, in-function authorisation for SECURITY DEFINER functions that bypass RLS as their owner:
 *   - auth_find_password_hash_by_user_id(uid) returned ANY organisation's password hash. Its only callers are step-up
 *     re-authentication of the caller's OWN account, so it now answers only for the bound user in the bound organisation.
 *   - list_organisations_for_admin() returned every organisation plus its CEO's contact details to any caller. Only an
 *     active platform administrator (the bound user) gets rows now.
 *   - create_organisation(name, slug) had no caller check. It now requires an active platform administrator.
 *   - mark_workspace_schema_superseded(ws, reason) accepted any organisation's workspace. It now acts only on a workspace
 *     of the caller's bound organisation (anything else reads as "not found", the same answer as a missing workspace).
 *
 * CF-12 / CF-58, search_path: DEFINER functions pinned `search_path = core, pg_catalog` — core BEFORE pg_catalog, so an
 * object created in schema core (owned by `crewflow`) named like a builtin would be resolved first inside a function
 * running as `rab_secure_owner`. They now run with `pg_catalog, core, pg_temp`: builtins cannot be shadowed, temporary
 * objects are consulted last, and unqualified references to core tables still resolve exactly as before.
 *
 * CF-30: `user_role_delete` only checked the organisation, while insert and update also require the role to be visible to
 * the caller (role RLS: same organisation, and an organisation-wide role or one of the bound workspace). Delete now
 * matches, so a bug in one workspace's session cannot remove another workspace's role assignment.
 *
 * Needs the privileged bootstrap identity (it redefines functions owned by rab_secure_owner).
 */
export class DatabaseDefenceInDepth1786717900000 implements MigrationInterface {
  name = 'DatabaseDefenceInDepth1786717900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.auth_find_password_hash_by_user_id(p_user_id uuid)
      RETURNS TABLE ("passwordHash" text)
      LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
      AS $function$
        SELECT u.password_hash FROM core."user" u
         WHERE u.id = p_user_id
           AND u.deleted_at IS NULL
           AND p_user_id = core.current_uid()
           AND u.organisation_id = core.current_org();
      $function$;
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.list_organisations_for_admin()
      RETURNS TABLE (id uuid, name text, slug citext, "suspendedAt" timestamptz, "createdAt" timestamptz, "ceoUserId" uuid, "ceoEmail" citext, "ceoFirstName" text, "ceoLastName" text, "ceoStatus" text)
      LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
      AS $function$
        SELECT o.id, o.name, o.slug, o.suspended_at, o.created_at,
               u.id, u.email, u.first_name, u.last_name, u.status
          FROM core.organisation o
          LEFT JOIN core.manager_profile mp ON mp.organisation_id = o.id AND mp.type = 'ceo'
          LEFT JOIN core."user" u ON u.id = mp.user_id
         WHERE core.is_active_platform_admin(core.current_uid())
         ORDER BY o.created_at DESC;
      $function$;
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.create_organisation(p_name text, p_slug citext)
      RETURNS uuid
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
      AS $function$
      DECLARE
        v_id uuid;
      BEGIN
        IF core.current_uid() IS NULL OR NOT core.is_active_platform_admin(core.current_uid()) THEN
          RAISE EXCEPTION 'only an active platform administrator can create an organisation' USING ERRCODE = 'insufficient_privilege';
        END IF;
        INSERT INTO core.organisation (name, slug) VALUES (p_name, p_slug) RETURNING id INTO v_id;
        RETURN v_id;
      END
      $function$;
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.mark_workspace_schema_superseded(p_workspace_id uuid, p_safe_reason text)
      RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
      AS $function$
      DECLARE
        v_org    uuid;
        v_status text;
        v_error  text;
        v_prev   text;
      BEGIN
        v_prev := current_setting('rab.organisation_id', true);
        SELECT w.organisation_id, w.schema_status INTO v_org, v_status
          FROM core.manager_workspace w WHERE w.id = p_workspace_id FOR UPDATE;
        -- CF-13: only a workspace of the caller's own bound organisation; another organisation's reads as not found.
        IF NOT FOUND OR v_prev IS NULL OR v_prev = '' OR v_prev <> v_org::text THEN
          RAISE EXCEPTION 'workspace not found' USING ERRCODE = 'P0002';
        END IF;
        IF v_status = 'SUPERSEDED' THEN
          RETURN;
        END IF;
        IF v_status IS DISTINCT FROM 'CREATING' AND v_status IS DISTINCT FROM 'FAILED' THEN
          RAISE EXCEPTION 'workspace schema is %, it cannot be superseded', coalesce(v_status, 'NULL') USING ERRCODE = '55000';
        END IF;
        v_error := left(coalesce(p_safe_reason, 'superseded'), 500);
        UPDATE core.workspace_schema_registry
           SET status = 'FAILED', migration_error = v_error
         WHERE workspace_id = p_workspace_id AND status IN ('PROVISIONING', 'FAILED');
        UPDATE core.manager_workspace
           SET schema_status = 'SUPERSEDED', schema_last_error = v_error
         WHERE id = p_workspace_id;
      END;
      $function$;
    `);

    // CF-12 / CF-58: builtins before core, temporary objects last, for every DEFINER function that still had core first.
    await queryRunner.query(`
      DO $paths$
      DECLARE
        r record;
      BEGIN
        FOR r IN
          SELECT p.oid::regprocedure AS fn
            FROM pg_proc p
           WHERE p.pronamespace = 'core'::regnamespace AND p.prosecdef
             AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) c WHERE c LIKE 'search_path=core%')
        LOOP
          EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, core, pg_temp', r.fn);
        END LOOP;
      END
      $paths$;
    `);

    await queryRunner.query(`
      ALTER POLICY user_role_delete ON core.user_role
        USING (organisation_id = core.current_org() AND EXISTS (SELECT 1 FROM core.role r WHERE r.id = user_role.role_id));
    `);

    // Verification: refuse to be recorded unless every DEFINER function has a safe search_path.
    await queryRunner.query(`
      DO $verify$
      DECLARE
        v text;
      BEGIN
        SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v
          FROM pg_proc p
         WHERE p.pronamespace = 'core'::regnamespace AND p.prosecdef
           AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) c
                            WHERE c LIKE 'search_path=pg_catalog%' OR c = 'search_path=""');
        IF v IS NOT NULL THEN
          RAISE EXCEPTION 'DatabaseDefenceInDepth1786717900000: SECURITY DEFINER function(s) without a pg_catalog-first search_path: %', v;
        END IF;
      END
      $verify$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER POLICY user_role_delete ON core.user_role USING (organisation_id = core.current_org());
    `);
    // search_path hardening and the in-function checks are not reverted: restoring a builtin-shadowable path or an
    // unauthenticated cross-organisation password-hash lookup would re-create the defects. Rolling back past this
    // migration leaves the functions in their hardened form, which every legitimate caller accepts.
  }
}
