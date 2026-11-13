import { DataSource } from 'typeorm';

import { reportTokenCleanupResult, runTokenCleanupCycle, TokenCleanupResult } from './token-cleanup.job';

/**
 * XP-09 owner decisions Q2 (each cleanup step isolated; the OAuth sign-in state cleanup always runs; a failure is logged and
 * reported with a fixed message) and Q3 (batches loop until one comes back short; the run is capped at 20 batches or 60 s).
 * Pure logic on a fake DataSource and a fake clock; the 5,000-row drain on a real database is
 * src/__tests__/integration/token-cleanup-loop.integration.spec.ts.
 */
const AUTH = /worker_cleanup_auth_tokens/;
const OAUTH = /worker_cleanup_oauth_transaction_state/;

type Reply = { refresh?: number; reset?: number; oauth?: number } | Error;

/** A DataSource whose `query` answers the auth-token calls from `auth` and the OAuth calls from `oauth`, in order. */
function fakeDataSource(auth: Reply[], oauth: Reply[], onCall?: () => void) {
  const calls: string[] = [];
  const query = jest.fn(async (sql: string, params: unknown[]) => {
    onCall?.();
    const isAuth = AUTH.test(sql);
    if (!isAuth && !OAUTH.test(sql)) throw new Error(`unexpected SQL: ${sql}`);
    calls.push(isAuth ? 'auth' : 'oauth');
    const reply = (isAuth ? auth : oauth).shift() ?? (isAuth ? { refresh: 0, reset: 0 } : { oauth: 0 });
    expect(params).toHaveLength(1);
    if (reply instanceof Error) throw reply;
    return isAuth
      ? [{ refresh_tokens_deleted: reply.refresh ?? 0, password_reset_tokens_deleted: reply.reset ?? 0 }]
      : [{ rows_deleted: reply.oauth ?? 0 }];
  });
  return { ds: { query } as unknown as DataSource, query, calls };
}

/** A pg error as TypeORM surfaces it, with a detail that must never reach a log line. */
function fkError(): Error {
  return Object.assign(new Error('update or delete on table "refresh_token" violates foreign key constraint "refresh_token_replaced_by_fkey"'), {
    code: '23503',
    detail: 'Key (id)=(00000000-0000-0000-0000-000000000001) is still referenced from table "refresh_token".',
  });
}

const logger = () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() });

