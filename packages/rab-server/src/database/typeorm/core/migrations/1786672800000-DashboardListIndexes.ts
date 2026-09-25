import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Four indexes matching the exact WHERE + default ORDER BY of the list
 * endpoints the Manager Web Dashboard fetches on every load — none of these
 * columns were indexed for the query shape actually run against them,
 * forcing a filter-then-sort over the full matched set on every page-1
 * request. Found via a production performance audit (2026-09-25); see
 * docs/HANDOFF.md for the full trace. Purely additive — no column, RLS
 * policy, or grant changes.
 *
 * - core.venue(created_by): the SOLE WHERE predicate of the owner-scoped
 *   venue list (venue.service.ts) had no index at all.
 * - core.job_offer(created_by, sent_at DESC): matches the owner-scoped
 *   offer list's WHERE + its default ORDER BY o.sent_at DESC exactly.
 * - core.staff_profile(organisation_id, created_by, created_at DESC):
 *   matches the staff list's WHERE + its default ORDER BY sp.createdAt DESC.
 * - core.manager_profile(organisation_id, created_at DESC): matches the
 *   manager list's WHERE + its default ORDER BY mp.createdAt DESC.
 */
export class DashboardListIndexes1786672800000 implements MigrationInterface {
  name = 'DashboardListIndexes1786672800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX venue_created_by_idx ON core.venue (created_by);`);
    await queryRunner.query(
      `CREATE INDEX job_offer_created_by_sent_at_idx ON core.job_offer (created_by, sent_at DESC);`,
    );
    await queryRunner.query(
      `CREATE INDEX staff_profile_org_created_by_created_at_idx ON core.staff_profile (organisation_id, created_by, created_at DESC);`,
    );
    await queryRunner.query(
      `CREATE INDEX manager_profile_org_created_at_idx ON core.manager_profile (organisation_id, created_at DESC);`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX core.manager_profile_org_created_at_idx;`);
    await queryRunner.query(`DROP INDEX core.staff_profile_org_created_by_created_at_idx;`);
    await queryRunner.query(`DROP INDEX core.job_offer_created_by_sent_at_idx;`);
    await queryRunner.query(`DROP INDEX core.venue_created_by_idx;`);
  }
}
