import { MigrationInterface, QueryRunner } from 'typeorm';

import {
  composeServerPathTemplateV1,
  SERVER_PATH_EXPECTED_V1 as EXPECTED,
  SERVER_PATH_SENTINEL_SCHEMA as SENTINEL_SCHEMA,
  SERVER_PATH_TABLES_V1 as TABLES,
} from '../../workspace-schema/v1/server-path-template';

/**
 * APPROVED for the development database by the owner (2026-10-22; gate G1, development migration only — production is
 * NOT approved). Moved here from core/proposed-migrations/ for the rab-devdb cutover; tested first on throwaway databases
 * and on restored copies of rab-devdb (CREWFLOW_TWENTY_ARCHITECTURE_PARITY_REPORT.md §14-§15).
 *
 * Server-path workspace provisioning (Twenty-style topology, 2026-10-22). OWNER-VETOABLE — see the SECURITY TRADE-OFF in
 * THREAT-MODEL.md ("Server-path workspace provisioning") and CREWFLOW_SERVER_PATH_PROVISIONING_REPORT.md.
 *
 * WHAT CHANGES: the restricted runtime role `crewflow_app` gains EXECUTE on exactly ONE new SECURITY DEFINER function,
 * `core.provision_workspace(uuid)`. Nothing else is granted to it. It still owns nothing, has no CREATE on the database,
 * on `core` or on any workspace schema, is not a member of `crewflow`/`rab_secure_owner`, and still cannot EXECUTE
 * `core.provision_workspace_schema` or the four lifecycle mutators (`PROVISIONER_ONLY_FUNCTIONS`,
 * ReconcileCoreOwnershipAndRuntimeGrants1786717700000). The verification block at the end of up() refuses to record this
 * migration unless all of that is still true.
 *
 * WHY THE PREVIOUS RULE EXISTED (quoted in the report): "`crewflow_app` is deliberately never granted EXECUTE on
 * `provision_workspace_schema` — only the worker's dedicated, non-pooled provisioning connection (authenticated as
 * `crewflow`) may run it" (assert-runtime-db-role.ts). The provisioning DDL ran as `crewflow` because creating the
 * workspace business tables needs schema CREATE and table ownership, which the runtime role must never hold
 * (CrewflowAppRestrictedRuntimeRole1786687000000); and the lifecycle mutators were revoked from the runtime role because
 * they let a caller attest READY/FAILED for an arbitrary workspace id with no structural verification
 * (WorkspaceLifecycleGrantTightening1786677800000, plan §8A.9 Check A). This function keeps both properties:
 *   - The DDL authority stays with `crewflow` (the function's OWNER). The caller gets the RESULT of a fixed template,
 *     never the authority: no schema name, table name, SQL fragment, role or owner is accepted — only a uuid.
 *   - READY is written only after the function's own structural verification, in the SAME transaction as the DDL.
 *   - The workspace must be the CALLER's own: the row is read as `crewflow` under `manager_workspace`'s RLS (visible only
 *     when `owner_user_id = current_uid()` or `id = current_workspace()`), then the bound organisation and user GUCs
 *     (set by TenantContextService from the verified session, never from the client) must match its organisation and owner.
 *     A foreign or unknown id reads as not found (P0002 -> 404).
 *
 * OWNER = `crewflow` (not `rab_secure_owner`), deliberately: tables created inside a SECURITY DEFINER function are owned by
 * the function's owner, and every existing workspace's business tables are owned by `crewflow` (the canonical template;
 * later migrations ALTER them as that owner). A `rab_secure_owner`-owned function would either create rab_secure_owner-owned
 * business tables (a different ownership model per workspace, and the NOLOGIN pre-auth owner's remit widened to 21 business
 * tables per workspace) or need `GRANT crewflow TO rab_secure_owner` (a new role-membership edge) to hand them back. Same
 * precedent as `worker_cleanup_oauth_transaction_state` (a `crewflow`-owned DEFINER). FORCE RLS binds the owner, so
 * ownership never bypasses a workspace table's policies.
 *
 * ATOMICITY: the caller's transaction contains (1) the lifecycle start (core.begin_workspace_schema_attempt /
 * core.register_workspace_schema / core.provision_workspace_schema — unchanged functions, called as `crewflow`, exactly as
 * the worker provisioner called them) and (2) a sub-transaction that applies the template, binds every table to this
 * workspace with a CHECK, verifies the structure and marks READY. A failure inside (2) rolls (2) back completely (zero
 * objects), records FAILED with a SAFE error (fixed label or SQLSTATE, never the driver message) and returns 'FAILED'. A
 * failure outside (2), a cancelled statement, a lost connection or a crash rolls back EVERYTHING the call did, leaving the
 * previous committed state (CREATING or FAILED), which is retryable.
 *
 * CONCURRENCY: a transaction-scoped advisory lock per workspace serialises every caller (any number of API replicas); the
 * lifecycle functions' row locks and the registry row lock also serialise against the legacy worker provisioner, which
 * remains a rollback artifact. A second caller waits, then sees READY and returns 'ALREADY_READY' after a read-only
 * verification. Correctness never depends on Redis.
 *
 * TEMPLATE: frozen (workspace-schema/v1/server-path-template.ts), composed from the same frozen SQL modules, in the same order, that
 * provision-workspace-schema.ts applies (that TypeScript provisioner stays as the rollback path). Any later migration that
 * changes the workspace template must CREATE OR REPLACE this function with the new composition and expected counts —
 * `workspace-schema/v1/server-path-template.spec.ts` fails if V1_EXPECTED or WORKSPACE_TABLES drift from the frozen copies.
 *
 * Runs as any identity that can act as `crewflow` (the migration identity, or the bootstrap superuser). down() drops both
 * functions, which removes the only new grant; schemas already provisioned are kept (they may hold data), exactly like
 * WorkspaceSchemaProvisioning1786674600000's own down().
 */

