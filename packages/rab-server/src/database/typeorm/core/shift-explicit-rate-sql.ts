// sql-injection-reviewed-file: SQL definition / check module (database layer). Every interpolation is a code constant of this repository (table, column, constraint, trigger, policy and role names); no request or row data reaches these templates. Reviewed 2026-11-24 (Lane C owner decision 41, DRAFT for owner SQL review).
/**
 * Owner decision 41 (DECISIONS-PENDING.md, decided 2026-11-22): "an explicit rate typed on the shift wins" over a staff
 * role rate. SQL of migration ShiftExplicitRate1786722220000, kept as data so the exact statements can be reviewed. DRAFT —
 * owner SQL review first.
 *
 * WHY A CORE SIDE TABLE. The shift row stores one resolved number (`pay_rate_pence`) and does not record whether a manager
 * typed it or it came from the venue role rate / job role default. A new column on `shift` would be a workspace-table
 * change (structure level, fingerprints for three PostgreSQL majors, the blocked 0.7.0 chain — owner decision 48). Instead,
 * one MARKER row per shift whose rate was typed explicitly, written in the shift-creating transaction
 * (SchedulingService.insertNewShiftTx when `payRatePence` was given). Presence = "explicit". No amount is stored here: the
 * shift's own `pay_rate_pence` stays the only number (a shift's rate never changes after creation — updateDraft never
 * reprices — so the marker cannot go stale).
 *
 * core.shift_explicit_rate:
 *   - layer 4 (tenant): organisation_id = core.current_org() AND workspace_id = core.current_workspace(), on both policies;
 *   - layer 5: a NON-venue, non-archived manager of the bound workspace (the shift creators and the offer senders who
 *     confirm); INSERT also created_by = core.current_uid();
 *   - INSERT-only: crewflow_app holds SELECT and INSERT only; the owner login is refused UPDATE, DELETE and TRUNCATE by the
 *     reviewed core.owner_login_grant_parity_guard() (statement level) — no new function;
 *   - no foreign key to `shift` (a workspace table with HWS on); shifts are never hard-deleted by the application (archive is
 *     soft), and a marker is only ever read by the id of the seat's own shift, so a marker can never apply to another shift.
 */

export const SHIFT_EXPLICIT_RATE_TABLE = 'shift_explicit_rate';

const TENANT = `(organisation_id = core.current_org()) AND (workspace_id = core.current_workspace())`;
const WORKSPACE_MANAGER = `(EXISTS (SELECT 1 FROM core.manager_profile mp
      WHERE (mp.user_id = core.current_uid()) AND (mp.organisation_id = core.current_org())
        AND (mp.workspace_id = core.current_workspace()) AND (mp.type <> 'venue'::text) AND (mp.archived_at IS NULL)))`;

/** The three grant-parity triggers (counted by owner-login-guards.integration.spec.ts next to GRANT_PARITY_TARGETS). */
export const SHIFT_EXPLICIT_RATE_PARITY_TRIGGERS: readonly string[] =
  Object.freeze([
    '_shift_explicit_rate_grant_parity_update',
    '_shift_explicit_rate_grant_parity_delete',
    '_shift_explicit_rate_grant_parity_truncate',
  ]);

export const SHIFT_EXPLICIT_RATE_TABLE_SQL = `
CREATE TABLE core.shift_explicit_rate (
  shift_id        uuid        NOT NULL,
  organisation_id uuid        NOT NULL,
  workspace_id    uuid        NOT NULL,
  created_by      uuid        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shift_explicit_rate_pkey PRIMARY KEY (shift_id),
  CONSTRAINT shift_explicit_rate_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE,
  CONSTRAINT shift_explicit_rate_workspace_fkey FOREIGN KEY (workspace_id, organisation_id) REFERENCES core.manager_workspace(id, organisation_id) ON DELETE CASCADE
)`;

export const SHIFT_EXPLICIT_RATE_SECURITY_SQL: readonly string[] =
  Object.freeze([
    'ALTER TABLE core.shift_explicit_rate ENABLE ROW LEVEL SECURITY',
    'ALTER TABLE core.shift_explicit_rate FORCE ROW LEVEL SECURITY',
    'REVOKE ALL ON TABLE core.shift_explicit_rate FROM PUBLIC',
    `CREATE POLICY shift_explicit_rate_select ON core.shift_explicit_rate AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (${TENANT} AND ${WORKSPACE_MANAGER})`,
    `CREATE POLICY shift_explicit_rate_insert ON core.shift_explicit_rate AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (${TENANT} AND ${WORKSPACE_MANAGER} AND (created_by = core.current_uid()))`,
    'GRANT SELECT, INSERT ON TABLE core.shift_explicit_rate TO crewflow_app',
    'CREATE TRIGGER _shift_explicit_rate_grant_parity_update BEFORE UPDATE ON core."shift_explicit_rate" FOR EACH STATEMENT EXECUTE FUNCTION core.owner_login_grant_parity_guard()',
    'CREATE TRIGGER _shift_explicit_rate_grant_parity_delete BEFORE DELETE ON core."shift_explicit_rate" FOR EACH STATEMENT EXECUTE FUNCTION core.owner_login_grant_parity_guard()',
    'CREATE TRIGGER _shift_explicit_rate_grant_parity_truncate BEFORE TRUNCATE ON core."shift_explicit_rate" FOR EACH STATEMENT EXECUTE FUNCTION core.owner_login_grant_parity_guard()',
  ]);

