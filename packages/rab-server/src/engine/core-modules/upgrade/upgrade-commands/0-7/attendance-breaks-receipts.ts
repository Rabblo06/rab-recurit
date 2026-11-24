import type { WorkspaceUpgradeCommand } from '../workspace-upgrade-command';

/**
 * M4 Lane B, design §13 PR 2 (docs/plans/m4-offline/DESIGN.md Appendix A + A.7, owner decisions D1-D20, 44, 45, 46, 91).
 * DRAFT — NEW SQL, owner SQL review FIRST; never edited after merge once approved. "[after 0.7.0 cutover]" (owner decision 44):
 * the frozen C3 copy list (hws-cutover-tables.ts) stays at 21 tables, so these rows are never written before the cutover.
 *
 * THE statements, in one place, for every copy:
 *   - `core` (HWS off): migration AttendanceBreaksReceipts1786722140000 (+ core.attendance_device_key and the break / device key
 *     guard functions, core-only objects);
 *   - every `workspace_<hex>` (HWS on): the level-27 workspace command at the end of this file, and
 *     WorkspaceAttendanceBreaksReceipts1786722150000 folds the same SQL into core.provision_workspace.
 *
 * For one schema, in order (every statement idempotent; no DROP of any kind, so `mayDrop` is unset):
 *   1. A.2: attendance +5 columns and their CHECK (NOT VALID, then VALIDATE: existing rows all take the defaults) + the
 *      offline index; shift_assignment.check_in_offline + CHECK; venue.offline_attendance_enabled (default false, D1) with
 *      CHECK venue_offline_attendance_disabled (NOT offline_attendance_enabled): D12 in the database; only the owner-approved
 *      M5 migration may drop it (review of #353, item 5).
 *   2. A.3: attendance_break. One open break per attendance (partial unique) and no overlap (GiST exclusion, btree_gist). The
 *      attendance key is ON DELETE RESTRICT (A.7). ENABLE + FORCE RLS; SELECT / INSERT / UPDATE policies; no DELETE policy.
 *   3. A.4: attendance_sync_receipt (idempotency + offline evidence, insert-only). Every key RESTRICT. ENABLE + FORCE RLS;
 *      SELECT / INSERT policies only. `request_sha256` is `text` (64 lower-case hex) instead of bytea (lead answer 3,
 *      2026-11-24: the metadata catalogue has no bytea field type); the CHECK is as strict as octet_length = 32.
 *   4. A.7 enforcement for the runtime login (crewflow_owner inherits the owner crewflow, so grants never bind it):
 *        - attendance_break: a ROW-level BEFORE UPDATE allow-list guard (core.owner_login_grant_parity_guard('ended_at',
 *          'end_source', 'updated_at'): any other column changing is 42501), statement-level BEFORE DELETE / TRUNCATE guards
 *          (42501), and core.attendance_break_write_guard() BEFORE INSERT OR UPDATE (closed breaks are frozen; each source
 *          names its writer; a `staff` start or end more than 120 s from now() is 23514; see the function);
 *        - attendance_sync_receipt: statement-level BEFORE UPDATE / DELETE / TRUNCATE guards (42501, even on zero rows).
 *      The guards let through only crewflow, rab_secure_owner and superusers (migrations, definers, foreign-key actions).
 *   5. Grants for parity (the schema role crewflow_app): SELECT, INSERT on both; UPDATE (ended_at, end_source, updated_at)
 *      on attendance_break. Nothing else; no DELETE.
 * Workspace copies only: `<table>_workspace_bound` CHECKs (the uuid is derived from the schema name), and NO foreign key to
 * core.organisation / core.manager_workspace / core."user" (structure level 22, owner decision 0a: workspace schemas reference
 * core only through the service layer). The core copies keep those core keys.
 *
 * Deviations from Appendix A (in the SQL review record): `request_sha256` text; every SELECT policy also admits the worker
 * marker (`rab.actor_type = 'worker'`, the same branch AttendanceStaffScopeRls gives attendance) so the post-shift and payroll
 * jobs can read breaks and receipts — never write them (INSERT / UPDATE have no worker branch).
 */

function checkedSchema(schema: string): string {
  if (schema !== 'core' && !/^workspace_[0-9a-f]{32}$/.test(schema)) throw new Error('Invalid workspace schema');
  return schema;
}

