import { MigrationInterface, QueryRunner } from 'typeorm';
import { venuePhotoSql } from '../../workspace-schema/v1/venue-photo';

const KINDS_BEFORE = ['PROFILE_IMAGE', 'ORGANISATION_LOGO', 'WORKSPACE_LOGO', 'SHIFT_ROSTER_PDF', 'FINAL_TIMESHEET_PDF'];
const KINDS_AFTER = [...KINDS_BEFORE, 'VENUE_PHOTO'];

const kindCheck = (kinds: string[]) => `CHECK (kind IN (${kinds.map((k) => `'${k}'`).join(', ')}))`;

/**
 * Venue profile photo. Additive only:
 *  1. `core.stored_file.kind` admits 'VENUE_PHOTO' (the CHECK is replaced; no stored row changes).
 *  2. `venue.photo_file_id uuid NULL` + FK to core.stored_file(id) in core and every provisioned workspace schema
 *     (see `venuePhotoSql`; the provisioner applies the same SQL, V1_EXPECTED.foreignKeys 95 -> 96).
 *
 * No new table, so no new RLS policy: a VENUE_PHOTO file is stored with the venue's own non-NULL workspace_id and is
 * therefore inside the existing `stored_file_tenant` workspace branch (organisation AND workspace must match the
 * caller's bound context). The NULL-workspace exceptions of that policy (PROFILE_IMAGE / ORGANISATION_LOGO) are not
 * widened. The per-caller rule (venue visibility / staff offer at the venue) is VenuePhotoFilePolicy (layer 2).
 */
export class VenuePhoto1786718700000 implements MigrationInterface {
  name = 'VenuePhoto1786718700000';

  private async schemas(runner: QueryRunner): Promise<string[]> {
    const rows: Array<{ schema_name: string }> = await runner.query(`
      SELECT n.nspname AS schema_name FROM pg_namespace n
      JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = 'venue' AND c.relkind = 'r'
      WHERE n.nspname = 'core' OR n.nspname ~ '^workspace_[0-9a-f]{32}$'
    `);
    return rows.map((row) => row.schema_name);
  }

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE core.stored_file DROP CONSTRAINT IF EXISTS stored_file_kind_check;`);
    await runner.query(`ALTER TABLE core.stored_file ADD CONSTRAINT stored_file_kind_check ${kindCheck(KINDS_AFTER)};`);
    for (const schema of await this.schemas(runner)) await runner.query(venuePhotoSql(schema));
  }

  /** Drops the pointer column and restores the kind CHECK. Fails (by design) if any VENUE_PHOTO row exists — down is for a failed rollout only. */
  async down(runner: QueryRunner): Promise<void> {
    for (const schema of await this.schemas(runner)) {
      const t = `${schema === 'core' ? 'core' : `"${schema}"`}.venue`;
      await runner.query(`ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS venue_photo_file_id_fkey, DROP COLUMN IF EXISTS photo_file_id;`);
    }
    await runner.query(`ALTER TABLE core.stored_file DROP CONSTRAINT IF EXISTS stored_file_kind_check;`);
    await runner.query(`ALTER TABLE core.stored_file ADD CONSTRAINT stored_file_kind_check ${kindCheck(KINDS_BEFORE)};`);
  }
}
