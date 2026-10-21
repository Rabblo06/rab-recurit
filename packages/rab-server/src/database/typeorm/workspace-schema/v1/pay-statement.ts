/**
 * Frozen SQL shipped with migration 1786719000000 (and applied by the provisioner after `payrollRecordSql`).
 *
 * Pay statement (owner decision 2026-10-21): approving a payroll record requests ONE PDF "pay statement" built only
 * from that record's frozen figures. The worker renders it, stores it (core.stored_file, kind PAY_STATEMENT_PDF,
 * resource payroll_record/<id>) and notifies the staff member. Approval, document and notification are three separate
 * states, never inferred from each other:
 *   - approval:      payroll_record.status / approved_at (unchanged)
 *   - document:      statement_status none | pending | generated | failed, statement_file_id, statement_generated_at,
 *                    statement_attempts, statement_error (a fixed safe code, never a driver message)
 *   - notification:  statement_notified_at, set only once an in-app notification row really exists
 *
 * RLS: `payroll_record_update` (humans) is re-created with one extra WITH CHECK clause — a human session can at most
 * REQUEST a statement (none / pending, no file, no notification); only the worker can record a generated document or a
 * notification. Two worker-only policies (same shape as staff_profile_worker_scan /
 * shift_staff_review_worker_scan): `rab.actor_type = 'worker'` AND tenant; UPDATE additionally only on approved /
 * processing / paid rows and only keeping them there. User sessions never carry the worker marker.
 * Grants: the runtime role gains UPDATE on the statement columns only (the money snapshot stays immutable).
 */
import { payrollRecordPredicates } from './payroll-record';

export function payStatementSql(schema: string): string {
  if (schema !== 'core' && !/^workspace_[0-9a-f]{32}$/.test(schema)) throw new Error('Invalid workspace schema');
  const q = schema === 'core' ? 'core' : `"${schema}"`;
  const t = `${q}.payroll_record`;
  const worker = `(current_setting('rab.actor_type'::text, true) = 'worker'::text) AND (organisation_id = core.current_org()) AND (workspace_id = core.current_workspace())`;
  const { tenant, payrollManager, notOwnHours } = payrollRecordPredicates(q);
  const humanStatementState = `((statement_status = ANY (ARRAY['none'::text, 'pending'::text])) AND (statement_file_id IS NULL) AND (statement_generated_at IS NULL) AND (statement_notified_at IS NULL))`;
  const approvedish = `(status = ANY (ARRAY['approved'::text, 'processing'::text, 'paid'::text]))`;
  return `
ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS statement_status text NOT NULL DEFAULT 'none';
ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS statement_file_id uuid;
ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS statement_generated_at timestamptz;
ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS statement_notified_at timestamptz;
ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS statement_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS statement_error text;
ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS payroll_record_statement_status_check;
ALTER TABLE ${t} ADD CONSTRAINT payroll_record_statement_status_check CHECK (statement_status IN ('none','pending','generated','failed'));
ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS payroll_record_statement_state_check;
ALTER TABLE ${t} ADD CONSTRAINT payroll_record_statement_state_check CHECK (
  (statement_status = 'generated') = (statement_file_id IS NOT NULL AND statement_generated_at IS NOT NULL)
  AND (statement_status = 'none' OR status IN ('approved','processing','paid','corrected'))
  AND (statement_notified_at IS NULL OR statement_status = 'generated')
  AND statement_attempts >= 0
  AND (statement_error IS NULL OR char_length(statement_error) <= 64));
ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS payroll_record_statement_file_id_fkey;
ALTER TABLE ${t} ADD CONSTRAINT payroll_record_statement_file_id_fkey FOREIGN KEY (statement_file_id) REFERENCES core.stored_file(id);
CREATE INDEX IF NOT EXISTS payroll_record_statement_due_idx ON ${t} USING btree (statement_status) WHERE (statement_status = ANY (ARRAY['pending'::text, 'failed'::text]));

DROP POLICY IF EXISTS payroll_record_update ON ${t};
CREATE POLICY payroll_record_update ON ${t} AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (${tenant} AND ${payrollManager})
  WITH CHECK (${tenant} AND ${payrollManager} AND ${notOwnHours} AND ${humanStatementState});

DROP POLICY IF EXISTS payroll_record_worker_select ON ${t};
CREATE POLICY payroll_record_worker_select ON ${t} AS PERMISSIVE FOR SELECT TO PUBLIC USING (${worker});
DROP POLICY IF EXISTS payroll_record_worker_update ON ${t};
CREATE POLICY payroll_record_worker_update ON ${t} AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (${worker} AND ${approvedish})
  WITH CHECK (${worker} AND ${approvedish});

GRANT UPDATE (statement_status, statement_file_id, statement_generated_at, statement_notified_at, statement_attempts, statement_error) ON ${t} TO crewflow_app;
`;
}