export const ATTENDANCE_TIME_SOURCES = ['server', 'offline_anchored', 'offline_untrusted', 'manager'] as const;
export const ATTENDANCE_BREAK_START_SOURCES = ['staff', 'offline_sync'] as const;
export const ATTENDANCE_BREAK_END_SOURCES = ['staff', 'offline_sync', 'clock_out', 'manager'] as const;
export const ATTENDANCE_SYNC_CHANNELS = ['online', 'offline_sync'] as const;
export const ATTENDANCE_SYNC_EVENT_TYPES = ['check_in', 'clock_in', 'break_start', 'break_end', 'clock_out'] as const;
export const ATTENDANCE_SYNC_OUTCOMES = ['applied', 'duplicate', 'rejected'] as const;
export const ATTENDANCE_SYNC_TIME_TRUST = ['server', 'anchored', 'untrusted'] as const;
export const ATTENDANCE_SYNC_QR_RESULTS = ['ok', 'invalid', 'expired', 'shift_mismatch', 'venue_mismatch', 'revoked', 'issued_after_punch'] as const;
export const ATTENDANCE_SYNC_FLAGS = [
  'clock_skew',
  'clock_changed',
  'late_sync',
  'clamped_to_schedule',
  'mock_location',
  'rooted_signal',
  'venue_changed_since_punch',
  'superseded_no_show',
] as const;

/** A staff-sourced break start or end must be this close to the server's now() (owner, 2026-11-21: ±2 minutes). */
export const ATTENDANCE_BREAK_STAFF_TOLERANCE_SECONDS = 120;

const list = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(', ');

export const ATTENDANCE_BREAK_WRITE_GUARD_FUNCTION = 'core.attendance_break_write_guard';
export const ATTENDANCE_GUARD_FUNCTION = 'core.owner_login_grant_parity_guard';
/** The constraint names the write guard reports (23514), so the service can map them (review of #353, item 7). */
export const ATTENDANCE_BREAK_STAFF_WINDOW = 'attendance_break_staff_window';
export const ATTENDANCE_BREAK_CLOCK_OUT_END = 'attendance_break_clock_out_end';

/**
 * The core-only trigger function (AttendanceBreaksReceipts1786722140000 creates it; every copy's trigger calls it, ROW BEFORE
 * INSERT OR UPDATE). SECURITY INVOKER (its reads run under the writer's own RLS), search_path pinned, owner crewflow (as
 * core.owner_login_grant_parity_guard), EXECUTE revoked from PUBLIC. It never changes NEW. Owner roles (crewflow,
 * rab_secure_owner) and superusers pass; for everyone else (the runtime login):
 *   - a closed break (OLD.ended_at set) is never changed again: 42501 (review item 3; corrections go through
 *     attendance_correction);
 *   - the source names the writer (review item 2): `staff` start / end only by the break's own staff member and within
 *     ±120 s of now() (23514, constraint attendance_break_staff_window; a CHECK cannot read now(), A.7); `offline_sync` only by
 *     the staff member AND only while the venue has offline attendance enabled (it cannot be enabled before M5: venue CHECK,
 *     review item 5); `manager` only by a Manager of the workspace or a Venue Manager of the shift's venue; `clock_out` only by
 *     the staff member or such a manager AND only at the attendance's own clock_out_at (23514, constraint
 *     attendance_break_clock_out_end: the service writes clock_out_at, closes the open break, then moves the status);
 *   - an attendance the writer cannot read refuses the write (42501).
 */
