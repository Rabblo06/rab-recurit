import { payrollEvidenceRestrictSql } from './payroll-evidence-restrict';
import { composeServerPathTemplateV1, SERVER_PATH_SENTINEL_SCHEMA } from './server-path-template';

/**
 * FROZEN with migration PayrollEvidenceRestrict1786719700000 (never edited after merge). The composition
 * `core.provision_workspace(uuid)` embeds from that migration on: the 1786719500000 composition, unchanged and in the same
 * order, followed by the F3 step (`payrollEvidenceRestrictSql`). Structural counts are unchanged — the step re-creates
 * three existing FKs with a different delete action — so `SERVER_PATH_EXPECTED_V1` / `core.verify_workspace_schema_v1`
 * still hold.
 *
 * Drift guard: `server-path-template-payroll-restrict.spec.ts` asserts that the TypeScript provisioner's
 * `WORKSPACE_TEMPLATE_STEPS` (provision-workspace-schema.ts) compose to exactly this text for the sentinel schema, so the
 * two provisioning paths cannot build different schemas.
 */
export function composeServerPathTemplateV1PayrollRestrict(): string {
  return [composeServerPathTemplateV1(), payrollEvidenceRestrictSql(SERVER_PATH_SENTINEL_SCHEMA)].join(';\n');
}
