// sql-injection-reviewed-file: SQL definition / check module (database layer). Every interpolation is a code constant of this repository (table, column, constraint, trigger, policy and role names, frozen value lists); no request or row data reaches these templates. Reviewed 2026-11-21 (Lane D staff documents, DRAFT for owner SQL review).
/**
 * Lane D (milestone M1): staff documents with an expiry. SQL of migration StaffDocumentSchema1786722300000, kept as data so
 * the exact statements can be reviewed, scanned and unit-tested. DRAFT — owner SQL review first.
 *
 * WHY `core` AND NOT A WORKSPACE TABLE. Adding a workspace business table needs a new workspace-schema module, structure
 * level, verify-function counts and fingerprints for three PostgreSQL majors (workspace-schema-modules.ts). A document row
 * is tenant data of exactly one workspace, so it lives in `core` with organisation_id AND workspace_id and FORCE RLS on
 * both, like the metadata tables (MetadataEngineTables1786721550000). It is keyed by the staff member's USER id
 * (`staff_user_id`), not by `staff_profile.id`: the profile lives in the workspace schema, which a core policy cannot name,
 * whereas "this row is mine" (`staff_user_id = core.current_uid()`) is a predicate RLS can enforce on its own.
 *
 * core.staff_document — one row per uploaded file:
 *   - layer 4 (tenant): organisation_id = core.current_org() AND workspace_id = core.current_workspace(), on every policy;
 *   - layer 5 (second, tighter predicate): SELECT only for the staff member themselves (staff_user_id = current uid), a
 *     NON-venue manager of the bound workspace (core.manager_profile, not archived), or the Worker marker (expiry alerts);
 *     INSERT only as the uploader (uploaded_by = current uid), status `pending`, scan state `not_scanned` or `clean`, for
 *     oneself or as such a manager; UPDATE only by such a manager and never on one's own document;
 *     no DELETE policy and no DELETE grant (history is retained — retention rule is an OWNER DECISION);
 *   - core.staff_document_guard() (BEFORE UPDATE, row): identity, file and dates never change; the status follows
 *     STAFF_DOCUMENT_TRANSITIONS (@rab/shared); decision columns change only with a transition and earlier decisions are
 *     kept; a recorded scan verdict never changes; updated_at is set here. BEFORE TRUNCATE (statement): refused except for
 *     crewflow, rab_secure_owner (their definers / foreign-key actions) and a superuser — TRUNCATE ignores RLS.
 * core.staff_document_requirement — per-organisation OVERRIDES of which types are REQUIRED. No row = the code default
 *   (DEFAULT_REQUIRED_STAFF_DOCUMENT_TYPES in @rab/shared: Right to Work only — the owner's recommended default, still an
 *   OWNER DECISION), so changing the default never needs a data migration and a new organisation needs no seed row.
 *   SELECT for anyone in the organisation (staff see what is required; the offer check reads it); INSERT / UPDATE / DELETE
 *   only by a non-venue manager of the organisation, recorded as updated_by = current uid.
 *
 * ACCESS: both tables and the guard function are owned by crewflow (handed over inside withCrewflowCoreCreate); crewflow_app
 * holds SELECT + INSERT + column UPDATE (decision and scan columns) on staff_document and SELECT / INSERT / DELETE + column
 * UPDATE (required, updated_by, updated_at) on the requirement table; nothing for PUBLIC. The owner login is bound by FORCE
 * RLS; the guard trigger stops it from changing the columns crewflow_app cannot update (owner-login grant parity, without a new GRANT_PARITY_TARGETS entry).
 */

/** Frozen literal (a merged migration's SQL never changes when a shared constant changes); pinned to @rab/shared by the spec. */
export const STAFF_DOCUMENT_TYPES_1786722300000: readonly string[] =
  Object.freeze([
    'right_to_work',
    'passport',
    'visa_or_permit',
    'dbs_check',
    'sia_licence',
    'personal_licence',
    'food_hygiene',
    'first_aid',
    'other',
  ]);
export const REQUIRABLE_STAFF_DOCUMENT_TYPES_1786722300000: readonly string[] =
  Object.freeze(
    STAFF_DOCUMENT_TYPES_1786722300000.filter((t) => t !== 'other'),
  );

