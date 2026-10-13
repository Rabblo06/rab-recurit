import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P2/P3 Checkpoint 2 (restricted runtime role) follow-up — a real, confirmed gap, not theoretical.
 *
 * `core.provision_workspace_schema()` (redefined by `CrewflowSingleCredentialRoleArchitecture1786682000000`)
 * grants `USAGE, CREATE` on a newly-provisioned workspace schema to `crewflow` alone — correct for
 * crewflow's own role in provisioning (the worker's dedicated, non-pooled connection runs this
 * function AS crewflow and then applies `WORKSPACE_SCHEMA_V1_TEMPLATE`'s CREATE TABLE statements
 * over that same connection, so it genuinely needs CREATE). But `crewflow_app` — the actual runtime
 * identity ordinary API/Worker business queries authenticate as since this checkpoint — was never
 * granted even USAGE on the schema, so every table inside it is invisible to the real runtime
 * connection (`relation "..." does not exist`, not `permission denied`, because Postgres hides
 * existence when the schema itself isn't even visible). This is the exact same class of bug the
 * P2.2 rab_app-to-crewflow fix already caught once in `tools/generate-workspace-schema-v1.js`
 * (confirmed live again via `workspace-execution-context.integration.spec.ts` failing with
 * `relation "probe" does not exist` after this checkpoint's own regression run, once the test's own
 * stale test-harness credential issue was ruled out separately).
 *
 * Fix: redefine the function (CREATE OR REPLACE, not edit the original migration) to additionally
 * grant USAGE ONLY (never CREATE) to `crewflow_app` — preserving the "ordinary runtime role can
 * never acquire schema-level CREATE" guarantee this checkpoint's whole design rests on.
 * `tools/generate-workspace-schema-v1.js` was separately fixed to also grant per-table DML to
 * `crewflow_app` for the 15 business tables themselves (regenerating
 * `workspace-schema-v1.sql`/`.template.ts`), since schema USAGE alone does not grant table access.
 */
export class WorkspaceSchemaCrewflowAppUsageGrant1786688000000 implements MigrationInterface {
  name = 'WorkspaceSchemaCrewflowAppUsageGrant1786688000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // provision_workspace_schema is owned by rab_secure_owner (CrewflowSingleCredentialRoleArchitecture1786682000000)
    // — redefining it requires the connecting role to itself be able to own/alter it, which `crewflow`
    // (the ordinary migration identity) structurally cannot, by the same design this checkpoint relies
    // on elsewhere. Confirmed empirically: running this migration as crewflow failed with "must be owner
    // of function provision_workspace_schema" before this guard was added.
    await assertBootstrapPrivilege(queryRunner);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.provision_workspace_schema(p_workspace_id uuid)
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
          EXECUTE format('CREATE SCHEMA %I AUTHORIZATION rab_secure_owner', v_name);
        END IF;

        SELECT pg_catalog.pg_get_userbyid(n.nspowner) INTO v_owner
          FROM pg_catalog.pg_namespace n
         WHERE n.nspname = v_name;
        IF v_owner IS DISTINCT FROM 'rab_secure_owner' THEN
          RAISE EXCEPTION 'existing schema is not owned by rab_secure_owner' USING ERRCODE = '42501';
        END IF;

        -- crewflow: this provisioning connection's own role. It creates the 15 business tables
        -- within this schema itself (provisionWorkspaceSchema's own raw-SQL template step, run on
        -- crewflow's own connection), so it needs CREATE here, not just USAGE.
        EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO crewflow', v_name);

        -- crewflow_app: the restricted ordinary runtime role (P2/P3 Checkpoint 2). USAGE only,
        -- never CREATE — it must stay structurally incapable of DDL even inside a workspace schema
        -- it has full business-table DML on.
        EXECUTE format('GRANT USAGE ON SCHEMA %I TO crewflow_app', v_name);

        RETURN v_name;
      END;
      $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await assertBootstrapPrivilege(queryRunner);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.provision_workspace_schema(p_workspace_id uuid)
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
          EXECUTE format('CREATE SCHEMA %I AUTHORIZATION rab_secure_owner', v_name);
        END IF;

        SELECT pg_catalog.pg_get_userbyid(n.nspowner) INTO v_owner
          FROM pg_catalog.pg_namespace n
         WHERE n.nspname = v_name;
        IF v_owner IS DISTINCT FROM 'rab_secure_owner' THEN
          RAISE EXCEPTION 'existing schema is not owned by rab_secure_owner' USING ERRCODE = '42501';
        END IF;

        EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO crewflow', v_name);

        RETURN v_name;
      END;
      $$;
    `);
  }
}

/**
 * Fails closed: refuses to run under `crewflow` (or any other non-bootstrap role) rather than error
 * midway with a confusing partial-privilege message. Checks for superuser OR CREATEROLE, matching
 * `CrewflowSingleCredentialRoleArchitecture1786682000000`'s own guard (same requirement: redefining a
 * `rab_secure_owner`-owned function needs the connecting role to be able to act as/alter its owner).
 */
async function assertBootstrapPrivilege(queryRunner: QueryRunner): Promise<void> {
  const rows = (await queryRunner.query(
    `SELECT rolname, rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user`,
  )) as Array<{ rolsuper: boolean; rolcreaterole: boolean; rolname: string }>;
  const [row] = rows;
  if (!row || !(row.rolsuper || row.rolcreaterole)) {
    throw new Error(
      `WorkspaceSchemaCrewflowAppUsageGrant1786688000000 refuses to run as '${row?.rolname ?? 'unknown'}': ` +
        `this migration redefines a function owned by rab_secure_owner, which requires the connecting ` +
        `role to be a superuser or have CREATEROLE. Re-run with DATABASE_URL_UNPOOLED pointed at the ` +
        `privileged bootstrap connection — never the ordinary crewflow runtime credential.`,
    );
  }
}
