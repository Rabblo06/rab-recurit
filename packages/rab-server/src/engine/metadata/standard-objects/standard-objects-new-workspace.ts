/**
 * Metadata engine M1 / E2: a NEW workspace gets its standard objects at creation, in ManagerWorkspaceService.createFor's own
 * transaction, right before its upgrade-logbook `is_initial` row (Twenty creates the workspace, then synchronises the standard
 * application: twentyhq/twenty @ eedb0a73 `engine/core-modules/workspace/services/workspace.service.ts:786-819` and
 * `twenty-standard-application.service.ts:42-156`; re-implemented, not copied). A new workspace starts at this release's last
 * step, so it never runs the SyncStandardObjects workspace command: without this it would have no metadata.
 *
 * The workspace schema does not exist yet (it is provisioned after the transaction commits), so the catalog check is skipped
 * here; the definitions are checked against the template on every CI database (standard-objects-catalog.integration.spec.ts)
 * and against each workspace's real tables at every upgrade run.
 *
 * The request transaction is bound to the caller's organisation but to no workspace (the workspace is being created), and the
 * metadata tables are FORCE RLS on (organisation_id, workspace_id). The new workspace id is bound for the sync only and the
 * previous value restored afterwards (the same pattern as markAsWorkspaceInitial). A failure aborts the whole creation.
 */
import { CREWFLOW_STANDARD_OBJECT_DEFINITIONS } from '../../../database/typeorm/workspace-schema/standard-objects/standard-object-definitions';
import { MetadataQuery, StandardSyncReport, syncStandardObjects } from './standard-object-sync';

export async function syncStandardObjectsForNewWorkspace(query: MetadataQuery, workspace: { readonly id: string; readonly organisationId: string }): Promise<StandardSyncReport> {
  const [prior] = (await query(`SELECT COALESCE(pg_catalog.current_setting('rab.workspace_id', true), '') AS v`)) as Array<{ v: string }>;
  await query(`SELECT pg_catalog.set_config('rab.workspace_id', $1, true)`, [workspace.id]);
  const report = await syncStandardObjects(query, CREWFLOW_STANDARD_OBJECT_DEFINITIONS, { workspaceId: workspace.id, organisationId: workspace.organisationId });
  // Restored only on success: on failure the caller's transaction rolls back, and the setting is transaction-local.
  await query(`SELECT pg_catalog.set_config('rab.workspace_id', $1, true)`, [prior?.v ?? '']);
  return report;
}
