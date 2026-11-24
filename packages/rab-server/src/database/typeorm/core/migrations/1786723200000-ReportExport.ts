import { MigrationInterface, QueryRunner } from 'typeorm';

import { withCrewflowCoreCreate } from '../core-schema-create-scope';

/**
 * Owner decision 29 (21 Nov 2026), reports page v1: background CSV exports. DRAFT: owner SQL review first.
 * Revised after the independent security review (22 Nov): the file and its one-time link live in a separate table the
 * runtime login holds no privilege on, served only by SECURITY DEFINER functions.
 *
 * 1. `core.report_export` (owner crewflow): one row per export a user asked for — what, for which period / venue / run,
 *    the scope and pay / hours decision stored at request time, and the build status. NO file content, NO link.
 *    organisation_id + workspace_id, ENABLE + FORCE RLS, USING + WITH CHECK, all in THIS migration (CLAUDE.md).
 *    Policies: the requester (organisation AND workspace AND requested_by = the bound user) SELECT, and INSERT only as a
 *    fresh pending row; the Worker (rab.actor_type = 'worker', set only by trusted server code, AND organisation AND
 *    workspace) SELECT and UPDATE. No person UPDATE policy, no DELETE policy, no DELETE / TRUNCATE grant.
 *    Trigger `core.report_export_guard()` (BEFORE INSERT OR UPDATE, SECURITY INVOKER, pinned search_path):
 *      - INSERT: the database sets created_at / updated_at (now), status pending, attempts 0, and clears every build
 *        column, whatever the caller sent (the INSERT column grant does not bind an owner-login runtime);
 *      - UPDATE: identity, parameters and scope immutable; only the Worker updates, with the transitions pending →
 *        ready | failed and ready → expired (not before file_expires_at); a built or finished export does not change.
 *    Owner-login parity: `_report_export_grant_parity_update` (allow-list = the UPDATE columns) and
 *    `_report_export_grant_parity_delete` (the existing core.owner_login_grant_parity_guard()).
 * 2. `core.report_export_file` (owner rab_secure_owner, NOLOGIN): the CSV and its one-time link. ENABLE + FORCE RLS with
 *    ONE owner-only PERMISSIVE policy (CURRENT_USER = rab_secure_owner AND the bound organisation AND workspace, true
 *    only inside the definers below) and a RESTRICTIVE deny-all for crewflow / crewflow_app. No table privilege for
 *    anyone but the owner: on its normal paths the runtime login can neither read the content nor touch the link.
 *    SAME POSTURE AS EVERY OTHER rab_secure_owner TABLE (behaviour catalogue BC-01, owner-accepted): the owner login
 *    crewflow_owner is a member of rab_secure_owner (INHERIT / SET), so arbitrary SQL in that session (injection) could
 *    `SET ROLE rab_secure_owner` or alter the policies; this protects normal code paths, not an attacker with SQL.
 *    A composite FK ties each file to its export row (same id, organisation, workspace and requester); a file row is
 *    never deleted while the export exists — purging clears the content and keeps a tombstone, so a file can be stored
 *    at most once per export. Reached only through four definers (owner rab_secure_owner, search_path pg_catalog,
 *    pg_temp; EXECUTE for crewflow_app only), each pinned to the bound organisation + workspace:
 *      - report_export_file_put(export, requester, csv): Worker only; the export must exist in the bound workspace with
 *        that requester (FK), once per export (PK); stores the file, expiry = now + 24 h;
 *      - report_export_file_issue_link(export, token_hash): the requester only, only before the file expires; the
 *        database sets the 60-second lifetime;
 *      - report_export_file_take(export, token_hash): the requester only; burns the link and returns the content in ONE
 *        statement, only for an unused, unexpired link of an unexpired file;
 *      - report_export_file_purge(export): Worker only; clears the file content once it has expired (tombstone kept);
 *      - report_export_file_sweep_expired(limit): Worker only; the same clearing for EVERY file of the bound workspace
 *        whose own file_expires_at has passed (at most `limit`, 1..1000 rows per call), whatever its export's status —
 *        so a file stored for a failed or expired export (a Worker bug) never keeps its content at rest.
 *    None names a crewflow-owned table (secure-owner invariant R4 unchanged).
 * 3. `core.notification_preference.notification_type` CHECK += 'report_export_ready'.
 *
 * down(): refuses while any export or file row exists; then restores the CHECK and drops the functions and tables.
 */
