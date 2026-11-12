import { Client } from 'pg';

import { sqlstateOf } from './helpers/workspace-fixtures';

/**
 * Phase D / D5 — the cutover gate of WorkerDueWorkClaimsToWorkerRole1786721330000 (gated migration, written, NOT applied).
 *
 * OPT-IN. Two modes, chosen by the operator running the cutover rehearsal on a DISPOSABLE database:
 *   PHASE_D_D5=before  — 1786721330000 not applied: the old Worker identity (crewflow_app) still claims due work; the new
 *                        one (crewflow_worker) can too, through its crewflow_app membership. Proves an old Worker keeps
 *                        working until the cutover (owner decision D2: old runtime mode keeps working until ready).
 *   PHASE_D_D5=after   — 1786721330000 applied: only crewflow_worker claims / completes / reschedules; crewflow_app and
 *                        crewflow are refused (42501) — the D0-A1 cross-tenant claim and delete by the API login is gone.
 * Needs PHASE_D_SQL_APPROVED=true and TEST_DATABASE_WORKER_URL (crewflow_worker on the same database).
 * The down() rehearsal (PHASE_D_D5=after, then `migration:revert` of 1786721330000, then PHASE_D_D5=before) proves the
 * rollback restores the old Worker's access exactly.
 */
const MODE = process.env.PHASE_D_D5;
const WORKER_URL = process.env.TEST_DATABASE_WORKER_URL;
const RUN = process.env.PHASE_D_SQL_APPROVED === 'true' && (MODE === 'before' || MODE === 'after') && Boolean(process.env.TEST_DATABASE_URL && WORKER_URL);
const describeIfApproved = RUN ? describe : describe.skip;

/**
 * Owner-login architecture (approved: "keep it, retitled under one login"). Every process connects as crewflow_owner
 * (TEST_DATABASE_URL and TEST_DATABASE_WORKER_URL are both the owner login in CI). The D5 EXECUTE boundary is a property
 * of the SCHEMA ROLES, so the BEFORE/AFTER expectations are checked as crewflow_worker / crewflow_app / crewflow through the
 * fixture superuser's `SET LOCAL ROLE` (rolled back). The runtime login itself can run all three functions (it inherits
 * their owner): catalogue BC-08 (DBA-01 separation lost), ACCEPTED (owner, 2026-11-05). PHASE_D_D5=before only in CI.
 */
describeIfApproved(`Phase D D5 due-work EXECUTE cutover under one login (${MODE ?? 'off'}; integration)`, () => {
  let runtime: Client;
  let admin: Client;

  beforeAll(async () => {
    runtime = new Client({ connectionString: WORKER_URL! });
    admin = new Client({ connectionString: process.env.TEST_DATABASE_URL_UNPOOLED! });
    await runtime.connect();
    await admin.connect();
  });

  afterAll(async () => {
    for (const c of [runtime, admin]) await c?.end().catch(() => undefined);
  });

  const calls = [
    `SELECT * FROM core.worker_claim_due_work('manager_confirmation_timeout', 1, 5)`,
    `SELECT core.worker_complete_due_work(gen_random_uuid(), gen_random_uuid())`,
    `SELECT core.worker_reschedule_due_work(gen_random_uuid(), gen_random_uuid(), now())`,
  ];
  /** SQLSTATE of `sql` run as the schema role `role` (superuser + SET LOCAL ROLE), always rolled back. */
  const asSchemaRole = async (role: 'crewflow_worker' | 'crewflow_app' | 'crewflow', sql: string): Promise<string> => {
    await admin.query('BEGIN');
    try {
      await admin.query(`SELECT set_config('role', $1, true)`, [role]);
      return await sqlstateOf(admin.query(sql));
    } finally {
      await admin.query('ROLLBACK').catch(() => undefined);
    }
  };

  it('schema role crewflow_worker can claim / complete / reschedule in both modes', async () => {
    for (const sql of calls) expect(await asSchemaRole('crewflow_worker', sql)).toBe('ACCEPTED');
  });

  it(MODE === 'after' ? 'schema roles crewflow_app and crewflow are refused (42501)' : 'schema roles crewflow_app (old Worker identity) and crewflow still can', async () => {
    for (const sql of calls) expect(await asSchemaRole('crewflow_app', sql)).toBe(MODE === 'after' ? '42501' : 'ACCEPTED');
    for (const sql of calls) expect(await asSchemaRole('crewflow', sql)).toBe(MODE === 'after' ? '42501' : 'ACCEPTED');
  });

  it('OWNER-LOGIN DIFFERENCE BC-08 (ACCEPTED (owner, 2026-11-05)): the one runtime login (API and Worker alike) can run all three', async () => {
    const [{ u }] = (await runtime.query(`SELECT current_user AS u`)).rows;
    expect(u).toBe('crewflow_owner');
    for (const sql of calls) expect(await sqlstateOf(runtime.query(sql))).toBe('ACCEPTED');
  });

  it('producers are unchanged: the schema role crewflow_app keeps INSERT / UPDATE on core.worker_due_work (schedulePointer) under RLS', async () => {
    const { rows } = await admin.query(
      `SELECT has_table_privilege('crewflow_app', 'core.worker_due_work', 'INSERT') AS i, has_table_privilege('crewflow_app', 'core.worker_due_work', 'UPDATE') AS u`,
    );
    expect(rows[0]).toEqual({ i: true, u: true });
  });
});
