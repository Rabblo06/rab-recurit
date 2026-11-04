import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

import { R4_PHASE_D_MISSING_PAIRS_SQL, R4_TABLES_SQL, secureOwnerInvariantViolations } from '../../database/typeorm/core/secure-owner-invariants';
import { POSTURE_QUERY } from '../../database/typeorm/core/security-posture';
import {
  dispatchTriggerProblems,
  expectedWorkerDispatchPrivilegeLines,
  OUTBOX_FUNCTIONS_EXPECTED,
  OUTBOX_FUNCTIONS_STATE_SQL,
  OUTBOX_TRIGGERS_EXPECTED,
  OUTBOX_TRIGGERS_STATE_SQL,
  STATEMENT_FUNCTION_EXPECTED,
  STATEMENT_FUNCTION_STATE_SQL,
  WORKER_DISPATCH_POINTER_EXPECTED_STATE,
  WORKER_DISPATCH_POINTER_STATE_SQL,
  workerDispatchPrivilegeChecksSql,
} from '../../database/typeorm/core/worker-dispatch-pointer-sql';
import { describeDatabaseUrl } from '../../database/typeorm/core/test-database-guard';
import { provisionServerPath, provisionTypeScript, seedWorkspace, sqlstateOf, SeededWorkspace } from './helpers/workspace-fixtures';

/**
 * Phase D (D1/D2) — security and behaviour of core.worker_dispatch_pointer, its claim / release definers and the pointer
 * triggers (migrations 1786721300000 … 1786721320000).
 *
 * OPT-IN: this suite needs the Phase D migrations applied, which only disposable test databases have until the release
 * is approved. It runs only when PHASE_D_SQL_APPROVED=true AND the disposable test database carries the
 * migrations AND TEST_DATABASE_WORKER_URL names a crewflow_worker login on that same database (same guard as the other
 * test URLs: loopback unless ALLOW_REMOTE_TEST_DATABASE=true). Everything it writes is synthetic and uniquely labelled;
 * destructive probes run inside transactions that are always rolled back.
 *
 * What it proves (owner decision D1: "forged pointers, altered tenant routing, expired leases and stale claim tokens
 * cannot cause cross-tenant processing or duplicate business effects"):
 *   - no login reads or writes the pointer table directly; with no tenant context nothing is returned — the read is
 *     refused outright (42501), never answered with rows;
 *   - only crewflow_worker can claim / release; the claim body is executable by nobody;
 *   - trigger lifecycle per queue mirrors the dispatcher (due now / later / deleted), a producer rollback leaves nothing,
 *     a scope change or a mismatched workspace is refused;
 *   - claims are bounded, disjoint under concurrency, fair across organisations, lease-fenced (expired lease reclaimed with
 *     a NEW token; the stale token can no longer release), and a claim never deletes;
 *   - a forged / stale pointer finds nothing under its own tenant context (RLS), so it cannot touch another tenant's row;
 *   - crewflow can attach the statement function (EXECUTE, SECURITY TRADE-OFF) but the function refuses on any table but
 *     payroll_record in core / the row's own workspace (E-2) and secure-owner invariants report the attachment; crewflow
 *     cannot attach the outbox functions;
 *   - a squatted pointer is re-pointed, never blocks a write (E-3); TRUNCATE drops the queue's pointers (E-4);
 *   - NOTIFY crewflow_worker_wake only when the session enabled crewflow.dispatch_notify (E-1), label only, after commit.
 */
const WORKER_URL = process.env.TEST_DATABASE_WORKER_URL;
const RUN = process.env.PHASE_D_SQL_APPROVED === 'true' && Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_DATABASE_URL_UNPOOLED && WORKER_URL);
const describeIfApproved = RUN ? describe : describe.skip;

