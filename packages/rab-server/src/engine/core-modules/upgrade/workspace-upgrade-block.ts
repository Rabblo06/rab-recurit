/**
 * OWNER-DB-ULTIMATE Part D, owner decisions D2 / D3 (2026-11-14): a workspace whose upgrade step failed with a structure that
 * does not match this code (a structural step, a structure mismatch, a refused adoption, no / unknown cursor) is BLOCKED until
 * its step succeeds: its requests get 503 "workspace is being upgraded", its Worker jobs pause, the step retries every start.
 * A data-only failure with a matching structure is NOT blocked (served, still reported failed and retried).
 *
 * Source of truth (no new SQL): the existing registry column `core.workspace_schema_registry.migration_error`, written by the
 * workspace command runner (as crewflow, tenant bound, like WorkspaceSchemaMigrator) with this prefix. The runtime role can
 * already read it under the registry's tenant RLS, so SchemaResolverService (the service-layer routing point every API and
 * Worker workspace bind passes through) refuses a blocked workspace. Messages written by the older migrator / provisioners
 * never carry the prefix and never block.
 */
export const UPGRADE_BLOCK_PREFIX = 'upgrade-blocked: ';

/** `upgrade-blocked: <step> (<CLASS>)`, at most 500 characters (the column's CHECK). Step and class are code labels only. */
export function upgradeBlockMarker(step: string, errorClass: string): string {
  const safeStep = step.replace(/[^A-Za-z0-9_.]/g, '').slice(0, 200);
  const safeClass = errorClass.replace(/[^A-Za-z0-9_]/g, '').slice(0, 60) || 'UNKNOWN';
  return `${UPGRADE_BLOCK_PREFIX}${safeStep} (${safeClass})`.slice(0, 500);
}

export function isUpgradeBlocked(migrationError: string | null | undefined): boolean {
  return typeof migrationError === 'string' && migrationError.startsWith(UPGRADE_BLOCK_PREFIX);
}

/** The step and class of a marker (null when the text is not a marker). */
export function parseUpgradeBlock(migrationError: string | null | undefined): { step: string; errorClass: string } | null {
  if (!isUpgradeBlocked(migrationError)) return null;
  const m = /^upgrade-blocked: ([A-Za-z0-9_.]*) \(([A-Za-z0-9_]+)\)$/.exec(migrationError!);
  return m ? { step: m[1]!, errorClass: m[2]! } : { step: '', errorClass: 'UNKNOWN' };
}
