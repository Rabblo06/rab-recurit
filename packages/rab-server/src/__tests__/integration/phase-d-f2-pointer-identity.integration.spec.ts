import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

import { describeDatabaseUrl } from '../../database/typeorm/core/test-database-guard';
import { DUE_CONSTANTS, F2_CUTOVER_SWEEP_SQL } from '../../database/typeorm/core/worker-dispatch-pointer-sql';
import { provisionTypeScript, seedWorkspace, sqlstateOf, SeededWorkspace } from './helpers/workspace-fixtures';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';

/**
 * Phase D, finding F2 (owner-approved 2026-11-01, option C; migration StatementPointerPhysicalIdentity1786721350000).
 * A payroll_record can exist twice with ONE id and ONE workspace: in core and in workspace_<hex> (the HWS backfill keeps
 * ids). A dispatch pointer must belong to exactly one physical row, so a write to one copy (terminal update, delete,
 * backfill rollback, TRUNCATE core) never removes the pointer another copy still needs, and a record id reused in
 * another workspace never touches that workspace's pointer. Written failing-first against the approved
 * `(queue, subject_id)` key.
 *
 * OPT-IN (PHASE_D_SQL_APPROVED=true and TEST_DATABASE_WORKER_URL on the same disposable database). Synthetic payroll rows
 * are written by the bootstrap superuser inside transactions that are ALWAYS rolled back, with only the FOREIGN KEY / guard
 * triggers switched off (the four statement-pointer triggers and every CHECK stay on). The per-row-token case uses
 * committed email_outbox rows of its own organisation.
 */
const WORKER_URL = process.env.TEST_DATABASE_WORKER_URL;
const RUN = process.env.PHASE_D_SQL_APPROVED === 'true' && Boolean(WORKER_URL) && integrationTestDatabaseReady();
const describeIfApproved = RUN ? describe : describe.skip;
jest.setTimeout(120_000);

