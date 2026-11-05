import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

import { describeDatabaseUrl } from '../../database/typeorm/core/test-database-guard';
import { sqlstateOf } from './helpers/workspace-fixtures';

/**
 * Phase D / D8 — F-1 regression at the database layer: the account-invite cleanup works on the RUNTIME side (the Worker's
 * login, crewflow_worker) through the three narrow definers of AccountInviteCleanupDefiner1786721340000, and nothing else
 * can reach them.
 *
 * OPT-IN: needs migration 1786721340000 applied (disposable test databases only). Runs only when PHASE_D_SQL_APPROVED=true and
 * TEST_DATABASE_WORKER_URL names a crewflow_worker login on the same disposable database. The end-to-end regression (the
 * real runAccountInviteCleanupCycle on the Worker's RUNTIME DataSource — today a silent no-op) belongs to rab-worker:
 * change request for Agent B in docs/plans/PHASE-D-SQL-GATE.md §1786721340000 (rab-server never imports rab-worker).
 *
 * Failing-first evidence for the defect itself (read-only, main's schema, rab_c1d, 2026-10-31): as crewflow_app with no
 * tenant context, `SELECT count(*) FROM core."user"` = 0 and `FROM core.account_invite` = 0 while the database holds 24
 * users and 38 invites — exactly what the cycle sees today.
 */
const WORKER_URL = process.env.TEST_DATABASE_WORKER_URL;
const RUN = process.env.PHASE_D_SQL_APPROVED === 'true' && Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_DATABASE_URL_UNPOOLED && WORKER_URL);
const describeIfApproved = RUN ? describe : describe.skip;

