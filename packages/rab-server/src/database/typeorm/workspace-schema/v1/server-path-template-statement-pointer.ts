import { SERVER_PATH_SENTINEL_SCHEMA } from './server-path-template';
import { statementDispatchPointerSql } from './statement-dispatch-pointer';
import { composeServerPathTemplateV1VenueTeamAdmin } from './server-path-template-venue-team-admin';

/**
 * FROZEN with migration StatementDispatchPointer1786721320000 (never edited after merge). The composition
 * `core.provision_workspace(uuid)` embeds from that migration on: the 1786721090000 composition (modules 1..18), unchanged
 * and in the same order, followed by module 19 (`statementDispatchPointerSql`).
 *
 * Structural counts: tables, FKs, indexes and policies unchanged (module 19 adds four triggers only (three row-level, one TRUNCATE), which the structural
 * counts do not include; the per-version fingerprint covers them). Drift guard: `workspace-schema-modules.spec.ts` asserts
 * the module list composes to exactly this.
 */
export function composeServerPathTemplateV1StatementPointer(): string {
  return [composeServerPathTemplateV1VenueTeamAdmin(), statementDispatchPointerSql(SERVER_PATH_SENTINEL_SCHEMA)].join(';\n');
}