describeIfApproved('Phase D F2: dispatch-pointer identity is the physical source row (integration)', () => {
  const run = randomUUID().slice(0, 8);
  let admin: Client;
  let app: Client;
  let worker: Client;
  let a: SeededWorkspace;
  let b: SeededWorkspace;

  const connect = async (url: string) => {
    const c = new Client({ connectionString: url });
    await c.connect();
    return c;
  };

  /** Statement pointers of one subject id: one row per pointer, ordered (workspace, due). */
  async function pointers(subject: string): Promise<Array<{ workspace_id: string; due: boolean }>> {
    const { rows } = await admin.query(
      `SELECT workspace_id, (due_at <= now()) AS due FROM core.worker_dispatch_pointer
        WHERE queue = 'statement' AND subject_id = $1 ORDER BY workspace_id, due_at`,
      [subject],
    );
    return rows;
  }

  /** In a rolled-back transaction: only the statement-pointer triggers stay on for these payroll tables. */
  async function rolledBackPayroll<T>(tables: string[], fn: () => Promise<T>): Promise<T> {
    await admin.query('BEGIN');
    try {
      await admin.query(`SET LOCAL lock_timeout = '5s'`);
      for (const t of tables) {
        await admin.query(`ALTER TABLE ${t} DISABLE TRIGGER ALL`);
        for (const s of ['ins', 'upd', 'del', 'trunc']) await admin.query(`ALTER TABLE ${t} ENABLE TRIGGER payroll_record_statement_pointer_${s}`);
      }
      return await fn();
    } finally {
      await admin.query('ROLLBACK');
    }
  }

  /** A due (approved, statement pending) synthetic payroll row in `table` for workspace `ws`. */
  async function insertDue(table: string, ws: SeededWorkspace, id: string): Promise<void> {
    await admin.query(
      `INSERT INTO ${table} (id, organisation_id, workspace_id, attendance_id, shift_id, staff_profile_id, worked_minutes, pay_rate_pence,
                             amount_pence, status, approved_at, approved_by, statement_status)
       VALUES ($1, $2, $3, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 0, 0, 0, 'approved', now(), gen_random_uuid(), 'pending')`,
      [id, ws.org, ws.id],
    );
  }

  /** Terminal for the statement dispatcher: failed with the attempts exhausted (no pointer for this copy any more). */
  const makeTerminal = (table: string, id: string) =>
    admin.query(`UPDATE ${table} SET statement_status = 'failed', statement_attempts = $2, updated_at = now() WHERE id = $1`, [id, DUE_CONSTANTS.statementMaxAttempts]);

  beforeAll(async () => {
    const adminUrl = process.env.TEST_DATABASE_URL_UNPOOLED!;
    const target = describeDatabaseUrl(adminUrl, 'TEST_DATABASE_URL_UNPOOLED');
    const w = describeDatabaseUrl(WORKER_URL!, 'TEST_DATABASE_WORKER_URL');
    if (w.database !== target.database || w.host !== target.host || w.port !== target.port) throw new Error('TEST_DATABASE_WORKER_URL names another database. Refusing.');
    admin = await connect(adminUrl);
    app = await connect(process.env.TEST_DATABASE_URL!);
    worker = await connect(WORKER_URL!);
    a = await seedWorkspace(admin, `pd-f2a-${run}`);
    b = await seedWorkspace(admin, `pd-f2b-${run}`);
    expect(await provisionTypeScript(adminUrl, a)).toBe('READY');
    expect(await provisionTypeScript(adminUrl, b)).toBe('READY');
  });

  afterAll(async () => {
    for (const c of [app, worker, admin]) await c?.end().catch(() => undefined);
  });

  it('(a) a stale copy made terminal does not remove the live copy\'s pointer (core + workspace copy, one id)', async () => {
    const id = randomUUID();
    const wsT = `${a.schema}.payroll_record`;
    await rolledBackPayroll(['core.payroll_record', wsT], async () => {
      await insertDue('core.payroll_record', a, id);
      await insertDue(wsT, a, id); // the HWS backfill copy: same id, same workspace
      expect((await pointers(id)).length).toBe(2); // one pointer per physical row
      await makeTerminal('core.payroll_record', id); // the stale core copy ends
      expect(await pointers(id)).toEqual([{ workspace_id: a.id, due: true }]); // the live copy keeps its pointer
    });
  });

  it('(b) the backfill rollback deleting the workspace copy does not remove the core copy\'s pointer', async () => {
    const id = randomUUID();
    const wsT = `${a.schema}.payroll_record`;
    await rolledBackPayroll(['core.payroll_record', wsT], async () => {
      await insertDue('core.payroll_record', a, id);
      await insertDue(wsT, a, id);
      await admin.query(`DELETE FROM ${wsT} WHERE id = $1`, [id]); // privileged-copy.ts rollback path
      expect(await pointers(id)).toEqual([{ workspace_id: a.id, due: true }]);
    });
  });

  it('(c) TRUNCATE core.payroll_record removes only core-source pointers; a workspace copy keeps its pointer', async () => {
    const id = randomUUID();
    const wsT = `${a.schema}.payroll_record`;
    await rolledBackPayroll(['core.payroll_record', wsT], async () => {
      await insertDue('core.payroll_record', a, id);
      await insertDue(wsT, a, id);
      await admin.query('TRUNCATE core.payroll_record CASCADE');
      expect(await pointers(id)).toEqual([{ workspace_id: a.id, due: true }]);
    });
  });

  it('(d) an id reused in another workspace gets its own pointer; its delete or terminal update never touches the first', async () => {
    const id = randomUUID();
    const aT = `${a.schema}.payroll_record`;
    const bT = `${b.schema}.payroll_record`;
    await rolledBackPayroll([aT, bT], async () => {
      await insertDue(aT, a, id);
      await insertDue(bT, b, id); // workspace B writes a row with A's id
      expect(await pointers(id)).toHaveLength(2);
      await makeTerminal(bT, id);
      await admin.query(`DELETE FROM ${bT} WHERE id = $1`, [id]);
      const left = await pointers(id);
      expect(left).toEqual([{ workspace_id: a.id, due: true }]);
    });
  });

  it('claim: two copies of one record (two sources) are each claimed exactly once, each with its own token', async () => {
    const id = randomUUID();
    const wsT = `${a.schema}.payroll_record`;
    await rolledBackPayroll(['core.payroll_record', wsT], async () => {
      await insertDue('core.payroll_record', a, id);
      await insertDue(wsT, a, id);
      // As the Worker login, inside the same (rolled-back) transaction; loop because other organisations' due rows may come first.
      await admin.query('SET LOCAL ROLE crewflow_worker');
      const mine: Array<{ subject_id: string; claim_token: string }> = [];
      for (let i = 0; i < 20 && mine.length < 2; i += 1) {
        const { rows } = await admin.query('SELECT * FROM core.worker_claim_statement_dispatch(200)');
        mine.push(...rows.filter((r) => r.subject_id === id));
        if (rows.length === 0) break;
      }
      await admin.query('RESET ROLE');
      expect(mine).toHaveLength(2);
      expect(new Set(mine.map((r) => r.claim_token)).size).toBe(2);
      const { rows: after } = await admin.query(
        `SELECT source_schema, claim_count, claim_token FROM core.worker_dispatch_pointer
          WHERE queue = 'statement' AND subject_id = $1 ORDER BY source_schema`,
        [id],
      );
      expect(after.map((r) => [r.source_schema, r.claim_count])).toEqual([
        ['core', 1],
        [a.schema, 1],
      ]);
      expect(new Set(after.map((r) => r.claim_token))).toEqual(new Set(mine.map((r) => r.claim_token)));
    });
  });

  it('sibling retirement: a generated statement retires the same record\'s other copies in the SAME workspace only', async () => {
    const id = randomUUID();
    const aT = `${a.schema}.payroll_record`;
    const bT = `${b.schema}.payroll_record`;
    await rolledBackPayroll(['core.payroll_record', aT, bT], async () => {
      await insertDue('core.payroll_record', a, id); // stale core copy of A's record
      await insertDue(aT, a, id); // live copy
      await insertDue(bT, b, id); // another workspace reusing the id
      expect(await pointers(id)).toHaveLength(3);
      await admin.query(
        `UPDATE ${aT} SET statement_status = 'generated', statement_file_id = gen_random_uuid(), statement_generated_at = now(), updated_at = now() WHERE id = $1`,
        [id],
      );
      expect(await pointers(id)).toEqual([{ workspace_id: b.id, due: true }]); // A's copies done; B untouched
    });
  });

  it('each claimed row gets its own claim token (a release can only re-time the row it was handed)', async () => {
    const ids: string[] = [];
    try {
      for (let i = 0; i < 2; i += 1) {
        await app.query('BEGIN');
        await app.query(`SELECT set_config('rab.organisation_id', $1, true)`, [a.org]);
        const { rows } = await app.query(
          `INSERT INTO core.email_outbox (organisation_id, job_type, status, recipient_email, rendered_subject)
           VALUES ($1, 'NOTIFICATION', 'PENDING', $2, 'phase-d-f2') RETURNING id`,
          [a.org, `pd-f2-${randomUUID()}@phase-d.invalid`],
        );
        await app.query('COMMIT');
        ids.push(rows[0].id);
      }
      // Claim until both of this test's rows are handed out (other suites' due rows may come first).
      const tokens = new Map<string, string>();
      for (let i = 0; i < 20 && tokens.size < 2; i += 1) {
        const { rows } = await worker.query('SELECT * FROM core.worker_claim_email_dispatch(200)');
        for (const r of rows) if (ids.includes(r.subject_id)) tokens.set(r.subject_id, r.claim_token);
        if (rows.length === 0) break;
      }
      expect(tokens.size).toBe(2);
      const [t1, t2] = [tokens.get(ids[0]!)!, tokens.get(ids[1]!)!];
      expect(t1).not.toBe(t2);
      // Releasing the first with its own token re-times it; the second keeps its lease (its token still matches).
      const rel = await worker.query('SELECT core.worker_release_dispatch_claim($1, $2, $3, 30) AS ok', ['email', ids[0], t1]);
      expect(rel.rows[0].ok).toBe(true);
      const { rows: left } = await admin.query(`SELECT claim_token FROM core.worker_dispatch_pointer WHERE queue = 'email' AND subject_id = $1`, [ids[1]]);
      expect(left[0].claim_token).toBe(t2);
    } finally {
      for (const id of ids) {
        await app.query('BEGIN');
        await app.query(`SELECT set_config('rab.organisation_id', $1, true)`, [a.org]);
        await app.query(`UPDATE core.email_outbox SET status = 'CANCELLED', cancelled_at = now() WHERE id = $1`, [id]).catch(() => undefined);
        await app.query('COMMIT');
      }
    }
  });

  it('a pointer can only name core or its own workspace schema (CHECK), and the cutover sweep removes only stale-source pointers', async () => {
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL ROLE rab_secure_owner');
      const insert = (src: string, ws: SeededWorkspace) =>
        sqlstateOf(
          admin.query(
            `INSERT INTO core.worker_dispatch_pointer (queue, subject_id, source_schema, organisation_id, workspace_id, due_at)
             VALUES ('statement', gen_random_uuid(), $1, $2, $3, now())`,
            [src, ws.org, ws.id],
          ),
        );
      await admin.query('SAVEPOINT s1');
      expect(await insert(b.schema, a)).toBe('23514'); // another workspace's schema name
      await admin.query('ROLLBACK TO SAVEPOINT s1');
      await admin.query('SAVEPOINT s2');
      expect(await insert('public', a)).toBe('23514');
      await admin.query('ROLLBACK TO SAVEPOINT s2');
      expect(await insert('core', a)).toBe('ACCEPTED');
      expect(await insert(a.schema, a)).toBe('ACCEPTED');
      expect(await insert('core', b)).toBe('ACCEPTED');
      // After workspace A's routing moved to its schema: the sweep removes A's core-source statement pointers only.
      await admin.query(F2_CUTOVER_SWEEP_SQL, [a.id]);
      const { rows } = await admin.query(
        `SELECT workspace_id, source_schema FROM core.worker_dispatch_pointer
          WHERE queue = 'statement' AND workspace_id IN ($1, $2) ORDER BY workspace_id, source_schema`,
        [a.id, b.id],
      );
      expect(rows.filter((r) => r.workspace_id === a.id).map((r) => r.source_schema)).toEqual([a.schema]);
      expect(rows.filter((r) => r.workspace_id === b.id).map((r) => r.source_schema)).toEqual(['core']);
    } finally {
      await admin.query('ROLLBACK');
    }
  });
});
