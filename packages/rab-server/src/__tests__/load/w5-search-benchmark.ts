/**
 * Wave 5 lane DATA — search benchmark (EXPLAIN ANALYZE, before vs after) on a DISPOSABLE database seeded with
 * 50,000 staff / 50,000 shifts / 2,000 venues (docs/evidence/w5-data/benchmark). Not a Jest suite (lives under
 * __tests__/load, which the default run ignores). It drives the REAL SearchService (so the "after" SQL is exactly what
 * production sends) through a recording EntityManager bound to one crewflow_app transaction with the tenant GUCs set,
 * so RLS is in force exactly as at runtime. The "before" queries are the pre-wave-5 ILIKE SQL, verbatim.
 *
 * Usage (lane DB only — refuses without the disposable marker):
 *   BENCH_DATABASE_URL=postgres://crewflow_app:...@127.0.0.1:15463/rab BENCH_ORG=… BENCH_WS=… BENCH_OWNER=… \
 *   node node_modules/ts-node/dist/bin.js --transpile-only -P packages/rab-server/tsconfig.app.json \
 *     packages/rab-server/src/__tests__/load/w5-search-benchmark.ts
 */
import 'reflect-metadata';
import { Client } from 'pg';

import { SearchService } from '../../modules/search/services/search.service';

const RUNS = 7;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

async function main(): Promise<void> {
  const url = process.env.BENCH_DATABASE_URL;
  const [org, ws, owner] = [process.env.BENCH_ORG, process.env.BENCH_WS, process.env.BENCH_OWNER];
  if (!url || !org || !ws || !owner) throw new Error('BENCH_DATABASE_URL, BENCH_ORG, BENCH_WS, BENCH_OWNER are required');
  const client = new Client({ connectionString: url });
  await client.connect();
  const [{ marker }] = (await client.query(`SELECT current_setting('crewflow.disposable_test_database', true) AS marker`)).rows;
  if (marker !== 'true') throw new Error('refusing: not a disposable test database');
  const [{ role }] = (await client.query('SELECT current_user AS role')).rows;

  await client.query('BEGIN');
  await client.query(
    `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true),
            set_config('rab.role', 'manager', true), set_config('search_path', 'core', true)`,
    [org, ws, owner],
  );

  const out: string[] = [`role=${role} runs=${RUNS} (median execution ms of EXPLAIN ANALYZE)`, ''];
  async function explain(label: string, sql: string, params: unknown[], jit: 'on' | 'off'): Promise<{ ms: number; rows: number; nodes: string }> {
    await client.query(`SELECT set_config('jit', $1, true)`, [jit]);
    const times: number[] = [];
    let plan: any = null;
    for (let i = 0; i < RUNS; i++) {
      const res = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
      plan = res.rows[0]['QUERY PLAN'][0];
      times.push(plan['Execution Time']);
    }
    const text = (await client.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params)).rows.map((r) => r['QUERY PLAN']).join('\n');
    const nodes = [...new Set([...text.matchAll(/(Seq Scan|Bitmap Index Scan|Index Scan|Index Only Scan|Parallel Seq Scan) on (\S+)/g)].map((m) => `${m[1]} ${m[2]}`))].join('; ');
    out.push(`### ${label}`, text, '');
    return { ms: median(times), rows: plan.Plan['Actual Rows'], nodes };
  }

  // ---------------------------------------------------------------- BEFORE (pre-wave-5 SQL, verbatim)
  const beforeStaff = `SELECT sp.id, u.first_name, u.last_name
         FROM staff_profile sp
         JOIN core."user" u ON u.id = sp.user_id
        WHERE (u.first_name ILIKE $1 OR u.last_name ILIKE $1 OR u.email::text ILIKE $1 OR sp.staff_ref ILIKE $1)
          AND sp.workspace_id = $2
        ORDER BY u.first_name ASC
        LIMIT $3`;
  const beforeVenue = `SELECT id, name FROM venue WHERE name ILIKE $1 AND workspace_id = $2 ORDER BY name ASC LIMIT $3`;
  const beforeShift = `SELECT s.id, v.name AS venue_name, s.starts_at FROM shift s JOIN venue v ON v.id = s.venue_id
        WHERE v.name ILIKE $1 AND s.workspace_id = $2 ORDER BY s.starts_at DESC LIMIT $3`;

  // ---------------------------------------------------------------- AFTER (the real SearchService SQL)
  const captured: Array<{ sql: string; params: unknown[] }> = [];
  const recordingManager = { query: async (sql: string, params: unknown[]) => { captured.push({ sql, params }); return []; } };
  const service = new SearchService(
    { runInTenantContext: async (_ctx: unknown, fn: (m: unknown) => unknown) => fn(recordingManager) } as never,
    { resolveTx: async () => ({ kind: 'owner', ownerUserId: owner, delegated: false }) } as never,
    { userHasPermission: async () => true } as never,
  );
  (service as unknown as { memberAccess: unknown }).memberAccess = {
    resolveTx: async (_m: unknown, _c: unknown, object: string) => ({ object, restricted: false, canRead: true, visibleFields: new Set(), visibleProperties: new Set(), filters: [] }),
    isFieldVisible: () => true,
    rawWhere: () => ({ sql: 'TRUE', named: {}, positional: [] }),
  };
  async function afterSql(q: string): Promise<Record<string, { sql: string; params: unknown[] }>> {
    captured.length = 0;
    await service.search({ organisationId: org, workspaceId: ws, userId: owner } as never, { q, limit: 8 });
    // Order of execution in SearchService.search: staff, managers, shifts, offers, venues.
    const [staff, managers, shifts, offers, venues] = captured.filter((c) => !c.sql.includes('set_config'));
    return { staff: staff!, managers: managers!, shifts: shifts!, offers: offers!, venues: venues! };
  }

  const summary: string[] = [
    '| query | term | before ms (JIT default = as shipped) | before ms (JIT off) | before rows | after ms (as shipped: JIT off) | after rows | after scans |',
    '|---|---|---|---|---|---|---|---|',
  ];
  const terms = ['smith', 'zoe', 'STAFF 4217', 'mith', 'zzqx'];
  for (const term of terms) {
    const after = await afterSql(term);
    const like = `%${term}%`;
    const pairs: Array<[string, string, unknown[], { sql: string; params: unknown[] }]> = [
      ['staff', beforeStaff, [like, ws, 8], after.staff],
      ['venue', beforeVenue, [like, ws, 8], after.venues],
      ['shift', beforeShift, [like, ws, 8], after.shifts],
    ];
    for (const [kind, bSql, bParams, a] of pairs) {
      const b = await explain(`BEFORE ${kind} "${term}" (JIT default)`, bSql, bParams, 'on');
      const bOff = await explain(`BEFORE ${kind} "${term}" (JIT off)`, bSql, bParams, 'off');
      const x = await explain(`AFTER ${kind} "${term}"`, a.sql, a.params, 'off');
      summary.push(`| ${kind} | \`${term}\` | ${b.ms.toFixed(2)} | ${bOff.ms.toFixed(2)} | ${b.rows} | ${x.ms.toFixed(2)} | ${x.rows} | ${x.nodes} |`);
    }
  }
  await client.query('ROLLBACK');
  await client.end();
  // eslint-disable-next-line no-console
  console.log([...summary, '', ...out].join('\n'));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
