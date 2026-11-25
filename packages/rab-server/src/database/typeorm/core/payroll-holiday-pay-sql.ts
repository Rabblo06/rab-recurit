// sql-injection-reviewed-file: SQL definition / check module (database layer). Every interpolation is a code constant of this repository (table, column, constraint, trigger, policy and role names, numeric limits); no request or row data reaches these templates. Reviewed 2026-11-21 (Lane P2 holiday pay, DRAFT for owner SQL review).
/**
 * Lane P2 (milestone M5, owner decision 4 of 21 Nov 2026, assumption A3): rolled-up holiday pay. SQL of migration
 * PayrollHolidayPay1786723110000, kept as data so the exact statements can be reviewed, scanned and unit-tested. DRAFT:
 * owner SQL review first.
 *
 * WHAT (decision 4, option a): rolled-up holiday pay at a per-organisation rate (default 12.07%), shown as its own line on
 * the shift statement, the staff payslip timeline and the provider export; or, per organisation, "our payroll provider
 * handles holiday pay" (no line). Two core tables:
 *
 * 1. core.organisation_payroll_setting: one row per organisation. No row = "provider handles it" (FAIL-SAFE, review fix 3
 *    and owner decision 78's recommendation): rolled-up holiday pay appears only after the Initial Manager explicitly
 *    chooses it (rate default 1207 basis points = 12.07% offered in the UI/API). Read by the organisation's non-venue managers; written only by the organisation's CURRENT Initial Manager
 *    (the same authority as the agency payment calendar, ManagerMarkPaidInitialManagerCalendar1786719300000), naming
 *    themselves in updated_by. No DELETE.
 *
 * 2. core.payroll_record_holiday_pay: the holiday pay of ONE payroll record, snapshotted when the record is approved (the
 *    moment its gross becomes approved and its statement is requested) and never recalculated: INSERT-only for the runtime
 *    login (no UPDATE, no DELETE grant; the owner login is held to the same by the reviewed grant-parity guard), one row
 *    per record (UNIQUE per organisation + workspace + record; review fix 4b). It keeps the mode and rate in force at that moment, the base (the record's approved gross) and
 *    the result, and a CHECK re-derives the result from base x rate with the repo's rounding rule (nearest penny, half up:
 *    (base * rate + 5000) / 10000 on non-negative integers), so a stored figure that does not follow the rule cannot exist.
 *    Read by the workspace's non-venue managers, by the staff member it pays (their own rows), and by the Worker (the
 *    statement PDF). Written only by a non-venue manager of the workspace naming themselves in created_by.
 *
 * WHY `core` (owner decision 48's approach, as core.payroll_adjustment): no workspace structure level. TRADE-OFF: no foreign
 * key to payroll_record / staff_profile; the service copies payroll_record_id, staff_profile_id, staff_user_id and
 * base_pence from the record it has just approved (same transaction, same workspace), and payroll records are never
 * hard-deleted by the application (RESTRICT since 1786719700000).
 *
 * A locked (finalised) run never changes: its lines' snapshots are immutable rows, and a setting change only affects
 * records approved after it.
 */

import { AUTHORITATIVE_COPIES_SQL } from './payroll-adjustment-sql';

export const HOLIDAY_SETTING_TABLE = 'organisation_payroll_setting';
export const HOLIDAY_SNAPSHOT_TABLE = 'payroll_record_holiday_pay';

/** Columns crewflow_app may UPDATE on the setting (and the owner login, through the grant-parity allow-list). */
export const HOLIDAY_SETTING_UPDATABLE_COLUMNS: readonly string[] = Object.freeze(['holiday_pay_mode', 'holiday_pay_rate_bps', 'updated_by', 'updated_at']);

