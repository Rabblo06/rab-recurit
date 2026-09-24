import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `core.stored_file` — first-class metadata for every object in object
 * storage (S3 or local). PostgreSQL is the source of truth for WHAT a file is
 * and WHO may see it; the object store only holds bytes. A client only ever
 * holds a file ID; the object key is resolved server-side after the row has
 * been read under RLS and the caller authorised.
 *
 * RLS (same migration as the table, per CLAUDE.md):
 *   - organisation is the outer boundary;
 *   - workspace_id NULL = organisation-level file (visible to the organisation);
 *   - otherwise workspace must match the caller's, OR the file belongs to a
 *     `shift_report` the caller can already see. That last branch selects from
 *     `core.shift_report` as the calling role, so `shift_report_tenant`'s own
 *     policy (workspace match OR a Venue Manager reaching the shift's venue)
 *     is applied — the file inherits the report's visibility instead of
 *     duplicating it.
 *
 * `rab_app` has no DELETE on this table: files are tombstoned (`status =
 * 'DELETED'`), never removed by the application role, so final attendance
 * evidence cannot vanish through a bug or a stolen session. Hard removal is
 * an explicit, owner-only reconciliation action.
 *
 * Referring columns are added here too (avatar, logos, report files, email
 * attachment) as real foreign keys to file IDs. The legacy `*_key` columns
 * are left in place (deprecated) so `storage:migrate-local` can move
 * existing data across before they are dropped in a later migration.
 */
export class StoredFileMetadata1786672600000 implements MigrationInterface {
  name = 'StoredFileMetadata1786672600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE core.stored_file (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id   uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        workspace_id      uuid REFERENCES core.manager_workspace(id),
        kind              text NOT NULL
                           CHECK (kind IN ('PROFILE_IMAGE', 'ORGANISATION_LOGO', 'WORKSPACE_LOGO', 'SHIFT_ROSTER_PDF', 'FINAL_TIMESHEET_PDF')),
        resource_type     text NOT NULL,
        resource_id       uuid NOT NULL,
        storage_driver    text NOT NULL CHECK (storage_driver IN ('LOCAL', 'S3')),
        bucket            text,
        object_key        text NOT NULL,
        original_filename text NOT NULL,
        mime_type         text NOT NULL,
        size_bytes        bigint NOT NULL CHECK (size_bytes > 0),
        sha256            char(64),
        status            text NOT NULL DEFAULT 'PENDING'
                           CHECK (status IN ('PENDING', 'AVAILABLE', 'FAILED', 'DELETED')),
        created_by        uuid REFERENCES core."user"(id) ON DELETE SET NULL,
        expires_at        timestamptz,
        deleted_at        timestamptz,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT stored_file_available_has_sha CHECK (status <> 'AVAILABLE' OR sha256 IS NOT NULL)
      );
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX stored_file_object_uidx ON core.stored_file (storage_driver, coalesce(bucket, ''), object_key);
    `);
    await queryRunner.query(`CREATE INDEX stored_file_resource_idx ON core.stored_file (organisation_id, resource_type, resource_id);`);
    await queryRunner.query(`CREATE INDEX stored_file_pending_idx ON core.stored_file (expires_at) WHERE status = 'PENDING';`);

    await queryRunner.query(`ALTER TABLE core.stored_file ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.stored_file FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY stored_file_tenant ON core.stored_file
        USING (
          organisation_id = core.current_org() AND (
            workspace_id IS NULL
            OR workspace_id = core.current_workspace()
            OR (
              resource_type = 'shift_report'
              AND EXISTS (SELECT 1 FROM core.shift_report sr WHERE sr.id = stored_file.resource_id)
            )
          )
        )
        WITH CHECK (
          organisation_id = core.current_org()
          AND (workspace_id IS NULL OR workspace_id = core.current_workspace())
        );
    `);
    await queryRunner.query(`REVOKE DELETE ON core.stored_file FROM rab_app;`);

    await queryRunner.query(`ALTER TABLE core."user" ADD COLUMN avatar_file_id uuid REFERENCES core.stored_file(id) ON DELETE SET NULL;`);
    // `core."user"` has NO table-wide SELECT for rab_app (that is how password_hash stays unreadable): every column is
    // granted explicitly, so a new readable column needs its own GRANT or every `SELECT` of the entity fails.
    await queryRunner.query(`GRANT SELECT (avatar_file_id) ON core."user" TO rab_app;`);
    await queryRunner.query(`ALTER TABLE core.organisation ADD COLUMN logo_file_id uuid REFERENCES core.stored_file(id) ON DELETE SET NULL;`);
    await queryRunner.query(`ALTER TABLE core.manager_workspace ADD COLUMN logo_file_id uuid REFERENCES core.stored_file(id) ON DELETE SET NULL;`);
    await queryRunner.query(`
      ALTER TABLE core.shift_report
        ADD COLUMN pre_shift_file_id uuid REFERENCES core.stored_file(id) ON DELETE SET NULL,
        ADD COLUMN final_file_id     uuid REFERENCES core.stored_file(id) ON DELETE SET NULL;
    `);
    // The outbox row is trusted DATABASE data (written by worker code in the same transaction as the file), unlike a queue
    // payload. The send processor builds its tenant context from `organisation_id` + `workspace_id` on the row, so a
    // workspace-scoped attachment stays invisible to any context that is not its own workspace — RLS is never loosened for it.
    await queryRunner.query(`
      ALTER TABLE core.email_outbox
        ADD COLUMN attachment_file_id uuid REFERENCES core.stored_file(id) ON DELETE SET NULL,
        ADD COLUMN workspace_id       uuid REFERENCES core.manager_workspace(id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.email_outbox DROP COLUMN IF EXISTS attachment_file_id, DROP COLUMN IF EXISTS workspace_id;`);
    await queryRunner.query(`ALTER TABLE core.shift_report DROP COLUMN IF EXISTS pre_shift_file_id, DROP COLUMN IF EXISTS final_file_id;`);
    await queryRunner.query(`ALTER TABLE core.manager_workspace DROP COLUMN IF EXISTS logo_file_id;`);
    await queryRunner.query(`ALTER TABLE core.organisation DROP COLUMN IF EXISTS logo_file_id;`);
    await queryRunner.query(`ALTER TABLE core."user" DROP COLUMN IF EXISTS avatar_file_id;`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.stored_file;`);
  }
}