/** Run inside withCrewflowCoreCreate (crewflow needs CREATE on core to become the owner). */
export const SHIFT_EXPLICIT_RATE_OWNERSHIP_SQL: readonly string[] =
  Object.freeze(['ALTER TABLE core.shift_explicit_rate OWNER TO crewflow']);

export const SHIFT_EXPLICIT_RATE_PREFLIGHT_SQL = `
SELECT pg_catalog.to_regclass('core.shift_explicit_rate') IS NOT NULL AS table_present,
       pg_catalog.to_regprocedure('core.owner_login_grant_parity_guard()') IS NOT NULL AS parity_guard,
       (SELECT pg_catalog.count(*) FROM pg_catalog.pg_roles WHERE rolname IN ('crewflow', 'crewflow_app'))::int AS roles`;

/** down(): retention — refuses while any marker exists (counted after NO FORCE in down()'s own transaction). */
export const SHIFT_EXPLICIT_RATE_DOWN_UNFORCE_SQL =
  'ALTER TABLE core.shift_explicit_rate NO FORCE ROW LEVEL SECURITY';
export const SHIFT_EXPLICIT_RATE_ROWS_SQL =
  'SELECT pg_catalog.count(*)::int AS n FROM core.shift_explicit_rate';
export const SHIFT_EXPLICIT_RATE_DOWN_SQL =
  'DROP TABLE core.shift_explicit_rate';

export const SHIFT_EXPLICIT_RATE_STATE_SQL = `
SELECT pg_catalog.pg_get_userbyid(c.relowner)::text AS owner,
       c.relrowsecurity AS rls,
       c.relforcerowsecurity AS force,
       coalesce((SELECT pg_catalog.string_agg(x.v, ',' ORDER BY x.v) FROM (
          SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END || ':' || a.privilege_type AS v
            FROM pg_catalog.aclexplode(c.relacl) a WHERE a.grantee <> c.relowner) x), '') AS acl,
       coalesce((SELECT pg_catalog.string_agg(p.polname || ':' || p.polcmd::text, ',' ORDER BY p.polname)
          FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid), '') AS policies,
       coalesce((SELECT pg_catalog.string_agg(t.tgname || ':' || t.tgenabled::text || ':' || t.tgfoid::pg_catalog.regprocedure::text, ',' ORDER BY t.tgname)
          FROM pg_catalog.pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal), '') AS triggers
  FROM pg_catalog.pg_class c
 WHERE c.oid = pg_catalog.to_regclass('core.shift_explicit_rate')`;

export interface ShiftExplicitRateTableState {
  owner: string;
  rls: boolean;
  force: boolean;
  acl: string;
  policies: string;
  triggers: string;
}

export const EXPECTED_SHIFT_EXPLICIT_RATE_STATE: Readonly<ShiftExplicitRateTableState> =
  Object.freeze({
    owner: 'crewflow',
    rls: true,
    force: true,
    acl: 'crewflow_app:INSERT,crewflow_app:SELECT',
    policies: 'shift_explicit_rate_insert:a,shift_explicit_rate_select:r',
    triggers: [...SHIFT_EXPLICIT_RATE_PARITY_TRIGGERS]
      .sort()
      .map((t) => `${t}:O:core.owner_login_grant_parity_guard()`)
      .join(','),
  });

/** Every difference between the catalog and EXPECTED_SHIFT_EXPLICIT_RATE_STATE (empty = as reviewed). */
export function shiftExplicitRateStateProblems(
  row: ShiftExplicitRateTableState | undefined,
): string[] {
  if (!row) return ['core.shift_explicit_rate: missing'];
  const problems: string[] = [];
  for (const key of Object.keys(EXPECTED_SHIFT_EXPLICIT_RATE_STATE) as Array<
    keyof ShiftExplicitRateTableState
  >) {
    if (String(row[key]) !== String(EXPECTED_SHIFT_EXPLICIT_RATE_STATE[key])) {
      problems.push(
        `core.shift_explicit_rate.${key}: expected ${JSON.stringify(EXPECTED_SHIFT_EXPLICIT_RATE_STATE[key])}, found ${JSON.stringify(row[key])}`,
      );
    }
  }
  return problems;
}
