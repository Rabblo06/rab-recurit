import { MigrationInterface, QueryRunner } from 'typeorm';

import { withCrewflowCoreCreate } from '../core-schema-create-scope';
import {
  PAYROLL_ADJUSTMENT_DOWN_SQL,
  PAYROLL_ADJUSTMENT_DOWN_UNFORCE_SQL,
  PAYROLL_ADJUSTMENT_FUNCTION_STATE_SQL,
  PAYROLL_ADJUSTMENT_OWNERSHIP_SQL,
  PAYROLL_ADJUSTMENT_PREFLIGHT_SQL,
  PAYROLL_ADJUSTMENT_ROWS_SQL,
  PAYROLL_ADJUSTMENT_SECURITY_SQL,
  PAYROLL_ADJUSTMENT_STATE_SQL,
  PAYROLL_ADJUSTMENT_TABLE_SQL,
  PayrollAdjustmentTableState,
  payrollAdjustmentStateProblems,
} from '../payroll-adjustment-sql';
import { secureOwnerInvariantViolations } from '../secure-owner-invariants';

/**
 * Lane P2 (milestone M5, owner decision 3; DRAFT: owner SQL review FIRST, run only on throwaway databases until approved):
 * payroll adjustments (correction / bonus / expense) as separate approved lines. Creates core.payroll_adjustment (and the
 * insert-only run facts core.payroll_run_event, review fix) with
 * ENABLE + FORCE ROW LEVEL SECURITY, its three policies (USING / WITH CHECK: tenant + a non-venue manager of the bound
 * workspace; the paid staff member reads their own APPROVED lines), the guard trigger core.payroll_adjustment_guard()
 * (state machine, immutable figures, payroll lock), grants and three grant-parity triggers in THIS migration (CLAUDE.md).
 * Exact SQL and reasoning: ../payroll-adjustment-sql.ts (including why this is a core table and not a workspace table).
 *
 * The table is not read before authentication, so it does not take the NOT-FORCE exception. tools/check-rls-coverage.ts
 * finds it through organisation_id. Self-check before commit (rolled back on any difference): owner, RLS, ACL, column ACL,
 * policies, triggers and the guard function, then secureOwnerInvariantViolations() empty. down() refuses while any
 * adjustment row exists (financial record, A11 retention).
 */
export class PayrollAdjustmentSchema1786723100000 implements MigrationInterface {
  name = 'PayrollAdjustmentSchema1786723100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    this.assertInTransaction(queryRunner, 'up');
    await this.pinSearchPath(queryRunner);
    await this.preflight(queryRunner, 'up');
    await queryRunner.query(PAYROLL_ADJUSTMENT_TABLE_SQL);
    for (const sql of PAYROLL_ADJUSTMENT_SECURITY_SQL) await queryRunner.query(sql);
    await withCrewflowCoreCreate(queryRunner, async () => {
      for (const sql of PAYROLL_ADJUSTMENT_OWNERSHIP_SQL) await queryRunner.query(sql);
    });

    const tables = (await queryRunner.query(PAYROLL_ADJUSTMENT_STATE_SQL)) as PayrollAdjustmentTableState[];
    const functions = (await queryRunner.query(PAYROLL_ADJUSTMENT_FUNCTION_STATE_SQL)) as Array<{ name: string; state: string }>;
    const problems = payrollAdjustmentStateProblems(tables, functions);
    if (problems.length) throw new Error(`${this.name}: unexpected state after create (rolled back):\n  ${problems.join('\n  ')}`);

    const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
    if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    this.assertInTransaction(queryRunner, 'down');
    await this.pinSearchPath(queryRunner);
    await this.preflight(queryRunner, 'down');
    // Retention: never drop recorded pay adjustments. The count needs NO FORCE (a migration binds no tenant); a refusal rolls back.
    for (const sql of PAYROLL_ADJUSTMENT_DOWN_UNFORCE_SQL) await queryRunner.query(sql);
    const [{ n }] = (await queryRunner.query(PAYROLL_ADJUSTMENT_ROWS_SQL)) as Array<{ n: number }>;
    if (Number(n) !== 0) throw new Error(`${this.name}: refusing down(): core.payroll_adjustment / core.payroll_run_event hold ${n} row(s). Nothing was dropped.`);
    for (const sql of PAYROLL_ADJUSTMENT_DOWN_SQL) await queryRunner.query(sql);
  }

  /** Every statement (the set_config(..., true) pin, NO FORCE in down(), the post-condition) relies on ONE transaction. */
  private assertInTransaction(queryRunner: QueryRunner, direction: 'up' | 'down'): void {
    if (!queryRunner.isTransactionActive) {
      throw new Error(`${this.name}: refusing to run ${direction} outside a transaction (transaction = false is never allowed here).`);
    }
  }

  /** Same as Phase 0b: this transaction resolves names in pg_catalog only; every object named here is schema-qualified. */
  private async pinSearchPath(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
  }

  private async preflight(queryRunner: QueryRunner, direction: 'up' | 'down'): Promise<void> {
    const [f] = (await queryRunner.query(PAYROLL_ADJUSTMENT_PREFLIGHT_SQL)) as Array<{
      table_present: boolean;
      event_present: boolean;
      guard_present: boolean;
      insert_guard_present: boolean;
      event_guard_present: boolean;
      core_staff_profile: boolean;
      parity_guard: boolean;
      tenant_functions: boolean;
      manager_archived_at: boolean;
      workspace_key: boolean;
      roles: number;
    }>;
    const problems: string[] = [];
    if (!f) problems.push('cannot read the catalog');
    else {
      if (Number(f.roles) !== 2) problems.push('the roles crewflow and crewflow_app must exist');
      if (!f.parity_guard) problems.push('core.owner_login_grant_parity_guard() must exist (OwnerLoginGrantParityGuards1786721420000 first)');
      if (!f.tenant_functions) problems.push('core.current_org(), core.current_workspace() and core.current_uid() must exist');
      if (!f.manager_archived_at) problems.push('core.manager_profile.archived_at must exist (ArchiveAndSearchSchema1786719920000 first)');
      if (!f.workspace_key) problems.push('core.manager_workspace must have a UNIQUE (id, organisation_id) key (the tenant FK target)');
      if (!f.core_staff_profile) problems.push('core.staff_profile must exist (the insert guard resolves the staff user)');
      const present = [f.table_present, f.event_present, f.guard_present, f.insert_guard_present, f.event_guard_present];
      if (direction === 'up' && present.some(Boolean)) problems.push('a payroll adjustment table or guard function already exists');
      if (direction === 'down' && !present.every(Boolean)) problems.push('a payroll adjustment table or guard function does not exist');
    }
    if (problems.length) throw new Error(`${this.name}: refusing to run ${direction}: ${problems.join('; ')}.`);
  }
}
