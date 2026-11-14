// TEMPORARY: renders the exact SQL of release 0b for the owner review appendix.
import { STAFF_PROFILE_MEMBER_SELECT, staffProfileMemberSelectSql } from '../engine/core-modules/upgrade/upgrade-commands/0-6/staff-profile-member-select';
import { composeServerPathTemplateLevel21, provisionWorkspaceFunctionLevelSql, VERIFY_WORKSPACE_SCHEMA_V1_LEVEL_21_SQL, WORKSPACE_FINGERPRINT_V2_FUNCTIONS_SQL } from '../database/typeorm/workspace-schema/structure-level-21';
import { moduleChecksum, modulesThrough } from '../database/typeorm/workspace-schema/workspace-schema-modules';
const which = process.argv[2];
const mods = modulesThrough(20).map((m) => ({ id: m.id, version: m.version, checksum: moduleChecksum(m) }));
if (which === 'command') process.stdout.write(staffProfileMemberSelectSql('workspace_<32hex>') + ';\n');
if (which === 'v2') process.stdout.write(WORKSPACE_FINGERPRINT_V2_FUNCTIONS_SQL);
if (which === 'verify') process.stdout.write(VERIFY_WORKSPACE_SCHEMA_V1_LEVEL_21_SQL);
if (which === 'provision') process.stdout.write(provisionWorkspaceFunctionLevelSql(composeServerPathTemplateLevel21(), mods, 21, STAFF_PROFILE_MEMBER_SELECT.structure!.fingerprints[16]!, STAFF_PROFILE_MEMBER_SELECT.structure!.provisionFunctionLiteral!) + '\n');
