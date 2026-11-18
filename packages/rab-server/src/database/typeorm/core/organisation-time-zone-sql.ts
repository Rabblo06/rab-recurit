// sql-injection-reviewed-file: SQL definition / check module (database layer). No interpolation of request or row data: the statements are literals, and the only template (the validity predicate) is filled with code constants of this repository (a column reference). Reviewed 2026-11-18 (organisation time zone, phase 1).
/**
 * Organisation time zone, phase 1 (owner decision 2026-11-18: "Time zone: the organisation's, stored on the organisation,
 * default Europe/London; payroll periods and displays use it; UTC in the DB"). SQL of migration
 * OrganisationTimeZoneGuard1786721610000, kept as data so the exact statements can be reviewed, scanned and unit-tested.
 * STATUS: DRAFT, waiting for the owner's SQL review. Applied only to disposable InstaBox test databases.
 *
 * THE COLUMN ALREADY EXISTS. `core.organisation.timezone text NOT NULL DEFAULT 'Europe/London'` was created by
 * IdentitySchema1786665800000 (merged, never edited) and is already read by the PDFs, the payroll month view, the staff
 * reviews, the AI tools and the offer "today" flag. Adding a second column (`time_zone`) would give the organisation two
 * zones and every reader a choice; this migration therefore ADDS NO COLUMN and only closes the gap the existing column has:
 * today nothing checks the value (UpdateWorkspaceDto.timezone is `@IsString()` only), and a bad value makes
 * `AT TIME ZONE $n` (payroll month view, staff reviews) and `Intl.DateTimeFormat` (PDFs) throw.
 *
 * WHY A TRIGGER, NOT A CHECK. A CHECK may not contain a sub-query, so `pg_timezone_names` cannot be named in one; the
 * usual work-around (an IMMUTABLE wrapper function) would be a lie about immutability, because the zone list is the
 * server's tz database and changes with PostgreSQL / OS updates. Consequences of that lie: pg_restore re-validates CHECK
 * constraints and would fail a restore onto a server whose tz database dropped or renamed a zone; and a CHECK is evaluated
 * on EVERY update of the row, so an organisation whose zone disappeared would be unable to bump its security_version
 * (logout, password reset, role changes write that row) - a lock-out on a security path. A BEFORE trigger that runs only
 * when the zone is inserted or changed validates against the live tz database at write time and never blocks unrelated
 * writes or a restore. Service-level validation alone is not enough (CLAUDE.md: five layers, fail closed): raw SQL, a CLI
 * command or a future service would bypass it. Phase 2 adds the service check as well (Intl must also accept the name,
 * because the PDFs and the web format with Intl).
 *
 * WHAT IS A VALID NAME HERE. A name the server's tz database lists in pg_timezone_names, spelled exactly (case-sensitive),
 * at most 64 characters, shaped like an IANA name (`Area`, `Area/Location` or `Area/Location/Sub`, letters, digits, `_`,
 * `+`, `-`), and not one of the tz database's non-zone entries: the `posix/` and `right/` copies (`right/` zones count
 * leap seconds and Intl does not know them), `posixrules`, `localtime` and `Factory`. POSIX offset strings such as
 * `UTC+3` or `<+03>-3`, which `AT TIME ZONE` would also accept, are refused: they have no daylight-saving rules a person
 * can audit. Legacy IANA aliases (`GB`, `US/Eastern`, `Etc/GMT+5`) are accepted (they are IANA names); whether the
 * settings screen should offer only canonical names is an owner question for phase 2.
 *
 * RLS AND GRANTS: UNCHANGED. core.organisation stays ENABLE + FORCE (PreAuthTablesForceOwnerOnly1786721400000; it is no
 * longer on a NOT-FORCED list), with its two policies organisation_self (id = core.current_org()) and
 * organisation_secure_owner_definer. No column, policy or grant is added. The trigger function is owned by
 * rab_secure_owner (a function attached to a rab_secure_owner table must be: secure-owner invariants), SECURITY INVOKER,
 * search_path pinned, EXECUTE revoked from PUBLIC (a trigger needs no EXECUTE grant to fire; nothing may call it directly).
 */

