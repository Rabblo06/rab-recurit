import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Waves 4+5 lane DB5 — timeline read-model index on the insert-only `core.audit_log` (CREWFLOW_TWENTY_FULL_ENGINE_PARITY_
 * REPORT.md §3.15) for the DATA lane's `GET /<entity>/:id/timeline`. Dev/test only: NOT in production-migration-approval.ts.
 * Contract: docs/evidence/w45-db5/CONTRACT.md §6.
 *
 * `transaction = false` so the index is built with CREATE INDEX CONCURRENTLY (the runner uses
 * migrationsTransactionMode 'each', which honours a per-migration `transaction = false`): writers to audit_log — every
 * audited action in the product — are never blocked by the build. The new index
 * `(organisation_id, entity_type, entity_id, created_at DESC, id DESC) WHERE entity_id IS NOT NULL` serves a keyset-paged
 * timeline; the old `audit_log_entity_idx (organisation_id, entity_type, entity_id) WHERE entity_id IS NOT NULL` is a strict
 * prefix of it and is dropped (DROP INDEX CONCURRENTLY) only after the new one is proven VALID.
 *
 * Failure handling: a CONCURRENTLY build that fails leaves an INVALID index behind; a re-run detects it, drops it
 * (concurrently) and rebuilds. Columns are `entity_type` / `entity_id` (there is no target_type / target_id).
 *
 * TypeORM limitation: `migration:revert` (undoLastMigration) always opens a transaction, ignoring `transaction = false`,
 * and CONCURRENTLY cannot run inside one. When a transaction is already active, both directions fall back to the plain
 * (locking) CREATE / DROP INDEX — correct, but it blocks audit_log writes for the build; prefer
 * `migration:revert -t none` on a busy database.
 */
const NEW_INDEX = 'audit_log_timeline_idx';
const OLD_INDEX = 'audit_log_entity_idx';

export class AuditLogTimelineIndex1786719950000 implements MigrationInterface {
  name = 'AuditLogTimelineIndex1786719950000';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.assertAuthority(queryRunner);
    const cc = queryRunner.isTransactionActive ? '' : 'CONCURRENTLY ';
    await queryRunner.query(`SET lock_timeout = '60s'`);
    try {
      if ((await this.state(queryRunner, NEW_INDEX)) === 'INVALID') {
        await queryRunner.query(`DROP INDEX ${cc}IF EXISTS core.${NEW_INDEX}`);
      }
      if ((await this.state(queryRunner, NEW_INDEX)) === 'ABSENT') {
        await queryRunner.query(
          `CREATE INDEX ${cc}${NEW_INDEX} ON core.audit_log (organisation_id, entity_type, entity_id, created_at DESC, id DESC) WHERE entity_id IS NOT NULL`,
        );
      }
      if ((await this.state(queryRunner, NEW_INDEX)) !== 'VALID') {
        throw new Error(`${this.name}: ${NEW_INDEX} is not valid after the build; refusing to drop ${OLD_INDEX}`);
      }
      await queryRunner.query(`DROP INDEX ${cc}IF EXISTS core.${OLD_INDEX}`);
    } finally {
      await queryRunner.query('RESET lock_timeout');
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.assertAuthority(queryRunner);
    const cc = queryRunner.isTransactionActive ? '' : 'CONCURRENTLY ';
    await queryRunner.query(`SET lock_timeout = '60s'`);
    try {
      if ((await this.state(queryRunner, OLD_INDEX)) === 'INVALID') await queryRunner.query(`DROP INDEX ${cc}IF EXISTS core.${OLD_INDEX}`);
      if ((await this.state(queryRunner, OLD_INDEX)) === 'ABSENT') {
        await queryRunner.query(
          `CREATE INDEX ${cc}${OLD_INDEX} ON core.audit_log (organisation_id, entity_type, entity_id) WHERE entity_id IS NOT NULL`,
        );
      }
      if ((await this.state(queryRunner, OLD_INDEX)) !== 'VALID') throw new Error(`${this.name}: ${OLD_INDEX} is not valid; refusing to drop ${NEW_INDEX}`);
      await queryRunner.query(`DROP INDEX ${cc}IF EXISTS core.${NEW_INDEX}`);
    } finally {
      await queryRunner.query('RESET lock_timeout');
    }
  }

  private async state(queryRunner: QueryRunner, index: string): Promise<'ABSENT' | 'VALID' | 'INVALID'> {
    const rows: Array<{ valid: boolean; ready: boolean }> = await queryRunner.query(
      `SELECT i.indisvalid AS valid, i.indisready AS ready FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'core' AND c.relname = $1`,
      [index],
    );
    if (rows.length === 0) return 'ABSENT';
    return rows[0]!.valid && rows[0]!.ready ? 'VALID' : 'INVALID';
  }

  private async assertAuthority(queryRunner: QueryRunner): Promise<void> {
    const [{ ok }] = await queryRunner.query(`SELECT pg_has_role(current_user, 'crewflow', 'USAGE') AS ok`);
    if (!ok) throw new Error(`${this.name} must run as crewflow or the bootstrap identity (core.audit_log owner)`);
  }
}
