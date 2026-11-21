import { MigrationInterface, QueryRunner } from 'typeorm';

import { withCrewflowCoreCreate } from '../core-schema-create-scope';

/**
 * Owner decision 29 (21 Nov 2026), reports page v1: background CSV exports. DRAFT: owner SQL review first.
 *
 * 1. NEW tenant-scoped table `core.report_export`, one row per export a user asked for. organisation_id + workspace_id,
 *    ENABLE + FORCE RLS, USING + WITH CHECK, all in THIS migration (CLAUDE.md). Not read before authentication, so no
 *    NOT-FORCE exception. The CSV itself is held in the row (`csv_content`, at most 10 MB) until the Worker deletes it
 *    24 hours after it was ready; there is no object-storage copy and no URL to leak.
 *    Policies:
 *      - the requester (organisation AND workspace AND requested_by = the bound user): SELECT; INSERT only as a fresh
 *        `pending` row with no file and no link; UPDATE (the guard below lets a person change only the download link).
 *      - the Worker (rab.actor_type = 'worker', set only by trusted server code, AND organisation AND workspace): SELECT
 *        and UPDATE, to build the file and delete it. Same shape as staff_profile_worker_scan (1786676600000).
 *    No DELETE policy, no DELETE / TRUNCATE grant: the row (who exported what, when) is kept; only the file is removed.
 *    Column grants to crewflow_app: INSERT on the request columns only; UPDATE on the build / file / link columns.
 *    Owner-login parity (the runtime login inherits the owner's privileges): `_report_export_grant_parity_update`
 *    (allow-list = the UPDATE columns) and `_report_export_grant_parity_delete`, the existing
 *    core.owner_login_grant_parity_guard().
 * 2. Trigger `core.report_export_guard()` (BEFORE UPDATE, SECURITY INVOKER, pinned search_path, owner crewflow):
 *      - identity, parameters and scope never change;
 *      - a person (any session that is not the Worker) may change only the download-link columns, only while the file
 *        is ready, and the database (not the caller) sets the issue time and the 60-second expiry; a burnt link is
 *        never un-burnt;
 *      - the Worker never touches the link columns; status moves only pending → ready | failed, ready → expired
 *        (@rab/shared REPORT_EXPORT_TRANSITIONS); a ready file's content never changes.
 *    With no tenant context every predicate is NULL ⇒ zero rows.
 * 3. `core.notification_preference.notification_type` CHECK += 'report_export_ready'.
 *
 * down(): refuses while any export row exists; then restores the CHECK and drops the table and function.
 */
const TABLE = 'core.report_export';
const OWNER = `organisation_id = core.current_org() AND workspace_id = core.current_workspace() AND requested_by = core.current_uid()`;
const WORKER = `current_setting('rab.actor_type', true) = 'worker' AND organisation_id = core.current_org() AND workspace_id = core.current_workspace()`;

