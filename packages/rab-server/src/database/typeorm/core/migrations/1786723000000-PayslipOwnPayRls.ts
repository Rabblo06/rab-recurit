import { MigrationInterface, QueryRunner } from 'typeorm';

import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import { BOOTSTRAP_IDENTITY_SQL, BootstrapIdentityFacts, bootstrapIdentityProblems } from '../worker-dispatch-pointer-sql';
import { corePolicyStateSql, PAYSLIP_OWN_PAY_HASHES, payslipDocumentInsertCheckSql, payslipUpdateCheckSql } from '../../workspace-schema/payslip-own-pay-rls-sql';

interface PolicyStep {
  label: string;
  stateSql: string;
  cmd: 'w' | 'a';
  /** USING hash, unchanged by this migration (null for an INSERT policy). */
  usingHash: string | null;
  checkBefore: string;
  checkAfter: string;
  upSql: string;
  downSql: string;
}

/**
 * DRAFT — NEW SQL, owner SQL review FIRST (owner decision 51, 2026-11-21: "apply the same own-pay refusal to upload and
 * set-net"). The database layer of PayrollRunService's own-pay refusals, on the core copies every request uses while HWS is
 * off (production today):
 *  1. `ALTER POLICY payslip_update ON core.payslip WITH CHECK (<old> AND NOT <the payslip's staff profile is the caller's>)`
 *     — covers upload's version bump, set/clear net pay and mark paid;
 *  2. `ALTER POLICY payslip_document_insert ON core.payslip_document WITH CHECK (<old> AND NOT <the document's payslip is the
 *     caller's>)` — covers the document row of an upload.
 * USING is never changed (a refused write raises 42501 instead of silently updating nothing). Each new expression is the old
 * one plus ONE conjunct, so it can only narrow. Expressions: payslip-own-pay-rls-sql.ts. The workspace-schema copies (HWS on)
 * get the same predicates from a 0.7.0 workspace command once the 0.7.0 release chain is on main.
 *
 * In ONE transaction, per policy: only a known expression pair is replaced (semantic-golden hashes, before or after on a
 * re-run), PERMISSIVE / command / TO PUBLIC checked before and after; then the secure-owner invariants. No table, grant,
 * function, trigger or data change; the policy count is unchanged. down(): both old expressions back (same checks).
 */
export class PayslipOwnPayRls1786723000000 implements MigrationInterface {
  name = 'PayslipOwnPayRls1786723000000';

  private readonly steps: readonly PolicyStep[] = [
    {
      label: "core.payslip's payslip_update",
      stateSql: corePolicyStateSql('payslip', 'payslip_update'),
      cmd: 'w',
      usingHash: PAYSLIP_OWN_PAY_HASHES.updateUsing,
      checkBefore: PAYSLIP_OWN_PAY_HASHES.updateCheckBefore,
      checkAfter: PAYSLIP_OWN_PAY_HASHES.updateCheckAfter,
      upSql: `ALTER POLICY payslip_update ON core.payslip WITH CHECK ${payslipUpdateCheckSql('core', true)}`,
      downSql: `ALTER POLICY payslip_update ON core.payslip WITH CHECK ${payslipUpdateCheckSql('core', false)}`,
    },
    {
      label: "core.payslip_document's payslip_document_insert",
      stateSql: corePolicyStateSql('payslip_document', 'payslip_document_insert'),
      cmd: 'a',
      usingHash: null,
      checkBefore: PAYSLIP_OWN_PAY_HASHES.documentInsertCheckBefore,
      checkAfter: PAYSLIP_OWN_PAY_HASHES.documentInsertCheckAfter,
      upSql: `ALTER POLICY payslip_document_insert ON core.payslip_document WITH CHECK ${payslipDocumentInsertCheckSql('core', true)}`,
      downSql: `ALTER POLICY payslip_document_insert ON core.payslip_document WITH CHECK ${payslipDocumentInsertCheckSql('core', false)}`,
    },
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.inTransaction(queryRunner, async () => {
      for (const step of this.steps) await this.alterCorePolicy(queryRunner, step, 'up');
      const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
      if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.inTransaction(queryRunner, async () => {
      for (const step of [...this.steps].reverse()) await this.alterCorePolicy(queryRunner, step, 'down');
    });
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

  /** Only a known WITH CHECK expression is replaced; USING and the policy's other properties must not move. */
  private async alterCorePolicy(queryRunner: QueryRunner, step: PolicyStep, direction: 'up' | 'down'): Promise<void> {
    const known = [step.checkBefore, step.checkAfter];
    const want = direction === 'up' ? step.checkAfter : step.checkBefore;
    const before = await this.corePolicy(queryRunner, step);
    if (!before.shapeOk || before.using !== step.usingHash || !before.check || !known.includes(before.check)) {
      throw new Error(
        `${this.name}: refusing to run ${direction}: ${step.label} is not a known policy (USING hash ${before.using ?? 'none'}, expected ` +
          `${step.usingHash ?? 'none'}; WITH CHECK hash ${before.check ?? 'none'}, expected one of ${known.join(', ')}; PERMISSIVE / command ${step.cmd} / ` +
          `TO PUBLIC: ${before.shapeOk}). Nothing was changed.`,
      );
    }
    await queryRunner.query(direction === 'up' ? step.upSql : step.downSql);
    const after = await this.corePolicy(queryRunner, step);
    if (!after.shapeOk || after.using !== step.usingHash || after.check !== want) {
      throw new Error(
        `${this.name}: ${step.label} after ${direction}: USING hash ${after.using ?? 'none'}, WITH CHECK hash ${after.check ?? 'none'} ` +
          `(expected ${want}), shape ${after.shapeOk} (rolled back).`,
      );
    }
  }

  private async corePolicy(queryRunner: QueryRunner, step: PolicyStep): Promise<{ using: string | null; check: string | null; shapeOk: boolean }> {
    const [p] = (await queryRunner.query(step.stateSql)) as Array<{ using_hash: string | null; check_hash: string | null; permissive: boolean; cmd: string; to_public: boolean }>;
    return { using: p?.using_hash ?? null, check: p?.check_hash ?? null, shapeOk: p?.permissive === true && p?.cmd === step.cmd && p?.to_public === true };
  }
}