// sql-injection-reviewed: the function name, constraint names and the tolerance are constants of this file; no input reaches this DDL.
export const ATTENDANCE_BREAK_WRITE_GUARD_FUNCTION_SQL = `CREATE FUNCTION ${ATTENDANCE_BREAK_WRITE_GUARD_FUNCTION}()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
DECLARE
  v record;
  v_end boolean;
BEGIN
  IF current_user IN ('crewflow'::name, 'rab_secure_owner'::name)
     OR coalesce((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'attendance_break: a closed break is never changed (corrections go through attendance_correction)'
      USING ERRCODE = '42501';
  END IF;
  EXECUTE pg_catalog.format($q$
    SELECT a.clock_out_at,
           coalesce(ve.offline_attendance_enabled, false) AS offline,
           EXISTS (SELECT 1 FROM %1$I.staff_profile sp WHERE sp.id = $1 AND sp.user_id = core.current_uid()) AS own,
           (EXISTS (SELECT 1 FROM core.manager_profile mp
                     WHERE mp.user_id = core.current_uid() AND mp.organisation_id = core.current_org()
                       AND mp.workspace_id = core.current_workspace() AND mp.type <> 'venue')
            OR EXISTS (SELECT 1 FROM %1$I.manager_venue mv JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
                        WHERE mv.venue_id = s.venue_id AND mp.user_id = core.current_uid() AND mp.type = 'venue'
                          AND mp.organisation_id = core.current_org() AND mp.workspace_id = core.current_workspace())) AS manager
      FROM %1$I.attendance a
      JOIN %1$I.shift s ON s.id = a.shift_id
      LEFT JOIN %1$I.venue ve ON ve.id = s.venue_id
     WHERE a.id = $2 AND a.staff_profile_id = $1 $q$, TG_TABLE_SCHEMA)
    INTO v USING NEW.staff_profile_id, NEW.attendance_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attendance_break: the attendance is not visible to this writer' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT v.own OR (NEW.start_source = 'offline_sync' AND NOT v.offline) THEN
      RAISE EXCEPTION 'attendance_break: % start not permitted for this writer', NEW.start_source USING ERRCODE = '42501';
    END IF;
    IF NEW.start_source = 'staff'
       AND pg_catalog.abs(EXTRACT(EPOCH FROM (NEW.started_at - pg_catalog.now()))) > ${ATTENDANCE_BREAK_STAFF_TOLERANCE_SECONDS} THEN
      RAISE EXCEPTION 'attendance_break: a staff break start must be within ${ATTENDANCE_BREAK_STAFF_TOLERANCE_SECONDS} seconds of the server time'
        USING ERRCODE = '23514', CONSTRAINT = '${ATTENDANCE_BREAK_STAFF_WINDOW}';
    END IF;
  END IF;
  v_end := NEW.ended_at IS NOT NULL
           AND (TG_OP = 'INSERT' OR NEW.ended_at IS DISTINCT FROM OLD.ended_at OR NEW.end_source IS DISTINCT FROM OLD.end_source);
  IF v_end THEN
    IF NOT CASE NEW.end_source
             WHEN 'staff' THEN v.own
             WHEN 'offline_sync' THEN v.own AND v.offline
             WHEN 'manager' THEN v.manager
             WHEN 'clock_out' THEN v.own OR v.manager
             ELSE false
           END THEN
      RAISE EXCEPTION 'attendance_break: % end not permitted for this writer', NEW.end_source USING ERRCODE = '42501';
    END IF;
    IF NEW.end_source = 'staff'
       AND pg_catalog.abs(EXTRACT(EPOCH FROM (NEW.ended_at - pg_catalog.now()))) > ${ATTENDANCE_BREAK_STAFF_TOLERANCE_SECONDS} THEN
      RAISE EXCEPTION 'attendance_break: a staff break end must be within ${ATTENDANCE_BREAK_STAFF_TOLERANCE_SECONDS} seconds of the server time'
        USING ERRCODE = '23514', CONSTRAINT = '${ATTENDANCE_BREAK_STAFF_WINDOW}';
    END IF;
    IF NEW.end_source = 'clock_out' AND (v.clock_out_at IS NULL OR NEW.ended_at IS DISTINCT FROM v.clock_out_at) THEN
      RAISE EXCEPTION 'attendance_break: a clock_out end is the attendance''s own clock-out time'
        USING ERRCODE = '23514', CONSTRAINT = '${ATTENDANCE_BREAK_CLOCK_OUT_END}';
    END IF;
  END IF;
  RETURN NEW;
END;
$guard$`;

export const ATTENDANCE_DEVICE_KEY_REVOKED_GUARD_FUNCTION = 'core.attendance_device_key_revoked_guard';

/**
 * Review of #353, item 4: a revoked device key never changes again (no un-revoke, no new last_used_at, no new reason) for any
 * non-owner role. ROW BEFORE UPDATE on core.attendance_device_key; core only.
 */
// sql-injection-reviewed: the function name is a constant of this file; no input reaches this DDL.
export const ATTENDANCE_DEVICE_KEY_REVOKED_GUARD_FUNCTION_SQL = `CREATE FUNCTION ${ATTENDANCE_DEVICE_KEY_REVOKED_GUARD_FUNCTION}()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
BEGIN
  IF current_user IN ('crewflow'::name, 'rab_secure_owner'::name)
     OR coalesce((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false) THEN
    RETURN NEW;
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'attendance_device_key: a revoked key never changes' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$guard$`;

/** tgtype bits: 1 ROW, 2 BEFORE, 4 INSERT, 8 DELETE, 16 UPDATE, 32 TRUNCATE. */
export const ATTENDANCE_BREAK_TRIGGERS = [
  { name: 'attendance_break_guard_update', timing: 'BEFORE UPDATE', level: 'ROW', fn: `${ATTENDANCE_GUARD_FUNCTION}('ended_at', 'end_source', 'updated_at')`, tgtype: 19 },
  { name: 'attendance_break_guard_delete', timing: 'BEFORE DELETE', level: 'STATEMENT', fn: `${ATTENDANCE_GUARD_FUNCTION}()`, tgtype: 10 },
  { name: 'attendance_break_guard_truncate', timing: 'BEFORE TRUNCATE', level: 'STATEMENT', fn: `${ATTENDANCE_GUARD_FUNCTION}()`, tgtype: 34 },
  { name: 'attendance_break_write_guard', timing: 'BEFORE INSERT OR UPDATE', level: 'ROW', fn: `${ATTENDANCE_BREAK_WRITE_GUARD_FUNCTION}()`, tgtype: 23 },
] as const;

