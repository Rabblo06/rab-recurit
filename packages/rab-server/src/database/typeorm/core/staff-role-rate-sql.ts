// sql-injection-reviewed-file: SQL definition / check module (database layer). Every interpolation is a code constant of this repository (table, column, constraint, trigger, policy and role names, numeric limits); no request or row data reaches these templates. Reviewed 2026-11-21 (Lane C staff role rate, DRAFT for owner SQL review).
/**
 * Lane C (milestone M2, architecture §1 A6 "assignment → staff role rate → venue role rate → org default"): the per-staff,
 * per-job-role pay rate, effective-dated. SQL of migration StaffRoleRateSchema1786722210000, kept as data so the exact
 * statements can be reviewed, scanned and unit-tested. DRAFT — owner SQL review first.
 *
 * WHY `core` AND NOT A WORKSPACE TABLE (lead decision 2026-11-21, owner to confirm; the workspace shape is the alternative —
 * see the PR body). A workspace business table needs a structure level (27, stacked on #300/#310 and blocked on #175), new
 * verify-function counts, fingerprints for three PostgreSQL majors, the C3 cutover copy and the M1 catalogue. A rate row is
 * tenant data of exactly one workspace, so it lives in `core` with organisation_id AND workspace_id and FORCE RLS, like
 * Lane D's staff documents (#280) and the metadata tables (MetadataEngineTables1786721550000). TRADE-OFF: no foreign key
 * to staff_profile or job_role (those rows live in the workspace schema with HWS on, which a core constraint cannot name).
 * The service proves both ids are in the caller's organisation, workspace and scope on every write (404 otherwise), and the
 * rate is only ever read by (staff_profile_id, job_role_id) of a live seat, so a row left behind by a deleted profile or
 * role is never read (staff-role-rate.service.ts, "Orphans").
 *
 * core.staff_role_rate — one row per (staff member, job role, effective period):
 *   - layer 4 (tenant): organisation_id = core.current_org() AND workspace_id = core.current_workspace(), on every policy;
 *   - layer 5 (second, tighter predicate): a NON-venue manager of the bound workspace (core.manager_profile type <> 'venue',
 *     not archived; the payroll managers of payroll_record), on SELECT / INSERT / UPDATE / DELETE. Staff, Venue Managers,
 *     custom workspace members and the Worker see and write nothing, even through a bug;
 *   - INSERT also requires created_by = core.current_uid() (the row names its real author);
 *   - created_by, the ids and created_at never change: crewflow_app holds UPDATE only on pay_rate_pence, effective_from,
 *     effective_to and updated_at, and the owner login is held to the same columns by the reviewed grant-parity guard
 *     (core.owner_login_grant_parity_guard(), an allow-list row trigger) — no new function;
 *   - no two periods of one (workspace, staff member, job role) overlap: EXCLUDE USING gist (btree_gist, InitSchema), both
 *     ends inclusive (the venue rate's own `effective_from <= start AND (effective_to IS NULL OR effective_to >= start)`);
 *   - 0 <= pay_rate_pence <= 100,000,000 (£1,000,000.00 an hour, a sanity ceiling, not a business rule) and
 *     effective_to >= effective_from.
 *
 * ACCESS: owned by crewflow (handed over inside withCrewflowCoreCreate); crewflow_app holds SELECT, INSERT, DELETE and the
 * four column UPDATEs; nothing for PUBLIC. TRUNCATE (which ignores RLS) is refused for the owner login by the same guard.
 * Retention: rows are deleted only by a manager through the audited endpoint; a confirmed seat's pay is its own snapshot
 * (shift_assignment.pay_rate_snapshot_pence), so deleting or editing a rate never reprices history.
 */

export const STAFF_ROLE_RATE_TABLE = 'staff_role_rate';

/** Columns crewflow_app may UPDATE (and the owner login, through the grant-parity allow-list); everything else is immutable. */
export const STAFF_ROLE_RATE_UPDATABLE_COLUMNS: readonly string[] =
  Object.freeze([
    'pay_rate_pence',
    'effective_from',
    'effective_to',
    'updated_at',
  ]);

/** Sanity ceiling of the CHECK, in pence (also the DTO's @Max). */
export const STAFF_ROLE_RATE_MAX_PENCE = 100_000_000;