const ORG = `(organisation_id = core.current_org())`;
const TENANT = `(organisation_id = core.current_org()) AND (workspace_id = core.current_workspace())`;
const ORG_MANAGER = `(EXISTS (SELECT 1 FROM core.manager_profile mp WHERE (mp.user_id = core.current_uid())
  AND (mp.organisation_id = core.current_org()) AND (mp.type <> 'venue'::text) AND (mp.archived_at IS NULL)))`;
const INITIAL_MANAGER = `(EXISTS (SELECT 1 FROM core.manager_profile mp WHERE (mp.user_id = core.current_uid())
  AND (mp.organisation_id = core.current_org()) AND (mp.type = 'internal'::text) AND mp.is_initial_manager AND (mp.superseded_at IS NULL)))`;
const WORKSPACE_MANAGER = `(EXISTS (SELECT 1 FROM core.manager_profile mp
      WHERE (mp.user_id = core.current_uid()) AND (mp.organisation_id = core.current_org())
        AND (mp.workspace_id = core.current_workspace()) AND (mp.type <> 'venue'::text) AND (mp.archived_at IS NULL)))`;
const WORKER = `(current_setting('rab.actor_type'::text, true) = 'worker'::text)`;

export const HOLIDAY_PAY_TABLES_SQL = `
CREATE TABLE core.organisation_payroll_setting (
  organisation_id      uuid        NOT NULL,
  holiday_pay_mode     text        NOT NULL,
  holiday_pay_rate_bps integer,
  updated_by           uuid        NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organisation_payroll_setting_pkey PRIMARY KEY (organisation_id),
  CONSTRAINT organisation_payroll_setting_mode_check CHECK (holiday_pay_mode IN ('rolled_up', 'provider')),
  CONSTRAINT organisation_payroll_setting_rate_check CHECK (((holiday_pay_mode = 'rolled_up') = (holiday_pay_rate_bps IS NOT NULL))
    AND (holiday_pay_rate_bps IS NULL OR holiday_pay_rate_bps BETWEEN 1 AND 10000)),
  CONSTRAINT organisation_payroll_setting_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE,
  CONSTRAINT organisation_payroll_setting_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES core."user"(id)
);
CREATE TABLE core.payroll_record_holiday_pay (
  id                uuid        NOT NULL DEFAULT gen_random_uuid(),
  organisation_id   uuid        NOT NULL,
  workspace_id      uuid        NOT NULL,
  payroll_record_id uuid        NOT NULL,
  staff_profile_id  uuid        NOT NULL,
  staff_user_id     uuid        NOT NULL,
  mode              text        NOT NULL,
  rate_bps          integer,
  base_pence        bigint      NOT NULL,
  holiday_pay_pence bigint      NOT NULL,
  created_by        uuid        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_record_holiday_pay_pkey PRIMARY KEY (id),
  CONSTRAINT payroll_record_holiday_pay_record_key UNIQUE (organisation_id, workspace_id, payroll_record_id),
  CONSTRAINT payroll_record_holiday_pay_mode_check CHECK (mode IN ('rolled_up', 'provider')),
  CONSTRAINT payroll_record_holiday_pay_rate_check CHECK (((mode = 'rolled_up') = (rate_bps IS NOT NULL)) AND (rate_bps IS NULL OR rate_bps BETWEEN 1 AND 10000)),
  CONSTRAINT payroll_record_holiday_pay_figures_check CHECK (base_pence >= 0 AND base_pence <= 100000000000 AND holiday_pay_pence >= 0),
  CONSTRAINT payroll_record_holiday_pay_rounding_check CHECK (
    (mode = 'provider' AND holiday_pay_pence = 0) OR (mode = 'rolled_up' AND holiday_pay_pence = (base_pence * rate_bps + 5000) / 10000)),
  CONSTRAINT payroll_record_holiday_pay_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE,
  CONSTRAINT payroll_record_holiday_pay_workspace_fkey FOREIGN KEY (workspace_id, organisation_id) REFERENCES core.manager_workspace(id, organisation_id),
  CONSTRAINT payroll_record_holiday_pay_staff_user_id_fkey FOREIGN KEY (staff_user_id) REFERENCES core."user"(id),
  CONSTRAINT payroll_record_holiday_pay_created_by_fkey FOREIGN KEY (created_by) REFERENCES core."user"(id)
);
CREATE INDEX payroll_record_holiday_pay_staff_idx ON core.payroll_record_holiday_pay (workspace_id, staff_profile_id)`;

