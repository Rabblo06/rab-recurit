import { MigrationInterface, QueryRunner } from 'typeorm';
import { shiftReviewSignoffSql } from '../../workspace-schema/v1/shift-review-signoff';

/**
 * Venue Manager timesheet sign-off evidence + per-shift staff reviews (owner brief 2026-10-17). See `shiftReviewSignoffSql`.
 * Additive only: two nullable `shift_report` columns (no back-fill — older finalisations keep no typed sign-off) and one
 * new RLS-forced table. No existing row is changed or deleted. Applied to core and every provisioned workspace schema.
 */
export class ShiftReviewSignoff1786718300000 implements MigrationInterface {
  name = 'ShiftReviewSignoff1786718300000';

  private async schemas(runner: QueryRunner): Promise<string[]> {
    const rows: Array<{ schema_name: string }> = await runner.query(`
      SELECT n.nspname AS schema_name FROM pg_namespace n
      JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = 'shift_report' AND c.relkind = 'r'
      WHERE n.nspname = 'core' OR n.nspname ~ '^workspace_[0-9a-f]{32}$'
    `);
    return rows.map((row) => row.schema_name);
  }

  async up(runner: QueryRunner): Promise<void> {
    for (const schema of await this.schemas(runner)) await runner.query(shiftReviewSignoffSql(schema));
  }

  /** Drops the review table (reviews are lost — down is for a failed rollout only). The sign-off columns are kept: dropping them would erase evidence. */
  async down(runner: QueryRunner): Promise<void> {
    for (const schema of await this.schemas(runner)) {
      const q = schema === 'core' ? 'core' : `"${schema}"`;
      await runner.query(`DROP TABLE IF EXISTS ${q}.shift_staff_review;`);
    }
  }
}
