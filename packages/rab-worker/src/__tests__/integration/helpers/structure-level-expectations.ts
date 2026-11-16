import { codeWorkspaceStructureLevel } from '@rab/server/engine/core-modules/upgrade/workspace-structure-level';
import { WORKSPACE_CORE_FOREIGN_KEYS } from '@rab/server/engine/core-modules/upgrade/upgrade-commands/0-6/workspace-core-fk-removal';
import { V1_EXPECTED } from '@rab/server/database/typeorm/workspace-schema/provision-workspace-schema';
import { expectedWorkspacePolicyCount } from '@rab/server/database/typeorm/workspace-schema/v1/server-path-template-venue-team-admin';
import { LATEST_WORKSPACE_MODULE_VERSION } from '@rab/server/database/typeorm/workspace-schema/workspace-schema-modules';

/**
 * OWNER-DB-ULTIMATE Part D: a new workspace is provisioned at the code's STRUCTURE LEVEL (the 20 frozen workspace modules plus
 * every structural workspace upgrade command of the registry), and the registry records that level, not
 * LATEST_WORKSPACE_MODULE_VERSION. The server-side specs compare against the same codeWorkspaceStructureLevel().
 */
export const CODE_STRUCTURE_LEVEL = codeWorkspaceStructureLevel();

/** Policies added by each structural level above 20 (level 21 StaffProfileMemberSelect: staff_profile_member_select). */
const POLICIES_ADDED_BY_LEVEL: Readonly<Record<number, number>> = { 21: 1 };

/** The workspace policy count at the code's structure level (41 at module 20, 42 from level 21). */
export function expectedPolicyCountAtCodeLevel(): number {
  let n = expectedWorkspacePolicyCount(LATEST_WORKSPACE_MODULE_VERSION);
  for (let level = LATEST_WORKSPACE_MODULE_VERSION + 1; level <= CODE_STRUCTURE_LEVEL; level++) n += POLICIES_ADDED_BY_LEVEL[level] ?? 0;
  return n;
}

/**
 * The workspace foreign key count at the code's structure level: V1_EXPECTED (128) through level 21; level 22
 * (DropWorkspaceCoreForeignKeys, Part D 0a) drops the 72 workspace → core foreign keys, leaving the 56 inside the schema.
 */
export function expectedForeignKeyCountAtCodeLevel(): number {
  if (CODE_STRUCTURE_LEVEL < 22) return V1_EXPECTED.foreignKeys;
  return V1_EXPECTED.foreignKeys - Object.values(WORKSPACE_CORE_FOREIGN_KEYS).reduce((n, list) => n + list.length, 0);
}
