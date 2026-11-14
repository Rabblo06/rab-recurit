/**
 * Part C1 (C1b, CI scale): remembers which organisations and workspaces THIS test file's fixtures created, so the
 * per-file test environment (fixture-schema-cleanup-environment.ts) can drop their workspace schemas when the file is done.
 *
 * Why: with HWS runtime routing on by default, every fixture workspace gets its READY schema (121 relations, ~31 foreign
 * keys to core rows). One shared in-band CI database otherwise accumulates hundreds of schemas: catalogue scans, the
 * provisioning definer and every core-row delete (one RI lock per referencing schema table) slow down until statements
 * time out (C1-STATUS.md §5, §7).
 *
 * The sets live on the test file's own global object (one per file in Jest), which the environment reads in teardown(),
 * after every hook of the file has run. Only ids the fixtures created are recorded, so a parallel Jest worker's
 * workspaces are never touched.
 */
interface FixtureTrackerGlobal {
  __crewflowFixtureWorkspaces?: Set<string>;
  __crewflowFixtureOrganisations?: Set<string>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function trackFixtureWorkspace(workspaceId: string): void {
  if (!UUID.test(workspaceId)) return;
  const g = globalThis as FixtureTrackerGlobal;
  (g.__crewflowFixtureWorkspaces ??= new Set()).add(workspaceId.toLowerCase());
}

export function trackFixtureOrganisation(organisationId: string): void {
  if (!UUID.test(organisationId)) return;
  const g = globalThis as FixtureTrackerGlobal;
  (g.__crewflowFixtureOrganisations ??= new Set()).add(organisationId.toLowerCase());
}
