/**
 * Frozen SQL shipped with migration 1786718300000 (and applied by the provisioner after the V1 template).
 *
 * Owner brief 2026-10-17 ("Reports, History & Timesheet"):
 *  1. `shift_report.signed_off_name` / `break_confirmed` — the Venue Manager's typed full-name sign-off and the break
 *     confirmation, recorded with the existing server-stamped `finalised_by` / `finalised_at`. Nullable: reports
 *     finalised before this migration have no typed sign-off and are NOT back-filled with invented evidence.
 *  2. `shift_staff_review` — one per-shift performance review per staff member on that shift (five 1-5 ratings, all
 *     required, no defaults; optional feedback). Scoped to the shift: never a global staff rating.
 *
 * RLS (ENABLE + FORCE, same migration): tenant (organisation + workspace) AND the caller can read the shift's report —
 * the shift's creator, or a Venue Manager linked to the shift's venue (`manager_venue`). WITH CHECK additionally pins
 * `reviewer_user_id` to the caller. The composite FKs pin the review to an assignment that really exists on that shift.
 */
export function shiftReviewSignoffSql(schema: string): string {
  if (schema !== 'core' && !/^workspace_[0-9a-f]{32}$/.test(schema)) throw new Error('Invalid workspace schema');
  const q = schema === 'core' ? 'core' : `"${schema}"`;
  const t = `${q}.shift_staff_review`;
  const tenant = `(organisation_id = core.current_org()) AND (workspace_id = core.current_workspace())`;
  const canReadShift = `(EXISTS (
      SELECT 1 FROM ${q}.shift s
      WHERE (s.id = shift_staff_review.shift_id) AND (s.organisation_id = core.current_org()) AND (s.workspace_id = core.current_workspace())
        AND ((s.created_by = core.current_uid()) OR (EXISTS (
          SELECT 1 FROM core.manager_profile mp JOIN ${q}.manager_venue mv ON (mv.manager_profile_id = mp.id)
          WHERE (mp.user_id = core.current_uid()) AND (mp.type = 'venue'::text)
            AND (mp.organisation_id = core.current_org()) AND (mp.workspace_id = core.current_workspace())
            AND (mv.venue_id = s.venue_id) AND (mv.organisation_id = core.current_org()) AND (mv.workspace_id = core.current_workspace()))))))`;
  return `
ALTER TABLE ${q}.shift_report ADD COLUMN IF NOT EXISTS signed_off_name text;
ALTER TABLE ${q}.shift_report ADD COLUMN IF NOT EXISTS break_confirmed boolean;
ALTER TABLE ${q}.shift_report DROP CONSTRAINT IF EXISTS shift_report_signed_off_name_check;
ALTER TABLE ${q}.shift_report ADD CONSTRAINT shift_report_signed_off_name_check
  CHECK (signed_off_name IS NULL OR char_length(btrim(signed_off_name)) BETWEEN 2 AND 120);

CREATE TABLE IF NOT EXISTS ${t} (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  staff_profile_id uuid NOT NULL,
  reviewer_user_id uuid NOT NULL,
  grooming smallint NOT NULL,
  attitude smallint NOT NULL,
  skills smallint NOT NULL,
  attendance smallint NOT NULL,
  time_keeping smallint NOT NULL,
  feedback text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shift_staff_review_pkey PRIMARY KEY (id),
  CONSTRAINT shift_staff_review_shift_id_staff_profile_id_key UNIQUE (shift_id, staff_profile_id),
  CONSTRAINT shift_staff_review_ratings_check CHECK (
    grooming BETWEEN 1 AND 5 AND attitude BETWEEN 1 AND 5 AND skills BETWEEN 1 AND 5
    AND attendance BETWEEN 1 AND 5 AND time_keeping BETWEEN 1 AND 5),
  CONSTRAINT shift_staff_review_feedback_check CHECK (feedback IS NULL OR char_length(feedback) <= 2000),
  CONSTRAINT shift_staff_review_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE,
  CONSTRAINT shift_staff_review_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES core.manager_workspace(id),
  CONSTRAINT shift_staff_review_reviewer_user_id_fkey FOREIGN KEY (reviewer_user_id) REFERENCES core."user"(id),
  CONSTRAINT shift_staff_review_shift_workspace_fkey FOREIGN KEY (shift_id, workspace_id) REFERENCES ${q}.shift(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT shift_staff_review_assignment_fkey FOREIGN KEY (shift_id, staff_profile_id) REFERENCES ${q}.shift_assignment(shift_id, staff_profile_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS shift_staff_review_workspace_idx ON ${t} USING btree (workspace_id);
-- Business tables are owned by crewflow (1786717700000); never by whichever bootstrap identity ran this.
ALTER TABLE ${t} OWNER TO crewflow;

ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS shift_staff_review_scope ON ${t};
CREATE POLICY shift_staff_review_scope ON ${t} AS PERMISSIVE FOR ALL TO PUBLIC
  USING (${tenant} AND ${canReadShift})
  WITH CHECK (${tenant} AND ${canReadShift} AND (reviewer_user_id = core.current_uid()));

REVOKE ALL ON ${t} FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON ${t} TO crewflow_app;
`;
}
