// sql-injection-reviewed-file: SQL definition module (database layer). Every interpolation is a code constant of this repository (table, policy and trigger names); no request or row data reaches these templates.
import { ATTENDANCE_DEVICE_KEY_TRIGGERS } from '../core/attendance-device-key-sql';
import {
  ATTENDANCE_BREAK_POLICIES,
  ATTENDANCE_BREAK_TRIGGERS,
  ATTENDANCE_SYNC_RECEIPT_POLICIES,
  ATTENDANCE_SYNC_RECEIPT_TRIGGERS,
} from '../../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-breaks-receipts';

/**
 * End-state checks for AttendanceBreaksReceipts1786722140000 (the core copies, M4 design §13 PR 2). Read-only catalog queries;
 * the migration runs them before COMMIT and refuses (rolled back) on any difference.
 */
export const CORE_NEW_TABLES = ['attendance_break', 'attendance_sync_receipt', 'attendance_device_key'] as const;

const IN_LIST = CORE_NEW_TABLES.map((t) => `'${t}'`).join(', ');

export const CORE_BREAKS_RECEIPTS_STATE_SQL = `
SELECT 'table' AS kind, c.relname::text AS name,
       (c.relrowsecurity AND c.relforcerowsecurity)::text || '|' || pg_catalog.pg_get_userbyid(c.relowner)::text AS detail
  FROM pg_catalog.pg_class c
 WHERE c.relnamespace = 'core'::pg_catalog.regnamespace AND c.relkind = 'r' AND c.relname IN (${IN_LIST})
UNION ALL
SELECT 'policy', c.relname::text || '.' || p.polname::text, p.polcmd::text
  FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
 WHERE c.relnamespace = 'core'::pg_catalog.regnamespace AND c.relname IN (${IN_LIST})
UNION ALL
SELECT 'trigger', c.relname::text || '.' || t.tgname::text, t.tgtype::text || '|' || t.tgenabled::text || '|' || t.tgfoid::pg_catalog.regprocedure::text
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
 WHERE c.relnamespace = 'core'::pg_catalog.regnamespace AND c.relname IN (${IN_LIST}) AND NOT t.tgisinternal
UNION ALL
SELECT 'app', c.relname::text,
       pg_catalog.has_table_privilege('crewflow_app', c.oid, 'SELECT')::text || '|' || pg_catalog.has_table_privilege('crewflow_app', c.oid, 'INSERT')::text || '|' ||
       pg_catalog.has_table_privilege('crewflow_app', c.oid, 'UPDATE')::text || '|' || pg_catalog.has_table_privilege('crewflow_app', c.oid, 'DELETE')::text || '|' ||
       pg_catalog.has_table_privilege('crewflow_app', c.oid, 'TRUNCATE')::text
  FROM pg_catalog.pg_class c
 WHERE c.relnamespace = 'core'::pg_catalog.regnamespace AND c.relkind = 'r' AND c.relname IN (${IN_LIST})
UNION ALL
SELECT 'function', p.oid::pg_catalog.regprocedure::text, pg_catalog.pg_get_userbyid(p.proowner)::text || '|' || p.prosecdef::text || '|' ||
       pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE')::text
  FROM pg_catalog.pg_proc p
 WHERE p.oid = pg_catalog.to_regprocedure('core.attendance_break_time_guard()')`;

export interface CoreStateRow {
  kind: string;
  name: string;
  detail: string;
}

const GUARD = 'core.owner_login_grant_parity_guard()';
const TIME_GUARD = 'core.attendance_break_time_guard()';

