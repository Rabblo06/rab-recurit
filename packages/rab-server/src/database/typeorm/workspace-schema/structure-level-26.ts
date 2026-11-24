// sql-injection-reviewed-file: SQL definition module (database layer). Every interpolation is a code constant of this repository (the frozen template, the sentinel schema name, trigger names); no request or row data reaches these templates.
import { composeServerPathTemplateLevel25 } from './structure-level-25';
import { SERVER_PATH_SENTINEL_SCHEMA } from './v1/server-path-template';
import {
  ATTENDANCE_CORRECTION_INSERT_ONLY_TRIGGERS,
  workspaceCorrectionInsertOnlySql,
} from '../../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-correction-insert-only';

/**
 * DRAFT — NEW SQL, owner SQL review FIRST (security finding S11 + owner decision 46, the workspace-schema copies). FROZEN with
 * migration WorkspaceAttendanceCorrectionInsertOnly1786722130000 once approved. Structure level 26:
 *  - `core.provision_workspace(uuid)`: the guarded v3 body over template(20) + levels 21-25 (structure-level-25.ts) with the
 *    level-26 statements appended (REVOKE UPDATE, DELETE from crewflow_app; the three guard triggers; the RESTRICT key),
 *    recording module_version 26 and checking the declared level-26 v2 fingerprint.
 *  - `core.verify_workspace_schema_v1(uuid)`: UNCHANGED (it counts tables, foreign keys, policies, indexes, FORCE and owners;
 *    the key is dropped and re-added, so the foreign-key count is unchanged).
 */
export function composeServerPathTemplateLevel26(): string {
  return [composeServerPathTemplateLevel25(), workspaceCorrectionInsertOnlySql(SERVER_PATH_SENTINEL_SCHEMA)].join(';\n');
}

const NAMES = ATTENDANCE_CORRECTION_INSERT_ONLY_TRIGGERS.map((g) => `'${g.name}'`).join(', ');

/** down() guard (same rule as levels 21-25): workspace schemas whose attendance_correction carries any level-26 trigger. */
export const LEVEL_26_WORKSPACES_SQL = `SELECT pg_catalog.count(DISTINCT n.oid)::int AS n
  FROM pg_catalog.pg_trigger t
  JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname ~ '^workspace_[0-9a-f]{32}$' AND c.relname = 'attendance_correction' AND NOT t.tgisinternal AND t.tgname IN (${NAMES})`;
