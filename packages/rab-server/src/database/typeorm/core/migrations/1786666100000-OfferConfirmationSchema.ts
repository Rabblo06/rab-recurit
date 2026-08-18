import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Splits offer acceptance into two steps (rab-workforce-architecture.md
 * §1.1, §8.4): staff accepting an offer only reserves it for manager
 * review — it does not claim a shift seat. Only the manager's explicit
 * confirm claims the seat (the atomic `filled_count` UPDATE and the GiST
 * no-double-booking check both move to that step, in `OfferService`).
 *
 * `job_offer.status='accepted'` and `shift_assignment.status='confirmed'`
 * rows written by the single-step flow are remapped to the new terminal
 * "manager confirmed" state before the CHECK constraints are tightened —
 * they represent shifts that were, in effect, already both accepted and
 * confirmed under the old one-step rule.
 */
export class OfferConfirmationSchema1786666100000 implements MigrationInterface {
  name = 'OfferConfirmationSchema1786666100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.job_offer
        ADD COLUMN staff_accepted_at   timestamptz,
        ADD COLUMN manager_confirmed_at timestamptz,
        ADD COLUMN manager_rejected_at timestamptz,
        ADD COLUMN confirmed_by        uuid REFERENCES core."user"(id),
        ADD COLUMN rejected_by         uuid REFERENCES core."user"(id),
        ADD COLUMN rejection_reason    text;
    `);

    // Drop the old CHECK before the remap — the new status value isn't
    // valid under it yet.
    await queryRunner.query(`ALTER TABLE core.job_offer DROP CONSTRAINT job_offer_status_check;`);

    // rab_owner is NOBYPASSRLS and this DDL migration runs with no tenant
    // context bound, so a plain UPDATE against a FORCEd table would
    // silently touch zero rows across every organisation (RLS fail-closed,
    // working as intended — just not what a cross-tenant data remap needs).
    // Table ownership still allows toggling RLS itself; do that for the
    // remap, then restore FORCE immediately, in the same migration
    // transaction.
    await queryRunner.query(`ALTER TABLE core.job_offer DISABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`UPDATE core.job_offer SET status = 'manager_confirmed' WHERE status = 'accepted';`);
    await queryRunner.query(`ALTER TABLE core.job_offer ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.job_offer FORCE ROW LEVEL SECURITY;`);

    await queryRunner.query(`
      ALTER TABLE core.job_offer
        ADD CONSTRAINT job_offer_status_check
        CHECK (status IN ('pending','staff_accepted','manager_confirmed','manager_rejected',
                           'declined','expired','withdrawn'));
    `);

    await queryRunner.query(`ALTER TABLE core.shift_assignment DROP CONSTRAINT shift_assignment_status_check;`);
    await queryRunner.query(`
      ALTER TABLE core.shift_assignment
        ADD CONSTRAINT shift_assignment_status_check
        CHECK (status IN ('offered','staff_accepted','confirmed','declined','rejected',
                           'withdrawn','cancelled','no_show','completed'));
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.shift_assignment DROP CONSTRAINT shift_assignment_status_check;`);
    await queryRunner.query(`
      ALTER TABLE core.shift_assignment
        ADD CONSTRAINT shift_assignment_status_check
        CHECK (status IN ('offered','confirmed','declined','withdrawn','cancelled','no_show','completed'));
    `);

    await queryRunner.query(`ALTER TABLE core.job_offer DROP CONSTRAINT job_offer_status_check;`);

    // Same RLS-disable-for-remap pattern as up() — see its comment.
    await queryRunner.query(`ALTER TABLE core.job_offer DISABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`UPDATE core.job_offer SET status = 'accepted' WHERE status = 'manager_confirmed';`);
    await queryRunner.query(`ALTER TABLE core.job_offer ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.job_offer FORCE ROW LEVEL SECURITY;`);

    await queryRunner.query(`
      ALTER TABLE core.job_offer
        ADD CONSTRAINT job_offer_status_check
        CHECK (status IN ('pending','accepted','declined','expired','withdrawn'));
    `);

    await queryRunner.query(`
      ALTER TABLE core.job_offer
        DROP COLUMN staff_accepted_at,
        DROP COLUMN manager_confirmed_at,
        DROP COLUMN manager_rejected_at,
        DROP COLUMN confirmed_by,
        DROP COLUMN rejected_by,
        DROP COLUMN rejection_reason;
    `);
  }
}
