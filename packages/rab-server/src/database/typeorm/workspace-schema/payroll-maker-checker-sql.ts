// sql-injection-reviewed-file: SQL definition / check module (database layer). Every interpolation is a code constant of this repository (function, policy and column names, md5 constants); no request or row data reaches these templates.
/**
 * DRAFT — NEW SQL, owner SQL review FIRST (owner decision 5, review of #335). The database layer of "the approver is never the
 * person who prepared the pay", used by migration PayrollMakerCheckerBackstop1786723020000:
 *  1. `core.payroll_record_guard()` (ONE function, the BEFORE UPDATE trigger of core.payroll_record AND of every
 *     workspace_*.payroll_record) gains a check: when `approved_by` is set or changed, it must not be the person who finalised
 *     the record's shift report (`shift_report.finalised_by`) nor the one who reviewed its attendance
 *     (`shift_assignment.attendance_reviewed_by`), read in the trigger's own schema (TG_TABLE_SCHEMA). 42501 otherwise. Only
 *     the moment of approval is checked, so rows approved before this rule are never blocked by later updates.
 *  2. `payroll_run_update` on core.payroll_run: WITH CHECK also requires a finalised run's `finalised_by` <> `prepared_by`.
 *     (The `workspace_*` copies of this policy need a 0.7.0 structure level and follow with the 0.7.0 chain.)
 * The rest of the guard body is byte-for-byte the 1786719200000 body.
 */

/** The 1786719200000 body of core.payroll_record_guard() (prosrc, exact). */
export const PAYROLL_RECORD_GUARD_BODY_BEFORE = `
DECLARE
  is_worker boolean := current_setting('rab.actor_type', true) = 'worker';
  retry boolean := OLD.statement_status = 'failed' AND NEW.statement_status = 'pending';
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF is_worker OR NOT ((OLD.status, NEW.status) IN (('draft','pending_approval'), ('pending_approval','approved'), ('pending_approval','rejected'),
        ('approved','processing'), ('processing','paid'), ('processing','corrected'), ('paid','corrected'), ('rejected','draft'))) THEN
      RAISE EXCEPTION 'payroll_record status % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NOT is_worker THEN
    IF NEW.statement_file_id IS DISTINCT FROM OLD.statement_file_id OR NEW.statement_generated_at IS DISTINCT FROM OLD.statement_generated_at
      OR NEW.statement_notified_at IS DISTINCT FROM OLD.statement_notified_at OR NEW.statement_dispatch_generation IS DISTINCT FROM OLD.statement_dispatch_generation
      OR NEW.statement_queued_at IS DISTINCT FROM OLD.statement_queued_at OR NEW.statement_processing_at IS DISTINCT FROM OLD.statement_processing_at
      OR (NEW.statement_status IS DISTINCT FROM OLD.statement_status AND NOT ((OLD.statement_status = 'none' AND NEW.statement_status = 'pending') OR retry))
      OR (NEW.statement_attempts IS DISTINCT FROM OLD.statement_attempts AND NOT (retry AND NEW.statement_attempts = 0))
      OR (NEW.statement_error IS DISTINCT FROM OLD.statement_error AND NOT (retry AND NEW.statement_error IS NULL)) THEN
      RAISE EXCEPTION 'statement state is written by the worker only' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
`;

/** The new body: the old one plus the maker-checker block before RETURN NEW. */
export const PAYROLL_RECORD_GUARD_BODY_AFTER = PAYROLL_RECORD_GUARD_BODY_BEFORE.replace(
  `DECLARE
  is_worker boolean`,
  `DECLARE
  prepared boolean;
  is_worker boolean`,
).replace(
  `  RETURN NEW;
END
`,
  `  -- Owner decision 5 (maker-checker): the approver never finalised the shift report nor reviewed the attendance.
  IF NEW.approved_by IS NOT NULL AND NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %1$I.shift_report sr WHERE sr.shift_id = $1 AND sr.finalised_by = $3)'
                   ' OR EXISTS (SELECT 1 FROM %1$I.attendance a JOIN %1$I.shift_assignment sa ON sa.id = a.shift_assignment_id'
                   ' WHERE a.id = $2 AND sa.attendance_reviewed_by = $3)', TG_TABLE_SCHEMA)
      INTO prepared USING NEW.shift_id, NEW.attendance_id, NEW.approved_by;
    IF prepared THEN
      RAISE EXCEPTION 'payroll_record approver prepared these hours' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
`,
);

