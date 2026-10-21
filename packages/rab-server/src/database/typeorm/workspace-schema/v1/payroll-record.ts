/**
 * Frozen SQL shipped with migration 1786718800000 (and applied by the provisioner after the earlier V1 add-ons).
 *
 * Payroll approval (owner rule 2026-10-20): Clock out -> the report is finalised (attendance 'approved') -> one
 * `payroll_record` per finalised attendance is created `pending_approval` in the SAME transaction -> a workspace
 * manager holding `payroll.approve` approves (or rejects) it -> only then does the staff member's History show it.
 * Payout is out of scope (no processing/paid writer exists yet; the states exist for the shared transition table).
 *
 * Money is bigint pence. `worked_minutes` / `pay_rate_pence` / `amount_pence` are a frozen snapshot of the finalised
 * attendance (`attendance.worked_minutes`, `shift_assignment.pay_rate_snapshot_pence`, `attendance.earned_pence`),
 * taken once at creation and never recalculated: the runtime role has NO column grant to change them.
 *
 * RLS (ENABLE + FORCE, same migration), four layers of predicate:
 *  - tenant: organisation AND workspace of the bound context, on every command.
 *  - SELECT: a non-venue manager of THIS workspace (manager_profile.type <> 'venue'), OR the staff member the row is
 *    about (their own staff_profile). Venue Managers are absent at the SQL level (architecture §5.7): they never read
 *    payroll rows, even through a bug.
 *  - INSERT: only a `pending_approval` row with no decision recorded, by a caller who can read the shift's report
 *    (shift creator, or a Venue Manager linked to the venue - the people who finalise), AND the row must mirror an
 *    `approved` attendance exactly (same shift, staff, worked minutes, earned pence, assignment rate snapshot). No one
 *    can insert a payroll row with invented figures or for unapproved attendance.
 *  - UPDATE: non-venue workspace managers only; the approver can never be the staff member the hours belong to.
 *  - DELETE: no policy and no grant. Payroll rows are financial records (A11 retention).
 */
/** The predicate fragments of the payroll_record policies, shared with later add-ons (1786719000000) so they never drift. */
export function payrollRecordPredicates(q: string) {
  const tenant = `(organisation_id = core.current_org()) AND (workspace_id = core.current_workspace())`;
  const payrollManager = `(EXISTS (
      SELECT 1 FROM core.manager_profile mp
      WHERE (mp.user_id = core.current_uid()) AND (mp.organisation_id = core.current_org())
        AND (mp.workspace_id = core.current_workspace()) AND (mp.type <> 'venue'::text)))`;
  const staffOwn = `(EXISTS (
      SELECT 1 FROM ${q}.staff_profile sp
      WHERE (sp.id = payroll_record.staff_profile_id) AND (sp.user_id = core.current_uid())
        AND (sp.organisation_id = core.current_org()) AND (sp.workspace_id = core.current_workspace())))`;
  const canReadShift = `(EXISTS (
      SELECT 1 FROM ${q}.shift s
      WHERE (s.id = payroll_record.shift_id) AND (s.organisation_id = core.current_org()) AND (s.workspace_id = core.current_workspace())
        AND ((s.created_by = core.current_uid()) OR (EXISTS (
          SELECT 1 FROM core.manager_profile mp JOIN ${q}.manager_venue mv ON (mv.manager_profile_id = mp.id)
          WHERE (mp.user_id = core.current_uid()) AND (mp.type = 'venue'::text)
            AND (mp.organisation_id = core.current_org()) AND (mp.workspace_id = core.current_workspace())
            AND (mv.venue_id = s.venue_id) AND (mv.organisation_id = core.current_org()) AND (mv.workspace_id = core.current_workspace()))))))`;
  const mirrorsApprovedAttendance = `(EXISTS (
      SELECT 1 FROM ${q}.attendance a JOIN ${q}.shift_assignment sa ON (sa.id = a.shift_assignment_id)
      WHERE (a.id = payroll_record.attendance_id) AND (a.status = 'approved'::text)
        AND (a.organisation_id = payroll_record.organisation_id) AND (a.workspace_id = payroll_record.workspace_id)
        AND (a.shift_id = payroll_record.shift_id) AND (a.staff_profile_id = payroll_record.staff_profile_id)
        AND (a.worked_minutes = payroll_record.worked_minutes) AND (a.earned_pence = payroll_record.amount_pence)
        AND (sa.pay_rate_snapshot_pence = payroll_record.pay_rate_pence)))`;
  const undecidedPending = `(status = 'pending_approval'::text) AND (approved_at IS NULL) AND (approved_by IS NULL)
      AND (rejected_at IS NULL) AND (rejected_by IS NULL) AND (rejection_reason IS NULL)`;
  const notOwnHours = `((approved_by IS NULL) OR (NOT (EXISTS (
      SELECT 1 FROM ${q}.staff_profile sp WHERE (sp.id = payroll_record.staff_profile_id) AND (sp.user_id = payroll_record.approved_by)))))`;
  return { tenant, payrollManager, staffOwn, canReadShift, mirrorsApprovedAttendance, undecidedPending, notOwnHours };
}

