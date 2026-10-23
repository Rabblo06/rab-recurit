/**
 * FROZEN with migration ArchiveAndSearchSchema1786719920000 (never edited after merge).
 *
 * `core.verify_workspace_schema_v1(uuid)` = the Wave 2 lane S2 body (workspace-schema-ledger-sql.ts
 * VERIFY_WORKSPACE_SCHEMA_V1_ISOLATED_SQL: same checks, labels, owner, ACL, schema-isolated binding-CHECK scan) with ONE
 * change: the index count is version-aware (module 16 adds 4 indexes, module 17 adds 6). Without it, every workspace
 * would fail verification the moment it reached v16/v17 — and, the other way round, running images whose TypeScript
 * provisioner still builds v15 (90 indexes) keep passing, because their registry records module_version 15.
 * CREATE OR REPLACE keeps owner, ACL and the SECURITY INVOKER / STABLE / search_path attributes.
 */
export const VERIFY_WORKSPACE_SCHEMA_V1_VERSIONED_SQL = `
CREATE OR REPLACE FUNCTION core.verify_workspace_schema_v1(p_workspace_id uuid)
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
      v_mv     integer;
      v_idx    integer;
    BEGIN
      -- Same checks, same labels, as provision-workspace-schema.ts verifyStructure(), plus table ownership.
      SELECT count(*)::int,
             count(*) FILTER (WHERE c.relrowsecurity AND c.relforcerowsecurity)::int,
             count(*) FILTER (WHERE pg_catalog.pg_get_userbyid(c.relowner) = 'crewflow')::int
        INTO v_n, v_forced, v_owned
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
       WHERE ns.nspname = v_name AND c.relkind = 'r';
      IF v_n <> 21 THEN RETURN 'table count'; END IF;
      IF v_forced <> 21 THEN RETURN 'FORCE RLS'; END IF;
      IF v_owned <> 21 THEN RETURN 'table owner'; END IF;
      -- Waves 4+5 lane DB5: the index count depends on the workspace's recorded module version (90 for v1..15, 94 at
      -- v16, 100 at v17+). With no visible registry version (0 / no tenant context: a pre-ledger baseline, or the
      -- provisioning transaction before READY) any known count is accepted; the exact structure is then proven by the
      -- per-version fingerprint, which every caller also checks.
      SELECT r.module_version INTO v_mv FROM core.workspace_schema_registry r WHERE r.workspace_id = p_workspace_id;
      v_idx := (SELECT count(*)::int FROM pg_catalog.pg_indexes WHERE schemaname = v_name);
      IF coalesce(v_mv, 0) = 0 THEN
        IF v_idx NOT IN (90, 94, 100) THEN RETURN 'index count'; END IF;
      ELSIF v_idx <> (CASE WHEN v_mv >= 17 THEN 100 WHEN v_mv = 16 THEN 94 ELSE 90 END) THEN
        RETURN 'index count';
      END IF;
      IF (SELECT count(*) FROM pg_catalog.pg_policies WHERE schemaname = v_name) <> 39 THEN RETURN 'policy count'; END IF;
      IF (SELECT count(*) FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_namespace ns ON ns.oid = k.connamespace
           WHERE ns.nspname = v_name AND k.contype = 'f') <> 128 THEN RETURN 'foreign key count'; END IF;
      IF (SELECT count(*) FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_namespace ns ON ns.oid = k.connamespace
           WHERE ns.nspname = v_name AND k.contype = 'c' AND k.conname LIKE '%\_workspace\_bound') <> 21 THEN
        RETURN 'workspace CHECK count';
      END IF;
      -- Wave 2 lane S2: the schema's own binding CHECKs are selected FIRST (MATERIALIZED), so pg_get_constraintdef — which
      -- takes AccessShareLock on the constrained table — never touches another workspace's tables. Before this, a lock
      -- held on ANY workspace's table blocked the verification (and therefore provisioning/migration) of every other one.
      IF EXISTS (WITH bound AS MATERIALIZED (
                   SELECT k.oid FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_namespace ns ON ns.oid = k.connamespace
                    WHERE ns.nspname = v_name AND k.contype = 'c' AND k.conname LIKE '%\_workspace\_bound')
                 SELECT 1 FROM bound b
                  WHERE strpos(pg_catalog.pg_get_constraintdef(b.oid), '''' || p_workspace_id::text || '''::uuid') = 0
                     OR strpos(pg_catalog.pg_get_constraintdef(b.oid), 'workspace_id IS NOT NULL') = 0) THEN
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
