import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PHASE 4 — replaces `replacement_request`'s dead, never-referenced
 * `'approved'` status value with `'approving'`: the transient, atomically-
 * claimed state (`UPDATE ... WHERE status IN ('awaiting_approval',
 * 'no_candidates') RETURNING`) `ReplacementRequestService.approve()` now
 * holds for the duration of one single transaction while it revalidates the
 * candidate and creates the offer — closing the double-approval race where
 * two concurrent approvals could both pass a plain read-then-check and both
 * send an offer. `'approved'` was confirmed (grepped, not assumed) to have
 * never been written by any code path — this is a safe, backward-compatible
 * constraint swap, not a data migration.
 */
export class ReplacementRequestApprovingState1786673300000 implements MigrationInterface {
  name = 'ReplacementRequestApprovingState1786673300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.replacement_request DROP CONSTRAINT replacement_request_status_check;`);
    await queryRunner.query(`
      ALTER TABLE core.replacement_request ADD CONSTRAINT replacement_request_status_check
        CHECK (status IN ('awaiting_approval', 'no_candidates', 'approving', 'rejected', 'offer_sent', 'cancelled'));
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.replacement_request DROP CONSTRAINT replacement_request_status_check;`);
    await queryRunner.query(`
      ALTER TABLE core.replacement_request ADD CONSTRAINT replacement_request_status_check
        CHECK (status IN ('awaiting_approval', 'no_candidates', 'approved', 'rejected', 'offer_sent', 'cancelled'));
    `);
  }
}