const list = (values: readonly string[]) =>
  values.map((v) => `'${v}'`).join(', ');

/** stored_file.kind and notification_preference.notification_type CHECKs, before and after (last set by 1786719200000). */
export const STORED_FILE_KINDS_BEFORE_1786722300000: readonly string[] =
  Object.freeze([
    'PROFILE_IMAGE',
    'ORGANISATION_LOGO',
    'WORKSPACE_LOGO',
    'SHIFT_ROSTER_PDF',
    'FINAL_TIMESHEET_PDF',
    'VENUE_PHOTO',
    'APPROVED_SHIFT_STATEMENT_PDF',
    'PAYSLIP_PDF',
  ]);
export const STORED_FILE_KINDS_AFTER_1786722300000: readonly string[] =
  Object.freeze([...STORED_FILE_KINDS_BEFORE_1786722300000, 'STAFF_DOCUMENT']);
export const NOTIFICATION_TYPES_BEFORE_1786722300000: readonly string[] =
  Object.freeze([
    'offer_sent',
    'offer_expired',
    'offer_accepted',
    'offer_declined',
    'offer_confirmed',
    'offer_rejected',
    'shift_reminder_24h',
    'shift_reminder_2h',
    'shift_reminder_30m',
    'shift_assignment_no_show',
    'attendance_missing_clock_out',
    'shift_request_submitted',
    'shift_request_approved',
    'shift_request_declined',
    'shift_request_staff_removed',
    'late_clock_in',
    'shift_cancelled',
    'replacement_required',
    'manager_confirmation_timeout',
    'clock_in_window_open',
    'shift_statement_ready',
    'payslip_available',
    'payroll_period_attention',
  ]);
export const NOTIFICATION_TYPES_AFTER_1786722300000: readonly string[] =
  Object.freeze([
    ...NOTIFICATION_TYPES_BEFORE_1786722300000,
    'staff_document_expiring',
  ]);

export const STAFF_DOCUMENT_TABLES = [
  'staff_document',
  'staff_document_requirement',
] as const;
export const STAFF_DOCUMENT_GUARD_FUNCTION = 'core.staff_document_guard()';

const TENANT = `(organisation_id = core.current_org()) AND (workspace_id = core.current_workspace())`;
const WORKSPACE_MANAGER = `(EXISTS (SELECT 1 FROM core.manager_profile mp
      WHERE (mp.user_id = core.current_uid()) AND (mp.organisation_id = core.current_org())
        AND (mp.workspace_id = core.current_workspace()) AND (mp.type <> 'venue'::text) AND (mp.archived_at IS NULL)))`;
const ORGANISATION_MANAGER = `(EXISTS (SELECT 1 FROM core.manager_profile mp
      WHERE (mp.user_id = core.current_uid()) AND (mp.organisation_id = core.current_org())
        AND (mp.type <> 'venue'::text) AND (mp.archived_at IS NULL)))`;
const OWN = `(staff_user_id = core.current_uid())`;
const WORKER = `(current_setting('rab.actor_type'::text, true) = 'worker'::text)`;

/** Columns crewflow_app may UPDATE on core.staff_document (decisions and scan evidence); everything else is immutable. */
export const STAFF_DOCUMENT_UPDATABLE_COLUMNS: readonly string[] =
  Object.freeze([
    'status',
    'verified_by',
    'verified_at',
    'rejected_by',
    'rejected_at',
    'rejection_reason',
    'revoked_by',
    'revoked_at',
    'revocation_reason',
    'scan_status',
    'scan_engine',
    'scanned_at',
  ]);