export const ORGANISATION_TIME_ZONE_MIGRATION = 'OrganisationTimeZoneGuard1786721610000';
export const ORGANISATION_TIME_ZONE_FUNCTION = 'core.organisation_timezone_guard()';
export const ORGANISATION_TIME_ZONE_TRIGGER = 'organisation_timezone_guard';
export const ORGANISATION_TIME_ZONE_DEFAULT = 'Europe/London';
export const ORGANISATION_TIME_ZONE_MAX_LENGTH = 64;

/** The one rule, as an SQL boolean expression over `ref` (a column reference, never data). Used by the trigger and the pre-check. */
export function validTimeZonePredicate(ref: string): string {
  return `(pg_catalog.length(${ref}) <= ${ORGANISATION_TIME_ZONE_MAX_LENGTH}
       AND ${ref} ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$'
       AND ${ref} !~ '^(posix|right)/'
       AND ${ref} NOT IN ('posixrules', 'localtime', 'Factory')
       AND EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name = ${ref}))`;
}

/** Statement 1. The trigger function. Run as rab_secure_owner (SET LOCAL ROLE), so it is created owned by it. */
export const ORGANISATION_TIME_ZONE_FUNCTION_SQL = `CREATE FUNCTION core.organisation_timezone_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  -- An UPDATE that leaves the zone as it was is not checked (a zone the tz database later dropped never blocks other writes).
  IF TG_OP = 'UPDATE' AND NEW.timezone IS NOT DISTINCT FROM OLD.timezone THEN
    RETURN NEW;
  END IF;
  -- NULL is left to the column's NOT NULL constraint (23502).
  IF NEW.timezone IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT ${validTimeZonePredicate('NEW.timezone')} THEN
    RAISE EXCEPTION 'core.organisation.timezone must be an IANA time zone name' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END
$fn$`;

/** Statements 2-5, in order, after statement 1. */
export const ORGANISATION_TIME_ZONE_UP_SQL: readonly string[] = [
  `ALTER FUNCTION core.organisation_timezone_guard() OWNER TO rab_secure_owner`,
  `REVOKE ALL ON FUNCTION core.organisation_timezone_guard() FROM PUBLIC`,
  `CREATE TRIGGER organisation_timezone_guard
  BEFORE INSERT OR UPDATE OF timezone ON core.organisation
  FOR EACH ROW EXECUTE FUNCTION core.organisation_timezone_guard()`,
];

/** down(): the trigger, then the function. The column and its default stay (they predate this migration). */
export const ORGANISATION_TIME_ZONE_DOWN_SQL: readonly string[] = [
  `DROP TRIGGER IF EXISTS organisation_timezone_guard ON core.organisation`,
  `DROP FUNCTION IF EXISTS core.organisation_timezone_guard()`,
];

/** Pre-check (read-only): the column is exactly what IdentitySchema1786665800000 created. */
export const ORGANISATION_TIME_ZONE_COLUMN_SQL = `
SELECT a.atttypid = 'pg_catalog.text'::pg_catalog.regtype AS is_text,
       a.attnotnull AS not_null,
       pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_expr
  FROM pg_catalog.pg_attribute a
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
 WHERE a.attrelid = 'core.organisation'::pg_catalog.regclass AND a.attname = 'timezone' AND NOT a.attisdropped`;
export const ORGANISATION_TIME_ZONE_EXPECTED_DEFAULT_EXPR = `'Europe/London'::text`;

/**
 * Pre-check (read-only, run as rab_secure_owner, whose owner-only policy shows every organisation): how many stored zones
 * the new rule would refuse. Any > 0 refuses the migration (fail closed; the operator fixes those rows first). Only the
 * count is read, never a value.
 */
export const ORGANISATION_TIME_ZONE_INVALID_ROWS_SQL = `
SELECT pg_catalog.count(*)::integer AS invalid
  FROM core.organisation o
 WHERE NOT ${validTimeZonePredicate('o.timezone')}`;