describeIfApproved('Phase D F-1: account-invite cleanup definers (integration; needs the approved migration)', () => {
  let admin: Client;
  let app: Client;
  let worker: Client;
  let worker2: Client;
  let crewflow: Client | null = null;

  const connect = async (url: string) => {
    const c = new Client({ connectionString: url });
    await c.connect();
    return c;
  };

  /** An organisation with one never-activated user whose 3rd (final) invite expired `expiredDaysAgo` days ago. */
  async function seedExhaustedInvite(opts: { expiredDaysAgo: number; status?: string; cleanupDaysAgo?: number | null }) {
    const tag = randomUUID().slice(0, 8);
    const { rows } = await admin.query(
      `WITH o AS (INSERT INTO core.organisation(name, slug) VALUES ($1::text, $1::text) RETURNING id),
            u AS (INSERT INTO core."user"(organisation_id, email, first_name, last_name, status)
                  SELECT id, $1::text || '@phase-d-f1.invalid', 'F', 'One', $2::text FROM o RETURNING id, organisation_id)
       INSERT INTO core.account_invite (organisation_id, user_id, token_hash, send_number, expires_at, cleanup_at)
       SELECT organisation_id, id, md5(random()::text || clock_timestamp()::text), 3, now() - make_interval(days => $3::int),
              CASE WHEN $4::int IS NULL THEN NULL ELSE now() - make_interval(days => $4::int) END
         FROM u RETURNING user_id, organisation_id`,
      [`pdf1-${tag}`, opts.status ?? 'invited', opts.expiredDaysAgo, opts.cleanupDaysAgo === undefined ? null : opts.cleanupDaysAgo],
    );
    return rows[0] as { user_id: string; organisation_id: string };
  }

  const statusOf = async (userId: string) => (await admin.query(`SELECT status FROM core."user" WHERE id = $1`, [userId])).rows[0]?.status as string | undefined;

  beforeAll(async () => {
    const adminUrl = process.env.TEST_DATABASE_URL_UNPOOLED!;
    const t = describeDatabaseUrl(adminUrl, 'TEST_DATABASE_URL_UNPOOLED');
    const w = describeDatabaseUrl(WORKER_URL!, 'TEST_DATABASE_WORKER_URL');
    if (w.database !== t.database || w.host !== t.host || w.port !== t.port) throw new Error('TEST_DATABASE_WORKER_URL names another database. Refusing.');
    admin = await connect(adminUrl);
    app = await connect(process.env.TEST_DATABASE_URL!);
    worker = await connect(WORKER_URL!);
    worker2 = await connect(WORKER_URL!);
    if (process.env.TEST_DATABASE_CREWFLOW_URL) crewflow = await connect(process.env.TEST_DATABASE_CREWFLOW_URL);
  });

  afterAll(async () => {
    for (const c of [app, worker, worker2, crewflow, admin]) await c?.end().catch(() => undefined);
  });

  // P-class (owner-login architecture): the schema role crewflow_app (the old API login) still cannot reach any of the three
  // definers (42501; fixture superuser + SET LOCAL ROLE, rolled back). The one runtime login inherits their owner and can:
  // catalogue BC-08 (DBA-01 lost, ACCEPTED (owner, 2026-11-05)), asserted inside a rolled-back transaction so nothing expires or is
  // deleted.
  it('the schema role crewflow_app cannot reach any of the three definers (42501); the runtime login can (BC-08, rolled back)', async () => {
    const calls = [
      'SELECT * FROM core.worker_expire_account_invites(1)',
      'SELECT * FROM core.worker_account_invite_cleanup_candidates(1, NULL, NULL)',
      'SELECT core.worker_delete_expired_invited_user(gen_random_uuid())',
    ];
    for (const sql of calls) {
      await admin.query('BEGIN');
      try {
        await admin.query(`SELECT set_config('role', 'crewflow_app', true)`);
        expect({ sql, code: await sqlstateOf(admin.query(sql)) }).toEqual({ sql, code: '42501' });
      } finally {
        await admin.query('ROLLBACK').catch(() => undefined);
      }
      await app.query('BEGIN');
      try {
        expect({ sql, code: await sqlstateOf(app.query(sql)) }).toEqual({ sql, code: 'ACCEPTED' });
      } finally {
        await app.query('ROLLBACK').catch(() => undefined);
      }
    }
  });

  it('expire: the Worker login, with NO tenant context, moves an exhausted, expired, unaccepted invite to invite_expired', async () => {
    const s = await seedExhaustedInvite({ expiredDaysAgo: 1 });
    const fresh = await seedExhaustedInvite({ expiredDaysAgo: -1 }); // not expired yet
    // Before the fix this is exactly what the cycle sees on the runtime login: nothing.
    expect((await worker.query(`SELECT count(*)::int AS n FROM core."user" WHERE id = $1`, [s.user_id])).rows[0].n).toBe(0);
    const { rows } = await worker.query('SELECT * FROM core.worker_expire_account_invites(500)');
    expect(rows).toContainEqual({ user_id: s.user_id, organisation_id: s.organisation_id });
    expect(rows.some((r: { user_id: string }) => r.user_id === fresh.user_id)).toBe(false);
    expect(await statusOf(s.user_id)).toBe('invite_expired');
    expect(await statusOf(fresh.user_id)).toBe('invited');
  });

  it('candidates and delete: after the grace period an exhausted account is listed, re-checked under lock and deleted', async () => {
    const s = await seedExhaustedInvite({ expiredDaysAgo: 9, status: 'invite_expired', cleanupDaysAgo: 2 });
    const grace = await seedExhaustedInvite({ expiredDaysAgo: 2, status: 'invite_expired', cleanupDaysAgo: -5 }); // grace not over
    const { rows } = await worker.query('SELECT * FROM core.worker_account_invite_cleanup_candidates(50, NULL, NULL)');
    expect(rows.find((r: { user_id: string }) => r.user_id === s.user_id)).toMatchObject({ organisation_id: s.organisation_id, blocking_reason: null });
    expect(rows.some((r: { user_id: string }) => r.user_id === grace.user_id)).toBe(false);
    expect((await worker.query('SELECT core.worker_delete_expired_invited_user($1) AS r', [grace.user_id])).rows[0].r).toBe('not_eligible');
    expect((await worker.query('SELECT core.worker_delete_expired_invited_user($1) AS r', [s.user_id])).rows[0].r).toBe('deleted');
    expect(await statusOf(s.user_id)).toBeUndefined();
    expect((await admin.query('SELECT count(*)::int AS n FROM core.account_invite WHERE user_id = $1', [s.user_id])).rows[0].n).toBe(0);
  });

  it('delete refuses an ACTIVE, an invited (not expired) and an unknown account', async () => {
    const active = await seedExhaustedInvite({ expiredDaysAgo: 9, status: 'active', cleanupDaysAgo: 2 });
    const invited = await seedExhaustedInvite({ expiredDaysAgo: 9, status: 'invited', cleanupDaysAgo: 2 });
    for (const u of [active.user_id, invited.user_id, randomUUID()]) {
      expect((await worker.query('SELECT core.worker_delete_expired_invited_user($1) AS r', [u])).rows[0].r).toBe('not_eligible');
    }
    expect(await statusOf(active.user_id)).toBe('active');
  });

  it('E-6 / N-4: an account that ever signed in, or ever held a refresh token (even revoked), is listed WITH its skip reason and never deleted', async () => {
    const signedIn = await seedExhaustedInvite({ expiredDaysAgo: 9, status: 'invite_expired', cleanupDaysAgo: 2 });
    await admin.query(`UPDATE core."user" SET last_login_at = now() - interval '30 days' WHERE id = $1`, [signedIn.user_id]);
    const hadToken = await seedExhaustedInvite({ expiredDaysAgo: 9, status: 'invite_expired', cleanupDaysAgo: 2 });
    // A revoked token row (the NOT NULL columns without defaults, read from the catalog 2026-10-31).
    await admin.query(
      `INSERT INTO core.refresh_token (organisation_id, user_id, token_hash, family_id, expires_at, family_expires_at, revoked_at)
       VALUES ($1, $2, md5(random()::text), gen_random_uuid(), now() + interval '1 day', now() + interval '1 day', now())`,
      [hadToken.organisation_id, hadToken.user_id],
    );
    const { rows } = await worker.query('SELECT * FROM core.worker_account_invite_cleanup_candidates(50, NULL, NULL)');
    for (const [u, reason] of [[signedIn.user_id, 'signed_in'], [hadToken.user_id, 'had_session']] as const) {
      expect(rows.find((r: { user_id: string }) => r.user_id === u)).toMatchObject({ blocking_reason: reason });
      expect((await worker.query('SELECT core.worker_delete_expired_invited_user($1) AS r', [u])).rows[0].r).toBe(reason);
      expect(await statusOf(u)).toBe('invite_expired');
    }
  });

  // ===================================================================================================================
  // Phase D wave 2 — coverage audit. The SQL is the same whatever WORKER_INVITE_AUTO_DELETE_ENABLED says:
  // the flag (default false) only decides whether the Worker CALLS these definers (rab-worker
  // phase-d-account-invite-cleanup-worker.integration.spec.ts case 5 proves "OFF ⇒ no expiry, no deletion, no audit").
  // These tests pin that the SQL eligibility conditions themselves are never weaker than reviewed.
  // ===================================================================================================================

  describe('wave 2: eligibility is never weakened — protected accounts are listed with their reason and never deleted', () => {
    it('crewflow (the owner login) cannot reach the three definers either (42501): EXECUTE is crewflow_worker only', async () => {
      if (!crewflow) return;
      expect(await sqlstateOf(crewflow.query('SELECT * FROM core.worker_expire_account_invites(1)'))).toBe('42501');
      expect(await sqlstateOf(crewflow.query('SELECT * FROM core.worker_account_invite_cleanup_candidates(1, NULL, NULL)'))).toBe('42501');
      expect(await sqlstateOf(crewflow.query('SELECT core.worker_delete_expired_invited_user(gen_random_uuid())'))).toBe('42501');
    });

    it('a workspace owner → manager_workspace; a platform admin → platform_admin; any user_session row (revoked) → had_session', async () => {
      const owner = await seedExhaustedInvite({ expiredDaysAgo: 9, status: 'invite_expired', cleanupDaysAgo: 2 });
      const label = `pdf1w-${randomUUID().slice(0, 8)}`;
      await admin.query(
        `INSERT INTO core.manager_workspace (organisation_id, owner_user_id, name, subdomain, status, schema_status) VALUES ($1, $2, $3::text, $3::text, 'active', 'CREATING')`,
        [owner.organisation_id, owner.user_id, label],
      );
      const pa = await seedExhaustedInvite({ expiredDaysAgo: 9, status: 'invite_expired', cleanupDaysAgo: 2 });
      await admin.query('INSERT INTO core.platform_admin (user_id) VALUES ($1)', [pa.user_id]);
      const sess = await seedExhaustedInvite({ expiredDaysAgo: 9, status: 'invite_expired', cleanupDaysAgo: 2 });
      await admin.query(
        `INSERT INTO core.user_session (id, organisation_id, user_id, application_target, absolute_expires_at, revoked_at, revoked_reason)
         VALUES (gen_random_uuid(), $1, $2, 'manager_web', now() + interval '1 day', now(), 'phase-d')`,
        [sess.organisation_id, sess.user_id],
      );
      const { rows } = await worker.query('SELECT * FROM core.worker_account_invite_cleanup_candidates(50, NULL, NULL)');
      for (const [u, reason] of [
        [owner.user_id, 'manager_workspace'],
        [pa.user_id, 'platform_admin'],
        [sess.user_id, 'had_session'],
      ] as const) {
        expect(rows.find((r: { user_id: string }) => r.user_id === u)).toMatchObject({ blocking_reason: reason });
        expect((await worker.query('SELECT core.worker_delete_expired_invited_user($1) AS r', [u])).rows[0].r).toBe(reason);
        expect(await statusOf(u)).toBe('invite_expired');
      }
    });

    it('FK restrictions are preserved: a business row referencing the account (venue.created_by, NO ACTION) retains it as "referenced"; nothing cascades', async () => {
      const s = await seedExhaustedInvite({ expiredDaysAgo: 9, status: 'invite_expired', cleanupDaysAgo: 2 });
      const { rows: v } = await admin.query(`INSERT INTO core.venue (organisation_id, name, created_by) VALUES ($1, 'pd-f1-venue', $2) RETURNING id`, [
        s.organisation_id,
        s.user_id,
      ]);
      expect((await worker.query('SELECT core.worker_delete_expired_invited_user($1) AS r', [s.user_id])).rows[0].r).toBe('referenced');
      expect(await statusOf(s.user_id)).toBe('invite_expired');
      // The CASCADE children rolled back with the refused delete (sub-transaction): the invite row is still there.
      expect((await admin.query('SELECT count(*)::int AS n FROM core.account_invite WHERE user_id = $1', [s.user_id])).rows[0].n).toBe(1);
      expect((await admin.query('SELECT created_by FROM core.venue WHERE id = $1', [v[0].id])).rows[0].created_by).toBe(s.user_id);
    });

    it('expired-but-not-final, revoked or accepted invites are never candidates (status / send_number / cleanup_at gate)', async () => {
      const notFinal = await seedExhaustedInvite({ expiredDaysAgo: 9, status: 'invite_expired', cleanupDaysAgo: 2 });
      await admin.query('UPDATE core.account_invite SET send_number = 2 WHERE user_id = $1', [notFinal.user_id]);
      const noCleanup = await seedExhaustedInvite({ expiredDaysAgo: 9, status: 'invite_expired', cleanupDaysAgo: null });
      const { rows } = await worker.query('SELECT * FROM core.worker_account_invite_cleanup_candidates(50, NULL, NULL)');
      for (const u of [notFinal.user_id, noCleanup.user_id]) {
        expect(rows.some((r: { user_id: string }) => r.user_id === u)).toBe(false);
        expect((await worker.query('SELECT core.worker_delete_expired_invited_user($1) AS r', [u])).rows[0].r).toBe('not_eligible');
      }
      // expire: a revoked or an accepted final invite never moves the user to invite_expired
      const revoked = await seedExhaustedInvite({ expiredDaysAgo: 1 });
      await admin.query('UPDATE core.account_invite SET revoked_at = now() WHERE user_id = $1', [revoked.user_id]);
      const accepted = await seedExhaustedInvite({ expiredDaysAgo: 1 });
      await admin.query('UPDATE core.account_invite SET accepted_at = now() - interval \'2 days\' WHERE user_id = $1', [accepted.user_id]);
      const { rows: expired } = await worker.query('SELECT * FROM core.worker_expire_account_invites(500)');
      for (const u of [revoked.user_id, accepted.user_id]) {
        expect(expired.some((r: { user_id: string }) => r.user_id === u)).toBe(false);
        expect(await statusOf(u)).toBe('invited');
      }
    });
  });

  describe('wave 2: concurrent cleanup is safe', () => {
    it('two Workers deleting the same account: the second waits on the row lock, re-checks, and gets not_eligible (one deletion)', async () => {
      const s = await seedExhaustedInvite({ expiredDaysAgo: 9, status: 'invite_expired', cleanupDaysAgo: 2 });
      await worker.query('BEGIN');
      let second: Promise<string>;
      try {
        expect((await worker.query('SELECT core.worker_delete_expired_invited_user($1) AS r', [s.user_id])).rows[0].r).toBe('deleted');
        second = worker2.query('SELECT core.worker_delete_expired_invited_user($1) AS r', [s.user_id]).then((r) => r.rows[0].r as string);
        await new Promise((r) => setTimeout(r, 300)); // worker2 is now blocked on FOR UPDATE OF u
        await worker.query('COMMIT');
      } catch (e) {
        await worker.query('ROLLBACK');
        throw e;
      }
      expect(await second!).toBe('not_eligible');
      expect(await statusOf(s.user_id)).toBeUndefined();
    });

    it('if the first deleter rolls back, the waiting one re-checks under the lock and deletes (exactly one deletion)', async () => {
      const s = await seedExhaustedInvite({ expiredDaysAgo: 9, status: 'invite_expired', cleanupDaysAgo: 2 });
      await worker.query('BEGIN');
      expect((await worker.query('SELECT core.worker_delete_expired_invited_user($1) AS r', [s.user_id])).rows[0].r).toBe('deleted');
      const second = worker2.query('SELECT core.worker_delete_expired_invited_user($1) AS r', [s.user_id]).then((r) => r.rows[0].r as string);
      await new Promise((r) => setTimeout(r, 300));
      await worker.query('ROLLBACK');
      expect(await second).toBe('deleted');
      expect(await statusOf(s.user_id)).toBeUndefined();
    });

    it('two concurrent expiry batches never block each other and never expire the same account twice (SKIP LOCKED)', async () => {
      const seeded = [];
      for (let i = 0; i < 4; i += 1) seeded.push(await seedExhaustedInvite({ expiredDaysAgo: 1 }));
      const ids = new Set(seeded.map((x) => x.user_id));
      await worker.query('BEGIN');
      try {
        const first = (await worker.query('SELECT * FROM core.worker_expire_account_invites(500)')).rows.filter((r: { user_id: string }) => ids.has(r.user_id));
        expect(first.length).toBeGreaterThan(0);
        await worker2.query(`SET statement_timeout = '5s'`);
        const second = (await worker2.query('SELECT * FROM core.worker_expire_account_invites(500)')).rows.filter((r: { user_id: string }) => ids.has(r.user_id));
        await worker2.query('RESET statement_timeout');
        const firstIds = new Set(first.map((r: { user_id: string }) => r.user_id));
        expect(second.filter((r: { user_id: string }) => firstIds.has(r.user_id))).toEqual([]);
        await worker.query('COMMIT');
      } catch (e) {
        await worker.query('ROLLBACK');
        throw e;
      }
      for (const u of ids) expect(await statusOf(u)).toBe('invite_expired');
    });
  });
});
