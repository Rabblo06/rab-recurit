import { SERVER_PATH_SENTINEL_SCHEMA as SENTINEL_SCHEMA, SERVER_PATH_TABLES_V1 as TABLES } from './server-path-template';

/**
 * Frozen with migration PayrollEvidenceRestrict1786719700000. Never edited after merge.
 *
 * The body of `core.provision_workspace(uuid)` exactly as ServerPathWorkspaceProvisioning1786719500000 created it
 * (that migration keeps it in a non-exported local function, and a migration file must never be edited or have extra
 * exports), parameterised ONLY by the frozen template text it embeds and by the CREATE verb. Every check, lock, error
 * code, safe-error label and the trusted-state rules are byte-identical; `provision-workspace-function.spec.ts` proves it
 * by capturing the SQL the 1786719500000 migration itself emits and comparing it with
 * `provisionWorkspaceFunctionSql(composeServerPathTemplateV1(), 'CREATE')`.
 *
 * A later migration that changes the workspace template re-creates the function with `CREATE OR REPLACE` and the new
 * frozen composition. CREATE OR REPLACE keeps the function's OID, owner (`crewflow`), SECURITY DEFINER flag, pinned
 * search_path and its ACL (PUBLIC revoked, EXECUTE to `crewflow_app` only), so no privilege changes.
 */
const sqlArray = (items: readonly string[]) => `ARRAY[${items.map((t) => `'${t}'`).join(', ')}]::text[]`;

export type ProvisionFunctionCreateVerb = 'CREATE' | 'CREATE OR REPLACE';

export function provisionWorkspaceFunctionSql(template: string, verb: ProvisionFunctionCreateVerb): string {
  for (const tag of ['$template$', '$provision$', '$verify$']) {
    if (template.includes(tag)) throw new Error(`workspace template contains the reserved dollar-quote tag ${tag}`);
  }
  return `
    ${verb} FUNCTION core.provision_workspace(p_workspace_id uuid)
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
