import type { WorkspaceUpgradeCommand, WorkspaceUpgradeCommandContext } from '../workspace-upgrade-command';
import { syncStandardObjects } from '../../../../metadata/standard-objects/standard-object-sync';
import { CREWFLOW_STANDARD_OBJECT_DEFINITIONS } from '../../../../../database/typeorm/workspace-schema/standard-objects/standard-object-definitions';

/**
 * Release 0.6.0, workspace DATA command (metadata engine M1 / E2, OWNER-METADATA-ENGINE.md §1 E2 and §0.3): register the
 * workspace's 21 tables as standard objects in core.object_metadata / field_metadata / field_metadata_option, with the §0.3
 * locks (the seven payroll / attendance objects isSystem, read-only, no custom fields; every built-in field locked; status
 * columns read-only, S13). Recorded per workspace in core.upgrade_migration by the runner, like every Part D command.
 *
 * Twenty (twentyhq/twenty @ eedb0a73) runs `TwentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow`
 * (`engine/workspace-manager/twenty-standard-application/services/twenty-standard-application.service.ts:42-156`) per workspace
 * from its upgrade commands and on workspace creation. Re-implemented, not copied.
 *
 * - Data only: no DDL (the runner refuses a data step that writes a catalog). It verifies the workspace's tables against the
 *   definitions first (CATALOG_MISMATCH refuses, nothing written), so the metadata never describes a table the workspace lacks.
 * - Idempotent: a re-run (a crash after COMMIT) plans nothing and writes nothing.
 * - `writesWorkspaceMetadata`: the runner allows INSERT / UPDATE of the metadata tables for this step only, and proves every
 *   write stayed in this workspace (workspace-command-runner.ts, metadata write check).
 * - New workspaces get the same sync in ManagerWorkspaceService.createFor (they start at this release's last step and never run
 *   this command).
 * The command body is the CURRENT code's definitions (as Twenty's sync): a later release that changes a definition ships its
 * own sync command; this one never needs editing.
 */
export const SYNC_STANDARD_OBJECTS_TIMESTAMP = 1786721900000;

export const SYNC_STANDARD_OBJECTS: WorkspaceUpgradeCommand = Object.freeze({
  kind: 'workspace',
  name: 'SyncStandardObjects',
  timestamp: SYNC_STANDARD_OBJECTS_TIMESTAMP,
  writesWorkspaceMetadata: true,
  run: async (ctx: WorkspaceUpgradeCommandContext) => {
    const r = await syncStandardObjects(ctx.query, CREWFLOW_STANDARD_OBJECT_DEFINITIONS, {
      workspaceId: ctx.workspaceId,
      organisationId: ctx.organisationId,
      schemaName: ctx.schemaName,
    });
    ctx.log(
      `standard objects: +${r.objectsInserted} ~${r.objectsUpdated} objects, +${r.fieldsInserted} ~${r.fieldsUpdated} fields, +${r.optionsInserted} ~${r.optionsUpdated} options`,
    );
  },
});
