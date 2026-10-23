/**
 * W6-E2E-07: which workspace-routing refusals a cross-tenant worker walk may SKIP instead of failing the whole cycle.
 *
 * Every per-workspace walk (`discoverInWorkspaces`, the realtime-outbox publisher, outbox retention) enumerates workspaces
 * from `core.worker_list_workspaces` — i.e. from `core.manager_workspace` — and then binds each one through
 * `TenantContextService`, which under HWS resolves the physical schema from `core.workspace_schema_registry`. A workspace
 * that is still being created is listed before its registry row exists (`registry-missing`) or is READY
 * (`not-ready`): `ManagerWorkspaceService` commits the workspace row, then provisions. Before this fix that refusal was
 * rethrown, so ONE brand-new workspace failed the cycle for EVERY tenant (seen once per workspace creation in wave 6 lane
 * E2E: "realtime outbox publish cycle failed … WorkspaceRoutingError registry-missing"), and the whole batch waited a tick.
 *
 * Skipping those two codes is safe and still fail-closed: nothing is routed to the workspace and nothing is read or
 * written for it; a workspace that is not READY has no workspace-schema rows to process, and the next cycle picks it up
 * once it is READY. The integrity refusals (`name-mismatch`, `unsupported-version`, `missing-context`) are NOT skippable:
 * they still fail the cycle loudly, exactly as before.
 *
 * Duck-typed on name + code (not `instanceof`) so it holds whichever compiled copy of `@rab/server` threw it.
 */
const SKIPPABLE_ROUTING_CODES: ReadonlySet<string> = new Set(['registry-missing', 'not-ready']);

export function isNotYetRoutableWorkspace(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'WorkspaceRoutingError') return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && SKIPPABLE_ROUTING_CODES.has(code);
}
