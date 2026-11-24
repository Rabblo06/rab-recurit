// sql-injection-reviewed-file: SQL definition / check module (database layer). Every interpolation is a code constant of this repository (table, column, constraint, trigger, function, policy and role names, numeric limits); no request or row data reaches these templates. Reviewed 2026-11-21 (Lane P2 payroll adjustments, DRAFT for owner SQL review).
/**
 * Lane P2 (milestone M5, owner decision 3 of 21 Nov 2026): payroll adjustments as separate approved lines. SQL of
 * migration PayrollAdjustmentSchema1786723100000, kept as data so the exact statements can be reviewed, scanned and
 * unit-tested. DRAFT: owner SQL review first.
 *
 * WHAT (decision 3, option a): three kinds only.
 *   - correction: plus or minus, linked to the ORIGINAL approved payroll record (corrects_payroll_record_id). A negative
 *     correction of an overpayment is the ONLY reduction that exists;
 *   - bonus and expense: positive only, not linked to a record.
 *   No free-form deduction exists (Employment Rights Act 1996 s.13). Each line has a reason, money as bigint pence, and
 *   needs approval by a DIFFERENT person than its creator, never by the staff member it pays (decision 5's rule). The
 *   approved original record is never edited. An approved line is picked up by the next payroll run prepared for the
 *   period it allocates to (run_id / included_at) and is LOCKED when that run is finalised (locked_at): from then on no
 *   UPDATE of the row is accepted by the database, whoever runs it.
 *
 * WHY `core` AND NOT A WORKSPACE TABLE (owner decision 48's approach, the same as core.staff_role_rate in #311): a
 * workspace business table would be the first table a structure level ever added (0.7.0 chain, new verify counts, three
 * PostgreSQL fingerprints, the C3 cutover copy, the M1 catalogue). An adjustment is tenant data of exactly one workspace,
 * so it lives in `core` with organisation_id AND workspace_id and FORCE RLS. TRADE-OFF: no foreign key to staff_profile,
 * payroll_record or payroll_run (with HWS on those rows live in the workspace schema, which a core constraint cannot
 * name). The service proves the staff member / original record is in the caller's organisation and workspace on every
 * write (404 otherwise) and copies staff_user_id from that row; staff_profile and payroll_record rows are never
 * hard-deleted by the application (payroll evidence is ON DELETE RESTRICT since 1786719700000).
 *
 * core.payroll_adjustment, the five layers:
 *   - layer 4 (tenant): organisation_id = core.current_org() AND workspace_id = core.current_workspace(), every policy;
 *   - layer 5 (tighter): writes and manager reads need a NON-venue, non-archived manager of the bound workspace (the
 *     payroll managers of payroll_record). The paid staff member reads only their OWN APPROVED lines
 *     (staff_user_id = core.current_uid() AND status = 'approved'). Venue Managers, custom members and the Worker see and
 *     write nothing, even through a bug;
 *   - INSERT: only an undecided `pending_approval` row, not in a run, created_by = core.current_uid();
 *   - CHECK constraints: kind/amount/link shape, reason length, decision pairs, and the segregation rule itself
 *     (created_by <> staff_user_id; decided_by <> created_by AND decided_by <> staff_user_id);
 *   - core.payroll_adjustment_guard() (BEFORE UPDATE): a locked row never changes; the figures and authorship never
 *     change; the status only moves pending_approval -> approved | rejected (PAYROLL_ADJUSTMENT_TRANSITIONS) and the
 *     decision names the deciding session (decided_by = core.current_uid()); a decision never changes afterwards; a row
 *     stays in the run that included it.
 *
 * ACCESS: owned by crewflow; crewflow_app holds SELECT, INSERT and UPDATE only on the decision / run columns; no DELETE
 * (financial record, A11 retention). The owner login is held to the same by core.owner_login_grant_parity_guard()
 * (UPDATE allow-list, DELETE, TRUNCATE), the reviewed function of 1786721420000 (no new parity function).
 *
 * REVIEW FIXES (independent security review of #337, 24 Nov):
 *   - core.payroll_run_event: insert-only facts "run R of workspace W was opened" (written at prepare) and "run R was
 *     finalised, with these payroll records" (written at finalise). The adjustment guard refuses to put a line into a run
 *     that has no `opened` fact in the SAME organisation and workspace (a foreign or invented run) or that already has a
 *     `finalised` fact (a locked run): the lock no longer covers only rows already included. The holiday-pay snapshot
 *     (PayrollHolidayPay1786723110000) uses the `finalised` facts to refuse lines of a locked run.
 *   - core.payroll_adjustment_insert_guard() (BEFORE INSERT): staff_user_id must be the user of staff_profile_id in the
 *     bound workspace (the core table and, when it exists, the workspace schema's copy must agree), so the segregation
 *     CHECK cannot be bypassed with a mismatched user id; created_at / updated_at are the database clock.
 */