const TABLE = 'core.report_export';
const FILE = 'core.report_export_file';
const OWNER = `organisation_id = core.current_org() AND workspace_id = core.current_workspace() AND requested_by = core.current_uid()`;
const WORKER = `current_setting('rab.actor_type', true) = 'worker' AND organisation_id = core.current_org() AND workspace_id = core.current_workspace()`;
const SECURE_ONLY = `(CURRENT_USER = 'rab_secure_owner'::name AND organisation_id = core.current_org() AND workspace_id = core.current_workspace())`;

export const REPORT_EXPORT_POLICIES_1786723200000 = ['report_export_insert', 'report_export_select', 'report_export_worker_select', 'report_export_worker_update'] as const;
export const REPORT_EXPORT_FILE_POLICIES_1786723200000 = ['report_export_file_runtime_deny', 'report_export_file_secure_owner_definer'] as const;
export const REPORT_EXPORT_INSERT_COLUMNS_1786723200000 = [
  'organisation_id',
  'workspace_id',
  'requested_by',
  'report_key',
  'period_from',
  'period_to',
  'venue_id',
  'payroll_run_id',
  'include_pay',
  'include_hours',
  'scope_kind',
  'scope_owner_user_id',
  'scope_venue_ids',
] as const;
export const REPORT_EXPORT_UPDATE_COLUMNS_1786723200000 = ['status', 'attempts', 'error_code', 'row_count', 'csv_bytes', 'ready_at', 'file_expires_at', 'file_deleted_at', 'updated_at'] as const;
export const REPORT_EXPORT_FILE_FUNCTIONS_1786723200000 = [
  'core.report_export_file_put(uuid, uuid, text)',
  'core.report_export_file_issue_link(uuid, text)',
  'core.report_export_file_take(uuid, text)',
  'core.report_export_file_purge(uuid)',
  'core.report_export_file_sweep_expired(integer)',
] as const;
/** Frozen copy of @rab/shared REPORT_KEYS at this migration. */
export const REPORT_KEYS_1786723200000 = ['hours_and_pay_by_venue', 'attendance_exceptions', 'weekly_hours_per_staff', 'fill_rate_by_venue', 'payroll_run_summary'] as const;

const NOTIFICATION_TYPES_BEFORE = [
  'offer_sent', 'offer_expired', 'offer_accepted', 'offer_declined', 'offer_confirmed', 'offer_rejected',
  'shift_reminder_24h', 'shift_reminder_2h', 'shift_reminder_30m', 'shift_assignment_no_show', 'attendance_missing_clock_out',
  'shift_request_submitted', 'shift_request_approved', 'shift_request_declined', 'shift_request_staff_removed',
  'late_clock_in', 'shift_cancelled', 'replacement_required', 'manager_confirmation_timeout', 'clock_in_window_open',
  'shift_statement_ready', 'payslip_available', 'payroll_period_attention',
];
const NOTIFICATION_TYPES_AFTER = [...NOTIFICATION_TYPES_BEFORE, 'report_export_ready'];
const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');

