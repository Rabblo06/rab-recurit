import { archiveColumnsSql } from './archive-columns';
import { searchVectorsSql } from './search-vectors';
import { SERVER_PATH_SENTINEL_SCHEMA } from './server-path-template';
import { composeServerPathTemplateV1AttendanceMoney } from './server-path-template-attendance-money';

/**
 * FROZEN with migration ArchiveAndSearchSchema1786719920000 (never edited after merge). The composition
 * `core.provision_workspace(uuid)` embeds from that migration on: the 1786719810000 composition (modules 1..15), unchanged
 * and in the same order, followed by module 16 (`archiveColumnsSql`) and module 17 (`searchVectorsSql`).
 *
 * Structural counts: tables, FKs and policies unchanged; indexes 90 → 94 (module 16) → 100 (module 17). The re-created
 * `core.verify_workspace_schema_v1` (verify-workspace-schema-v1-versioned.ts) expects the count of the workspace's
 * recorded module version. Drift guard: `workspace-schema-modules.spec.ts` asserts the module list composes to exactly this.
 */
export function composeServerPathTemplateV1ArchiveSearch(): string {
  return [
    composeServerPathTemplateV1AttendanceMoney(),
    archiveColumnsSql(SERVER_PATH_SENTINEL_SCHEMA),
    searchVectorsSql(SERVER_PATH_SENTINEL_SCHEMA),
  ].join(';\n');
}

/** Index count of a correctly built workspace schema by module version (v1..15 = 90, the 1786719500000 count). */
export function expectedWorkspaceIndexCount(moduleVersion: number): number {
  if (moduleVersion >= 17) return 100;
  if (moduleVersion === 16) return 94;
  return 90;
}
export const KNOWN_WORKSPACE_INDEX_COUNTS = [90, 94, 100] as const;
