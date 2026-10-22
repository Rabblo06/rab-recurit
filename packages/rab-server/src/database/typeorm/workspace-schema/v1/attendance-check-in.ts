/**
 * Frozen SQL shipped with migration 1786719450000 (and applied by the provisioner after the earlier V1 add-ons).
 *
 * Check In → Clock In → Clock Out (owner brief 2026-10-21). Additive columns only, no new table, no new policy: the
 * existing row-level RLS on shift_assignment / attendance applies unchanged (column-agnostic).
 *
 * shift_assignment (one Check In per booking — arrival evidence, NOT worked time, never payroll input):
 *   check_in_required          — rollout rule. Added with DEFAULT false so every booking that exists when the migration
 *                                runs keeps the old flow (no row is updated, no check-in is fabricated), then the default
 *                                becomes true: every booking created afterwards must be checked in before clock-in.
 *   checked_in_at              — server time of the Check In (never client time).
 *   check_in_source            — 'staff' (app button) | 'qr' (Shift QR scanned).
 *   check_in_location_verified — the venue enforced its geofence and the fix passed.
 *   check_in_distance_m / check_in_accuracy_m / check_in_captured_at — the only evidence kept (rounded metres and the
 *                                device capture time used for replay detection). Raw coordinates are NOT stored.
 *
 * attendance (punch provenance):
 *   clock_in_method      — 'staff' | 'manager_on_behalf' | 'manager_correction' (NULL = legacy row, staff app).
 *   clock_in_by / clock_in_reason, clock_out_by / clock_out_reason — the Venue Manager and reason of an on-behalf punch,
 *                          pinned by CHECKs to exactly the on-behalf method (FKs to core."user": evidence, no ON DELETE).
 *   clock_in_captured_at — device capture time of the clock-in fix (a clock-out fix must be strictly newer).
 *   clock_out_method     — widened with 'manager_on_behalf'.
 */
export function attendanceCheckInSql(schema: string): string {
  if (schema !== 'core' && !/^workspace_[0-9a-f]{32}$/.test(schema)) throw new Error('Invalid workspace schema');
  const q = schema === 'core' ? 'core' : `"${schema}"`;
  const sa = `${q}.shift_assignment`;
  const a = `${q}.attendance`;
  return `
ALTER TABLE ${sa} ADD COLUMN IF NOT EXISTS check_in_required boolean NOT NULL DEFAULT false;
ALTER TABLE ${sa} ALTER COLUMN check_in_required SET DEFAULT true;
ALTER TABLE ${sa} ADD COLUMN IF NOT EXISTS checked_in_at timestamptz;
ALTER TABLE ${sa} ADD COLUMN IF NOT EXISTS check_in_source text;
ALTER TABLE ${sa} ADD COLUMN IF NOT EXISTS check_in_location_verified boolean;
ALTER TABLE ${sa} ADD COLUMN IF NOT EXISTS check_in_distance_m integer;
ALTER TABLE ${sa} ADD COLUMN IF NOT EXISTS check_in_accuracy_m integer;
ALTER TABLE ${sa} ADD COLUMN IF NOT EXISTS check_in_captured_at timestamptz;
ALTER TABLE ${sa} DROP CONSTRAINT IF EXISTS shift_assignment_check_in_check;
ALTER TABLE ${sa} ADD CONSTRAINT shift_assignment_check_in_check CHECK (
  (check_in_source IS NULL OR check_in_source IN ('staff', 'qr'))
  AND (checked_in_at IS NULL) = (check_in_source IS NULL)
  AND (checked_in_at IS NULL) = (check_in_location_verified IS NULL)
  AND (check_in_distance_m IS NULL OR check_in_distance_m >= 0)
  AND (check_in_accuracy_m IS NULL OR check_in_accuracy_m >= 0)
  AND (checked_in_at IS NOT NULL OR (check_in_distance_m IS NULL AND check_in_accuracy_m IS NULL AND check_in_captured_at IS NULL))
);

ALTER TABLE ${a} ADD COLUMN IF NOT EXISTS clock_in_method text;
ALTER TABLE ${a} ADD COLUMN IF NOT EXISTS clock_in_by uuid;
ALTER TABLE ${a} ADD COLUMN IF NOT EXISTS clock_in_reason text;
ALTER TABLE ${a} ADD COLUMN IF NOT EXISTS clock_out_by uuid;
ALTER TABLE ${a} ADD COLUMN IF NOT EXISTS clock_out_reason text;
ALTER TABLE ${a} ADD COLUMN IF NOT EXISTS clock_in_captured_at timestamptz;
ALTER TABLE ${a} DROP CONSTRAINT IF EXISTS attendance_clock_out_method_check;
ALTER TABLE ${a} ADD CONSTRAINT attendance_clock_out_method_check
  CHECK (clock_out_method IS NULL OR clock_out_method IN ('manual', 'auto_geofence', 'manager_correction', 'manager_on_behalf'));
ALTER TABLE ${a} DROP CONSTRAINT IF EXISTS attendance_on_behalf_check;
ALTER TABLE ${a} ADD CONSTRAINT attendance_on_behalf_check CHECK (
  (clock_in_method IS NULL OR clock_in_method IN ('staff', 'manager_on_behalf', 'manager_correction'))
  AND (COALESCE(clock_in_method, '') = 'manager_on_behalf') = (clock_in_by IS NOT NULL)
  AND (COALESCE(clock_in_method, '') = 'manager_on_behalf') = (clock_in_reason IS NOT NULL)
  AND (COALESCE(clock_out_method, '') = 'manager_on_behalf') = (clock_out_by IS NOT NULL)
  AND (COALESCE(clock_out_method, '') = 'manager_on_behalf') = (clock_out_reason IS NOT NULL)
  AND (clock_in_reason IS NULL OR char_length(clock_in_reason) BETWEEN 1 AND 1000)
  AND (clock_out_reason IS NULL OR char_length(clock_out_reason) BETWEEN 1 AND 1000)
);
ALTER TABLE ${a} DROP CONSTRAINT IF EXISTS attendance_clock_in_by_fkey;
ALTER TABLE ${a} ADD CONSTRAINT attendance_clock_in_by_fkey FOREIGN KEY (clock_in_by) REFERENCES core."user"(id);
ALTER TABLE ${a} DROP CONSTRAINT IF EXISTS attendance_clock_out_by_fkey;
ALTER TABLE ${a} ADD CONSTRAINT attendance_clock_out_by_fkey FOREIGN KEY (clock_out_by) REFERENCES core."user"(id);
`;
}
