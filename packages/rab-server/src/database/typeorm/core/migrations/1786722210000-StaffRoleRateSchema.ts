import { MigrationInterface, QueryRunner } from 'typeorm';

import { withCrewflowCoreCreate } from '../core-schema-create-scope';
import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import {
  STAFF_ROLE_RATE_DOWN_SQL,
  STAFF_ROLE_RATE_DOWN_UNFORCE_SQL,
  STAFF_ROLE_RATE_OWNERSHIP_SQL,
  STAFF_ROLE_RATE_PREFLIGHT_SQL,
  STAFF_ROLE_RATE_ROWS_SQL,
  STAFF_ROLE_RATE_SECURITY_SQL,
  STAFF_ROLE_RATE_STATE_SQL,
  STAFF_ROLE_RATE_TABLE_SQL,
  StaffRoleRateTableState,
  staffRoleRateStateProblems,
} from '../staff-role-rate-sql';

/**
 * Lane C (milestone M2; DRAFT — owner SQL review FIRST, run only on throwaway databases until approved): the per-staff,
 * per-job-role pay rate (architecture §1 A6, "staff role rate"). Creates core.staff_role_rate with ENABLE + FORCE ROW LEVEL
 * SECURITY, its four policies (USING / WITH CHECK: tenant + a non-venue manager of the bound workspace; INSERT also
 * created_by = the caller), grants and two grant-parity triggers in THIS migration (CLAUDE.md). Exact SQL and reasoning:
 * ../staff-role-rate-sql.ts (including why this is a core table and not a workspace table).
 *
 * The table is not read before authentication, so it does not take the NOT-FORCE exception. tools/check-rls-coverage.ts
 * finds it through organisation_id. Self-check before commit (rolled back on any difference): owner, RLS, ACL, column ACL,
 * policies and triggers, then secureOwnerInvariantViolations() empty. down() refuses while any rate row exists (retention).
 */
export class StaffRoleRateSchema1786722210000 implements MigrationInterface {
  name = 'StaffRoleRateSchema1786722210000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    this.assertInTransaction(queryRunner, 'up');
    await this.pinSearchPath(queryRunner);
    await this.preflight(queryRunner, 'up');
    await queryRunner.query(STAFF_ROLE_RATE_TABLE_SQL);
    for (const sql of STAFF_ROLE_RATE_SECURITY_SQL)
      await queryRunner.query(sql);
    await withCrewflowCoreCreate(queryRunner, async () => {
      for (const sql of STAFF_ROLE_RATE_OWNERSHIP_SQL)
        await queryRunner.query(sql);
    });

    const [state] = (await queryRunner.query(
      STAFF_ROLE_RATE_STATE_SQL,
    )) as StaffRoleRateTableState[];
    const problems = staffRoleRateStateProblems(state);
    if (problems.length)
      throw new Error(
        `${this.name}: unexpected state after create (rolled back):\n  ${problems.join('\n  ')}`,
      );

    const violations = await secureOwnerInvariantViolations((sql) =>
      queryRunner.query(sql),
    );
    if (violations.length)
      throw new Error(
        `${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`,
      );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    this.assertInTransaction(queryRunner, 'down');
    await this.pinSearchPath(queryRunner);
    await this.preflight(queryRunner, 'down');
    // Retention: never drop recorded pay rates. The count needs NO FORCE (a migration binds no tenant); a refusal rolls back.
    await queryRunner.query(STAFF_ROLE_RATE_DOWN_UNFORCE_SQL);
    const [{ n }] = (await queryRunner.query(
      STAFF_ROLE_RATE_ROWS_SQL,
    )) as Array<{ n: number }>;
    if (Number(n) !== 0)
      throw new Error(
        `${this.name}: refusing down(): core.staff_role_rate holds ${n} row(s). Nothing was dropped.`,
      );
    await queryRunner.query(STAFF_ROLE_RATE_DOWN_SQL);
  }

  /** Every statement (the set_config(..., true) pin, NO FORCE in down(), the post-condition) relies on ONE transaction. */
  private assertInTransaction(
    queryRunner: QueryRunner,
    direction: 'up' | 'down',
  ): void {
    if (!queryRunner.isTransactionActive) {
      throw new Error(
        `${this.name}: refusing to run ${direction} outside a transaction (transaction = false is never allowed here).`,
      );
    }
  }

  /** Same as Phase 0b: this transaction resolves names in pg_catalog only; every object named here is schema-qualified. */
  private async pinSearchPath(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`,
    );
  }

  private async preflight(
    queryRunner: QueryRunner,
    direction: 'up' | 'down',
  ): Promise<void> {
    const [f] = (await queryRunner.query(
      STAFF_ROLE_RATE_PREFLIGHT_SQL,
    )) as Array<{
      table_present: boolean;
      parity_guard: boolean;
      tenant_functions: boolean;
      btree_gist: boolean;
      workspace_key: boolean;
      roles: number;
    }>;
    const problems: string[] = [];
    if (!f) problems.push('cannot read the catalog');
    else {
      if (Number(f.roles) !== 2)
        problems.push('the roles crewflow and crewflow_app must exist');
      if (!f.parity_guard)
        problems.push(
          'core.owner_login_grant_parity_guard() must exist (OwnerLoginGrantParityGuards1786721420000 first)',
        );
      if (!f.tenant_functions)
        problems.push(
          'core.current_org(), core.current_workspace() and core.current_uid() must exist',
        );
      if (!f.btree_gist)
        problems.push(
          'the btree_gist extension must be installed (InitSchema)',
        );
      if (!f.workspace_key)
        problems.push(
          'core.manager_workspace must have a UNIQUE (id, organisation_id) key (the tenant FK target)',
        );
      if (direction === 'up' && f.table_present)
        problems.push('core.staff_role_rate already exists');
      if (direction === 'down' && !f.table_present)
        problems.push('core.staff_role_rate does not exist');
    }
    if (problems.length)
      throw new Error(
        `${this.name}: refusing to run ${direction}: ${problems.join('; ')}.`,
      );
  }
}
