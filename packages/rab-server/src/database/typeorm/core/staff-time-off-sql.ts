// sql-injection-reviewed-file: SQL definition / check module (database layer). Every interpolation is a code constant of this repository (table, column, constraint, trigger, policy and role names, numeric limits); no request or row data reaches these templates. Reviewed 2026-11-24 (Lane C staff time off, DRAFT for owner SQL review).
/**
 * Lane C, owner decisions 42 and 48: date-specific staff time off. SQL of migration StaffTimeOffSchema1786722230000, kept as
 * data so the exact statements can be reviewed, scanned and unit-tested. DRAFT — owner SQL review first.
 *
 * Decision 48: a CORE table (not a per-workspace table) carrying organisation_id AND workspace_id, FORCE RLS, and the service
 * checks every staff id. Like Lane D's staff documents (#280) the row also carries the staff member's USER id
 * (`staff_user_id`, server-set from the staff profile): a core policy cannot name the workspace-schema staff_profile table,
 * whereas "this row is mine" (`staff_user_id = core.current_uid()`) is a predicate RLS can enforce on its own. There is no
 * foreign key to staff_profile (it lives in the workspace schema with HWS on); StaffTimeOffService proves the profile is in
 * the caller's organisation, workspace and scope on every write (404 otherwise) and takes staff_user_id from that profile.
 *
 * Decision 42: staff REQUEST time off, a manager APPROVES it, and APPROVED time off is a hard block on new offers for the
 * organisation-local days it covers (modules/staff/services/staff-time-off-check.ts, at send and at confirmation).
 *
 * core.staff_time_off — one row per requested or manager-entered range:
 *   - layer 4 (tenant): organisation_id = core.current_org() AND workspace_id = core.current_workspace(), on every policy;
 *   - layer 5 (second, tighter predicate), per actor:
 *       managers (a NON-venue, non-archived core.manager_profile of the bound workspace, as core.staff_role_rate):
 *         SELECT every row of the workspace; INSERT only an `approved` row they requested and decided themselves
 *         (manager-entered time off); UPDATE only a `requested` or `approved` row, and the new row must be a decision
 *         (approved / declined, decided_by = the caller) or a cancellation of approved time off (cancelled_by = the caller,
 *         the approval kept). Never on their own row (staff_user_id <> the caller): no self-approval;
 *       the staff member (staff_user_id = core.current_uid()):
 *         SELECT their own rows; INSERT only a `requested` row for themselves (requested_by = staff_user_id = the caller);
 *         UPDATE only their own still-`requested` row, and only to `cancelled` by themselves with no decision;
 *       Venue Managers, other staff, custom workspace members and the Worker: nothing.
 *   - immutable columns: crewflow_app holds UPDATE only on the decision / cancellation columns and updated_at; the owner login
 *     is held to the same columns by the reviewed grant-parity guard (core.owner_login_grant_parity_guard(), allow-list row
 *     trigger) — no new function;
 *   - no DELETE: time off is never deleted, only declined or cancelled (crewflow_app holds no DELETE; the owner login is
 *     refused by the parity guard; TRUNCATE, which ignores RLS, likewise);
 *   - CHECKs: status in the four states; ends_on >= starts_on and at most 366 calendar days (both ends inclusive); note and
 *     decline reason at most 500 characters; the decision / cancellation columns consistent with the status;
 *   - no two APPROVED ranges of one staff member overlap (EXCLUDE USING gist, btree_gist from InitSchema, WHERE approved).
 *
 * SECURITY TRADE-OFF (also in THREAT-MODEL.md): a policy sees the old row (USING) and the new row (WITH CHECK) separately and
 * permissive policies are OR-ed, so RLS cannot pair a specific old status with a specific new one. Within the manager branch it
 * allows approved → approved / declined (a re-decision) on top of the real edges; StaffTimeOffService refuses those with
 * assertTransition (STAFF_TIME_OFF_TRANSITIONS, 409) before any write. No new trigger function was added for this (owner may
 * ask for one — a BEFORE UPDATE guard like core.staff_document_guard()).
 *
 * ACCESS: owned by crewflow (handed over inside withCrewflowCoreCreate); crewflow_app holds SELECT, INSERT and the seven column
 * UPDATEs; nothing for PUBLIC.
 */