export const STAFF_DOCUMENT_TABLES_SQL = `
CREATE TABLE core.staff_document (
  id                uuid        NOT NULL DEFAULT gen_random_uuid(),
  organisation_id   uuid        NOT NULL,
  workspace_id      uuid        NOT NULL,
  staff_user_id     uuid        NOT NULL,
  document_type     text        NOT NULL,
  file_id           uuid        NOT NULL,
  issued_on         date,
  expires_on        date,
  status            text        NOT NULL DEFAULT 'pending',
  scan_status       text        NOT NULL DEFAULT 'not_scanned',
  scan_engine       text,
  scanned_at        timestamptz,
  uploaded_by       uuid        NOT NULL,
  verified_by       uuid,
  verified_at       timestamptz,
  rejected_by       uuid,
  rejected_at       timestamptz,
  rejection_reason  text,
  revoked_by        uuid,
  revoked_at        timestamptz,
  revocation_reason text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_document_pkey PRIMARY KEY (id),
  CONSTRAINT staff_document_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE,
  CONSTRAINT staff_document_workspace_fkey FOREIGN KEY (workspace_id, organisation_id) REFERENCES core.manager_workspace(id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT staff_document_file_id_fkey FOREIGN KEY (file_id) REFERENCES core.stored_file(id),
  CONSTRAINT staff_document_file_id_key UNIQUE (file_id),
  CONSTRAINT staff_document_type_check CHECK (document_type IN (${list(STAFF_DOCUMENT_TYPES_1786722300000)})),
  CONSTRAINT staff_document_status_check CHECK (status IN ('pending', 'verified', 'rejected', 'revoked')),
  CONSTRAINT staff_document_scan_status_check CHECK (scan_status IN ('not_scanned', 'clean', 'infected')),
  CONSTRAINT staff_document_scan_evidence_check CHECK (
    (scan_status = 'not_scanned' AND scan_engine IS NULL AND scanned_at IS NULL)
    OR (scan_status <> 'not_scanned' AND scan_engine IS NOT NULL AND char_length(scan_engine) BETWEEN 1 AND 100 AND scanned_at IS NOT NULL)
  ),
  CONSTRAINT staff_document_dates_check CHECK (issued_on IS NULL OR expires_on IS NULL OR expires_on >= issued_on),
  CONSTRAINT staff_document_reason_check CHECK (
    (rejection_reason IS NULL OR char_length(rejection_reason) BETWEEN 3 AND 500)
    AND (revocation_reason IS NULL OR char_length(revocation_reason) BETWEEN 3 AND 500)
  ),
  CONSTRAINT staff_document_decision_check CHECK (CASE status
    WHEN 'pending' THEN verified_by IS NULL AND verified_at IS NULL AND rejected_by IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL
                        AND revoked_by IS NULL AND revoked_at IS NULL AND revocation_reason IS NULL
    WHEN 'verified' THEN verified_by IS NOT NULL AND verified_at IS NOT NULL AND rejected_by IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL
                        AND revoked_by IS NULL AND revoked_at IS NULL AND revocation_reason IS NULL
    WHEN 'rejected' THEN rejected_by IS NOT NULL AND rejected_at IS NOT NULL AND rejection_reason IS NOT NULL AND verified_by IS NULL AND verified_at IS NULL
                        AND revoked_by IS NULL AND revoked_at IS NULL AND revocation_reason IS NULL
    WHEN 'revoked' THEN revoked_by IS NOT NULL AND revoked_at IS NOT NULL AND rejected_by IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL
                        AND ((verified_by IS NULL) = (verified_at IS NULL))
    ELSE false END)
);
CREATE INDEX staff_document_staff_idx ON core.staff_document (workspace_id, staff_user_id, document_type);
CREATE INDEX staff_document_expiry_idx ON core.staff_document (workspace_id, expires_on) WHERE status IN ('pending', 'verified') AND expires_on IS NOT NULL;

CREATE TABLE core.staff_document_requirement (
  organisation_id uuid        NOT NULL,
  document_type   text        NOT NULL,
  required        boolean     NOT NULL,
  updated_by      uuid        NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_document_requirement_pkey PRIMARY KEY (organisation_id, document_type),
  CONSTRAINT staff_document_requirement_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE,
  CONSTRAINT staff_document_requirement_type_check CHECK (document_type IN (${list(REQUIRABLE_STAFF_DOCUMENT_TYPES_1786722300000)}))
);`;

