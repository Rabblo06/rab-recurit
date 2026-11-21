import { MigrationInterface, QueryRunner } from 'typeorm';

import { withCrewflowCoreCreate } from '../core-schema-create-scope';
import {
  HOLIDAY_PAY_DOWN_SQL,
  HOLIDAY_PAY_DOWN_UNFORCE_SQL,
  HOLIDAY_PAY_OWNERSHIP_SQL,
  HOLIDAY_PAY_PREFLIGHT_SQL,
  HOLIDAY_PAY_ROWS_SQL,
  HOLIDAY_PAY_SECURITY_SQL,
  HOLIDAY_PAY_STATE_SQL,
  HOLIDAY_PAY_TABLES_SQL,
  HolidayPayTableState,
  holidayPayStateProblems,
} from '../payroll-holiday-pay-sql';
import { secureOwnerInvariantViolations } from '../secure-owner-invariants';

/**
 * Lane P2 (milestone M5, owner decision 4, assumption A3; DRAFT: owner SQL review FIRST, run only on throwaway databases
 * until approved): rolled-up holiday pay. Creates core.organisation_payroll_setting (the per-organisation choice: rolled-up
 * at a rate, default 12.07%, or "our payroll provider handles it") and core.payroll_record_holiday_pay (the insert-only
 * snapshot taken when a payroll record is approved), each with ENABLE + FORCE ROW LEVEL SECURITY, USING / WITH CHECK
 * policies, grants and grant-parity triggers in THIS migration (CLAUDE.md). Exact SQL and reasoning:
 * ../payroll-holiday-pay-sql.ts.
 *
 * Neither table is read before authentication (no NOT-FORCE exception). Self-check before commit (rolled back on any
 * difference), then secureOwnerInvariantViolations() empty. down() refuses while any row exists (payroll record retention).
 */
export class PayrollHolidayPay1786723110000 implements MigrationInterface {
  name = 'PayrollHolidayPay1786723110000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    this.assertInTransaction(queryRunner, 'up');
    await this.pinSearchPath(queryRunner);
    await this.preflight(queryRunner, 'up');
    await queryRunner.query(HOLIDAY_PAY_TABLES_SQL);
    for (const sql of HOLIDAY_PAY_SECURITY_SQL) await queryRunner.query(sql);
    await withCrewflowCoreCreate(queryRunner, async () => {
      for (const sql of HOLIDAY_PAY_OWNERSHIP_SQL) await queryRunner.query(sql);
    });
    const problems = holidayPayStateProblems((await queryRunner.query(HOLIDAY_PAY_STATE_SQL)) as HolidayPayTableState[]);
    if (problems.length) throw new Error(`${this.name}: unexpected state after create (rolled back):\n  ${problems.join('\n  ')}`);
    const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
    if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    this.assertInTransaction(queryRunner, 'down');
    await this.pinSearchPath(queryRunner);
    await this.preflight(queryRunner, 'down');
    for (const sql of HOLIDAY_PAY_DOWN_UNFORCE_SQL) await queryRunner.query(sql);
    const [{ n }] = (await queryRunner.query(HOLIDAY_PAY_ROWS_SQL)) as Array<{ n: number }>;
    if (Number(n) !== 0) throw new Error(`${this.name}: refusing down(): the holiday pay tables hold ${n} row(s). Nothing was dropped.`);
    for (const sql of HOLIDAY_PAY_DOWN_SQL) await queryRunner.query(sql);
  }

  private assertInTransaction(queryRunner: QueryRunner, direction: 'up' | 'down'): void {
    if (!queryRunner.isTransactionActive) {
      throw new Error(`${this.name}: refusing to run ${direction} outside a transaction (transaction = false is never allowed here).`);
    }
  }

  private async pinSearchPath(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
  }

  private async preflight(queryRunner: QueryRunner, direction: 'up' | 'down'): Promise<void> {
    const [f] = (await queryRunner.query(HOLIDAY_PAY_PREFLIGHT_SQL)) as Array<{
      setting_present: boolean;
      snapshot_present: boolean;
      parity_guard: boolean;
      tenant_functions: boolean;
      manager_columns: number;
      roles: number;
    }>;
    const problems: string[] = [];
    if (!f) problems.push('cannot read the catalog');
    else {
      if (Number(f.roles) !== 2) problems.push('the roles crewflow and crewflow_app must exist');
      if (!f.parity_guard) problems.push('core.owner_login_grant_parity_guard() must exist (OwnerLoginGrantParityGuards1786721420000 first)');
      if (!f.tenant_functions) problems.push('core.current_org(), core.current_workspace() and core.current_uid() must exist');
      if (Number(f.manager_columns) !== 3) problems.push('core.manager_profile must have archived_at, is_initial_manager and superseded_at');
      if (direction === 'up' && (f.setting_present || f.snapshot_present)) problems.push('a holiday pay table already exists');
      if (direction === 'down' && !(f.setting_present && f.snapshot_present)) problems.push('a holiday pay table does not exist');
    }
    if (problems.length) throw new Error(`${this.name}: refusing to run ${direction}: ${problems.join('; ')}.`);
  }
}
