// sql-injection-reviewed-file: SQL definition / check module (database layer). Every interpolation is a code constant of this repository (table, column, trigger, policy, function and role names); the definer's one dynamic statement formats a schema name derived from core.current_workspace() with %I and binds every value. No request or row data reaches these templates. Reviewed 2026-11-24 (Lane C owner decisions 41 and 97, DRAFT for owner SQL review).
/**
 * Owner decisions 41 and 97 (DECISIONS-PENDING.md): a rate TYPED on the shift wins over a staff role rate (41), and shifts
 * created BEFORE this migration keep the shift's own rate (97: staff role rates apply only to shifts created after it). SQL of
 * migration ShiftResolvedRate1786722220000, kept as data so the exact statements can be reviewed. DRAFT — owner SQL review.
 *
 * ONE MARKER, BOTH RULES. The shift row stores one resolved number and does not record how it was obtained (a new `shift`
 * column would be a workspace-table change, owner decision 48). So the shift-creating transaction records the opposite of
 * "explicit": core.shift_resolved_rate holds a row for a shift whose rate was RESOLVED (venue role rate / job role default,
 * no `payRatePence` given) by SchedulingService.insertNewShiftTx. Only such a shift may take a staff role rate at send /
 * confirmation (resolveSeatPayRate). A shift with a typed rate has no row (41), and every shift created before this
 * migration has no row (97) — the cut-over is the presence of a row written in the shift's own creating transaction, derived
 * from the database, never from a client value or a clock comparison.
 *
 * core.mark_shift_rate_resolved(uuid) — the ONLY writer (crewflow_app has no INSERT; the owner login is refused INSERT /
 * UPDATE / DELETE / TRUNCATE by the reviewed grant-parity guard, which lets the crewflow-owned definer through):
 *   - SECURITY DEFINER, owner crewflow, pinned search_path, EXECUTE for crewflow_app only (never PUBLIC);
 *   - refuses (42501) unless a tenant (organisation, workspace, user) is bound, and the shift EXISTS in the bound
 *     workspace — in its workspace-schema copy `workspace_<32 hex>.shift` (HWS on) or `core.shift` (HWS off): whichever copy
 *     the caller's transaction writes is the one holding a row created in THIS transaction — with created_by = the caller
 *     and created_at = now() (the transaction start: only the transaction that inserted the shift can mark it, so an
 *     existing shift — another manager's, an old one, or a non-existent id — can never be marked);
 *   - the insert itself is bound again by RLS (tenant + created_by = current_uid()).
 * core.shift_resolved_rate:
 *   - layer 4 (tenant): organisation_id = core.current_org() AND workspace_id = core.current_workspace(), on both policies;
 *   - layer 5: SELECT only for a non-venue, non-archived manager of the workspace (the offer senders who price seats);
 *   - no amount stored; no foreign key to `shift` (a workspace table with HWS on).
 * SECURITY TRADE-OFF (recorded in the PR): the SELECT predicate is any non-venue manager of the workspace, wider than the
 * services' creator scope, because a seat can be priced by a manager who did not create the shift (replacement-request
 * approval); the row holds no amount and only says how the shift's own rate was obtained.
 */

export const SHIFT_RESOLVED_RATE_TABLE = 'shift_resolved_rate';
export const MARK_SHIFT_RATE_RESOLVED_FUNCTION = 'core.mark_shift_rate_resolved(uuid)';

const TENANT = `(organisation_id = core.current_org()) AND (workspace_id = core.current_workspace())`;
const WORKSPACE_MANAGER = `(EXISTS (SELECT 1 FROM core.manager_profile mp
      WHERE (mp.user_id = core.current_uid()) AND (mp.organisation_id = core.current_org())
        AND (mp.workspace_id = core.current_workspace()) AND (mp.type <> 'venue'::text) AND (mp.archived_at IS NULL)))`;

/** The four grant-parity triggers (counted by owner-login-guards.integration.spec.ts next to GRANT_PARITY_TARGETS). */
export const SHIFT_RESOLVED_RATE_PARITY_TRIGGERS: readonly string[] = Object.freeze([
  '_shift_resolved_rate_grant_parity_insert',
  '_shift_resolved_rate_grant_parity_update',
  '_shift_resolved_rate_grant_parity_delete',
  '_shift_resolved_rate_grant_parity_truncate',
]);

export const SHIFT_RESOLVED_RATE_TABLE_SQL = `
CREATE TABLE core.shift_resolved_rate (
  shift_id        uuid        NOT NULL,
  organisation_id uuid        NOT NULL,
  workspace_id    uuid        NOT NULL,
  created_by      uuid        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shift_resolved_rate_pkey PRIMARY KEY (shift_id),
  CONSTRAINT shift_resolved_rate_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE,
  CONSTRAINT shift_resolved_rate_workspace_fkey FOREIGN KEY (workspace_id, organisation_id) REFERENCES core.manager_workspace(id, organisation_id) ON DELETE CASCADE
)`;

