// sql-injection-reviewed-file: SQL definition module (database layer). Every interpolation is a code constant of this repository (the frozen template, the sentinel schema name, table / policy / trigger names and structure counts); no request or row data reaches these templates.
import { VERIFY_WORKSPACE_SCHEMA_V1_LEVEL_22_SQL } from './structure-level-22';
import { composeServerPathTemplateLevel26 } from './structure-level-26';
import { SERVER_PATH_SENTINEL_SCHEMA } from './v1/server-path-template';
import { workspaceAttendanceBreaksReceiptsSql } from '../../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-breaks-receipts';

/**
 * DRAFT — NEW SQL, owner SQL review FIRST (M4 design §13 PR 2, Appendix A + A.7; "[after 0.7.0 cutover]", owner decision 44).
 * FROZEN with migration WorkspaceAttendanceBreaksReceipts1786722150000 once approved. Structure level 27, the first structure
 * level that ADDS workspace tables (attendance_break, attendance_sync_receipt; WORKSPACE_TABLES 21 -> 23):
 *  - `core.provision_workspace(uuid)`: the guarded v3 body over template(20) + levels 21-26 (structure-level-26.ts) with the
 *    level-27 statements appended, recording module_version 27 and checking the declared level-27 v2 fingerprint. The body's
 *    `_workspace_bound` loop still runs over the frozen 21 template tables; the level-27 statements add the bound CHECK of the
 *    two new tables themselves (derived from the schema name).
 *  - `core.verify_workspace_schema_v1(uuid)`: the level-22 body (structure-level-22.ts) with the level-27 counts:
 *      tables / FORCE / owner / bound CHECKs 23 (was 21), indexes 112 (was 100: +5 attendance_break, +6 receipt,
 *      +1 attendance_offline_idx), policies 47 (was 42: +3 break, +2 receipt), foreign keys 62 (was 56: +2 break, +4 receipt;
 *      no key to core in a workspace schema since level 22).
 *    A level-27 schema is recognised by its recorded module_version >= 27, or, with no visible registry version (the
 *    provisioning transaction before READY), by having 23 tables: it must then match every level-27 count exactly (never a mix
 *    of level-26 and level-27 counts). Below 27 every check is byte-for-byte the level-22 rule.
 */
export function composeServerPathTemplateLevel27(): string {
  return [composeServerPathTemplateLevel26(), workspaceAttendanceBreaksReceiptsSql(SERVER_PATH_SENTINEL_SCHEMA)].join(';\n');
}

/** The level-27 structure counts (see above). Exported for the TypeScript checks and the specs. */
export const LEVEL_27_COUNTS = Object.freeze({ tables: 23, indexes: 112, policies: 47, foreignKeys: 62 });