export const STAFF_TIME_OFF_TABLE = 'staff_time_off';

/** Columns crewflow_app may UPDATE (and the owner login, through the grant-parity allow-list); everything else is immutable. */
export const STAFF_TIME_OFF_UPDATABLE_COLUMNS: readonly string[] =
  Object.freeze([
    'status',
    'decided_by',
    'decided_at',
    'decline_reason',
    'cancelled_by',
    'cancelled_at',
    'updated_at',
  ]);

/** CHECK limits (also the DTOs' limits; pinned to @rab/shared by the spec). */
export const STAFF_TIME_OFF_MAX_DAYS_1786722230000 = 366;
export const STAFF_TIME_OFF_TEXT_MAX_1786722230000 = 500;

const TENANT = `(organisation_id = core.current_org()) AND (workspace_id = core.current_workspace())`;
const WORKSPACE_MANAGER = `(EXISTS (SELECT 1 FROM core.manager_profile mp
      WHERE (mp.user_id = core.current_uid()) AND (mp.organisation_id = core.current_org())
        AND (mp.workspace_id = core.current_workspace()) AND (mp.type <> 'venue'::text) AND (mp.archived_at IS NULL)))`;
const OWN = `(staff_user_id = core.current_uid())`;
const NOT_OWN = `(staff_user_id <> core.current_uid())`;

export const STAFF_TIME_OFF_TABLE_SQL = `
CREATE TABLE core.staff_time_off (
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  organisation_id  uuid        NOT NULL,
  workspace_id     uuid        NOT NULL,
  staff_profile_id uuid        NOT NULL,
  staff_user_id    uuid        NOT NULL,
  starts_on        date        NOT NULL,
  ends_on          date        NOT NULL,
  status           text        NOT NULL DEFAULT 'requested',
  note             text,
  requested_by     uuid        NOT NULL,
  decided_by       uuid,
  decided_at       timestamptz,
  decline_reason   text,
  cancelled_by     uuid,
  cancelled_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_time_off_pkey PRIMARY KEY (id),
  CONSTRAINT staff_time_off_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE,
  CONSTRAINT staff_time_off_workspace_fkey FOREIGN KEY (workspace_id, organisation_id) REFERENCES core.manager_workspace(id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT staff_time_off_status_check CHECK (status IN ('requested', 'approved', 'declined', 'cancelled')),
  CONSTRAINT staff_time_off_dates_check CHECK (ends_on >= starts_on AND ends_on - starts_on < ${STAFF_TIME_OFF_MAX_DAYS_1786722230000}),
  CONSTRAINT staff_time_off_note_check CHECK (note IS NULL OR char_length(note) <= ${STAFF_TIME_OFF_TEXT_MAX_1786722230000}),
  CONSTRAINT staff_time_off_decline_reason_check CHECK (decline_reason IS NULL OR char_length(decline_reason) BETWEEN 1 AND ${STAFF_TIME_OFF_TEXT_MAX_1786722230000}),
  CONSTRAINT staff_time_off_decision_check CHECK (CASE status
    WHEN 'requested' THEN decided_by IS NULL AND decided_at IS NULL AND decline_reason IS NULL AND cancelled_by IS NULL AND cancelled_at IS NULL
    WHEN 'approved' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL AND decline_reason IS NULL AND cancelled_by IS NULL AND cancelled_at IS NULL
    WHEN 'declined' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL AND decline_reason IS NOT NULL AND cancelled_by IS NULL AND cancelled_at IS NULL
    WHEN 'cancelled' THEN cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL AND decline_reason IS NULL AND ((decided_by IS NULL) = (decided_at IS NULL))
    ELSE false END),
  CONSTRAINT staff_time_off_no_overlapping_approved EXCLUDE USING gist (
    workspace_id WITH =,
    staff_profile_id WITH =,
    daterange(starts_on, ends_on, '[]') WITH &&
  ) WHERE (status = 'approved')
);
CREATE INDEX staff_time_off_staff_idx ON core.staff_time_off (workspace_id, staff_profile_id, starts_on, ends_on);
CREATE INDEX staff_time_off_status_idx ON core.staff_time_off (workspace_id, status, starts_on)`;