export const ATTENDANCE_SYNC_RECEIPT_TRIGGERS = [
  { name: 'attendance_sync_receipt_insert_only_update', timing: 'BEFORE UPDATE', level: 'STATEMENT', fn: `${ATTENDANCE_GUARD_FUNCTION}()`, tgtype: 18 },
  { name: 'attendance_sync_receipt_insert_only_delete', timing: 'BEFORE DELETE', level: 'STATEMENT', fn: `${ATTENDANCE_GUARD_FUNCTION}()`, tgtype: 10 },
  { name: 'attendance_sync_receipt_insert_only_truncate', timing: 'BEFORE TRUNCATE', level: 'STATEMENT', fn: `${ATTENDANCE_GUARD_FUNCTION}()`, tgtype: 34 },
] as const;

export const ATTENDANCE_BREAK_POLICIES = ['attendance_break_select', 'attendance_break_insert', 'attendance_break_update'] as const;
export const ATTENDANCE_SYNC_RECEIPT_POLICIES = ['attendance_sync_receipt_select', 'attendance_sync_receipt_insert'] as const;

const TENANT = '(organisation_id = core.current_org()) AND (workspace_id = core.current_workspace())';
const WORKER = `current_setting('rab.actor_type', true) = 'worker'`;

function staffOwn(s: string, table: string): string {
  // sql-injection-reviewed: s is 'core' or a regex-validated workspace schema; table is a constant of this file.
  return `EXISTS (SELECT 1 FROM "${s}".staff_profile sp
                 WHERE sp.id = ${table}.staff_profile_id AND sp.user_id = core.current_uid()
                   AND sp.organisation_id = core.current_org() AND sp.workspace_id = core.current_workspace())`;
}

const WORKSPACE_MANAGER = `EXISTS (SELECT 1 FROM core.manager_profile mp
                 WHERE mp.user_id = core.current_uid() AND mp.organisation_id = core.current_org()
                   AND mp.workspace_id = core.current_workspace() AND mp.type <> 'venue')`;

/** Venue Manager of the shift's venue; `from` joins the shift as `s` (A.1 venueManagerOfShift). */
function venueManager(s: string, from: string, where: string): string {
  // sql-injection-reviewed: s is validated; from / where are constants of this file.
  return `EXISTS (SELECT 1 FROM ${from}
                   JOIN "${s}".manager_venue mv ON mv.venue_id = s.venue_id
                   JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
                  WHERE ${where}
                    AND s.organisation_id = core.current_org() AND s.workspace_id = core.current_workspace()
                    AND mv.organisation_id = core.current_org() AND mv.workspace_id = core.current_workspace()
                    AND mp.user_id = core.current_uid() AND mp.type = 'venue'
                    AND mp.organisation_id = core.current_org() AND mp.workspace_id = core.current_workspace())`;
}

function breakVenueManager(s: string): string {
  // sql-injection-reviewed: s is the regex-validated schema; the join and the predicate are constants of this file.
  return venueManager(s, `"${s}".attendance a JOIN "${s}".shift s ON s.id = a.shift_id`, 'a.id = attendance_break.attendance_id');
}

/** A.2 for one schema. */
export function attendanceOfflineColumnsSql(schema: string): string {
  const s = checkedSchema(schema);
  const a = `"${s}".attendance`;
  // sql-injection-reviewed: a / s are built from the validated schema; every value list is a constant of this file.
  return `ALTER TABLE ${a} ADD COLUMN IF NOT EXISTS offline_recorded boolean NOT NULL DEFAULT false;
ALTER TABLE ${a} ADD COLUMN IF NOT EXISTS clock_in_time_source text;
ALTER TABLE ${a} ADD COLUMN IF NOT EXISTS clock_out_time_source text;
ALTER TABLE ${a} ADD COLUMN IF NOT EXISTS clock_in_claimed_at timestamptz;
ALTER TABLE ${a} ADD COLUMN IF NOT EXISTS clock_out_claimed_at timestamptz;
ALTER TABLE "${s}".shift_assignment ADD COLUMN IF NOT EXISTS check_in_offline boolean NOT NULL DEFAULT false;
DO $offline_columns$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = '${a}'::pg_catalog.regclass AND k.conname = 'attendance_time_source_check') THEN
    ALTER TABLE ${a} ADD CONSTRAINT attendance_time_source_check CHECK (
      (clock_in_time_source IS NULL OR clock_in_time_source IN (${list(ATTENDANCE_TIME_SOURCES)}))
      AND (clock_out_time_source IS NULL OR clock_out_time_source IN (${list(ATTENDANCE_TIME_SOURCES)}))
      AND (clock_in_claimed_at IS NULL OR clock_in_time_source = 'offline_anchored' OR offline_recorded)
      AND (clock_out_claimed_at IS NULL OR clock_out_time_source = 'offline_anchored' OR offline_recorded)
      AND (offline_recorded OR (COALESCE(clock_in_time_source, '') NOT LIKE 'offline%'
                            AND COALESCE(clock_out_time_source, '') NOT LIKE 'offline%'))
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = '"${s}".shift_assignment'::pg_catalog.regclass AND k.conname = 'shift_assignment_check_in_offline_check') THEN
    ALTER TABLE "${s}".shift_assignment ADD CONSTRAINT shift_assignment_check_in_offline_check CHECK (NOT check_in_offline OR checked_in_at IS NOT NULL);
  END IF;
END
$offline_columns$;
ALTER TABLE ${a} VALIDATE CONSTRAINT attendance_time_source_check;
CREATE INDEX IF NOT EXISTS attendance_offline_idx ON ${a} USING btree (shift_id) WHERE offline_recorded;
ALTER TABLE "${s}".venue ADD COLUMN IF NOT EXISTS offline_attendance_enabled boolean NOT NULL DEFAULT false;
DO $offline_venue$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = '"${s}".venue'::pg_catalog.regclass AND k.conname = 'venue_offline_attendance_disabled') THEN
    ALTER TABLE "${s}".venue ADD CONSTRAINT venue_offline_attendance_disabled CHECK (NOT offline_attendance_enabled);
  END IF;
END
$offline_venue$`;
}

