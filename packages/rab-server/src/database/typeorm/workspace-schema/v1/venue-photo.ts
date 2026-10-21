/**
 * Frozen SQL shipped with migration 1786718700000 (and applied by the provisioner after the earlier V1 add-ons).
 *
 * Venue profile photo: one nullable pointer from a venue to the `core.stored_file` row (kind VENUE_PHOTO) that is its
 * current photo. Same shape as `core."user".avatar_file_id`: a real FK to the file id, ON DELETE SET NULL (stored_file
 * rows are tombstoned, never deleted by the runtime role, so the SET NULL only matters for an owner-run hard purge).
 * No back-fill: every existing venue simply has no photo. Existing RLS on venue applies unchanged (row-level,
 * column-agnostic); who may READ the bytes is decided by stored_file RLS + VenuePhotoFilePolicy, not by this column.
 */
export function venuePhotoSql(schema: string): string {
  if (schema !== 'core' && !/^workspace_[0-9a-f]{32}$/.test(schema)) throw new Error('Invalid workspace schema');
  const t = `${schema === 'core' ? 'core' : `"${schema}"`}.venue`;
  return `
ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS photo_file_id uuid;
ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS venue_photo_file_id_fkey;
ALTER TABLE ${t} ADD CONSTRAINT venue_photo_file_id_fkey
  FOREIGN KEY (photo_file_id) REFERENCES core.stored_file(id) ON DELETE SET NULL;
`;
}
