import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `AuditService.list()` (`GET /audit-logs`) unconditionally filters
 * `actor_user_id = $1` on every call — never optional, see that method's
 * own doc comment on why (self-scoped, no org-wide actor visibility). The
 * only existing index on this table, `audit_log_org_time_idx
 * (organisation_id, created_at DESC)`, doesn't cover that predicate at all:
 * confirmed via a live `EXPLAIN ANALYZE` of the exact query shape before
 * writing this migration — Postgres uses that index for the RLS-injected
 * `organisation_id` condition, then applies `actor_user_id = $1` as a
 * post-scan `Filter` over every row the org-scoped bitmap scan returns
 * (`Rows Removed by Filter: 34` out of 98 org rows, on a dataset this
 * small). `audit_log` is append-only and grows without bound (never
 * pruned — see `audit_log`'s own insert-only invariant) — that Filter step
 * degrades linearly with total org history, not with what any one caller
 * actually needs to see. `(actor_user_id, created_at DESC)` matches the
 * query's actual shape (equality + range/sort) and lets Postgres use an
 * Index Scan for it directly instead.
 */
export class AuditLogActorCreatedAtIndex1786671100000 implements MigrationInterface {
  name = 'AuditLogActorCreatedAtIndex1786671100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX audit_log_actor_created_idx ON core.audit_log (actor_user_id, created_at DESC)
        WHERE actor_user_id IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS core.audit_log_actor_created_idx;`);
  }
}
