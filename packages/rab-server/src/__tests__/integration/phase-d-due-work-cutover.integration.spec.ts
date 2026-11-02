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

describeIfApproved(`Phase D D5 due-work EXECUTE cutover (${MODE ?? 'off'}; integration)`, () => {
  let app: Client;
  let worker: Client;
  let crewflow: Client | null = null;

  beforeAll(async () => {
    app = new Client({ connectionString: process.env.TEST_DATABASE_URL! });
    worker = new Client({ connectionString: WORKER_URL! });
    await app.connect();
    await worker.connect();
    if (process.env.TEST_DATABASE_CREWFLOW_URL) {
      crewflow = new Client({ connectionString: process.env.TEST_DATABASE_CREWFLOW_URL });
      await crewflow.connect();
    }
  });

  afterAll(async () => {
    for (const c of [app, worker, crewflow]) await c?.end().catch(() => undefined);
  });

  const calls = [
    `SELECT * FROM core.worker_claim_due_work('manager_confirmation_timeout', 1, 5)`,
    `SELECT core.worker_complete_due_work(gen_random_uuid(), gen_random_uuid())`,
    `SELECT core.worker_reschedule_due_work(gen_random_uuid(), gen_random_uuid(), now())`,
  ];

  it('crewflow_worker can claim / complete / reschedule in both modes', async () => {
    for (const sql of calls) expect(await sqlstateOf(worker.query(sql))).toBe('ACCEPTED');
  });

  it(MODE === 'after' ? 'crewflow_app and crewflow are refused (42501)' : 'crewflow_app (old Worker identity) still can', async () => {
    for (const sql of calls) expect(await sqlstateOf(app.query(sql))).toBe(MODE === 'after' ? '42501' : 'ACCEPTED');
    if (crewflow) for (const sql of calls) expect(await sqlstateOf(crewflow.query(sql))).toBe(MODE === 'after' ? '42501' : 'ACCEPTED');
  });

  it('producers are unchanged: crewflow_app keeps INSERT / UPDATE on core.worker_due_work (schedulePointer) under RLS', async () => {
    const { rows } = await app.query(
      `SELECT has_table_privilege('core.worker_due_work', 'INSERT') AS i, has_table_privilege('core.worker_due_work', 'UPDATE') AS u`,
    );
    expect(rows[0]).toEqual({ i: true, u: true });
  });
});
