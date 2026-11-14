// sql-injection-reviewed-file: SQL definition module (database layer). Every interpolation is a code constant of this repository (the frozen template, module ids / versions / checksums, a 64-hex fingerprint, a validated app_version literal and a structure level integer); no request or row data reaches these templates.
import { SERVER_PATH_SENTINEL_SCHEMA } from './v1/server-path-template';
import { composeServerPathTemplateLevel21, VERIFY_WORKSPACE_SCHEMA_V1_LEVEL_21_SQL } from './structure-level-21';
import { workspaceCoreFkRemovalSql } from '../../../engine/core-modules/upgrade/upgrade-commands/0-6/workspace-core-fk-removal';

/**
 * DRAFT for owner SQL review (WS-COMMANDS.md "FOR OWNER REVIEW — 0a"; throwaway databases only until approved). Frozen with
 * migration WorkspaceCoreForeignKeyRemoval1786721490000 once approved. Structure level 22 (decision 0a option (b)):
 *  1. `core.verify_workspace_schema_v1(uuid)`: the level-21 body (structure-level-21.ts) with ONE change: the foreign-key count
 *     is 56 at level 22+ (128 - the 72 workspace → core."user" / organisation / manager_workspace constraints), 128 below; with no
 *     visible registry version either count is accepted (the per-level fingerprint then proves the exact structure);
 *  2. `core.provision_workspace(uuid)`: the guarded v3 body over template(20) + level 21 + level 22 (the frozen module SQL still
 *     creates the 72 constraints; the level-22 statements drop them again in the same EXECUTE, before verification).
 */

const FK_LINE_OLD = `           WHERE ns.nspname = v_name AND k.contype = 'f') <> 128 THEN RETURN 'foreign key count'; END IF;`;
const FK_LINE_NEW = `           WHERE ns.nspname = v_name AND k.contype = 'f') <> ALL (CASE WHEN coalesce(v_mv, 0) = 0 THEN ARRAY[128, 56] WHEN v_mv >= 22 THEN ARRAY[56] ELSE ARRAY[128] END) THEN RETURN 'foreign key count'; END IF;`;

export const VERIFY_WORKSPACE_SCHEMA_V1_LEVEL_22_SQL = (() => {
  if (VERIFY_WORKSPACE_SCHEMA_V1_LEVEL_21_SQL.split(FK_LINE_OLD).length !== 2) throw new Error('verify level-21 FK anchor not found exactly once');
  return VERIFY_WORKSPACE_SCHEMA_V1_LEVEL_21_SQL.replace(FK_LINE_OLD, FK_LINE_NEW);
})();

/** The composition core.provision_workspace embeds from this release on: template(20) + level 21 + level 22. */
export function composeServerPathTemplateLevel22(): string {
  return [composeServerPathTemplateLevel21(), workspaceCoreFkRemovalSql(SERVER_PATH_SENTINEL_SCHEMA)].join(';\n');
}

/**
 * down() guard (same rule as 0b's F1): the workspace schemas already at level 22 — they have the workspace tables but no foreign
 * key to core."user" left (catalog only). down() refuses while any remains: the level-21 verify body expects 128 foreign keys.
 */
export const LEVEL_22_WORKSPACES_SQL = `SELECT pg_catalog.count(*)::int AS n
  FROM pg_catalog.pg_namespace n
 WHERE n.nspname ~ '^workspace_[0-9a-f]{32}$'
   AND EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace = n.oid AND c.relname = 'staff_profile' AND c.relkind = 'r')
   AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k
                    WHERE k.connamespace = n.oid AND k.contype = 'f' AND k.confrelid = 'core."user"'::pg_catalog.regclass)`;