export const VERIFY_WORKSPACE_SCHEMA_V1_LEVEL_27_SQL = `
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
      v_pol    integer;
      v_l27    boolean;
      v_tables integer;
    BEGIN
      -- Same checks, same labels, as provision-workspace-schema.ts verifyStructure(), plus table ownership.
      SELECT count(*)::int,
             count(*) FILTER (WHERE c.relrowsecurity AND c.relforcerowsecurity)::int,
             count(*) FILTER (WHERE pg_catalog.pg_get_userbyid(c.relowner) = 'crewflow')::int
        INTO v_n, v_forced, v_owned
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
       WHERE ns.nspname = v_name AND c.relkind = 'r';
      SELECT r.module_version INTO v_mv FROM core.workspace_schema_registry r WHERE r.workspace_id = p_workspace_id;
      -- Structure level 27 (WorkspaceAttendanceBreaksReceipts1786722150000) adds two tables. A level-27 schema: recorded
      -- version >= 27, or no visible version (0 / no tenant context: the provisioning transaction before READY) and 23 tables.
      v_l27 := coalesce(v_mv, 0) >= 27 OR (coalesce(v_mv, 0) = 0 AND v_n = ${LEVEL_27_COUNTS.tables});
      v_tables := CASE WHEN v_l27 THEN ${LEVEL_27_COUNTS.tables} ELSE 21 END;
      IF v_n <> v_tables THEN RETURN 'table count'; END IF;
      IF v_forced <> v_tables THEN RETURN 'FORCE RLS'; END IF;
      IF v_owned <> v_tables THEN RETURN 'table owner'; END IF;
      -- Index count (90 for v1..15, 94 at v16, 100 at v17..26, 112 at 27+) and policy count (39 for v1..17, 41 at v18..20, 42 at
      -- 21..26, 47 at 27+) depend on the workspace's recorded module version. With no visible registry version a level-27
      -- schema must match the level-27 counts exactly and any other schema any known pre-27 count; the exact structure is then
      -- proven by the per-version fingerprint, which every caller also checks.
      v_idx := (SELECT count(*)::int FROM pg_catalog.pg_indexes WHERE schemaname = v_name);
      v_pol := (SELECT count(*)::int FROM pg_catalog.pg_policies WHERE schemaname = v_name);
      IF v_l27 THEN
        IF v_idx <> ${LEVEL_27_COUNTS.indexes} THEN RETURN 'index count'; END IF;
        IF v_pol <> ${LEVEL_27_COUNTS.policies} THEN RETURN 'policy count'; END IF;
      ELSIF coalesce(v_mv, 0) = 0 THEN
        IF v_idx NOT IN (90, 94, 100) THEN RETURN 'index count'; END IF;
        IF v_pol NOT IN (39, 41, 42) THEN RETURN 'policy count'; END IF;
      ELSE
        IF v_idx <> (CASE WHEN v_mv >= 17 THEN 100 WHEN v_mv = 16 THEN 94 ELSE 90 END) THEN RETURN 'index count'; END IF;
        IF v_pol <> (CASE WHEN v_mv >= 21 THEN 42 WHEN v_mv >= 18 THEN 41 ELSE 39 END) THEN RETURN 'policy count'; END IF;
      END IF;
      IF (SELECT count(*) FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_namespace ns ON ns.oid = k.connamespace
           WHERE ns.nspname = v_name AND k.contype = 'f') <> ALL (CASE WHEN v_l27 THEN ARRAY[${LEVEL_27_COUNTS.foreignKeys}] WHEN coalesce(v_mv, 0) = 0 THEN ARRAY[128, 56] WHEN v_mv >= 22 THEN ARRAY[56] ELSE ARRAY[128] END) THEN RETURN 'foreign key count'; END IF;
      IF (SELECT count(*) FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_namespace ns ON ns.oid = k.connamespace
           WHERE ns.nspname = v_name AND k.contype = 'c' AND k.conname LIKE '%_workspace_bound') <> v_tables THEN
        RETURN 'workspace CHECK count';
      END IF;
      -- Wave 2 lane S2: the schema's own binding CHECKs are selected FIRST (MATERIALIZED), so pg_get_constraintdef — which
      -- takes AccessShareLock on the constrained table — never touches another workspace's tables. Before this, a lock
      -- held on ANY workspace's table blocked the verification (and therefore provisioning/migration) of every other one.
      IF EXISTS (WITH bound AS MATERIALIZED (
                   SELECT k.oid FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_namespace ns ON ns.oid = k.connamespace
                    WHERE ns.nspname = v_name AND k.contype = 'c' AND k.conname LIKE '%_workspace_bound')
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

/** down(): the level-22 verify body back (unchanged since level 22). */
export const VERIFY_WORKSPACE_SCHEMA_V1_BEFORE_LEVEL_27_SQL = VERIFY_WORKSPACE_SCHEMA_V1_LEVEL_22_SQL;

/** down() guard (same rule as levels 21-26): workspace schemas that already have attendance_break or attendance_sync_receipt. */
export const LEVEL_27_WORKSPACES_SQL = `SELECT pg_catalog.count(DISTINCT n.oid)::int AS n
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname ~ '^workspace_[0-9a-f]{32}$' AND c.relkind = 'r' AND c.relname IN ('attendance_break', 'attendance_sync_receipt')`;
