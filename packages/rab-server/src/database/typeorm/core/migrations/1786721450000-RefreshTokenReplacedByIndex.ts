import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Index fix IDX-B (owner-approved 2026-11-06; docs/plans/index-fix/current/PROPOSAL.md §3): two foreign keys whose
 * referential checks scanned a whole table.
 *
 *  - refresh_token_replaced_by_idx: `refresh_token.replaced_by → refresh_token(id)` (NO ACTION) had no index, so EVERY
 *    deleted refresh token seq-scanned refresh_token to check that nothing references it. Measured as rab_secure_owner inside
 *    core.worker_cleanup_auth_tokens: 1,000 deletions took 14.8 s, 14.76 s of it in `refresh_token_replaced_by_fkey` (200k
 *    rows); a user hard delete paid it once per cascaded token. Partial: only rotated tokens have replaced_by.
 *  - login_history_user_id_idx: `login_history.user_id → user(id)` (SET NULL) had no index; login_history is append-only and
 *    never purged, the largest scan of a user hard delete.
 *
 * Both tables are pre-auth tables owned by rab_secure_owner (FORCE RLS since M-T1); the index is owned by the table owner.
 * Same CONCURRENTLY / INVALID-retry handling and `transaction = false` as OutboxClaimIndexes1786721440000.
 * Not in production-migration-approval.ts: production approval is a separate owner gate.
 */
const INDEXES: ReadonlyArray<{ name: string; definition: string }> = Object.freeze([
  { name: 'refresh_token_replaced_by_idx', definition: 'ON core.refresh_token (replaced_by) WHERE replaced_by IS NOT NULL' },
  { name: 'login_history_user_id_idx', definition: 'ON core.login_history (user_id) WHERE user_id IS NOT NULL' },
]);
/** Owner of core.refresh_token / core.login_history. */
const TABLE_OWNER = 'rab_secure_owner';

export class RefreshTokenReplacedByIndex1786721450000 implements MigrationInterface {
  name = 'RefreshTokenReplacedByIndex1786721450000';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.assertAuthority(queryRunner);
    const cc = queryRunner.isTransactionActive ? '' : 'CONCURRENTLY ';
    await queryRunner.query(`SET lock_timeout = '60s'`);
    try {
      for (const index of INDEXES) {
        if ((await this.state(queryRunner, index.name)) === 'INVALID') await queryRunner.query(`DROP INDEX ${cc}IF EXISTS core.${index.name}`);
        if ((await this.state(queryRunner, index.name)) === 'ABSENT') {
          await queryRunner.query(`CREATE INDEX ${cc}IF NOT EXISTS ${index.name} ${index.definition}`);
        }
        if ((await this.state(queryRunner, index.name)) !== 'VALID') throw new Error(`${this.name}: ${index.name} is not valid after the build`);
      }
    } finally {
      await queryRunner.query('RESET lock_timeout');
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.assertAuthority(queryRunner);
    const cc = queryRunner.isTransactionActive ? '' : 'CONCURRENTLY ';
    for (const index of [...INDEXES].reverse()) await queryRunner.query(`DROP INDEX ${cc}IF EXISTS core.${index.name}`);
  }

  private async state(queryRunner: QueryRunner, name: string): Promise<'ABSENT' | 'VALID' | 'INVALID'> {
    const rows: Array<{ valid: boolean; ready: boolean }> = await queryRunner.query(
      `SELECT i.indisvalid AS valid, i.indisready AS ready FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'core' AND c.relname = $1`,
      [name],
    );
    if (rows.length === 0) return 'ABSENT';
    return rows[0]!.valid && rows[0]!.ready ? 'VALID' : 'INVALID';
  }

  private async assertAuthority(queryRunner: QueryRunner): Promise<void> {
    const [{ ok }] = await queryRunner.query(`SELECT pg_has_role(current_user, $1, 'USAGE') AS ok`, [TABLE_OWNER]);
    if (!ok) throw new Error(`${this.name} must run as ${TABLE_OWNER} or the migration identity (owner of refresh_token / login_history)`);
  }
}