export const PAYROLL_ADJUSTMENT_TABLE = 'payroll_adjustment';
export const PAYROLL_RUN_EVENT_TABLE = 'payroll_run_event';

/** Columns crewflow_app may UPDATE (and the owner login, through the grant-parity allow-list); everything else is immutable. */
export const PAYROLL_ADJUSTMENT_UPDATABLE_COLUMNS: readonly string[] = Object.freeze([
  'status',
  'decided_by',
  'decided_at',
  'rejection_reason',
  'run_id',
  'included_at',
  'locked_at',
  'updated_at',
]);

/** Sanity ceiling of the CHECK, in pence (also the DTO's @Max): £1,000,000.00 per line. Not a business rule. */
export const PAYROLL_ADJUSTMENT_MAX_PENCE = 100_000_000;

/** Reason length bounds (CHECK and DTO). */
export const PAYROLL_ADJUSTMENT_REASON_MIN = 3;
export const PAYROLL_ADJUSTMENT_REASON_MAX = 500;

const TENANT = `(organisation_id = core.current_org()) AND (workspace_id = core.current_workspace())`;
const WORKSPACE_MANAGER = `(EXISTS (SELECT 1 FROM core.manager_profile mp
      WHERE (mp.user_id = core.current_uid()) AND (mp.organisation_id = core.current_org())
        AND (mp.workspace_id = core.current_workspace()) AND (mp.type <> 'venue'::text) AND (mp.archived_at IS NULL)))`;
const OWN_APPROVED = `((staff_user_id = core.current_uid()) AND (status = 'approved'::text))`;
const UNDECIDED_NEW = `(status = 'pending_approval'::text) AND (decided_by IS NULL) AND (decided_at IS NULL) AND (rejection_reason IS NULL)
      AND (run_id IS NULL) AND (included_at IS NULL) AND (locked_at IS NULL)`;

