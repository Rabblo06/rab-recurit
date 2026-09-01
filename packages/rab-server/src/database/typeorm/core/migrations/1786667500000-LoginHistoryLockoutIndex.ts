import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `core.auth_count_recent_login_failures` (PreAuthLookupFunctions1786667400000)
 * — the brute-force lockout counter `AuthService.login` runs on EVERY login
 * attempt — filters `email = $1 AND success = false AND created_at > $2`.
 * The only existing indexes on `login_history` are the PK and
 * `(organisation_id, created_at DESC)`, neither usable for an email-only
 * predicate (the org isn't known pre-auth). Confirmed live via
 * `EXPLAIN (ANALYZE, BUFFERS)`: a sequential scan over 8043 rows, ~15ms,
 * on this table alone — and this table is insert-heavy (every login
 * attempt, success or failure), so it only gets worse with usage.
 *
 * Partial on `success = false` (the query's own predicate) — most login
 * attempts succeed, so this index stays a small fraction of the table's
 * size rather than growing with every login regardless of outcome.
 */
export class LoginHistoryLockoutIndex1786667500000 implements MigrationInterface {
  name = 'LoginHistoryLockoutIndex1786667500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX login_history_lockout_idx
        ON core.login_history (email, created_at DESC)
        WHERE success = false;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX core.login_history_lockout_idx;`);
  }
}
