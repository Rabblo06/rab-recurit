/**
 * Frozen SQL shipped with migration 1786718500000 (and applied by the provisioner after the earlier V1 add-ons).
 *
 * Owner brief 2026-10-18: "Reviewed" must mean a persisted, completed ATTENDANCE review by a manager — distinct from a
 * saved correction and from report finalisation. One explicit record per seat, on the assignment, so it covers both a
 * staff member who attended (clock-out present) and a confirmed no-show (no attendance row):
 *   attendance_reviewed_at / attendance_reviewed_by  — set by the review action, cleared by any later correction.
 * Nullable, no back-fill: no existing seat is presented as reviewed. The CHECK keeps the pair consistent; the FK pins
 * the reviewer to a real account. Existing RLS on shift_assignment applies unchanged (row-level, column-agnostic).
 */
export function attendanceReviewSql(schema: string): string {
  if (schema !== 'core' && !/^workspace_[0-9a-f]{32}$/.test(schema)) throw new Error('Invalid workspace schema');
  const t = `${schema === 'core' ? 'core' : `"${schema}"`}.shift_assignment`;
  return `
ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS attendance_reviewed_at timestamptz;
ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS attendance_reviewed_by uuid;
ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS shift_assignment_attendance_review_pair_check;
ALTER TABLE ${t} ADD CONSTRAINT shift_assignment_attendance_review_pair_check
  CHECK ((attendance_reviewed_at IS NULL) = (attendance_reviewed_by IS NULL));
ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS shift_assignment_attendance_reviewed_by_fkey;
ALTER TABLE ${t} ADD CONSTRAINT shift_assignment_attendance_reviewed_by_fkey
  FOREIGN KEY (attendance_reviewed_by) REFERENCES core."user"(id);
`;
}