export const PAYROLL_ADJUSTMENT_TABLE_SQL = `
CREATE TABLE core.payroll_adjustment (
  id                         uuid        NOT NULL DEFAULT gen_random_uuid(),
  organisation_id            uuid        NOT NULL,
  workspace_id               uuid        NOT NULL,
  staff_profile_id           uuid        NOT NULL,
  staff_user_id              uuid        NOT NULL,
  kind                       text        NOT NULL,
  amount_pence               bigint      NOT NULL,
  reason                     text        NOT NULL,
  corrects_payroll_record_id uuid,
  status                     text        NOT NULL DEFAULT 'pending_approval',
  created_by                 uuid        NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  decided_by                 uuid,
  decided_at                 timestamptz,
  rejection_reason           text,
  run_id                     uuid,
  included_at                timestamptz,
  locked_at                  timestamptz,
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_adjustment_pkey PRIMARY KEY (id),
  CONSTRAINT payroll_adjustment_status_check CHECK (status IN ('pending_approval', 'approved', 'rejected')),
  CONSTRAINT payroll_adjustment_kind_check CHECK (kind IN ('correction', 'bonus', 'expense')),
  CONSTRAINT payroll_adjustment_amount_check CHECK (amount_pence <> 0
    AND amount_pence >= -${PAYROLL_ADJUSTMENT_MAX_PENCE} AND amount_pence <= ${PAYROLL_ADJUSTMENT_MAX_PENCE}
    AND (kind = 'correction' OR amount_pence > 0)),
  CONSTRAINT payroll_adjustment_correction_link_check CHECK ((kind = 'correction') = (corrects_payroll_record_id IS NOT NULL)),
  CONSTRAINT payroll_adjustment_reason_check CHECK (char_length(btrim(reason)) BETWEEN ${PAYROLL_ADJUSTMENT_REASON_MIN} AND ${PAYROLL_ADJUSTMENT_REASON_MAX}),
  CONSTRAINT payroll_adjustment_decision_check CHECK (((status = 'pending_approval') = (decided_by IS NULL)) AND ((decided_by IS NULL) = (decided_at IS NULL))),
  CONSTRAINT payroll_adjustment_rejection_check CHECK (((status = 'rejected') = (rejection_reason IS NOT NULL))
    AND (rejection_reason IS NULL OR char_length(btrim(rejection_reason)) BETWEEN ${PAYROLL_ADJUSTMENT_REASON_MIN} AND ${PAYROLL_ADJUSTMENT_REASON_MAX})),
  CONSTRAINT payroll_adjustment_segregation_check CHECK ((created_by <> staff_user_id)
    AND (decided_by IS NULL OR (decided_by <> created_by AND decided_by <> staff_user_id))),
  CONSTRAINT payroll_adjustment_run_check CHECK (((run_id IS NULL) = (included_at IS NULL))
    AND (run_id IS NULL OR status = 'approved') AND (locked_at IS NULL OR run_id IS NOT NULL)),
  CONSTRAINT payroll_adjustment_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE,
  CONSTRAINT payroll_adjustment_workspace_fkey FOREIGN KEY (workspace_id, organisation_id) REFERENCES core.manager_workspace(id, organisation_id),
  CONSTRAINT payroll_adjustment_staff_user_id_fkey FOREIGN KEY (staff_user_id) REFERENCES core."user"(id),
  CONSTRAINT payroll_adjustment_created_by_fkey FOREIGN KEY (created_by) REFERENCES core."user"(id),
  CONSTRAINT payroll_adjustment_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES core."user"(id)
);
CREATE INDEX payroll_adjustment_workspace_status_idx ON core.payroll_adjustment (workspace_id, status, created_at DESC);
CREATE INDEX payroll_adjustment_staff_idx ON core.payroll_adjustment (workspace_id, staff_profile_id);
CREATE INDEX payroll_adjustment_record_idx ON core.payroll_adjustment (corrects_payroll_record_id) WHERE corrects_payroll_record_id IS NOT NULL;
CREATE INDEX payroll_adjustment_run_idx ON core.payroll_adjustment (run_id) WHERE run_id IS NOT NULL;
CREATE TABLE core.payroll_run_event (
  id                 uuid        NOT NULL DEFAULT gen_random_uuid(),
  organisation_id    uuid        NOT NULL,
  workspace_id       uuid        NOT NULL,
  run_id             uuid        NOT NULL,
  event              text        NOT NULL,
  payroll_record_ids uuid[]      NOT NULL DEFAULT '{}'::uuid[],
  created_by         uuid        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_run_event_pkey PRIMARY KEY (id),
  CONSTRAINT payroll_run_event_key UNIQUE (organisation_id, workspace_id, run_id, event),
  CONSTRAINT payroll_run_event_event_check CHECK (event IN ('opened', 'finalised')),
  CONSTRAINT payroll_run_event_records_check CHECK (event = 'finalised' OR cardinality(payroll_record_ids) = 0),
  CONSTRAINT payroll_run_event_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE,
  CONSTRAINT payroll_run_event_workspace_fkey FOREIGN KEY (workspace_id, organisation_id) REFERENCES core.manager_workspace(id, organisation_id),
  CONSTRAINT payroll_run_event_created_by_fkey FOREIGN KEY (created_by) REFERENCES core."user"(id)
);
CREATE INDEX payroll_run_event_records_idx ON core.payroll_run_event USING gin (payroll_record_ids) WHERE event = 'finalised'`;

