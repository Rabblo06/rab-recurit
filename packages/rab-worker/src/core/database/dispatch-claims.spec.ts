import {
  claimDispatchPointers,
  DISPATCH_CLAIM_COUNT_ALERT_THRESHOLD,
  DispatchClaim,
  groupClaimsByScope,
  releaseDispatchClaim,
  runGlobalDispatch,
} from './dispatch-claims';

/**
 * Phase D (D1) — Worker side of the global claim. Unit tests with a mocked autocommit query function: the SQL functions
 * themselves (core.worker_claim_*_dispatch / core.worker_release_dispatch_claim) are Agent A's and are NOT executed here
 * (SQL gate). What is proven here is the Worker's half of the contract: fixed SQL per queue, no tenant context, clamped
 * batch, grouping by scope, token-checked release on an unprocessable scope, and fail-closed parsing.
 */
const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';
const WS_A1 = '00000000-0000-4000-8000-0000000000a1';
const WS_A2 = '00000000-0000-4000-8000-0000000000a2';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const token = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const row = (n: number, org: string, ws: string | null, claimCount = 1) => ({
  subject_id: uuid(n),
  organisation_id: org,
  workspace_id: ws,
  claim_token: token(n),
  claim_count: claimCount,
});

function fakeDb(pages: Array<ReturnType<typeof row>[]>, release: (params: unknown[]) => boolean = () => true) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let page = 0;
  return {
    calls,
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('worker_release_dispatch_claim')) return [{ released: release(params) }];
      return pages[page++] ?? [];
    }),
  };
}

const routingError = (code: string) => Object.assign(new Error(`routing ${code}`), { name: 'WorkspaceRoutingError', code });

describe('claimDispatchPointers', () => {
  it('calls exactly the contract function for each queue, autocommit, with the batch clamped to 1..200', async () => {
    const expected: Record<string, string> = {
      email: 'core.worker_claim_email_dispatch',
      push: 'core.worker_claim_push_dispatch',
      realtime: 'core.worker_claim_realtime_publish',
      statement: 'core.worker_claim_statement_dispatch',
    };
    for (const [queue, fn] of Object.entries(expected)) {
      const db = fakeDb([[]]);
      await claimDispatchPointers(db, queue as never, 100);
      expect(db.calls).toHaveLength(1);
      expect(db.calls[0]!.sql).toBe(`SELECT subject_id, organisation_id, workspace_id, claim_token, claim_count FROM ${fn}($1::integer)`);
      expect(db.calls[0]!.params).toEqual([100]);
      // No transaction, no tenant GUCs: one plain statement on the claimer connection.
      expect(db.calls[0]!.sql).not.toMatch(/set_config|START TRANSACTION|BEGIN/i);
    }
    const db = fakeDb([[], []]);
    await claimDispatchPointers(db, 'email', 0);
    await claimDispatchPointers(db, 'email', 5000);
    expect(db.calls.map((c) => c.params[0])).toEqual([1, 200]);
  });

  it('refuses an unknown queue label (fail closed: nothing is interpolated into SQL)', async () => {
    const db = fakeDb([[]]);
    await expect(claimDispatchPointers(db, "email'); DROP TABLE x; --" as never, 10)).rejects.toThrow(/unknown dispatch queue/);
    expect(db.calls).toHaveLength(0);
  });

  it('parses routing ids and drops a malformed row instead of acting on it', async () => {
    const db = fakeDb([[row(1, ORG_A, null), { ...row(2, ORG_A, null), organisation_id: 'not-a-uuid' }, { ...row(3, ORG_A, null), claim_token: null as unknown as string }]]);
    const claims = await claimDispatchPointers(db, 'email', 10);
    expect(claims).toEqual([{ subjectId: uuid(1), organisationId: ORG_A, workspaceId: null, claimToken: token(1), claimCount: 1 }]);
  });
});

describe('releaseDispatchClaim', () => {
  it('passes the queue, subject and claim token and returns the function verdict; a stale token is refused (false), never an error', async () => {
    const fresh = fakeDb([], () => true);
    expect(await releaseDispatchClaim(fresh, 'realtime', uuid(1), token(1), 30)).toBe(true);
    expect(fresh.calls[0]!.sql).toBe('SELECT core.worker_release_dispatch_claim($1::text, $2::uuid, $3::uuid, $4::integer) AS released');
    expect(fresh.calls[0]!.params).toEqual(['realtime', uuid(1), token(1), 30]);

    const stale = fakeDb([], () => false); // the function's own verdict for a token that no longer matches
    expect(await releaseDispatchClaim(stale, 'realtime', uuid(1), token(99), 30)).toBe(false);
  });

  it('clamps the retry delay to 1..300 s on the client as well', async () => {
    const db = fakeDb([]);
    await releaseDispatchClaim(db, 'email', uuid(1), token(1), 0);
    await releaseDispatchClaim(db, 'email', uuid(1), token(1), 10_000);
    expect(db.calls.map((c) => c.params[3])).toEqual([1, 300]);
  });
});