/** A.3 table + indexes for one schema; the core copy keeps its core keys. */
function breakTableSql(s: string): string {
  const core = s === 'core';
  const coreKeys = core
    ? `,
  CONSTRAINT attendance_break_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE,
  CONSTRAINT attendance_break_workspace_id_fkey    FOREIGN KEY (workspace_id) REFERENCES core.manager_workspace(id)`
    : '';
  // sql-injection-reviewed: s is validated; the value lists and coreKeys are constants of this file.
  return `CREATE TABLE IF NOT EXISTS "${s}".attendance_break (
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  organisation_id  uuid        NOT NULL,
  workspace_id     uuid        NOT NULL,
  attendance_id    uuid        NOT NULL,
  staff_profile_id uuid        NOT NULL,
  started_at       timestamptz NOT NULL,
  ended_at         timestamptz,
  start_source     text        NOT NULL,
  end_source       text,
  is_paid          boolean     NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_break_pkey PRIMARY KEY (id),
  CONSTRAINT attendance_break_order_check  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CONSTRAINT attendance_break_end_pair     CHECK ((ended_at IS NULL) = (end_source IS NULL)),
  CONSTRAINT attendance_break_start_source CHECK (start_source IN (${list(ATTENDANCE_BREAK_START_SOURCES)})),
  CONSTRAINT attendance_break_end_source   CHECK (end_source IS NULL OR end_source IN (${list(ATTENDANCE_BREAK_END_SOURCES)})),
  CONSTRAINT attendance_break_no_overlap EXCLUDE USING gist (
    attendance_id WITH =, tstzrange(started_at, COALESCE(ended_at, 'infinity'::timestamptz), '[)') WITH &&),
  CONSTRAINT attendance_break_attendance_id_fkey   FOREIGN KEY (attendance_id) REFERENCES "${s}".attendance(id) ON DELETE RESTRICT,
  CONSTRAINT attendance_break_staff_workspace_fkey FOREIGN KEY (staff_profile_id, workspace_id)
    REFERENCES "${s}".staff_profile(id, workspace_id)${coreKeys}
);
CREATE UNIQUE INDEX IF NOT EXISTS attendance_break_one_open ON "${s}".attendance_break USING btree (attendance_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS attendance_break_attendance_idx ON "${s}".attendance_break USING btree (attendance_id, started_at);
CREATE INDEX IF NOT EXISTS attendance_break_workspace_id_idx ON "${s}".attendance_break USING btree (workspace_id)`;
}