/** Columns the guard refuses to change, for any session (the table owner included). */
const IMMUTABLE_COLUMNS = [
  'id', 'organisation_id', 'workspace_id', 'staff_profile_id', 'staff_user_id', 'kind', 'amount_pence', 'reason',
  'corrects_payroll_record_id', 'created_by', 'created_at',
] as const;

export const PAYROLL_ADJUSTMENT_GUARD_FUNCTION = 'core.payroll_adjustment_guard()';
export const PAYROLL_ADJUSTMENT_INSERT_GUARD_FUNCTION = 'core.payroll_adjustment_insert_guard()';

const RUN_FACT = (event: 'opened' | 'finalised') => `EXISTS (SELECT 1 FROM core.payroll_run_event e
       WHERE e.run_id = NEW.run_id AND e.organisation_id = NEW.organisation_id AND e.workspace_id = NEW.workspace_id AND e.event = '${event}')`;

export const PAYROLL_ADJUSTMENT_GUARD_FUNCTION_SQL = `CREATE FUNCTION core.payroll_adjustment_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, core AS $fn$
BEGIN
  IF OLD.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'payroll_adjustment % is locked: its payroll run is finalised', OLD.id USING ERRCODE = '42501';
  END IF;
  IF ${IMMUTABLE_COLUMNS.map((c) => `NEW.${c} IS DISTINCT FROM OLD.${c}`).join('\n     OR ')} THEN
    RAISE EXCEPTION 'payroll_adjustment figures and authorship never change' USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (OLD.status = 'pending_approval' AND NEW.status IN ('approved', 'rejected')) THEN
      RAISE EXCEPTION 'payroll_adjustment status % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = '23514';
    END IF;
    IF NEW.decided_by IS DISTINCT FROM core.current_uid() THEN
      RAISE EXCEPTION 'a payroll adjustment decision names the deciding session' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
     OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason THEN
    RAISE EXCEPTION 'a payroll adjustment decision never changes' USING ERRCODE = '42501';
  END IF;
  IF OLD.run_id IS NOT NULL AND (NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.included_at IS DISTINCT FROM OLD.included_at) THEN
    RAISE EXCEPTION 'a payroll adjustment stays in the payroll run that included it' USING ERRCODE = '42501';
  END IF;
  IF NEW.run_id IS NOT NULL AND OLD.run_id IS NULL THEN
    IF NOT ${RUN_FACT('opened')} THEN
      RAISE EXCEPTION 'a payroll adjustment joins only an open payroll run of its own workspace' USING ERRCODE = '42501';
    END IF;
    IF ${RUN_FACT('finalised')} THEN
      RAISE EXCEPTION 'a payroll adjustment never joins a finalised payroll run' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$`;

/**
 * BEFORE INSERT: staff_user_id is the user of staff_profile_id in the bound workspace. The business table lives in `core`
 * (HWS off) or in the workspace schema `workspace_<32 hex>` (HWS on, the schema name derived from the uuid, so `%I` only
 * ever quotes hex); every copy that holds the profile must name the same user, and at least one must hold it. Fail
 * closed: a profile found nowhere, or a different user, is refused (23514). The row's clocks are the database's.
 */
