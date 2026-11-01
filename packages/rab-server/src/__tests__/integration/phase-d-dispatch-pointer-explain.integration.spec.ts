import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

/**
 * Phase D (D1) — EXPLAIN (ANALYZE, BUFFERS) of the global claim on ≥ 500,000 synthetic pointers: the pending path, the
 * retry path (re-timed by a release / a trigger, claim_count > 0, token cleared) and the expired-lease path (token set,
 * due_at in the past), separately, plus wall time of the real definer call.
 *
 * Opt-in: PHASE_D_SQL_APPROVED=true AND PHASE_D_EXPLAIN=true, on a DISPOSABLE database
 * that carries the approved migrations (bootstrap superuser URL in TEST_DATABASE_URL_UNPOOLED). Everything runs inside ONE
 * transaction that is always rolled back: no pointer, organisation or plan setting survives. Plans are printed (for
 * docs/plans/PHASE-D-SQL-GATE.md / the lead's performance report) and asserted only on shape: index scans on worker_dispatch_pointer_fair_idx,
 * no sequential scan of the pointer table, bounded rows per step. Absolute timings are recorded, never asserted.
 *
 * Distribution (per queue 'email'): 200 organisations; 500,000 pointers = 350,000 not due (future due_at: PROCESSING /
 * QUEUED leases), 100,000 pending (due now, no token), 30,000 retry (due, claim_count 1..4, no token), 20,000 expired
 * leases (due in the past, token set). One organisation holds 40 % of every class (skew, the fairness case).
 */
const RUN = process.env.PHASE_D_SQL_APPROVED === 'true' && process.env.PHASE_D_EXPLAIN === 'true' && Boolean(process.env.TEST_DATABASE_URL_UNPOOLED);
const describeIfApproved = RUN ? describe : describe.skip;

jest.setTimeout(30 * 60 * 1000);

