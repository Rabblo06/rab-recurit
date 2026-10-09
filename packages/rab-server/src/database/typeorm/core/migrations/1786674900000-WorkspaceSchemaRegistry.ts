import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hyper Workspace Phase 3, steps 1–2 — authoritative workspace schema registry.
 *
 * core.workspace_schema_registry is the ONLY runtime source of physical workspace schema names.
 * Security properties enforced by the database, not by service code:
 * - one row per workspace (PK workspace_id), and one row per schema name (UNIQUE schema_name);
 * - the schema name is DERIVED: CHECK (schema_name = 'workspace_' || replace(workspace_id::text,'-','')).
 *   A client, or a bug, cannot store any other name;
 * - organisation_id is composite-FK'd to the authoritative manager_workspace row, so the mapping cannot cross organisations;
 * - FORCE RLS: a row is visible only inside its own organisation (core.current_org());
 * - rab_app has SELECT only. Mapping changes happen only through the three SECURITY DEFINER functions below, and each
 *   accepts a workspace UUID, never a schema name, and only moves status forward.
 *
 * Status vocabulary (only states the runtime needs):
 *   PROVISIONING — created, schema not yet verified READY
 *   READY        — schema provisioned, migrated and verified; the only status business routing accepts
 *   FAILED       — provisioning failed; the workspace is not routable; retry moves it back to PROVISIONING via register
 *
 * This migration does not create any workspace schema and does not route any business traffic.
 */
export class WorkspaceSchemaRegistry1786674900000 implements MigrationInterface {
  name = 'WorkspaceSchemaRegistry1786674900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE core.workspace_schema_registry (
        workspace_id        uuid PRIMARY KEY,
        organisation_id     uuid NOT NULL,
        schema_name         text NOT NULL UNIQUE,
        schema_version      integer NOT NULL DEFAULT 0,
        status              text NOT NULL DEFAULT 'PROVISIONING',
        created_at          timestamptz NOT NULL DEFAULT now(),
        ready_at            timestamptz,
        last_migrated_at    timestamptz,
        migration_error     text,
        CONSTRAINT workspace_schema_registry_workspace_org_fkey
          FOREIGN KEY (workspace_id, organisation_id) REFERENCES core.manager_workspace (id, organisation_id) ON DELETE RESTRICT,
        CONSTRAINT workspace_schema_registry_name_derived_check
          CHECK (schema_name = 'workspace_' || replace(workspace_id::text, '-', '')),
        CONSTRAINT workspace_schema_registry_status_check
          CHECK (status IN ('PROVISIONING', 'READY', 'FAILED')),
        CONSTRAINT workspace_schema_registry_version_check
          CHECK (schema_version >= 0),
        CONSTRAINT workspace_schema_registry_ready_check
          CHECK (status <> 'READY' OR (ready_at IS NOT NULL AND schema_version >= 1)),
        CONSTRAINT workspace_schema_registry_error_length_check
          CHECK (migration_error IS NULL OR char_length(migration_error) <= 500)
      );
    `);

    await queryRunner.query(`ALTER TABLE core.workspace_schema_registry ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.workspace_schema_registry FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY workspace_schema_registry_tenant ON core.workspace_schema_registry
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);
    await queryRunner.query(`GRANT SELECT ON core.workspace_schema_registry TO rab_app;`);
    await queryRunner.query(`REVOKE INSERT, UPDATE, DELETE ON core.workspace_schema_registry FROM rab_app;`);

    // register: create the PROVISIONING row for an existing authoritative workspace. Idempotent.
    // Returns the DERIVED name, never an argument. Refuses unknown workspaces.
    await queryRunner.query(`
      CREATE FUNCTION core.register_workspace_schema(p_workspace_id uuid)
      RETURNS text
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $$
      DECLARE
        v_org  uuid;
        v_name text;
        v_prev text;
      BEGIN
        IF p_workspace_id IS NULL THEN
          RAISE EXCEPTION 'workspace id is required' USING ERRCODE = '22004';
        END IF;
        SELECT w.organisation_id INTO v_org FROM core.manager_workspace w WHERE w.id = p_workspace_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'workspace not found' USING ERRCODE = 'P0002';
        END IF;
        v_name := 'workspace_' || replace(p_workspace_id::text, '-', '');
        -- FORCE RLS applies to the owner: bind the organisation from the authoritative row, then restore the caller's value.
        v_prev := current_setting('rab.organisation_id', true);
        PERFORM set_config('rab.organisation_id', v_org::text, true);
        INSERT INTO core.workspace_schema_registry (workspace_id, organisation_id, schema_name, status)
          VALUES (p_workspace_id, v_org, v_name, 'PROVISIONING')
          ON CONFLICT (workspace_id) DO NOTHING;
        v_name := (SELECT r.schema_name FROM core.workspace_schema_registry r WHERE r.workspace_id = p_workspace_id);
        PERFORM set_config('rab.organisation_id', coalesce(v_prev, ''), true);
        RETURN v_name;
      END;
      $$;
    `);

    // mark_ready: only from PROVISIONING or FAILED, and only after the caller has verified the schema.
    await queryRunner.query(`
      CREATE FUNCTION core.mark_workspace_schema_ready(p_workspace_id uuid, p_schema_version integer)
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

    // mark_failed: only from PROVISIONING. The error text is a SAFE SUMMARY supplied by the caller and is length-limited.
    await queryRunner.query(`
      CREATE FUNCTION core.mark_workspace_schema_failed(p_workspace_id uuid, p_safe_error text)
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

    for (const fn of [
      'core.register_workspace_schema(uuid)',
      'core.mark_workspace_schema_ready(uuid, integer)',
      'core.mark_workspace_schema_failed(uuid, text)',
    ]) {
      await queryRunner.query(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC;`);
      await queryRunner.query(`GRANT EXECUTE ON FUNCTION ${fn} TO rab_app;`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.mark_workspace_schema_failed(uuid, text);`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.mark_workspace_schema_ready(uuid, integer);`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.register_workspace_schema(uuid);`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.workspace_schema_registry;`);
  }
}