export const PAYROLL_ADJUSTMENT_INSERT_GUARD_FUNCTION_SQL = `CREATE FUNCTION core.payroll_adjustment_insert_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, core AS $fn$
DECLARE
  ws_schema text := 'workspace_' || pg_catalog.replace(NEW.workspace_id::text, '-', '');
  core_user uuid;
  ws_user uuid;
BEGIN
  NEW.created_at := pg_catalog.now();
  NEW.updated_at := pg_catalog.now();
  SELECT sp.user_id INTO core_user FROM core.staff_profile sp
   WHERE sp.id = NEW.staff_profile_id AND sp.workspace_id = NEW.workspace_id AND sp.organisation_id = NEW.organisation_id;
  IF pg_catalog.to_regclass(pg_catalog.format('%I.staff_profile', ws_schema)) IS NOT NULL THEN
    EXECUTE pg_catalog.format('SELECT sp.user_id FROM %I.staff_profile sp WHERE sp.id = $1 AND sp.workspace_id = $2 AND sp.organisation_id = $3', ws_schema)
      INTO ws_user USING NEW.staff_profile_id, NEW.workspace_id, NEW.organisation_id;
  END IF;
  IF (core_user IS NULL AND ws_user IS NULL)
     OR (core_user IS NOT NULL AND core_user IS DISTINCT FROM NEW.staff_user_id)
     OR (ws_user IS NOT NULL AND ws_user IS DISTINCT FROM NEW.staff_user_id) THEN
    RAISE EXCEPTION 'payroll_adjustment staff_user_id must be the user of staff_profile_id in this workspace' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$`;

/**
 * The grant-parity triggers this migration adds with the reviewed core.owner_login_grant_parity_guard() (outside
 * GRANT_PARITY_TARGETS, whose list is consumed by the frozen OwnerLoginGrantParityGuards1786721420000). Counted by
 * owner-login-guards.integration.spec.ts next to that list.
 */
export const PAYROLL_ADJUSTMENT_PARITY_TRIGGERS: readonly string[] = Object.freeze([
  '_payroll_adjustment_grant_parity_delete',
  '_payroll_adjustment_grant_parity_truncate',
  '_payroll_adjustment_grant_parity_update',
  '_payroll_run_event_grant_parity_delete',
  '_payroll_run_event_grant_parity_truncate',
  '_payroll_run_event_grant_parity_update',
]);

const PARITY = 'core.owner_login_grant_parity_guard()';