describeIfApproved('Phase D claim plans on 500k pointers (EXPLAIN ANALYZE; needs the approved migrations)', () => {
  let admin: Client;
  const plans: Record<string, string> = {};

  const explain = async (label: string, sql: string, params: unknown[] = []) => {
    const { rows } = await admin.query(`EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT TEXT) ${sql}`, params);
    plans[label] = rows.map((r: Record<string, string>) => r['QUERY PLAN']).join('\n');
    // eslint-disable-next-line no-console
    console.log(`--- ${label}\n${plans[label]}`);
    return plans[label]!;
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.TEST_DATABASE_URL_UNPOOLED! });
    await admin.connect();
    await admin.query('BEGIN');
    const tag = randomUUID().slice(0, 8);
    await admin.query(
      `CREATE TEMP TABLE pd_orgs ON COMMIT DROP AS
       WITH o AS (INSERT INTO core.organisation(name, slug) SELECT 'pdx-' || $1 || '-' || g, 'pdx-' || $1 || '-' || g FROM generate_series(1, 200) g RETURNING id)
       SELECT id, row_number() OVER (ORDER BY id) AS n FROM o`,
      [tag],
    );
    await admin.query('GRANT SELECT ON pd_orgs TO rab_secure_owner');
    // org(i): 40 % of rows go to organisation 1, the rest spread over 2..200.
    const org = `(SELECT id FROM pd_orgs WHERE n = CASE WHEN g % 5 < 2 THEN 1 ELSE 2 + (g % 199) END)`;
    await admin.query(`SET LOCAL ROLE rab_secure_owner`);
    await admin.query(`INSERT INTO core.worker_dispatch_pointer (queue, subject_id, organisation_id, due_at)
                       SELECT 'email', gen_random_uuid(), ${org}, now() + make_interval(secs => 60 + g % 600) FROM generate_series(1, 350000) g`);
    await admin.query(`INSERT INTO core.worker_dispatch_pointer (queue, subject_id, organisation_id, due_at)
                       SELECT 'email', gen_random_uuid(), ${org}, now() - make_interval(secs => g % 300) FROM generate_series(1, 100000) g`);
    await admin.query(`INSERT INTO core.worker_dispatch_pointer (queue, subject_id, organisation_id, due_at, claim_count)
                       SELECT 'email', gen_random_uuid(), ${org}, now() - make_interval(secs => g % 120), 1 + g % 4 FROM generate_series(1, 30000) g`);
    await admin.query(`INSERT INTO core.worker_dispatch_pointer (queue, subject_id, organisation_id, due_at, claim_token, claim_count, claimed_at)
                       SELECT 'email', gen_random_uuid(), ${org}, now() - make_interval(secs => 1 + g % 60), gen_random_uuid(), 1, now() - interval '2 minutes'
                         FROM generate_series(1, 20000) g`);
    await admin.query('RESET ROLE');
    await admin.query('ANALYZE core.worker_dispatch_pointer');
  });

  afterAll(async () => {
    await admin?.query('ROLLBACK').catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  it('loose-scan step: one index descent per organisation (Index Scan / Index Only Scan on the fair index, Limit 1)', async () => {
    await admin.query('SET LOCAL ROLE rab_secure_owner');
    const plan = await explain(
      'loose-scan step',
      `SELECT p.organisation_id, p.due_at FROM core.worker_dispatch_pointer p WHERE p.queue = 'email' AND p.organisation_id > $1 ORDER BY p.organisation_id, p.due_at LIMIT 1`,
      [randomUUID()],
    );
    await admin.query('RESET ROLE');
    expect(plan).toMatch(/Index (Only )?Scan using worker_dispatch_pointer_fair_idx/);
    expect(plan).not.toMatch(/Seq Scan on (core\.)?worker_dispatch_pointer/);
  });

  it.each([
    ['pending path (due now, no token)', `p.claim_token IS NULL AND p.claim_count = 0`],
    ['retry path (due, claim_count > 0, token cleared)', `p.claim_token IS NULL AND p.claim_count > 0`],
    ['expired-lease path (token set, due in the past)', `p.claim_token IS NOT NULL`],
  ])('%s: per-organisation candidates + SKIP LOCKED pick + UPDATE use the fair index, bounded', async (label, extra) => {
    await admin.query('SAVEPOINT s');
    await admin.query('SET LOCAL ROLE rab_secure_owner');
    const orgs = (await admin.query(`SELECT array_agg(id) AS a FROM (SELECT id FROM pd_orgs ORDER BY n LIMIT 100) x`)).rows[0].a;
    const plan = await explain(
      label,
      `WITH cand AS MATERIALIZED (
         SELECT x.sid, x.due FROM unnest($1::uuid[]) AS o(org)
         CROSS JOIN LATERAL (SELECT p.subject_id AS sid, p.due_at AS due FROM core.worker_dispatch_pointer p
                              WHERE p.queue = 'email' AND p.organisation_id = o.org AND p.due_at <= now() AND ${extra}
                              ORDER BY p.due_at LIMIT 10) x
         ORDER BY x.due LIMIT 100
       ), picked AS MATERIALIZED (
         SELECT p.subject_id AS sid FROM core.worker_dispatch_pointer p
          WHERE p.queue = 'email' AND p.subject_id IN (SELECT c.sid FROM cand c) AND p.due_at <= now()
          FOR UPDATE OF p SKIP LOCKED
       )
       UPDATE core.worker_dispatch_pointer w SET due_at = now() + interval '30 seconds', claim_token = gen_random_uuid(),
              claim_count = w.claim_count + 1, claimed_at = now(), updated_at = now()
         FROM picked k WHERE w.queue = 'email' AND w.subject_id = k.sid
       RETURNING w.subject_id`,
      [orgs],
    );
    await admin.query('ROLLBACK TO SAVEPOINT s');
    expect(plan).toMatch(/worker_dispatch_pointer_fair_idx/);
    expect(plan).not.toMatch(/Seq Scan on (core\.)?worker_dispatch_pointer/);
  });

  it('the real definer call: wall time per claim of 100 on 500k pointers (recorded) and the 40 % organisation capped at 10', async () => {
    await admin.query('SAVEPOINT s');
    const t0 = process.hrtime.bigint();
    const { rows } = await admin.query('SELECT * FROM core.worker_claim_email_dispatch(100)');
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    // eslint-disable-next-line no-console
    console.log(`--- definer claim of 100 on 500k pointers: ${ms.toFixed(1)} ms, ${rows.length} rows`);
    const heavy = (await admin.query(`SELECT id FROM pd_orgs WHERE n = 1`)).rows[0].id;
    expect(rows.length).toBe(100);
    expect(rows.filter((r: { organisation_id: string }) => r.organisation_id === heavy).length).toBeLessThanOrEqual(10);
    await admin.query('ROLLBACK TO SAVEPOINT s');
  });
});