/**
 * The three grant-parity triggers this migration adds with the reviewed core.owner_login_grant_parity_guard() (outside
 * GRANT_PARITY_TARGETS, whose list is consumed by the frozen OwnerLoginGrantParityGuards1786721420000). Counted by
 * owner-login-guards.integration.spec.ts next to that list.
 */
export const STAFF_TIME_OFF_PARITY_TRIGGERS: readonly string[] = Object.freeze([
  '_staff_time_off_grant_parity_update',
  '_staff_time_off_grant_parity_delete',
  '_staff_time_off_grant_parity_truncate',
]);

export const STAFF_TIME_OFF_SECURITY_SQL: readonly string[] = Object.freeze([
  'ALTER TABLE core.staff_time_off ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE core.staff_time_off FORCE ROW LEVEL SECURITY',
  'REVOKE ALL ON TABLE core.staff_time_off FROM PUBLIC',
  `CREATE POLICY staff_time_off_manager_select ON core.staff_time_off AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (${TENANT} AND ${WORKSPACE_MANAGER})`,
  `CREATE POLICY staff_time_off_own_select ON core.staff_time_off AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (${TENANT} AND ${OWN})`,
  `CREATE POLICY staff_time_off_manager_insert ON core.staff_time_off AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (${TENANT} AND ${WORKSPACE_MANAGER} AND ${NOT_OWN} AND (status = 'approved'::text)
    AND (requested_by = core.current_uid()) AND (decided_by = core.current_uid()))`,
  `CREATE POLICY staff_time_off_own_insert ON core.staff_time_off AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (${TENANT} AND ${OWN} AND (status = 'requested'::text) AND (requested_by = core.current_uid()))`,
  `CREATE POLICY staff_time_off_manager_update ON core.staff_time_off AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (${TENANT} AND ${WORKSPACE_MANAGER} AND ${NOT_OWN} AND (status = ANY (ARRAY['requested'::text, 'approved'::text])))
  WITH CHECK (${TENANT} AND ${WORKSPACE_MANAGER} AND ${NOT_OWN}
    AND (((status = ANY (ARRAY['approved'::text, 'declined'::text])) AND (decided_by = core.current_uid()))
      OR ((status = 'cancelled'::text) AND (cancelled_by = core.current_uid()) AND (decided_by IS NOT NULL))))`,
  `CREATE POLICY staff_time_off_own_update ON core.staff_time_off AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (${TENANT} AND ${OWN} AND (status = 'requested'::text))
  WITH CHECK (${TENANT} AND ${OWN} AND (status = 'cancelled'::text) AND (cancelled_by = core.current_uid()) AND (decided_by IS NULL))`,
  'GRANT SELECT, INSERT ON TABLE core.staff_time_off TO crewflow_app',
  `GRANT UPDATE (${STAFF_TIME_OFF_UPDATABLE_COLUMNS.join(', ')}) ON TABLE core.staff_time_off TO crewflow_app`,
  `CREATE TRIGGER _staff_time_off_grant_parity_update BEFORE UPDATE ON core."staff_time_off" FOR EACH ROW EXECUTE FUNCTION core.owner_login_grant_parity_guard(${STAFF_TIME_OFF_UPDATABLE_COLUMNS.map((c) => `'${c}'`).join(', ')})`,
  'CREATE TRIGGER _staff_time_off_grant_parity_delete BEFORE DELETE ON core."staff_time_off" FOR EACH STATEMENT EXECUTE FUNCTION core.owner_login_grant_parity_guard()',
  'CREATE TRIGGER _staff_time_off_grant_parity_truncate BEFORE TRUNCATE ON core."staff_time_off" FOR EACH STATEMENT EXECUTE FUNCTION core.owner_login_grant_parity_guard()',
]);

/** Run inside withCrewflowCoreCreate (crewflow needs CREATE on core to become the owner). */
export const STAFF_TIME_OFF_OWNERSHIP_SQL: readonly string[] = Object.freeze([
  'ALTER TABLE core.staff_time_off OWNER TO crewflow',
]);

