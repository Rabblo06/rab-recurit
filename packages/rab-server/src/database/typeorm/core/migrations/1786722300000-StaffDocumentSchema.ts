import { MigrationInterface, QueryRunner } from 'typeorm';

import { withCrewflowCoreCreate } from '../core-schema-create-scope';
import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import {
  STAFF_DOCUMENT_DOWN_SQL,
  STAFF_DOCUMENT_DOWN_UNFORCE_SQL,
  STAFF_DOCUMENT_FUNCTION_STATE_SQL,
  STAFF_DOCUMENT_GUARD_FUNCTION_SQL,
  STAFF_DOCUMENT_OWNERSHIP_SQL,
  STAFF_DOCUMENT_ROWS_SQL,
  STAFF_DOCUMENT_SECURITY_SQL,
  STAFF_DOCUMENT_STATE_SQL,
  STAFF_DOCUMENT_TABLES_SQL,
  StaffDocumentTableState,
  staffDocumentStateProblems,
} from '../staff-document-sql';

/**
 * Lane D (milestone M1; DRAFT — owner SQL review FIRST, run only on throwaway databases until approved): staff documents with
 * an expiry. Creates core.staff_document and core.staff_document_requirement with ENABLE + FORCE ROW LEVEL SECURITY, their
 * policies (USING / WITH CHECK, tenant + a second staff-/manager-scoped predicate) and grants in THIS migration (CLAUDE.md),
 * the guard trigger function core.staff_document_guard(), and widens two CHECKs: core.stored_file.kind (+ STAFF_DOCUMENT) and
 * core.notification_preference.notification_type (+ staff_document_expiring). Exact SQL and reasoning: ../staff-document-sql.ts.
 *
 * Neither table is read before authentication, so neither takes the NOT-FORCE exception. tools/check-rls-coverage.ts finds
 * both through organisation_id. Self-check before commit (rolled back on any difference): owner, RLS, ACL, policies,
 * triggers and the function's posture, then secureOwnerInvariantViolations() empty. down() refuses while any document,
 * STAFF_DOCUMENT file row or staff_document_expiring preference exists (retention; the narrowed CHECKs would fail anyway).
 *
 * The three legacy columns on staff_profile (right_to_work_status, document_type, expiry_date) are NOT touched: they keep
 * working as before. Dropping them is a later, separate migration once no client writes them (owner decision).
 */
export class StaffDocumentSchema1786722300000 implements MigrationInterface {
  name = 'StaffDocumentSchema1786722300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    this.assertInTransaction(queryRunner, 'up');
    await this.pinSearchPath(queryRunner);
    await queryRunner.query(STAFF_DOCUMENT_TABLES_SQL);
    await queryRunner.query(STAFF_DOCUMENT_GUARD_FUNCTION_SQL);
    for (const sql of STAFF_DOCUMENT_SECURITY_SQL) await queryRunner.query(sql);
    await withCrewflowCoreCreate(queryRunner, async () => {
      for (const sql of STAFF_DOCUMENT_OWNERSHIP_SQL)
        await queryRunner.query(sql);
    });

    const rows = (await queryRunner.query(
      STAFF_DOCUMENT_STATE_SQL,
    )) as StaffDocumentTableState[];
    const [fn] = (await queryRunner.query(
      STAFF_DOCUMENT_FUNCTION_STATE_SQL,
    )) as Array<Record<string, unknown>>;
    const problems = staffDocumentStateProblems(rows, fn);
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
    for (const sql of STAFF_DOCUMENT_DOWN_UNFORCE_SQL)
      await queryRunner.query(sql);
    const [counts] = (await queryRunner.query(
      STAFF_DOCUMENT_ROWS_SQL,
    )) as Array<{
      document_rows: number;
      file_rows: number;
      preference_rows: number;
    }>;
    if (
      Number(counts?.document_rows) !== 0 ||
      Number(counts?.file_rows) !== 0 ||
      Number(counts?.preference_rows) !== 0
    ) {
      throw new Error(
        `${this.name}: refusing down(): staff document data exists (${JSON.stringify(counts)}). Nothing was dropped.`,
      );
    }
    for (const sql of STAFF_DOCUMENT_DOWN_SQL) await queryRunner.query(sql);
  }

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
}
