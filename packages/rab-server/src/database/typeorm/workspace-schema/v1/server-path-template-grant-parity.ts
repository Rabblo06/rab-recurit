import { workspaceGrantParitySql } from './grant-parity-guards';
import { SERVER_PATH_SENTINEL_SCHEMA } from './server-path-template';
import { composeServerPathTemplateV1StatementPointer } from './server-path-template-statement-pointer';

/**
 * FROZEN with migration WorkspaceGrantParityGuards1786721430000 (never edited after merge). The composition
 * `core.provision_workspace(uuid)` embeds from that migration on: the 1786721320000 composition (modules 1..19), unchanged
 * and in the same order, followed by module 20 (`workspaceGrantParitySql`).
 *
 * Structural counts: tables, FKs, indexes and policies unchanged (module 20 adds triggers only, which the structural counts
 * do not include; the per-version fingerprint covers them). Drift guard: `workspace-schema-modules.spec.ts` asserts the
 * module list composes to exactly this.
 */
export function composeServerPathTemplateV1GrantParity(): string {
  return [composeServerPathTemplateV1StatementPointer(), workspaceGrantParitySql(SERVER_PATH_SENTINEL_SCHEMA)].join(';\n');
}
