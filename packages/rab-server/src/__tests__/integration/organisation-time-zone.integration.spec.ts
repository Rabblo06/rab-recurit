import { createHash, randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { DataSource, QueryRunner } from 'typeorm';

import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { OrganisationTimeZoneGuard1786721610000 } from '../../database/typeorm/core/migrations/1786721610000-OrganisationTimeZoneGuard';
import {
  ORGANISATION_TIME_ZONE_ABSENT_STATE,
  ORGANISATION_TIME_ZONE_FUNCTION_SQL,
  ORGANISATION_TIME_ZONE_STATE_SQL,
  functionBodyOf,
  organisationTimeZoneExpectedState,
} from '../../database/typeorm/core/organisation-time-zone-sql';
import { readSecurityPosture } from '../../database/typeorm/core/security-posture';
import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';

/**
 * Organisation time zone, phase 1 (migration OrganisationTimeZoneGuard1786721610000; SQL draft for the owner's review).
 * Database-level behaviour only: the default, the validation trigger, RLS with and without a tenant context, and the
 * abuse cases (cross-tenant write, invalid value through the runtime login, tampering with the trigger as the runtime
 * login), plus the migration's own down/up round trip. The service-level rules (who may change the zone, what happens to
 * open payroll periods) are phase 2 and are not tested here.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

const VALID = ['Europe/London', 'America/New_York', 'Asia/Kolkata', 'America/Argentina/Buenos_Aires', 'Australia/Lord_Howe', 'UTC', 'Etc/GMT+5'];
const INVALID = [
  'Mars/Olympus_Mons', // not in the tz database
  'europe/london', // wrong case (the stored spelling must be canonical)
  'Europe/London ', // trailing space
  ' Europe/London',
  '',
  'UTC+3', // POSIX offset string: AT TIME ZONE accepts it, the rule does not
  '<+03>-3',
  'posix/Europe/London', // tz database copies, not zones
  'right/Europe/London',
  'posixrules',
  'Factory',
  'localtime',
  'Europe//London',
  "Europe/London'; DROP TABLE core.organisation; --",
  `Europe/${'A'.repeat(70)}`,
];

describeIfDb('organisation time zone (integration, OrganisationTimeZoneGuard1786721610000 applied)', () => {
  const { appUrl, adminUrl } = RUN ? resolveIntegrationTestDatabase(process.env) : { appUrl: '', adminUrl: '' };
  let admin: Client;
  let orgA: string;
  let orgB: string;

  async function connect(url: string): Promise<Client> {
    const c = new Client({ connectionString: url });
    await c.connect();
    return c;
  }

  /** Expects `sql` to fail with SQLSTATE `code`, leaving the surrounding transaction usable. */
  async function expectSqlState(c: Client, sql: string, params: unknown[], code: string): Promise<void> {
    await c.query('SAVEPOINT expect_fail');
    let error: { code?: string } | null = null;
    try {
      await c.query(sql, params);
    } catch (e) {
      error = e as { code?: string };
    }
    await c.query('ROLLBACK TO SAVEPOINT expect_fail');
    expect({ sql: sql.slice(0, 90), params, code: error?.code }).toEqual({ sql: sql.slice(0, 90), params, code });
  }

  const zoneOf = async (id: string): Promise<string> =>
    ((await admin.query(`SELECT timezone FROM core.organisation WHERE id = $1`, [id])).rows[0] as { timezone: string }).timezone;

  /**
   * Two runtime identities, both bound by RLS: `login` is TEST_DATABASE_URL as CI builds it (crewflow_owner in the
   * owner-login build, crewflow_app in a separated build); `crewflow_app` is the separated runtime role, reached by the
   * fixture superuser's SET LOCAL ROLE (which drops every superuser privilege), so it is exercised in every build.
   */
  type Runtime = 'login' | 'crewflow_app';
  const RUNTIMES: Runtime[] = ['login', 'crewflow_app'];

  /** A runtime session in a transaction bound to `organisationId` (or to nothing), always rolled back. */
  async function asRuntime<T>(runtime: Runtime, organisationId: string | null, fn: (c: Client) => Promise<T>): Promise<T> {
    const c = await connect(runtime === 'login' ? appUrl : adminUrl);
    try {
      await c.query('BEGIN');
      if (runtime === 'crewflow_app') await c.query('SET LOCAL ROLE crewflow_app');
      const [who] = (await c.query(`SELECT r.rolsuper AS su, r.rolbypassrls AS bypass FROM pg_roles r WHERE r.rolname = current_user`)).rows;
      expect(who).toEqual({ su: false, bypass: false });
      await c.query(
        `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', '', true), set_config('rab.user_id', '', true), set_config('rab.role', '', true)`,
        [organisationId ?? ''],
      );
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  }

  beforeAll(async () => {
    admin = await connect(adminUrl);
    const make = async (label: string): Promise<string> => {
      const slug = `tz-${label}-${randomUUID().slice(0, 8)}`;
      return ((await admin.query(`INSERT INTO core.organisation (name, slug) VALUES ($1, $2) RETURNING id`, [slug, slug])).rows[0] as { id: string }).id;
    };
    orgA = await make('a');
    orgB = await make('b');
  });

  afterAll(async () => {
    await admin?.end();
  });

  it('the migration left exactly the reviewed state: INVOKER function owned by rab_secure_owner, no EXECUTE grant, trigger enabled, RLS unchanged', async () => {
    const bodyHash = createHash('md5').update(`${functionBodyOf(ORGANISATION_TIME_ZONE_FUNCTION_SQL)}|`).digest('hex');
    await admin.query('BEGIN');
    let state: unknown;
    try {
      await admin.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
      [state] = (await admin.query(ORGANISATION_TIME_ZONE_STATE_SQL)).rows;
    } finally {
      await admin.query('ROLLBACK');
    }
    expect(state).toEqual(organisationTimeZoneExpectedState(bodyHash));
    const grants = (
      await admin.query(
        `SELECT r.rolname, has_function_privilege(r.oid, 'core.organisation_timezone_guard()'::regprocedure, 'EXECUTE') AS can
           FROM pg_roles r WHERE r.rolname IN ('crewflow', 'crewflow_app') ORDER BY 1`,
      )
    ).rows;
    expect(grants).toEqual([
      { rolname: 'crewflow', can: false },
      { rolname: 'crewflow_app', can: false },
    ]);
  });

  describe('default', () => {
    it('an organisation created without a zone stores Europe/London', async () => {
      expect(await zoneOf(orgA)).toBe('Europe/London');
      const [col] = (
        await admin.query(
          `SELECT is_nullable, column_default, data_type FROM information_schema.columns
            WHERE table_schema = 'core' AND table_name = 'organisation' AND column_name = 'timezone'`,
        )
      ).rows;
      expect(col).toEqual({ is_nullable: 'NO', column_default: "'Europe/London'::text", data_type: 'text' });
    });

    it('an INSERT as rab_secure_owner (the identity of the create_organisation / bootstrap definers) gets the default and passes the trigger', async () => {
      await admin.query('BEGIN');
      try {
        await admin.query('SET LOCAL ROLE rab_secure_owner');
        const slug = `tz-def-${randomUUID().slice(0, 8)}`;
        const [row] = (await admin.query(`INSERT INTO core.organisation (name, slug) VALUES ($1, $2) RETURNING timezone`, [slug, slug])).rows;
        expect(row).toEqual({ timezone: 'Europe/London' });
      } finally {
        await admin.query('ROLLBACK');
      }
    });
  });

  describe('validation (BEFORE INSERT OR UPDATE OF timezone)', () => {
    it.each(VALID)('accepts the IANA name %s on UPDATE and on INSERT', async (zone) => {
      await admin.query('BEGIN');
      try {
        await admin.query(`UPDATE core.organisation SET timezone = $2 WHERE id = $1`, [orgA, zone]);
        expect(((await admin.query(`SELECT timezone FROM core.organisation WHERE id = $1`, [orgA])).rows[0] as { timezone: string }).timezone).toBe(zone);
        const slug = `tz-ins-${randomUUID().slice(0, 8)}`;
        await admin.query(`INSERT INTO core.organisation (name, slug, timezone) VALUES ($1, $2, $3)`, [slug, slug, zone]);
      } finally {
        await admin.query('ROLLBACK');
      }
    });

    it('refuses every non-IANA value with 22023, on UPDATE and on INSERT, and stores nothing', async () => {
      await admin.query('BEGIN');
      try {
        for (const zone of INVALID) {
          await expectSqlState(admin, `UPDATE core.organisation SET timezone = $2 WHERE id = $1`, [orgA, zone], '22023');
          const slug = `tz-bad-${randomUUID().slice(0, 8)}`;
          await expectSqlState(admin, `INSERT INTO core.organisation (name, slug, timezone) VALUES ($1, $2, $3)`, [slug, slug, zone], '22023');
        }
      } finally {
        await admin.query('ROLLBACK');
      }
      expect(await zoneOf(orgA)).toBe('Europe/London');
    });

    it('NULL is refused by the NOT NULL constraint (23502), not silently defaulted', async () => {
      await admin.query('BEGIN');
      try {
        await expectSqlState(admin, `UPDATE core.organisation SET timezone = NULL WHERE id = $1`, [orgA], '23502');
      } finally {
        await admin.query('ROLLBACK');
      }
    });

    it('a zone the tz database no longer lists never blocks other writes to the row (no lock-out of security_version bumps)', async () => {
      // Simulates a stored zone that a later tz database dropped: written with the trigger off, all in one rolled-back transaction.
      await admin.query('BEGIN');
      try {
        await admin.query(`ALTER TABLE core.organisation DISABLE TRIGGER organisation_timezone_guard`);
        await admin.query(`UPDATE core.organisation SET timezone = 'Mars/Olympus_Mons' WHERE id = $1`, [orgA]);
        await admin.query(`ALTER TABLE core.organisation ENABLE TRIGGER organisation_timezone_guard`);
        await admin.query(`UPDATE core.organisation SET name = name || '.' WHERE id = $1`, [orgA]);
        await admin.query(`UPDATE core.organisation SET security_version = security_version + 1 WHERE id = $1`, [orgA]);
        await admin.query(`UPDATE core.organisation SET timezone = timezone WHERE id = $1`, [orgA]); // unchanged: not re-checked
        await expectSqlState(admin, `UPDATE core.organisation SET timezone = 'Mars/Valles' WHERE id = $1`, [orgA], '22023');
        await admin.query(`UPDATE core.organisation SET timezone = 'Europe/London' WHERE id = $1`, [orgA]); // a valid zone repairs it
      } finally {
        await admin.query('ROLLBACK');
      }
      expect(await zoneOf(orgA)).toBe('Europe/London');
    });
  });

  describe('RLS (core.organisation stays ENABLE + FORCE with organisation_self)', () => {
    it.each(RUNTIMES)('runtime %s with NO tenant context sees zero organisations and updates zero rows', async (runtime) => {
      await asRuntime(runtime, null, async (c) => {
        expect((await c.query(`SELECT id, timezone FROM core.organisation`)).rowCount).toBe(0);
        expect((await c.query(`SELECT timezone FROM core.organisation WHERE id = $1`, [orgA])).rowCount).toBe(0);
        expect((await c.query(`UPDATE core.organisation SET timezone = 'America/New_York' WHERE id = $1`, [orgA])).rowCount).toBe(0);
        expect((await c.query(`UPDATE core.organisation SET timezone = 'America/New_York'`)).rowCount).toBe(0);
      });
      expect(await zoneOf(orgA)).toBe('Europe/London');
    });

    it.each(RUNTIMES)('runtime %s bound to its own organisation sees exactly that row, even reading every row', async (runtime) => {
      await asRuntime(runtime, orgA, async (c) => {
        expect((await c.query(`SELECT id, timezone FROM core.organisation`)).rows).toEqual([{ id: orgA, timezone: 'Europe/London' }]);
      });
    });
  });

  describe('abuse cases', () => {
    it.each(RUNTIMES)("runtime %s bound to tenant A cannot read or change tenant B's zone (0 rows, B unchanged)", async (runtime) => {
      await asRuntime(runtime, orgA, async (c) => {
        expect((await c.query(`SELECT timezone FROM core.organisation WHERE id = $1`, [orgB])).rowCount).toBe(0);
        expect((await c.query(`UPDATE core.organisation SET timezone = 'Asia/Tokyo' WHERE id = $1`, [orgB])).rowCount).toBe(0);
      });
      expect(await zoneOf(orgB)).toBe('Europe/London');
    });

    it.each(RUNTIMES)('runtime %s cannot store an invalid zone in its own organisation either (the trigger binds every role)', async (runtime) => {
      await asRuntime(runtime, orgA, async (c) => {
        for (const zone of ['Mars/Olympus_Mons', 'UTC+3', 'europe/london', '']) {
          await expectSqlState(c, `UPDATE core.organisation SET timezone = $2 WHERE id = $1`, [orgA, zone], '22023');
        }
        // The valid path is open at the database layer (RLS limits it to the own row); WHO may change it is the service's rule.
        expect((await c.query(`UPDATE core.organisation SET timezone = 'America/New_York' WHERE id = $1`, [orgA])).rowCount).toBe(1);
      });
      expect(await zoneOf(orgA)).toBe('Europe/London');
    });

    it('crewflow_app (separated runtime role) cannot disable, drop or replace the guard, nor call its function', async () => {
      await asRuntime('crewflow_app', orgA, async (c) => {
        await expectSqlState(c, `ALTER TABLE core.organisation DISABLE TRIGGER organisation_timezone_guard`, [], '42501');
        await expectSqlState(c, `DROP TRIGGER organisation_timezone_guard ON core.organisation`, [], '42501');
        await expectSqlState(c, `DROP FUNCTION core.organisation_timezone_guard()`, [], '42501');
        await expectSqlState(
          c,
          `CREATE OR REPLACE FUNCTION core.organisation_timezone_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
          [],
          '42501',
        );
        await expectSqlState(c, `SELECT core.organisation_timezone_guard()`, [], '42501');
      });
      const [{ enabled }] = (
        await admin.query(`SELECT tgenabled::text AS enabled FROM pg_trigger WHERE tgrelid = 'core.organisation'::regclass AND tgname = 'organisation_timezone_guard'`)
      ).rows as Array<{ enabled: string }>;
      expect(enabled).toBe('O');
    });

    it('owner-login build: the runtime login inherits rab_secure_owner, so tampering is the owner-accepted G-02/G-03 class (detected, not prevented)', async () => {
      // Recorded, not hidden: an injected statement as crewflow_owner could DISABLE this trigger exactly as it could
      // ALTER TABLE ... NO FORCE (preauth-force-sql.ts, "WHAT IT DOES NOT DO"). The semantic posture monitor would report
      // the trigger line (enabled=O) changing or disappearing; organisation-time-zone-sql.spec.ts pins that line.
      const c = await connect(appUrl);
      try {
        const [row] = (await c.query(`SELECT current_user::text AS u, pg_has_role(current_user, 'rab_secure_owner', 'USAGE') AS member`)).rows as Array<{ u: string; member: boolean }>;
        if (row!.member) expect(row!.u).toBe('crewflow_owner');
        else expect(row!.u).not.toBe('crewflow_owner');
      } finally {
        await c.end();
      }
    });
  });

  describe('migration round trip (one transaction, always rolled back)', () => {
    async function inMigrationTx(fn: (qr: QueryRunner) => Promise<void>): Promise<void> {
      const ds = new DataSource({ type: 'postgres', url: adminUrl, entities: [], logging: false });
      await ds.initialize();
      const qr = ds.createQueryRunner();
      try {
        await qr.startTransaction();
        try {
          await fn(qr);
        } finally {
          await qr.rollbackTransaction();
        }
      } finally {
        await qr.release();
        await ds.destroy();
      }
    }

    it('down() removes the trigger and the function and nothing else; up() restores the exact state; zero posture drift', async () => {
      const posture = await readSecurityPosture(adminUrl);
      await inMigrationTx(async (qr) => {
        const migration = new OrganisationTimeZoneGuard1786721610000();
        await migration.down(qr);
        await qr.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
        expect((await qr.query(ORGANISATION_TIME_ZONE_STATE_SQL))[0]).toEqual(ORGANISATION_TIME_ZONE_ABSENT_STATE);
        // Without the guard the column takes any text again (what main allows today) ...
        await qr.query(`UPDATE core.organisation SET timezone = 'Mars/Olympus_Mons' WHERE id = $1`, [orgB]);
        // ... and up() then refuses to install it over an invalid stored zone (fail closed, nothing applied).
        await qr.query('SAVEPOINT up_refused');
        await expect(migration.up(qr)).rejects.toThrow(/1 organisation\(s\) store a time zone that is not a valid IANA name/);
        await qr.query('ROLLBACK TO SAVEPOINT up_refused');
        await qr.query(`UPDATE core.organisation SET timezone = 'Europe/London' WHERE id = $1`, [orgB]);
        await migration.up(qr);
        const bodyHash = createHash('md5').update(`${functionBodyOf(ORGANISATION_TIME_ZONE_FUNCTION_SQL)}|`).digest('hex');
        await qr.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
        expect((await qr.query(ORGANISATION_TIME_ZONE_STATE_SQL))[0]).toEqual(organisationTimeZoneExpectedState(bodyHash));
      });
      expect(await readSecurityPosture(adminUrl)).toEqual(posture);
      expect(await zoneOf(orgB)).toBe('Europe/London');
    });
  });
});