const TENANT = `(organisation_id = core.current_org()) AND (workspace_id = core.current_workspace())`;
const WORKSPACE_MANAGER = `(EXISTS (SELECT 1 FROM core.manager_profile mp
      WHERE (mp.user_id = core.current_uid()) AND (mp.organisation_id = core.current_org())
        AND (mp.workspace_id = core.current_workspace()) AND (mp.type <> 'venue'::text) AND (mp.archived_at IS NULL)))`;

export const STAFF_ROLE_RATE_TABLE_SQL = `
CREATE TABLE core.staff_role_rate (
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  organisation_id  uuid        NOT NULL,
  workspace_id     uuid        NOT NULL,
  staff_profile_id uuid        NOT NULL,
  job_role_id      uuid        NOT NULL,
  pay_rate_pence   bigint      NOT NULL,
  effective_from   date        NOT NULL,
  effective_to     date,
  created_by       uuid        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_role_rate_pkey PRIMARY KEY (id),
  CONSTRAINT staff_role_rate_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE,
  CONSTRAINT staff_role_rate_workspace_fkey FOREIGN KEY (workspace_id, organisation_id) REFERENCES core.manager_workspace(id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT staff_role_rate_pay_rate_check CHECK (pay_rate_pence >= 0 AND pay_rate_pence <= ${STAFF_ROLE_RATE_MAX_PENCE}),
  CONSTRAINT staff_role_rate_dates_check CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT staff_role_rate_no_overlap EXCLUDE USING gist (
    workspace_id WITH =,
    staff_profile_id WITH =,
    job_role_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  )
);
CREATE INDEX staff_role_rate_lookup_idx ON core.staff_role_rate (workspace_id, staff_profile_id, job_role_id, effective_from DESC)`;

/**
 * The two grant-parity triggers this migration adds with the reviewed core.owner_login_grant_parity_guard() (outside
 * GRANT_PARITY_TARGETS, whose list is consumed by the frozen OwnerLoginGrantParityGuards1786721420000). Counted by
 * owner-login-guards.integration.spec.ts next to that list.
 */
export const STAFF_ROLE_RATE_PARITY_TRIGGERS: readonly string[] = Object.freeze(
  [
    '_staff_role_rate_grant_parity_update',
    '_staff_role_rate_grant_parity_truncate',
  ],
);

export const STAFF_ROLE_RATE_SECURITY_SQL: readonly string[] = Object.freeze([
  'ALTER TABLE core.staff_role_rate ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE core.staff_role_rate FORCE ROW LEVEL SECURITY',
  'REVOKE ALL ON TABLE core.staff_role_rate FROM PUBLIC',
  `CREATE POLICY staff_role_rate_select ON core.staff_role_rate AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (${TENANT} AND ${WORKSPACE_MANAGER})`,
  `CREATE POLICY staff_role_rate_insert ON core.staff_role_rate AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (${TENANT} AND ${WORKSPACE_MANAGER} AND (created_by = core.current_uid()))`,
  `CREATE POLICY staff_role_rate_update ON core.staff_role_rate AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (${TENANT} AND ${WORKSPACE_MANAGER})
  WITH CHECK (${TENANT} AND ${WORKSPACE_MANAGER})`,
  `CREATE POLICY staff_role_rate_delete ON core.staff_role_rate AS PERMISSIVE FOR DELETE TO PUBLIC
  USING (${TENANT} AND ${WORKSPACE_MANAGER})`,
  'GRANT SELECT, INSERT, DELETE ON TABLE core.staff_role_rate TO crewflow_app',
  `GRANT UPDATE (${STAFF_ROLE_RATE_UPDATABLE_COLUMNS.join(', ')}) ON TABLE core.staff_role_rate TO crewflow_app`,
  `CREATE TRIGGER _staff_role_rate_grant_parity_update BEFORE UPDATE ON core."staff_role_rate" FOR EACH ROW EXECUTE FUNCTION core.owner_login_grant_parity_guard(${STAFF_ROLE_RATE_UPDATABLE_COLUMNS.map((c) => `'${c}'`).join(', ')})`,
  'CREATE TRIGGER _staff_role_rate_grant_parity_truncate BEFORE TRUNCATE ON core."staff_role_rate" FOR EACH STATEMENT EXECUTE FUNCTION core.owner_login_grant_parity_guard()',
]);

