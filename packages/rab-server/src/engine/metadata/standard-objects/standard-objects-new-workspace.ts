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
 *   4. the previous role and workspace binding are restored and checked, still inside the savepoint;
 *   5. RELEASE, then the role / identity / binding are checked once more outside it.
 * Steps 1-4 run inside `SAVEPOINT std_sync` (security review #166 F1): on ANY error (a JS error, a SQL error that aborted the
 * transaction, a failed restore or check) `ROLLBACK TO SAVEPOINT std_sync` reverts the role, the bindings and the metadata
 * writes even in an aborted transaction, and the error propagates (the caller's transaction then rolls back the workspace row).
 * The helper must be entered as the plain runtime identity (current_user = session_user); anything else is refused.
 * The same pattern as WorkspaceSchemaMigrator.actAsMigrationRole. A session that is neither allowed nor able to SET ROLE
 * crewflow is refused (fail closed): creation then fails rather than leaving a workspace without metadata.
 */
import { CREWFLOW_STANDARD_OBJECT_DEFINITIONS } from '../../../database/typeorm/workspace-schema/standard-objects/standard-object-definitions';
import { StandardObjectSyncError } from './standard-object-plan';
import { MetadataQuery, StandardSyncReport, syncStandardObjects } from './standard-object-sync';

const STATE_SQL = `SELECT pg_catalog.current_setting('role') AS role, (current_user = session_user) AS plain,
  COALESCE(pg_catalog.current_setting('rab.workspace_id', true), '') AS ws,
  (current_user IN ('crewflow'::name, 'rab_secure_owner'::name)
   OR coalesce((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false)) AS allowed,
  EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'crewflow') AND pg_catalog.pg_has_role(current_user, 'crewflow', 'SET') AS can_set`;

interface SessionState {
  role: string;
  plain: boolean;
  ws: string;
  allowed: boolean;
  can_set: boolean;
}

export const STANDARD_SYNC_SAVEPOINT = 'std_sync';

export async function syncStandardObjectsForNewWorkspace(query: MetadataQuery, workspace: { readonly id: string; readonly organisationId: string }): Promise<StandardSyncReport> {
  const state = async () => ((await query(STATE_SQL)) as SessionState[])[0];
  const prior = await state();
  if (!prior?.plain) throw new StandardObjectSyncError('NO_TENANT', 'the standard-object sync must start as the plain runtime identity (current_user = session_user)');
  if (!prior.allowed && !prior.can_set) throw new StandardObjectSyncError('NO_TENANT', 'this session can neither write built-in metadata nor SET ROLE crewflow');
  const elevate = !prior.allowed;
  const back = (s: SessionState | undefined) => Boolean(s && s.plain && s.role === prior.role && s.ws === prior.ws);

  await query(`SAVEPOINT ${STANDARD_SYNC_SAVEPOINT}`);
  let report: StandardSyncReport;
  try {
    await query(`SELECT pg_catalog.set_config('rab.workspace_id', $1, true)`, [workspace.id]);
    if (elevate) await query(`SELECT pg_catalog.set_config('role', 'crewflow', true)`);
    report = await syncStandardObjects(query, CREWFLOW_STANDARD_OBJECT_DEFINITIONS, { workspaceId: workspace.id, organisationId: workspace.organisationId });
    // Narrow privileged section: back to the caller's role and binding before leaving the savepoint, and proven.
    if (elevate) await query(`SELECT pg_catalog.set_config('role', $1, true)`, [prior.role]);
    await query(`SELECT pg_catalog.set_config('rab.workspace_id', $1, true)`, [prior.ws]);
    if (!back(await state())) throw new StandardObjectSyncError('NO_TENANT', 'the role or workspace binding could not be restored after the standard-object sync');
  } catch (error) {
    // Reverts the role, the bindings and the metadata writes, also in an aborted transaction. If even this fails the
    // transaction is unusable and the caller rolls it back; the original error is what propagates.
    await query(`ROLLBACK TO SAVEPOINT ${STANDARD_SYNC_SAVEPOINT}`).catch(() => undefined);
    throw error;
  }
  await query(`RELEASE SAVEPOINT ${STANDARD_SYNC_SAVEPOINT}`);
  if (!back(await state())) throw new StandardObjectSyncError('NO_TENANT', 'the session is not back to the caller\'s role and binding after the standard-object sync');
  return report;
}