describe('groupClaimsByScope', () => {
  const claim = (n: number, org: string, ws: string | null): DispatchClaim => ({ subjectId: uuid(n), organisationId: org, workspaceId: ws, claimToken: token(n), claimCount: 1 });

  it('groups by (organisation, workspace) in first-seen order', () => {
    const groups = groupClaimsByScope('realtime', [claim(1, ORG_A, WS_A1), claim(2, ORG_B, null), claim(3, ORG_A, WS_A1), claim(4, ORG_A, null), claim(5, ORG_A, WS_A2)]);
    expect(groups.map((g) => [g.organisationId, g.workspaceId, g.claims.map((c) => c.subjectId)])).toEqual([
      [ORG_A, WS_A1, [uuid(1), uuid(3)]],
      [ORG_B, null, [uuid(2)]],
      [ORG_A, null, [uuid(4)]],
      [ORG_A, WS_A2, [uuid(5)]],
    ]);
  });

  it('email and push are organisation-scoped outboxes: the workspace is never bound for them (today\'s per-org scope)', () => {
    for (const queue of ['email', 'push'] as const) {
      const groups = groupClaimsByScope(queue, [claim(1, ORG_A, null), claim(2, ORG_A, WS_A1)]);
      expect(groups.map((g) => [g.organisationId, g.workspaceId, g.claims.length])).toEqual([[ORG_A, null, 2]]);
    }
  });
});