/** Pre-flight facts: what the migration relies on, and whether the table already exists. */
export const STAFF_TIME_OFF_PREFLIGHT_SQL = `
SELECT pg_catalog.to_regclass('core.staff_time_off') IS NOT NULL AS table_present,
       pg_catalog.to_regprocedure('core.owner_login_grant_parity_guard()') IS NOT NULL AS parity_guard,
       pg_catalog.to_regprocedure('core.current_org()') IS NOT NULL AND pg_catalog.to_regprocedure('core.current_workspace()') IS NOT NULL
         AND pg_catalog.to_regprocedure('core.current_uid()') IS NOT NULL AS tenant_functions,
       EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'btree_gist') AS btree_gist,
       EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k
                WHERE k.conrelid = 'core.manager_workspace'::pg_catalog.regclass AND k.contype IN ('u', 'p')
                  AND (SELECT pg_catalog.array_agg(a.attname::text ORDER BY a.attname)
                         FROM pg_catalog.pg_attribute a WHERE a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)) = ARRAY['id', 'organisation_id']) AS workspace_key,
       (SELECT pg_catalog.count(*) FROM pg_catalog.pg_roles WHERE rolname IN ('crewflow', 'crewflow_app'))::int AS roles`;

/** down(): retention — refuses while any time-off row exists (counted after NO FORCE in down()'s own transaction). */
export const STAFF_TIME_OFF_DOWN_UNFORCE_SQL =
  'ALTER TABLE core.staff_time_off NO FORCE ROW LEVEL SECURITY';
export const STAFF_TIME_OFF_ROWS_SQL =
  'SELECT pg_catalog.count(*)::int AS n FROM core.staff_time_off';
export const STAFF_TIME_OFF_DOWN_SQL = 'DROP TABLE core.staff_time_off';

/** Post-condition: owner, RLS, ACL (non-owner grantees), column ACL, policies and triggers. */
export const STAFF_TIME_OFF_STATE_SQL = `
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
 WHERE c.oid = pg_catalog.to_regclass('core.staff_time_off')`;

export interface StaffTimeOffTableState {
  owner: string;
  rls: boolean;
  force: boolean;
  acl: string;
  column_acl: string;
  policies: string;
  triggers: string;
}

const sortedCsv = (values: readonly string[]) => [...values].sort().join(',');

export const EXPECTED_STAFF_TIME_OFF_STATE: Readonly<StaffTimeOffTableState> =
  Object.freeze({
    owner: 'crewflow',
    rls: true,
    force: true,
    acl: 'crewflow_app:INSERT,crewflow_app:SELECT',
    column_acl: sortedCsv(
      STAFF_TIME_OFF_UPDATABLE_COLUMNS.map((c) => `crewflow_app:UPDATE:${c}`),
    ),
    policies:
      'staff_time_off_manager_insert:a,staff_time_off_manager_select:r,staff_time_off_manager_update:w,staff_time_off_own_insert:a,staff_time_off_own_select:r,staff_time_off_own_update:w',
    triggers:
      '_staff_time_off_grant_parity_delete:O:core.owner_login_grant_parity_guard(),_staff_time_off_grant_parity_truncate:O:core.owner_login_grant_parity_guard(),_staff_time_off_grant_parity_update:O:core.owner_login_grant_parity_guard()',
  });

/** Every difference between the catalog and EXPECTED_STAFF_TIME_OFF_STATE (empty = as reviewed). */
export function staffTimeOffStateProblems(
  row: StaffTimeOffTableState | undefined,
): string[] {
  if (!row) return ['core.staff_time_off: missing'];
  const problems: string[] = [];
  for (const key of Object.keys(EXPECTED_STAFF_TIME_OFF_STATE) as Array<
    keyof StaffTimeOffTableState
  >) {
    if (String(row[key]) !== String(EXPECTED_STAFF_TIME_OFF_STATE[key])) {
      problems.push(
        `core.staff_time_off.${key}: expected ${JSON.stringify(EXPECTED_STAFF_TIME_OFF_STATE[key])}, found ${JSON.stringify(row[key])}`,
      );
    }
  }
  return problems;
}
