import { MigrationInterface, QueryRunner } from 'typeorm';
import { payrollRunsSql } from '../../workspace-schema/v1/payroll-runs';

const KINDS_BEFORE = ['PROFILE_IMAGE', 'ORGANISATION_LOGO', 'WORKSPACE_LOGO', 'SHIFT_ROSTER_PDF', 'FINAL_TIMESHEET_PDF', 'VENUE_PHOTO', 'APPROVED_SHIFT_STATEMENT_PDF'];
const KINDS_AFTER = [...KINDS_BEFORE, 'PAYSLIP_PDF'];
const kindCheck = (kinds: string[]) => `CHECK (kind IN (${kinds.map((k) => `'${k}'`).join(', ')}))`;
const TYPES_BEFORE = [
  'offer_sent', 'offer_expired', 'offer_accepted', 'offer_declined', 'offer_confirmed', 'offer_rejected',
  'shift_reminder_24h', 'shift_reminder_2h', 'shift_reminder_30m', 'shift_assignment_no_show', 'attendance_missing_clock_out',
  'shift_request_submitted', 'shift_request_approved', 'shift_request_declined', 'shift_request_staff_removed',
  'late_clock_in', 'shift_cancelled', 'replacement_required', 'manager_confirmation_timeout', 'clock_in_window_open',
  'shift_statement_ready',
];
const TYPES_AFTER = [...TYPES_BEFORE, 'payslip_available', 'payroll_period_attention'];
const typeCheck = (types: string[]) => `CHECK (notification_type IN (${types.map((k) => `'${k}'`).join(', ')}))`;

const MANAGER_OF_ORG = `(EXISTS (SELECT 1 FROM core.manager_profile mp WHERE (mp.user_id = core.current_uid())
  AND (mp.organisation_id = core.current_org()) AND (mp.type <> 'venue'::text)))`;

/**
 * Agency payment calendar, payroll runs and official (provider-uploaded) payslips — owner decisions 2026-10-21.
 *
 * Core (organisation = agency), RLS ENABLE + FORCE in this migration:
 *  - `payroll_calendar` (year, version, source, timezone Europe/London, status, notes = guidance text only) and
 *    `payroll_calendar_period` (start, end, payday, note, needs_confirmation, active). Active periods of one
 *    organisation can never overlap (GiST exclusion on the date range). History is preserved: a re-import creates a NEW
 *    version and deactivates the previous one; periods are never updated except their `active` flag, never deleted.
 *    Read: any session of the organisation (managers, and staff for their own payday). Write: a non-venue manager of the
 *    organisation (the service additionally requires `payroll.calculate`).
 *  - `core.payroll_record_guard()`: BEFORE UPDATE trigger function for every `payroll_record` (state machine + statement
 *    state backstop, see `payrollRunsSql`).
 * Workspace (core + every workspace schema; the provisioner applies the same SQL): `payroll_run`, `payroll_run_line`,
 * `payslip`, `payslip_document` (`payrollRunsSql`). V1_EXPECTED 21 tables / 126 FKs / 90 indexes / 39 policies.
 * Also: stored_file kind PAYSLIP_PDF; notification types payslip_available / payroll_period_attention.
 */
export class PayrollCalendarRunsPayslips1786719200000 implements MigrationInterface {
  name = 'PayrollCalendarRunsPayslips1786719200000';

