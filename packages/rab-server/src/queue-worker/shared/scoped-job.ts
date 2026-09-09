import { EntityManager } from 'typeorm';

import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';

/**
 * The one, uniform way every non-maintenance worker job touches a specific
 * business row: bind a real `rab_app`-role transaction to that row's
 * organisation AND workspace, never the owner/bypass connection the
 * periodic-scan step used to FIND the candidate. Per CLAUDE.md's layer-2
 * rule and this session's own explicit instruction — "email/notifications/
 * shift jobs/offers/attendance/payroll should [never] use the same
 * elevated connection" maintenance sweeps do.
 *
 * `workspaceId` is REQUIRED, not optional — confirmed directly against the
 * real RLS policies (`PlatformAdminGlobalRedesign1786669400000`):
 * `shift_assignment_tenant`/`job_offer_tenant`/`attendance_tenant`/
 * `shift_tenant` all gate on `workspace_id = core.current_workspace()` (or
 * an unrelated venue-manager EXISTS clause), not `organisation_id` alone.
 * Binding only `organisationId` (an earlier draft of this helper did
 * exactly that) makes `current_workspace()` resolve to NULL, and
 * `workspace_id = NULL` is never true in SQL — every read/write against
 * these 4 tables silently sees nothing, no error, just an empty result.
 * Caught by this file's own integration tests (`worker-operations-abuse-
 * cases.integration.spec.ts`), not by inspection. A row with a NULL
 * `workspace_id` of its own (pre-Workspace-migration legacy data) is
 * therefore inert to every job using this helper — an acceptable, honest
 * degradation matching this codebase's own "never guess ownership" rule
 * for other nullable ownership columns, not a bug to work around.
 *
 * Callers must still reload the target row fresh inside `fn` and re-
 * validate before any mutation (A9/A10-style revalidation) — this helper
 * only supplies the correctly-scoped transaction, never a shortcut past
 * that check.
 */
export function runScopedForOrg<T>(
  tenantContext: TenantContextService,
  organisationId: string,
  workspaceId: string | null,
  fn: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  return tenantContext.runInTenantContext({ organisationId, workspaceId, userId: '', role: '' }, fn);
}
