// sql-injection-reviewed-file: SQL definition / check module (database layer). Every interpolation is a code constant of this repository (function, table, action and column names, md5 constants); no request or row data reaches these templates.
/**
 * DRAFT — NEW SQL, owner SQL review FIRST (owner decision 5; independent reviews of #335). The database layer of "the approver
 * is never the person who prepared the pay", used by migration PayrollMakerCheckerBackstop1786723020000.
 *
 * `core.payroll_record_guard()` is ONE function: the BEFORE UPDATE trigger of core.payroll_record AND of every
 * workspace_*.payroll_record, so this covers both copies without a workspace structure level. It gains:
 *  - on the move to `approved` (NEW.status = 'approved', OLD.status <> 'approved'): `approved_by` must be the signed-in caller
 *    (core.current_uid(); no worker exemption — the worker never writes approved_by, and the worker marker is a plain GUC);
 *    the record's finalised shift report and its attendance seat must be readable in the trigger's schema with a non-null
 *    finaliser and reviewer (fail closed); the approver is neither of them; AND, because those live columns are writable by
 *    managers, the insert-only `core.audit_log` must hold the report's finalisation and the seat's review, and no such
 *    history row may name the approver as actor (so re-pointing `finalised_by` / clearing `attendance_reviewed_by` after the
 *    fact does not help);
 *  - outside that move, `approved_by` never changes (42501).
 * Rows approved before this rule are never re-checked (only the move to approved is). The rest of the body is byte-for-byte
 * the 1786719200000 body. The payroll_run finaliser rule (core + workspace copies) ships with the 0.7.0 chain.
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

/** Variables the maker-checker block adds to DECLARE. */
export const PAYROLL_RECORD_GUARD_DECLARE_ADDED = `  report_id uuid;
  finaliser uuid;
  seat_id uuid;
  reviewer uuid;
`;

/** The maker-checker block (inserted before RETURN NEW). */
export const PAYROLL_RECORD_GUARD_BLOCK = `  -- Owner decision 5 (maker-checker): checked on the move to approved; approved_by changes nowhere else.
  IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved' THEN
    IF NEW.approved_by IS NULL OR NEW.approved_by IS DISTINCT FROM core.current_uid() THEN
      RAISE EXCEPTION 'payroll_record approver must be the signed-in caller' USING ERRCODE = '42501';
    END IF;
    EXECUTE format('SELECT sr.id, sr.finalised_by, sa.id, sa.attendance_reviewed_by FROM (SELECT 1) one'
                   ' LEFT JOIN %1$I.shift_report sr ON sr.shift_id = $1 AND sr.status = ''finalised'''
                   ' LEFT JOIN %1$I.attendance a ON a.id = $2'
                   ' LEFT JOIN %1$I.shift_assignment sa ON sa.id = a.shift_assignment_id', TG_TABLE_SCHEMA)
      INTO report_id, finaliser, seat_id, reviewer USING NEW.shift_id, NEW.attendance_id;
    IF report_id IS NULL OR seat_id IS NULL OR finaliser IS NULL OR reviewer IS NULL
       OR finaliser = NEW.approved_by OR reviewer = NEW.approved_by
       OR NOT EXISTS (SELECT 1 FROM core.audit_log al WHERE al.organisation_id = NEW.organisation_id
                        AND al.action = 'attendance.report_finalised' AND al.entity_type = 'shift_report' AND al.entity_id::text = report_id::text)
       OR NOT EXISTS (SELECT 1 FROM core.audit_log al WHERE al.organisation_id = NEW.organisation_id
                        AND al.action = 'attendance.reviewed' AND al.entity_type = 'shift_assignment' AND al.entity_id::text = seat_id::text)
       OR EXISTS (SELECT 1 FROM core.audit_log al WHERE al.organisation_id = NEW.organisation_id AND al.actor_user_id = NEW.approved_by
                    AND ((al.action = 'attendance.report_finalised' AND al.entity_type = 'shift_report' AND al.entity_id::text = report_id::text)
                      OR (al.action = 'attendance.reviewed' AND al.entity_type = 'shift_assignment' AND al.entity_id::text = seat_id::text))) THEN
      RAISE EXCEPTION 'payroll_record approver prepared these hours, or their preparation cannot be verified' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
    RAISE EXCEPTION 'payroll_record approver changes only when the record is approved' USING ERRCODE = '42501';
  END IF;
`;

/** The new body: the old one plus the DECLARE additions and the maker-checker block before RETURN NEW. */
export const PAYROLL_RECORD_GUARD_BODY_AFTER = PAYROLL_RECORD_GUARD_BODY_BEFORE.replace('DECLARE\n', `DECLARE\n${PAYROLL_RECORD_GUARD_DECLARE_ADDED}`).replace(
  '  RETURN NEW;\nEND\n',
  `${PAYROLL_RECORD_GUARD_BLOCK}  RETURN NEW;\nEND\n`,
);

/** CREATE OR REPLACE keeps the function's owner (crewflow), ACL and the triggers that call it. */
export function payrollRecordGuardSql(body: string): string {
  return `CREATE OR REPLACE FUNCTION core.payroll_record_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, core AS $fn$${body}$fn$`;
}

/** Catalog state: the guard's body hash (the semantic goldens' `body=`). */
export const PAYROLL_MAKER_CHECKER_STATE_SQL = `SELECT pg_catalog.md5(coalesce(p.prosrc, '') || '|' || coalesce(pg_catalog.pg_get_function_sqlbody(p.oid), '')) AS guard_body_hash
  FROM pg_catalog.pg_proc p WHERE p.oid = 'core.payroll_record_guard()'::pg_catalog.regprocedure`;

export const PAYROLL_MAKER_CHECKER_HASHES = Object.freeze({
  guardBodyBefore: '6493c13974ec4c47975a703bade22f0a',
  guardBodyAfter: 'a5117bbbccae1919729e6f86e03d6d07',
});
