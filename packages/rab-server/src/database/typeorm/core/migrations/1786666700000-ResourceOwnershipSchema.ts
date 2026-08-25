import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds manager-ownership tracking to `staff_profile` and `job_offer` —
 * `shift.created_by` already existed (NOT NULL, since day one), so it needs
 * no migration here, only the query-scoping change alongside this one.
 *
 * Both new columns are NULLABLE, deliberately: neither table has ever
 * recorded a creator before this migration, and per this change's own
 * "never guess ownership" rule, existing rows must not be silently
 * assigned an owner.
 *
 * `staff_profile.created_by`: genuinely unrecoverable for pre-existing
 * rows — `StaffService.create()` never called `AuditService.record()`
 * (confirmed by grep, zero audit calls in that file), so there is no
 * record anywhere of who created a pre-existing Staff profile. Left NULL;
 * a NULL-owner Staff profile is visible to the platform admin only, until
 * explicitly claimed/reassigned (a future, separate piece of work — this
 * migration does not invent a reassignment flow).
 *
 * `job_offer.created_by`: recoverable — every offer send already writes
 * an `audit_log` row (`AuditAction.OFFER_SENT = 'offer.sent'`,
 * `entityType: 'offer'`, `entityId: offer.id`, actor = the sending
 * manager's `ctx.userId`). Backfilled from that trail below, so existing
 * offers keep their real sender rather than losing ownership data that
 * was actually available.
 */
export class ResourceOwnershipSchema1786666700000 implements MigrationInterface {
  name = 'ResourceOwnershipSchema1786666700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.staff_profile ADD COLUMN created_by uuid REFERENCES core."user"(id) ON DELETE SET NULL;
    `);
    await queryRunner.query(`
      CREATE INDEX staff_profile_org_owner_idx ON core.staff_profile (organisation_id, created_by);
    `);

    await queryRunner.query(`
      ALTER TABLE core.job_offer ADD COLUMN created_by uuid REFERENCES core."user"(id) ON DELETE SET NULL;
    `);
    await queryRunner.query(`
      CREATE INDEX job_offer_org_owner_idx ON core.job_offer (organisation_id, created_by);
    `);

    // Backfill job_offer.created_by from the audit trail. Both tables are
    // FORCE-RLS'd and this migration runs with no tenant context bound, so
    // (matching every prior backfill in this schema) toggle RLS off for
    // both sides of the join, then restore ENABLE+FORCE immediately after,
    // in the same migration transaction.
    await queryRunner.query(`ALTER TABLE core.job_offer DISABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.audit_log DISABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      UPDATE core.job_offer o
         SET created_by = al.actor_user_id
        FROM core.audit_log al
       WHERE al.entity_type = 'offer'
         AND al.entity_id = o.id
         AND al.action = 'offer.sent'
         AND al.actor_user_id IS NOT NULL;
    `);
    await queryRunner.query(`ALTER TABLE core.job_offer ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.job_offer FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.audit_log ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.audit_log FORCE ROW LEVEL SECURITY;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.job_offer DROP COLUMN created_by;`);
    await queryRunner.query(`ALTER TABLE core.staff_profile DROP COLUMN created_by;`);
  }
}
