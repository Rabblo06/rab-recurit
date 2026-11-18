import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SEMANTIC_GOLDEN_PG16 } from '../../posture-drift/semantic-golden.pg16';
import { SEMANTIC_GOLDEN_PG17 } from '../../posture-drift/semantic-golden.pg17';
import { SEMANTIC_GOLDEN_PG18 } from '../../posture-drift/semantic-golden.pg18';
import { SEMANTIC_OBJECT_SQL } from '../../posture-drift/semantic-posture';
import {
  functionBodyOf,
  ORGANISATION_TIME_ZONE_DOWN_SQL,
  ORGANISATION_TIME_ZONE_FUNCTION_SQL,
  ORGANISATION_TIME_ZONE_INVALID_ROWS_SQL,
  ORGANISATION_TIME_ZONE_TZDATA_SQL,
  ORGANISATION_TIME_ZONE_UP_SQL,
  organisationTimeZoneExpectedState,
  validTimeZonePredicate,
} from './organisation-time-zone-sql';

/**
 * Static review of OrganisationTimeZoneGuard1786721610000's SQL (draft for the owner's review). The behaviour is proven on a
 * real database in organisation-time-zone.integration.spec.ts.
 */
describe('organisation time zone guard SQL (1786721610000)', () => {
  const bodyHash = createHash('md5').update(`${functionBodyOf(ORGANISATION_TIME_ZONE_FUNCTION_SQL)}|`).digest('hex');
  const all = [
    ORGANISATION_TIME_ZONE_FUNCTION_SQL,
    ...ORGANISATION_TIME_ZONE_UP_SQL,
    ...ORGANISATION_TIME_ZONE_DOWN_SQL,
    ORGANISATION_TIME_ZONE_INVALID_ROWS_SQL,
    ORGANISATION_TIME_ZONE_TZDATA_SQL,
  ];

  it('adds no column, policy or grant, and never touches RLS', () => {
    for (const sql of all) {
      expect(sql).not.toMatch(/\bADD\s+COLUMN\b|\bDROP\s+COLUMN\b|\bALTER\s+COLUMN\b/i);
      expect(sql).not.toMatch(/\bPOLICY\b|ROW\s+LEVEL\s+SECURITY/i);
      expect(sql).not.toMatch(/\bGRANT\b/i);
    }
  });

  it('the trigger function is SECURITY INVOKER with a pinned search_path, owned by rab_secure_owner, EXECUTE revoked from PUBLIC', () => {
    expect(ORGANISATION_TIME_ZONE_FUNCTION_SQL.startsWith('CREATE FUNCTION core.organisation_timezone_guard()\nRETURNS trigger\nLANGUAGE plpgsql\n')).toBe(true);
    expect(ORGANISATION_TIME_ZONE_FUNCTION_SQL).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(ORGANISATION_TIME_ZONE_FUNCTION_SQL).toContain('SET search_path = pg_catalog, pg_temp');
    expect(ORGANISATION_TIME_ZONE_FUNCTION_SQL).toContain(`RAISE EXCEPTION 'core.organisation.timezone must be an IANA time zone name' USING ERRCODE = '22023'`);
    expect(ORGANISATION_TIME_ZONE_UP_SQL).toEqual([
      'ALTER FUNCTION core.organisation_timezone_guard() OWNER TO rab_secure_owner',
      'REVOKE ALL ON FUNCTION core.organisation_timezone_guard() FROM PUBLIC',
      'CREATE TRIGGER organisation_timezone_guard\n  BEFORE INSERT OR UPDATE OF timezone ON core.organisation\n  FOR EACH ROW EXECUTE FUNCTION core.organisation_timezone_guard()',
    ]);
  });

  it('the trigger and the pre-check use the same rule text (one source)', () => {
    expect(ORGANISATION_TIME_ZONE_FUNCTION_SQL).toContain(`IF NOT ${validTimeZonePredicate('NEW.timezone')} THEN`);
    expect(ORGANISATION_TIME_ZONE_INVALID_ROWS_SQL).toContain(`WHERE NOT ${validTimeZonePredicate('o.timezone')}`);
    expect(ORGANISATION_TIME_ZONE_TZDATA_SQL).toContain(`SELECT ${validTimeZonePredicate(`'Europe/London'::text`)} AS london`);
    expect(ORGANISATION_TIME_ZONE_TZDATA_SQL).toContain(`${validTimeZonePredicate(`'UTC'::text`)} AS utc`);
    expect(ORGANISATION_TIME_ZONE_TZDATA_SQL).not.toMatch(/FROM\s+core\./); // reads no table
  });

  it('the invalid-zone pre-check counts DISTINCT zones (the tz directory is read once per zone, not per organisation)', () => {
    expect(ORGANISATION_TIME_ZONE_INVALID_ROWS_SQL).toContain('FROM (SELECT DISTINCT d.timezone FROM core.organisation d) o');
    expect(ORGANISATION_TIME_ZONE_INVALID_ROWS_SQL.match(/core\.organisation/g)).toHaveLength(1);
  });

  it('up() runs the tz-database check before the role switch and before anything is created (DB review F1)', () => {
    const source = readFileSync(join(__dirname, 'migrations', '1786721610000-OrganisationTimeZoneGuard.ts'), 'utf8');
    const up = source.slice(source.indexOf('public async up('), source.indexOf('public async down('));
    const at = (needle: string) => up.indexOf(needle);
    expect(at('ORGANISATION_TIME_ZONE_TZDATA_SQL')).toBeGreaterThan(0);
    expect(at('ORGANISATION_TIME_ZONE_TZDATA_SQL')).toBeLessThan(at("'SET LOCAL ROLE rab_secure_owner'"));
    expect(at("'SET LOCAL ROLE rab_secure_owner'")).toBeLessThan(at('ORGANISATION_TIME_ZONE_FUNCTION_SQL'));
    expect(up).toMatch(/tz\?\.london !== true \|\| tz\?\.utc !== true/);
    expect(validTimeZonePredicate('x')).toContain('pg_catalog.pg_timezone_names');
  });

  it('down() drops exactly the trigger and then the function (the column and its default stay)', () => {
    expect(ORGANISATION_TIME_ZONE_DOWN_SQL).toEqual([
      'DROP TRIGGER IF EXISTS organisation_timezone_guard ON core.organisation',
      'DROP FUNCTION IF EXISTS core.organisation_timezone_guard()',
    ]);
  });

  it('the semantic posture goldens (PG16/17/18) carry this exact body hash and the trigger line', () => {
    const fnLine =
      'function|organisation_timezone_guard()|owner=rab_secure_owner|definer=false|lang=plpgsql|vol=v|strict=false|leakproof=false|' +
      `config=search_path=pg_catalog, pg_temp|body=${bodyHash}`;
    // DB review F5: the trigger line carries the hash of its definition (timing, events, UPDATE OF columns, WHEN, arguments).
    const trgLine = /^trigger\|organisation\|organisation_timezone_guard\|enabled=O\|core\.organisation_timezone_guard\(\)\|def=[0-9a-f]{32}$/;
    const trgLines = [SEMANTIC_GOLDEN_PG16, SEMANTIC_GOLDEN_PG17, SEMANTIC_GOLDEN_PG18].map((golden) => {
      expect(golden).toContain(fnLine);
      const lines = golden.filter((l) => trgLine.test(l));
      expect(lines).toHaveLength(1);
      return lines[0];
    });
    expect(new Set(trgLines).size).toBe(1); // same definition on every major
    // The hash covers the definition, never the table or schema name (workspace copies stay comparable).
    for (const part of ['t.tgtype::text', 't.tgattr::pg_catalog.int2[]', 'pg_catalog.pg_get_expr(t.tgqual, t.tgrelid)', 't.tgdeferrable', 't.tginitdeferred', "pg_catalog.encode(t.tgargs, 'hex')", 't.tgoldtable', 't.tgnewtable']) {
      expect(SEMANTIC_OBJECT_SQL).toContain(part);
    }
    expect(SEMANTIC_OBJECT_SQL).not.toContain('pg_get_triggerdef');
    expect(organisationTimeZoneExpectedState(bodyHash).function_state).toContain(`body=${bodyHash}`);
  });

  it('the security posture golden lists the function as rab_secure_owner-owned with no EXECUTE for crewflow / crewflow_app', () => {
    const golden = readFileSync(join(__dirname, 'security-posture.golden.txt'), 'utf8').split('\n');
    expect(golden).toEqual(
      expect.arrayContaining([
        'execute|organisation_timezone_guard()|crewflow_app|false',
        'execute|organisation_timezone_guard()|crewflow|false',
        'owner|function|organisation_timezone_guard()|rab_secure_owner|definer=false',
      ]),
    );
  });

  it('the migration file holds no SQL of its own beyond the role switch and search_path pin (everything reviewable is in this module)', () => {
    const source = readFileSync(join(__dirname, 'migrations', '1786721610000-OrganisationTimeZoneGuard.ts'), 'utf8');
    const literals = [...source.matchAll(/queryRunner\.query\(\s*(['`])([\s\S]*?)\1/g)].map((m) => m[2]);
    expect(literals.sort()).toEqual(['RESET ROLE', 'RESET ROLE', 'SET LOCAL ROLE rab_secure_owner', 'SET LOCAL ROLE rab_secure_owner', "SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)"].sort());
  });
});