export const HOLIDAY_PAY_INSERT_GUARD_FUNCTION = 'core.payroll_record_holiday_pay_insert_guard()';

/**
 * BEFORE INSERT on core.payroll_record_holiday_pay (review fix 2 + re-review item 2). Every figure of the line is bound to
 * the database's own facts, so a manager session cannot insert an arbitrary line:
 *   - a payroll record that a FINALISED run holds (core.payroll_run_event `finalised` fact) is refused: a locked run's
 *     totals never change;
 *   - the record is read in the ONE authoritative copy (AUTHORITATIVE_COPIES_SQL of PayrollAdjustmentSchema: chosen from the
 *     cutover state, no core fallback once cut over; the schema name derives from the uuid, so `%I` only quotes hex), and
 *     share-locked (FOR SHARE OF pr), so a concurrent finalise is waited for and its 'processing' is re-read: it must exist in this
 *     organisation and workspace, be `approved`, and its staff_profile_id, staff user (staff_profile.user_id) and approved
 *     gross (amount_pence = base_pence) must equal the line's;
 *   - mode and rate must equal the organisation's setting row (no row = `provider`, rate NULL; holiday_pay_pence is then
 *     fixed by the rounding CHECK: 0 for provider, (base * rate + 5000) / 10000 for rolled-up).
 * Any mismatch is refused (42501). created_at is the database clock.
 */
export const HOLIDAY_PAY_INSERT_GUARD_FUNCTION_SQL = `CREATE FUNCTION core.payroll_record_holiday_pay_insert_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, core AS $fn$
DECLARE
  ws_schema text := 'workspace_' || pg_catalog.replace(NEW.workspace_id::text, '-', '');
  sch text;
  rec_id uuid;
  rec_status text;
  rec_staff uuid;
  rec_amount bigint;
  rec_user uuid;
  set_mode text;
  set_rate integer;
  cut_state text;
  copies text[];
BEGIN
  NEW.created_at := pg_catalog.now();
  IF EXISTS (SELECT 1 FROM core.payroll_run_event e
              WHERE e.organisation_id = NEW.organisation_id AND e.workspace_id = NEW.workspace_id AND e.event = 'finalised'
                AND NEW.payroll_record_id = ANY (e.payroll_record_ids)) THEN
    RAISE EXCEPTION 'holiday pay of payroll record % cannot be added: its payroll run is finalised', NEW.payroll_record_id USING ERRCODE = '42501';
  END IF;
  ${AUTHORITATIVE_COPIES_SQL}
  FOREACH sch IN ARRAY copies LOOP
    CONTINUE WHEN pg_catalog.to_regclass(pg_catalog.format('%I.payroll_record', sch)) IS NULL;
    EXECUTE pg_catalog.format('SELECT pr.id, pr.status, pr.staff_profile_id, pr.amount_pence, sp.user_id FROM %I.payroll_record pr JOIN %I.staff_profile sp ON sp.id = pr.staff_profile_id WHERE pr.id = $1 AND pr.organisation_id = $2 AND pr.workspace_id = $3 FOR SHARE OF pr', sch, sch)
      INTO rec_id, rec_status, rec_staff, rec_amount, rec_user USING NEW.payroll_record_id, NEW.organisation_id, NEW.workspace_id;
    EXIT WHEN rec_id IS NOT NULL;
  END LOOP;
  IF rec_id IS NULL OR rec_status IS DISTINCT FROM 'approved' OR rec_staff IS DISTINCT FROM NEW.staff_profile_id
     OR rec_amount IS DISTINCT FROM NEW.base_pence OR rec_user IS DISTINCT FROM NEW.staff_user_id THEN
    RAISE EXCEPTION 'a holiday pay line must match its approved payroll record' USING ERRCODE = '42501';
  END IF;
  SELECT s.holiday_pay_mode, s.holiday_pay_rate_bps INTO set_mode, set_rate
    FROM core.organisation_payroll_setting s WHERE s.organisation_id = NEW.organisation_id;
  IF set_mode IS NULL THEN
    set_mode := 'provider';
    set_rate := NULL;
  END IF;
  IF NEW.mode IS DISTINCT FROM set_mode OR NEW.rate_bps IS DISTINCT FROM set_rate THEN
    RAISE EXCEPTION 'a holiday pay line must follow the organisation holiday pay setting' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$`;