export const PAYROLL_ADJUSTMENT_SECURITY_SQL: readonly string[] = Object.freeze([
  'ALTER TABLE core.payroll_adjustment ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE core.payroll_adjustment FORCE ROW LEVEL SECURITY',
  'REVOKE ALL ON TABLE core.payroll_adjustment FROM PUBLIC',
  `CREATE POLICY payroll_adjustment_select ON core.payroll_adjustment AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (${TENANT} AND (${WORKSPACE_MANAGER} OR ${OWN_APPROVED}))`,
  `CREATE POLICY payroll_adjustment_insert ON core.payroll_adjustment AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (${TENANT} AND ${WORKSPACE_MANAGER} AND (created_by = core.current_uid()) AND ${UNDECIDED_NEW})`,
  `CREATE POLICY payroll_adjustment_update ON core.payroll_adjustment AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (${TENANT} AND ${WORKSPACE_MANAGER})
  WITH CHECK (${TENANT} AND ${WORKSPACE_MANAGER})`,
  'GRANT SELECT, INSERT ON TABLE core.payroll_adjustment TO crewflow_app',
  `GRANT UPDATE (${PAYROLL_ADJUSTMENT_UPDATABLE_COLUMNS.join(', ')}) ON TABLE core.payroll_adjustment TO crewflow_app`,
  // core.payroll_run_event (insert-only run facts)
  'ALTER TABLE core.payroll_run_event ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE core.payroll_run_event FORCE ROW LEVEL SECURITY',
  'REVOKE ALL ON TABLE core.payroll_run_event FROM PUBLIC',
  `CREATE POLICY payroll_run_event_select ON core.payroll_run_event AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (${TENANT} AND ${WORKSPACE_MANAGER})`,
  `CREATE POLICY payroll_run_event_insert ON core.payroll_run_event AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (${TENANT} AND ${WORKSPACE_MANAGER} AND (created_by = core.current_uid()))`,
  'GRANT SELECT, INSERT ON TABLE core.payroll_run_event TO crewflow_app',
  // guard functions and triggers
  PAYROLL_ADJUSTMENT_GUARD_FUNCTION_SQL,
  'REVOKE ALL ON FUNCTION core.payroll_adjustment_guard() FROM PUBLIC',
  'GRANT EXECUTE ON FUNCTION core.payroll_adjustment_guard() TO crewflow, crewflow_app',
  PAYROLL_ADJUSTMENT_INSERT_GUARD_FUNCTION_SQL,
  'REVOKE ALL ON FUNCTION core.payroll_adjustment_insert_guard() FROM PUBLIC',
  'GRANT EXECUTE ON FUNCTION core.payroll_adjustment_insert_guard() TO crewflow, crewflow_app',
  'CREATE TRIGGER payroll_adjustment_guard BEFORE UPDATE ON core.payroll_adjustment FOR EACH ROW EXECUTE FUNCTION core.payroll_adjustment_guard()',
  'CREATE TRIGGER payroll_adjustment_insert_guard BEFORE INSERT ON core.payroll_adjustment FOR EACH ROW EXECUTE FUNCTION core.payroll_adjustment_insert_guard()',
  `CREATE TRIGGER _payroll_adjustment_grant_parity_update BEFORE UPDATE ON core."payroll_adjustment" FOR EACH ROW EXECUTE FUNCTION core.owner_login_grant_parity_guard(${PAYROLL_ADJUSTMENT_UPDATABLE_COLUMNS.map((c) => `'${c}'`).join(', ')})`,
  `CREATE TRIGGER _payroll_adjustment_grant_parity_delete BEFORE DELETE ON core."payroll_adjustment" FOR EACH STATEMENT EXECUTE FUNCTION ${PARITY}`,
  `CREATE TRIGGER _payroll_adjustment_grant_parity_truncate BEFORE TRUNCATE ON core."payroll_adjustment" FOR EACH STATEMENT EXECUTE FUNCTION ${PARITY}`,
  `CREATE TRIGGER _payroll_run_event_grant_parity_update BEFORE UPDATE ON core."payroll_run_event" FOR EACH STATEMENT EXECUTE FUNCTION ${PARITY}`,
  `CREATE TRIGGER _payroll_run_event_grant_parity_delete BEFORE DELETE ON core."payroll_run_event" FOR EACH STATEMENT EXECUTE FUNCTION ${PARITY}`,
  `CREATE TRIGGER _payroll_run_event_grant_parity_truncate BEFORE TRUNCATE ON core."payroll_run_event" FOR EACH STATEMENT EXECUTE FUNCTION ${PARITY}`,
]);

/** Run inside withCrewflowCoreCreate (crewflow needs CREATE on core to become the owner). */
export const PAYROLL_ADJUSTMENT_OWNERSHIP_SQL: readonly string[] = Object.freeze([
  'ALTER TABLE core.payroll_adjustment OWNER TO crewflow',
  'ALTER TABLE core.payroll_run_event OWNER TO crewflow',
  'ALTER FUNCTION core.payroll_adjustment_guard() OWNER TO crewflow',
  'ALTER FUNCTION core.payroll_adjustment_insert_guard() OWNER TO crewflow',
]);