describe('runGlobalDispatch', () => {
  const logger = { log: jest.fn(), warn: jest.fn() };

  it('claims, then processes each scope with exactly its own subject ids', async () => {
    const db = fakeDb([[row(1, ORG_A, WS_A1), row(2, ORG_B, WS_A2), row(3, ORG_A, WS_A1)]]);
    const seen: Array<[string, string | null, string[]]> = [];
    const report = await runGlobalDispatch({
      claimer: db,
      queue: 'realtime',
      batch: 10,
      maxBatches: 5,
      logger,
      processScope: async (scope) => {
        seen.push([scope.organisationId, scope.workspaceId, scope.subjectIds]);
      },
    });
    expect(seen).toEqual([
      [ORG_A, WS_A1, [uuid(1), uuid(3)]],
      [ORG_B, WS_A2, [uuid(2)]],
    ]);
    expect(report).toMatchObject({ batches: 2, claimed: 3, scopes: 2, skippedNotReady: 0, released: 0 });
    // Wave 5 (F-W4-1): a SHORT batch no longer ends the run (the server's per-organisation cap makes batches short while
    // more is due); the run ends at the first EMPTY claim — here the second call.
    expect(db.calls.filter((c) => c.sql.includes('worker_claim'))).toHaveLength(2);
  });

  it('keeps claiming while a batch comes back full, bounded by maxBatches', async () => {
    const full = (base: number) => [row(base, ORG_A, null), row(base + 1, ORG_A, null)];
    const db = fakeDb([full(1), full(3), full(5), full(7)]);
    const processScope = jest.fn(async () => undefined);
    const report = await runGlobalDispatch({ claimer: db, queue: 'email', batch: 2, maxBatches: 3, logger, processScope });
    expect(report.batches).toBe(3);
    expect(report.claimed).toBe(6);
    expect(db.calls.filter((c) => c.sql.includes('worker_claim'))).toHaveLength(3);
  });

  it('a workspace that is not routable yet releases ITS claims (token-checked) and the other scopes still run', async () => {
    const db = fakeDb([[row(1, ORG_A, WS_A1), row(2, ORG_A, WS_A2)]]);
    const processed: string[] = [];
    const report = await runGlobalDispatch({
      claimer: db,
      queue: 'statement',
      batch: 10,
      maxBatches: 1,
      logger,
      processScope: async (scope) => {
        if (scope.workspaceId === WS_A1) throw routingError('not-ready');
        processed.push(scope.workspaceId!);
      },
    });
    expect(processed).toEqual([WS_A2]);
    const releases = db.calls.filter((c) => c.sql.includes('worker_release_dispatch_claim'));
    expect(releases.map((c) => c.params)).toEqual([['statement', uuid(1), token(1), 30]]);
    expect(report).toMatchObject({ skippedNotReady: 1, released: 1, releaseRefused: 0 });
  });

  it('an unexpected error releases the failed scope and every unprocessed scope, then fails the run (counted by the runtime)', async () => {
    const db = fakeDb([[row(1, ORG_A, null), row(2, ORG_B, null)]]);
    await expect(
      runGlobalDispatch({
        claimer: db,
        queue: 'email',
        batch: 10,
        maxBatches: 1,
        logger,
        processScope: async () => {
          throw new Error('connection terminated');
        },
      }),
    ).rejects.toThrow('connection terminated');
    const releases = db.calls.filter((c) => c.sql.includes('worker_release_dispatch_claim'));
    expect(releases.map((c) => c.params[1])).toEqual([uuid(1), uuid(2)]);
  });

  it('an integrity routing refusal (not skippable) is NOT swallowed', async () => {
    const db = fakeDb([[row(1, ORG_A, WS_A1)]]);
    await expect(
      runGlobalDispatch({ claimer: db, queue: 'realtime', batch: 10, maxBatches: 1, logger, processScope: async () => { throw routingError('name-mismatch'); } }),
    ).rejects.toThrow('routing name-mismatch');
  });

  it('a refused release (stale token: another Worker re-claimed after our lease expired) is counted, not thrown', async () => {
    const db = fakeDb([[row(1, ORG_A, WS_A1)]], () => false);
    const report = await runGlobalDispatch({
      claimer: db, queue: 'realtime', batch: 10, maxBatches: 1, logger,
      processScope: async () => { throw routingError('registry-missing'); },
    });
    expect(report).toMatchObject({ skippedNotReady: 1, released: 0, releaseRefused: 1 });
  });

  it('a statement pointer without a workspace is never processed (statements are per workspace; a forged pointer acts on nothing)', async () => {
    const db = fakeDb([[row(1, ORG_A, null), row(2, ORG_A, WS_A1)]]);
    const processScope = jest.fn(async () => undefined);
    const report = await runGlobalDispatch({ claimer: db, queue: 'statement', batch: 10, maxBatches: 1, logger, processScope });
    expect(processScope).toHaveBeenCalledTimes(1);
    expect(processScope).toHaveBeenCalledWith({ organisationId: ORG_A, workspaceId: WS_A1, subjectIds: [uuid(2)], claims: expect.any(Array) });
    expect(report.invalidScope).toBe(1);
  });

  it('a failing release never masks the outcome (release is best effort; the lease covers it)', async () => {
    const db = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('worker_release')) throw new Error('release down');
        return [row(1, ORG_A, WS_A1)];
      }),
    };
    const report = await runGlobalDispatch({ claimer: db, queue: 'realtime', batch: 10, maxBatches: 1, logger, processScope: async () => { throw routingError('not-ready'); } });
    expect(report).toMatchObject({ skippedNotReady: 1, released: 0, releaseFailed: 1 });
  });
});

/**
 * Phase D wave 2 — OD-1 visibility (owner decision 2026-11-01): repeated claims of the same pointer (claim_count > 1) are
 * counted per run; a claim with claim_count > 20 is handed to the alert hook (routing ids + count only). No new SQL.
 */
describe('runGlobalDispatch — OD-1 claim_count visibility', () => {
  const logger = { log: jest.fn(), warn: jest.fn() };

  it('counts claims with claim_count > 1 and > 20, and hands only the > 20 ones to onHighClaimCount', async () => {
    const db = fakeDb([[row(1, ORG_A, WS_A1, 1), row(2, ORG_A, WS_A1, 2), row(3, ORG_B, WS_A2, 20), row(4, ORG_B, WS_A2, 21), row(5, ORG_A, WS_A1, 57)]]);
    const high: DispatchClaim[] = [];
    const report = await runGlobalDispatch({
      claimer: db,
      queue: 'email',
      batch: 10,
      maxBatches: 1,
      logger,
      processScope: async () => undefined,
      onHighClaimCount: (claim) => high.push(claim),
    });
    expect(report).toMatchObject({ claimed: 5, repeatedClaims: 4, highClaimCount: 2 });
    expect(high.map((c) => [c.subjectId, c.organisationId, c.claimCount])).toEqual([
      [uuid(4), ORG_B, 21],
      [uuid(5), ORG_A, 57],
    ]);
  });

  it('first-time claims only: both counters stay 0 and the hook is never called', async () => {
    const db = fakeDb([[row(1, ORG_A, WS_A1), row(2, ORG_B, WS_A2)]]);
    const hook = jest.fn();
    const report = await runGlobalDispatch({ claimer: db, queue: 'push', batch: 10, maxBatches: 1, logger, processScope: async () => undefined, onHighClaimCount: hook });
    expect(report).toMatchObject({ repeatedClaims: 0, highClaimCount: 0 });
    expect(hook).not.toHaveBeenCalled();
  });

  it('the alert threshold is 20 (owner decision OD-1)', () => {
    expect(DISPATCH_CLAIM_COUNT_ALERT_THRESHOLD).toBe(20);
  });
});

