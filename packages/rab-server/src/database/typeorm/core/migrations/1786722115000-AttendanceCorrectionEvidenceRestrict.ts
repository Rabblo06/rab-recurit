import { MigrationInterface, QueryRunner } from 'typeorm';

import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import { BOOTSTRAP_IDENTITY_SQL, BootstrapIdentityFacts, bootstrapIdentityProblems } from '../worker-dispatch-pointer-sql';
import {
  CORE_CORRECTION_FK_STATE_SQL,
  CorrectionFkRow,
  correctionAttendanceFkSql,
  correctionFkProblems,
} from '../../workspace-schema/attendance-correction-evidence-restrict-sql';

/**
 * DRAFT — NEW SQL, owner SQL review FIRST (security review of #306, Medium; tied to OWNER DECISION 46, the pay-evidence
 * principle approved for attendance_break and attendance_sync_receipt in DESIGN §A.7). Runs after
 * AttendanceCorrectionInsertOnly1786722110000.
 *
 * core.attendance_correction.attendance_id: ON DELETE CASCADE → ON DELETE RESTRICT. Before: the insert-only triggers stopped
 * every direct UPDATE / DELETE / TRUNCATE by the runtime, but deleting the parent attendance (core.attendance has a FOR ALL
 * policy and no delete guard) cascaded the corrections away, because the FK action runs as the table owner and the guard lets
 * the owner through. After: such a delete fails (23503 / 23001) and the correction stays. No code path deletes attendance
 * today; a hard user delete that would reach it already falls back to a soft delete on a foreign-key refusal
 * (UserDeletionService.hardDeleteFallbackReason). The organisation FK (tenant offboarding) is not changed (LC-2).
 *
 * The workspace-schema copies get the same change with the 0.7.0 workspace command for attendance_correction (level 26).
 * In ONE transaction: the constraint must be the expected CASCADE one (or already RESTRICT on a re-run, then nothing is done),
 * the ALTER, the end state checked, then the secure-owner invariants. down(): back to CASCADE (same checks).
 */
export class AttendanceCorrectionEvidenceRestrict1786722115000 implements MigrationInterface {
  name = 'AttendanceCorrectionEvidenceRestrict1786722115000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.inTransaction(queryRunner, () => this.move(queryRunner, 'c', 'r'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.inTransaction(queryRunner, () => this.move(queryRunner, 'r', 'c'));
  }

  private async move(queryRunner: QueryRunner, from: 'r' | 'c', to: 'r' | 'c'): Promise<void> {
    const [before] = (await queryRunner.query(CORE_CORRECTION_FK_STATE_SQL)) as CorrectionFkRow[];
    if (correctionFkProblems(before, to).length === 0) return; // already there (re-run)
    const problems = correctionFkProblems(before, from);
    if (problems.length) throw new Error(`${this.name}: refusing: unexpected constraint before the change (nothing changed):\n  ${problems.join('\n  ')}`);
    await queryRunner.query(correctionAttendanceFkSql('core', to === 'r' ? 'RESTRICT' : 'CASCADE'));
    const [after] = (await queryRunner.query(CORE_CORRECTION_FK_STATE_SQL)) as CorrectionFkRow[];
    const left = correctionFkProblems(after, to);
    if (left.length) throw new Error(`${this.name}: unexpected constraint after the change (rolled back):\n  ${left.join('\n  ')}`);
    const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
    if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
  }

  private async inTransaction(queryRunner: QueryRunner, body: () => Promise<void>): Promise<void> {
    const outer = queryRunner.isTransactionActive;
    if (!outer) await queryRunner.query('BEGIN');
    try {
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
