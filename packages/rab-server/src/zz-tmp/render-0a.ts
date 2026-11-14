import { workspaceCoreFkRemovalSql } from '../engine/core-modules/upgrade/upgrade-commands/0-6/workspace-core-fk-removal';
import { VERIFY_WORKSPACE_SCHEMA_V1_LEVEL_22_SQL } from '../database/typeorm/workspace-schema/structure-level-22';
const w = process.argv[2];
if (w === 'command') process.stdout.write(workspaceCoreFkRemovalSql('workspace_<32hex>') + ';\n');
if (w === 'verify') process.stdout.write(VERIFY_WORKSPACE_SCHEMA_V1_LEVEL_22_SQL);