/** Self-check (read-only): the function, its trigger and the table's RLS, as one row of text facts. */
export const ORGANISATION_TIME_ZONE_STATE_SQL = `
SELECT
  (SELECT pg_catalog.pg_get_userbyid(p.proowner)::text || '|definer=' || p.prosecdef::text || '|' || COALESCE(pg_catalog.array_to_string(p.proconfig, ';'), '')
          || '|execute=' || COALESCE((SELECT pg_catalog.string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END, '+' ORDER BY a.grantee)
                                        FROM pg_catalog.aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE'), '')
          || '|body=' || pg_catalog.md5(p.prosrc || '|')
     FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('core.organisation_timezone_guard()')) AS function_state,
  (SELECT pg_catalog.string_agg(t.tgname::text || '|enabled=' || t.tgenabled::text || '|' || pg_catalog.pg_get_triggerdef(t.oid), ';' ORDER BY t.tgname)
     FROM pg_catalog.pg_trigger t
    WHERE t.tgrelid = 'core.organisation'::pg_catalog.regclass AND NOT t.tgisinternal
      AND t.tgfoid = pg_catalog.to_regprocedure('core.organisation_timezone_guard()')) AS trigger_state,
  (SELECT c.relrowsecurity::text || '|' || c.relforcerowsecurity::text || '|' || pg_catalog.pg_get_userbyid(c.relowner)::text
     FROM pg_catalog.pg_class c WHERE c.oid = 'core.organisation'::pg_catalog.regclass) AS rls_state,
  (SELECT pg_catalog.string_agg(pol.polname::text, ',' ORDER BY pol.polname)
     FROM pg_catalog.pg_policy pol WHERE pol.polrelid = 'core.organisation'::pg_catalog.regclass) AS policies`;

export interface OrganisationTimeZoneState {
  function_state: string | null;
  trigger_state: string | null;
  rls_state: string | null;
  policies: string | null;
}

/** The text between `AS $fn$` and the closing `$fn$` (pg_proc.prosrc). */
export function functionBodyOf(createSql: string): string {
  const m = /AS \$fn\$([\s\S]*)\$fn\$$/.exec(createSql);
  if (!m) throw new Error('functionBodyOf: no $fn$ body');
  return m[1]!;
}

/** Expected facts after up(); `bodyHash` is md5(prosrc || '|'). The RLS part is what main has; this migration must not move it. */
export function organisationTimeZoneExpectedState(bodyHash: string): OrganisationTimeZoneState {
  return {
    function_state: `rab_secure_owner|definer=false|search_path=pg_catalog, pg_temp|execute=rab_secure_owner|body=${bodyHash}`,
    trigger_state:
      'organisation_timezone_guard|enabled=O|CREATE TRIGGER organisation_timezone_guard BEFORE INSERT OR UPDATE OF timezone ON core.organisation ' +
      'FOR EACH ROW EXECUTE FUNCTION core.organisation_timezone_guard()',
    rls_state: 'true|true|rab_secure_owner',
    policies: 'organisation_secure_owner_definer,organisation_self',
  };
}

/** Expected facts after down() (and before up()): no function, no trigger, RLS exactly as before. */
export const ORGANISATION_TIME_ZONE_ABSENT_STATE: OrganisationTimeZoneState = {
  function_state: null,
  trigger_state: null,
  rls_state: 'true|true|rab_secure_owner',
  policies: 'organisation_secure_owner_definer,organisation_self',
};

export function organisationTimeZoneStateProblems(actual: OrganisationTimeZoneState | undefined, expected: OrganisationTimeZoneState): string[] {
  if (!actual) return ['state query returned no row'];
  const problems: string[] = [];
  for (const key of Object.keys(expected) as Array<keyof OrganisationTimeZoneState>) {
    if (actual[key] !== expected[key]) problems.push(`${key}: expected ${expected[key] ?? 'absent'}, found ${actual[key] ?? 'absent'}`);
  }
  return problems;
}
