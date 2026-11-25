import { MigrationInterface, QueryRunner } from 'typeorm';

import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import { BOOTSTRAP_IDENTITY_SQL, BootstrapIdentityFacts, bootstrapIdentityProblems } from '../worker-dispatch-pointer-sql';
import {
  PAYROLL_MAKER_CHECKER_HASHES as H,
  PAYROLL_MAKER_CHECKER_STATE_SQL,
  PAYROLL_RECORD_GUARD_BODY_AFTER,
  PAYROLL_RECORD_GUARD_BODY_BEFORE,
  payrollRecordGuardSql,
} from '../../workspace-schema/payroll-maker-checker-sql';

/**
 * DRAFT — NEW SQL, owner SQL review FIRST (owner decision 5; independent reviews of #335). The database layer under the
 * services' maker-checker refusals: CREATE OR REPLACE core.payroll_record_guard() with the maker-checker block (see
 * payroll-maker-checker-sql.ts). One function serves the payroll_record trigger of core AND of every workspace schema, so
 * both copies are covered; owner, ACL and triggers are unchanged (CREATE OR REPLACE). No table, policy, grant or data change.
 * In ONE transaction, only from a known body (semantic-golden hash; the after-body on a re-run), re-checked after; then the
 * secure-owner invariants. down(): the 1786719200000 body back.
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
    const before = await this.bodyHash(queryRunner);
    if (before !== H.guardBodyBefore && before !== H.guardBodyAfter) {
      throw new Error(`${this.name}: refusing to run ${direction}: core.payroll_record_guard() has an unknown body (hash ${before ?? 'none'}). Nothing was changed.`);
    }
    const up = direction === 'up';
    await queryRunner.query(payrollRecordGuardSql(up ? PAYROLL_RECORD_GUARD_BODY_AFTER : PAYROLL_RECORD_GUARD_BODY_BEFORE));
    const after = await this.bodyHash(queryRunner);
    const want = up ? H.guardBodyAfter : H.guardBodyBefore;
    if (after !== want) throw new Error(`${this.name}: after ${direction}: body hash ${after ?? 'none'}, expected ${want} (rolled back).`);
  }

  private async bodyHash(queryRunner: QueryRunner): Promise<string | null> {
    const [row] = (await queryRunner.query(PAYROLL_MAKER_CHECKER_STATE_SQL)) as Array<{ guard_body_hash: string | null }>;
    return row?.guard_body_hash ?? null;
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
