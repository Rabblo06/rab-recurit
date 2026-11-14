import { Client } from 'pg';

import * as invariants from '../../database/typeorm/core/secure-owner-invariants';
import {
  R4_CREWFLOW_TABLES_REACHED_BY_SECURE_DEFINERS,
  R4_PHASE_D_TRIGGER_PAIRS,
  REVIEWED_DYNAMIC_SQL_SECURE_DEFINERS,
  secureOwnerInvariantViolations,
} from '../../database/typeorm/core/secure-owner-invariants';
import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';

/**
 * Phase D wave 2 — owner condition on Phase 0b R4 ("only the four exact trigger-function/table pairs are exempt; a
 * failing-first regression test must prove an unrelated protected-table rab_secure_owner definer is still rejected").
 *
 * Runs on the disposable test database AS IT IS (the C1 schema, no Phase D SQL needed; also valid once the Phase D
 * migrations exist): every probe object is created by the bootstrap superuser inside a transaction that is ALWAYS rolled
 * back, handed to rab_secure_owner, and the invariant check is asserted to report exactly the expected new line(s) over
 * the live baseline. Nothing is committed; no migration runs.
 *
 * Proves secure-owner-invariants.ts still rejects:
 *   (a) an unrelated rab_secure_owner function reading a protected crewflow-owned business table — each of the four
 *       exempt tables and two ordinary ones — whether it is a DEFINER or an INVOKER helper a definer would run as
 *       rab_secure_owner, and even when it carries the exact `TG_TABLE_NAME IS DISTINCT FROM '<table>'` literal;
 *   (b) a function with the SAME NAME as one of the four exempt trigger functions that reads another table, reads its
 *       own table outside the binding literal, lives in another schema, is an overload, or is attached as a trigger to a
 *       table / under a trigger name other than its reviewed ones;
 *   (c) a new dynamic-SQL function (definer or a rab_secure_owner invoker), in any schema, any casing, or as an overload
 *       of the one reviewed dynamic-SQL definer;
 * and that the exemption is exactly the four pairs, never table-wide.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(120_000);

const PAIRS = [
  { fn: 'worker_dispatch_pointer_email_trg', table: 'email_outbox' },
  { fn: 'worker_dispatch_pointer_push_trg', table: 'push_delivery' },
  { fn: 'worker_dispatch_pointer_realtime_trg', table: 'realtime_event' },
  { fn: 'worker_dispatch_pointer_statement_trg', table: 'payroll_record' },
] as const;
const binding = (table: string) => `TG_TABLE_NAME IS DISTINCT FROM '${table}'`;
const r4Added = (table: string) => `r4-table-added|${table}|not in the reviewed list`;
const dynAdded = (fn: string) => `dynamic-sql-definer-added|${fn}|not in the reviewed list`;

describe('Phase D R4: the exemption is exactly the four reviewed (function, own table) pairs (offline)', () => {
  it('the pair list is exactly the four pairs', () => {
    expect(R4_PHASE_D_TRIGGER_PAIRS).toEqual(PAIRS);
  });

  it('no table-wide exemption exists: none of the four tables is in the frozen R4 list, and no other R4 export exists', () => {
    for (const p of PAIRS) expect(R4_CREWFLOW_TABLES_REACHED_BY_SECURE_DEFINERS).not.toContain(p.table);
    expect(Object.keys(invariants).filter((k) => /R4/.test(k)).sort()).toEqual(
      ['R4_CREWFLOW_TABLES_REACHED_BY_SECURE_DEFINERS', 'R4_PHASE_D_MISSING_PAIRS_SQL', 'R4_PHASE_D_TRIGGER_PAIRS', 'R4_TABLES_SQL'].sort(),
    );
    expect(REVIEWED_DYNAMIC_SQL_SECURE_DEFINERS).toEqual(['core.provision_workspace_schema(pg_catalog.uuid)']);
  });
});

describeIfDb('Phase D R4 regression: secure-owner invariants still reject (rolled back on the live test database)', () => {
  const { adminUrl } = RUN ? resolveIntegrationTestDatabase(process.env) : ({} as never);
  let baseline: string[] = [];

  /** New violations a probe adds over the live baseline, in a transaction that is always rolled back. */
  async function added(setup: (c: Client) => Promise<void>): Promise<string[]> {
    const c = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 15_000 });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL lock_timeout = '5s'`);
      await setup(c);
      const now = await secureOwnerInvariantViolations(async (sql) => (await c.query(sql)).rows);
      return now.filter((v) => !baseline.includes(v)).sort();
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  }

  /** CREATE OR REPLACE (works whether or not the Phase D function exists), then hand it to rab_secure_owner. */
  async function secureFn(c: Client, signature: string, opts: { returns: string; body: string; definer?: boolean; lang?: string }) {
    await c.query(`CREATE OR REPLACE FUNCTION ${signature} RETURNS ${opts.returns} LANGUAGE ${opts.lang ?? 'plpgsql'}
                     ${opts.definer === false ? 'SECURITY INVOKER' : 'SECURITY DEFINER'} SET search_path = pg_catalog, pg_temp
                     AS $probe$ ${opts.body} $probe$`);
    await c.query(`ALTER FUNCTION ${signature} OWNER TO rab_secure_owner`);
  }

  beforeAll(async () => {
    const c = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 15_000 });
    await c.connect();
    try {
      if (!(await c.query('SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user')).rows[0].rolsuper) {
        throw new Error('this suite needs the disposable database bootstrap superuser as TEST_DATABASE_URL_UNPOOLED');
      }
      baseline = await secureOwnerInvariantViolations(async (sql) => (await c.query(sql)).rows);
    } finally {
      await c.end();
    }
  });

  it('precondition: the live catalog holds every invariant (so each probe below is the only change)', () => {
    expect(baseline).toEqual([]);
  });

  describe('(a) an unrelated rab_secure_owner function reading a protected crewflow-owned table is rejected', () => {
    it.each([...PAIRS.map((p) => p.table), 'shift', 'venue'])('definer reading core.%s', async (table) => {
      expect(
        await added((c) => secureFn(c, 'core.pd_r4a_probe()', { returns: 'integer', lang: 'sql', body: `SELECT count(*)::int FROM core.${table}` })),
      ).toEqual([r4Added(table)]);
    });

    it.each(PAIRS.map((p) => p.table))('an unrelated definer that also carries the exact binding literal for %s is still rejected', async (table) => {
      expect(
        await added((c) =>
          secureFn(c, 'core.pd_r4a_probe()', {
            returns: 'trigger',
            body: `BEGIN IF ${binding(table)} THEN RAISE EXCEPTION 'probe'; END IF; PERFORM count(*) FROM core.${table}; RETURN NULL; END`,
          }),
        ),
      ).toEqual([r4Added(table)]);
    });

    it('an INVOKER helper owned by rab_secure_owner (runs as rab_secure_owner when a definer calls it) reading core.shift', async () => {
      expect(
        await added((c) => secureFn(c, 'core.pd_r4a_helper()', { returns: 'integer', lang: 'sql', definer: false, body: 'SELECT count(*)::int FROM core.shift' })),
      ).toEqual([r4Added('shift')]);
    });
  });

  describe('(b) a function with the SAME NAME as an exempt trigger function gains nothing from the name', () => {
    const trgBody = (own: string, extra = '') => `BEGIN IF ${binding(own)} THEN RAISE EXCEPTION 'probe'; END IF; ${extra} RETURN NULL; END`;

    it.each(PAIRS.map((p, i) => [p.fn, p.table, PAIRS[(i + 1) % PAIRS.length]!.table] as const))(
      'core.%s() bound to %s but reading core.%s',
      async (fn, own, other) => {
        expect(await added((c) => secureFn(c, `core.${fn}()`, { returns: 'trigger', body: trgBody(own, `PERFORM count(*) FROM core.${other};`) }))).toEqual([
          r4Added(other),
        ]);
      },
    );

    it.each(PAIRS.map((p) => [p.fn, p.table] as const))('core.%s() reading core.shift', async (fn, own) => {
      expect(await added((c) => secureFn(c, `core.${fn}()`, { returns: 'trigger', body: trgBody(own, 'PERFORM count(*) FROM core.shift;') }))).toEqual([
        r4Added('shift'),
      ]);
    });

    it.each(PAIRS.map((p) => [p.fn, p.table] as const))('core.%s() reading its OWN table %s outside the binding literal', async (fn, own) => {
      expect(await added((c) => secureFn(c, `core.${fn}()`, { returns: 'trigger', body: trgBody(own, `PERFORM count(*) FROM core.${own};`) }))).toEqual([
        r4Added(own),
      ]);
    });

    it.each(PAIRS.map((p) => [p.fn, p.table] as const))('public.%s() (same name, another schema) reading %s', async (fn, own) => {
      expect(await added((c) => secureFn(c, `public.${fn}()`, { returns: 'trigger', body: trgBody(own, `PERFORM count(*) FROM core.${own};`) }))).toEqual([
        r4Added(own),
      ]);
    });

    it.each(PAIRS.map((p) => [p.fn, p.table] as const))('core.%s(integer) (same name, an overload) reading %s', async (fn, own) => {
      expect(
        await added((c) => secureFn(c, `core.${fn}(integer)`, { returns: 'integer', lang: 'sql', body: `SELECT count(*)::int FROM core.${own}` })),
      ).toEqual([r4Added(own)]);
    });

    it.each(PAIRS.map((p, i) => [p.fn, p.table, PAIRS[(i + 1) % PAIRS.length]!.table] as const))(
      'core.%s() (binding %s, no reads) attached to core.%s under that table\'s reviewed trigger name',
      async (fn, own, other) => {
        const trg = other === 'payroll_record' ? 'payroll_record_statement_pointer_ins' : `${other}_dispatch_pointer_ins`;
        const got = await added(async (c) => {
          await secureFn(c, `core.${fn}()`, { returns: 'trigger', body: trgBody(own) });
          await c.query(`DROP TRIGGER IF EXISTS ${trg} ON core.${other}`);
          await c.query(`CREATE TRIGGER ${trg} AFTER INSERT ON core.${other} FOR EACH ROW EXECUTE FUNCTION core.${fn}()`);
        });
        expect(got).toEqual([
          `secure-trigger-attachment-added|core.${other}.${trg}|core.${fn}() fires as rab_secure_owner on a table it does not own; not in the reviewed list`,
        ]);
      },
    );

    it.each(PAIRS.map((p) => [p.fn, p.table] as const))('core.%s() attached to its own table %s under an unreviewed trigger name', async (fn, own) => {
      const got = await added(async (c) => {
        await secureFn(c, `core.${fn}()`, { returns: 'trigger', body: trgBody(own) });
        await c.query(`CREATE TRIGGER pd_r4_unreviewed AFTER INSERT ON core.${own} FOR EACH ROW EXECUTE FUNCTION core.${fn}()`);
      });
      expect(got).toEqual([
        `secure-trigger-attachment-added|core.${own}.pd_r4_unreviewed|core.${fn}() fires as rab_secure_owner on a table it does not own; not in the reviewed list`,
      ]);
    });

    it.each(PAIRS.map((p) => [p.fn, p.table] as const))(
      'public.%s() (same name, another schema) attached to its pair table %s under the reviewed trigger name',
      async (fn, own) => {
        const trg = own === 'payroll_record' ? 'payroll_record_statement_pointer_ins' : `${own}_dispatch_pointer_ins`;
        const got = await added(async (c) => {
          await secureFn(c, `public.${fn}()`, { returns: 'trigger', body: trgBody(own) });
          await c.query(`DROP TRIGGER IF EXISTS ${trg} ON core.${own}`);
          await c.query(`CREATE TRIGGER ${trg} AFTER INSERT ON core.${own} FOR EACH ROW EXECUTE FUNCTION public.${fn}()`);
        });
        // Two independent rejections: the attachment (not a reviewed core. function) and R4 (outside core the binding
        // literal is not exempt, so the body's mention of its table counts).
        expect(got).toEqual([
          r4Added(own),
          `secure-trigger-attachment-added|core.${own}.${trg}|public.${fn}() fires as rab_secure_owner on a table it does not own; not in the reviewed list`,
        ]);
      },
    );
  });

  describe('(c) a new dynamic-SQL function is rejected', () => {
    it.each([
      ['core.pd_dyn_probe()', `BEGIN EXECUTE 'SELECT 1'; RETURN 1; END`, true],
      ['core.pd_dyn_probe()', `BEGIN RETURN QUERY execute pg_catalog.format('SELECT %s', 1); END`, true],
      ['public.pd_dyn_probe()', `BEGIN EXECUTE 'SELECT 1'; RETURN 1; END`, true],
      ['core.provision_workspace_schema(pg_catalog.text)', `BEGIN EXECUTE 'SELECT 1'; RETURN 1; END`, true],
      ['core.pd_dyn_helper()', `BEGIN EXECUTE 'SELECT 1'; RETURN 1; END`, false],
    ] as const)('%s: %s (definer=%s)', async (label, body, definer) => {
      const signature = label.replace('pg_catalog.text', 'text');
      const returns = body.includes('RETURN QUERY') ? 'SETOF integer' : 'integer';
      expect(await added((c) => secureFn(c, signature, { returns, body, definer }))).toEqual([dynAdded(label)]);
    });
  });
});
