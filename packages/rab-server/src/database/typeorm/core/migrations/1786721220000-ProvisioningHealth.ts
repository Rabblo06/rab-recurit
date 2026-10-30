import { MigrationInterface, QueryRunner } from 'typeorm';

import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import {
  PROVISIONING_HEALTH_DOWN_SQL,
  PROVISIONING_HEALTH_EXPECTED_STATE,
  PROVISIONING_HEALTH_GONE_SQL,
  PROVISIONING_HEALTH_STATE_SQL,
  PROVISIONING_HEALTH_UP_SQL,
} from '../workspace-provisioning-health-sql';

/**
 * Phase B P8 (E6 gates 10, 14). Owner decision C (2026-10-29): APPROVED for the counts-only health definer ONLY; the
 * drafted status-only workspace-schema drift wrapper and its crewflow CREATE-on-core window are DEFERRED as an
 * HWS prerequisite and are not part of this migration. Exact SQL: core/workspace-provisioning-health-sql.ts (with the
 * cross-organisation justification block for the independent review).
 *
 * Creates, for the ORDINARY Worker (`crewflow_app`), so the privileged provisioner identity is not needed for it:
 *   - core.worker_workspace_provisioning_health(): counts only (stale CREATING > 10 min, FAILED), rab_secure_owner-owned
 *     SECURITY DEFINER, STABLE, search_path = pg_catalog, pg_temp, EXECUTE crewflow_app only — the daily stuck-workspace alert.
 * No table, policy, role, membership, default privilege or RLS flag changes, so the post-Phase-0b privilege-drift check
 * reports nothing (no REVIEWED_MIGRATION_DRIFT entry). The golden posture snapshot gains exactly 4 function lines
 * (PROVISIONING_HEALTH_GOLDEN_LINES).
 *
 * Authority: the Phase 0b bootstrap identity (member of crewflow + rab_secure_owner, no CREATEROLE) or a superuser.
 * Self-check before commit: exact owner / definer / volatility / search_path / EXECUTE holders, and the secure-owner
 * invariants (reachability, R4, dynamic-SQL lists) unchanged; anything else raises and rolls back.
 *
 * down(): drops the function and verifies it is gone. The Worker health job must be unregistered first (it then fails
 * loudly, never silently, if the function is missing).
 */
export class ProvisioningHealth1786721220000 implements MigrationInterface {
  name = 'ProvisioningHealth1786721220000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.pinSearchPath(queryRunner);
    await this.assertBootstrap(queryRunner);
    for (const sql of PROVISIONING_HEALTH_UP_SQL) await queryRunner.query(sql);

    const state = (await queryRunner.query(PROVISIONING_HEALTH_STATE_SQL)) as Array<Record<string, unknown>>;
    if (JSON.stringify(state) !== JSON.stringify(PROVISIONING_HEALTH_EXPECTED_STATE)) {
      throw new Error(`${this.name}: unexpected function state after create (rolled back): ${JSON.stringify(state)}`);
    }
    const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
    if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.pinSearchPath(queryRunner);
    await this.assertBootstrap(queryRunner);
    for (const sql of PROVISIONING_HEALTH_DOWN_SQL) await queryRunner.query(sql);
    const [row] = (await queryRunner.query(PROVISIONING_HEALTH_GONE_SQL)) as Array<{ gone: boolean }>;
    if (row?.gone !== true) throw new Error(`${this.name}: functions remain after down() (rolled back).`);
  }

  private async pinSearchPath(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
  }

  private async assertBootstrap(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $authority$
      BEGIN
        IF NOT pg_catalog.pg_has_role(current_user, 'crewflow', 'USAGE') OR NOT pg_catalog.pg_has_role(current_user, 'rab_secure_owner', 'USAGE') THEN
          RAISE EXCEPTION 'ProvisioningHealth1786721220000 must run as the bootstrap identity (it creates a rab_secure_owner function in core); refusing as %', current_user
            USING ERRCODE = 'insufficient_privilege';
        END IF;
      END
      $authority$;
    `);
  }
}