describe('token cleanup — step isolation (XP-09 Q2)', () => {
  it('the auth-token step throws → the OAuth step still runs; the failure is recorded with its SQLSTATE only', async () => {
    const { ds, calls } = fakeDataSource([fkError()], [{ oauth: 3 }]);
    const result = await runTokenCleanupCycle(ds);
    expect(calls).toEqual(['auth', 'oauth']);
    expect(result.oauthTransactionsDeleted).toBe(3);
    expect(result.refreshTokensDeleted).toBe(0);
    expect(result.steps).toEqual([
      { step: 'auth-tokens', batches: 1, rowsDeleted: 0, drained: false, stoppedBy: null, failed: true, sqlState: '23503' },
      { step: 'oauth-transaction-state', batches: 1, rowsDeleted: 3, drained: true, stoppedBy: null, failed: false, sqlState: null },
    ]);
  });

  it('a failure after some full batches keeps the rows already deleted (each batch committed on its own) and stops that step only', async () => {
    const { ds, calls } = fakeDataSource([{ refresh: 1000 }, { refresh: 1000, reset: 2 }, fkError()], [{ oauth: 0 }]);
    const result = await runTokenCleanupCycle(ds);
    expect(calls).toEqual(['auth', 'auth', 'auth', 'oauth']);
    expect(result).toMatchObject({ refreshTokensDeleted: 2000, passwordResetTokensDeleted: 2, batches: 4, capHit: false });
    expect(result.steps[0]).toMatchObject({ failed: true, batches: 3, rowsDeleted: 2002 });
    expect(result.steps[1]).toMatchObject({ failed: false, drained: true });
  });

  it('the OAuth step throwing does not undo or hide the auth-token step', async () => {
    const { ds } = fakeDataSource([{ refresh: 7, reset: 1 }], [new Error('connection terminated unexpectedly')]);
    const result = await runTokenCleanupCycle(ds);
    expect(result).toMatchObject({ refreshTokensDeleted: 7, passwordResetTokensDeleted: 1, oauthTransactionsDeleted: 0 });
    expect(result.steps.map((s) => [s.step, s.failed, s.sqlState])).toEqual([
      ['auth-tokens', false, null],
      ['oauth-transaction-state', true, null],
    ]);
  });

  it('both steps failing: both are attempted, both recorded', async () => {
    const { ds, calls } = fakeDataSource([fkError()], [fkError()]);
    const result = await runTokenCleanupCycle(ds);
    expect(calls).toEqual(['auth', 'oauth']);
    expect(result.steps.every((s) => s.failed)).toBe(true);
  });

  it('report: each failed step is logged with a fixed message, then ONE fixed-message error fails the cycle (no SQL text, detail, id or email)', async () => {
    const { ds } = fakeDataSource([fkError()], [Object.assign(new Error('value someone@example.test violates check'), { code: '23514' })]);
    const result = await runTokenCleanupCycle(ds);
    const l = logger();
    let thrown: Error | undefined;
    try {
      reportTokenCleanupResult(result, l);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toBe('token cleanup: 2 step(s) failed: auth-tokens, oauth-transaction-state (details in the worker log)');
    expect(thrown?.stack).toBe(thrown?.message);
    expect(l.error.mock.calls).toEqual([
      ['token cleanup: step auth-tokens failed (SQLSTATE 23503); the other steps still ran'],
      ['token cleanup: step oauth-transaction-state failed (SQLSTATE 23514); the other steps still ran'],
    ]);
    const everything = JSON.stringify([l.log.mock.calls, l.warn.mock.calls, l.error.mock.calls, thrown?.message]);
    for (const leak of ['@', 'Key (id)', '00000000-0000', 'violates', 'refresh_token_replaced_by_fkey', 'SELECT']) expect(everything).not.toContain(leak);
  });

  it('report: no failure → no throw; a quiet run (nothing deleted, no cap) logs nothing', () => {
    const quiet: TokenCleanupResult = { refreshTokensDeleted: 0, passwordResetTokensDeleted: 0, oauthTransactionsDeleted: 0, batches: 2, capHit: false, steps: [] };
    const l = logger();
    expect(() => reportTokenCleanupResult(quiet, l)).not.toThrow();
    expect([l.log, l.warn, l.error].map((f) => f.mock.calls.length)).toEqual([0, 0, 0]);
  });

  it('a non-SQLSTATE code is never echoed (only five-character [0-9A-Z] codes)', async () => {
    const { ds } = fakeDataSource([Object.assign(new Error('x'), { code: 'ECONNRESET someone@example.test' })], []);
    const result = await runTokenCleanupCycle(ds);
    expect(result.steps[0]).toMatchObject({ failed: true, sqlState: null });
  });
});

describe('token cleanup — batch loop and run cap (XP-09 Q3)', () => {
  it('loops while a batch is full and stops at the first short batch, per step', async () => {
    const { ds, calls, query } = fakeDataSource(
      [{ refresh: 1000 }, { refresh: 1000 }, { refresh: 400, reset: 1000 }, { refresh: 0, reset: 12 }],
      [{ oauth: 1000 }, { oauth: 5 }],
    );
    const result = await runTokenCleanupCycle(ds);
    expect(calls).toEqual(['auth', 'auth', 'auth', 'auth', 'oauth', 'oauth']);
    expect(query.mock.calls.every(([, params]) => (params as unknown[])[0] === 1000)).toBe(true);
    expect(result).toMatchObject({ refreshTokensDeleted: 2400, passwordResetTokensDeleted: 1012, oauthTransactionsDeleted: 1005, batches: 6, capHit: false });
    expect(result.steps.map((s) => [s.batches, s.drained, s.stoppedBy])).toEqual([
      [4, true, null],
      [2, true, null],
    ]);
  });

  it('an endless backlog stops at 20 batches per run; one batch stays reserved for the OAuth step; capHit is reported', async () => {
    const { ds, calls } = fakeDataSource(Array.from({ length: 100 }, () => ({ refresh: 1000 })), [{ oauth: 2 }]);
    const result = await runTokenCleanupCycle(ds);
    expect(calls.filter((c) => c === 'auth')).toHaveLength(19);
    expect(calls[calls.length - 1]).toBe('oauth');
    expect(result).toMatchObject({ batches: 20, capHit: true, refreshTokensDeleted: 19_000, oauthTransactionsDeleted: 2 });
    expect(result.steps[0]).toMatchObject({ stoppedBy: 'batch-cap', drained: false });
    expect(result.steps[1]).toMatchObject({ stoppedBy: null, drained: true });
    const l = logger();
    reportTokenCleanupResult(result, l);
    expect(l.warn.mock.calls).toEqual([['token cleanup: step auth-tokens stopped at the run cap (batch-cap) after 19 batch(es); the rest is deleted on the next run']]);
    expect(l.log.mock.calls).toEqual([['token cleanup: refreshTokens=19000 passwordResetTokens=0 oauthTransactions=2 batches=20 capHit=true']]);
  });

  it('both steps with a backlog share the 20-batch cap; the OAuth step gets what the auth step left', async () => {
    const { ds, calls } = fakeDataSource(
      [...Array.from({ length: 5 }, () => ({ refresh: 1000 })), { refresh: 10 }],
      Array.from({ length: 100 }, () => ({ oauth: 1000 })),
    );
    const result = await runTokenCleanupCycle(ds);
    expect(calls.filter((c) => c === 'auth')).toHaveLength(6);
    expect(calls.filter((c) => c === 'oauth')).toHaveLength(14);
    expect(result).toMatchObject({ batches: 20, capHit: true });
    expect(result.steps[1]).toMatchObject({ stoppedBy: 'batch-cap' });
  });

  it('time cap (fake clock): no new batch starts after 60 s; the OAuth step still gets its first batch', async () => {
    let t = 1_000_000;
    // Every call costs 25 s of fake time.
    const { ds, calls } = fakeDataSource(Array.from({ length: 100 }, () => ({ refresh: 1000 })), [{ oauth: 1 }], () => {
      t += 25_000;
    });
    const result = await runTokenCleanupCycle(ds, { now: () => t });
    // Calls start at 0 s, 25 s, 50 s; at 75 s the auth step stops; the OAuth step's first batch still runs.
    expect(calls).toEqual(['auth', 'auth', 'auth', 'oauth']);
    expect(result.steps[0]).toMatchObject({ stoppedBy: 'time-cap', batches: 3 });
    expect(result.steps[1]).toMatchObject({ batches: 1, drained: true, stoppedBy: null });
    expect(result.capHit).toBe(true);
  });

  it('time cap applies to the OAuth step too (after its first batch)', async () => {
    let t = 0;
    const { ds, calls } = fakeDataSource([{ refresh: 3 }], Array.from({ length: 100 }, () => ({ oauth: 1000 })), () => {
      t += 20_000;
    });
    const result = await runTokenCleanupCycle(ds, { now: () => t });
    // auth at 0 s (short), oauth at 20 s, 40 s; at 60 s the deadline is reached.
    expect(calls).toEqual(['auth', 'oauth', 'oauth']);
    expect(result.steps[1]).toMatchObject({ stoppedBy: 'time-cap', batches: 2 });
  });

  it('whichever cap comes first: a fast backlog hits the batch cap well inside 60 s', async () => {
    let t = 0;
    const { ds } = fakeDataSource(Array.from({ length: 100 }, () => ({ refresh: 1000 })), Array.from({ length: 100 }, () => ({ oauth: 1000 })), () => {
      t += 10;
    });
    const result = await runTokenCleanupCycle(ds, { now: () => t });
    expect(result.batches).toBe(20);
    expect(result.steps.map((s) => s.stoppedBy)).toEqual(['batch-cap', 'batch-cap']);
    // The OAuth step had exactly its one reserved batch left; it came back full, so the cap is reported for it too.
    expect(result.steps[1]).toMatchObject({ batches: 1, drained: false });
    expect(t).toBeLessThan(60_000);
  });

  it('batch size and caps are clamped (1..10000 rows, at least one batch)', async () => {
    const { ds, query } = fakeDataSource([{ refresh: 0 }], [{ oauth: 0 }]);
    await runTokenCleanupCycle(ds, { batchSize: 50_000, maxBatches: 0 });
    expect(query.mock.calls.map(([, p]) => (p as unknown[])[0])).toEqual([10_000, 10_000]);
    const second = fakeDataSource([{ refresh: 1 }], [{ oauth: 1 }]);
    const result = await runTokenCleanupCycle(second.ds, { batchSize: 0 });
    expect(second.query.mock.calls.map(([, p]) => (p as unknown[])[0])).toEqual([1, 1, 1, 1]);
    // A batch of 1 that returned 1 is full: with the default caps the step would continue; the fake answers 0 next.
    expect(result.steps.map((s) => s.batches)).toEqual([2, 2]);
  });

  it('the SQL is fixed: only the two SECURITY DEFINER functions, one integer parameter each, nothing from a caller', async () => {
    const { ds, query } = fakeDataSource([{ refresh: 1 }], [{ oauth: 1 }]);
    await runTokenCleanupCycle(ds);
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'SELECT refresh_tokens_deleted, password_reset_tokens_deleted FROM core.worker_cleanup_auth_tokens($1::integer)',
      'SELECT rows_deleted FROM core.worker_cleanup_oauth_transaction_state($1::integer)',
    ]);
  });
});