export const REPORT_EXPORT_TABLE_SQL_1786723200000 = `
CREATE TABLE ${TABLE} (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id      uuid        NOT NULL,
  workspace_id         uuid        NOT NULL,
  requested_by         uuid        NOT NULL,
  report_key           text        NOT NULL,
  period_from          date,
  period_to            date,
  venue_id             uuid,
  payroll_run_id       uuid,
  include_pay          boolean     NOT NULL,
  include_hours        boolean     NOT NULL,
  scope_kind           text        NOT NULL,
  scope_owner_user_id  uuid,
  scope_venue_ids      uuid[]      NOT NULL DEFAULT '{}',
  status               text        NOT NULL DEFAULT 'pending',
  attempts             integer     NOT NULL DEFAULT 0,
  error_code           text,
  row_count            integer,
  csv_bytes            integer,
  ready_at             timestamptz,
  file_expires_at      timestamptz,
  file_deleted_at      timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT report_export_organisation_fkey FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE,
  CONSTRAINT report_export_file_target_key UNIQUE (id, organisation_id, workspace_id, requested_by),
  CONSTRAINT report_export_report_key_check CHECK (report_key IN (${list(REPORT_KEYS_1786723200000)})),
  CONSTRAINT report_export_params_check CHECK (
    CASE WHEN report_key = 'payroll_run_summary'
      THEN payroll_run_id IS NOT NULL AND period_from IS NULL AND period_to IS NULL AND venue_id IS NULL
      ELSE payroll_run_id IS NULL AND period_from IS NOT NULL AND period_to IS NOT NULL
           AND period_to >= period_from AND period_to - period_from <= 365
    END
  ),
  CONSTRAINT report_export_scope_check CHECK (
    (scope_kind = 'owner' AND scope_owner_user_id IS NOT NULL AND cardinality(scope_venue_ids) = 0)
    OR (scope_kind = 'venue' AND scope_owner_user_id IS NULL AND cardinality(scope_venue_ids) BETWEEN 1 AND 500
        AND NOT include_pay AND report_key <> 'payroll_run_summary'
        AND (venue_id IS NULL OR venue_id = ANY (scope_venue_ids)))
  ),
  CONSTRAINT report_export_status_check CHECK (status IN ('pending', 'ready', 'failed', 'expired')),
  CONSTRAINT report_export_attempts_check CHECK (attempts BETWEEN 0 AND 3),
  CONSTRAINT report_export_error_check CHECK ((status = 'failed') = (error_code IS NOT NULL) AND (error_code IS NULL OR error_code IN ('too_large', 'not_found', 'build_failed'))),
  CONSTRAINT report_export_file_check CHECK (
    (status IN ('ready', 'expired')) = (ready_at IS NOT NULL)
    AND (ready_at IS NULL) = (file_expires_at IS NULL)
    AND (ready_at IS NULL) = (csv_bytes IS NULL)
    AND (file_expires_at IS NULL OR file_expires_at = ready_at + interval '24 hours')
    AND (status = 'expired') = (file_deleted_at IS NOT NULL)
    AND (csv_bytes IS NULL OR csv_bytes BETWEEN 0 AND 10485760)
    AND (row_count IS NULL OR row_count >= 0)
  )
)`;

export const REPORT_EXPORT_GUARD_SQL_1786723200000 = `
CREATE FUNCTION core.report_export_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- The database, not the caller, decides how a new export starts.
    NEW.status := 'pending';
    NEW.attempts := 0;
    NEW.error_code := NULL;
    NEW.row_count := NULL;
    NEW.csv_bytes := NULL;
    NEW.ready_at := NULL;
    NEW.file_expires_at := NULL;
    NEW.file_deleted_at := NULL;
    NEW.created_at := pg_catalog.now();
    NEW.updated_at := pg_catalog.now();
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.report_key IS DISTINCT FROM OLD.report_key OR NEW.period_from IS DISTINCT FROM OLD.period_from
     OR NEW.period_to IS DISTINCT FROM OLD.period_to OR NEW.venue_id IS DISTINCT FROM OLD.venue_id
     OR NEW.payroll_run_id IS DISTINCT FROM OLD.payroll_run_id OR NEW.include_pay IS DISTINCT FROM OLD.include_pay
     OR NEW.include_hours IS DISTINCT FROM OLD.include_hours OR NEW.scope_kind IS DISTINCT FROM OLD.scope_kind
     OR NEW.scope_owner_user_id IS DISTINCT FROM OLD.scope_owner_user_id
     OR NEW.scope_venue_ids IS DISTINCT FROM OLD.scope_venue_ids OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'report_export: identity, parameters and scope are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF pg_catalog.current_setting('rab.actor_type', true) IS DISTINCT FROM 'worker' THEN
    RAISE EXCEPTION 'report_export: only the Worker updates an export' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'pending' AND NEW.status IN ('ready', 'failed'))
    OR (OLD.status = 'ready' AND NEW.status = 'expired')) THEN
    RAISE EXCEPTION 'report_export: transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'pending' AND NEW.status = OLD.status THEN
    RAISE EXCEPTION 'report_export: a built or finished export does not change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'ready' AND NEW.status = 'expired'
     AND (OLD.file_expires_at > pg_catalog.clock_timestamp() OR NEW.ready_at IS DISTINCT FROM OLD.ready_at
          OR NEW.file_expires_at IS DISTINCT FROM OLD.file_expires_at OR NEW.csv_bytes IS DISTINCT FROM OLD.csv_bytes
          OR NEW.row_count IS DISTINCT FROM OLD.row_count) THEN
    RAISE EXCEPTION 'report_export: the file is not due for deletion yet' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$fn$`;

