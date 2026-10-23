import { MigrationInterface, QueryRunner } from 'typeorm';

import { WORKSPACE_FINGERPRINT_FUNCTIONS_SQL } from '../../workspace-schema/workspace-schema-fingerprint';
import {
  VERIFY_WORKSPACE_SCHEMA_V1_ISOLATED_SQL,
  VERIFY_WORKSPACE_SCHEMA_V1_ORIGINAL_SQL,
  WORKSPACE_SCHEMA_LEDGER_DOWN_SQL,
  WORKSPACE_SCHEMA_LEDGER_UP_SQL,
} from '../../workspace-schema/workspace-schema-ledger-sql';
import { WorkspaceSchemaMigrator } from '../../workspace-schema/workspace-schema-migrator';

/**
 * Wave 2 lane S2 (B3 + B4 foundation). Dev/test only: deliberately NOT in production-migration-approval.ts.
 *
 * Creates:
 *  - `core.workspace_schema_migration`, the append-only per-workspace module ledger (ENABLE + FORCE RLS, organisation
 *    policy; `crewflow_app` SELECT only — no INSERT/UPDATE/DELETE; an append-only trigger binds every role, the owner
 *    included);
 *  - registry columns `module_version`, `expected_fingerprint`, `observed_fingerprint`, `fingerprint_checked_at`,
 *    `drift_status`, `drift_detail`, plus a guard so the runtime role cannot write them;
 *  - `core.workspace_schema_fingerprint[_lines](uuid)` (structural fingerprint) and `core.record_workspace_schema_drift(uuid)`
 *    (alert-only drift recorder), EXECUTE to `crewflow` only;
 *  - `core.verify_workspace_schema_v1(uuid)` re-created (CREATE OR REPLACE: same checks, labels, owner, ACL) so that its
 *    binding-CHECK scan cannot block on a lock held on ANOTHER workspace's table (found by the migrator's lock test).
 *
 * Backfill (G2): every READY workspace that existed before the ledger is BASELINED through WorkspaceSchemaMigrator — only
 * when its fingerprint equals the expected v14 fingerprint (what the hand-looped migrations through 1786719700000
 * produce). A workspace that does not match is NOT adopted: a REFUSED ledger row (BASELINE_MISMATCH) records it, nothing
 * else changes, and the next workspace-module migration will refuse to run on it until an operator resolves it.
 *
 * `schema_version` is untouched (stays 1): SchemaResolverService routes only SUPPORTED_WORKSPACE_SCHEMA_VERSIONS = {1}.
 */
export class WorkspaceSchemaMigrationLedger1786719800000 implements MigrationInterface {
  name = 'WorkspaceSchemaMigrationLedger1786719800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await assertCrewflowAuthority(queryRunner, this.name);
    await queryRunner.query(WORKSPACE_SCHEMA_LEDGER_UP_SQL);
    await queryRunner.query(WORKSPACE_FINGERPRINT_FUNCTIONS_SQL);
    // Same checks/labels/owner/ACL; the binding-CHECK scan no longer locks other workspaces' tables (see the SQL comment).
    await queryRunner.query(VERIFY_WORKSPACE_SCHEMA_V1_ISOLATED_SQL);

    const outcomes = await new WorkspaceSchemaMigrator(queryRunner).migrateAll({
      throughVersion: 14,
      txMode: 'savepoint',
      appVersion: `migration:${this.name}`,
    });
    const refused = outcomes.filter((o) => o.status === 'REFUSED' || o.status === 'FAILED');
    // eslint-disable-next-line no-console
    console.log(
      `[${this.name}] ledger backfill: ${outcomes.filter((o) => o.status === 'BASELINED').length} baselined, ` +
        `${outcomes.filter((o) => o.status === 'SKIPPED').length} skipped (not READY), ${refused.length} refused` +
        (refused.length ? ` (${refused.map((o) => `${o.schemaName}:${o.errorClass}`).join(', ')})` : ''),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await assertCrewflowAuthority(queryRunner, this.name);
    await queryRunner.query(VERIFY_WORKSPACE_SCHEMA_V1_ORIGINAL_SQL);
    await queryRunner.query(WORKSPACE_SCHEMA_LEDGER_DOWN_SQL);
  }
}

async function assertCrewflowAuthority(queryRunner: QueryRunner, name: string): Promise<void> {
  await queryRunner.query(`
    DO $authority$
    BEGIN
      IF NOT pg_has_role(current_user, 'crewflow', 'USAGE') THEN
        RAISE EXCEPTION '${name} must run as crewflow or the bootstrap identity; refusing as %', current_user
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END
    $authority$;
  `);
}