export const HOLIDAY_PAY_PARITY_TRIGGERS: readonly string[] = Object.freeze([
  '_organisation_payroll_setting_grant_parity_delete',
  '_organisation_payroll_setting_grant_parity_truncate',
  '_organisation_payroll_setting_grant_parity_update',
  '_payroll_record_holiday_pay_grant_parity_delete',
  '_payroll_record_holiday_pay_grant_parity_truncate',
  '_payroll_record_holiday_pay_grant_parity_update',
]);

const PARITY = 'core.owner_login_grant_parity_guard()';

export const HOLIDAY_PAY_SECURITY_SQL: readonly string[] = Object.freeze([
  // core.organisation_payroll_setting
  'ALTER TABLE core.organisation_payroll_setting ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE core.organisation_payroll_setting FORCE ROW LEVEL SECURITY',
  'REVOKE ALL ON TABLE core.organisation_payroll_setting FROM PUBLIC',
  `CREATE POLICY organisation_payroll_setting_select ON core.organisation_payroll_setting AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (${ORG} AND ${ORG_MANAGER})`,
  `CREATE POLICY organisation_payroll_setting_insert ON core.organisation_payroll_setting AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (${ORG} AND ${INITIAL_MANAGER} AND (updated_by = core.current_uid()))`,
  `CREATE POLICY organisation_payroll_setting_update ON core.organisation_payroll_setting AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (${ORG} AND ${INITIAL_MANAGER})
  WITH CHECK (${ORG} AND ${INITIAL_MANAGER} AND (updated_by = core.current_uid()))`,
  'GRANT SELECT, INSERT ON TABLE core.organisation_payroll_setting TO crewflow_app',
  `GRANT UPDATE (${HOLIDAY_SETTING_UPDATABLE_COLUMNS.join(', ')}) ON TABLE core.organisation_payroll_setting TO crewflow_app`,
  `CREATE TRIGGER _organisation_payroll_setting_grant_parity_update BEFORE UPDATE ON core."organisation_payroll_setting" FOR EACH ROW EXECUTE FUNCTION core.owner_login_grant_parity_guard(${HOLIDAY_SETTING_UPDATABLE_COLUMNS.map((c) => `'${c}'`).join(', ')})`,
  `CREATE TRIGGER _organisation_payroll_setting_grant_parity_delete BEFORE DELETE ON core."organisation_payroll_setting" FOR EACH STATEMENT EXECUTE FUNCTION ${PARITY}`,
  `CREATE TRIGGER _organisation_payroll_setting_grant_parity_truncate BEFORE TRUNCATE ON core."organisation_payroll_setting" FOR EACH STATEMENT EXECUTE FUNCTION ${PARITY}`,
  // core.payroll_record_holiday_pay (insert-only)
  'ALTER TABLE core.payroll_record_holiday_pay ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE core.payroll_record_holiday_pay FORCE ROW LEVEL SECURITY',
  'REVOKE ALL ON TABLE core.payroll_record_holiday_pay FROM PUBLIC',
  `CREATE POLICY payroll_record_holiday_pay_select ON core.payroll_record_holiday_pay AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (${TENANT} AND (${WORKSPACE_MANAGER} OR (staff_user_id = core.current_uid()) OR ${WORKER}))`,
  `CREATE POLICY payroll_record_holiday_pay_insert ON core.payroll_record_holiday_pay AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (${TENANT} AND ${WORKSPACE_MANAGER} AND (created_by = core.current_uid()))`,
  'GRANT SELECT, INSERT ON TABLE core.payroll_record_holiday_pay TO crewflow_app',
  HOLIDAY_PAY_INSERT_GUARD_FUNCTION_SQL,
  'REVOKE ALL ON FUNCTION core.payroll_record_holiday_pay_insert_guard() FROM PUBLIC',
  'GRANT EXECUTE ON FUNCTION core.payroll_record_holiday_pay_insert_guard() TO crewflow, crewflow_app',
  'CREATE TRIGGER payroll_record_holiday_pay_insert_guard BEFORE INSERT ON core.payroll_record_holiday_pay FOR EACH ROW EXECUTE FUNCTION core.payroll_record_holiday_pay_insert_guard()',
  `CREATE TRIGGER _payroll_record_holiday_pay_grant_parity_update BEFORE UPDATE ON core."payroll_record_holiday_pay" FOR EACH STATEMENT EXECUTE FUNCTION ${PARITY}`,
  `CREATE TRIGGER _payroll_record_holiday_pay_grant_parity_delete BEFORE DELETE ON core."payroll_record_holiday_pay" FOR EACH STATEMENT EXECUTE FUNCTION ${PARITY}`,
  `CREATE TRIGGER _payroll_record_holiday_pay_grant_parity_truncate BEFORE TRUNCATE ON core."payroll_record_holiday_pay" FOR EACH STATEMENT EXECUTE FUNCTION ${PARITY}`,
]);