export const STAFF_DOCUMENT_GUARD_FUNCTION_SQL = `CREATE FUNCTION core.staff_document_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_privileged boolean := current_user IN ('crewflow'::name, 'rab_secure_owner'::name)
    OR coalesce((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false);
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    IF v_privileged THEN RETURN NULL; END IF;
    RAISE EXCEPTION 'staff document tables cannot be truncated' USING ERRCODE = '42501';
  END IF;
  IF TG_OP <> 'UPDATE' OR TG_TABLE_NAME IS DISTINCT FROM 'staff_document' THEN
    RAISE EXCEPTION 'core.staff_document_guard: unexpected % on %', TG_OP, TG_TABLE_NAME USING ERRCODE = '42501';
  END IF;
  IF (NEW.id, NEW.organisation_id, NEW.workspace_id, NEW.staff_user_id, NEW.document_type, NEW.file_id, NEW.issued_on, NEW.expires_on,
      NEW.uploaded_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.organisation_id, OLD.workspace_id, OLD.staff_user_id, OLD.document_type, OLD.file_id, OLD.issued_on, OLD.expires_on,
      OLD.uploaded_by, OLD.created_at) THEN
    RAISE EXCEPTION 'a staff document''s owner, type, file and dates never change; upload a new document instead' USING ERRCODE = '42501';
  END IF;
  IF (NEW.scan_status, NEW.scan_engine, NEW.scanned_at) IS DISTINCT FROM (OLD.scan_status, OLD.scan_engine, OLD.scanned_at)
     AND OLD.scan_status <> 'not_scanned' THEN
    RAISE EXCEPTION 'a recorded scan verdict never changes' USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'pending' AND NEW.status IN ('verified', 'rejected', 'revoked'))
            OR (OLD.status = 'verified' AND NEW.status = 'revoked')) THEN
      RAISE EXCEPTION 'invalid staff document transition % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'verified' AND (NEW.verified_by, NEW.verified_at) IS DISTINCT FROM (OLD.verified_by, OLD.verified_at) THEN
      RAISE EXCEPTION 'an earlier verification is kept when a document is revoked' USING ERRCODE = '23514';
    END IF;
  ELSIF (NEW.verified_by, NEW.verified_at, NEW.rejected_by, NEW.rejected_at, NEW.rejection_reason, NEW.revoked_by, NEW.revoked_at, NEW.revocation_reason)
        IS DISTINCT FROM
        (OLD.verified_by, OLD.verified_at, OLD.rejected_by, OLD.rejected_at, OLD.rejection_reason, OLD.revoked_by, OLD.revoked_at, OLD.revocation_reason) THEN
    RAISE EXCEPTION 'decision columns change only together with a status transition' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END
$fn$`;

export const STAFF_DOCUMENT_SECURITY_SQL: readonly string[] = [
  'REVOKE ALL ON FUNCTION core.staff_document_guard() FROM PUBLIC',
  'CREATE TRIGGER staff_document_guard BEFORE UPDATE ON core.staff_document FOR EACH ROW EXECUTE FUNCTION core.staff_document_guard()',
  ...STAFF_DOCUMENT_TABLES.map(
    (t) =>
      `CREATE TRIGGER ${t}_truncate_guard BEFORE TRUNCATE ON core.${t} FOR EACH STATEMENT EXECUTE FUNCTION core.staff_document_guard()`,
  ),
  ...STAFF_DOCUMENT_TABLES.flatMap((t) => [
    `ALTER TABLE core.${t} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE core.${t} FORCE ROW LEVEL SECURITY`,
    `REVOKE ALL ON TABLE core.${t} FROM PUBLIC`,
  ]),
  `CREATE POLICY staff_document_select ON core.staff_document AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (${TENANT} AND (${OWN} OR ${WORKSPACE_MANAGER} OR ${WORKER}))`,
  `CREATE POLICY staff_document_insert ON core.staff_document AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (${TENANT} AND (uploaded_by = core.current_uid()) AND (status = 'pending'::text)
    AND (scan_status = ANY (ARRAY['not_scanned'::text, 'clean'::text])) AND (${OWN} OR ${WORKSPACE_MANAGER}))`,
  `CREATE POLICY staff_document_update ON core.staff_document AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (${TENANT} AND ${WORKSPACE_MANAGER})
  WITH CHECK (${TENANT} AND ${WORKSPACE_MANAGER} AND (staff_user_id <> core.current_uid()))`,
  `CREATE POLICY staff_document_requirement_select ON core.staff_document_requirement AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (organisation_id = core.current_org())`,
  `CREATE POLICY staff_document_requirement_insert ON core.staff_document_requirement AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK ((organisation_id = core.current_org()) AND (updated_by = core.current_uid()) AND ${ORGANISATION_MANAGER})`,
  `CREATE POLICY staff_document_requirement_update ON core.staff_document_requirement AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING ((organisation_id = core.current_org()) AND ${ORGANISATION_MANAGER})
  WITH CHECK ((organisation_id = core.current_org()) AND (updated_by = core.current_uid()) AND ${ORGANISATION_MANAGER})`,
  `CREATE POLICY staff_document_requirement_delete ON core.staff_document_requirement AS PERMISSIVE FOR DELETE TO PUBLIC
  USING ((organisation_id = core.current_org()) AND ${ORGANISATION_MANAGER})`,
  'GRANT SELECT, INSERT ON TABLE core.staff_document TO crewflow_app',
  `GRANT UPDATE (${STAFF_DOCUMENT_UPDATABLE_COLUMNS.join(', ')}) ON TABLE core.staff_document TO crewflow_app`,
  'GRANT SELECT, INSERT, DELETE ON TABLE core.staff_document_requirement TO crewflow_app',
  'GRANT UPDATE (required, updated_by, updated_at) ON TABLE core.staff_document_requirement TO crewflow_app',
  `ALTER TABLE core.stored_file DROP CONSTRAINT stored_file_kind_check`,
  `ALTER TABLE core.stored_file ADD CONSTRAINT stored_file_kind_check CHECK (kind IN (${list(STORED_FILE_KINDS_AFTER_1786722300000)}))`,
  `ALTER TABLE core.notification_preference DROP CONSTRAINT notification_preference_notification_type_check`,
  `ALTER TABLE core.notification_preference ADD CONSTRAINT notification_preference_notification_type_check CHECK (notification_type IN (${list(NOTIFICATION_TYPES_AFTER_1786722300000)}))`,
];