/** The body of core.mark_shift_rate_resolved (prosrc: exactly the text between the $fn$ quotes; hashed by the semantic posture). */
export const MARK_SHIFT_RATE_RESOLVED_BODY = `
DECLARE
  v_org    uuid := core.current_org();
  v_ws     uuid := core.current_workspace();
  v_uid    uuid := core.current_uid();
  v_schema text;
  v_found  boolean := false;
BEGIN
  IF v_org IS NULL OR v_ws IS NULL OR v_uid IS NULL OR p_shift_id IS NULL THEN
    RAISE EXCEPTION 'mark_shift_rate_resolved: no tenant context' USING ERRCODE = '42501';
  END IF;
  -- The bound workspace's own schema copy (HWS on), then the core copy (HWS off): the copy this transaction wrote holds it.
  FOREACH v_schema IN ARRAY ARRAY['workspace_' || pg_catalog.replace(v_ws::text, '-', ''), 'core'] LOOP
    IF NOT v_found AND pg_catalog.to_regclass(pg_catalog.format('%I.shift', v_schema)) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'SELECT EXISTS (SELECT 1 FROM %I.shift s WHERE s.id = $1 AND s.organisation_id = $2 AND s.workspace_id = $3 AND s.created_by = $4 AND s.created_at = pg_catalog.now())',
        v_schema)
        INTO v_found USING p_shift_id, v_org, v_ws, v_uid;
    END IF;
  END LOOP;
  IF NOT v_found THEN
    RAISE EXCEPTION 'mark_shift_rate_resolved: not a shift created by the caller in this transaction and workspace' USING ERRCODE = '42501';
  END IF;
  INSERT INTO core.shift_resolved_rate (shift_id, organisation_id, workspace_id, created_by) VALUES (p_shift_id, v_org, v_ws, v_uid);
END
`;

export const MARK_SHIFT_RATE_RESOLVED_FUNCTION_SQL = `CREATE FUNCTION core.mark_shift_rate_resolved(p_shift_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$${MARK_SHIFT_RATE_RESOLVED_BODY}$fn$`;

export const SHIFT_RESOLVED_RATE_SECURITY_SQL: readonly string[] = Object.freeze([
  'ALTER TABLE core.shift_resolved_rate ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE core.shift_resolved_rate FORCE ROW LEVEL SECURITY',
  'REVOKE ALL ON TABLE core.shift_resolved_rate FROM PUBLIC',
  `CREATE POLICY shift_resolved_rate_select ON core.shift_resolved_rate AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (${TENANT} AND ${WORKSPACE_MANAGER})`,
  `CREATE POLICY shift_resolved_rate_insert ON core.shift_resolved_rate AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (${TENANT} AND (created_by = core.current_uid()))`,
  'GRANT SELECT ON TABLE core.shift_resolved_rate TO crewflow_app',
  'CREATE TRIGGER _shift_resolved_rate_grant_parity_insert BEFORE INSERT ON core."shift_resolved_rate" FOR EACH STATEMENT EXECUTE FUNCTION core.owner_login_grant_parity_guard()',
  'CREATE TRIGGER _shift_resolved_rate_grant_parity_update BEFORE UPDATE ON core."shift_resolved_rate" FOR EACH STATEMENT EXECUTE FUNCTION core.owner_login_grant_parity_guard()',
  'CREATE TRIGGER _shift_resolved_rate_grant_parity_delete BEFORE DELETE ON core."shift_resolved_rate" FOR EACH STATEMENT EXECUTE FUNCTION core.owner_login_grant_parity_guard()',
  'CREATE TRIGGER _shift_resolved_rate_grant_parity_truncate BEFORE TRUNCATE ON core."shift_resolved_rate" FOR EACH STATEMENT EXECUTE FUNCTION core.owner_login_grant_parity_guard()',
  MARK_SHIFT_RATE_RESOLVED_FUNCTION_SQL,
  'REVOKE ALL ON FUNCTION core.mark_shift_rate_resolved(uuid) FROM PUBLIC',
  'GRANT EXECUTE ON FUNCTION core.mark_shift_rate_resolved(uuid) TO crewflow_app',
]);

/** Run inside withCrewflowCoreCreate (crewflow needs CREATE on core to become the owner). */
export const SHIFT_RESOLVED_RATE_OWNERSHIP_SQL: readonly string[] = Object.freeze([
  'ALTER TABLE core.shift_resolved_rate OWNER TO crewflow',
  'ALTER FUNCTION core.mark_shift_rate_resolved(uuid) OWNER TO crewflow',
]);