/**
 * Wave 5 — F-W4-1: the server caps each claim at 10 pointers per organisation (email/push/statement; realtime 25), so a
 * backlog in ONE organisation always comes back short. Stopping on `claims.length < batch` drained 10 rows per tick /
 * NOTIFY. The run now continues while a claim returned ANY rows, ends at the first empty claim, and is bounded by
 * `maxBatches`; `boundReached` tells the coordinator a follow-up run is due. No SQL change.
 */
describe('runGlobalDispatch — F-W4-1 (single-organisation backlog vs the per-organisation cap)', () => {
  const logger = { log: jest.fn(), warn: jest.fn() };
  const page = (from: number, count: number) => Array.from({ length: count }, (_, i) => row(from + i, ORG_A, null));

  it('a single-organisation backlog of 35 (cap 10 per claim) drains in ONE run: 4 claims with rows, then the empty claim ends it', async () => {
    const db = fakeDb([page(1, 10), page(11, 10), page(21, 10), page(31, 5)]);
    const processed: string[] = [];
    const report = await runGlobalDispatch({
      claimer: db, queue: 'email', batch: 100, maxBatches: 10, logger,
      processScope: async (scope) => void processed.push(...scope.subjectIds),
    });
    expect(processed).toHaveLength(35);
    expect(new Set(processed).size).toBe(35);
    const claimCalls = db.calls.filter((c) => c.sql.includes('worker_claim'));
    expect(claimCalls).toHaveLength(5); // 4 with rows + the empty one that ends the run
    expect(report).toMatchObject({ batches: 5, claimed: 35, boundReached: false });
  });

  it('the maxBatches bound holds; a run that hits it with rows still coming reports boundReached', async () => {
    const db = fakeDb([page(1, 10), page(11, 10), page(21, 10), page(31, 10)]);
    const report = await runGlobalDispatch({ claimer: db, queue: 'email', batch: 100, maxBatches: 3, logger, processScope: async () => undefined });
    expect(db.calls.filter((c) => c.sql.includes('worker_claim'))).toHaveLength(3);
    expect(report).toMatchObject({ batches: 3, claimed: 30, boundReached: true });
  });

  it('a run ends at the first empty claim (nothing due → one call, no follow-up)', async () => {
    const db = fakeDb([]);
    const report = await runGlobalDispatch({ claimer: db, queue: 'email', batch: 100, maxBatches: 10, logger, processScope: async () => undefined });
    expect(db.calls.filter((c) => c.sql.includes('worker_claim'))).toHaveLength(1);
    expect(report).toMatchObject({ batches: 1, claimed: 0, boundReached: false });
  });

  it('pointers whose subject is NOT due cannot make the loop spin: each claim leases them, so the next claim is empty and the run ends', async () => {
    // A lease-modelling claimer: due pointers are returned once and then leased (30 s); processScope finds nothing to do.
    const leasedUntil = new Map<string, number>();
    const pointers = Array.from({ length: 7 }, (_, i) => uuid(i + 1));
    let claimCalls = 0;
    const claimer = {
      query: async (sql: string) => {
        if (sql.includes('worker_release_dispatch_claim')) return [{ released: true }];
        claimCalls += 1;
        const due = pointers.filter((p) => !leasedUntil.has(p)).slice(0, 10);
        for (const p of due) leasedUntil.set(p, 30_000);
        return due.map((p) => ({ subject_id: p, organisation_id: ORG_A, workspace_id: null, claim_token: token(1), claim_count: 1 }));
      },
    };
    const report = await runGlobalDispatch({ claimer, queue: 'email', batch: 100, maxBatches: 10, logger, processScope: async () => undefined });
    expect(claimCalls).toBe(2);
    expect(report).toMatchObject({ claimed: 7, boundReached: false });
  });
});
