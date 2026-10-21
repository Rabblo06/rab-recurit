/**
 * Frozen SQL shipped with migration 1786719100000 (and applied by the provisioner after `payStatementSql`).
 *
 * Owner scope update 2026-10-21: the per-shift document released on payroll approval is the "Approved Shift Statement"
 * (never a payslip), and its generation goes through the durable outbox + BullMQ pattern:
 *   approval commits `statement_status = 'pending'` in the SAME transaction (the durable event) → the worker dispatcher
 *   claims it (`queued`, `statement_dispatch_generation` bumped, `statement_queued_at`) and publishes a BullMQ job →
 *   the processor marks `processing` (`statement_processing_at`), renders, stores, marks `generated` and notifies.
 *   Reconciliation: the dispatcher also re-queues stale `queued`/`processing` rows (lease expired), retryable `failed`
 *   rows, and approved records that never had a statement requested (`none`), so a lost job or a Redis outage only
 *   delays a statement, never loses it.
 * The status values widen; the new columns are worker-writable only (column grant to the runtime role, human UPDATE
 * policy still limited to none/pending with no file/notification — see payStatementSql).
 */
export function approvedShiftStatementSql(schema: string): string {
  if (schema !== 'core' && !/^workspace_[0-9a-f]{32}$/.test(schema)) throw new Error('Invalid workspace schema');
  const t = `${schema === 'core' ? 'core' : `"${schema}"`}.payroll_record`;
  return `
ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS statement_dispatch_generation integer NOT NULL DEFAULT 0;
ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS statement_queued_at timestamptz;
ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS statement_processing_at timestamptz;
ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS payroll_record_statement_status_check;
ALTER TABLE ${t} ADD CONSTRAINT payroll_record_statement_status_check
  CHECK (statement_status IN ('none','pending','queued','processing','generated','failed'));
ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS payroll_record_statement_dispatch_check;
ALTER TABLE ${t} ADD CONSTRAINT payroll_record_statement_dispatch_check CHECK (statement_dispatch_generation >= 0);
DROP INDEX IF EXISTS ${schema === 'core' ? 'core' : `"${schema}"`}.payroll_record_statement_due_idx;
CREATE INDEX IF NOT EXISTS payroll_record_statement_due_idx ON ${t} USING btree (statement_status)
  WHERE (statement_status <> 'generated'::text);
GRANT UPDATE (statement_dispatch_generation, statement_queued_at, statement_processing_at) ON ${t} TO crewflow_app;
`;
}