export const REPORT_EXPORT_POLICIES_1786723200000 = [
  'report_export_insert',
  'report_export_select',
  'report_export_update',
  'report_export_worker_select',
  'report_export_worker_update',
] as const;
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
export const REPORT_EXPORT_UPDATE_COLUMNS_1786723200000 = [
  'status',
  'attempts',
  'error_code',
  'row_count',
  'csv_content',
  'csv_bytes',
  'ready_at',
  'file_expires_at',
  'file_deleted_at',
  'download_token_hash',
  'download_token_issued_at',
  'download_token_expires_at',
  'download_token_used_at',
  'download_count',
  'updated_at',
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
  id                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id            uuid        NOT NULL,
  workspace_id               uuid        NOT NULL,
  requested_by               uuid        NOT NULL,
  report_key                 text        NOT NULL,
  period_from                date,
  period_to                  date,
  venue_id                   uuid,
  payroll_run_id             uuid,
  include_pay                boolean     NOT NULL,
  include_hours              boolean     NOT NULL,
  scope_kind                 text        NOT NULL,
  scope_owner_user_id        uuid,
  scope_venue_ids            uuid[]      NOT NULL DEFAULT '{}',
  status                     text        NOT NULL DEFAULT 'pending',
  attempts                   integer     NOT NULL DEFAULT 0,
  error_code                 text,
  row_count                  integer,
  csv_content                text,
  csv_bytes                  integer,
  ready_at                   timestamptz,
  file_expires_at            timestamptz,
  file_deleted_at            timestamptz,
  download_token_hash        text,
  download_token_issued_at   timestamptz,
  download_token_expires_at  timestamptz,
  download_token_used_at     timestamptz,
  download_count             integer     NOT NULL DEFAULT 0,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT report_export_organisation_fkey FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE,
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
    (status = 'ready') = (csv_content IS NOT NULL)
    AND (csv_content IS NULL OR (octet_length(csv_content) <= 10485760 AND csv_bytes = octet_length(csv_content)))
    AND (status IN ('ready', 'expired')) = (ready_at IS NOT NULL)
    AND (ready_at IS NULL) = (file_expires_at IS NULL)
    AND (file_expires_at IS NULL OR file_expires_at = ready_at + interval '24 hours')
    AND (status = 'expired') = (file_deleted_at IS NOT NULL)
    AND (row_count IS NULL OR row_count >= 0)
  ),
  CONSTRAINT report_export_link_check CHECK (
    (download_token_hash IS NULL OR download_token_hash ~ '^[0-9a-f]{64}$')
    AND (download_token_hash IS NULL) = (download_token_issued_at IS NULL)
    AND (download_token_issued_at IS NULL) = (download_token_expires_at IS NULL)
    AND (download_token_expires_at IS NULL OR download_token_expires_at = download_token_issued_at + interval '60 seconds')
    AND (download_token_used_at IS NULL OR download_token_hash IS NOT NULL)
    AND download_count >= 0
  )
)`;

export const REPORT_EXPORT_GUARD_SQL_1786723200000 = `
CREATE FUNCTION core.report_export_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  is_worker boolean := pg_catalog.current_setting('rab.actor_type', true) = 'worker';
  link_changed boolean := NEW.download_token_hash IS DISTINCT FROM OLD.download_token_hash
    OR NEW.download_token_issued_at IS DISTINCT FROM OLD.download_token_issued_at
    OR NEW.download_token_expires_at IS DISTINCT FROM OLD.download_token_expires_at
    OR NEW.download_token_used_at IS DISTINCT FROM OLD.download_token_used_at
    OR NEW.download_count IS DISTINCT FROM OLD.download_count;
  build_changed boolean := NEW.status IS DISTINCT FROM OLD.status
    OR NEW.attempts IS DISTINCT FROM OLD.attempts
    OR NEW.error_code IS DISTINCT FROM OLD.error_code
    OR NEW.row_count IS DISTINCT FROM OLD.row_count
    OR NEW.csv_content IS DISTINCT FROM OLD.csv_content
    OR NEW.csv_bytes IS DISTINCT FROM OLD.csv_bytes
    OR NEW.ready_at IS DISTINCT FROM OLD.ready_at
    OR NEW.file_expires_at IS DISTINCT FROM OLD.file_expires_at
    OR NEW.file_deleted_at IS DISTINCT FROM OLD.file_deleted_at;
