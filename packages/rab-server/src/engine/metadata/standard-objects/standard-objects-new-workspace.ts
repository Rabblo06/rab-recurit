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
 * Order inside the request transaction (M1 E1 security review #165, identity split):
 *   1. the caller's tenant context is already bound (organisation); the NEW workspace id is bound here, transaction-local;
 *   2. `SET LOCAL ROLE crewflow` — core.metadata_guard() accepts built-in / locked metadata writes only from crewflow,
 *      rab_secure_owner or a superuser (the request path may change display columns only). The binding comes first because
 *      TenantContextService.bindGucs asserts current_user = session_user;
 *   3. the sync (FORCE RLS still applies to crewflow, the table owner: the binding is still what scopes every row);
 *   4. the previous role and workspace binding are restored, so nothing after this call runs elevated. On failure the caller's
 *      transaction rolls back (the settings are transaction-local) and the role is restored in `finally` anyway.
 * The same pattern as WorkspaceSchemaMigrator.actAsMigrationRole. A session that is neither allowed nor able to SET ROLE
 * crewflow is refused (fail closed): creation then fails rather than leaving a workspace without metadata.
 */
import { CREWFLOW_STANDARD_OBJECT_DEFINITIONS } from '../../../database/typeorm/workspace-schema/standard-objects/standard-object-definitions';
import { StandardObjectSyncError } from './standard-object-plan';
import { MetadataQuery, StandardSyncReport, syncStandardObjects } from './standard-object-sync';

const ROLE_SQL = `SELECT pg_catalog.current_setting('role') AS role,
  (current_user IN ('crewflow'::name, 'rab_secure_owner'::name)
   OR coalesce((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false)) AS allowed,
  EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'crewflow') AND pg_catalog.pg_has_role(current_user, 'crewflow', 'SET') AS can_set`;

export async function syncStandardObjectsForNewWorkspace(query: MetadataQuery, workspace: { readonly id: string; readonly organisationId: string }): Promise<StandardSyncReport> {
  const [prior] = (await query(`SELECT COALESCE(pg_catalog.current_setting('rab.workspace_id', true), '') AS v`)) as Array<{ v: string }>;
  await query(`SELECT pg_catalog.set_config('rab.workspace_id', $1, true)`, [workspace.id]);
  const [r] = (await query(ROLE_SQL)) as Array<{ role: string; allowed: boolean; can_set: boolean }>;
  if (!r?.allowed && !r?.can_set) {
    throw new StandardObjectSyncError('NO_TENANT', 'this session can neither write built-in metadata nor SET ROLE crewflow');
  }
  const elevate = !r.allowed;
  if (elevate) await query(`SELECT pg_catalog.set_config('role', 'crewflow', true)`);
  const restore = async () => {
    // Narrow privileged section: back to the caller's role before anything else runs in this transaction.
    if (elevate) await query(`SELECT pg_catalog.set_config('role', $1, true)`, [r.role]);
    await query(`SELECT pg_catalog.set_config('rab.workspace_id', $1, true)`, [prior?.v ?? '']);
  };
  let report: StandardSyncReport;
  try {
    report = await syncStandardObjects(query, CREWFLOW_STANDARD_OBJECT_DEFINITIONS, { workspaceId: workspace.id, organisationId: workspace.organisationId });
  } catch (error) {
    // The transaction is usually aborted here and rolls back (transaction-local settings go with it); try anyway.
    await restore().catch(() => undefined);
    throw error;
  }
  // On success the restore must succeed: a failure propagates and aborts the creation (never continue elevated).
  await restore();
  const [after] = (await query(`SELECT pg_catalog.current_setting('role') AS role`)) as Array<{ role: string }>;
  if (after?.role !== r.role) throw new StandardObjectSyncError('NO_TENANT', 'the role could not be restored after the standard-object sync');
  return report;
}