/** Run inside withCrewflowCoreCreate (crewflow needs CREATE on core to become the owner). */
export const STAFF_ROLE_RATE_OWNERSHIP_SQL: readonly string[] = Object.freeze([
  'ALTER TABLE core.staff_role_rate OWNER TO crewflow',
]);

/** Pre-flight facts: what the migration relies on, and whether the table already exists. */
export const STAFF_ROLE_RATE_PREFLIGHT_SQL = `
SELECT pg_catalog.to_regclass('core.staff_role_rate') IS NOT NULL AS table_present,
       pg_catalog.to_regprocedure('core.owner_login_grant_parity_guard()') IS NOT NULL AS parity_guard,
       pg_catalog.to_regprocedure('core.current_org()') IS NOT NULL AND pg_catalog.to_regprocedure('core.current_workspace()') IS NOT NULL
         AND pg_catalog.to_regprocedure('core.current_uid()') IS NOT NULL AS tenant_functions,
       EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'btree_gist') AS btree_gist,
       EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k
                WHERE k.conrelid = 'core.manager_workspace'::pg_catalog.regclass AND k.contype IN ('u', 'p')
                  AND (SELECT pg_catalog.array_agg(a.attname::text ORDER BY a.attname)
                         FROM pg_catalog.pg_attribute a WHERE a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)) = ARRAY['id', 'organisation_id']) AS workspace_key,
       (SELECT pg_catalog.count(*) FROM pg_catalog.pg_roles WHERE rolname IN ('crewflow', 'crewflow_app'))::int AS roles`;

/** down(): retention — refuses while any rate row exists (counted after NO FORCE in down()'s own transaction). */
export const STAFF_ROLE_RATE_DOWN_UNFORCE_SQL =
  'ALTER TABLE core.staff_role_rate NO FORCE ROW LEVEL SECURITY';
export const STAFF_ROLE_RATE_ROWS_SQL =
  'SELECT pg_catalog.count(*)::int AS n FROM core.staff_role_rate';
export const STAFF_ROLE_RATE_DOWN_SQL = 'DROP TABLE core.staff_role_rate';

/** Post-condition: owner, RLS, ACL (non-owner grantees), column ACL, policies and triggers. */
export const STAFF_ROLE_RATE_STATE_SQL = `
SELECT pg_catalog.pg_get_userbyid(c.relowner)::text AS owner,
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
 WHERE c.oid = pg_catalog.to_regclass('core.staff_role_rate')`;

export interface StaffRoleRateTableState {
  owner: string;
  rls: boolean;
  force: boolean;
  acl: string;
  column_acl: string;
  policies: string;
  triggers: string;
}

const sortedCsv = (values: readonly string[]) => [...values].sort().join(',');

export const EXPECTED_STAFF_ROLE_RATE_STATE: Readonly<StaffRoleRateTableState> =
  Object.freeze({
    owner: 'crewflow',
    rls: true,
    force: true,
    acl: 'crewflow_app:DELETE,crewflow_app:INSERT,crewflow_app:SELECT',
    column_acl: sortedCsv(
      STAFF_ROLE_RATE_UPDATABLE_COLUMNS.map((c) => `crewflow_app:UPDATE:${c}`),
    ),
    policies:
      'staff_role_rate_delete:d,staff_role_rate_insert:a,staff_role_rate_select:r,staff_role_rate_update:w',
    triggers:
      '_staff_role_rate_grant_parity_truncate:O:core.owner_login_grant_parity_guard(),_staff_role_rate_grant_parity_update:O:core.owner_login_grant_parity_guard()',
  });

/** Every difference between the catalog and EXPECTED_STAFF_ROLE_RATE_STATE (empty = as reviewed). */
export function staffRoleRateStateProblems(
  row: StaffRoleRateTableState | undefined,
): string[] {
  if (!row) return ['core.staff_role_rate: missing'];
  const problems: string[] = [];
  for (const key of Object.keys(EXPECTED_STAFF_ROLE_RATE_STATE) as Array<
    keyof StaffRoleRateTableState
  >) {
    if (String(row[key]) !== String(EXPECTED_STAFF_ROLE_RATE_STATE[key])) {
      problems.push(
        `core.staff_role_rate.${key}: expected ${JSON.stringify(EXPECTED_STAFF_ROLE_RATE_STATE[key])}, found ${JSON.stringify(row[key])}`,
      );
    }
  }
  return problems;
}
