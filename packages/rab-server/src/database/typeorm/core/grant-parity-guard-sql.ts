/**
 * Owner-login GRANT PARITY guards (OwnerLoginGrantParityGuards1786721420000; finding PAY-1, Agent 5 differential run
 * 2026-11-04). Exact SQL and the reviewed target list, shared by the migration and its specs.
 *
 * WHY. Many invariants were enforced only by what the restricted runtime login `crewflow_app` was NOT granted: payroll
 * run lines, payslip documents and calendar periods were insert-only for it; AI usage / proposal / agent tables, the
 * workspace registry and ledger were written only through SECURITY DEFINER functions; outbox and event rows were never
 * deleted by it. The table OWNER is `crewflow`, and the owner login `crewflow_owner` inherits crewflow's privileges, so on
 * a NORMAL code path (no injection) the runtime could now `UPDATE payroll_run_line SET amount_pence = …` or
 * `DELETE FROM core.payroll_calendar_period` (verified by Agent 5: payroll-runs.integration.spec.ts:410-413).
 *
 * WHAT. One trigger function, core.owner_login_grant_parity_guard() (owner crewflow, SECURITY INVOKER, pinned
 * search_path, no PUBLIC EXECUTE), attached BEFORE the operations crewflow_app lacked on each listed table:
 *   - INSERT  when crewflow_app holds no INSERT on any column of the table;
 *   - UPDATE  when crewflow_app lacks UPDATE: with NO trigger arguments when it held no UPDATE on any column (every update
 *             refused), otherwise with the exact columns it could NOT update as arguments (an update that changes one of
 *             them is refused; the columns it could update stay writable) — computed from the catalog at migration time;
 *   - DELETE  when crewflow_app lacked DELETE;
 *   - TRUNCATE (statement level) on the payroll family.
 * The guard lets through only `crewflow` and `rab_secure_owner` — i.e. their SECURITY DEFINER functions, foreign-key
 * actions (PostgreSQL runs them as the table owner), the provisioner / migrator after `SET LOCAL ROLE crewflow` — and a
 * superuser. Everyone else gets 42501 (permission denied), the same SQLSTATE crewflow_app got from the missing grant.
 * So on normal paths the owner login can do exactly what crewflow_app could, no more.
 *
 * WHAT IT DOES NOT DO (owner-accepted §2, BC-01): an injected `SET ROLE crewflow`, `ALTER TABLE … DISABLE TRIGGER` or a
 * replaced function body defeats it. The semantic posture monitor detects a disabled or re-pointed trigger and a changed
 * body afterwards. INSERT is guarded only where crewflow_app had no column INSERT at all (column-level INSERT parity is
 * not reproduced). Workspace-schema copies of the payroll tables (HWS runtime) are NOT covered by this migration: that
 * needs a workspace module version and new expected fingerprints (Agent 1) — recorded as an open item.
 *
 * Exclusions (reviewed): core.migrations (the migration runner, as the owner login, writes the ledger), core.permission
 * (reference data written by the seed commands), core.audit_log (its UPDATE / DELETE / TRUNCATE are revoked from the
 * owner crewflow itself, so the owner login is already refused on normal paths), rab_secure_owner-owned tables (M-T1
 * FORCE + their own policies; column-level secret grants are catalogue BC-13, NEEDS OWNER APPROVAL), sequences.
 */
export const GRANT_PARITY_FUNCTION = 'core.owner_login_grant_parity_guard()';

export type ParityOp = 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE';