export const REPORT_EXPORT_FILE_TABLE_SQL_1786723200000 = `
CREATE TABLE ${FILE} (
  export_id                  uuid        PRIMARY KEY,
  organisation_id            uuid        NOT NULL,
  workspace_id               uuid        NOT NULL,
  requested_by               uuid        NOT NULL,
  csv_content                text,
  created_at                 timestamptz NOT NULL,
  file_expires_at            timestamptz NOT NULL,
  purged_at                  timestamptz,
  download_token_hash        text,
  download_token_issued_at   timestamptz,
  download_token_expires_at  timestamptz,
  download_token_used_at     timestamptz,
  download_count             integer     NOT NULL DEFAULT 0,
  CONSTRAINT report_export_file_organisation_fkey FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE,
  CONSTRAINT report_export_file_export_fkey FOREIGN KEY (export_id, organisation_id, workspace_id, requested_by)
    REFERENCES core.report_export (id, organisation_id, workspace_id, requested_by) ON DELETE CASCADE,
  CONSTRAINT report_export_file_size_check CHECK (csv_content IS NULL OR octet_length(csv_content) <= 10485760),
  CONSTRAINT report_export_file_purge_check CHECK ((purged_at IS NULL) = (csv_content IS NOT NULL) AND (purged_at IS NULL OR purged_at >= file_expires_at)),
  CONSTRAINT report_export_file_expiry_check CHECK (file_expires_at = created_at + interval '24 hours'),
  CONSTRAINT report_export_file_link_check CHECK (
    (download_token_hash IS NULL OR download_token_hash ~ '^[0-9a-f]{64}$')
    AND (download_token_hash IS NULL) = (download_token_issued_at IS NULL)
    AND (download_token_issued_at IS NULL) = (download_token_expires_at IS NULL)
    AND (download_token_expires_at IS NULL OR download_token_expires_at = download_token_issued_at + interval '60 seconds')
    AND (download_token_used_at IS NULL OR download_token_hash IS NOT NULL)
    AND download_count >= 0
  )
)`;