export function payrollRecordSql(schema: string): string {
  if (schema !== 'core' && !/^workspace_[0-9a-f]{32}$/.test(schema)) throw new Error('Invalid workspace schema');
  const q = schema === 'core' ? 'core' : `"${schema}"`;
  const t = `${q}.payroll_record`;
  const { tenant, payrollManager, staffOwn, canReadShift, mirrorsApprovedAttendance, undecidedPending, notOwnHours } = payrollRecordPredicates(q);
  return `
CREATE TABLE IF NOT EXISTS ${t} (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  attendance_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  staff_profile_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending_approval',
  worked_minutes integer NOT NULL,
  pay_rate_pence bigint NOT NULL,
  amount_pence bigint NOT NULL,
  approved_at timestamptz,
  approved_by uuid,
  rejected_at timestamptz,
  rejected_by uuid,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_record_pkey PRIMARY KEY (id),
  CONSTRAINT payroll_record_attendance_id_key UNIQUE (attendance_id),
  CONSTRAINT payroll_record_status_check CHECK (status IN ('draft','pending_approval','approved','processing','paid','rejected','corrected')),
  CONSTRAINT payroll_record_figures_check CHECK (worked_minutes >= 0 AND pay_rate_pence >= 0 AND amount_pence >= 0),
  CONSTRAINT payroll_record_approval_pair_check CHECK ((approved_at IS NULL) = (approved_by IS NULL)),
  CONSTRAINT payroll_record_rejection_pair_check CHECK ((rejected_at IS NULL) = (rejected_by IS NULL)),
  CONSTRAINT payroll_record_approved_check CHECK (status NOT IN ('approved','processing','paid') OR approved_at IS NOT NULL),
  CONSTRAINT payroll_record_rejected_check CHECK (status <> 'rejected' OR (rejected_at IS NOT NULL AND rejection_reason IS NOT NULL)),
  CONSTRAINT payroll_record_reason_check CHECK (rejection_reason IS NULL OR char_length(btrim(rejection_reason)) BETWEEN 3 AND 500),
  CONSTRAINT payroll_record_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE,
  CONSTRAINT payroll_record_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES core.manager_workspace(id),
  CONSTRAINT payroll_record_attendance_id_fkey FOREIGN KEY (attendance_id) REFERENCES ${q}.attendance(id) ON DELETE CASCADE,
  CONSTRAINT payroll_record_shift_workspace_fkey FOREIGN KEY (shift_id, workspace_id) REFERENCES ${q}.shift(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT payroll_record_staff_workspace_fkey FOREIGN KEY (staff_profile_id, workspace_id) REFERENCES ${q}.staff_profile(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT payroll_record_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES core."user"(id),
  CONSTRAINT payroll_record_rejected_by_fkey FOREIGN KEY (rejected_by) REFERENCES core."user"(id)
);
CREATE INDEX IF NOT EXISTS payroll_record_workspace_status_idx ON ${t} USING btree (workspace_id, status);
CREATE INDEX IF NOT EXISTS payroll_record_staff_idx ON ${t} USING btree (staff_profile_id);
-- Business tables are owned by crewflow (1786717700000); never by whichever bootstrap identity ran this.
ALTER TABLE ${t} OWNER TO crewflow;

ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payroll_record_select ON ${t};
CREATE POLICY payroll_record_select ON ${t} AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (${tenant} AND (${payrollManager} OR ${staffOwn}));
DROP POLICY IF EXISTS payroll_record_insert ON ${t};
CREATE POLICY payroll_record_insert ON ${t} AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (${tenant} AND ${undecidedPending} AND ${canReadShift} AND ${mirrorsApprovedAttendance});
DROP POLICY IF EXISTS payroll_record_update ON ${t};
CREATE POLICY payroll_record_update ON ${t} AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (${tenant} AND ${payrollManager})
  WITH CHECK (${tenant} AND ${payrollManager} AND ${notOwnHours});

-- Runtime role: read + create; UPDATE only on the decision columns (the snapshot figures are immutable); never DELETE.
REVOKE ALL ON ${t} FROM PUBLIC;
REVOKE ALL ON ${t} FROM crewflow_app;
GRANT SELECT, INSERT ON ${t} TO crewflow_app;
GRANT UPDATE (status, approved_at, approved_by, rejected_at, rejected_by, rejection_reason, updated_at) ON ${t} TO crewflow_app;
`;
}