BEGIN
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
  IF is_worker THEN
    IF link_changed THEN
      RAISE EXCEPTION 'report_export: the Worker never changes a download link' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
         (OLD.status = 'pending' AND NEW.status IN ('ready', 'failed'))
      OR (OLD.status = 'ready' AND NEW.status = 'expired')) THEN
      RAISE EXCEPTION 'report_export: transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status <> 'pending' AND NEW.status = OLD.status AND build_changed THEN
      RAISE EXCEPTION 'report_export: a built or finished export does not change' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'ready' AND NEW.status = 'expired' AND NEW.file_expires_at > pg_catalog.now() THEN
      RAISE EXCEPTION 'report_export: the file is not due for deletion yet' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF build_changed THEN
      RAISE EXCEPTION 'report_export: only the Worker builds or deletes an export file' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.download_token_hash IS DISTINCT FROM OLD.download_token_hash THEN
      -- A new link: only for a ready file; the database fixes when it was issued and that it lasts 60 seconds.
      IF OLD.status <> 'ready' OR NEW.download_token_hash IS NULL THEN
        RAISE EXCEPTION 'report_export: a download link is issued only for a ready file' USING ERRCODE = 'check_violation';
      END IF;
      NEW.download_token_issued_at := pg_catalog.clock_timestamp();
      NEW.download_token_expires_at := NEW.download_token_issued_at + interval '60 seconds';
      NEW.download_token_used_at := NULL;
      IF NEW.download_count IS DISTINCT FROM OLD.download_count THEN
        RAISE EXCEPTION 'report_export: issuing a link is not a download' USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      IF NEW.download_token_issued_at IS DISTINCT FROM OLD.download_token_issued_at
         OR NEW.download_token_expires_at IS DISTINCT FROM OLD.download_token_expires_at THEN
        RAISE EXCEPTION 'report_export: a link''s lifetime is fixed when it is issued' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.download_token_used_at IS DISTINCT FROM OLD.download_token_used_at THEN
        -- Burning a link: once, before it expires, with exactly one more download counted.
        IF OLD.download_token_used_at IS NOT NULL OR OLD.download_token_hash IS NULL OR OLD.status <> 'ready'
           OR OLD.download_token_expires_at <= pg_catalog.clock_timestamp()
           OR NEW.download_count IS DISTINCT FROM OLD.download_count + 1 THEN
          RAISE EXCEPTION 'report_export: a download link is used once, before it expires' USING ERRCODE = 'check_violation';
        END IF;
        NEW.download_token_used_at := pg_catalog.clock_timestamp();
      ELSIF NEW.download_count IS DISTINCT FROM OLD.download_count THEN
        RAISE EXCEPTION 'report_export: a download is counted only when its link is used' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$fn$`;

export class ReportExport1786723200000 implements MigrationInterface {
  name = 'ReportExport1786723200000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(REPORT_EXPORT_TABLE_SQL_1786723200000);
    await runner.query(`CREATE INDEX report_export_requester_idx ON ${TABLE} (organisation_id, workspace_id, requested_by, created_at DESC)`);
    await runner.query(`CREATE INDEX report_export_due_idx ON ${TABLE} (organisation_id, workspace_id, status, created_at) WHERE status IN ('pending', 'ready')`);
    await runner.query(`CREATE UNIQUE INDEX report_export_token_key ON ${TABLE} (download_token_hash) WHERE download_token_hash IS NOT NULL`);
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
    await runner.query(`CREATE TRIGGER report_export_guard BEFORE UPDATE ON ${TABLE} FOR EACH ROW EXECUTE FUNCTION core.report_export_guard()`);

    await runner.query(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`);
    await runner.query(`ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY`);
    await runner.query(`REVOKE ALL ON ${TABLE} FROM PUBLIC`);
    await runner.query(`REVOKE ALL ON ${TABLE} FROM crewflow_app`);
    await runner.query(`CREATE POLICY report_export_select ON ${TABLE} FOR SELECT USING (${OWNER})`);
    await runner.query(
      `CREATE POLICY report_export_insert ON ${TABLE} FOR INSERT WITH CHECK (${OWNER} AND status = 'pending' AND attempts = 0 AND csv_content IS NULL AND download_token_hash IS NULL)`,
    );
    await runner.query(`CREATE POLICY report_export_update ON ${TABLE} FOR UPDATE USING (${OWNER}) WITH CHECK (${OWNER})`);
    await runner.query(`CREATE POLICY report_export_worker_select ON ${TABLE} FOR SELECT USING (${WORKER})`);
    await runner.query(`CREATE POLICY report_export_worker_update ON ${TABLE} FOR UPDATE USING (${WORKER}) WITH CHECK (${WORKER})`);
    await runner.query(`GRANT SELECT ON ${TABLE} TO crewflow_app`);
    await runner.query(`GRANT INSERT (${REPORT_EXPORT_INSERT_COLUMNS_1786723200000.join(', ')}) ON ${TABLE} TO crewflow_app`);
    await runner.query(`GRANT UPDATE (${REPORT_EXPORT_UPDATE_COLUMNS_1786723200000.join(', ')}) ON ${TABLE} TO crewflow_app`);

    await runner.query(`ALTER TABLE core.notification_preference DROP CONSTRAINT IF EXISTS notification_preference_notification_type_check`);
    await runner.query(
      `ALTER TABLE core.notification_preference ADD CONSTRAINT notification_preference_notification_type_check CHECK (notification_type IN (${list(NOTIFICATION_TYPES_AFTER)}))`,
    );

    await this.verify(runner);
  }

  /** Refuse to record the migration on drift. */
  private async verify(runner: QueryRunner): Promise<void> {
    const [check] = (await runner.query(
      `SELECT
         (SELECT c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner) = 'crewflow' FROM pg_class c WHERE c.oid = '${TABLE}'::regclass) AS forced,
         (SELECT array_agg(policyname::text ORDER BY policyname) FROM pg_policies WHERE schemaname = 'core' AND tablename = 'report_export') AS policies,
         (SELECT array_agg(column_name::text ORDER BY column_name) FROM information_schema.column_privileges
           WHERE grantee = 'crewflow_app' AND table_schema = 'core' AND table_name = 'report_export' AND privilege_type = 'INSERT') AS insert_cols,
         (SELECT array_agg(column_name::text ORDER BY column_name) FROM information_schema.column_privileges
           WHERE grantee = 'crewflow_app' AND table_schema = 'core' AND table_name = 'report_export' AND privilege_type = 'UPDATE') AS update_cols,
         has_table_privilege('crewflow_app', '${TABLE}', 'SELECT') AS can_select,
         has_table_privilege('crewflow_app', '${TABLE}', 'DELETE') AS can_delete,
         has_table_privilege('crewflow_app', '${TABLE}', 'TRUNCATE') AS can_truncate,
         (SELECT array_agg(t.tgname::text ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid = '${TABLE}'::regclass AND NOT t.tgisinternal AND t.tgenabled = 'O') AS triggers,
         (SELECT NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'] AND pg_get_userbyid(p.proowner) = 'crewflow'
            FROM pg_proc p WHERE p.oid = 'core.report_export_guard()'::regprocedure) AS guard_ok,
         has_function_privilege('crewflow_app', 'core.report_export_guard()', 'EXECUTE') AS app_execute_guard,
         (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'core.notification_preference'::regclass AND conname = 'notification_preference_notification_type_check') AS type_check,
         (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'crewflow_app') AS app_bypass`,
    )) as Array<Record<string, unknown>>;
    const same = (a: unknown, b: readonly string[]) => JSON.stringify(a) === JSON.stringify([...b].sort());
    if (
      check?.forced !== true ||
      !same(check.policies, REPORT_EXPORT_POLICIES_1786723200000) ||
      !same(check.insert_cols, REPORT_EXPORT_INSERT_COLUMNS_1786723200000) ||
      !same(check.update_cols, REPORT_EXPORT_UPDATE_COLUMNS_1786723200000) ||
      check.can_select !== true ||
      check.can_delete !== false ||
      check.can_truncate !== false ||
      !same(check.triggers, ['_report_export_grant_parity_delete', '_report_export_grant_parity_update', 'report_export_guard']) ||
      check.guard_ok !== true ||
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
    const [{ n }] = (await runner.query(`SELECT count(*)::int AS n FROM ${TABLE}`)) as Array<{ n: number }>;
    await runner.query(`SET LOCAL row_security = on`);
    if (n > 0) throw new Error(`${this.name}: ${n} report export row(s) exist; down() refuses to drop them`);
    await runner.query(`ALTER TABLE core.notification_preference DROP CONSTRAINT IF EXISTS notification_preference_notification_type_check`);
    await runner.query(
      `ALTER TABLE core.notification_preference ADD CONSTRAINT notification_preference_notification_type_check CHECK (notification_type IN (${list(NOTIFICATION_TYPES_BEFORE)}))`,
    );
    await runner.query(`DROP TABLE ${TABLE}`);
    await runner.query(`DROP FUNCTION core.report_export_guard()`);
  }
}
