import { MigrationInterface, QueryRunner } from 'typeorm';

import {
  GUARDS_MIGRATION_NAME,
  PROVISION_WORKSPACE_PRIVILEGE_SHAPE,
  PROVISION_WORKSPACE_STATE_SQL,
  provisionWorkspaceGuardsDownSql,
  provisionWorkspaceGuardsUpSql,
} from '../provision-workspace-guards-sql';
import { secureOwnerInvariantViolations } from '../secure-owner-invariants';

/**
 * Phase B P8 (E6 gates 3, 4, 8). Owner decision B (2026-10-29): APPROVED for disposable databases. Exact SQL:
 * core/provision-workspace-guards-sql.ts (rendered in scratchpad/phaseB/a6/ProvisionWorkspaceGuards1786721210000.sql).
 * Owner requirements: a suspended organisation cannot initiate provisioning; only an ACTIVE owner account may provision;
 * platform administrators get NO exemption (the function has no admin path at all, and the service-layer
 * `assertCallerMayProvision` refuses on organisation suspension / account status alone, so the route guard's platform-admin
 * exemption cannot let provisioning through); function ownership, SECURITY DEFINER, search_path, lock_timeout and ACL,
 * the module-v18 template and FORCE RLS are unchanged.
 *
 * Re-creates `core.provision_workspace(uuid)` (CREATE OR REPLACE: same OID, owner crewflow, SECURITY DEFINER,
 * search_path = pg_catalog, pg_temp, lock_timeout 30s, ACL EXECUTE crewflow + crewflow_app) with the v18 module composition
 * of VenueTeamOrgAdmin1786721090000 UNCHANGED plus: a shared lock in the worker provisioner's advisory-lock keyspace (gate
 * 8), and refusals for a suspended organisation (CWP01) and an account that is not active (CWP02) (gates 3-4, F3). See the
 * SQL module's header for the exact insertions and why no in-function rate guard is added.
 *
 * Refuses (rolls back) unless the installed body is exactly the one 1786721090000 created — so it can never silently replace
 * a later module composition; a later module migration must re-compose on top of this guarded body (its spec fails until
 * then: GUARDS_THROUGH_VERSION must equal LATEST_WORKSPACE_MODULE_VERSION).
 *
 * Authority: the CF-41 / Phase 0b bootstrap identity (restricted migrator: member of crewflow + rab_secure_owner, no
 * CREATEROLE) or a superuser. No CREATE ROLE, no grant, no ownership change, no RLS change: no privilege drift.
 *
 * down(): restores byte-for-byte the 1786721090000 body (same composition, same app_version literal) and re-verifies the
 * privilege shape. Workspace schemas are untouched in both directions.
 */
export class ProvisionWorkspaceGuards1786721210000 implements MigrationInterface {
  name = GUARDS_MIGRATION_NAME;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.pinSearchPath(queryRunner);
    await this.assertBootstrap(queryRunner);
    const before = await this.state(queryRunner);
    if (before.is_previous_body !== true || before.has_guards !== false) {
      throw new Error(
        `${this.name}: core.provision_workspace is not the VenueTeamOrgAdmin1786721090000 body (previous=${String(before.is_previous_body)}, ` +
          `guards=${String(before.has_guards)}). Re-base this migration on the installed module composition. Refusing.`,
      );
    }
    await queryRunner.query(provisionWorkspaceGuardsUpSql());
    await this.verify(queryRunner, 'up');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.pinSearchPath(queryRunner);
    await this.assertBootstrap(queryRunner);
    await queryRunner.query(provisionWorkspaceGuardsDownSql());
    await this.verify(queryRunner, 'down');
  }

  /** Same as Phase 0b: this session resolves names in pg_catalog only; every object named here is schema-qualified. */
  private async pinSearchPath(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
  }

  private async assertBootstrap(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $authority$
      BEGIN
        IF NOT pg_catalog.pg_has_role(current_user, 'crewflow', 'USAGE') OR NOT pg_catalog.pg_has_role(current_user, 'rab_secure_owner', 'USAGE') THEN
          RAISE EXCEPTION 'ProvisionWorkspaceGuards1786721210000 must run as the bootstrap identity (it re-creates the crewflow-owned core.provision_workspace); refusing as %', current_user
            USING ERRCODE = 'insufficient_privilege';
        END IF;
      END
      $authority$;
    `);
  }

  private async state(queryRunner: QueryRunner): Promise<Record<string, unknown>> {
    const [row] = (await queryRunner.query(PROVISION_WORKSPACE_STATE_SQL)) as Array<Record<string, unknown>>;
    if (!row) throw new Error(`${this.name}: core.provision_workspace(uuid) does not exist. Refusing.`);
    return row;
  }

  /** Privilege shape unchanged, the intended body installed, and the Phase 0b secure-owner invariants still hold. */
  private async verify(queryRunner: QueryRunner, direction: 'up' | 'down'): Promise<void> {
    const after = await this.state(queryRunner);
    const problems = Object.entries(PROVISION_WORKSPACE_PRIVILEGE_SHAPE)
      .filter(([key, expected]) => after[key] !== expected)
      .map(([key, expected]) => `${key}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(after[key])}`);
    const wantGuards = direction === 'up';
    if (after.has_guards !== wantGuards) problems.push(`guards present: expected ${wantGuards}, found ${String(after.has_guards)}`);
    if (after.is_guarded_body !== wantGuards) problems.push(`guarded body marker: expected ${wantGuards}, found ${String(after.is_guarded_body)}`);
    if (after.is_previous_body !== !wantGuards) problems.push(`previous body marker: expected ${!wantGuards}, found ${String(after.is_previous_body)}`);
    if (problems.length) throw new Error(`${this.name} ${direction}: unexpected state (rolled back):\n  ${problems.join('\n  ')}`);

    const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
    if (violations.length) throw new Error(`${this.name} ${direction}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
  }
}