/** A.4 table + indexes for one schema; the core copy keeps its core keys. */
function receiptTableSql(s: string): string {
  const core = s === 'core';
  const coreKeys = core
    ? `,
  CONSTRAINT attendance_sync_receipt_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE,
  CONSTRAINT attendance_sync_receipt_workspace_id_fkey    FOREIGN KEY (workspace_id) REFERENCES core.manager_workspace(id),
  CONSTRAINT attendance_sync_receipt_user_id_fkey         FOREIGN KEY (user_id) REFERENCES core."user"(id)`
    : '';
  // sql-injection-reviewed: s is validated; the value lists and coreKeys are constants of this file.
  return `CREATE TABLE IF NOT EXISTS "${s}".attendance_sync_receipt (
  id                    uuid        NOT NULL DEFAULT gen_random_uuid(),
  organisation_id       uuid        NOT NULL,
  workspace_id          uuid        NOT NULL,
  staff_profile_id      uuid        NOT NULL,
  user_id               uuid        NOT NULL,
  idempotency_key       uuid        NOT NULL,
  request_sha256        text        NOT NULL,
  channel               text        NOT NULL,
  event_type            text        NOT NULL,
  shift_id              uuid,
  attendance_id         uuid,
  break_id              uuid,
  outcome               text        NOT NULL,
  reason_code           text,
  time_trust            text        NOT NULL,
  claimed_at            timestamptz,
  applied_at            timestamptz,
  received_at           timestamptz NOT NULL DEFAULT now(),
  ticket_issued_at      timestamptz,
  device_wall_clock_at  timestamptz,
  device_key_thumbprint text,
  client_seq            bigint,
  location_verified     boolean,
  distance_m            integer,
  accuracy_m            integer,
  qr_result             text,
  flags                 text[]      NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_sync_receipt_pkey PRIMARY KEY (id),
  CONSTRAINT attendance_sync_receipt_key UNIQUE (staff_profile_id, idempotency_key),
  CONSTRAINT attendance_sync_receipt_sha_check      CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT attendance_sync_receipt_channel_check  CHECK (channel IN (${list(ATTENDANCE_SYNC_CHANNELS)})),
  CONSTRAINT attendance_sync_receipt_event_check    CHECK (event_type IN (${list(ATTENDANCE_SYNC_EVENT_TYPES)})),
  CONSTRAINT attendance_sync_receipt_outcome_check  CHECK (outcome IN (${list(ATTENDANCE_SYNC_OUTCOMES)})),
  CONSTRAINT attendance_sync_receipt_reason_check   CHECK ((outcome = 'rejected') = (reason_code IS NOT NULL)
                                                          AND (reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z_]{2,48}$')),
  CONSTRAINT attendance_sync_receipt_trust_check    CHECK (time_trust IN (${list(ATTENDANCE_SYNC_TIME_TRUST)})
                                                          AND ((channel = 'online') = (time_trust = 'server'))),
  CONSTRAINT attendance_sync_receipt_applied_check  CHECK (outcome <> 'applied' OR applied_at IS NOT NULL),
  CONSTRAINT attendance_sync_receipt_evidence_check CHECK ((distance_m IS NULL OR distance_m >= 0) AND (accuracy_m IS NULL OR accuracy_m >= 0)
                                                          AND (client_seq IS NULL OR client_seq >= 0)),
  CONSTRAINT attendance_sync_receipt_qr_check       CHECK (qr_result IS NULL OR qr_result IN (${list(ATTENDANCE_SYNC_QR_RESULTS)})),
  CONSTRAINT attendance_sync_receipt_thumb_check    CHECK (device_key_thumbprint IS NULL OR device_key_thumbprint ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT attendance_sync_receipt_flags_check    CHECK (flags <@ ARRAY[${list(ATTENDANCE_SYNC_FLAGS)}]::text[]),
  CONSTRAINT attendance_sync_receipt_staff_workspace_fkey FOREIGN KEY (staff_profile_id, workspace_id)
    REFERENCES "${s}".staff_profile(id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT attendance_sync_receipt_shift_workspace_fkey FOREIGN KEY (shift_id, workspace_id)
    REFERENCES "${s}".shift(id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT attendance_sync_receipt_attendance_id_fkey   FOREIGN KEY (attendance_id) REFERENCES "${s}".attendance(id) ON DELETE RESTRICT,
  CONSTRAINT attendance_sync_receipt_break_id_fkey        FOREIGN KEY (break_id) REFERENCES "${s}".attendance_break(id) ON DELETE RESTRICT${coreKeys}
);
CREATE INDEX IF NOT EXISTS attendance_sync_receipt_attendance_idx ON "${s}".attendance_sync_receipt USING btree (attendance_id) WHERE attendance_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS attendance_sync_receipt_shift_idx ON "${s}".attendance_sync_receipt USING btree (shift_id, outcome, received_at DESC);
CREATE INDEX IF NOT EXISTS attendance_sync_receipt_staff_idx ON "${s}".attendance_sync_receipt USING btree (staff_profile_id, received_at DESC);
CREATE INDEX IF NOT EXISTS attendance_sync_receipt_workspace_id_idx ON "${s}".attendance_sync_receipt USING btree (workspace_id)`;
}