/** The four definers. Every one re-reads the bound tenant itself; parameters only name the export and carry the hash / content. */
export const REPORT_EXPORT_FILE_FUNCTIONS_SQL_1786723200000: readonly string[] = [
  `CREATE FUNCTION core.report_export_file_put(p_export_id uuid, p_requested_by uuid, p_csv text)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $f$
DECLARE
  v_org uuid := core.current_org();
  v_ws  uuid := core.current_workspace();
  v_now timestamptz := pg_catalog.now();
BEGIN
  IF pg_catalog.current_setting('rab.actor_type', true) IS DISTINCT FROM 'worker' OR v_org IS NULL OR v_ws IS NULL THEN
    RAISE EXCEPTION 'report_export_file_put: the Worker only, inside a bound workspace' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO core.report_export_file (export_id, organisation_id, workspace_id, requested_by, csv_content, created_at, file_expires_at)
  VALUES (p_export_id, v_org, v_ws, p_requested_by, p_csv, v_now, v_now + interval '24 hours');
  RETURN v_now + interval '24 hours';
END;
$f$`,
  `CREATE FUNCTION core.report_export_file_issue_link(p_export_id uuid, p_token_hash text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $f$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'report_export_file_issue_link: token hash must be lowercase hex64' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF pg_catalog.current_setting('rab.actor_type', true) = 'worker' THEN RETURN false; END IF;
  UPDATE core.report_export_file f
     SET download_token_hash = p_token_hash, download_token_issued_at = v_now,
         download_token_expires_at = v_now + interval '60 seconds', download_token_used_at = NULL
   WHERE f.export_id = p_export_id AND f.organisation_id = core.current_org() AND f.workspace_id = core.current_workspace()
     AND f.requested_by = core.current_uid() AND f.purged_at IS NULL AND f.file_expires_at > v_now;
  RETURN FOUND;
END;
$f$`,
  `CREATE FUNCTION core.report_export_file_take(p_export_id uuid, p_token_hash text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $f$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_csv text;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
  IF pg_catalog.current_setting('rab.actor_type', true) = 'worker' THEN RETURN NULL; END IF;
  -- Burn first, in the same statement that returns the content: one use, before the link and the file expire.
  UPDATE core.report_export_file f
     SET download_token_used_at = v_now, download_count = f.download_count + 1
   WHERE f.export_id = p_export_id AND f.organisation_id = core.current_org() AND f.workspace_id = core.current_workspace()
     AND f.requested_by = core.current_uid() AND f.download_token_hash = p_token_hash AND f.download_token_used_at IS NULL
     AND f.download_token_expires_at > v_now AND f.file_expires_at > v_now AND f.purged_at IS NULL
  RETURNING f.csv_content INTO v_csv;
  RETURN v_csv;
END;
$f$`,
  `CREATE FUNCTION core.report_export_file_purge(p_export_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $f$
BEGIN
  IF pg_catalog.current_setting('rab.actor_type', true) IS DISTINCT FROM 'worker' THEN
    RAISE EXCEPTION 'report_export_file_purge: the Worker only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Content cleared, row kept as a tombstone: the PK then refuses any second file for this export.
  UPDATE core.report_export_file f
     SET csv_content = NULL, purged_at = pg_catalog.clock_timestamp(), download_token_hash = NULL, download_token_issued_at = NULL,
         download_token_expires_at = NULL, download_token_used_at = NULL
   WHERE f.export_id = p_export_id AND f.organisation_id = core.current_org() AND f.workspace_id = core.current_workspace()
     AND f.purged_at IS NULL AND f.file_expires_at <= pg_catalog.clock_timestamp();
  RETURN FOUND;
END;
$f$`,
  `CREATE FUNCTION core.report_export_file_sweep_expired(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $f$
DECLARE
  v_n integer;
BEGIN
  IF pg_catalog.current_setting('rab.actor_type', true) IS DISTINCT FROM 'worker' THEN
    RAISE EXCEPTION 'report_export_file_sweep_expired: the Worker only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Keyed on the file's own expiry, never on the export's status: every expired file of the bound workspace is cleared.
  UPDATE core.report_export_file f
     SET csv_content = NULL, purged_at = pg_catalog.clock_timestamp(), download_token_hash = NULL, download_token_issued_at = NULL,
         download_token_expires_at = NULL, download_token_used_at = NULL
   WHERE f.organisation_id = core.current_org() AND f.workspace_id = core.current_workspace()
     AND f.export_id IN (
       SELECT g.export_id FROM core.report_export_file g
        WHERE g.organisation_id = core.current_org() AND g.workspace_id = core.current_workspace()
          AND g.purged_at IS NULL AND g.file_expires_at <= pg_catalog.clock_timestamp()
        ORDER BY g.file_expires_at, g.export_id
        LIMIT LEAST(GREATEST(COALESCE(p_limit, 500), 1), 1000));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$f$`,
];

