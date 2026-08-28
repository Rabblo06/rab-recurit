import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Closes the last real gap in per-Manager private data scoping: `venue` and
 * `job_role` were the only two tenant tables with no `created_by` column at
 * all (`staff_profile`/`shift`/`job_offer` already have one, added by
 * ResourceOwnershipSchema1786666700000). `VenueRoleRate` was assessed too —
 * skipped, since no controller route exposes it directly (only read
 * internally by `SchedulingService.resolvePayRate`), so there's nothing to
 * scope and no way to populate the column if added.
 *
 * No backfill: unlike `job_offer.created_by` (recoverable from `OFFER_SENT`
 * audit rows), venue/job-role creation has never written an audit entry —
 * existing rows have no recoverable creator and stay NULL, visible only to
 * the platform admin (`ResourceScopeService`'s `admin` scope), matching the
 * same precedent already set for `staff_profile.created_by`'s unrecoverable
 * rows. Never guessed into a specific Manager's scope.
 */
export class VenueJobRoleOwnershipSchema1786667200000 implements MigrationInterface {
  name = 'VenueJobRoleOwnershipSchema1786667200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.venue ADD COLUMN created_by uuid REFERENCES core."user"(id);`);
    await queryRunner.query(`ALTER TABLE core.job_role ADD COLUMN created_by uuid REFERENCES core."user"(id);`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.job_role DROP COLUMN created_by;`);
    await queryRunner.query(`ALTER TABLE core.venue DROP COLUMN created_by;`);
  }
}
