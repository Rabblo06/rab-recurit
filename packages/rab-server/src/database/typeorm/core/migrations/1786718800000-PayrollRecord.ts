import { MigrationInterface, QueryRunner } from 'typeorm';
import { payrollRecordSql } from '../../workspace-schema/v1/payroll-record';

/**
 * Payroll approval (owner rule 2026-10-20): one `payroll_record` per finalised attendance, approved or rejected by a
 * workspace manager holding `payroll.approve`; staff History shows a shift only once its record is approved. See
 * `payrollRecordSql` for the table, the four-layer RLS and the column-limited runtime grants.
 *
 * Additive only: one new RLS-forced table in core and in every provisioned workspace schema (the provisioner applies
 * the same SQL; V1_EXPECTED 17 tables / 103 FKs / 78 indexes / 27 policies). No existing row is changed. There is no
 * back-fill: reports finalised before this migration get no payroll record, so their shifts stay out of staff History
 * until an owner-approved back-fill (flagged, not invented here).
 */
export class PayrollRecord1786718800000 implements MigrationInterface {
  name = 'PayrollRecord1786718800000';

  private async schemas(runner: QueryRunner): Promise<string[]> {
    const rows: Array<{ schema_name: string }> = await runner.query(`
      SELECT n.nspname AS schema_name FROM pg_namespace n
      JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = 'attendance' AND c.relkind = 'r'
      WHERE n.nspname = 'core' OR n.nspname ~ '^workspace_[0-9a-f]{32}$'
    `);
    return rows.map((row) => row.schema_name);
  }

  async up(runner: QueryRunner): Promise<void> {
    for (const schema of await this.schemas(runner)) await runner.query(payrollRecordSql(schema));
  }

  /** Drops the table. Payroll decisions are lost (the audit_log rows remain) — down is for a failed rollout only. */
  async down(runner: QueryRunner): Promise<void> {
    for (const schema of await this.schemas(runner)) {
      const q = schema === 'core' ? 'core' : `"${schema}"`;
      await runner.query(`DROP TABLE IF EXISTS ${q}.payroll_record;`);
    }
  }
}
