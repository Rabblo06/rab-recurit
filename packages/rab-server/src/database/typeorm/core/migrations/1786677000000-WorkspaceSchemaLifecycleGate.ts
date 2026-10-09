import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hyper Workspace: one controlled lifecycle for a physical workspace schema, enforced in the database.
 *
 * Two lifecycle columns describe the same attempt and must never disagree:
 *   - core.manager_workspace.schema_status: CREATING | READY | MIGRATING | FAILED, or NULL for a legacy workspace. NULL, CREATING,
 *     MIGRATING and FAILED are NOT routable. Only READY routes.
 *   - core.workspace_schema_registry.status: PROVISIONING | READY | FAILED.
 *
 * Every transition goes through a function that updates BOTH rows in one call, so the provisioner never issues a direct UPDATE
 * against either lifecycle table:
 *   - core.begin_workspace_schema_attempt(ws)         NULL | FAILED | CREATING -> CREATING           (refuses READY and MIGRATING)
 *   - core.mark_workspace_schema_ready(ws, version)   CREATING | FAILED -> READY, registry -> READY  (refuses everything else)
 *   - core.mark_workspace_schema_failed(ws, error)    any non-READY -> FAILED, idempotent FAILED -> FAILED (refuses READY)
 *   - core.workspace_schema_routable(ws)              true only for READY with a READY registry row at version >= 1 (fails closed)
 *
 * mark_workspace_schema_ready and mark_workspace_schema_failed are replaced in place (CREATE OR REPLACE). Their grants are unchanged.
 * SECURITY DEFINER, pinned search_path, the organisation context is bound from the authoritative row and then restored, as before.
 */