const sqlArray = (items: readonly string[]) => `ARRAY[${items.map((t) => `'${t}'`).join(', ')}]::text[]`;

function verifyFunctionSql(): string {
  return `
    CREATE FUNCTION core.verify_workspace_schema_v1(p_workspace_id uuid)
    RETURNS text
    LANGUAGE plpgsql
    STABLE
    SET search_path = pg_catalog, pg_temp
    AS $verify$
    DECLARE
      v_name   text := 'workspace_' || replace(p_workspace_id::text, '-', '');
      v_n      integer;
      v_forced integer;
      v_owned  integer;
    BEGIN
      -- Same checks, same labels, as provision-workspace-schema.ts verifyStructure(), plus table ownership.
      SELECT count(*)::int,
             count(*) FILTER (WHERE c.relrowsecurity AND c.relforcerowsecurity)::int,
             count(*) FILTER (WHERE pg_catalog.pg_get_userbyid(c.relowner) = 'crewflow')::int
        INTO v_n, v_forced, v_owned
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
       WHERE ns.nspname = v_name AND c.relkind = 'r';
      IF v_n <> ${EXPECTED.tables} THEN RETURN 'table count'; END IF;
      IF v_forced <> ${EXPECTED.tables} THEN RETURN 'FORCE RLS'; END IF;
      IF v_owned <> ${EXPECTED.tables} THEN RETURN 'table owner'; END IF;
      IF (SELECT count(*) FROM pg_catalog.pg_indexes WHERE schemaname = v_name) <> ${EXPECTED.indexes} THEN RETURN 'index count'; END IF;
      IF (SELECT count(*) FROM pg_catalog.pg_policies WHERE schemaname = v_name) <> ${EXPECTED.policies} THEN RETURN 'policy count'; END IF;
      IF (SELECT count(*) FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_namespace ns ON ns.oid = k.connamespace
           WHERE ns.nspname = v_name AND k.contype = 'f') <> ${EXPECTED.foreignKeys} THEN RETURN 'foreign key count'; END IF;
      IF (SELECT count(*) FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_namespace ns ON ns.oid = k.connamespace
           WHERE ns.nspname = v_name AND k.contype = 'c' AND k.conname LIKE '%\\_workspace\\_bound') <> ${TABLES.length} THEN
        RETURN 'workspace CHECK count';
      END IF;
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_namespace ns ON ns.oid = k.connamespace
                  WHERE ns.nspname = v_name AND k.contype = 'c' AND k.conname LIKE '%\\_workspace\\_bound'
                    AND (strpos(pg_catalog.pg_get_constraintdef(k.oid), '''' || p_workspace_id::text || '''::uuid') = 0
                         OR strpos(pg_catalog.pg_get_constraintdef(k.oid), 'workspace_id IS NOT NULL') = 0)) THEN
        RETURN 'workspace CHECK value or NULL exclusion';
      END IF;
      IF (SELECT pg_catalog.pg_get_userbyid(nspowner) FROM pg_catalog.pg_namespace WHERE nspname = v_name) IS DISTINCT FROM 'rab_secure_owner' THEN
        RETURN 'schema owner';
      END IF;
      IF (SELECT a.attnotnull FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
            JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
           WHERE ns.nspname = v_name AND c.relname = 'user_note' AND a.attname = 'workspace_id') IS DISTINCT FROM true THEN
        RETURN 'user_note workspace_id NOT NULL';
      END IF;
      RETURN NULL;
    END;
    $verify$;
  `;
}