/** Derived from the posture golden at 1786721410000: crewflow-owned core tables and the operations crewflow_app lacked. */
export const GRANT_PARITY_TARGETS: Readonly<Record<string, readonly ParityOp[]>> = Object.freeze({
  ai_action_proposal: ['INSERT', 'UPDATE', 'DELETE'],
  ai_agent: ['INSERT', 'UPDATE', 'DELETE'],
  ai_agent_event: ['INSERT', 'UPDATE', 'DELETE'],
  ai_agent_trigger: ['INSERT', 'UPDATE'],
  ai_conversation: ['UPDATE'],
  ai_input_request: ['INSERT', 'UPDATE', 'DELETE'],
  ai_message: ['UPDATE', 'DELETE'],
  ai_skill: ['INSERT', 'UPDATE'],
  ai_usage: ['INSERT', 'UPDATE', 'DELETE'],
  ai_usage_daily: ['UPDATE', 'DELETE'],
  email_outbox: ['DELETE'],
  host_label_claim: ['INSERT', 'UPDATE', 'DELETE'],
  hws_backfill_checkpoint: ['DELETE'],
  navigation_layout: ['DELETE'],
  oauth_transaction_state: ['DELETE'],
  organisation_ai_assistant: ['INSERT', 'UPDATE'],
  organisation_ai_instruction: ['INSERT', 'UPDATE'],
  organisation_ai_model_policy: ['INSERT', 'UPDATE'],
  organisation_ai_model_preference: ['INSERT', 'UPDATE'],
  organisation_ai_setting: ['INSERT', 'UPDATE', 'DELETE'],
  payroll_calendar: ['UPDATE', 'DELETE', 'TRUNCATE'],
  payroll_calendar_period: ['UPDATE', 'DELETE', 'TRUNCATE'],
  payroll_record: ['UPDATE', 'DELETE', 'TRUNCATE'],
  payroll_run: ['UPDATE', 'DELETE', 'TRUNCATE'],
  payroll_run_line: ['UPDATE', 'DELETE', 'TRUNCATE'],
  payslip: ['UPDATE', 'DELETE', 'TRUNCATE'],
  payslip_document: ['UPDATE', 'DELETE', 'TRUNCATE'],
  push_delivery: ['DELETE'],
  realtime_event: ['DELETE'],
  reserved_host_label: ['INSERT', 'UPDATE', 'DELETE'],
  shift_staff_review: ['DELETE'],
  stored_file: ['DELETE'],
  worker_event: ['DELETE'],
  workspace_membership: ['DELETE'],
  workspace_schema_migration: ['INSERT', 'UPDATE', 'DELETE'],
  workspace_schema_registry: ['INSERT', 'UPDATE', 'DELETE'],
});

export const GRANT_PARITY_FUNCTION_SQL = `CREATE FUNCTION core.owner_login_grant_parity_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
DECLARE
  c text;
BEGIN
  IF current_user IN ('crewflow'::name, 'rab_secure_owner'::name)
     OR coalesce((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false) THEN
    IF TG_LEVEL = 'STATEMENT' THEN RETURN NULL; END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND TG_NARGS > 0 THEN
    FOREACH c IN ARRAY TG_ARGV LOOP
      IF (pg_catalog.to_jsonb(NEW) -> c) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) -> c) THEN
        RAISE EXCEPTION 'permission denied: column % of %.% is not writable by the runtime login (grant parity)', c, TG_TABLE_SCHEMA, TG_TABLE_NAME
          USING ERRCODE = '42501';
      END IF;
    END LOOP;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'permission denied: % on %.% is not permitted for the runtime login (grant parity)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = '42501';
END;
$guard$`;

export const triggerName = (table: string, op: ParityOp) => `${table}_grant_parity_${op.toLowerCase()}`;

/** crewflow_app's privileges on the target tables, read at migration time (the source of the UPDATE column lists). */
export const GRANT_PARITY_FACTS_SQL = `
SELECT c.relname::text AS tbl, pg_catalog.pg_get_userbyid(c.relowner)::text AS owner,
       pg_catalog.has_table_privilege('crewflow_app', c.oid, 'INSERT') AS app_insert,
       pg_catalog.has_any_column_privilege('crewflow_app', c.oid, 'INSERT') AS app_any_insert,
       pg_catalog.has_table_privilege('crewflow_app', c.oid, 'UPDATE') AS app_update,
       pg_catalog.has_table_privilege('crewflow_app', c.oid, 'DELETE') AS app_delete,
       pg_catalog.has_table_privilege('crewflow_app', c.oid, 'TRUNCATE') AS app_truncate,
       coalesce((SELECT pg_catalog.array_agg(a.attname::text ORDER BY a.attnum) FROM pg_catalog.pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                    AND NOT pg_catalog.has_column_privilege('crewflow_app', c.oid, a.attnum, 'UPDATE')), ARRAY[]::text[]) AS protected_columns,
       coalesce((SELECT pg_catalog.count(*) FROM pg_catalog.pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), 0)::int AS column_count
  FROM pg_catalog.pg_class c
 WHERE c.relnamespace = 'core'::regnamespace AND c.relkind = 'r' AND c.relname = ANY ($1::text[])
 ORDER BY 1`;