describeIfApproved('Phase D dispatch pointer (integration; needs the approved Phase D migrations)', () => {
  let admin: Client; // bootstrap superuser of the disposable database (no RLS)
  let app: Client; // crewflow_app — the API login
  let worker: Client; // crewflow_worker
  let worker2: Client;
  let crewflow: Client | null = null;
  const run = randomUUID().slice(0, 8);

  const connect = async (url: string) => {
    const c = new Client({ connectionString: url });
    await c.connect();
    return c;
  };

  async function asTenant<T>(c: Client, org: string, ws: string | null, fn: () => Promise<T>): Promise<T> {
    await c.query('BEGIN');
    try {
      await c.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', '', true), set_config('rab.role', '', true)`, [org, ws ?? '']);
      const out = await fn();
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  }

  async function pointer(queue: string, subject: string) {
    const { rows } = await admin.query(
      `SELECT organisation_id, workspace_id, due_at, claim_token, claim_count, (due_at <= now()) AS due, extract(epoch FROM due_at - now())::float8 AS in_s
         FROM core.worker_dispatch_pointer WHERE queue = $1 AND subject_id = $2`,
      [queue, subject],
    );
    return rows[0] as { organisation_id: string; workspace_id: string | null; due_at: Date; claim_token: string | null; claim_count: number; due: boolean; in_s: number } | undefined;
  }

  async function insertEmail(org: string, status = 'PENDING'): Promise<string> {
    return asTenant(app, org, null, async () => {
      const { rows } = await app.query(
        `INSERT INTO core.email_outbox (organisation_id, job_type, status, recipient_email, rendered_subject)
         VALUES ($1, 'NOTIFICATION', $2, $3, 'phase-d') RETURNING id`,
        [org, status, `pd-${randomUUID()}@phase-d.invalid`],
      );
      return rows[0].id as string;
    });
  }

  /** A realtime event written by the API login under its own tenant + workspace context (the normal producer path). */
  async function insertRealtime(ws: SeededWorkspace): Promise<string> {
    return asTenant(app, ws.org, ws.id, async () => {
      const { rows } = await app.query(
        `INSERT INTO core.realtime_event (organisation_id, workspace_id, event_key, event_type, entity_type, entity_id, status)
         VALUES ($1, $2, $3, 'phase_d.test', 'shift', gen_random_uuid(), 'pending') RETURNING id`,
        [ws.org, ws.id, `pd-${randomUUID()}`],
      );
      return rows[0].id as string;
    });
  }

  /** Runs `fn` on the bootstrap superuser connection inside a transaction that is ALWAYS rolled back. */
  async function rolledBack<T>(fn: () => Promise<T>): Promise<T> {
    await admin.query('BEGIN');
    try {
      await admin.query(`SET LOCAL lock_timeout = '5s'`);
      return await fn();
    } finally {
      await admin.query('ROLLBACK');
    }
  }

  /** SQLSTATE of one statement inside the current transaction, isolated by a savepoint ('ACCEPTED' when it succeeds). */
  async function stateIn(c: Client, sql: string, params: unknown[] = []): Promise<string> {
    await c.query('SAVEPOINT probe');
    const code = await sqlstateOf(c.query(sql, params));
    await c.query(code === 'ACCEPTED' ? 'RELEASE SAVEPOINT probe' : 'ROLLBACK TO SAVEPOINT probe');
    return code;
  }

  /**
   * P-class (owner-login architecture): SQLSTATE of `sql` run as the SCHEMA ROLE `role` (fixture superuser + SET LOCAL ROLE,
   * optional tenant binding), always rolled back. crewflow_app / crewflow_worker / crewflow are schema roles now; their
   * grants and policies are still the reviewed boundary.
   */
  async function asSchemaRole(role: 'crewflow_app' | 'crewflow_worker' | 'crewflow', sql: string, params: unknown[] = [], org: string | null = null, ws: string | null = null): Promise<string> {
    await admin.query('BEGIN');
    try {
      await admin.query(`SELECT set_config('role', $1, true)`, [role]);
      if (org) await admin.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true)`, [org, ws ?? '']);
      return await sqlstateOf(admin.query(sql, params));
    } finally {
      await admin.query('ROLLBACK').catch(() => undefined);
    }
  }
  /** SQLSTATE of `fn` on the runtime connection `c` inside a transaction that is always rolled back. */
  async function runtimeRolledBack(c: Client, fn: () => Promise<unknown>, org: string | null = null, ws: string | null = null): Promise<string> {
    await c.query('BEGIN');
    try {
      if (org) await c.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true)`, [org, ws ?? '']);
      return await sqlstateOf(fn());
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
    }
  }

  const claim = async (c: Client, queue: 'email' | 'push' | 'realtime' | 'statement', limit: number) => {
    const fn = { email: 'worker_claim_email_dispatch', push: 'worker_claim_push_dispatch', realtime: 'worker_claim_realtime_publish', statement: 'worker_claim_statement_dispatch' }[queue];
    const { rows } = await c.query(`SELECT * FROM core.${fn}($1)`, [limit]);
    return rows as Array<{ subject_id: string; organisation_id: string; workspace_id: string | null; claim_token: string; claim_count: number }>;
  };

  let a: SeededWorkspace;
  let b: SeededWorkspace;

  beforeAll(async () => {
    const appUrl = process.env.TEST_DATABASE_URL!;
    const adminUrl = process.env.TEST_DATABASE_URL_UNPOOLED!;
    // Same database as the application and admin URLs (never another one).
    const target = describeDatabaseUrl(adminUrl, 'TEST_DATABASE_URL_UNPOOLED');
    const w = describeDatabaseUrl(WORKER_URL!, 'TEST_DATABASE_WORKER_URL');
    if (w.database !== target.database || w.host !== target.host || w.port !== target.port) throw new Error('TEST_DATABASE_WORKER_URL names another database. Refusing.');
    admin = await connect(adminUrl);
    app = await connect(appUrl);
    worker = await connect(WORKER_URL!);
    worker2 = await connect(WORKER_URL!);
    if (process.env.TEST_DATABASE_CREWFLOW_URL) crewflow = await connect(process.env.TEST_DATABASE_CREWFLOW_URL);
    const { rows } = await worker.query('SELECT current_user AS u, session_user AS s');
    // BC-08 (Phase D under one login): TEST_DATABASE_WORKER_URL is the owner login; crewflow_worker is a schema role.
    expect(rows[0]).toEqual({ u: 'crewflow_owner', s: 'crewflow_owner' });
    a = await seedWorkspace(admin, `pd-a-${run}`);
    b = await seedWorkspace(admin, `pd-b-${run}`);
  });

  afterAll(async () => {
    for (const c of [app, worker, worker2, crewflow, admin]) await c?.end().catch(() => undefined);
  });

  describe('no direct access, fail closed', () => {
    // P-class (owner-login architecture): the three schema roles keep "no direct access" (42501), with or without a tenant.
    it.each(['crewflow_app', 'crewflow_worker', 'crewflow'] as const)('schema role %s cannot read, insert, update or delete pointers (42501), with or without tenant context', async (role) => {
      expect(await asSchemaRole(role, 'SELECT count(*) FROM core.worker_dispatch_pointer')).toBe('42501');
      expect(await asSchemaRole(role, `INSERT INTO core.worker_dispatch_pointer (queue, subject_id, organisation_id, due_at) VALUES ('email', gen_random_uuid(), $1, now())`, [a.org])).toBe('42501');
      expect(await asSchemaRole(role, `UPDATE core.worker_dispatch_pointer SET due_at = now()`)).toBe('42501');
      expect(await asSchemaRole(role, `DELETE FROM core.worker_dispatch_pointer`)).toBe('42501');
      expect(await asSchemaRole(role, 'SELECT count(*) FROM core.worker_dispatch_pointer', [], a.org)).toBe('42501');
    });

    // The one runtime login holds table privileges through the owner (catalogue BC-10, NEEDS OWNER APPROVAL), but the pointer
    // policies still fail it closed: the definer policy admits only current_user = rab_secure_owner and the RESTRICTIVE deny
    // binds members of crewflow. It sees zero rows, cannot insert (42501) and changes nothing (rolled back). Only an injected
    // SET ROLE rab_secure_owner gets past this (G-03, owner-accepted).
    it('the runtime login (API and Worker alike) sees zero pointers, cannot insert one and changes none, with or without tenant context (BC-10)', async () => {
      const total = async () => (await admin.query('SELECT count(*)::int AS n FROM core.worker_dispatch_pointer')).rows[0].n as number;
      const before = await total();
      for (const c of [app, worker]) {
        expect((await c.query('SELECT count(*)::int AS n FROM core.worker_dispatch_pointer')).rows[0].n).toBe(0);
        expect((await asTenant(c, a.org, null, () => c.query('SELECT count(*)::int AS n FROM core.worker_dispatch_pointer'))).rows[0].n).toBe(0);
        expect(await runtimeRolledBack(c, () => c.query(`INSERT INTO core.worker_dispatch_pointer (queue, subject_id, organisation_id, due_at) VALUES ('email', gen_random_uuid(), $1, now())`, [a.org]))).toBe('42501');
        await c.query('BEGIN');
        try {
          expect((await c.query(`UPDATE core.worker_dispatch_pointer SET due_at = now()`)).rowCount).toBe(0);
          expect((await c.query(`DELETE FROM core.worker_dispatch_pointer`)).rowCount).toBe(0);
        } finally {
          await c.query('ROLLBACK').catch(() => undefined);
        }
      }
      expect(await total()).toBe(before);
    });

    // P-class (owner-login architecture): the boundary between the SCHEMA ROLES is unchanged: only crewflow_worker may claim
    // or release, and the claim body is executable by none of them. The one runtime login inherits the definers' owner and
    // can do all of it, the body included: catalogue BC-08 (DBA-01 lost, NEEDS OWNER APPROVAL); asserted in rolled-back
    // transactions so no pointer is leased.
    it('only the schema role crewflow_worker may claim or release; the claim body is executable by no schema role; the runtime login can (BC-08)', async () => {
      const claimSql = (q: 'email' | 'push' | 'realtime' | 'statement') =>
        `SELECT * FROM core.${{ email: 'worker_claim_email_dispatch', push: 'worker_claim_push_dispatch', realtime: 'worker_claim_realtime_publish', statement: 'worker_claim_statement_dispatch' }[q]}(1)`;
      const release = `SELECT core.worker_release_dispatch_claim('email', gen_random_uuid(), gen_random_uuid(), 1)`;
      const impl = `SELECT * FROM core.worker_dispatch_claim_impl('email', 10, 300, 50)`;
      for (const role of ['crewflow_app', 'crewflow'] as const) {
        for (const q of ['email', 'push', 'realtime', 'statement'] as const) expect({ role, q, code: await asSchemaRole(role, claimSql(q)) }).toEqual({ role, q, code: '42501' });
        expect({ role, code: await asSchemaRole(role, release) }).toEqual({ role, code: '42501' });
      }
      expect(await asSchemaRole('crewflow_worker', impl)).toBe('42501');
      expect(await asSchemaRole('crewflow_worker', claimSql('email'))).toBe('ACCEPTED');
      // OWNER-LOGIN DIFFERENCE BC-08 (NEEDS OWNER APPROVAL), rolled back.
      expect(await runtimeRolledBack(worker, () => worker.query(impl))).toBe('ACCEPTED');
      expect(await runtimeRolledBack(worker, () => claim(worker, 'email', 1))).toBe('ACCEPTED');
    });

    it('the API login is not, and cannot become, the Worker: no membership either way', async () => {
      const { rows } = await admin.query(
        `SELECT pg_has_role('crewflow_app', 'crewflow_worker', 'USAGE') AS app_has_worker, pg_has_role('crewflow_worker', 'crewflow_app', 'SET') AS worker_set_app,
                pg_has_role('crewflow_worker', 'crewflow', 'USAGE') AS worker_crewflow, pg_has_role('crewflow_worker', 'rab_secure_owner', 'USAGE') AS worker_secure`,
      );
      expect(rows[0]).toEqual({ app_has_worker: false, worker_set_app: false, worker_crewflow: false, worker_secure: false });
    });
  });

  describe('trigger lifecycle (email; push and realtime share the shape)', () => {
    it('PENDING → due now; QUEUED → queued_at + 2 min; PROCESSING → + 10 min; SENT → pointer deleted', async () => {
      const id = await insertEmail(a.org);
      expect(await pointer('email', id)).toMatchObject({ organisation_id: a.org, workspace_id: null, due: true, claim_token: null });
      await asTenant(app, a.org, null, () => app.query(`UPDATE core.email_outbox SET status = 'QUEUED', queued_at = now() WHERE id = $1`, [id]));
      const q = (await pointer('email', id))!;
      expect(q.due).toBe(false);
      expect(Math.round(q.in_s)).toBeGreaterThanOrEqual(118);
      await asTenant(app, a.org, null, () => app.query(`UPDATE core.email_outbox SET status = 'PROCESSING', processing_at = now() WHERE id = $1`, [id]));
      expect(Math.round((await pointer('email', id))!.in_s)).toBeGreaterThanOrEqual(598);
      await asTenant(app, a.org, null, () => app.query(`UPDATE core.email_outbox SET status = 'SENT', sent_at = now() WHERE id = $1`, [id]));
      expect(await pointer('email', id)).toBeUndefined();
    });

    it('a producer rollback leaves no pointer (the pointer is written in the producer transaction)', async () => {
      const id = randomUUID();
      await app.query('BEGIN');
      await app.query(`SELECT set_config('rab.organisation_id', $1, true)`, [a.org]);
      await app.query(`INSERT INTO core.email_outbox (id, organisation_id, job_type, status, recipient_email, rendered_subject) VALUES ($1, $2, 'NOTIFICATION', 'PENDING', 'rb@phase-d.invalid', 'x')`, [id, a.org]);
      await app.query('ROLLBACK');
      expect(await pointer('email', id)).toBeUndefined();
    });

    it('altered tenant routing is refused: an open subject cannot move to another organisation (even as a superuser)', async () => {
      const id = await insertEmail(a.org);
      expect(await sqlstateOf(admin.query(`UPDATE core.email_outbox SET organisation_id = $1 WHERE id = $2`, [b.org, id]))).toBe('42501');
      expect((await pointer('email', id))!.organisation_id).toBe(a.org);
    });

    it('a realtime event whose workspace belongs to another organisation is refused (scope pairing)', async () => {
      const code = await sqlstateOf(
        admin.query(
          `INSERT INTO core.realtime_event (organisation_id, workspace_id, event_key, event_type, entity_type, entity_id, status)
           VALUES ($1, $2, $3, 'phase_d.test', 'shift', gen_random_uuid(), 'pending')`,
          [a.org, b.id, `pd-${randomUUID()}`],
        ),
      );
      expect(code).toBe('42501');
    });
  });

  describe('claims', () => {
    it('returns routing ids only, pushes due_at by the server lease, and never hands the same pointer out twice within it', async () => {
      const id = await insertEmail(a.org);
      const first = (await claim(worker, 'email', 200)).filter((r) => r.subject_id === id);
      expect(first).toHaveLength(1);
      expect(Object.keys(first[0]!).sort()).toEqual(['claim_count', 'claim_token', 'organisation_id', 'subject_id', 'workspace_id']);
      expect(first[0]).toMatchObject({ organisation_id: a.org, workspace_id: null, claim_count: 1 });
      const p = (await pointer('email', id))!;
      expect(p.claim_token).toBe(first[0]!.claim_token);
      expect(Math.round(p.in_s)).toBeGreaterThanOrEqual(29);
      expect((await claim(worker2, 'email', 200)).filter((r) => r.subject_id === id)).toHaveLength(0);
    });

    it('two concurrent claimers get disjoint pointers; the batch is clamped to 1..200', async () => {
      const ids = new Set<string>();
      for (let i = 0; i < 60; i += 1) ids.add(await insertEmail(a.org));
      const [x, y] = await Promise.all([claim(worker, 'email', 40), claim(worker2, 'email', 40)]);
      const mine = (rows: typeof x) => rows.filter((r) => ids.has(r.subject_id)).map((r) => r.subject_id);
      const overlap = mine(x).filter((s) => mine(y).includes(s));
      expect(overlap).toEqual([]);
      expect(x.length).toBeLessThanOrEqual(40);
      expect((await claim(worker, 'email', 100000)).length).toBeLessThanOrEqual(200);
    });

    it('fair across organisations: one organisation with a large backlog does not starve the others (per-organisation cap)', async () => {
      const orgs: string[] = [];
      for (let i = 0; i < 12; i += 1) {
        const w = await seedWorkspace(admin, `pd-f${i}-${run}`);
        orgs.push(w.org);
        await insertEmail(w.org);
      }
      const big = await seedWorkspace(admin, `pd-big-${run}`);
      for (let i = 0; i < 150; i += 1) await insertEmail(big.org);
      const got = await claim(worker, 'email', 200);
      for (const org of orgs) expect(got.some((r) => r.organisation_id === org)).toBe(true);
      expect(got.filter((r) => r.organisation_id === big.org).length).toBeLessThanOrEqual(10);
    });

    it('an expired lease is reclaimed with a NEW token; the stale token can no longer release; release never deletes', async () => {
      // A fresh organisation: the per-organisation cap (10) hands out the OLDEST due pointers first, and org A has a backlog.
      const id = await insertEmail((await seedWorkspace(admin, `pd-lease-${run}`)).org);
      const old = (await claim(worker, 'email', 200)).find((r) => r.subject_id === id)!;
      // Simulate the lease running out (the only thing the test changes directly).
      await admin.query(`UPDATE core.worker_dispatch_pointer SET due_at = now() - interval '1 second' WHERE queue = 'email' AND subject_id = $1`, [id]);
      const fresh = (await claim(worker2, 'email', 200)).find((r) => r.subject_id === id)!;
      expect(fresh.claim_token).not.toBe(old.claim_token);
      expect(fresh.claim_count).toBe(2);
      const stale = await worker.query(`SELECT core.worker_release_dispatch_claim('email', $1, $2, 300) AS ok`, [id, old.claim_token]);
      expect(stale.rows[0].ok).toBe(false);
      expect((await pointer('email', id))!.claim_token).toBe(fresh.claim_token);
      const ok = await worker2.query(`SELECT core.worker_release_dispatch_claim('email', $1, $2, 100000) AS ok`, [id, fresh.claim_token]);
      expect(ok.rows[0].ok).toBe(true);
      const p = (await pointer('email', id))!;
      expect(p.claim_token).toBeNull();
      expect(Math.round(p.in_s)).toBeLessThanOrEqual(300); // clamped
      expect(await pointer('email', id)).toBeDefined();
    });

    it('a subject state change clears the claim: a late release by the claimer is a no-op', async () => {
      const w = await seedWorkspace(admin, `pd-late-${run}`);
      const id = await insertEmail(w.org);
      const c = (await claim(worker, 'email', 200)).find((r) => r.subject_id === id)!;
      await asTenant(app, w.org, null, () => app.query(`UPDATE core.email_outbox SET status = 'QUEUED', queued_at = now() WHERE id = $1`, [id]));
      expect((await worker.query(`SELECT core.worker_release_dispatch_claim('email', $1, $2, 1) AS ok`, [id, c.claim_token])).rows[0].ok).toBe(false);
    });
  });

  describe('forged and stale pointers cannot cross tenants', () => {
    it('a pointer naming organisation A for organisation B\'s row finds nothing under A\'s context (RLS); B\'s row is untouched', async () => {
      const victim = await insertEmail(b.org);
      // Forge as the only identity that can write a pointer outside the triggers (the bootstrap superuser).
      await admin.query(`DELETE FROM core.worker_dispatch_pointer WHERE queue = 'email' AND subject_id = $1`, [victim]);
      await admin.query(`INSERT INTO core.worker_dispatch_pointer (queue, subject_id, organisation_id, due_at) VALUES ('email', $1, $2, now())`, [victim, a.org]);
      const forged = (await claim(worker, 'email', 200)).find((r) => r.subject_id === victim)!;
      expect(forged.organisation_id).toBe(a.org);
      // The Worker's per-scope claim SQL under the POINTER's own context (organisation A), restricted to the claimed ids.
      const seen = await asTenant(worker, forged.organisation_id, null, () =>
        worker.query(`SELECT id FROM core.email_outbox WHERE id = ANY($1::uuid[]) AND status = 'PENDING' FOR UPDATE SKIP LOCKED`, [[victim]]),
      );
      expect(seen.rows).toEqual([]);
      const { rows } = await admin.query(`SELECT status, dispatch_generation FROM core.email_outbox WHERE id = $1`, [victim]);
      expect(rows[0]).toEqual({ status: 'PENDING', dispatch_generation: 0 });
    });
  });

  describe('E-3: a stale or squatted pointer never blocks a tenant write', () => {
    it('a pointer pre-inserted with a foreign scope is RE-POINTED to the real row\'s scope when the row is written (repoint_count + 1)', async () => {
      const id = randomUUID();
      await admin.query('BEGIN');
      try {
        await admin.query('SET LOCAL ROLE rab_secure_owner');
        await admin.query(`INSERT INTO core.worker_dispatch_pointer (queue, subject_id, organisation_id, due_at) VALUES ('email', $1, $2, now() + interval '1 hour')`, [id, b.org]);
        await admin.query('RESET ROLE');
        await admin.query('COMMIT');
      } catch (e) {
        await admin.query('ROLLBACK');
        throw e;
      }
      await asTenant(app, a.org, null, () =>
        app.query(`INSERT INTO core.email_outbox (id, organisation_id, job_type, status, recipient_email, rendered_subject) VALUES ($1, $2, 'NOTIFICATION', 'PENDING', 'sq@phase-d.invalid', 'x')`, [id, a.org]),
      );
      const { rows } = await admin.query(`SELECT organisation_id, repoint_count, (due_at <= now()) AS due FROM core.worker_dispatch_pointer WHERE queue = 'email' AND subject_id = $1`, [id]);
      expect(rows[0]).toEqual({ organisation_id: a.org, repoint_count: 1, due: true });
    });
  });

  describe('E-4: TRUNCATE removes the queue\'s pointers (rolled back)', () => {
    it('TRUNCATE core.realtime_event drops every realtime pointer and nothing else', async () => {
      const id = await insertEmail(a.org);
      await admin.query('BEGIN');
      try {
        await admin.query(`SET LOCAL lock_timeout = '5s'`);
        await admin.query('TRUNCATE core.realtime_event');
        const { rows } = await admin.query(`SELECT queue, count(*)::int AS n FROM core.worker_dispatch_pointer GROUP BY queue`);
        expect(rows.find((r: { queue: string }) => r.queue === 'realtime')).toBeUndefined();
        expect(await pointer('email', id)).toBeDefined();
      } finally {
        await admin.query('ROLLBACK');
      }
    });
  });

  describe('statement function (crewflow EXECUTE — SECURITY TRADE-OFF) and workspace schemas', () => {
    it('both provisioning paths (crewflow) attach the four statement triggers, enabled, to the new workspace payroll table', async () => {
      for (const [label, provision] of [
        ['server', (ws: SeededWorkspace) => provisionServerPath(process.env.TEST_DATABASE_URL!, ws)],
        ['typescript', (ws: SeededWorkspace) => provisionTypeScript(process.env.TEST_DATABASE_URL_UNPOOLED!, ws)],
      ] as const) {
        const ws = await seedWorkspace(admin, `pd-prov-${label}-${run}`);
        expect(await provision(ws)).toBe('READY');
        const { rows } = await admin.query(
          `SELECT string_agg(t.tgname || ':' || t.tgfoid::regprocedure::text || ':' || t.tgenabled::text, ',' ORDER BY t.tgname) AS t FROM pg_trigger t
            WHERE t.tgrelid = to_regclass($1) AND NOT t.tgisinternal AND t.tgname LIKE 'payroll_record_statement_pointer_%'`,
          [`${ws.schema}.payroll_record`],
        );
        expect(rows[0].t).toBe(['del', 'ins', 'trunc', 'upd'].map((s) => `payroll_record_statement_pointer_${s}:core.worker_dispatch_pointer_statement_trg():O`).join(','));
      }
    });

    it('E-2: crewflow attaching the statement function anywhere else gets a refusal on the first write (and the invariant reports it)', async () => {
      if (!crewflow) return;
      const cols = `(id uuid, organisation_id uuid, workspace_id uuid, status text, statement_status text, statement_file_id uuid,
                     statement_attempts int, statement_queued_at timestamptz, statement_processing_at timestamptz, updated_at timestamptz)`;
      // (1) another table name in public; (2) a table NAMED payroll_record but in public (not core, not a workspace schema).
      for (const [schema, table] of [['public', `pd_forge_${run}`], ['public', 'payroll_record']] as const) {
        await crewflow.query('BEGIN');
        try {
          await crewflow.query(`CREATE TABLE ${schema}.${table} ${cols}`);
          await crewflow.query(`CREATE TRIGGER f AFTER INSERT ON ${schema}.${table} FOR EACH ROW EXECUTE FUNCTION core.worker_dispatch_pointer_statement_trg()`);
          const violations = await secureOwnerInvariantViolations(async (sql) => (await crewflow!.query(sql)).rows);
          expect(violations.some((v) => v.startsWith(`secure-trigger-attachment-added|${schema}.${table}.f|`))).toBe(true);
          expect(
            await sqlstateOf(crewflow.query(`INSERT INTO ${schema}.${table} VALUES (gen_random_uuid(), $1, $2, 'approved', 'pending', NULL, 0, NULL, NULL, now())`, [a.org, a.id])),
          ).toBe('42501');
        } finally {
          await crewflow.query('ROLLBACK');
        }
      }
    });

    it('crewflow cannot attach the outbox trigger functions at all (no EXECUTE)', async () => {
      if (!crewflow) return;
      await crewflow.query('BEGIN');
      try {
        await crewflow.query(`CREATE TABLE public.pd_forge2_${run} (id uuid, organisation_id uuid, status text)`);
        expect(await sqlstateOf(crewflow.query(`CREATE TRIGGER f AFTER INSERT ON public.pd_forge2_${run} FOR EACH ROW EXECUTE FUNCTION core.worker_dispatch_pointer_email_trg()`))).toBe('42501');
      } finally {
        await crewflow.query('ROLLBACK');
      }
    });

    it('in a workspace\'s own payroll table it mirrors DUE_SQL into a pointer bound to that workspace (FK triggers off, rolled back)', async () => {
      const ws = await seedWorkspace(admin, `pd-stmt-${run}`);
      expect(await provisionTypeScript(process.env.TEST_DATABASE_URL_UNPOOLED!, ws)).toBe('READY');
      const t = `${ws.schema}.payroll_record`;
      await admin.query('BEGIN');
      try {
        // Synthetic record without its shift / attendance / staff rows: only the FOREIGN KEY (and guard) triggers are
        // switched off in this rolled-back transaction; the four statement pointer triggers stay on, CHECKs stay on.
        await admin.query(`ALTER TABLE ${t} DISABLE TRIGGER ALL`);
        for (const s of ['ins', 'upd', 'del']) await admin.query(`ALTER TABLE ${t} ENABLE TRIGGER payroll_record_statement_pointer_${s}`);
        const id = randomUUID();
        await admin.query(
          `INSERT INTO ${t} (id, organisation_id, workspace_id, attendance_id, shift_id, staff_profile_id, worked_minutes, pay_rate_pence, amount_pence,
                             status, approved_at, approved_by, statement_status)
           VALUES ($1, $2, $3, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 0, 0, 0, 'approved', now(), gen_random_uuid(), 'pending')`,
          [id, ws.org, ws.id],
        );
        let p = await pointer('statement', id);
        expect(p).toMatchObject({ organisation_id: ws.org, workspace_id: ws.id, due: true });
        await admin.query(`UPDATE ${t} SET statement_status = 'failed', statement_attempts = 2, updated_at = now() WHERE id = $1`, [id]);
        p = await pointer('statement', id);
        expect(Math.round(p!.in_s)).toBeGreaterThanOrEqual(118);
        await admin.query(`UPDATE ${t} SET statement_attempts = 5 WHERE id = $1`, [id]);
        expect(await pointer('statement', id)).toBeUndefined();
      } finally {
        await admin.query('ROLLBACK');
      }
    });
  });

  describe('wake-up hint (D2, E-1)', () => {
    const listen = async (fn: (got: readonly string[]) => Promise<void>) => {
      const got: string[] = [];
      const listener = await connect(WORKER_URL!);
      try {
        listener.on('notification', (n) => {
          if (n.channel === 'crewflow_worker_wake') got.push(String(n.payload));
        });
        await listener.query('LISTEN crewflow_worker_wake');
        await fn(got);
        await new Promise((r) => setTimeout(r, 500));
        return got;
      } finally {
        await listener.end();
      }
    };

    it('default (setting unset / off): a due-now write sends NO notification at all', async () => {
      const got = await listen(async () => {
        await insertEmail(a.org);
      });
      expect(got).toEqual([]);
    });

    it('with crewflow.dispatch_notify = on: label only, after commit only, folded once per transaction', async () => {
      const seenBeforeCommit: string[] = [];
      const got = await listen(async (soFar) => {
        await app.query('BEGIN');
        await app.query(`SELECT set_config('crewflow.dispatch_notify', 'on', true), set_config('rab.organisation_id', $1, true)`, [a.org]);
        for (let i = 0; i < 3; i += 1) {
          await app.query(`INSERT INTO core.email_outbox (organisation_id, job_type, status, recipient_email, rendered_subject) VALUES ($1, 'NOTIFICATION', 'PENDING', $2, 'x')`, [a.org, `n${i}-${run}@phase-d.invalid`]);
        }
        await new Promise((r) => setTimeout(r, 300));
        seenBeforeCommit.push(...soFar);
        await app.query('COMMIT');
      });
      expect(seenBeforeCommit).toEqual([]);
      expect(got).toEqual(['email']);
    });

    it('wave 2 / poll mode: any value other than exactly on (off, true, 1, ON) sends nothing; nor does a realtime write', async () => {
      for (const v of ['off', 'true', '1', 'ON']) {
        const got = await listen(async () => {
          await app.query('BEGIN');
          await app.query(`SELECT set_config('crewflow.dispatch_notify', $1, true), set_config('rab.organisation_id', $2, true)`, [v, a.org]);
          await app.query(`INSERT INTO core.email_outbox (organisation_id, job_type, status, recipient_email, rendered_subject) VALUES ($1, 'NOTIFICATION', 'PENDING', $2, 'x')`, [
            a.org,
            `v-${randomUUID()}@phase-d.invalid`,
          ]);
          await app.query('COMMIT');
        });
        expect(got).toEqual([]);
      }
      expect(
        await listen(async () => {
          await insertRealtime(a);
        }),
      ).toEqual([]);
    });

    it('wave 2 / event mode: exactly the queue labels of due-now writes (email + realtime → two labels), nothing for a not-yet-due write', async () => {
      const got = await listen(async () => {
        await app.query('BEGIN');
        await app.query(`SELECT set_config('crewflow.dispatch_notify', 'on', true), set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true)`, [a.org, a.id]);
        await app.query(`INSERT INTO core.email_outbox (organisation_id, job_type, status, recipient_email, rendered_subject) VALUES ($1, 'NOTIFICATION', 'PENDING', $2, 'x')`, [
          a.org,
          `e-${randomUUID()}@phase-d.invalid`,
        ]);
        await app.query(
          `INSERT INTO core.realtime_event (organisation_id, workspace_id, event_key, event_type, entity_type, entity_id, status) VALUES ($1, $2, $3, 'phase_d.test', 'shift', gen_random_uuid(), 'pending')`,
          [a.org, a.id, `pd-${randomUUID()}`],
        );
        await app.query('COMMIT');
      });
      expect([...got].sort()).toEqual(['email', 'realtime']);
      const later = await listen(async () => {
        await app.query('BEGIN');
        await app.query(`SELECT set_config('crewflow.dispatch_notify', 'on', true), set_config('rab.organisation_id', $1, true)`, [a.org]);
        await app.query(
          `INSERT INTO core.email_outbox (organisation_id, job_type, status, recipient_email, rendered_subject, queued_at) VALUES ($1, 'NOTIFICATION', 'QUEUED', $2, 'x', now())`,
          [a.org, `q-${randomUUID()}@phase-d.invalid`],
        );
        await app.query('COMMIT');
      });
      expect(later).toEqual([]);
    });
  });

  describe('re-review N-1 / N-2 (rolled back)', () => {
    it('N-1: another rab_secure_owner definer naming core.payroll_record is still an R4 addition, even after 1786721320000', async () => {
      await admin.query('BEGIN');
      try {
        await admin.query(`CREATE FUNCTION core.pd_r4_probe() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
                           AS $p$ SELECT count(*)::int FROM core.payroll_record $p$`);
        await admin.query('ALTER FUNCTION core.pd_r4_probe() OWNER TO rab_secure_owner');
        const r4 = (await admin.query(R4_TABLES_SQL)).rows.map((r: { relname: string }) => r.relname);
        expect(r4).toContain('payroll_record');
        const violations = await secureOwnerInvariantViolations(async (sql) => (await admin.query(sql)).rows);
        expect(violations).toContain('r4-table-added|payroll_record|not in the reviewed list');
        // and the four reviewed pairs themselves are present and bound (required once their functions exist)
        expect((await admin.query(R4_PHASE_D_MISSING_PAIRS_SQL)).rows).toEqual([]);
      } finally {
        await admin.query('ROLLBACK');
      }
    });

    it('N-2: crewflow-created workspace_<unprovisioned id>.payroll_record: insert and TRUNCATE both refused, no pointer change', async () => {
      if (!crewflow) return;
      const ghost = await seedWorkspace(admin, `pd-ghost-${run}`); // CREATING, never provisioned: no schema exists
      await crewflow.query('BEGIN');
      try {
        await crewflow.query(`CREATE SCHEMA ${ghost.schema}`); // crewflow has CREATE on the database; it owns this schema
        await crewflow.query(`CREATE TABLE ${ghost.schema}.payroll_record (id uuid, organisation_id uuid, workspace_id uuid, status text,
                                statement_status text, statement_file_id uuid, statement_attempts int, statement_queued_at timestamptz,
                                statement_processing_at timestamptz, updated_at timestamptz)`);
        await crewflow.query(`CREATE TRIGGER f AFTER INSERT ON ${ghost.schema}.payroll_record FOR EACH ROW EXECUTE FUNCTION core.worker_dispatch_pointer_statement_trg()`);
        await crewflow.query(`CREATE TRIGGER t AFTER TRUNCATE ON ${ghost.schema}.payroll_record FOR EACH STATEMENT EXECUTE FUNCTION core.worker_dispatch_pointer_statement_trg()`);
        await crewflow.query('SAVEPOINT s');
        expect(
          await sqlstateOf(crewflow.query(`INSERT INTO ${ghost.schema}.payroll_record VALUES (gen_random_uuid(), $1, $2, 'approved', 'pending', NULL, 0, NULL, NULL, now())`, [ghost.org, ghost.id])),
        ).toBe('42501');
        await crewflow.query('ROLLBACK TO SAVEPOINT s');
        expect(await sqlstateOf(crewflow.query(`TRUNCATE ${ghost.schema}.payroll_record`))).toBe('42501');
      } finally {
        await crewflow.query('ROLLBACK');
      }
    });
  });

  // ===================================================================================================================
  // Phase D wave 2 — coverage audit against the owner's lists (same opt-in as the rest of this suite).
  // ===================================================================================================================

  describe('wave 2 / 1786721300000: ownership, hardened search_path, FORCE RLS, exact grants (catalog = migration post-conditions)', () => {
    it('pointer table: owner rab_secure_owner, ENABLE + FORCE RLS, owner-only + runtime-deny policies, no non-owner ACL; functions owned, search_path pinned, EXECUTE crewflow_worker only', async () => {
      expect((await admin.query(WORKER_DISPATCH_POINTER_STATE_SQL)).rows[0]).toEqual(WORKER_DISPATCH_POINTER_EXPECTED_STATE);
      const lines = (await admin.query(workerDispatchPrivilegeChecksSql())).rows.map((r: { line: string }) => r.line).sort();
      expect(lines).toEqual(expectedWorkerDispatchPrivilegeLines());
    });

    it('trigger functions: owner, DEFINER, search_path, exact EXECUTE ACL (statement: + crewflow, the reviewed trade-off); twelve outbox triggers ENABLED', async () => {
      expect((await admin.query(OUTBOX_FUNCTIONS_STATE_SQL)).rows[0].functions).toBe(OUTBOX_FUNCTIONS_EXPECTED);
      expect((await admin.query(OUTBOX_TRIGGERS_STATE_SQL)).rows[0].triggers).toBe(OUTBOX_TRIGGERS_EXPECTED);
      expect((await admin.query(STATEMENT_FUNCTION_STATE_SQL)).rows[0]).toEqual(STATEMENT_FUNCTION_EXPECTED);
    });

    // P-class (owner-login architecture): the schema role crewflow_app (the old API login) cannot execute any claim or the
    // release, even inside a tenant context (42501). The one runtime login can: catalogue BC-08 (NEEDS OWNER APPROVAL),
    // asserted inside rolled-back transactions so nothing is leased.
    it('the schema role crewflow_app cannot execute any claim or the release, even inside a tenant context (42501); the runtime login can (BC-08)', async () => {
      const fn = { email: 'worker_claim_email_dispatch', push: 'worker_claim_push_dispatch', realtime: 'worker_claim_realtime_publish', statement: 'worker_claim_statement_dispatch' };
      for (const q of ['email', 'push', 'realtime', 'statement'] as const) {
        // sql-injection-reviewed: fn[q] comes from the constant map above
        expect({ q, code: await asSchemaRole('crewflow_app', `SELECT * FROM core.${fn[q]}(1)`, [], a.org, a.id) }).toEqual({ q, code: '42501' });
        expect({ q, code: await runtimeRolledBack(app, () => claim(app, q, 1), a.org, a.id) }).toEqual({ q, code: 'ACCEPTED' });
      }
      const release = `SELECT core.worker_release_dispatch_claim('email', gen_random_uuid(), gen_random_uuid(), 1)`;
      expect(await asSchemaRole('crewflow_app', release, [], a.org)).toBe('42501');
      expect(await runtimeRolledBack(app, () => app.query(release), a.org)).toBe('ACCEPTED');
    });

    it('the pointer table carries routing ids only: exactly the reviewed columns, no payload / recipient / content column', async () => {
      const { rows } = await admin.query(
        `SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' ORDER BY attnum) AS cols FROM pg_attribute
          WHERE attrelid = 'core.worker_dispatch_pointer'::regclass AND attnum > 0 AND NOT attisdropped`,
      );
      expect(rows[0].cols).toBe(
        'queue:text,subject_id:uuid,organisation_id:uuid,workspace_id:uuid,due_at:timestamp with time zone,claim_token:uuid,' +
          'claim_count:integer,claimed_at:timestamp with time zone,repoint_count:integer,updated_at:timestamp with time zone,' +
          // F2 (StatementPointerPhysicalIdentity1786721350000): the source row's schema, a routing id like the others.
          'source_schema:text',
      );
    });
  });

  describe('wave 2 / 1786721300000: a forged or cross-tenant pointer row is refused by the table itself (rolled back, as rab_secure_owner)', () => {
    const insertAsOwner = (queue: string, org: string, ws: string | null, extraCol = '', extraVal = '') =>
      rolledBack(async () => {
        await admin.query('SET LOCAL ROLE rab_secure_owner');
        return stateIn(
          admin,
          `INSERT INTO core.worker_dispatch_pointer (queue, subject_id, organisation_id, workspace_id, due_at${extraCol}) VALUES ($1, gen_random_uuid(), $2, $3, now()${extraVal})`,
          [queue, org, ws],
        );
      });

    it('control: a consistent realtime pointer (organisation A, workspace A) is accepted', async () => {
      expect(await insertAsOwner('realtime', a.org, a.id)).toBe('ACCEPTED');
    });

    it("wrong organisation/workspace pairing (A with B's workspace) → composite FK 23503", async () => {
      expect(await insertAsOwner('realtime', a.org, b.id)).toBe('23503');
      expect(await insertAsOwner('statement', a.org, b.id)).toBe('23503');
    });

    it('an organisation that does not exist → FK 23503', async () => {
      expect(await insertAsOwner('email', randomUUID(), null)).toBe('23503');
    });

    it('scope shape: email/push with a workspace, statement without one, an unknown queue → CHECK 23514', async () => {
      expect(await insertAsOwner('email', a.org, a.id)).toBe('23514');
      expect(await insertAsOwner('push', a.org, a.id)).toBe('23514');
      expect(await insertAsOwner('statement', a.org, null)).toBe('23514');
      expect(await insertAsOwner('bogus', a.org, null)).toBe('23514');
    });

    it('claim bookkeeping: a token without claimed_at, a negative claim_count / repoint_count → CHECK 23514', async () => {
      expect(await insertAsOwner('email', a.org, null, ', claim_token', ', gen_random_uuid()')).toBe('23514');
      expect(await insertAsOwner('email', a.org, null, ', claim_count', ', -1')).toBe('23514');
      expect(await insertAsOwner('email', a.org, null, ', repoint_count', ', -1')).toBe('23514');
    });

    it("a forged realtime pointer (organisation A for B's event) finds nothing under A's context; B's event is untouched", async () => {
      const victim = await insertRealtime(b);
      await admin.query('BEGIN');
      try {
        await admin.query('SET LOCAL ROLE rab_secure_owner');
        await admin.query(
          `UPDATE core.worker_dispatch_pointer SET organisation_id = $1, workspace_id = $2, due_at = now() WHERE queue = 'realtime' AND subject_id = $3`,
          [a.org, a.id, victim],
        );
        await admin.query('COMMIT');
      } catch (e) {
        await admin.query('ROLLBACK');
        throw e;
      }
      const forged = (await claim(worker, 'realtime', 200)).find((r) => r.subject_id === victim)!;
      expect(forged).toMatchObject({ organisation_id: a.org, workspace_id: a.id });
      const seen = await asTenant(worker, forged.organisation_id, forged.workspace_id, () =>
        worker.query(`SELECT id FROM core.realtime_event WHERE id = $1 FOR UPDATE SKIP LOCKED`, [victim]),
      );
      expect(seen.rows).toEqual([]);
      expect((await admin.query(`SELECT status, attempt_count FROM core.realtime_event WHERE id = $1`, [victim])).rows[0]).toEqual({ status: 'pending', attempt_count: 0 });
    });
  });

  describe('wave 2 / 1786721300000: concurrency, SKIP LOCKED, batch and release clamps', () => {
    it('a claim never waits on, and never shares, pointers another session is claiming (SKIP LOCKED; distinct tokens; one owner each)', async () => {
      const c = await seedWorkspace(admin, `pd-skip-${run}`);
      const ids = new Set<string>();
      for (let i = 0; i < 5; i += 1) ids.add(await insertEmail(c.org));
      let first: Awaited<ReturnType<typeof claim>> = [];
      await worker.query('BEGIN');
      try {
        first = (await claim(worker, 'email', 200)).filter((r) => ids.has(r.subject_id));
        expect(first.length).toBeGreaterThan(0);
        // worker's claim UPDATE is uncommitted, so those pointer rows are locked: worker2 must neither block nor get them.
        await worker2.query(`SET statement_timeout = '5s'`);
        const second = (await claim(worker2, 'email', 200)).filter((r) => ids.has(r.subject_id));
        await worker2.query('RESET statement_timeout');
        const firstIds = new Set(first.map((r) => r.subject_id));
        expect(second.filter((r) => firstIds.has(r.subject_id))).toEqual([]);
        if (second.length > 0) expect(second[0]!.claim_token).not.toBe(first[0]!.claim_token);
        await worker.query('COMMIT');
      } catch (e) {
        await worker.query('ROLLBACK');
        throw e;
      }
      for (const r of first) expect((await pointer('email', r.subject_id))!.claim_token).toBe(r.claim_token);
      expect(new Set(first.map((r) => r.claim_token)).size).toBe(first.length); // one token per claimed row (F2, 1786721350000)
    });

    it('batch clamp lower bound: 0 and a negative value → at most 1 row; NULL → the default (≤ 100)', async () => {
      const c = await seedWorkspace(admin, `pd-clamp-${run}`);
      for (let i = 0; i < 3; i += 1) await insertEmail(c.org);
      for (const n of [0, -5]) expect((await worker.query('SELECT * FROM core.worker_claim_email_dispatch($1)', [n])).rows.length).toBeLessThanOrEqual(1);
      expect((await worker.query('SELECT * FROM core.worker_claim_email_dispatch(NULL)')).rows.length).toBeLessThanOrEqual(100);
    });

    it('release clamp lower bound: 0 / negative → 1 s; NULL → 30 s; a NULL token or a wrong queue releases nothing', async () => {
      const id = await insertEmail((await seedWorkspace(admin, `pd-rel-${run}`)).org);
      const mine = (await claim(worker, 'email', 200)).find((r) => r.subject_id === id)!;
      expect((await worker.query(`SELECT core.worker_release_dispatch_claim('push', $1, $2, 1) AS ok`, [id, mine.claim_token])).rows[0].ok).toBe(false);
      expect((await worker.query(`SELECT core.worker_release_dispatch_claim('email', $1, NULL, 1) AS ok`, [id])).rows[0].ok).toBe(false);
      expect((await worker.query(`SELECT core.worker_release_dispatch_claim('email', $1, $2, -10) AS ok`, [id, mine.claim_token])).rows[0].ok).toBe(true);
      const p = (await pointer('email', id))!;
      expect(p.in_s).toBeGreaterThan(0);
      expect(p.in_s).toBeLessThanOrEqual(1.5);
      await new Promise((r) => setTimeout(r, 1200));
      const again = (await claim(worker, 'email', 200)).find((r) => r.subject_id === id)!;
      expect((await worker.query(`SELECT core.worker_release_dispatch_claim('email', $1, $2, NULL) AS ok`, [id, again.claim_token])).rows[0].ok).toBe(true);
      expect(Math.round((await pointer('email', id))!.in_s)).toBeGreaterThanOrEqual(29);
    });
  });

  describe('wave 2 / 1786721310000: producer transaction, scope changes, DELETE / TRUNCATE consistency, normal writes', () => {
    it('the pointer is written INSIDE the producer transaction (visible to it, invisible to others before commit); ROLLBACK removes the row AND the pointer', async () => {
      const id = randomUUID();
      const other = await connect(process.env.TEST_DATABASE_URL_UNPOOLED!);
      try {
        await admin.query('BEGIN');
        try {
          await admin.query(
            `INSERT INTO core.email_outbox (id, organisation_id, job_type, status, recipient_email, rendered_subject) VALUES ($1, $2, 'NOTIFICATION', 'PENDING', 'tx@phase-d.invalid', 'x')`,
            [id, a.org],
          );
          const inTx = await admin.query(
            `SELECT organisation_id, workspace_id, (due_at <= now()) AS due FROM core.worker_dispatch_pointer WHERE queue = 'email' AND subject_id = $1`,
            [id],
          );
          expect(inTx.rows).toEqual([{ organisation_id: a.org, workspace_id: null, due: true }]);
          expect((await other.query(`SELECT count(*)::int AS n FROM core.worker_dispatch_pointer WHERE queue = 'email' AND subject_id = $1`, [id])).rows[0].n).toBe(0);
        } finally {
          await admin.query('ROLLBACK');
        }
      } finally {
        await other.end();
      }
      expect(await pointer('email', id)).toBeUndefined();
      expect((await admin.query('SELECT count(*)::int AS n FROM core.email_outbox WHERE id = $1', [id])).rows[0].n).toBe(0);
    });

    it("realtime: a workspace change on UPDATE (to NULL, or to another tenant's workspace) is refused (42501); the pointer keeps its scope", async () => {
      const id = await insertRealtime(a);
      expect(await sqlstateOf(admin.query(`UPDATE core.realtime_event SET workspace_id = NULL WHERE id = $1`, [id]))).toBe('42501');
      expect(await sqlstateOf(admin.query(`UPDATE core.realtime_event SET organisation_id = $1, workspace_id = $2 WHERE id = $3`, [b.org, b.id, id]))).toBe('42501');
      expect(await pointer('realtime', id)).toMatchObject({ organisation_id: a.org, workspace_id: a.id });
    });

    it("DELETE of an open row removes its pointer; TRUNCATE core.email_outbox removes every email pointer and no other queue's", async () => {
      const id = await insertEmail(a.org);
      const rt = await insertRealtime(a);
      await admin.query('DELETE FROM core.email_outbox WHERE id = $1', [id]);
      expect(await pointer('email', id)).toBeUndefined();
      const id2 = await insertEmail(a.org);
      await rolledBack(async () => {
        await admin.query('TRUNCATE core.email_outbox');
        expect((await admin.query(`SELECT count(*)::int AS n FROM core.worker_dispatch_pointer WHERE queue = 'email'`)).rows[0].n).toBe(0);
        expect(await pointer('realtime', rt)).toBeDefined();
      });
      expect(await pointer('email', id2)).toBeDefined(); // rolled back: nothing lost
    });

    it('normal producer writes still work as the API login: realtime (tenant + workspace context) and push (tenant context)', async () => {
      const rt = await insertRealtime(a);
      expect(await pointer('realtime', rt)).toMatchObject({ organisation_id: a.org, workspace_id: a.id, due: true, claim_token: null });
      const notificationId = randomUUID();
      const deviceId = randomUUID();
      await admin.query(`INSERT INTO core.notification (id, organisation_id, user_id, type, title, message) VALUES ($1, $2, $3, 'TEST', 't', 'm')`, [notificationId, a.org, a.owner]);
      const envelope = Buffer.concat([Buffer.from('RAB2'), Buffer.from([1]), Buffer.from('x'), Buffer.alloc(40, 7)]);
      await admin.query(`INSERT INTO core.push_device (id, organisation_id, user_id, device_id, platform, push_token_encrypted) VALUES ($1, $2, $3, $4, 'ios', $5)`, [
        deviceId,
        a.org,
        a.owner,
        `pd-${deviceId}`,
        envelope,
      ]);
      try {
        const pushId = await asTenant(app, a.org, null, async () => {
          const { rows } = await app.query(
            `INSERT INTO core.push_delivery (organisation_id, notification_id, push_device_id, status) VALUES ($1, $2, $3, 'PENDING') RETURNING id`,
            [a.org, notificationId, deviceId],
          );
          return rows[0].id as string;
        });
        expect(await pointer('push', pushId)).toMatchObject({ organisation_id: a.org, workspace_id: null, due: true });
        await asTenant(app, a.org, null, () => app.query(`UPDATE core.push_delivery SET status = 'CANCELLED', cancelled_at = now() WHERE id = $1`, [pushId]));
        expect(await pointer('push', pushId)).toBeUndefined();
      } finally {
        // The synthetic envelope is deliberately undecryptable; a committed copy would fail any later whole-database
        // ciphertext scan (secret-rotation-wave5's retire gate). Remove everything this test committed.
        await admin.query(`DELETE FROM core.push_delivery WHERE push_device_id = $1`, [deviceId]);
        await admin.query(`DELETE FROM core.push_device WHERE id = $1`, [deviceId]);
        await admin.query(`DELETE FROM core.notification WHERE id = $1`, [notificationId]);
      }
    });

    it('source-table / schema checks: an outbox function fired anywhere but AFTER ROW on its own core table refuses the write (42501)', async () => {
      const cols = '(id uuid, organisation_id uuid, status text, queued_at timestamptz, processing_at timestamptz, updated_at timestamptz)';
      await rolledBack(async () => {
        await admin.query(`CREATE TABLE public.pd_src_${run} ${cols}`);
        await admin.query(`CREATE TRIGGER f AFTER INSERT ON public.pd_src_${run} FOR EACH ROW EXECUTE FUNCTION core.worker_dispatch_pointer_email_trg()`);
        expect(await stateIn(admin, `INSERT INTO public.pd_src_${run} VALUES (gen_random_uuid(), $1, 'PENDING', NULL, NULL, now())`, [a.org])).toBe('42501');
        // A table NAMED email_outbox outside core.
        await admin.query(`CREATE TABLE public.email_outbox ${cols}`);
        await admin.query(`CREATE TRIGGER f AFTER INSERT ON public.email_outbox FOR EACH ROW EXECUTE FUNCTION core.worker_dispatch_pointer_email_trg()`);
        expect(await stateIn(admin, `INSERT INTO public.email_outbox VALUES (gen_random_uuid(), $1, 'PENDING', NULL, NULL, now())`, [a.org])).toBe('42501');
        // Its own table, but BEFORE, or FOR EACH STATEMENT on INSERT.
        const ins = `INSERT INTO core.email_outbox (organisation_id, job_type, status, recipient_email, rendered_subject) VALUES ($1, 'NOTIFICATION', 'PENDING', 'src@phase-d.invalid', 'x')`;
        await admin.query(`CREATE TRIGGER pd_before BEFORE INSERT ON core.email_outbox FOR EACH ROW EXECUTE FUNCTION core.worker_dispatch_pointer_email_trg()`);
        expect(await stateIn(admin, ins, [a.org])).toBe('42501');
        await admin.query('DROP TRIGGER pd_before ON core.email_outbox');
        await admin.query(`CREATE TRIGGER pd_stmt AFTER INSERT ON core.email_outbox FOR EACH STATEMENT EXECUTE FUNCTION core.worker_dispatch_pointer_email_trg()`);
        expect(await stateIn(admin, ins, [a.org])).toBe('42501');
      });
    });
  });

  describe('wave 2 / E-5: a disabled, missing or re-pointed trigger, and an unauthorised attachment, are detected (rolled back)', () => {
    const postureLines = async () => (await admin.query(POSTURE_QUERY)).rows.map((r: { line: string }) => r.line);
    const problems = () => dispatchTriggerProblems(async (sql, params) => (await admin.query(sql, params as unknown[] | undefined)).rows);

    it("baseline: check-rls-coverage's trigger check reports nothing", async () => {
      expect(await problems()).toEqual([]);
    });

    it.each([
      ['DISABLE', 'email_outbox', 'email_outbox_dispatch_pointer_ins', 'worker_dispatch_pointer_email_trg()', 'ALTER TABLE core.email_outbox DISABLE TRIGGER email_outbox_dispatch_pointer_ins', 'D'],
      ['ENABLE REPLICA', 'realtime_event', 'realtime_event_dispatch_pointer_upd', 'worker_dispatch_pointer_realtime_trg()', 'ALTER TABLE core.realtime_event ENABLE REPLICA TRIGGER realtime_event_dispatch_pointer_upd', 'R'],
      ['DROP', 'push_delivery', 'push_delivery_dispatch_pointer_trunc', 'worker_dispatch_pointer_push_trg()', 'DROP TRIGGER push_delivery_dispatch_pointer_trunc ON core.push_delivery', null],
      ['DISABLE', 'payroll_record', 'payroll_record_statement_pointer_del', 'worker_dispatch_pointer_statement_trg()', 'ALTER TABLE core.payroll_record DISABLE TRIGGER payroll_record_statement_pointer_del', 'D'],
    ] as const)('%s core.%s.%s → check-rls problem + posture drift', async (_verb, table, trg, fn, ddl, state) => {
      const reviewed = `trigger|${table}|${trg}|enabled=O|${fn}`;
      expect(await postureLines()).toContain(reviewed);
      await rolledBack(async () => {
        await admin.query(ddl);
        expect((await problems()).some((p) => p.startsWith(`core.${table}: dispatch pointer triggers are [`))).toBe(true);
        const after = await postureLines();
        expect(after).not.toContain(reviewed);
        if (state) expect(after).toContain(`trigger|${table}|${trg}|enabled=${state}|${fn}`);
      });
    });

    it('a workspace payroll table with a disabled statement trigger is reported for that schema', async () => {
      const ws = await seedWorkspace(admin, `pd-e5-${run}`);
      expect(await provisionTypeScript(process.env.TEST_DATABASE_URL_UNPOOLED!, ws)).toBe('READY');
      await rolledBack(async () => {
        await admin.query(`ALTER TABLE ${ws.schema}.payroll_record DISABLE TRIGGER payroll_record_statement_pointer_upd`);
        expect((await problems()).some((p) => p.startsWith(`${ws.schema}.payroll_record: dispatch pointer triggers are [`))).toBe(true);
      });
    });

    it('a reviewed trigger NAME firing another function is reported by both checks', async () => {
      await rolledBack(async () => {
        await admin.query('DROP TRIGGER email_outbox_dispatch_pointer_upd ON core.email_outbox');
        await admin.query(`CREATE TRIGGER email_outbox_dispatch_pointer_upd AFTER UPDATE ON core.email_outbox FOR EACH ROW EXECUTE FUNCTION core.worker_dispatch_pointer_push_trg()`);
        expect((await problems()).some((p) => p.startsWith('core.email_outbox: dispatch pointer triggers are ['))).toBe(true);
        expect(await secureOwnerInvariantViolations(async (sql) => (await admin.query(sql)).rows)).toContain(
          'secure-trigger-attachment-added|core.email_outbox.email_outbox_dispatch_pointer_upd|core.worker_dispatch_pointer_push_trg() fires as rab_secure_owner on a table it does not own; not in the reviewed list',
        );
      });
    });

    it('an unauthorised attachment of the statement function (core.shift) is a posture line AND a secure-owner invariant violation', async () => {
      await rolledBack(async () => {
        await admin.query(`CREATE TRIGGER pd_unreviewed AFTER INSERT ON core.shift FOR EACH ROW EXECUTE FUNCTION core.worker_dispatch_pointer_statement_trg()`);
        expect(await postureLines()).toContain('trigger|shift|pd_unreviewed|enabled=O|worker_dispatch_pointer_statement_trg()');
        expect(await secureOwnerInvariantViolations(async (sql) => (await admin.query(sql)).rows)).toContain(
          'secure-trigger-attachment-added|core.shift.pd_unreviewed|core.worker_dispatch_pointer_statement_trg() fires as rab_secure_owner on a table it does not own; not in the reviewed list',
        );
      });
    });
  });

  describe('wave 2 / 1786721320000 adversarial (synthetic; FK and guard triggers off only where noted)', () => {
    const PAYROLL_COLS = `(id, organisation_id, workspace_id, attendance_id, shift_id, staff_profile_id, worked_minutes, pay_rate_pence, amount_pence,
                           status, approved_at, approved_by, statement_status)`;
    const PAYROLL_VALS = `($1, $2, $3, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 0, 0, 0, 'approved', now(), gen_random_uuid(), 'pending')`;

    it('core.payroll_record: a row whose workspace belongs to another organisation is refused (42501), no pointer', async () => {
      const id = randomUUID();
      await rolledBack(async () => {
        await admin.query('ALTER TABLE core.payroll_record DISABLE TRIGGER ALL');
        await admin.query('ALTER TABLE core.payroll_record ENABLE TRIGGER payroll_record_statement_pointer_ins');
        expect(await stateIn(admin, `INSERT INTO core.payroll_record ${PAYROLL_COLS} VALUES ${PAYROLL_VALS}`, [id, a.org, b.id])).toBe('42501');
        expect(await pointer('statement', id)).toBeUndefined();
      });
    });

    it('a workspace payroll table holding a row of ANOTHER workspace (binding CHECKs dropped) is refused (42501), no pointer', async () => {
      const ws = await seedWorkspace(admin, `pd-bind-${run}`);
      expect(await provisionTypeScript(process.env.TEST_DATABASE_URL_UNPOOLED!, ws)).toBe('READY');
      const t = `${ws.schema}.payroll_record`;
      const id = randomUUID();
      await rolledBack(async () => {
        await admin.query(`ALTER TABLE ${t} DISABLE TRIGGER ALL`);
        await admin.query(`ALTER TABLE ${t} ENABLE TRIGGER payroll_record_statement_pointer_ins`);
        const { rows } = await admin.query(
          `SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ~ '(workspace_id|organisation_id)'`,
          [t],
        );
        for (const r of rows) await admin.query(`ALTER TABLE ${t} DROP CONSTRAINT "${r.conname}"`);
        expect(await stateIn(admin, `INSERT INTO ${t} ${PAYROLL_COLS} VALUES ${PAYROLL_VALS}`, [id, b.org, b.id])).toBe('42501');
        expect(await pointer('statement', id)).toBeUndefined();
      });
    });

    it("a forged statement pointer (A's scope on B's record) causes no cross-tenant processing", async () => {
      const wa = await seedWorkspace(admin, `pd-fsa-${run}`);
      const wb = await seedWorkspace(admin, `pd-fsb-${run}`);
      for (const w of [wa, wb]) expect(await provisionTypeScript(process.env.TEST_DATABASE_URL_UNPOOLED!, w)).toBe('READY');
      const victim = randomUUID();
      const tb = `${wb.schema}.payroll_record`;
      // A committed synthetic record in B (only its FK / guard triggers are off for the insert; all re-enabled before commit).
      await admin.query('BEGIN');
      try {
        await admin.query(`ALTER TABLE ${tb} DISABLE TRIGGER ALL`);
        for (const s of ['ins', 'upd', 'del', 'trunc']) await admin.query(`ALTER TABLE ${tb} ENABLE TRIGGER payroll_record_statement_pointer_${s}`);
        await admin.query(`INSERT INTO ${tb} ${PAYROLL_COLS} VALUES ${PAYROLL_VALS}`, [victim, wb.org, wb.id]);
        await admin.query(`ALTER TABLE ${tb} ENABLE TRIGGER ALL`);
        await admin.query('SET LOCAL ROLE rab_secure_owner');
        // F2 (1786721350000): a pointer naming A's workspace with B's source schema is refused by the table itself.
        expect(
          await stateIn(
            admin,
            `UPDATE core.worker_dispatch_pointer SET organisation_id = $1, workspace_id = $2, due_at = now() WHERE queue = 'statement' AND subject_id = $3`,
            [wa.org, wa.id, victim],
          ),
        ).toBe('23514');
        // The strongest forgery left: a self-consistent pointer (A's scope AND A's source) for B's record id.
        await admin.query(
          `UPDATE core.worker_dispatch_pointer SET organisation_id = $1, workspace_id = $2::uuid, source_schema = 'workspace_' || replace($2::uuid::text, '-', ''), due_at = now()
            WHERE queue = 'statement' AND subject_id = $3`,
          [wa.org, wa.id, victim],
        );
        await admin.query('COMMIT');
      } catch (e) {
        await admin.query('ROLLBACK');
        throw e;
      }
      const forged = (await claim(worker, 'statement', 200)).find((r) => r.subject_id === victim)!;
      expect(forged).toMatchObject({ organisation_id: wa.org, workspace_id: wa.id });
      // Every place the Worker could look, under the POINTER's (forged) context: nothing (no row, no privilege, or no table).
      const seen = await asTenant(worker, forged.organisation_id, forged.workspace_id, async () => {
        const out: string[] = [];
        for (const rel of [`${wa.schema}.payroll_record`, tb, 'core.payroll_record']) {
          const code = await stateIn(worker, `SELECT 1 FROM ${rel} WHERE id = $1`, [victim]);
          out.push(code === 'ACCEPTED' ? `${rel}:${(await worker.query(`SELECT count(*)::int AS n FROM ${rel} WHERE id = $1`, [victim])).rows[0].n}` : `${rel}:${code}`);
        }
        return out;
      });
      for (const line of seen) expect(line).toMatch(/:(0|42501|42P01)$/);
      expect((await admin.query(`SELECT statement_status, statement_attempts FROM ${tb} WHERE id = $1`, [victim])).rows[0]).toEqual({
        statement_status: 'pending',
        statement_attempts: 0,
      });
    });
  });
});