function provisionFunctionSql(template: string): string {
  return `
    CREATE FUNCTION core.provision_workspace(p_workspace_id uuid)
    RETURNS text
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    SET lock_timeout = '30s'
    AS $provision$
    DECLARE
      v_bound_org text := current_setting('rab.organisation_id', true);
      v_bound_uid text := current_setting('rab.user_id', true);
      v_name      text;
      v_org       uuid;
      v_owner     uuid;
      v_status    text;
      v_ws_status text;
      v_reg       text;
      v_created   text;
      v_problem   text;
      v_error     text;
      v_table     text;
    BEGIN
      IF p_workspace_id IS NULL THEN
        RAISE EXCEPTION 'workspace id is required' USING ERRCODE = '22004';
      END IF;
      IF p_workspace_id = '00000000-0000-0000-0000-000000000000'::uuid THEN
        RAISE EXCEPTION 'workspace not found' USING ERRCODE = 'P0002';
      END IF;
      -- Caller identity: bound by the server from the verified session (TenantContextService), never by the client.
      IF coalesce(v_bound_org, '') = '' OR coalesce(v_bound_uid, '') = '' THEN
        RAISE EXCEPTION 'workspace not found' USING ERRCODE = 'P0002';
      END IF;

      -- Derived, never supplied: uuid::text is canonical lowercase, so the name cannot carry arbitrary characters.
      v_name := 'workspace_' || replace(p_workspace_id::text, '-', '');
      IF v_name !~ '^workspace_[0-9a-f]{32}$' THEN
        RAISE EXCEPTION 'derived schema name failed canonical check' USING ERRCODE = '22023';
      END IF;

      -- One provisioning attempt per workspace at a time, across every API replica. Transaction-scoped: released on
      -- commit, rollback, or a dropped connection, so a crashed caller can never leave it held.
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('rab_workspace_provisioning'), pg_catalog.hashtext(p_workspace_id::text));

      -- Read AS crewflow, under manager_workspace's RLS: visible only when it is the caller's own workspace.
      SELECT w.organisation_id, w.owner_user_id, w.schema_status, w.status
        INTO v_org, v_owner, v_status, v_ws_status
        FROM core.manager_workspace w
       WHERE w.id = p_workspace_id;
      IF NOT FOUND OR v_org::text IS DISTINCT FROM v_bound_org OR v_owner::text IS DISTINCT FROM v_bound_uid THEN
        RAISE EXCEPTION 'workspace not found' USING ERRCODE = 'P0002';
      END IF;
      IF v_ws_status IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'workspace is not active' USING ERRCODE = '55000';
      END IF;

      IF v_status = 'READY' THEN
        v_problem := core.verify_workspace_schema_v1(p_workspace_id);
        IF v_problem IS NOT NULL THEN
          -- Never re-provision or re-mark a READY workspace; report it, change nothing.
          RAISE EXCEPTION 'READY workspace schema failed verification: %', v_problem USING ERRCODE = 'CWV02';
        END IF;
        RETURN 'ALREADY_READY';
      END IF;
      IF v_status IS NULL OR v_status NOT IN ('CREATING', 'FAILED') THEN
        RAISE EXCEPTION 'workspace schema is %, it cannot be provisioned', coalesce(v_status, 'NULL') USING ERRCODE = '55000';
      END IF;

      -- Lifecycle start: unchanged functions, called as crewflow exactly as the worker provisioner called them.
      PERFORM core.begin_workspace_schema_attempt(p_workspace_id);
      PERFORM core.register_workspace_schema(p_workspace_id);
      v_created := core.provision_workspace_schema(p_workspace_id);
      IF v_created IS DISTINCT FROM v_name THEN
        RAISE EXCEPTION 'derived schema name mismatch' USING ERRCODE = '22023';
      END IF;

      -- FORCE RLS binds crewflow on the registry: the bound organisation is the workspace's own (checked above).
      SELECT r.status INTO v_reg FROM core.workspace_schema_registry r WHERE r.workspace_id = p_workspace_id FOR UPDATE;
      IF NOT FOUND OR v_reg NOT IN ('PROVISIONING', 'FAILED') THEN
        RAISE EXCEPTION 'registry status is not provisionable' USING ERRCODE = '55000';
      END IF;

      BEGIN
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = v_name) THEN
          RAISE EXCEPTION 'schema is not empty; refusing to apply' USING ERRCODE = 'CWV03';
        END IF;

        -- The fixed, migration-frozen V1 template. The only substitution is the derived, regex-checked schema name.
        EXECUTE replace($template$${template}$template$, '${SENTINEL_SCHEMA}', v_name);

        FOREACH v_table IN ARRAY ${sqlArray(TABLES)} LOOP
          EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK (workspace_id IS NOT NULL AND workspace_id = %L::uuid)',
                         v_name, v_table, v_table || '_workspace_bound', p_workspace_id::text);
        END LOOP;

        v_problem := core.verify_workspace_schema_v1(p_workspace_id);
        IF v_problem IS NOT NULL THEN
          RAISE EXCEPTION '%', v_problem USING ERRCODE = 'CWV01';
        END IF;

        PERFORM core.mark_workspace_schema_ready(p_workspace_id, 1);
        RETURN 'READY';
      EXCEPTION WHEN OTHERS THEN
        -- Everything in this block is already rolled back (zero objects). Record a SAFE error only.
        v_error := CASE SQLSTATE
          WHEN 'CWV01' THEN 'verification failed: ' || SQLERRM
          WHEN 'CWV03' THEN 'schema is not empty; refusing to apply'
          ELSE 'V1 provisioning failed at apply (SQLSTATE ' || SQLSTATE || ')'
        END;
        PERFORM core.mark_workspace_schema_failed(p_workspace_id, v_error);
        RETURN 'FAILED';
      END;
    END;
    $provision$;
  `;
}

