import { payrollRecordPredicates } from './payroll-record';

/**
 * Frozen SQL shipped with migration 1786719200000 (and applied by the provisioner after `approvedShiftStatementSql`).
 *
 * Payroll runs and official payslips (owner decisions 2026-10-21):
 *  - `payroll_run`: one per (workspace, agency calendar period). `prepared` (lines may still be appended) → `finalised`
 *    (locked). Never paid automatically.
 *  - `payroll_run_line`: an immutable snapshot of one approved payroll record in a run (minutes, gross, work date,
 *    original period, late flag). UNIQUE (payroll_record_id): a record is included in exactly one run, ever.
 *  - `payslip`: per (run, staff member) after finalisation — provider-supplied net (optional, labelled), paid confirmation.
 *  - `payslip_document`: immutable versions of the uploaded provider PDF (replacing adds a version; old kept).
 *  - `payroll_record` guard trigger (`core.payroll_record_guard`): the status may only move along
 *    PAYROLL_RECORD_TRANSITIONS, and a non-worker session may change statement state only to REQUEST a statement
 *    (none → pending) or to RETRY a failed one (failed → pending, attempts reset). Replaces the 1786719000000 human
 *    WITH CHECK clause, which also blocked legitimate status changes on records that already had a statement.
 *
 * RLS (ENABLE + FORCE on all four): tenant + a non-venue manager of the workspace for every write; reads add the staff
 * member's own rows (lines, payslips, the documents of their own payslips) and, for runs, any staff member of the
 * workspace (a run row holds no personal data and staff need its status/period for their own payslip timeline). Worker
 * sessions may read runs and lines (statement period/payday). Lines and documents are INSERT-only (no UPDATE/DELETE
 * grant); a line can only be inserted into a `prepared` run, a payslip only for a `finalised` run.
 */
