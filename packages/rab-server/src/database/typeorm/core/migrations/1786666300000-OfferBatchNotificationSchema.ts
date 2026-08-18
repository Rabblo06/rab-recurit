import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Three additive changes, one migration:
 *
 * 1. `job_offer.offer_batch_id` — every send (1 recipient or 100) stamps a
 *    fresh UUID here, generated server-side. There is no `offer_batch`
 *    summary table: a batch's venue/role/date/counts are always derived by
 *    grouping `job_offer` rows by this id at query time, joining out to
 *    `shift_assignment`/`shift` — a denormalised summary would be a second
 *    source of truth that must track every accept/decline/confirm on the
 *    underlying rows for no real query-cost win at this data scale.
 *
 * 2. `audit_log.entity_type`/`entity_id` — a generic polymorphic target,
 *    additive to the existing `target_user_id` (kept for account-lifecycle
 *    rows). This is what finally powers `GET /audit-logs`, which the
 *    frontend (`TimelinePanel.tsx`, `AuditLog.tsx`) was already built
 *    against but which never had a backend route.
 *
 * 3. `notification` — a new table, FORCEd RLS scoped by organisation only
 *    (the tenant-context session never sets a per-user variable, only
 *    `core.current_org()` — same reason `OfferService.listMine` already
 *    scopes to the caller's own staff profile in the service layer rather
 *    than via RLS). Unlike `audit_log` this table needs UPDATE (marking
 *    `read_at`), so no REVOKE — ownership (`user_id = caller`) is enforced
 *    in `NotificationService`, not by DB grants.
 */
export class OfferBatchNotificationSchema1786666300000 implements MigrationInterface {
  name = 'OfferBatchNotificationSchema1786666300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.job_offer ADD COLUMN offer_batch_id uuid;
      CREATE INDEX job_offer_batch_idx ON core.job_offer (organisation_id, offer_batch_id)
        WHERE offer_batch_id IS NOT NULL;
    `);

    await queryRunner.query(`
      ALTER TABLE core.audit_log ADD COLUMN entity_type text, ADD COLUMN entity_id uuid;
      CREATE INDEX audit_log_entity_idx ON core.audit_log (organisation_id, entity_type, entity_id)
        WHERE entity_id IS NOT NULL;
    `);

    await queryRunner.query(`
      CREATE TABLE core.notification (
        id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id      uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        user_id              uuid NOT NULL REFERENCES core."user"(id) ON DELETE CASCADE,
        type                 text NOT NULL,
        title                text NOT NULL,
        message              text NOT NULL,
        related_entity_type  text,
        related_entity_id    uuid,
        channel_state        jsonb NOT NULL DEFAULT '{}',
        read_at              timestamptz,
        created_at           timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX notification_user_idx ON core.notification (user_id, read_at, created_at DESC);
    `);
    await queryRunner.query(`ALTER TABLE core.notification ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.notification FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY notification_tenant ON core.notification
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS core.notification`);
    await queryRunner.query(`ALTER TABLE core.audit_log DROP COLUMN entity_type, DROP COLUMN entity_id;`);
    await queryRunner.query(`ALTER TABLE core.job_offer DROP COLUMN offer_batch_id;`);
  }
}