export const HOLIDAY_PAY_OWNERSHIP_SQL: readonly string[] = Object.freeze([
  'ALTER TABLE core.organisation_payroll_setting OWNER TO crewflow',
  'ALTER TABLE core.payroll_record_holiday_pay OWNER TO crewflow',
  'ALTER FUNCTION core.payroll_record_holiday_pay_insert_guard() OWNER TO crewflow',
]);

export const HOLIDAY_PAY_PREFLIGHT_SQL = `
SELECT pg_catalog.to_regclass('core.organisation_payroll_setting') IS NOT NULL AS setting_present,
       pg_catalog.to_regclass('core.payroll_record_holiday_pay') IS NOT NULL AS snapshot_present,
       pg_catalog.to_regprocedure('core.owner_login_grant_parity_guard()') IS NOT NULL AS parity_guard,
       pg_catalog.to_regprocedure('core.current_org()') IS NOT NULL AND pg_catalog.to_regprocedure('core.current_workspace()') IS NOT NULL
         AND pg_catalog.to_regprocedure('core.current_uid()') IS NOT NULL AS tenant_functions,
       (SELECT pg_catalog.count(*) FROM pg_catalog.pg_attribute a WHERE a.attrelid = 'core.manager_profile'::pg_catalog.regclass
          AND a.attname IN ('archived_at', 'is_initial_manager', 'superseded_at') AND NOT a.attisdropped)::int AS manager_columns,
       pg_catalog.to_regclass('core.payroll_run_event') IS NOT NULL AS run_event,
       pg_catalog.to_regprocedure('core.payroll_record_holiday_pay_insert_guard()') IS NOT NULL AS guard_present,
       (SELECT pg_catalog.count(*) FROM pg_catalog.pg_roles WHERE rolname IN ('crewflow', 'crewflow_app'))::int AS roles`;

