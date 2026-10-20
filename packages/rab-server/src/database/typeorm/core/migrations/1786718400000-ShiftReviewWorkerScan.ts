import { MigrationInterface, QueryRunner } from 'typeorm';
import { shiftReviewWorkerScanSql } from '../../workspace-schema/v1/shift-review-worker-scan';

/**
 * Lets the final-timesheet worker read per-shift staff reviews for the final PDF (see `shiftReviewWorkerScanSql`):
 * one SELECT-only policy for the worker actor, tenant-bound, mirroring `staff_profile_worker_scan`. No data changes.
 * Applied to core and every provisioned workspace schema that has the table.
 */
export class ShiftReviewWorkerScan1786718400000 implements MigrationInterface {
  name = 'ShiftReviewWorkerScan1786718400000';

  private async schemas(runner: QueryRunner): Promise<string[]> {
    const rows: Array<{ schema_name: string }> = await runner.query(`
      SELECT n.nspname AS schema_name FROM pg_namespace n
      JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = 'shift_staff_review' AND c.relkind = 'r'
      WHERE n.nspname = 'core' OR n.nspname ~ '^workspace_[0-9a-f]{32}$'
    `);
    return rows.map((row) => row.schema_name);
  }

  async up(runner: QueryRunner): Promise<void> {
    for (const schema of await this.schemas(runner)) await runner.query(shiftReviewWorkerScanSql(schema));
  }

  async down(runner: QueryRunner): Promise<void> {
    for (const schema of await this.schemas(runner)) {
      await runner.query(`DROP POLICY IF EXISTS shift_staff_review_worker_scan ON ${schema === 'core' ? 'core' : `"${schema}"`}.shift_staff_review;`);
    }
  }
}