export function payrollRunsSql(schema: string): string {
  if (schema !== 'core' && !/^workspace_[0-9a-f]{32}$/.test(schema)) throw new Error('Invalid workspace schema');
  const q = schema === 'core' ? 'core' : `"${schema}"`;
  const { tenant, payrollManager, notOwnHours } = payrollRecordPredicates(q);
  const worker = `(current_setting('rab.actor_type'::text, true) = 'worker'::text) AND ${tenant}`;
  const ownStaff = (table: string) => `(EXISTS (SELECT 1 FROM ${q}.staff_profile sp WHERE (sp.id = ${table}.staff_profile_id) AND (sp.user_id = core.current_uid())
      AND (sp.organisation_id = core.current_org()) AND (sp.workspace_id = core.current_workspace())))`;
  const staffOfWorkspace = `(EXISTS (SELECT 1 FROM ${q}.staff_profile sp WHERE (sp.user_id = core.current_uid())
      AND (sp.organisation_id = core.current_org()) AND (sp.workspace_id = core.current_workspace())))`;
  const fkCommon = (t: string) => `
  CONSTRAINT ${t}_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE,
  CONSTRAINT ${t}_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES core.manager_workspace(id)`;
  const secure = (t: string) => `ALTER TABLE ${q}.${t} OWNER TO crewflow;
ALTER TABLE ${q}.${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${q}.${t} FORCE ROW LEVEL SECURITY;
REVOKE ALL ON ${q}.${t} FROM PUBLIC;
REVOKE ALL ON ${q}.${t} FROM crewflow_app;`;
  return `
CREATE TABLE IF NOT EXISTS ${q}.payroll_run (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  period_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'prepared',
  prepared_at timestamptz NOT NULL DEFAULT now(),
  prepared_by uuid NOT NULL,
  finalised_at timestamptz,
  finalised_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_run_pkey PRIMARY KEY (id),
  CONSTRAINT payroll_run_workspace_period_key UNIQUE (workspace_id, period_id),
  CONSTRAINT payroll_run_status_check CHECK (status IN ('prepared','finalised')),
  CONSTRAINT payroll_run_finalised_check CHECK ((status = 'finalised') = (finalised_at IS NOT NULL AND finalised_by IS NOT NULL)),${fkCommon('payroll_run')},
  CONSTRAINT payroll_run_period_id_fkey FOREIGN KEY (period_id) REFERENCES core.payroll_calendar_period(id),
  CONSTRAINT payroll_run_prepared_by_fkey FOREIGN KEY (prepared_by) REFERENCES core."user"(id),
  CONSTRAINT payroll_run_finalised_by_fkey FOREIGN KEY (finalised_by) REFERENCES core."user"(id)
);
${secure('payroll_run')}
DROP POLICY IF EXISTS payroll_run_select ON ${q}.payroll_run;
CREATE POLICY payroll_run_select ON ${q}.payroll_run AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((${tenant} AND (${payrollManager} OR ${staffOfWorkspace})) OR (${worker}));
DROP POLICY IF EXISTS payroll_run_insert ON ${q}.payroll_run;
CREATE POLICY payroll_run_insert ON ${q}.payroll_run AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (${tenant} AND ${payrollManager} AND (status = 'prepared'::text) AND (prepared_by = core.current_uid()));
DROP POLICY IF EXISTS payroll_run_update ON ${q}.payroll_run;
CREATE POLICY payroll_run_update ON ${q}.payroll_run AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (${tenant} AND ${payrollManager})
  WITH CHECK (${tenant} AND ${payrollManager});
GRANT SELECT, INSERT ON ${q}.payroll_run TO crewflow_app;
GRANT UPDATE (status, finalised_at, finalised_by, updated_at) ON ${q}.payroll_run TO crewflow_app;

CREATE TABLE IF NOT EXISTS ${q}.payroll_run_line (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  payroll_record_id uuid NOT NULL,
  staff_profile_id uuid NOT NULL,
  work_date date NOT NULL,
  original_period_id uuid,
  late_approval boolean NOT NULL DEFAULT false,
  worked_minutes integer NOT NULL,
  pay_rate_pence bigint NOT NULL,
  amount_pence bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_run_line_pkey PRIMARY KEY (id),
  CONSTRAINT payroll_run_line_record_key UNIQUE (payroll_record_id),
  CONSTRAINT payroll_run_line_figures_check CHECK (worked_minutes >= 0 AND pay_rate_pence >= 0 AND amount_pence >= 0),
  CONSTRAINT payroll_run_line_late_check CHECK ((NOT late_approval) OR original_period_id IS NOT NULL),${fkCommon('payroll_run_line')},
  CONSTRAINT payroll_run_line_run_id_fkey FOREIGN KEY (run_id) REFERENCES ${q}.payroll_run(id),
  CONSTRAINT payroll_run_line_record_id_fkey FOREIGN KEY (payroll_record_id) REFERENCES ${q}.payroll_record(id),
  CONSTRAINT payroll_run_line_staff_id_fkey FOREIGN KEY (staff_profile_id) REFERENCES ${q}.staff_profile(id),
  CONSTRAINT payroll_run_line_original_period_fkey FOREIGN KEY (original_period_id) REFERENCES core.payroll_calendar_period(id)
);
CREATE INDEX IF NOT EXISTS payroll_run_line_run_idx ON ${q}.payroll_run_line USING btree (run_id);
CREATE INDEX IF NOT EXISTS payroll_run_line_staff_idx ON ${q}.payroll_run_line USING btree (staff_profile_id);
${secure('payroll_run_line')}
DROP POLICY IF EXISTS payroll_run_line_select ON ${q}.payroll_run_line;
CREATE POLICY payroll_run_line_select ON ${q}.payroll_run_line AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((${tenant} AND (${payrollManager} OR ${ownStaff('payroll_run_line')})) OR (${worker}));
DROP POLICY IF EXISTS payroll_run_line_insert ON ${q}.payroll_run_line;
CREATE POLICY payroll_run_line_insert ON ${q}.payroll_run_line AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (${tenant} AND ${payrollManager} AND (EXISTS (
    SELECT 1 FROM ${q}.payroll_run r WHERE (r.id = payroll_run_line.run_id) AND (r.status = 'prepared'::text)
      AND (r.organisation_id = core.current_org()) AND (r.workspace_id = core.current_workspace()))) AND (EXISTS (
    SELECT 1 FROM ${q}.payroll_record pr WHERE (pr.id = payroll_run_line.payroll_record_id) AND (pr.status = 'approved'::text)
      AND (pr.staff_profile_id = payroll_run_line.staff_profile_id) AND (pr.worked_minutes = payroll_run_line.worked_minutes)
      AND (pr.amount_pence = payroll_run_line.amount_pence) AND (pr.pay_rate_pence = payroll_run_line.pay_rate_pence))));
GRANT SELECT, INSERT ON ${q}.payroll_run_line TO crewflow_app;

CREATE TABLE IF NOT EXISTS ${q}.payslip (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  staff_profile_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 0,
  net_pence bigint,
  net_source text,
  net_recorded_by uuid,
  net_recorded_at timestamptz,
  paid_at timestamptz,
  paid_by uuid,
  payment_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payslip_pkey PRIMARY KEY (id),
  CONSTRAINT payslip_run_staff_key UNIQUE (run_id, staff_profile_id),
  CONSTRAINT payslip_version_check CHECK (version >= 0),
  CONSTRAINT payslip_net_check CHECK ((net_pence IS NULL AND net_source IS NULL) OR (net_pence >= 0 AND net_source = 'provider_document' AND net_recorded_by IS NOT NULL AND net_recorded_at IS NOT NULL)),
  CONSTRAINT payslip_paid_check CHECK ((paid_at IS NULL) = (paid_by IS NULL)),
  CONSTRAINT payslip_reference_check CHECK (payment_reference IS NULL OR char_length(payment_reference) <= 120),${fkCommon('payslip')},
  CONSTRAINT payslip_run_id_fkey FOREIGN KEY (run_id) REFERENCES ${q}.payroll_run(id),
  CONSTRAINT payslip_staff_id_fkey FOREIGN KEY (staff_profile_id) REFERENCES ${q}.staff_profile(id),
  CONSTRAINT payslip_net_recorded_by_fkey FOREIGN KEY (net_recorded_by) REFERENCES core."user"(id),
  CONSTRAINT payslip_paid_by_fkey FOREIGN KEY (paid_by) REFERENCES core."user"(id)
);
CREATE INDEX IF NOT EXISTS payslip_staff_idx ON ${q}.payslip USING btree (staff_profile_id);
${secure('payslip')}
DROP POLICY IF EXISTS payslip_select ON ${q}.payslip;
CREATE POLICY payslip_select ON ${q}.payslip AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (${tenant} AND (${payrollManager} OR ${ownStaff('payslip')}));
DROP POLICY IF EXISTS payslip_insert ON ${q}.payslip;
CREATE POLICY payslip_insert ON ${q}.payslip AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (${tenant} AND ${payrollManager} AND (EXISTS (
    SELECT 1 FROM ${q}.payroll_run r WHERE (r.id = payslip.run_id) AND (r.status = 'finalised'::text)
      AND (r.organisation_id = core.current_org()) AND (r.workspace_id = core.current_workspace()))));
DROP POLICY IF EXISTS payslip_update ON ${q}.payslip;
CREATE POLICY payslip_update ON ${q}.payslip AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (${tenant} AND ${payrollManager})
  WITH CHECK (${tenant} AND ${payrollManager} AND ((paid_by IS NULL) OR (NOT ${ownStaff('payslip').replace('sp.user_id = core.current_uid()', 'sp.user_id = payslip.paid_by')})));
GRANT SELECT, INSERT ON ${q}.payslip TO crewflow_app;
GRANT UPDATE (version, net_pence, net_source, net_recorded_by, net_recorded_at, paid_at, paid_by, payment_reference, updated_at) ON ${q}.payslip TO crewflow_app;

CREATE TABLE IF NOT EXISTS ${q}.payslip_document (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  payslip_id uuid NOT NULL,
  version integer NOT NULL,
  file_id uuid NOT NULL,
  sha256 text NOT NULL,
  uploaded_by uuid NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payslip_document_pkey PRIMARY KEY (id),
  CONSTRAINT payslip_document_version_key UNIQUE (payslip_id, version),
  CONSTRAINT payslip_document_version_check CHECK (version >= 1),
  CONSTRAINT payslip_document_sha_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),${fkCommon('payslip_document')},
  CONSTRAINT payslip_document_payslip_id_fkey FOREIGN KEY (payslip_id) REFERENCES ${q}.payslip(id),
  CONSTRAINT payslip_document_file_id_fkey FOREIGN KEY (file_id) REFERENCES core.stored_file(id),
  CONSTRAINT payslip_document_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES core."user"(id)
);
${secure('payslip_document')}
DROP POLICY IF EXISTS payslip_document_select ON ${q}.payslip_document;
CREATE POLICY payslip_document_select ON ${q}.payslip_document AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (${tenant} AND (${payrollManager} OR (EXISTS (SELECT 1 FROM ${q}.payslip ps JOIN ${q}.staff_profile sp ON (sp.id = ps.staff_profile_id)
    WHERE (ps.id = payslip_document.payslip_id) AND (sp.user_id = core.current_uid()) AND (sp.workspace_id = core.current_workspace())))));
DROP POLICY IF EXISTS payslip_document_insert ON ${q}.payslip_document;
CREATE POLICY payslip_document_insert ON ${q}.payslip_document AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (${tenant} AND ${payrollManager} AND (uploaded_by = core.current_uid()));
GRANT SELECT, INSERT ON ${q}.payslip_document TO crewflow_app;

-- payroll_record: DB backstop for the state machine + statement state (replaces the human WITH CHECK clause).
DROP POLICY IF EXISTS payroll_record_update ON ${q}.payroll_record;
CREATE POLICY payroll_record_update ON ${q}.payroll_record AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (${tenant} AND ${payrollManager})
  WITH CHECK (${tenant} AND ${payrollManager} AND ${notOwnHours});
DROP TRIGGER IF EXISTS payroll_record_guard ON ${q}.payroll_record;
CREATE TRIGGER payroll_record_guard BEFORE UPDATE ON ${q}.payroll_record FOR EACH ROW EXECUTE FUNCTION core.payroll_record_guard();
`;
}
