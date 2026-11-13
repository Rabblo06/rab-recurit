import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { reportTokenCleanupResult, runTokenCleanupCycle, TOKEN_CLEANUP_MAX_BATCHES, TokenCleanupResult } from '../../queues/rab-maintenance/token-cleanup.job';

/**
 * XP-09 owner decisions Q2 + Q3 on a real database, through the runtime login (TEST_DATABASE_URL = crewflow_owner, the one
 * login the Worker connects as) and the real SECURITY DEFINER functions:
 *
 * - Q3: a 5,000-row refresh-token backlog (plus 1,500 password-reset tokens and 2,500 Google/Microsoft sign-in rows) drains in
 *   ONE run, each batch its own committed transaction, inside the cap (20 batches / 60 s); a backlog bigger than the cap stops
 *   at the cap, says so, and the next run continues.
 * - Q2: the auth-token step failing (its table locked by another session; lock_timeout → 55P03) does not stop the OAuth step:
 *   the expired sign-in rows, which carry a provider email, are still deleted; the report has a fixed message only.
 *
 * The backlog is independent tokens (no `replaced_by` chain), so it cannot trigger the XP-09 heap-order 23503 that the
 * current (pre-fix) body of core.worker_cleanup_auth_tokens can hit on split rotation chains; that bug and its fix are covered
 * by branch fix/xp09-token-cleanup. Fixtures are written by the cluster superuser (TEST_DATABASE_URL_UNPOOLED), like the
 * other integration suites; the code under test only ever uses the runtime login.
 */
const RUN = Boolean(process.env.DATABASE_URL && process.env.TEST_DATABASE_URL_UNPOOLED);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(300_000);

const REFRESH = 5_000;
const RESET = 1_500;
const OAUTH = 2_500;