export class ReportExport1786723200000 implements MigrationInterface {
  name = 'ReportExport1786723200000';

  async up(runner: QueryRunner): Promise<void> {
    // ── 1. core.report_export (crewflow) ───────────────────────────────────────────────────────────────────────────────
    await runner.query(REPORT_EXPORT_TABLE_SQL_1786723200000);
    await runner.query(`CREATE INDEX report_export_requester_idx ON ${TABLE} (organisation_id, workspace_id, requested_by, created_at DESC)`);
    await runner.query(`CREATE INDEX report_export_due_idx ON ${TABLE} (organisation_id, workspace_id, status, created_at) WHERE status IN ('pending', 'ready')`);
    await runner.query(REPORT_EXPORT_GUARD_SQL_1786723200000);
    await runner.query(`REVOKE ALL ON FUNCTION core.report_export_guard() FROM PUBLIC`);
    await withCrewflowCoreCreate(runner, async () => {
      await runner.query(`ALTER TABLE ${TABLE} OWNER TO crewflow`);
      await runner.query(`ALTER FUNCTION core.report_export_guard() OWNER TO crewflow`);
    });
    // Grant-parity UPDATE guard first (leading underscore sorts before report_export_guard), as on every parity table.
    await runner.query(
      `CREATE TRIGGER _report_export_grant_parity_update BEFORE UPDATE ON ${TABLE} FOR EACH ROW EXECUTE FUNCTION core.owner_login_grant_parity_guard(${REPORT_EXPORT_UPDATE_COLUMNS_1786723200000.map((c) => `'${c}'`).join(', ')})`,
    );
    await runner.query(`CREATE TRIGGER _report_export_grant_parity_delete BEFORE DELETE ON ${TABLE} FOR EACH ROW EXECUTE FUNCTION core.owner_login_grant_parity_guard()`);
    await runner.query(`CREATE TRIGGER report_export_guard BEFORE INSERT OR UPDATE ON ${TABLE} FOR EACH ROW EXECUTE FUNCTION core.report_export_guard()`);
    await runner.query(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`);
    await runner.query(`ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY`);
    await runner.query(`REVOKE ALL ON ${TABLE} FROM PUBLIC`);
    await runner.query(`REVOKE ALL ON ${TABLE} FROM crewflow_app`);
    await runner.query(`CREATE POLICY report_export_select ON ${TABLE} FOR SELECT USING (${OWNER})`);
    await runner.query(`CREATE POLICY report_export_insert ON ${TABLE} FOR INSERT WITH CHECK (${OWNER} AND status = 'pending' AND attempts = 0)`);
    await runner.query(`CREATE POLICY report_export_worker_select ON ${TABLE} FOR SELECT USING (${WORKER})`);
    await runner.query(`CREATE POLICY report_export_worker_update ON ${TABLE} FOR UPDATE USING (${WORKER}) WITH CHECK (${WORKER})`);
    await runner.query(`GRANT SELECT ON ${TABLE} TO crewflow_app`);
    await runner.query(`GRANT INSERT (${REPORT_EXPORT_INSERT_COLUMNS_1786723200000.join(', ')}) ON ${TABLE} TO crewflow_app`);
    await runner.query(`GRANT UPDATE (${REPORT_EXPORT_UPDATE_COLUMNS_1786723200000.join(', ')}) ON ${TABLE} TO crewflow_app`);

    // ── 2. core.report_export_file (rab_secure_owner) ──────────────────────────────────────────────────────────────────
    await runner.query(REPORT_EXPORT_FILE_TABLE_SQL_1786723200000);
    await runner.query(`CREATE INDEX report_export_file_expiry_idx ON ${FILE} (organisation_id, workspace_id, file_expires_at)`);
    // Phase 0b: rab_secure_owner owns core, so the migrator (a member) may hand objects to it.
    await runner.query(`ALTER TABLE ${FILE} OWNER TO rab_secure_owner`);
    await runner.query(`REVOKE ALL ON TABLE ${FILE} FROM PUBLIC, crewflow, crewflow_app`);
    await runner.query(`REVOKE ALL ON TABLE ${FILE} FROM rab_secure_owner`);
    await runner.query(`GRANT SELECT, INSERT, UPDATE ON TABLE ${FILE} TO rab_secure_owner`);
    await runner.query(`ALTER TABLE ${FILE} ENABLE ROW LEVEL SECURITY`);
    await runner.query(`ALTER TABLE ${FILE} FORCE ROW LEVEL SECURITY`);
    await runner.query(`CREATE POLICY report_export_file_secure_owner_definer ON ${FILE} AS PERMISSIVE FOR ALL TO rab_secure_owner USING ${SECURE_ONLY} WITH CHECK ${SECURE_ONLY}`);
    await runner.query(`CREATE POLICY report_export_file_runtime_deny ON ${FILE} AS RESTRICTIVE FOR ALL TO crewflow, crewflow_app USING (false) WITH CHECK (false)`);
    for (const sql of REPORT_EXPORT_FILE_FUNCTIONS_SQL_1786723200000) await runner.query(sql);
    for (const fn of REPORT_EXPORT_FILE_FUNCTIONS_1786723200000) {
      await runner.query(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC`);
      await runner.query(`ALTER FUNCTION ${fn} OWNER TO rab_secure_owner`);
      await runner.query(`REVOKE ALL ON FUNCTION ${fn} FROM crewflow, crewflow_app`);
      await runner.query(`GRANT EXECUTE ON FUNCTION ${fn} TO crewflow_app`);
    }

