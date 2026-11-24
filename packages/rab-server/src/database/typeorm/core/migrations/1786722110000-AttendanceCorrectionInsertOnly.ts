import { MigrationInterface, QueryRunner } from 'typeorm';

import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import { BOOTSTRAP_IDENTITY_SQL, BootstrapIdentityFacts, bootstrapIdentityProblems } from '../worker-dispatch-pointer-sql';
import {
  CORE_CORRECTION_APP_GRANTS_SQL,
  CORE_CORRECTION_GUARD_STATE_SQL,
  CorrectionAppGrants,
  CorrectionGuardRow,
  coreCorrectionGuardProblems,
} from '../../workspace-schema/attendance-correction-insert-only-sql';
import {
  attendanceCorrectionInsertOnlyDownSql,
  attendanceCorrectionInsertOnlySql,
} from '../../../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-correction-insert-only';

/**
 * DRAFT — NEW SQL, owner SQL review FIRST (security finding S11 / architecture §5.7, owner decision 2026-11-21).
 * core.attendance_correction (the copy every request uses while HWS is off) becomes insert-only in the database: three
 * statement-level BEFORE UPDATE / DELETE / TRUNCATE triggers calling the existing, unchanged core.owner_login_grant_parity_guard().
 * The runtime login (crewflow_owner) gets 42501 for any such statement, even one that RLS leaves with no row; definers,
 * foreign-key actions (table owner) and superusers pass. crewflow_app's (cosmetic) UPDATE / DELETE grant is revoked together
 * with the workspace copies, in one release: tools/check-rls-coverage.ts requires workspace grants to equal core's.
 * Statements and reasoning: upgrade-commands/0-7/attendance-correction-insert-only.ts. The workspace-schema copies (HWS on)
 * follow with a 0.7.0 workspace command once the 0.7.0 release chain (#175 / #177 / #243) is on main.
 *
 * In ONE transaction, then the end state is checked (the three triggers with their tgtype and function; crewflow_app keeps
 * SELECT and INSERT) and the secure-owner invariants. No table, column, policy, grant or data change.
 * down(): drops the three triggers (the state before).
 */
export class AttendanceCorrectionInsertOnly1786722110000 implements MigrationInterface {
  name = 'AttendanceCorrectionInsertOnly1786722110000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.inTransaction(queryRunner, async () => {
      const [g] = (await queryRunner.query(`SELECT pg_catalog.to_regprocedure('core.owner_login_grant_parity_guard()') IS NOT NULL AS guard`)) as Array<{ guard: boolean }>;
      if (!g?.guard) throw new Error(`${this.name}: core.owner_login_grant_parity_guard() does not exist (OwnerLoginGrantParityGuards1786721420000 first); refusing.`);
      await queryRunner.query(attendanceCorrectionInsertOnlySql('core'));
      const rows = (await queryRunner.query(CORE_CORRECTION_GUARD_STATE_SQL)) as CorrectionGuardRow[];
      const [grants] = (await queryRunner.query(CORE_CORRECTION_APP_GRANTS_SQL)) as CorrectionAppGrants[];
      const problems = coreCorrectionGuardProblems(rows, grants);
      if (problems.length) throw new Error(`${this.name}: unexpected state after up() (rolled back):\n  ${problems.join('\n  ')}`);
      const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
      if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.inTransaction(queryRunner, async () => {
      await queryRunner.query(attendanceCorrectionInsertOnlyDownSql('core'));
      const rows = (await queryRunner.query(CORE_CORRECTION_GUARD_STATE_SQL)) as CorrectionGuardRow[];
      if (rows.length) throw new Error(`${this.name}: ${rows.length} guard trigger(s) still present after down() (rolled back).`);
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
}