export interface GrantParityFacts {
  tbl: string;
  owner: string;
  app_insert: boolean;
  app_any_insert: boolean;
  app_update: boolean;
  app_delete: boolean;
  app_truncate: boolean;
  protected_columns: string[];
  column_count: number;
}

const quoteLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * The trigger DDL for one table, from its live facts. Throws when the reviewed list no longer matches crewflow_app's
 * grants (a later migration granted it something): the list must then be reviewed, never silently guarded.
 */
export function grantParityTriggerSql(table: string, ops: readonly ParityOp[], f: GrantParityFacts | undefined): string[] {
  if (!f) throw new Error(`core.${table} is missing`);
  if (f.owner !== 'crewflow') throw new Error(`core.${table} is owned by ${f.owner}, not crewflow`);
  const out: string[] = [];
  const name = (op: ParityOp) => triggerName(table, op);
  const on = `ON core."${table}"`;
  for (const op of ops) {
    if (op === 'INSERT') {
      if (f.app_any_insert) throw new Error(`core.${table}: crewflow_app holds INSERT on some column; review the parity list`);
      out.push(`CREATE TRIGGER ${name(op)} BEFORE INSERT ${on} FOR EACH ROW EXECUTE FUNCTION ${GRANT_PARITY_FUNCTION}`);
    } else if (op === 'UPDATE') {
      if (f.app_update) throw new Error(`core.${table}: crewflow_app holds table UPDATE; review the parity list`);
      const all = f.protected_columns.length === f.column_count;
      if (f.protected_columns.length === 0) throw new Error(`core.${table}: crewflow_app can update every column; review the parity list`);
      const args = all ? '' : f.protected_columns.map(quoteLiteral).join(', ');
      out.push(`CREATE TRIGGER ${name(op)} BEFORE UPDATE ${on} FOR EACH ROW EXECUTE FUNCTION core.owner_login_grant_parity_guard(${args})`);
    } else if (op === 'DELETE') {
      if (f.app_delete) throw new Error(`core.${table}: crewflow_app holds DELETE; review the parity list`);
      out.push(`CREATE TRIGGER ${name(op)} BEFORE DELETE ${on} FOR EACH ROW EXECUTE FUNCTION ${GRANT_PARITY_FUNCTION}`);
    } else {
      if (f.app_truncate) throw new Error(`core.${table}: crewflow_app holds TRUNCATE; review the parity list`);
      out.push(`CREATE TRIGGER ${name(op)} BEFORE TRUNCATE ${on} FOR EACH STATEMENT EXECUTE FUNCTION ${GRANT_PARITY_FUNCTION}`);
    }
  }
  return out;
}

/** End-state check: every expected trigger exists, is enabled (O) and calls the guard. */
export const GRANT_PARITY_TRIGGERS_SQL = `
SELECT c.relname::text AS tbl, t.tgname::text AS trg, t.tgenabled::text AS enabled, t.tgfoid::regprocedure::text AS fn
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
 WHERE c.relnamespace = 'core'::regnamespace AND NOT t.tgisinternal AND t.tgname LIKE '%\\_grant\\_parity\\_%'
 ORDER BY 1, 2`;

export function grantParityEndProblems(rows: Array<{ tbl: string; trg: string; enabled: string; fn: string }>): string[] {
  const p: string[] = [];
  for (const [table, ops] of Object.entries(GRANT_PARITY_TARGETS)) {
    for (const op of ops) {
      const r = rows.find((x) => x.tbl === table && x.trg === triggerName(table, op));
      if (!r) p.push(`core.${table}: trigger ${triggerName(table, op)} missing`);
      else if (r.enabled !== 'O' || r.fn !== 'core.owner_login_grant_parity_guard()') p.push(`core.${table}: ${r.trg} enabled=${r.enabled} fn=${r.fn}`);
    }
  }
  const expected = Object.values(GRANT_PARITY_TARGETS).reduce((n, ops) => n + ops.length, 0);
  if (rows.length !== expected) p.push(`expected ${expected} grant-parity triggers, found ${rows.length}`);
  return p;
}
