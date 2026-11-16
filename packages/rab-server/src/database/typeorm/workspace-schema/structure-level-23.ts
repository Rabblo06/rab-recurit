// sql-injection-reviewed-file: SQL definition module (database layer). Every interpolation is a code constant of this repository (the frozen template and the sentinel schema name); no request or row data reaches these templates.
import { composeServerPathTemplateLevel22 } from './structure-level-22';
import { SERVER_PATH_SENTINEL_SCHEMA } from './v1/server-path-template';
import {
  STAFF_PROFILE_WORKSPACE_REQUIRED_CONSTRAINT,
  staffProfileWorkspaceRequiredValidateSql,
} from '../../../engine/core-modules/upgrade/upgrade-commands/0-7/staff-profile-workspace-required-validate';

/**
 * DRAFT — NEW SQL, owner SQL review FIRST (C3 Q3). FROZEN with migration WorkspaceStaffProfileWorkspaceRequiredValidated1786721570000
 * once approved. Structure level 23 (C3 owner decision Q3: VALIDATE staff_profile_workspace_required):
 *  - `core.provision_workspace(uuid)`: the guarded v3 body over template(20) + level 21 + level 22 (structure-level-22.ts) with the
 *    level-23 command's statement appended, recording module_version 23 and checking the declared level-23 v2 fingerprint. In
 *    the provisioning transaction the new staff_profile is empty, so the VALIDATE is a catalog flip (SHARE UPDATE EXCLUSIVE on
 *    the new table only; no lock on any core table).
 *  - `core.verify_workspace_schema_v1(uuid)`: UNCHANGED (it counts tables, foreign keys, policies, indexes, FORCE and owners;
 *    it never reads `convalidated`): the per-level v2 fingerprint is what proves the constraint is validated.
 */
export function composeServerPathTemplateLevel23(): string {
  return [composeServerPathTemplateLevel22(), staffProfileWorkspaceRequiredValidateSql(SERVER_PATH_SENTINEL_SCHEMA)].join(';\n');
}

/**
 * down() guard (same rule as 0b's F1 / 0a's): the workspace schemas whose staff_profile_workspace_required is already VALID
 * (catalog only). down() refuses while any remains: a level-22 provision body (expecting the NOT VALID fingerprint) next to
 * level-23 workspaces would make the fleet's structure inconsistent, and PostgreSQL cannot mark a constraint NOT VALID again
 * except by dropping and re-adding it (owner-run, per workspace).
 */
export const LEVEL_23_WORKSPACES_SQL = `SELECT pg_catalog.count(*)::int AS n
  FROM pg_catalog.pg_constraint k
  JOIN pg_catalog.pg_class c ON c.oid = k.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname ~ '^workspace_[0-9a-f]{32}$' AND c.relname = 'staff_profile' AND k.contype = 'c'
   AND k.conname = '${STAFF_PROFILE_WORKSPACE_REQUIRED_CONSTRAINT}' AND k.convalidated`;
