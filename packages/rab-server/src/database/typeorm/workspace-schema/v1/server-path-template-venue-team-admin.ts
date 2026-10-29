import { SERVER_PATH_SENTINEL_SCHEMA } from './server-path-template';
import { composeServerPathTemplateV1ArchiveSearch } from './server-path-template-archive-search';
import { venueTeamOrgAdminSql } from './venue-team-org-admin';

/**
 * FROZEN with migration VenueTeamOrgAdmin1786721090000 (never edited after merge). The composition
 * `core.provision_workspace(uuid)` embeds from that migration on: the 1786719920000 composition (modules 1..17), unchanged
 * and in the same order, followed by module 18 (`venueTeamOrgAdminSql`).
 *
 * Structural counts: tables, FKs and indexes unchanged; policies 39 → 41 (module 18). The re-created
 * `core.verify_workspace_schema_v1` (verify-workspace-schema-v1-policy-aware.ts) expects the count of the workspace's
 * recorded module version. Drift guard: `workspace-schema-modules.spec.ts` asserts the module list composes to exactly this.
 */
export function composeServerPathTemplateV1VenueTeamAdmin(): string {
  return [composeServerPathTemplateV1ArchiveSearch(), venueTeamOrgAdminSql(SERVER_PATH_SENTINEL_SCHEMA)].join(';\n');
}

/** Policy count of a correctly built workspace schema by module version (v1..17 = 39, the 1786719500000 count). */
export function expectedWorkspacePolicyCount(moduleVersion: number): number {
  return moduleVersion >= 18 ? 41 : 39;
}
export const KNOWN_WORKSPACE_POLICY_COUNTS = [39, 41] as const;