/** Pre-flight facts: what the migration relies on, and whether its objects already exist. */
export const PAYROLL_ADJUSTMENT_PREFLIGHT_SQL = `
SELECT pg_catalog.to_regclass('core.payroll_adjustment') IS NOT NULL AS table_present,
       pg_catalog.to_regclass('core.payroll_run_event') IS NOT NULL AS event_present,
       pg_catalog.to_regprocedure('core.payroll_adjustment_guard()') IS NOT NULL AS guard_present,
       pg_catalog.to_regprocedure('core.payroll_adjustment_insert_guard()') IS NOT NULL AS insert_guard_present,
       pg_catalog.to_regprocedure('core.owner_login_grant_parity_guard()') IS NOT NULL AS parity_guard,
       pg_catalog.to_regprocedure('core.current_org()') IS NOT NULL AND pg_catalog.to_regprocedure('core.current_workspace()') IS NOT NULL
         AND pg_catalog.to_regprocedure('core.current_uid()') IS NOT NULL AS tenant_functions,
       pg_catalog.to_regclass('core.staff_profile') IS NOT NULL AS core_staff_profile,
       EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = 'core.manager_profile'::pg_catalog.regclass
                 AND a.attname = 'archived_at' AND NOT a.attisdropped) AS manager_archived_at,
       EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k
                WHERE k.conrelid = 'core.manager_workspace'::pg_catalog.regclass AND k.contype IN ('u', 'p')
                  AND (SELECT pg_catalog.array_agg(a.attname::text ORDER BY a.attname)
                         FROM pg_catalog.pg_attribute a WHERE a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)) = ARRAY['id', 'organisation_id']) AS workspace_key,
       (SELECT pg_catalog.count(*) FROM pg_catalog.pg_roles WHERE rolname IN ('crewflow', 'crewflow_app'))::int AS roles`;

/** down(): retention: refuses while any row exists (counted after NO FORCE in down()'s own transaction). */
export const PAYROLL_ADJUSTMENT_DOWN_UNFORCE_SQL: readonly string[] = Object.freeze([
  'ALTER TABLE core.payroll_adjustment NO FORCE ROW LEVEL SECURITY',
  'ALTER TABLE core.payroll_run_event NO FORCE ROW LEVEL SECURITY',
]);
export const PAYROLL_ADJUSTMENT_ROWS_SQL = `SELECT (SELECT pg_catalog.count(*) FROM core.payroll_adjustment)::int
  + (SELECT pg_catalog.count(*) FROM core.payroll_run_event)::int AS n`;
export const PAYROLL_ADJUSTMENT_DOWN_SQL: readonly string[] = Object.freeze([
  'DROP TABLE core.payroll_adjustment',
  'DROP TABLE core.payroll_run_event',
  'DROP FUNCTION core.payroll_adjustment_guard()',
  'DROP FUNCTION core.payroll_adjustment_insert_guard()',
]);

/** Post-condition per table: owner, RLS, ACL (non-owner grantees), column ACL, policies, triggers. */
export const PAYROLL_ADJUSTMENT_STATE_SQL = `
SELECT c.relname::text AS table_name,
       pg_catalog.pg_get_userbyid(c.relowner)::text AS owner,
       c.relrowsecurity AS rls,
       c.relforcerowsecurity AS force,
       coalesce((SELECT pg_catalog.string_agg(x.v, ',' ORDER BY x.v) FROM (
          SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END || ':' || a.privilege_type AS v
            FROM pg_catalog.aclexplode(c.relacl) a WHERE a.grantee <> c.relowner) x), '') AS acl,
       coalesce((SELECT pg_catalog.string_agg(x.v, ',' ORDER BY x.v) FROM (
          SELECT pg_catalog.pg_get_userbyid(a.grantee)::text || ':' || a.privilege_type || ':' || att.attname::text AS v
            FROM pg_catalog.pg_attribute att CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a
           WHERE att.attrelid = c.oid AND att.attacl IS NOT NULL AND NOT att.attisdropped AND a.grantee <> c.relowner) x), '') AS column_acl,
       coalesce((SELECT pg_catalog.string_agg(p.polname || ':' || p.polcmd::text, ',' ORDER BY p.polname)
          FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid), '') AS policies,
       coalesce((SELECT pg_catalog.string_agg(t.tgname || ':' || t.tgenabled::text || ':' || t.tgfoid::pg_catalog.regprocedure::text, ',' ORDER BY t.tgname)
          FROM pg_catalog.pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal), '') AS triggers
  FROM pg_catalog.pg_class c
 WHERE c.oid IN (pg_catalog.to_regclass('core.payroll_adjustment'), pg_catalog.to_regclass('core.payroll_run_event'))
 ORDER BY c.relname`;

