import { MigrationInterface, QueryRunner } from 'typeorm';

import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import { BOOTSTRAP_IDENTITY_SQL, BootstrapIdentityFacts, bootstrapIdentityProblems } from '../worker-dispatch-pointer-sql';
import {
  PAYROLL_MAKER_CHECKER_HASHES as H,
  PAYROLL_MAKER_CHECKER_STATE_SQL,
  PAYROLL_RECORD_GUARD_BODY_AFTER,
  PAYROLL_RECORD_GUARD_BODY_BEFORE,
  payrollRecordGuardSql,
  payrollRunUpdatePolicySql,
} from '../../workspace-schema/payroll-maker-checker-sql';

interface State {
  guard_body_hash: string | null;
  run_using_hash: string | null;
  run_check_hash: string | null;
}

/**
 * DRAFT — NEW SQL, owner SQL review FIRST (owner decision 5; independent review of #335, MEDIUM). The database layer under
 * PayrollService / PayrollRunService's maker-checker refusals:
 *  1. CREATE OR REPLACE core.payroll_record_guard(): when `approved_by` is set or changed, refuse (42501) an approver who
 *     finalised the record's shift report or reviewed its attendance. One function serves core AND every workspace schema's
 *     payroll_record trigger, so both copies are covered now. Owner, ACL and triggers are unchanged (CREATE OR REPLACE).
 *  2. ALTER POLICY payroll_run_update ON core.payroll_run WITH CHECK (<old> AND (status <> 'finalised' OR finalised_by <>
 *     prepared_by)). The workspace copies need a 0.7.0 structure level.
 * In ONE transaction, only from a known state (semantic-golden hashes; the after-state on a re-run), re-checked after; then
 * the secure-owner invariants. down(): the 1786719200000 body and expression back.
 */
export class PayrollMakerCheckerBackstop1786723020000 implements MigrationInterface {
  name = 'PayrollMakerCheckerBackstop1786723020000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.inTransaction(queryRunner, async () => {
      await this.apply(queryRunner, 'up');
      const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
      if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.inTransaction(queryRunner, () => this.apply(queryRunner, 'down'));
  }

  private async apply(queryRunner: QueryRunner, direction: 'up' | 'down'): Promise<void> {
    const before = await this.state(queryRunner);
    const known = (v: string | null, a: string, b: string) => v === a || v === b;
    if (!known(before.guard_body_hash, H.guardBodyBefore, H.guardBodyAfter) || before.run_using_hash !== H.runUsing || !known(before.run_check_hash, H.runCheckBefore, H.runCheckAfter)) {
      throw new Error(`${this.name}: refusing to run ${direction}: unknown state ${JSON.stringify(before)}. Nothing was changed.`);
    }
    const up = direction === 'up';
    await queryRunner.query(payrollRecordGuardSql(up ? PAYROLL_RECORD_GUARD_BODY_AFTER : PAYROLL_RECORD_GUARD_BODY_BEFORE));
    await queryRunner.query(payrollRunUpdatePolicySql(up));
    const after = await this.state(queryRunner);
    const want = { guard_body_hash: up ? H.guardBodyAfter : H.guardBodyBefore, run_using_hash: H.runUsing, run_check_hash: up ? H.runCheckAfter : H.runCheckBefore };
    if (JSON.stringify(after) !== JSON.stringify(want)) {
      throw new Error(`${this.name}: after ${direction}: ${JSON.stringify(after)}, expected ${JSON.stringify(want)} (rolled back).`);
    }
  }

  private async state(queryRunner: QueryRunner): Promise<State> {
    const [row] = (await queryRunner.query(PAYROLL_MAKER_CHECKER_STATE_SQL)) as State[];
    return { guard_body_hash: row?.guard_body_hash ?? null, run_using_hash: row?.run_using_hash ?? null, run_check_hash: row?.run_check_hash ?? null };
  }

  private async inTransaction(queryRunner: QueryRunner, body: () => Promise<void>): Promise<void> {
    const outer = queryRunner.isTransactionActive;
    if (!outer) await queryRunner.query('BEGIN');
    try {
      // This session resolves names in pg_catalog only; every object named here is core-qualified.
      await queryRunner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
      const [f] = (await queryRunner.query(BOOTSTRAP_IDENTITY_SQL)) as BootstrapIdentityFacts[];
      const problems = bootstrapIdentityProblems(f);
      if (problems.length) throw new Error(`${this.name}: refusing to run as ${f?.who ?? 'unknown'}: ${problems.join('; ')}.`);
      await body();
      if (!outer) await queryRunner.query('COMMIT');
    } catch (error) {
      if (!outer) await queryRunner.query('ROLLBACK');
      throw error;
    }
  }
}
