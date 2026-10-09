import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 1 — hybrid workspace-schema foundation (docs/architecture/10-PHASE-ARCHITECTURE-MIGRATION.md).
 *
 * Adds the lifecycle state for a per-workspace PostgreSQL schema to the EXISTING
 * `core.manager_workspace` registry (no second registry), and one restricted
 * provisioning function. Moves NO business data: every existing row keeps
 * `schema_status` NULL, meaning "legacy shared-core workspace, not yet provisioned".
 *
 * Decisions (see the architecture doc):
 * - The schema name is DERIVED from the workspace UUID, never stored. A stored copy
 *   would be a second source of truth.
 * - `schema_status` follows the existing text + CHECK convention used by `status` on
 *   this table, not a Postgres enum type.
 * - The provisioning function accepts ONLY a uuid, derives the name internally,
 *   creates only that schema, grants USAGE only to rab_app (never CREATE), and is
 *   executable by rab_app alone (PUBLIC revoked).
 */
export class WorkspaceSchemaProvisioning1786674600000 implements MigrationInterface {
  name = 'WorkspaceSchemaProvisioning1786674600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.manager_workspace
        ADD COLUMN schema_status text,
        ADD COLUMN schema_version integer NOT NULL DEFAULT 0,
        ADD COLUMN schema_last_error text,
        ADD COLUMN schema_migrated_at timestamptz,
        ADD CONSTRAINT manager_workspace_schema_status_check
          CHECK (schema_status IS NULL OR schema_status IN ('CREATING', 'READY', 'MIGRATING', 'FAILED')),
        ADD CONSTRAINT manager_workspace_schema_version_check
          CHECK (schema_version >= 0);
    `);

    // Restricted provisioning. Runs as rab_owner (SECURITY DEFINER) so it can CREATE SCHEMA;
    // rab_app holds no CREATE privilege anywhere.
    //
    // Serialisation: the registry row is locked FOR UPDATE, so two concurrent provisioning
    // calls for the same workspace run one after the other. The second sees the schema
    // already present and owned by rab_owner, and returns the same name (idempotent).
    //
    // Ownership check: if a schema with the derived name already exists but is not owned by
    // rab_owner, the call fails rather than adopting it.
    await queryRunner.query(`
      CREATE FUNCTION core.provision_workspace_schema(p_workspace_id uuid)
      RETURNS text
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $$
      DECLARE
        v_name   text;
        v_status text;
        v_owner  text;
      BEGIN
        IF p_workspace_id IS NULL THEN
          RAISE EXCEPTION 'workspace id is required' USING ERRCODE = '22004';
        END IF;

        -- uuid::text is always canonical lowercase with hyphens, so this derivation is total
        -- and cannot carry arbitrary characters into the identifier.
        v_name := 'workspace_' || replace(p_workspace_id::text, '-', '');
        IF v_name !~ '^workspace_[0-9a-f]{32}$' THEN
          RAISE EXCEPTION 'derived schema name failed canonical check' USING ERRCODE = '22023';
        END IF;

        SELECT w.schema_status INTO v_status
          FROM core.manager_workspace w
         WHERE w.id = p_workspace_id
           FOR UPDATE;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'workspace not found' USING ERRCODE = 'P0002';
        END IF;
        IF v_status IS NULL THEN
          RAISE EXCEPTION 'workspace is not in a provisionable state' USING ERRCODE = '55000';
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = v_name) THEN
          EXECUTE format('CREATE SCHEMA %I AUTHORIZATION rab_owner', v_name);
        END IF;

        SELECT pg_catalog.pg_get_userbyid(n.nspowner) INTO v_owner
          FROM pg_catalog.pg_namespace n
         WHERE n.nspname = v_name;
        IF v_owner IS DISTINCT FROM 'rab_owner' THEN
          RAISE EXCEPTION 'existing schema is not owned by rab_owner' USING ERRCODE = '42501';
        END IF;

        -- USAGE only, to the one runtime role. Never CREATE.
        EXECUTE format('GRANT USAGE ON SCHEMA %I TO rab_app', v_name);

        RETURN v_name;
      END;
      $$;
    `);

    await queryRunner.query(`REVOKE ALL ON FUNCTION core.provision_workspace_schema(uuid) FROM PUBLIC;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.provision_workspace_schema(uuid) TO rab_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Schemas created by the function are NOT dropped here: they may hold data. Down removes
    // only the lifecycle machinery added by this migration.
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.provision_workspace_schema(uuid);`);
    await queryRunner.query(`
      ALTER TABLE core.manager_workspace
        DROP CONSTRAINT IF EXISTS manager_workspace_schema_version_check,
        DROP CONSTRAINT IF EXISTS manager_workspace_schema_status_check,
        DROP COLUMN IF EXISTS schema_migrated_at,
        DROP COLUMN IF EXISTS schema_last_error,
        DROP COLUMN IF EXISTS schema_version,
        DROP COLUMN IF EXISTS schema_status;
    `);
  }
}