/** The exact expected rows (kind|name -> detail). Table-level UPDATE privilege is false: only column UPDATE grants exist. */
export function expectedCoreState(): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of CORE_NEW_TABLES) m.set(`table|${t}`, 'true|crewflow');
  const cmd = (name: string) => (name.endsWith('_select') ? 'r' : name.endsWith('_insert') ? 'a' : name.endsWith('_update') ? 'w' : '*');
  for (const p of ATTENDANCE_BREAK_POLICIES) m.set(`policy|attendance_break.${p}`, cmd(p));
  for (const p of ATTENDANCE_SYNC_RECEIPT_POLICIES) m.set(`policy|attendance_sync_receipt.${p}`, cmd(p));
  m.set('policy|attendance_device_key.attendance_device_key_own', '*');
  for (const g of ATTENDANCE_BREAK_TRIGGERS) m.set(`trigger|attendance_break.${g.name}`, `${g.tgtype}|O|${g.name === 'attendance_break_time_guard' ? TIME_GUARD : GUARD}`);
  for (const g of ATTENDANCE_SYNC_RECEIPT_TRIGGERS) m.set(`trigger|attendance_sync_receipt.${g.name}`, `${g.tgtype}|O|${GUARD}`);
  for (const g of ATTENDANCE_DEVICE_KEY_TRIGGERS) m.set(`trigger|attendance_device_key.${g.name}`, `${g.tgtype}|O|${GUARD}`);
  for (const t of CORE_NEW_TABLES) m.set(`app|${t}`, 'true|true|false|false|false');
  m.set(`function|${TIME_GUARD}`, 'crewflow|false|false');
  return m;
}

/** Differences between the catalog and the expected end state (empty = as built). */
export function coreBreaksReceiptsProblems(rows: readonly CoreStateRow[]): string[] {
  const want = expectedCoreState();
  const got = new Map(rows.map((r) => [`${r.kind}|${r.name}`, r.detail]));
  const problems: string[] = [];
  for (const [k, v] of want) if (got.get(k) !== v) problems.push(`${k}: expected ${v}, found ${got.get(k) ?? 'nothing'}`);
  for (const [k, v] of got) if (!want.has(k)) problems.push(`${k}: unexpected (${v})`);
  return problems;
}

/** down() guard: any evidence row in the new core tables, or any attendance / assignment / venue with a non-default new column. */
export const CORE_BREAKS_RECEIPTS_DATA_SQL = `
SELECT (SELECT pg_catalog.count(*) FROM core.attendance_break)::int AS breaks,
       (SELECT pg_catalog.count(*) FROM core.attendance_sync_receipt)::int AS receipts,
       (SELECT pg_catalog.count(*) FROM core.attendance_device_key)::int AS device_keys,
       (SELECT pg_catalog.count(*) FROM core.attendance
         WHERE offline_recorded OR clock_in_time_source IS NOT NULL OR clock_out_time_source IS NOT NULL
            OR clock_in_claimed_at IS NOT NULL OR clock_out_claimed_at IS NOT NULL)::int AS attendance,
       (SELECT pg_catalog.count(*) FROM core.shift_assignment WHERE check_in_offline)::int AS assignments,
       (SELECT pg_catalog.count(*) FROM core.venue WHERE offline_attendance_enabled)::int AS venues`;

/** down(): the state before, in dependency order. Only run after CORE_BREAKS_RECEIPTS_DATA_SQL found nothing. */
export const CORE_BREAKS_RECEIPTS_DOWN_SQL: readonly string[] = Object.freeze([
  'DROP TABLE core.attendance_sync_receipt',
  'DROP TABLE core.attendance_break',
  'DROP TABLE core.attendance_device_key',
  'DROP FUNCTION core.attendance_break_time_guard()',
  'DROP INDEX core.attendance_offline_idx',
  'ALTER TABLE core.attendance DROP CONSTRAINT attendance_time_source_check',
  'ALTER TABLE core.attendance DROP COLUMN offline_recorded, DROP COLUMN clock_in_time_source, DROP COLUMN clock_out_time_source, DROP COLUMN clock_in_claimed_at, DROP COLUMN clock_out_claimed_at',
  'ALTER TABLE core.shift_assignment DROP CONSTRAINT shift_assignment_check_in_offline_check',
  'ALTER TABLE core.shift_assignment DROP COLUMN check_in_offline',
  'ALTER TABLE core.venue DROP COLUMN offline_attendance_enabled',
]);