/** The policy statements for one schema, keyed by policy name (each created only when missing). */
export function attendanceBreaksReceiptsPolicies(schema: string): ReadonlyArray<{ table: string; name: string; sql: string }> {
  const s = checkedSchema(schema);
  const b = `"${s}".attendance_break`;
  const r = `"${s}".attendance_sync_receipt`;
  // sql-injection-reviewed: b / r / s are built from the validated schema; every fragment is a constant of this file.
  return [
    {
      table: 'attendance_break',
      name: 'attendance_break_select',
      // sql-injection-reviewed: b / r are built from the regex-validated schema; the policy text is constants of this file.
      sql: `CREATE POLICY attendance_break_select ON ${b} AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (
    ${TENANT}
    AND ( ${WORKER}
       OR ${WORKSPACE_MANAGER}
       OR ${staffOwn(s, 'attendance_break')}
       OR ${breakVenueManager(s)} )
  )`,
    },
    {
      table: 'attendance_break',
      name: 'attendance_break_insert',
      // sql-injection-reviewed: b / r are built from the regex-validated schema; the policy text is constants of this file.
      sql: `CREATE POLICY attendance_break_insert ON ${b} AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (
    ${TENANT}
    AND ${staffOwn(s, 'attendance_break')}
    AND EXISTS (SELECT 1 FROM "${s}".attendance a
                 WHERE a.id = attendance_break.attendance_id AND a.staff_profile_id = attendance_break.staff_profile_id
                   AND a.organisation_id = attendance_break.organisation_id AND a.workspace_id = attendance_break.workspace_id
                   AND a.status IN ('clocked_in', 'on_break'))
  )`,
    },
    {
      table: 'attendance_break',
      name: 'attendance_break_update',
      // sql-injection-reviewed: b / r are built from the regex-validated schema; the policy text is constants of this file.
      sql: `CREATE POLICY attendance_break_update ON ${b} AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (
    ${TENANT}
    AND EXISTS (SELECT 1 FROM "${s}".attendance a
                 WHERE a.id = attendance_break.attendance_id
                   AND a.status IN ('clocked_in', 'on_break', 'missing_clock_out'))
    AND ( ${staffOwn(s, 'attendance_break')}
       OR ${WORKSPACE_MANAGER}
       OR ${breakVenueManager(s)} )
  )
  WITH CHECK (${TENANT})`,
    },
    {
      table: 'attendance_sync_receipt',
      name: 'attendance_sync_receipt_select',
      // sql-injection-reviewed: b / r are built from the regex-validated schema; the policy text is constants of this file.
      sql: `CREATE POLICY attendance_sync_receipt_select ON ${r} AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (
    ${TENANT}
    AND ( ${WORKER}
       OR ${WORKSPACE_MANAGER}
       OR ${staffOwn(s, 'attendance_sync_receipt')}
       OR ${venueManager(s, `"${s}".shift s`, 's.id = attendance_sync_receipt.shift_id')} )
  )`,
    },
    {
      table: 'attendance_sync_receipt',
      name: 'attendance_sync_receipt_insert',
      // sql-injection-reviewed: b / r are built from the regex-validated schema; the policy text is constants of this file.
      sql: `CREATE POLICY attendance_sync_receipt_insert ON ${r} AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (
    ${TENANT}
    AND user_id = core.current_uid()
    AND ${staffOwn(s, 'attendance_sync_receipt')}
    AND (attendance_id IS NULL OR EXISTS (SELECT 1 FROM "${s}".attendance a
                                           WHERE a.id = attendance_sync_receipt.attendance_id
                                             AND a.staff_profile_id = attendance_sync_receipt.staff_profile_id))
    AND (break_id IS NULL OR EXISTS (SELECT 1 FROM "${s}".attendance_break b
                                      WHERE b.id = attendance_sync_receipt.break_id
                                        AND b.staff_profile_id = attendance_sync_receipt.staff_profile_id))
    AND (shift_id IS NULL OR EXISTS (SELECT 1 FROM "${s}".shift_assignment sa
                                      WHERE sa.shift_id = attendance_sync_receipt.shift_id
                                        AND sa.staff_profile_id = attendance_sync_receipt.staff_profile_id))
  )`,
    },
  ];
}

/** RLS on, policies (created only when missing), guard triggers (created only when missing) and grants, for one schema. */
function securitySql(s: string): string {
  const b = `"${s}".attendance_break`;
  const r = `"${s}".attendance_sync_receipt`;
  const policies = attendanceBreaksReceiptsPolicies(s)
    .map(
      // sql-injection-reviewed: p.table / p.name are constants; the CREATE POLICY text is built from the validated schema.
      (p) => `  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = '"${s}".${p.table}'::pg_catalog.regclass AND p.polname = '${p.name}') THEN
    ${p.sql};
  END IF;`,
    )
    .join('\n');
  const triggers = [
    ...ATTENDANCE_BREAK_TRIGGERS.map((g) => ({ ...g, on: b })),
    ...ATTENDANCE_SYNC_RECEIPT_TRIGGERS.map((g) => ({ ...g, on: r })),
  ]
    .map(
      // sql-injection-reviewed: g.on is built from the validated schema; name / timing / level / fn are constants of this file.
      (g) => `  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = '${g.on}'::pg_catalog.regclass AND t.tgname = '${g.name}') THEN
    CREATE TRIGGER ${g.name} ${g.timing} ON ${g.on} FOR EACH ${g.level} EXECUTE FUNCTION ${g.fn};
  END IF;`,
    )
    .join('\n');
  // sql-injection-reviewed: b / r / s are built from the validated schema; everything else is constant text.
  return `ALTER TABLE ${b} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${b} FORCE ROW LEVEL SECURITY;
ALTER TABLE ${r} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${r} FORCE ROW LEVEL SECURITY;
DO $breaks_receipts_security$
BEGIN
${policies}
${triggers}
END
$breaks_receipts_security$;
REVOKE ALL ON ${b} FROM PUBLIC;
REVOKE ALL ON ${b} FROM crewflow_app;
GRANT SELECT, INSERT ON ${b} TO crewflow_app;
GRANT UPDATE (ended_at, end_source, updated_at) ON ${b} TO crewflow_app;
REVOKE ALL ON ${r} FROM PUBLIC;
REVOKE ALL ON ${r} FROM crewflow_app;
GRANT SELECT, INSERT ON ${r} TO crewflow_app`;
}