export const STAFF_DOCUMENT_OWNERSHIP_SQL: readonly string[] = [
  ...STAFF_DOCUMENT_TABLES.map(
    (t) => `ALTER TABLE core.${t} OWNER TO crewflow`,
  ),
  'ALTER FUNCTION core.staff_document_guard() OWNER TO crewflow',
];

/** down(): retention — refuses while any document row exists (counted after NO FORCE in down()'s own transaction). */
export const STAFF_DOCUMENT_DOWN_UNFORCE_SQL: readonly string[] =
  STAFF_DOCUMENT_TABLES.map(
    (t) => `ALTER TABLE core.${t} NO FORCE ROW LEVEL SECURITY`,
  );
export const STAFF_DOCUMENT_ROWS_SQL = `SELECT (SELECT pg_catalog.count(*) FROM core.staff_document)::int AS document_rows,
  (SELECT pg_catalog.count(*) FROM core.stored_file WHERE kind = 'STAFF_DOCUMENT')::int AS file_rows,
  (SELECT pg_catalog.count(*) FROM core.notification_preference WHERE notification_type = 'staff_document_expiring')::int AS preference_rows`;
export const STAFF_DOCUMENT_DOWN_SQL: readonly string[] = [
  'DROP TABLE core.staff_document_requirement',
  'DROP TABLE core.staff_document',
  'DROP FUNCTION core.staff_document_guard()',
  `ALTER TABLE core.stored_file DROP CONSTRAINT stored_file_kind_check`,
  `ALTER TABLE core.stored_file ADD CONSTRAINT stored_file_kind_check CHECK (kind IN (${list(STORED_FILE_KINDS_BEFORE_1786722300000)}))`,
  `ALTER TABLE core.notification_preference DROP CONSTRAINT notification_preference_notification_type_check`,
  `ALTER TABLE core.notification_preference ADD CONSTRAINT notification_preference_notification_type_check CHECK (notification_type IN (${list(NOTIFICATION_TYPES_BEFORE_1786722300000)}))`,
];

