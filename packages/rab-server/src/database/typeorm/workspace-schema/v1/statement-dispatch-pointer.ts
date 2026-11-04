// sql-injection-reviewed-file: SQL definition / check module (database layer). Every interpolation is a code constant of this repository (table, function, role and policy names, numeric limits) or a validated identifier; no request or row data reaches these templates. Reviewed 2026-11-04 (owner-login SQL-injection lint).
/**
 * Frozen SQL shipped with migration StatementDispatchPointer1786721320000 (module v1.019; applied to `core` by that
 * migration and to every workspace schema by WorkspaceSchemaMigrator / both provisioning paths after module 18). Never
 * edit after merge. Owner-approved 2026-11-01 after the v19 fingerprint sign-off; run on disposable test databases only.
 *
 * Phase D (D1): the Approved Shift Statement dispatcher's due rows live in `payroll_record` — in `core` and, under HWS, in
 * every `workspace_<hex>` schema — so a global claim needs a routing pointer per due record. Three AFTER ROW triggers on
 * `payroll_record` call `core.worker_dispatch_pointer_statement_trg()` (SECURITY DEFINER, rab_secure_owner, created by
 * 1786721320000 before this module runs), which mirrors the dispatcher's DUE_SQL (shift-statement.job.ts) into
 * `core.worker_dispatch_pointer.due_at`, deletes the pointer when the record is no longer due, refuses a scope change and
 * NOTIFYs `crewflow_worker_wake` 'statement' when the record becomes due now and the writing session enabled
 * `crewflow.dispatch_notify` (E-1). A fourth, statement-level AFTER TRUNCATE trigger (E-4) removes that schema's
 * statement pointers (all statement pointers for `core`). Lock waits are bounded by the applying migration / migrator
 * (lock_timeout, E-8), never by this module.
 *
 * Nothing else changes: no table, column, index, policy, grant, RLS flag or CHECK. The WHEN clauses run as the writing role
 * (built-in comparisons only) and only decide whether the function fires; they never widen what it may do.
 */
export function statementDispatchPointerSql(schema: string): string {
  if (schema !== 'core' && !/^workspace_[0-9a-f]{32}$/.test(schema)) throw new Error('Invalid workspace schema');
  const t = `${schema === 'core' ? 'core' : `"${schema}"`}.payroll_record`;
  const fn = 'core.worker_dispatch_pointer_statement_trg()';
  return `
DROP TRIGGER IF EXISTS payroll_record_statement_pointer_ins ON ${t};
CREATE TRIGGER payroll_record_statement_pointer_ins AFTER INSERT ON ${t}
  FOR EACH ROW WHEN (NEW.status IN ('approved', 'processing', 'paid') AND NEW.statement_file_id IS NULL)
  EXECUTE FUNCTION ${fn};
DROP TRIGGER IF EXISTS payroll_record_statement_pointer_upd ON ${t};
CREATE TRIGGER payroll_record_statement_pointer_upd AFTER UPDATE ON ${t}
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.statement_status IS DISTINCT FROM NEW.statement_status
    OR OLD.statement_file_id IS DISTINCT FROM NEW.statement_file_id OR OLD.statement_attempts IS DISTINCT FROM NEW.statement_attempts
    OR OLD.statement_queued_at IS DISTINCT FROM NEW.statement_queued_at
    OR OLD.statement_processing_at IS DISTINCT FROM NEW.statement_processing_at
    OR (NEW.statement_status IN ('queued', 'processing', 'failed') AND OLD.updated_at IS DISTINCT FROM NEW.updated_at)
    OR OLD.id IS DISTINCT FROM NEW.id OR OLD.organisation_id IS DISTINCT FROM NEW.organisation_id
    OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id)
  EXECUTE FUNCTION ${fn};
DROP TRIGGER IF EXISTS payroll_record_statement_pointer_del ON ${t};
CREATE TRIGGER payroll_record_statement_pointer_del AFTER DELETE ON ${t}
  FOR EACH ROW WHEN (OLD.status IN ('approved', 'processing', 'paid') AND OLD.statement_file_id IS NULL)
  EXECUTE FUNCTION ${fn};
DROP TRIGGER IF EXISTS payroll_record_statement_pointer_trunc ON ${t};
CREATE TRIGGER payroll_record_statement_pointer_trunc AFTER TRUNCATE ON ${t}
  FOR EACH STATEMENT EXECUTE FUNCTION ${fn};
`;
}

/** The four trigger names module v1.019 creates on each `payroll_record` (posture `ws|trigger|` lines, invariants). */
export const STATEMENT_POINTER_TRIGGER_NAMES = [
  'payroll_record_statement_pointer_del',
  'payroll_record_statement_pointer_ins',
  'payroll_record_statement_pointer_trunc',
  'payroll_record_statement_pointer_upd',
] as const;
