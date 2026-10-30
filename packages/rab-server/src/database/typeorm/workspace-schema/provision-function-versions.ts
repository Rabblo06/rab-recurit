/**
 * Phase B (schema-version compatibility gates, proposal 03 item 6): which workspace module version the database's
 * `core.provision_workspace(uuid)` body builds.
 *
 * The module composition is frozen into the function body by the core migration that last re-created it, and every such
 * body carries one literal `db:provision_workspace@<MigrationName>` (its ledger `app_version`). That literal identifies the
 * body, and this FROZEN map says which module version it provisions. Append-only: a migration that re-creates the function
 * adds its literal here in the same change (workspace-schema-modules.spec.ts proves the newest entry equals
 * LATEST_WORKSPACE_MODULE_VERSION).
 *
 * Reading the body is catalog-only (`pg_catalog.pg_proc` is world-readable; no grant, no new SQL object).
 */
export const PROVISION_FUNCTION_APP_VERSION_PREFIX = 'db:provision_workspace@';

export const PROVISION_FUNCTION_MODULE_VERSIONS: Readonly<Record<string, number>> = Object.freeze({
  'db:provision_workspace@AttendanceMoneyChecks1786719810000': 15,
  'db:provision_workspace@ArchiveAndSearchSchema1786719920000': 17,
  'db:provision_workspace@VenueTeamOrgAdmin1786721090000': 18,
  'db:provision_workspace@ProvisionWorkspaceGuards1786721210000': 18,
});

/**
 * - missing: the function does not exist (drift or a database the migrations never reached);
 * - legacy:  the pre-ledger v1 body, which carries no app_version literal (provisions below module 15);
 * - unknown: a literal this code has never seen (another branch, a newer image's migration, or tampering);
 * - known:   a literal in the frozen map, with its module version.
 */
export type ProvisionFunctionState =
  | { state: 'missing' }
  | { state: 'legacy' }
  | { state: 'unknown'; literal: string }
  | { state: 'known'; literal: string; moduleVersion: number };

export const PROVISION_FUNCTION_SOURCE_SQL = `SELECT p.prosrc AS "prosrc" FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('core.provision_workspace(uuid)')`;

const LITERAL_PATTERN = /'(db:provision_workspace@[A-Za-z0-9._:@+/-]{1,100})'/g;

/** Pure: the state of a function body (null = the function does not exist). Two different literals are 'unknown'. */
export function parseProvisionFunctionSource(prosrc: string | null | undefined): ProvisionFunctionState {
  if (prosrc === null || prosrc === undefined) return { state: 'missing' };
  const literals = [...new Set([...prosrc.matchAll(LITERAL_PATTERN)].map((m) => m[1]!))];
  if (literals.length === 0) return { state: 'legacy' };
  if (literals.length > 1) return { state: 'unknown', literal: literals.join(' + ') };
  const literal = literals[0]!;
  const moduleVersion = PROVISION_FUNCTION_MODULE_VERSIONS[literal];
  return moduleVersion === undefined ? { state: 'unknown', literal } : { state: 'known', literal, moduleVersion };
}

/** Read-only catalog read on the caller's session. */
export async function readProvisionFunctionState(query: (sql: string, params?: unknown[]) => Promise<unknown[]>): Promise<ProvisionFunctionState> {
  const rows = (await query(PROVISION_FUNCTION_SOURCE_SQL)) as Array<{ prosrc: string | null }>;
  return parseProvisionFunctionSource(rows[0]?.prosrc ?? null);
}

export function describeProvisionFunctionState(s: ProvisionFunctionState): string {
  switch (s.state) {
    case 'missing':
      return 'core.provision_workspace(uuid) does not exist';
    case 'legacy':
      return 'core.provision_workspace(uuid) is the pre-ledger body (no app_version literal)';
    case 'unknown':
      return `core.provision_workspace(uuid) carries an app_version this code does not know (${s.literal})`;
    case 'known':
      return `core.provision_workspace(uuid) is ${s.literal} (module ${s.moduleVersion})`;
  }
}