export const HOLIDAY_PAY_DOWN_UNFORCE_SQL: readonly string[] = Object.freeze([
  'ALTER TABLE core.organisation_payroll_setting NO FORCE ROW LEVEL SECURITY',
  'ALTER TABLE core.payroll_record_holiday_pay NO FORCE ROW LEVEL SECURITY',
]);
export const HOLIDAY_PAY_ROWS_SQL = `SELECT (SELECT pg_catalog.count(*) FROM core.organisation_payroll_setting)::int
  + (SELECT pg_catalog.count(*) FROM core.payroll_record_holiday_pay)::int AS n`;
export const HOLIDAY_PAY_DOWN_SQL: readonly string[] = Object.freeze([
  'DROP TABLE core.payroll_record_holiday_pay',
  'DROP TABLE core.organisation_payroll_setting',
  'DROP FUNCTION core.payroll_record_holiday_pay_insert_guard()',
]);

/** Post-condition per table: owner, RLS, ACL (non-owner grantees), column ACL, policies, triggers. */
export const HOLIDAY_PAY_STATE_SQL = `
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
 WHERE c.oid IN (pg_catalog.to_regclass('core.organisation_payroll_setting'), pg_catalog.to_regclass('core.payroll_record_holiday_pay'))
 ORDER BY c.relname`;

export interface HolidayPayTableState {
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
const parity = (table: string) => ['delete', 'truncate', 'update'].map((op) => `_${table}_grant_parity_${op}:O:${PARITY}`).join(',');

export const EXPECTED_HOLIDAY_PAY_STATE: Readonly<Record<string, Omit<HolidayPayTableState, 'table_name'>>> = Object.freeze({
  organisation_payroll_setting: {
    owner: 'crewflow', rls: true, force: true,
    acl: 'crewflow_app:INSERT,crewflow_app:SELECT',
    column_acl: sortedCsv(HOLIDAY_SETTING_UPDATABLE_COLUMNS.map((c) => `crewflow_app:UPDATE:${c}`)),
    policies: 'organisation_payroll_setting_insert:a,organisation_payroll_setting_select:r,organisation_payroll_setting_update:w',
    triggers: parity('organisation_payroll_setting'),
  },
  payroll_record_holiday_pay: {
    owner: 'crewflow', rls: true, force: true,
    acl: 'crewflow_app:INSERT,crewflow_app:SELECT',
    column_acl: '',
    policies: 'payroll_record_holiday_pay_insert:a,payroll_record_holiday_pay_select:r',
    triggers: `${parity('payroll_record_holiday_pay')},payroll_record_holiday_pay_insert_guard:O:${HOLIDAY_PAY_INSERT_GUARD_FUNCTION}`,
  },
});

/** Every difference between the catalog and EXPECTED_HOLIDAY_PAY_STATE (empty = as reviewed). */
export function holidayPayStateProblems(rows: readonly HolidayPayTableState[]): string[] {
  const problems: string[] = [];
  for (const [table, expected] of Object.entries(EXPECTED_HOLIDAY_PAY_STATE)) {
    const row = rows.find((r) => r.table_name === table);
    if (!row) { problems.push(`core.${table}: missing`); continue; }
    for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
      if (String(row[key]) !== String(expected[key])) problems.push(`core.${table}.${key}: expected ${JSON.stringify(expected[key])}, found ${JSON.stringify(row[key])}`);
    }
  }
  return problems;
}

/** Post-condition for the insert guard function: owner, SECURITY INVOKER, EXECUTE grantees. */
export const HOLIDAY_PAY_FUNCTION_STATE_SQL = `
SELECT pg_catalog.pg_get_userbyid(p.proowner)::text || ':definer=' || p.prosecdef::text || ':' ||
       coalesce((SELECT pg_catalog.string_agg(x.v, ',' ORDER BY x.v) FROM (
          SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS v
            FROM pg_catalog.aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE') x), '') AS state
  FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('core.payroll_record_holiday_pay_insert_guard()')`;

export const EXPECTED_HOLIDAY_PAY_FUNCTION_STATE = 'crewflow:definer=false:crewflow,crewflow_app';