export class WorkspaceSchemaLifecycleGate1786677000000 implements MigrationInterface {
  name = 'WorkspaceSchemaLifecycleGate1786677000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.begin_workspace_schema_attempt(p_workspace_id uuid)
      RETURNS text
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path TO 'pg_catalog', 'pg_temp'
      AS $function$
      DECLARE
        v_org    uuid;
        v_status text;
        v_prev   text;
      BEGIN
        IF p_workspace_id IS NULL THEN
          RAISE EXCEPTION 'workspace id is required' USING ERRCODE = '22004';
        END IF;
        SELECT w.organisation_id, w.schema_status INTO v_org, v_status
          FROM core.manager_workspace w WHERE w.id = p_workspace_id FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'workspace not found' USING ERRCODE = 'P0002';
        END IF;
        IF v_status IS NOT NULL AND v_status NOT IN ('CREATING', 'FAILED') THEN
          RAISE EXCEPTION 'workspace schema is %, a provisioning attempt cannot start', v_status USING ERRCODE = '55000';
        END IF;
        v_prev := current_setting('rab.organisation_id', true);
        PERFORM set_config('rab.organisation_id', v_org::text, true);
        UPDATE core.manager_workspace SET schema_status = 'CREATING' WHERE id = p_workspace_id;
        PERFORM set_config('rab.organisation_id', coalesce(v_prev, ''), true);
        RETURN 'CREATING';
      END;
      $function$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.mark_workspace_schema_ready(p_workspace_id uuid, p_schema_version integer)
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path TO 'pg_catalog', 'pg_temp'
      AS $function$
      DECLARE
        v_org    uuid;
        v_status text;
        v_prev   text;
      BEGIN
        IF p_schema_version IS NULL OR p_schema_version < 1 THEN
          RAISE EXCEPTION 'schema version must be >= 1' USING ERRCODE = '22023';
        END IF;
        SELECT w.organisation_id, w.schema_status INTO v_org, v_status
          FROM core.manager_workspace w WHERE w.id = p_workspace_id FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'workspace not found' USING ERRCODE = 'P0002';
        END IF;
        IF v_status IS NULL OR v_status NOT IN ('CREATING', 'FAILED') THEN
          RAISE EXCEPTION 'workspace schema is %, it cannot become READY', coalesce(v_status, 'NULL') USING ERRCODE = '55000';
        END IF;
        v_prev := current_setting('rab.organisation_id', true);
        PERFORM set_config('rab.organisation_id', v_org::text, true);
        UPDATE core.workspace_schema_registry
           SET status = 'READY', schema_version = p_schema_version, ready_at = now(),
               last_migrated_at = now(), migration_error = NULL
         WHERE workspace_id = p_workspace_id AND status IN ('PROVISIONING', 'FAILED');
        IF NOT FOUND THEN
          PERFORM set_config('rab.organisation_id', coalesce(v_prev, ''), true);
          RAISE EXCEPTION 'workspace schema registry is not in a state that can become READY' USING ERRCODE = '55000';
        END IF;
        UPDATE core.manager_workspace
           SET schema_status = 'READY', schema_version = p_schema_version, schema_migrated_at = now(), schema_last_error = NULL
         WHERE id = p_workspace_id;
        PERFORM set_config('rab.organisation_id', coalesce(v_prev, ''), true);
      END;
      $function$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.mark_workspace_schema_failed(p_workspace_id uuid, p_safe_error text)
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path TO 'pg_catalog', 'pg_temp'
      AS $function$
      DECLARE
        v_org    uuid;
        v_status text;
        v_error  text;
        v_prev   text;
      BEGIN
        SELECT w.organisation_id, w.schema_status INTO v_org, v_status
          FROM core.manager_workspace w WHERE w.id = p_workspace_id FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'workspace not found' USING ERRCODE = 'P0002';
        END IF;
        IF v_status = 'READY' THEN
          RAISE EXCEPTION 'a READY workspace schema cannot be marked failed' USING ERRCODE = '55000';
        END IF;
        v_error := left(coalesce(p_safe_error, 'provisioning failed'), 500);
        v_prev := current_setting('rab.organisation_id', true);
        PERFORM set_config('rab.organisation_id', v_org::text, true);
        -- Registry may not exist yet when the failure happens before registration. Then only the workspace row is marked.
        UPDATE core.workspace_schema_registry
           SET status = 'FAILED', migration_error = v_error
         WHERE workspace_id = p_workspace_id AND status IN ('PROVISIONING', 'FAILED');
        UPDATE core.manager_workspace
           SET schema_status = 'FAILED', schema_last_error = v_error
         WHERE id = p_workspace_id;
        PERFORM set_config('rab.organisation_id', coalesce(v_prev, ''), true);
      END;
      $function$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.workspace_schema_routable(p_workspace_id uuid)
      RETURNS boolean
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path TO 'pg_catalog', 'pg_temp'
      AS $function$
      DECLARE
        v_org     uuid;
        v_status  text;
        v_prev    text;
        v_ready   boolean;
      BEGIN
        SELECT w.organisation_id, w.schema_status INTO v_org, v_status
          FROM core.manager_workspace w WHERE w.id = p_workspace_id;
        IF NOT FOUND OR v_status IS DISTINCT FROM 'READY' THEN
          RETURN false;
        END IF;
        v_prev := current_setting('rab.organisation_id', true);
        PERFORM set_config('rab.organisation_id', v_org::text, true);
        SELECT EXISTS (
          SELECT 1 FROM core.workspace_schema_registry r
           WHERE r.workspace_id = p_workspace_id AND r.status = 'READY' AND r.schema_version >= 1
        ) INTO v_ready;
        PERFORM set_config('rab.organisation_id', coalesce(v_prev, ''), true);
        RETURN coalesce(v_ready, false);
      END;
      $function$
    `);

    await queryRunner.query(`REVOKE ALL ON FUNCTION core.begin_workspace_schema_attempt(uuid) FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.begin_workspace_schema_attempt(uuid) TO rab_app`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.workspace_schema_routable(uuid) FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.workspace_schema_routable(uuid) TO rab_app`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drops the two functions this migration added, then restores the EXACT previous bodies of the two it replaced. The bodies are
    // copied verbatim from WorkspaceSchemaRegistry1786674900000 (where they were created) and re-created with CREATE OR REPLACE. The
    // grants (REVOKE PUBLIC, EXECUTE rab_app) were never changed by this migration, so they are not touched here.
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.workspace_schema_routable(uuid)`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.begin_workspace_schema_attempt(uuid)`);
    await queryRunner.query(`
CREATE OR REPLACE FUNCTION core.mark_workspace_schema_ready(p_workspace_id uuid, p_schema_version integer)
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $$
      DECLARE
        v_org  uuid;
        v_prev text;
      BEGIN
        IF p_schema_version IS NULL OR p_schema_version < 1 THEN
          RAISE EXCEPTION 'schema version must be >= 1' USING ERRCODE = '22023';
        END IF;
        SELECT w.organisation_id INTO v_org FROM core.manager_workspace w WHERE w.id = p_workspace_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'workspace not found' USING ERRCODE = 'P0002';
        END IF;
        v_prev := current_setting('rab.organisation_id', true);
        PERFORM set_config('rab.organisation_id', v_org::text, true);
        UPDATE core.workspace_schema_registry
           SET status = 'READY', schema_version = p_schema_version, ready_at = now(),
               last_migrated_at = now(), migration_error = NULL
         WHERE workspace_id = p_workspace_id AND status IN ('PROVISIONING', 'FAILED');
        IF NOT FOUND THEN
          PERFORM set_config('rab.organisation_id', coalesce(v_prev, ''), true);
          RAISE EXCEPTION 'workspace schema is not in a state that can become READY' USING ERRCODE = '55000';
        END IF;
        PERFORM set_config('rab.organisation_id', coalesce(v_prev, ''), true);
      END;
      $$;
    `);
    await queryRunner.query(`
CREATE OR REPLACE FUNCTION core.mark_workspace_schema_failed(p_workspace_id uuid, p_safe_error text)
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $$
      DECLARE
        v_org  uuid;
        v_prev text;
      BEGIN
        SELECT w.organisation_id INTO v_org FROM core.manager_workspace w WHERE w.id = p_workspace_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'workspace not found' USING ERRCODE = 'P0002';
        END IF;
        v_prev := current_setting('rab.organisation_id', true);
        PERFORM set_config('rab.organisation_id', v_org::text, true);
        UPDATE core.workspace_schema_registry
           SET status = 'FAILED', migration_error = left(coalesce(p_safe_error, 'provisioning failed'), 500)
         WHERE workspace_id = p_workspace_id AND status = 'PROVISIONING';
        IF NOT FOUND THEN
          PERFORM set_config('rab.organisation_id', coalesce(v_prev, ''), true);
          RAISE EXCEPTION 'workspace schema is not in a state that can fail' USING ERRCODE = '55000';
        END IF;
        PERFORM set_config('rab.organisation_id', coalesce(v_prev, ''), true);
      END;
      $$;
    `);
  }
}
