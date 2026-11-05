// sql-injection-reviewed-file: SQL definition / check module (database layer). Every interpolation is a code constant of this repository (table, function, role and policy names, numeric limits) or a validated identifier; no request or row data reaches these templates. Reviewed 2026-11-04 (owner-login SQL-injection lint).
/**
 * FROZEN with migration WorkspaceGrantParityGuards1786721430000 (workspace module v1.020; never edited after merge).
 *
 * PAY-1, workspace copies: the owner-login grant-parity guards of OwnerLoginGrantParityGuards1786721420000 (core) attached
 * to the workspace-schema copies of the payroll tables, where the HWS runtime reads and writes them. In every
 * `workspace_<hex>` schema the runtime login crewflow_owner inherits the table owner crewflow's privileges; crewflow_app's
 * workspace grants (identical to core's — tools/check-rls-coverage.ts) are what these triggers reproduce on normal paths:
 *   - payroll_record, payroll_run, payslip: UPDATE only of the columns crewflow_app may update (allow-list, literal below);
 *   - payroll_run_line, payslip_document: no UPDATE at all (insert-only);
 *   - all five: no DELETE, no TRUNCATE; shift_staff_review: no DELETE.
 * The guard function core.owner_login_grant_parity_guard() lets crewflow, rab_secure_owner (definers, FK actions,
 * SET LOCAL ROLE crewflow) and superusers through; everyone else gets 42501.
 *
 * The allow-lists are the literal crewflow_app column grants of the workspace modules (payroll-record.ts, pay-statement.ts,
 * approved-shift-statement.ts, payroll-runs.ts). The applying migration re-checks them against crewflow_app's live column
 * privileges on the core counterparts and refuses on any difference (never a silent guard).
 *
 * Nothing else changes: no table, column, index, policy, grant, RLS flag or CHECK; triggers only (the per-version
 * fingerprint covers them). Injection is not covered (BC-01).
 *
 * Re-frozen in place 2026-11-04 (owner-approved PAY-1b; v20 had run only on disposable databases): DELETE, and UPDATE of
 * a table with an empty allow-list, are refused per STATEMENT (a statement RLS leaves with no row is refused too, like
 * the missing privilege); the allow-list UPDATE guards stay per ROW. Every name starts with `_` so the row guard fires
 * before any other BEFORE UPDATE row trigger (core/grant-parity-guard-sql.ts triggerName).
 */
export const WORKSPACE_PARITY_UPDATABLE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  payroll_record: [
    'status',
    'approved_at',
    'approved_by',
    'rejected_at',
    'rejected_by',
    'rejection_reason',
    'updated_at',
    'statement_status',
    'statement_file_id',
    'statement_generated_at',
    'statement_notified_at',
    'statement_attempts',
    'statement_error',
    'statement_dispatch_generation',
    'statement_queued_at',
    'statement_processing_at',
  ],
  payroll_run: ['status', 'finalised_at', 'finalised_by', 'updated_at'],
  payroll_run_line: [],
  payslip: ['version', 'net_pence', 'net_source', 'net_recorded_by', 'net_recorded_at', 'paid_at', 'paid_by', 'payment_reference', 'updated_at'],
  payslip_document: [],
});

/** Tables guarded for DELETE only. */
export const WORKSPACE_PARITY_DELETE_ONLY: readonly string[] = Object.freeze(['shift_staff_review']);

const FN = 'core.owner_login_grant_parity_guard';

export function workspaceGrantParitySql(schema: string): string {
  if (!/^workspace_[0-9a-f]{32}$/.test(schema)) throw new Error('Invalid workspace schema');
  const q = `"${schema}"`;
  const out: string[] = [];
  for (const [table, updatable] of Object.entries(WORKSPACE_PARITY_UPDATABLE)) {
    const t = `${q}.${table}`;
    const args = updatable.map((c) => `'${c}'`).join(', ');
    out.push(
      `DROP TRIGGER IF EXISTS _${table}_grant_parity_update ON ${t}`,
      updatable.length === 0
        ? `CREATE TRIGGER _${table}_grant_parity_update BEFORE UPDATE ON ${t} FOR EACH STATEMENT EXECUTE FUNCTION ${FN}()`
        : `CREATE TRIGGER _${table}_grant_parity_update BEFORE UPDATE ON ${t} FOR EACH ROW EXECUTE FUNCTION ${FN}(${args})`,
      `DROP TRIGGER IF EXISTS _${table}_grant_parity_delete ON ${t}`,
      `CREATE TRIGGER _${table}_grant_parity_delete BEFORE DELETE ON ${t} FOR EACH STATEMENT EXECUTE FUNCTION ${FN}()`,
      `DROP TRIGGER IF EXISTS _${table}_grant_parity_truncate ON ${t}`,
      `CREATE TRIGGER _${table}_grant_parity_truncate BEFORE TRUNCATE ON ${t} FOR EACH STATEMENT EXECUTE FUNCTION ${FN}()`,
    );
  }
  for (const table of WORKSPACE_PARITY_DELETE_ONLY) {
    const t = `${q}.${table}`;
    out.push(
      `DROP TRIGGER IF EXISTS _${table}_grant_parity_delete ON ${t}`,
      `CREATE TRIGGER _${table}_grant_parity_delete BEFORE DELETE ON ${t} FOR EACH STATEMENT EXECUTE FUNCTION ${FN}()`,
    );
  }
  return `\n${out.join(';\n')};\n`;
}