export class ServerPathWorkspaceProvisioning1786719500000 implements MigrationInterface {
  name = 'ServerPathWorkspaceProvisioning1786719500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $authority$
      BEGIN
        IF NOT pg_has_role(current_user, 'crewflow', 'USAGE') THEN
          RAISE EXCEPTION 'ServerPathWorkspaceProvisioning1786719500000 must run as crewflow or the bootstrap identity (it creates crewflow-owned functions); refusing as %', current_user
            USING ERRCODE = 'insufficient_privilege';
        END IF;
      END
      $authority$;
    `);

    const template = composeServerPathTemplateV1();
    for (const tag of ['$template$', '$provision$', '$verify$']) {
      if (template.includes(tag)) throw new Error(`workspace template contains the reserved dollar-quote tag ${tag}`);
    }

    await queryRunner.query(verifyFunctionSql());
    await queryRunner.query(`ALTER FUNCTION core.verify_workspace_schema_v1(uuid) OWNER TO crewflow;`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.verify_workspace_schema_v1(uuid) FROM PUBLIC;`);

    await queryRunner.query(provisionFunctionSql(template));
    await queryRunner.query(`ALTER FUNCTION core.provision_workspace(uuid) OWNER TO crewflow;`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.provision_workspace(uuid) FROM PUBLIC;`);
    // The ONE new runtime privilege.
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.provision_workspace(uuid) TO crewflow_app;`);

    // Refuse to be recorded unless the runtime role gained nothing else.
    await queryRunner.query(`
      DO $verify$
      DECLARE v text;
      BEGIN
        SELECT string_agg(x, '; ') INTO v FROM (
          SELECT 'provision_workspace is not a crewflow-owned SECURITY DEFINER with search_path pg_catalog, pg_temp' AS x
            FROM pg_proc p
           WHERE p.oid = 'core.provision_workspace(uuid)'::regprocedure
             AND NOT (p.prosecdef AND pg_get_userbyid(p.proowner) = 'crewflow'
                      AND 'search_path=pg_catalog, pg_temp' = ANY (coalesce(p.proconfig, ARRAY[]::text[])))
          UNION ALL
          SELECT format('PUBLIC may EXECUTE %s', f)
            FROM unnest(ARRAY['core.provision_workspace(uuid)', 'core.verify_workspace_schema_v1(uuid)']) f
           WHERE EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                          WHERE p.oid = f::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
          UNION ALL
          SELECT 'crewflow_app cannot EXECUTE core.provision_workspace' WHERE NOT has_function_privilege('crewflow_app', 'core.provision_workspace(uuid)', 'EXECUTE')
          UNION ALL
          SELECT 'crewflow_app may EXECUTE core.verify_workspace_schema_v1' WHERE has_function_privilege('crewflow_app', 'core.verify_workspace_schema_v1(uuid)', 'EXECUTE')
          UNION ALL
          SELECT format('crewflow_app may EXECUTE provisioner-only core.%s', f)
            FROM unnest(ARRAY['provision_workspace_schema(uuid)', 'register_workspace_schema(uuid)', 'mark_workspace_schema_ready(uuid,integer)',
                              'mark_workspace_schema_failed(uuid,text)', 'begin_workspace_schema_attempt(uuid)',
                              'worker_list_pending_workspace_schemas(integer)', 'worker_resolve_workspace_organisation(uuid)']) f
           WHERE has_function_privilege('crewflow_app', 'core.' || f, 'EXECUTE')
          UNION ALL
          SELECT 'crewflow_app has CREATE on the database' WHERE has_database_privilege('crewflow_app', current_database(), 'CREATE')
          UNION ALL
          SELECT 'crewflow_app has CREATE on schema core' WHERE has_schema_privilege('crewflow_app', 'core', 'CREATE')
          UNION ALL
          SELECT format('crewflow_app has CREATE on schema %s', n.nspname)
            FROM pg_namespace n WHERE n.nspname ~ '^workspace_[0-9a-f]{32}$' AND has_schema_privilege('crewflow_app', n.oid, 'CREATE')
          UNION ALL
          SELECT format('crewflow_app can act as %s', r.rolname)
            FROM pg_roles r WHERE r.rolname IN ('crewflow', 'rab_secure_owner', 'rab_owner') AND pg_has_role('crewflow_app', r.oid, 'USAGE')
          UNION ALL
          SELECT 'crewflow_app is SUPERUSER, BYPASSRLS, CREATEROLE or CREATEDB'
            FROM pg_roles WHERE rolname = 'crewflow_app' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb)
          UNION ALL
          SELECT format('crewflow_app owns %s', c.oid::regclass) FROM pg_class c WHERE c.relowner = 'crewflow_app'::regrole
        ) problems;
        IF v IS NOT NULL THEN
          RAISE EXCEPTION 'ServerPathWorkspaceProvisioning1786719500000 verification failed: %', v USING ERRCODE = 'invalid_grant_operation';
        END IF;
      END
      $verify$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restores the previous grant state exactly: before this migration neither function existed, so crewflow_app held no
    // provisioning privilege at all. Provisioned schemas are kept (they may hold data).
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.provision_workspace(uuid);`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.verify_workspace_schema_v1(uuid);`);
  }
}