  private async schemas(runner: QueryRunner): Promise<string[]> {
    const rows: Array<{ schema_name: string }> = await runner.query(`
      SELECT n.nspname AS schema_name FROM pg_namespace n
      JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = 'payroll_record' AND c.relkind = 'r'
      WHERE n.nspname = 'core' OR n.nspname ~ '^workspace_[0-9a-f]{32}$'
    `);
    return rows.map((row) => row.schema_name);
  }

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
CREATE TABLE IF NOT EXISTS core.payroll_calendar (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  year integer NOT NULL,
  version integer NOT NULL,
  source text NOT NULL,
  timezone text NOT NULL DEFAULT 'Europe/London',
  status text NOT NULL DEFAULT 'active',
  notes text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz,
  CONSTRAINT payroll_calendar_pkey PRIMARY KEY (id),
  CONSTRAINT payroll_calendar_version_key UNIQUE (organisation_id, year, version),
  CONSTRAINT payroll_calendar_year_check CHECK (year BETWEEN 2000 AND 2100 AND version >= 1),
  CONSTRAINT payroll_calendar_status_check CHECK (status IN ('active','inactive')),
  CONSTRAINT payroll_calendar_timezone_check CHECK (timezone = 'Europe/London'),
  CONSTRAINT payroll_calendar_text_check CHECK (char_length(btrim(source)) BETWEEN 1 AND 200 AND (notes IS NULL OR char_length(notes) <= 2000)),
  CONSTRAINT payroll_calendar_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE,
  CONSTRAINT payroll_calendar_created_by_fkey FOREIGN KEY (created_by) REFERENCES core."user"(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS payroll_calendar_one_active_per_year ON core.payroll_calendar (organisation_id, year) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS core.payroll_calendar_period (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  calendar_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  payday date NOT NULL,
  note text,
  needs_confirmation boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_calendar_period_pkey PRIMARY KEY (id),
  CONSTRAINT payroll_calendar_period_start_key UNIQUE (calendar_id, period_start),
  CONSTRAINT payroll_calendar_period_dates_check CHECK (period_end >= period_start AND payday >= period_end),
  CONSTRAINT payroll_calendar_period_note_check CHECK (note IS NULL OR char_length(note) <= 500),
  CONSTRAINT payroll_calendar_period_no_overlap EXCLUDE USING gist (organisation_id WITH =, daterange(period_start, period_end, '[]') WITH &&) WHERE (active),
  CONSTRAINT payroll_calendar_period_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE,
  CONSTRAINT payroll_calendar_period_calendar_id_fkey FOREIGN KEY (calendar_id) REFERENCES core.payroll_calendar(id)
);
CREATE INDEX IF NOT EXISTS payroll_calendar_period_lookup ON core.payroll_calendar_period (organisation_id, period_start) WHERE active;
`);
    for (const t of ['payroll_calendar', 'payroll_calendar_period']) {
      await runner.query(`
ALTER TABLE core.${t} OWNER TO crewflow;
ALTER TABLE core.${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.${t} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ${t}_select ON core.${t};
CREATE POLICY ${t}_select ON core.${t} AS PERMISSIVE FOR SELECT TO PUBLIC USING (organisation_id = core.current_org());
DROP POLICY IF EXISTS ${t}_insert ON core.${t};
CREATE POLICY ${t}_insert ON core.${t} AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK ((organisation_id = core.current_org()) AND ${MANAGER_OF_ORG});
DROP POLICY IF EXISTS ${t}_update ON core.${t};
CREATE POLICY ${t}_update ON core.${t} AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING ((organisation_id = core.current_org()) AND ${MANAGER_OF_ORG}) WITH CHECK ((organisation_id = core.current_org()) AND ${MANAGER_OF_ORG});
REVOKE ALL ON core.${t} FROM PUBLIC;
REVOKE ALL ON core.${t} FROM crewflow_app;
GRANT SELECT, INSERT ON core.${t} TO crewflow_app;`);
    }
    await runner.query(`GRANT UPDATE (status, deactivated_at) ON core.payroll_calendar TO crewflow_app;
GRANT UPDATE (active) ON core.payroll_calendar_period TO crewflow_app;`);

    // State machine + statement-state backstop for payroll_record (all schemas share this function).
    await runner.query(`
CREATE OR REPLACE FUNCTION core.payroll_record_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, core AS $fn$
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
$fn$;
ALTER FUNCTION core.payroll_record_guard() OWNER TO crewflow;
REVOKE ALL ON FUNCTION core.payroll_record_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.payroll_record_guard() TO crewflow, crewflow_app;`);

    for (const schema of await this.schemas(runner)) await runner.query(payrollRunsSql(schema));

    await runner.query(`ALTER TABLE core.stored_file DROP CONSTRAINT IF EXISTS stored_file_kind_check;`);
    await runner.query(`ALTER TABLE core.stored_file ADD CONSTRAINT stored_file_kind_check ${kindCheck(KINDS_AFTER)};`);
    await runner.query(`ALTER TABLE core.notification_preference DROP CONSTRAINT IF EXISTS notification_preference_notification_type_check;`);
    await runner.query(`ALTER TABLE core.notification_preference ADD CONSTRAINT notification_preference_notification_type_check ${typeCheck(TYPES_AFTER)};`);
  }

  /** Failed-rollout only: drops the new tables (data lost; audit rows remain) and restores the previous CHECKs. */
  async down(runner: QueryRunner): Promise<void> {
    for (const schema of await this.schemas(runner)) {
      const q = schema === 'core' ? 'core' : `"${schema}"`;
      await runner.query(`DROP TRIGGER IF EXISTS payroll_record_guard ON ${q}.payroll_record;
        DROP TABLE IF EXISTS ${q}.payslip_document; DROP TABLE IF EXISTS ${q}.payslip; DROP TABLE IF EXISTS ${q}.payroll_run_line; DROP TABLE IF EXISTS ${q}.payroll_run;`);
    }
    await runner.query(`DROP FUNCTION IF EXISTS core.payroll_record_guard(); DROP TABLE IF EXISTS core.payroll_calendar_period; DROP TABLE IF EXISTS core.payroll_calendar;`);
    await runner.query(`ALTER TABLE core.notification_preference DROP CONSTRAINT IF EXISTS notification_preference_notification_type_check;`);
    await runner.query(`ALTER TABLE core.notification_preference ADD CONSTRAINT notification_preference_notification_type_check ${typeCheck(TYPES_BEFORE)};`);
    await runner.query(`ALTER TABLE core.stored_file DROP CONSTRAINT IF EXISTS stored_file_kind_check;`);
    await runner.query(`ALTER TABLE core.stored_file ADD CONSTRAINT stored_file_kind_check ${kindCheck(KINDS_BEFORE)};`);
  }
}