/** Post-condition for the two guard functions: owner, SECURITY INVOKER, EXECUTE grantees. */
export const PAYROLL_ADJUSTMENT_FUNCTION_STATE_SQL = `
SELECT p.proname::text AS name,
       pg_catalog.pg_get_userbyid(p.proowner)::text || ':definer=' || p.prosecdef::text || ':' ||
       coalesce((SELECT pg_catalog.string_agg(x.v, ',' ORDER BY x.v) FROM (
          SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS v
            FROM pg_catalog.aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE') x), '') AS state
  FROM pg_catalog.pg_proc p
 WHERE p.oid IN (pg_catalog.to_regprocedure('core.payroll_adjustment_guard()'), pg_catalog.to_regprocedure('core.payroll_adjustment_insert_guard()'))
 ORDER BY p.proname`;

export interface PayrollAdjustmentTableState {
  table_name: string;
  owner: string;
  rls: boolean;
  force: boolean;
  acl: string;
  column_acl: string;
  policies: string;
  triggers: string;
}

const sortedCsv = (values: readonly string[]) => [...values].sort().join(',');
const parity = (table: string) => ['delete', 'truncate', 'update'].map((op) => `_${table}_grant_parity_${op}:O:${PARITY}`);

export const EXPECTED_PAYROLL_ADJUSTMENT_STATE: Readonly<Record<string, Omit<PayrollAdjustmentTableState, 'table_name'>>> = Object.freeze({
  payroll_adjustment: {
    owner: 'crewflow', rls: true, force: true,
    acl: 'crewflow_app:INSERT,crewflow_app:SELECT',
    column_acl: sortedCsv(PAYROLL_ADJUSTMENT_UPDATABLE_COLUMNS.map((c) => `crewflow_app:UPDATE:${c}`)),
    policies: 'payroll_adjustment_insert:a,payroll_adjustment_select:r,payroll_adjustment_update:w',
    triggers: [
      ...parity('payroll_adjustment'),
      `payroll_adjustment_guard:O:${PAYROLL_ADJUSTMENT_GUARD_FUNCTION}`,
      `payroll_adjustment_insert_guard:O:${PAYROLL_ADJUSTMENT_INSERT_GUARD_FUNCTION}`,
    ].join(','),
  },
  payroll_run_event: {
    owner: 'crewflow', rls: true, force: true,
    acl: 'crewflow_app:INSERT,crewflow_app:SELECT',
    column_acl: '',
    policies: 'payroll_run_event_insert:a,payroll_run_event_select:r',
    triggers: parity('payroll_run_event').join(','),
  },
});

export const EXPECTED_PAYROLL_ADJUSTMENT_FUNCTIONS: Readonly<Record<string, string>> = Object.freeze({
  payroll_adjustment_guard: 'crewflow:definer=false:crewflow,crewflow_app',
  payroll_adjustment_insert_guard: 'crewflow:definer=false:crewflow,crewflow_app',
});

/** Every difference between the catalog and the reviewed state (empty = as reviewed). */
export function payrollAdjustmentStateProblems(
  tables: readonly PayrollAdjustmentTableState[],
  functions: ReadonlyArray<{ name: string; state: string }>,
): string[] {
  const problems: string[] = [];
  for (const [table, expected] of Object.entries(EXPECTED_PAYROLL_ADJUSTMENT_STATE)) {
    const row = tables.find((r) => r.table_name === table);
    if (!row) { problems.push(`core.${table}: missing`); continue; }
    for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
      if (String(row[key]) !== String(expected[key])) problems.push(`core.${table}.${key}: expected ${JSON.stringify(expected[key])}, found ${JSON.stringify(row[key])}`);
    }
  }
  for (const [name, expected] of Object.entries(EXPECTED_PAYROLL_ADJUSTMENT_FUNCTIONS)) {
    const fn = functions.find((f) => f.name === name);
    if (!fn) problems.push(`core.${name}(): missing`);
    else if (fn.state !== expected) problems.push(`core.${name}(): expected ${JSON.stringify(expected)}, found ${JSON.stringify(fn.state)}`);
  }
  return problems;
}