    // ── 3. notification preference type ────────────────────────────────────────────────────────────────────────────────
    await runner.query(`ALTER TABLE core.notification_preference DROP CONSTRAINT IF EXISTS notification_preference_notification_type_check`);
    await runner.query(
      `ALTER TABLE core.notification_preference ADD CONSTRAINT notification_preference_notification_type_check CHECK (notification_type IN (${list(NOTIFICATION_TYPES_AFTER)}))`,
    );

    await this.verify(runner);
  }

  /** Refuse to record the migration on drift. */
  private async verify(runner: QueryRunner): Promise<void> {
    const fnList = REPORT_EXPORT_FILE_FUNCTIONS_1786723200000.map((f) => `'${f}'::regprocedure`).join(', ');
    const [check] = (await runner.query(
      `SELECT
         (SELECT c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner) = 'crewflow' FROM pg_class c WHERE c.oid = '${TABLE}'::regclass) AS forced,
         (SELECT c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner) = 'rab_secure_owner' FROM pg_class c WHERE c.oid = '${FILE}'::regclass) AS file_forced,
         (SELECT array_agg(policyname::text ORDER BY policyname) FROM pg_policies WHERE schemaname = 'core' AND tablename = 'report_export') AS policies,
         (SELECT array_agg(policyname::text ORDER BY policyname) FROM pg_policies WHERE schemaname = 'core' AND tablename = 'report_export_file') AS file_policies,
         (SELECT array_agg(column_name::text ORDER BY column_name) FROM information_schema.column_privileges
           WHERE grantee = 'crewflow_app' AND table_schema = 'core' AND table_name = 'report_export' AND privilege_type = 'INSERT') AS insert_cols,
         (SELECT array_agg(column_name::text ORDER BY column_name) FROM information_schema.column_privileges
           WHERE grantee = 'crewflow_app' AND table_schema = 'core' AND table_name = 'report_export' AND privilege_type = 'UPDATE') AS update_cols,
         has_table_privilege('crewflow_app', '${TABLE}', 'SELECT') AS can_select,
         has_table_privilege('crewflow_app', '${TABLE}', 'DELETE') AS can_delete,
         has_table_privilege('crewflow_app', '${TABLE}', 'TRUNCATE') AS can_truncate,
         (has_any_column_privilege('crewflow_app', '${FILE}', 'SELECT') OR has_any_column_privilege('crewflow_app', '${FILE}', 'INSERT')
           OR has_any_column_privilege('crewflow_app', '${FILE}', 'UPDATE') OR has_table_privilege('crewflow_app', '${FILE}', 'DELETE')
           OR has_any_column_privilege('crewflow', '${FILE}', 'SELECT')) AS file_reachable,
         (SELECT array_agg(t.tgname::text ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid = '${TABLE}'::regclass AND NOT t.tgisinternal AND t.tgenabled = 'O') AS triggers,
         (SELECT NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'] AND pg_get_userbyid(p.proowner) = 'crewflow'
            FROM pg_proc p WHERE p.oid = 'core.report_export_guard()'::regprocedure) AS guard_ok,
         (SELECT bool_and(p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'] AND pg_get_userbyid(p.proowner) = 'rab_secure_owner'
                          AND has_function_privilege('crewflow_app', p.oid, 'EXECUTE') AND NOT has_function_privilege('public', p.oid, 'EXECUTE'))
            FROM pg_proc p WHERE p.oid IN (${fnList})) AS definers_ok,
         has_function_privilege('crewflow_app', 'core.report_export_guard()', 'EXECUTE') AS app_execute_guard,
         (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'core.notification_preference'::regclass AND conname = 'notification_preference_notification_type_check') AS type_check,
         (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'crewflow_app') AS app_bypass`,
    )) as Array<Record<string, unknown>>;
    const same = (a: unknown, b: readonly string[]) => JSON.stringify(a) === JSON.stringify([...b].sort());
    if (
      check?.forced !== true ||
      check.file_forced !== true ||
      !same(check.policies, REPORT_EXPORT_POLICIES_1786723200000) ||
      !same(check.file_policies, REPORT_EXPORT_FILE_POLICIES_1786723200000) ||
      !same(check.insert_cols, REPORT_EXPORT_INSERT_COLUMNS_1786723200000) ||
      !same(check.update_cols, REPORT_EXPORT_UPDATE_COLUMNS_1786723200000) ||
      check.can_select !== true ||
      check.can_delete !== false ||
      check.can_truncate !== false ||
      check.file_reachable !== false ||
      !same(check.triggers, ['_report_export_grant_parity_delete', '_report_export_grant_parity_update', 'report_export_guard']) ||
      check.guard_ok !== true ||
      check.definers_ok !== true ||
      check.app_execute_guard !== false ||
      typeof check.type_check !== 'string' ||
      !NOTIFICATION_TYPES_AFTER.every((s) => (check.type_check as string).includes(`'${s}'`)) ||
      check.app_bypass !== false
    ) {
      throw new Error(`${this.name}: post-condition failed ${JSON.stringify(check)}`);
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`SET LOCAL row_security = off`);
    const [{ n }] = (await runner.query(`SELECT ((SELECT count(*) FROM ${TABLE}) + (SELECT count(*) FROM ${FILE}))::int AS n`)) as Array<{ n: number }>;
    await runner.query(`SET LOCAL row_security = on`);
    if (n > 0) throw new Error(`${this.name}: ${n} report export / file row(s) exist; down() refuses to drop them`);
    await runner.query(`ALTER TABLE core.notification_preference DROP CONSTRAINT IF EXISTS notification_preference_notification_type_check`);
    await runner.query(
      `ALTER TABLE core.notification_preference ADD CONSTRAINT notification_preference_notification_type_check CHECK (notification_type IN (${list(NOTIFICATION_TYPES_BEFORE)}))`,
    );
    for (const fn of REPORT_EXPORT_FILE_FUNCTIONS_1786723200000) await runner.query(`DROP FUNCTION ${fn}`);
    await runner.query(`DROP TABLE ${FILE}`);
    await runner.query(`DROP TABLE ${TABLE}`);
    await runner.query(`DROP FUNCTION core.report_export_guard()`);
  }
}