describeIfDb('token cleanup: batch loop within the run cap and step isolation (XP-09 Q2/Q3, integration)', () => {
  let admin: Client;
  let runtime: DataSource;
  let organisationId: string;
  let userId: string;

  /** Drains whatever earlier suites left eligible, so this suite's counts are exact. Any failing step fails the suite here. */
  async function drain(): Promise<void> {
    for (let run = 0; run < 50; run += 1) {
      const r = await runTokenCleanupCycle(runtime, { batchSize: 10_000 });
      const failed = r.steps.filter((s) => s.failed).map((s) => `${s.step}:${s.sqlState}`);
      if (failed.length) throw new Error(`pre-drain: a cleanup step failed (${failed.join(', ')}); the shared database is not in a cleanable state`);
      if (!r.capHit) return;
    }
    throw new Error('pre-drain did not finish in 50 runs');
  }

  async function seed(prefix: string, counts: { refresh: number; reset: number; oauth: number }): Promise<void> {
    // Refresh tokens dead for 400 days (expired AND revoked; no replaced_by), password-reset tokens expired 400 days ago,
    // sign-in attempts expired 2 hours ago with a provider email. created_at is older than expires_at (oauth CHECK).
    await admin.query(
      `INSERT INTO core.refresh_token (organisation_id, user_id, token_hash, family_id, expires_at, revoked_at, created_at, application_target, family_expires_at)
       SELECT $1::uuid, $2::uuid, $3::text || g, gen_random_uuid(), now() - interval '400 days', now() - interval '400 days', now() - interval '401 days', 'staff_app', now() - interval '400 days'
         FROM generate_series(1, $4::integer) g`,
      [organisationId, userId, `${prefix}-rt-`, counts.refresh],
    );
    await admin.query(
      `INSERT INTO core.password_reset_token (organisation_id, user_id, token_hash, purpose, expires_at, created_at)
       SELECT $1::uuid, $2::uuid, $3::text || g, 'forgot_password', now() - interval '400 days', now() - interval '401 days'
         FROM generate_series(1, $4::integer) g`,
      [organisationId, userId, `${prefix}-prt-`, counts.reset],
    );
    await admin.query(
      `INSERT INTO core.oauth_transaction_state (provider, pkce_code_verifier, nonce, return_to_path, created_at, expires_at, provider_email)
       SELECT 'google', 'v', $1::text || g, '/', now() - interval '3 hours', now() - interval '2 hours', 'person' || g || '@example.test'
         FROM generate_series(1, $2::integer) g`,
      [`${prefix}-n-`, counts.oauth],
    );
  }

  async function left(prefix: string): Promise<{ refresh: number; reset: number; oauth: number }> {
    const { rows } = await admin.query<{ refresh: string; reset: string; oauth: string }>(
      `SELECT (SELECT count(*) FROM core.refresh_token WHERE token_hash LIKE $1::text || '-rt-%') AS refresh,
              (SELECT count(*) FROM core.password_reset_token WHERE token_hash LIKE $1::text || '-prt-%') AS reset,
              (SELECT count(*) FROM core.oauth_transaction_state WHERE nonce LIKE $1::text || '-n-%') AS oauth`,
      [prefix],
    );
    return { refresh: Number(rows[0]!.refresh), reset: Number(rows[0]!.reset), oauth: Number(rows[0]!.oauth) };
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.TEST_DATABASE_URL_UNPOOLED! });
    await admin.connect();
    runtime = new DataSource({ type: 'postgres', url: process.env.DATABASE_URL!, entities: [], name: `token-cleanup-loop-${randomUUID()}` });
    await runtime.initialize();
    const [who] = await runtime.query<Array<{ u: string; bypass: boolean; superuser: boolean }>>(
      `SELECT current_user AS u, r.rolbypassrls AS bypass, r.rolsuper AS superuser FROM pg_roles r WHERE r.rolname = current_user`,
    );
    // The code under test runs as the real runtime login, never a privileged one.
    expect(who).toMatchObject({ u: 'crewflow_owner', bypass: false, superuser: false });

    const slug = `tcl-${randomUUID()}`;
    organisationId = (await admin.query<{ id: string }>(`INSERT INTO core.organisation (name, slug) VALUES ($1, $2) RETURNING id`, [slug, slug])).rows[0]!.id;
    userId = (
      await admin.query<{ id: string }>(
        `INSERT INTO core."user" (organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'Token', 'Cleanup', 'active') RETURNING id`,
        [organisationId, `${slug}@example.test`],
      )
    ).rows[0]!.id;
    await drain();
  });

  afterAll(async () => {
    await runtime?.destroy();
    await admin?.end();
  });

  it('a 5,000-row backlog drains in ONE run, each step looping until a short batch, inside the 20-batch / 60 s cap', async () => {
    const prefix = `q3a-${randomUUID()}`;
    await seed(prefix, { refresh: REFRESH, reset: RESET, oauth: OAUTH });
    expect(await left(prefix)).toEqual({ refresh: REFRESH, reset: RESET, oauth: OAUTH });

    const started = Date.now();
    const result = await runTokenCleanupCycle(runtime);
    const elapsedMs = Date.now() - started;
    // eslint-disable-next-line no-console
    console.log(`[token-cleanup-loop] one run: ${JSON.stringify({ ...result, elapsedMs })}`);

    expect(await left(prefix)).toEqual({ refresh: 0, reset: 0, oauth: 0 });
    expect(result).toMatchObject({ refreshTokensDeleted: REFRESH, passwordResetTokensDeleted: RESET, oauthTransactionsDeleted: OAUTH, capHit: false });
    // auth-tokens: 5 full batches (1000 refresh each; reset full in the first) + 1 short; oauth: 2 full + 1 short.
    expect(result.steps.map((s) => [s.step, s.batches, s.drained, s.failed, s.stoppedBy])).toEqual([
      ['auth-tokens', 6, true, false, null],
      ['oauth-transaction-state', 3, true, false, null],
    ]);
    expect(result.batches).toBeLessThanOrEqual(TOKEN_CLEANUP_MAX_BATCHES);
    expect(elapsedMs).toBeLessThan(60_000);
  });

  it('each batch commits on its own: a backlog larger than the cap stops at 20 batches, reports capHit, keeps what it deleted, and the next run finishes', async () => {
    const prefix = `q3b-${randomUUID()}`;
    await seed(prefix, { refresh: REFRESH, reset: 0, oauth: 300 });

    // Batch 200: the 5,000 refresh rows need 25 full batches; the auth step may use 19 (one is kept for the OAuth step).
    const first = await runTokenCleanupCycle(runtime, { batchSize: 200 });
    expect(first).toMatchObject({ batches: 20, capHit: true, refreshTokensDeleted: 19 * 200 });
    expect(first.steps[0]).toMatchObject({ step: 'auth-tokens', batches: 19, stoppedBy: 'batch-cap', drained: false, failed: false });
    // The OAuth step got its reserved batch (200 of 300) and then stopped at the cap too.
    expect(first.steps[1]).toMatchObject({ step: 'oauth-transaction-state', batches: 1, rowsDeleted: 200, stoppedBy: 'batch-cap' });
    expect(await left(prefix)).toEqual({ refresh: REFRESH - 19 * 200, reset: 0, oauth: 100 });

    const logs = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    expect(() => reportTokenCleanupResult(first, logs)).not.toThrow();
    expect(logs.warn).toHaveBeenCalledWith('token cleanup: step auth-tokens stopped at the run cap (batch-cap) after 19 batch(es); the rest is deleted on the next run');

    const second = await runTokenCleanupCycle(runtime, { batchSize: 200 });
    expect(second.capHit).toBe(false);
    expect(await left(prefix)).toEqual({ refresh: 0, reset: 0, oauth: 0 });
  });

  it('isolation: the auth-token step failing (table locked → 55P03) does not stop the OAuth step; the report is a fixed message', async () => {
    const prefix = `q2-${randomUUID()}`;
    await seed(prefix, { refresh: 50, reset: 0, oauth: 40 });

    // Another session holds core.refresh_token; the runtime session gives up after 300 ms instead of waiting.
    const impatient = new DataSource({ type: 'postgres', url: process.env.DATABASE_URL!, entities: [], name: `token-cleanup-iso-${randomUUID()}`, extra: { options: '-c lock_timeout=300' } });
    await impatient.initialize();
    const holder = new Client({ connectionString: process.env.TEST_DATABASE_URL_UNPOOLED! });
    await holder.connect();
    let result: TokenCleanupResult;
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE core.refresh_token IN ACCESS EXCLUSIVE MODE');
      result = await runTokenCleanupCycle(impatient);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end();
      await impatient.destroy();
    }

    expect(result.steps[0]).toMatchObject({ step: 'auth-tokens', failed: true, sqlState: '55P03', batches: 1 });
    expect(result.steps[1]).toMatchObject({ step: 'oauth-transaction-state', failed: false, drained: true });
    // The provider-email rows are gone even though the token step failed; the refresh rows wait for the next run.
    expect(await left(prefix)).toEqual({ refresh: 50, reset: 0, oauth: 0 });

    const logs = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    expect(() => reportTokenCleanupResult(result, logs)).toThrow('token cleanup: 1 step(s) failed: auth-tokens (details in the worker log)');
    expect(logs.error.mock.calls).toEqual([['token cleanup: step auth-tokens failed (SQLSTATE 55P03); the other steps still ran']]);
    expect(JSON.stringify([logs.log.mock.calls, logs.error.mock.calls])).not.toMatch(/@|lock timeout|refresh_token/);

    // Next run, nothing in the way: the refresh rows go.
    const next = await runTokenCleanupCycle(runtime);
    expect(next.steps.every((s) => !s.failed)).toBe(true);
    expect(await left(prefix)).toEqual({ refresh: 0, reset: 0, oauth: 0 });
  });
});
