import { assignmentRoleSql } from './assignment-role';
import { SERVER_PATH_SENTINEL_SCHEMA } from './server-path-template';
import { composeServerPathTemplateV1ArchiveSearch } from './server-path-template-archive-search';
import { VERIFY_WORKSPACE_SCHEMA_V1_VERSIONED_SQL } from './verify-workspace-schema-v1-versioned';

export const composeServerPathTemplateV1AssignmentRole = () => [composeServerPathTemplateV1ArchiveSearch(), assignmentRoleSql(SERVER_PATH_SENTINEL_SCHEMA)].join(';\n');
/** Same checks, one additional foreign key at module 18. Do not edit the older frozen function. */
export const VERIFY_ASSIGNMENT_ROLE_SQL = VERIFY_WORKSPACE_SCHEMA_V1_VERSIONED_SQL.replace(
  "<> 128 THEN RETURN 'foreign key count'",
  // Provisioning verifies structure before recording the module ledger. The
  // exact version is still checked by the fingerprint in the same transaction.
  "NOT IN (128 + CASE WHEN v_mv >= 18 THEN 1 ELSE 0 END, CASE WHEN coalesce(v_mv, 0) = 0 THEN 129 ELSE 128 + CASE WHEN v_mv >= 18 THEN 1 ELSE 0 END END) THEN RETURN 'foreign key count'",
);
