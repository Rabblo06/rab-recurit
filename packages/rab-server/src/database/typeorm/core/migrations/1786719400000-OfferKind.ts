import { MigrationInterface, QueryRunner } from 'typeorm';
import { offerKindSql } from '../../workspace-schema/v1/offer-kind';

/**
 * Replacement & standby offers on the original shift (see `offerKindSql`). Additive: one NOT NULL column with a constant
 * DEFAULT (metadata-only on PostgreSQL 11+, no table rewrite) and a value CHECK on job_offer, in core and every
 * provisioned workspace schema. Existing rows read as 'standard'. No RLS/grant/policy change.
 */
export class OfferKind1786719400000 implements MigrationInterface {
  name = 'OfferKind1786719400000';

  private async schemas(runner: QueryRunner): Promise<string[]> {
    const rows: Array<{ schema_name: string }> = await runner.query(`
      SELECT n.nspname AS schema_name FROM pg_namespace n
      JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = 'job_offer' AND c.relkind = 'r'
      WHERE n.nspname = 'core' OR n.nspname ~ '^workspace_[0-9a-f]{32}$'
    `);
    return rows.map((row) => row.schema_name);
  }

  async up(runner: QueryRunner): Promise<void> {
    for (const schema of await this.schemas(runner)) await runner.query(offerKindSql(schema));
  }

  /** Drops the column (every offer's kind is lost — down is for a failed rollout only). */
  async down(runner: QueryRunner): Promise<void> {
    for (const schema of await this.schemas(runner)) {
      const t = `${schema === 'core' ? 'core' : `"${schema}"`}.job_offer`;
      await runner.query(`ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS job_offer_offer_kind_check, DROP COLUMN IF EXISTS offer_kind;`);
    }
  }
}