/** CREATE OR REPLACE keeps the function's owner (crewflow), ACL and the triggers that call it. */
export function payrollRecordGuardSql(body: string): string {
  return `CREATE OR REPLACE FUNCTION core.payroll_record_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, core AS $fn$${body}$fn$`;
}

const RUN_UPDATE_BASE = `(organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()) AND (EXISTS ( SELECT 1 FROM core.manager_profile mp WHERE ((mp.user_id = core.current_uid()) AND (mp.organisation_id = core.current_org()) AND (mp.workspace_id = core.current_workspace()) AND (mp.type <> 'venue'::text))))`;

/** core.payroll_run's payroll_run_update WITH CHECK before (1786719200000; equal to its USING) and after. */
export const CORE_PAYROLL_RUN_UPDATE_CHECK_BEFORE_DEPARSED = `(${RUN_UPDATE_BASE})`;
export const CORE_PAYROLL_RUN_UPDATE_CHECK_AFTER_DEPARSED = `(${RUN_UPDATE_BASE} AND ((status <> 'finalised'::text) OR (finalised_by <> prepared_by)))`;

export function payrollRunUpdatePolicySql(after: boolean): string {
  return `ALTER POLICY payroll_run_update ON core.payroll_run WITH CHECK ${after ? CORE_PAYROLL_RUN_UPDATE_CHECK_AFTER_DEPARSED : CORE_PAYROLL_RUN_UPDATE_CHECK_BEFORE_DEPARSED}`;
}

/** Catalog state: the guard's body hash (the semantic goldens' `body=`) and the run policy's hashes. */
export const PAYROLL_MAKER_CHECKER_STATE_SQL = `SELECT
  (SELECT pg_catalog.md5(coalesce(p.prosrc, '') || '|' || coalesce(pg_catalog.pg_get_function_sqlbody(p.oid), ''))
     FROM pg_catalog.pg_proc p WHERE p.oid = 'core.payroll_record_guard()'::pg_catalog.regprocedure) AS guard_body_hash,
  (SELECT pg_catalog.md5(pg_catalog.regexp_replace(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '\\s+', ' ', 'g'))
     FROM pg_catalog.pg_policy p WHERE p.polrelid = 'core.payroll_run'::pg_catalog.regclass AND p.polname = 'payroll_run_update') AS run_using_hash,
  (SELECT pg_catalog.md5(pg_catalog.regexp_replace(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '\\s+', ' ', 'g'))
     FROM pg_catalog.pg_policy p WHERE p.polrelid = 'core.payroll_run'::pg_catalog.regclass AND p.polname = 'payroll_run_update') AS run_check_hash`;

export const PAYROLL_MAKER_CHECKER_HASHES = Object.freeze({
  guardBodyBefore: '6493c13974ec4c47975a703bade22f0a',
  guardBodyAfter: '2c3915061a4c098c3f064816d5a3e22f',
  runUsing: 'de27c66e727763f94d047d16e9656077',
  runCheckBefore: 'de27c66e727763f94d047d16e9656077',
  runCheckAfter: 'ade0d170c86d51a5f9f663125bab36ee',
});

/** The restricted-migrator's reviewed privilege drift for PayrollMakerCheckerBackstop1786723020000 (the policy line). */
export const CORE_PAYROLL_MAKER_CHECKER_REVIEWED_DRIFT: readonly string[] = Object.freeze([
  `- policy|payroll_run|payroll_run_update|w|permissive=true|roles=public|using=${CORE_PAYROLL_RUN_UPDATE_CHECK_BEFORE_DEPARSED}|check=${CORE_PAYROLL_RUN_UPDATE_CHECK_BEFORE_DEPARSED}`,
  `+ policy|payroll_run|payroll_run_update|w|permissive=true|roles=public|using=${CORE_PAYROLL_RUN_UPDATE_CHECK_BEFORE_DEPARSED}|check=${CORE_PAYROLL_RUN_UPDATE_CHECK_AFTER_DEPARSED}`,
]);
