import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PHASE 7 — the manager-confirmation-timeout discovery scan
 * (`WHERE status = 'staff_accepted' AND staff_accepted_at < now() - interval
 * ORDER BY staff_accepted_at ASC LIMIT 500`, `offer-expiry.job.ts`'s
 * `runManagerConfirmationTimeoutCycle`) ran a Seq Scan with no supporting
 * index at all — confirmed via `EXPLAIN` before adding this, matching this
 * repository's own "don't add an index unless the plan justifies it" rule.
 * Same shape as the existing `job_offer_pending_expiry_idx` (a partial
 * index scoped to the one status this query cares about, ordered by the
 * same column the query sorts by). Purely additive — no column, RLS
 * policy, or grant changes.
 */
export class ManagerConfirmationTimeoutIndex1786673500000 implements MigrationInterface {
  name = 'ManagerConfirmationTimeoutIndex1786673500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX job_offer_staff_accepted_timeout_idx ON core.job_offer (staff_accepted_at) WHERE (status = 'staff_accepted');`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX core.job_offer_staff_accepted_timeout_idx;`);
  }
}
