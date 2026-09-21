import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the Venue-Manager-submits / Internal-Manager-approves workflow onto
 * the existing Shift lifecycle, reusing `Shift` directly rather than a
 * second "request" entity/table (the row IS the shift from the moment it's
 * submitted — approval only ever changes its `status`, matching how
 * `SchedulingService.create`→`publish` already treats DRAFT→OPEN as a
 * status change on the same row, not a new object).
 *
 * `pending_manager_approval` is a genuinely new starting state (a Venue
 * Manager submitting is not the same act as an Internal Manager's own
 * DRAFT→OPEN publish); `declined` is its terminal rejection counterpart —
 * distinct from `cancelled`, which already means "an approved/open shift
 * was called off," not "never approved to begin with."
 *
 * `requested_by` records who submitted the request (nullable — every
 * existing shift and every Internal-Manager-created shift going forward
 * has no requester, only `created_by`). It is what `staffAccept()` checks
 * to decide whether this shift's offers get the new auto-confirm behavior
 * (§G) — a shift created directly via `createShiftAndSend` (requested_by
 * IS NULL) keeps the old two-step staff-accept→manager-confirm flow
 * untouched.
 */
export class ShiftRequestApprovalSchema1786671300000 implements MigrationInterface {
  name = 'ShiftRequestApprovalSchema1786671300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.shift
        ADD COLUMN requested_by uuid REFERENCES core."user"(id),
        ADD COLUMN declined_reason text,
        ADD COLUMN declined_at timestamptz,
        ADD COLUMN declined_by uuid REFERENCES core."user"(id),
        ADD COLUMN approved_at timestamptz,
        ADD COLUMN approved_by uuid REFERENCES core."user"(id);
    `);

    await queryRunner.query(`ALTER TABLE core.shift DROP CONSTRAINT shift_status_check;`);
    await queryRunner.query(`
      ALTER TABLE core.shift
        ADD CONSTRAINT shift_status_check
        CHECK (status IN ('draft','pending_manager_approval','declined','open','offered',
                           'partially_filled','fully_filled','confirmed','in_progress',
                           'completed','cancelled'));
    `);

    // Mirrors the existing `shift_open_status_idx` partial index — pending
    // requests are looked up by Internal Managers frequently enough (the
    // approval-queue list) to deserve the same treatment.
    await queryRunner.query(`
      CREATE INDEX shift_pending_approval_idx ON core.shift (organisation_id, workspace_id)
        WHERE status = 'pending_manager_approval';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS core.shift_pending_approval_idx;`);

    await queryRunner.query(`ALTER TABLE core.shift DROP CONSTRAINT shift_status_check;`);
    await queryRunner.query(`
      ALTER TABLE core.shift
        ADD CONSTRAINT shift_status_check
        CHECK (status IN ('draft','open','offered','partially_filled',
                           'fully_filled','confirmed','in_progress',
                           'completed','cancelled'));
    `);

    await queryRunner.query(`
      ALTER TABLE core.shift
        DROP COLUMN requested_by,
        DROP COLUMN declined_reason,
        DROP COLUMN declined_at,
        DROP COLUMN declined_by,
        DROP COLUMN approved_at,
        DROP COLUMN approved_by;
    `);
  }
}