/** Post-condition: owner, RLS, ACL (non-owner grantees), policy names and triggers of both tables, and the function. */
export const STAFF_DOCUMENT_STATE_SQL = `
SELECT c.relname::text AS tbl,
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
       coalesce((SELECT pg_catalog.string_agg(t.tgname || ':' || t.tgenabled::text, ',' ORDER BY t.tgname)
          FROM pg_catalog.pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal), '') AS triggers
  FROM pg_catalog.pg_class c
 WHERE c.relnamespace = 'core'::regnamespace AND c.relname = ANY (ARRAY['staff_document', 'staff_document_requirement'])
 ORDER BY c.relname`;

export const STAFF_DOCUMENT_FUNCTION_STATE_SQL = `
SELECT pg_catalog.pg_get_userbyid(p.proowner)::text AS owner, p.prosecdef AS definer,
       pg_catalog.array_to_string(p.proconfig, ';') AS config,
       pg_catalog.has_function_privilege('crewflow_app', p.oid, 'EXECUTE') AS app_execute,
       (p.proacl IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(p.proacl) x WHERE x.grantee = 0)) AS public_revoked
  FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('core.staff_document_guard()')`;

export interface StaffDocumentTableState {
  tbl: string;
  owner: string;
  rls: boolean;
  force: boolean;
  acl: string;
  column_acl: string;
  policies: string;
  triggers: string;
}

const sortedCsv = (values: readonly string[]) => [...values].sort().join(',');

export const EXPECTED_STAFF_DOCUMENT_STATE: Readonly<
  Record<
    (typeof STAFF_DOCUMENT_TABLES)[number],
    Omit<StaffDocumentTableState, 'tbl'>
  >
> = Object.freeze({
  staff_document: {
    owner: 'crewflow',
    rls: true,
    force: true,
    acl: 'crewflow_app:INSERT,crewflow_app:SELECT',
    column_acl: sortedCsv(
      STAFF_DOCUMENT_UPDATABLE_COLUMNS.map((c) => `crewflow_app:UPDATE:${c}`),
    ),
    policies:
      'staff_document_insert:a,staff_document_select:r,staff_document_update:w',
    triggers: 'staff_document_guard:O,staff_document_truncate_guard:O',
  },
  staff_document_requirement: {
    owner: 'crewflow',
    rls: true,
    force: true,
    acl: 'crewflow_app:DELETE,crewflow_app:INSERT,crewflow_app:SELECT',
    column_acl: sortedCsv(
      ['required', 'updated_by', 'updated_at'].map(
        (c) => `crewflow_app:UPDATE:${c}`,
      ),
    ),
    policies:
      'staff_document_requirement_delete:d,staff_document_requirement_insert:a,staff_document_requirement_select:r,staff_document_requirement_update:w',
    triggers: 'staff_document_requirement_truncate_guard:O',
  },
});

/** Every difference between the catalog and EXPECTED_STAFF_DOCUMENT_STATE (empty = as reviewed). */
export function staffDocumentStateProblems(
  rows: readonly StaffDocumentTableState[],
  fn: Record<string, unknown> | undefined,
): string[] {
  const problems: string[] = [];
  for (const t of STAFF_DOCUMENT_TABLES) {
    const got = rows.find((r) => r.tbl === t);
    if (!got) {
      problems.push(`core.${t}: missing`);
      continue;
    }
    const want = EXPECTED_STAFF_DOCUMENT_STATE[t];
    for (const key of Object.keys(want) as Array<keyof typeof want>) {
      if (String(got[key]) !== String(want[key]))
        problems.push(
          `core.${t}.${key}: expected ${JSON.stringify(want[key])}, found ${JSON.stringify(got[key])}`,
        );
    }
  }
  if (rows.length !== STAFF_DOCUMENT_TABLES.length)
    problems.push(
      `expected ${STAFF_DOCUMENT_TABLES.length} tables, found ${rows.length}`,
    );
  const wantFn = {
    owner: 'crewflow',
    definer: false,
    config: 'search_path=pg_catalog, pg_temp',
    app_execute: false,
    public_revoked: true,
  };
  if (!fn) problems.push(`${STAFF_DOCUMENT_GUARD_FUNCTION}: missing`);
  else
    for (const [k, v] of Object.entries(wantFn))
      if (fn[k] !== v)
        problems.push(
          `${STAFF_DOCUMENT_GUARD_FUNCTION}.${k}: expected ${JSON.stringify(v)}, found ${JSON.stringify(fn[k])}`,
        );
  return problems;
}