/**
 * Workspace copies only: the `<table>_workspace_bound` CHECK the provisioners add to the 21 template tables, for the two new
 * tables (the provisioners' loops run before the structure levels, over the frozen 21). The workspace uuid is the schema
 * name's 32 hex digits (`workspace_` || replace(id::text, '-', '')), re-hyphenated; created only when missing.
 */
function workspaceBoundSql(s: string): string {
  // sql-injection-reviewed: s is a regex-validated `workspace_<32 hex>` name; the table and constraint names are constants.
  const add = (table: string) => `  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = '"${s}".${table}'::pg_catalog.regclass AND k.conname = '${table}_workspace_bound') THEN
    EXECUTE pg_catalog.format('ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK (workspace_id IS NOT NULL AND workspace_id = %L::uuid)',
                              '${s}', '${table}', '${table}_workspace_bound', v_ws::text);
  END IF;`;
  return `DO $breaks_receipts_bound$
DECLARE
  v_ws uuid := pg_catalog.regexp_replace(pg_catalog.substr('${s}', 11), '^(.{8})(.{4})(.{4})(.{4})(.{12})$', '\\1-\\2-\\3-\\4-\\5')::uuid;
BEGIN
${add('attendance_break')}
${add('attendance_sync_receipt')}
END
$breaks_receipts_bound$`;
}

/** Everything for one schema ('core' or a validated workspace schema), in order. */
export function attendanceBreaksReceiptsSql(schema: string): string {
  const s = checkedSchema(schema);
  const parts = [attendanceOfflineColumnsSql(s), breakTableSql(s), receiptTableSql(s), securitySql(s)];
  if (s !== 'core') parts.push(workspaceBoundSql(s));
  return parts.join(';\n');
}

// ---------------------------------------------------------------------------------------------------------------------
// Workspace structure level 27 (lead allocation 2026-11-24; levels 27/28 of Lane C were not needed, owner decision 48).
// Registered in the 0-7 bucket for now; when the lead opens 0.8.0 it moves to 0-8 (lead answer 2026-11-24: one-line move,
// the step name prefix becomes 0.8.0_). Additive only: `mayDrop` unset. WorkspaceAttendanceBreaksReceipts1786722150000
// re-creates core.verify_workspace_schema_v1 (23 tables at level 27) and folds this SQL into core.provision_workspace.

export const ATTENDANCE_BREAKS_RECEIPTS_TIMESTAMP = 1786722150000;

/** The level-27 statements for one workspace schema (the same builder as core, workspace mode). */
export function workspaceAttendanceBreaksReceiptsSql(schema: string): string {
  if (!/^workspace_[0-9a-f]{32}$/.test(schema)) throw new Error('Invalid workspace schema');
  return attendanceBreaksReceiptsSql(schema);
}

/**
 * Expected `core.workspace_schema_fingerprint_v2` of a level-27 workspace per PostgreSQL major. Measured, never derived
 * (ws-attendance-breaks-receipts.integration.spec.ts `[l27-fp]`; the fingerprints ci run prints `MISMATCH (measured …)`).
 * PLACEHOLDERS until CI measures them (fail closed).
 */
export const ATTENDANCE_BREAKS_RECEIPTS_FINGERPRINTS_V2: Readonly<Partial<Record<16 | 17 | 18, string>>> = Object.freeze({
  16: '0000000000000000000000000000000000000000000000000000000000000036',
  17: '0000000000000000000000000000000000000000000000000000000000000037',
  18: '0000000000000000000000000000000000000000000000000000000000000038',
});

export const ATTENDANCE_BREAKS_RECEIPTS_PROVISION_LITERAL = 'db:provision_workspace@WorkspaceAttendanceBreaksReceipts1786722150000';

export const ATTENDANCE_BREAKS_RECEIPTS: WorkspaceUpgradeCommand = Object.freeze({
  kind: 'workspace',
  name: 'AttendanceBreaksReceipts',
  timestamp: ATTENDANCE_BREAKS_RECEIPTS_TIMESTAMP,
  sql: workspaceAttendanceBreaksReceiptsSql,
  structure: Object.freeze({
    level: 27,
    fingerprints: ATTENDANCE_BREAKS_RECEIPTS_FINGERPRINTS_V2,
    provisionFunctionLiteral: ATTENDANCE_BREAKS_RECEIPTS_PROVISION_LITERAL,
  }),
});