export const SHIFT_RESOLVED_RATE_PREFLIGHT_SQL = `
SELECT pg_catalog.to_regclass('core.shift_resolved_rate') IS NOT NULL AS table_present,
       pg_catalog.to_regprocedure('core.mark_shift_rate_resolved(uuid)') IS NOT NULL AS function_present,
       pg_catalog.to_regprocedure('core.owner_login_grant_parity_guard()') IS NOT NULL AS parity_guard,
       (SELECT pg_catalog.count(*) FROM pg_catalog.pg_roles WHERE rolname IN ('crewflow', 'crewflow_app'))::int AS roles`;

/** down(): retention — refuses while any marker exists (counted after NO FORCE in down()'s own transaction). */
export const SHIFT_RESOLVED_RATE_DOWN_UNFORCE_SQL = 'ALTER TABLE core.shift_resolved_rate NO FORCE ROW LEVEL SECURITY';
export const SHIFT_RESOLVED_RATE_ROWS_SQL = 'SELECT pg_catalog.count(*)::int AS n FROM core.shift_resolved_rate';
export const SHIFT_RESOLVED_RATE_DOWN_SQL: readonly string[] = Object.freeze([
  'DROP FUNCTION core.mark_shift_rate_resolved(uuid)',
  'DROP TABLE core.shift_resolved_rate',
]);

export const SHIFT_RESOLVED_RATE_STATE_SQL = `
SELECT pg_catalog.pg_get_userbyid(c.relowner)::text AS owner,
       c.relrowsecurity AS rls,
       c.relforcerowsecurity AS force,
       coalesce((SELECT pg_catalog.string_agg(x.v, ',' ORDER BY x.v) FROM (
          SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END || ':' || a.privilege_type AS v
            FROM pg_catalog.aclexplode(c.relacl) a WHERE a.grantee <> c.relowner) x), '') AS acl,
       coalesce((SELECT pg_catalog.string_agg(p.polname || ':' || p.polcmd::text, ',' ORDER BY p.polname)
          FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid), '') AS policies,
       coalesce((SELECT pg_catalog.string_agg(t.tgname || ':' || t.tgenabled::text, ',' ORDER BY t.tgname)
          FROM pg_catalog.pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal
            AND t.tgfoid = 'core.owner_login_grant_parity_guard()'::pg_catalog.regprocedure), '') AS triggers,
       (SELECT pg_catalog.pg_get_userbyid(p.proowner)::text || '|definer=' || p.prosecdef::text || '|' || pg_catalog.array_to_string(p.proconfig, ';')
               || '|app=' || pg_catalog.has_function_privilege('crewflow_app', p.oid, 'EXECUTE')::text
               || '|public=' || (p.proacl IS NULL OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(p.proacl) x WHERE x.grantee = 0))::text
          FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('core.mark_shift_rate_resolved(uuid)')) AS fn
  FROM pg_catalog.pg_class c
 WHERE c.oid = pg_catalog.to_regclass('core.shift_resolved_rate')`;

export interface ShiftResolvedRateTableState {
  owner: string;
  rls: boolean;
  force: boolean;
  acl: string;
  policies: string;
  triggers: string;
  fn: string | null;
}

export const EXPECTED_SHIFT_RESOLVED_RATE_STATE: Readonly<ShiftResolvedRateTableState> = Object.freeze({
  owner: 'crewflow',
  rls: true,
  force: true,
  acl: 'crewflow_app:SELECT',
  policies: 'shift_resolved_rate_insert:a,shift_resolved_rate_select:r',
  triggers: [...SHIFT_RESOLVED_RATE_PARITY_TRIGGERS]
    .sort()
    .map((t) => `${t}:O`)
    .join(','),
  fn: 'crewflow|definer=true|search_path=pg_catalog, pg_temp|app=true|public=false',
});

/** Every difference between the catalog and EXPECTED_SHIFT_RESOLVED_RATE_STATE (empty = as reviewed). */
export function shiftResolvedRateStateProblems(row: ShiftResolvedRateTableState | undefined): string[] {
  if (!row) return ['core.shift_resolved_rate: missing'];
  const problems: string[] = [];
  for (const key of Object.keys(EXPECTED_SHIFT_RESOLVED_RATE_STATE) as Array<keyof ShiftResolvedRateTableState>) {
    if (String(row[key]) !== String(EXPECTED_SHIFT_RESOLVED_RATE_STATE[key])) {
      problems.push(`core.shift_resolved_rate.${key}: expected ${JSON.stringify(EXPECTED_SHIFT_RESOLVED_RATE_STATE[key])}, found ${JSON.stringify(row[key])}`);
    }
  }
  return problems;
}
