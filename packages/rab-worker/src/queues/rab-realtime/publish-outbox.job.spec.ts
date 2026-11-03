import { fakeTenant, PRE_PHASE_D_SQL_SHA256, sha256 } from '../../__tests__/helpers/dispatch-fakes';
import { publishRealtimeScope, runRealtimeOutboxPublishCycle } from './publish-outbox.job';

/**
 * Phase D (D1 + owner condition D4) — realtime publisher.
 *  1. per_scope mode issues byte-for-byte the pre-Phase-D claim SQL.
 *  2. global mode runs the SAME claim (MATERIALIZED CTE, SKIP LOCKED, lease, claim_token) restricted to the claimed ids.
 *  3. LEASE SAFETY with a model of core.realtime_event's row semantics (status / claim_token / lease_expires_at under
 *     RLS): a Worker whose lease expired cannot complete after another Worker re-claimed; a pointer re-visit while the
 *     row lease is still held claims nothing (no duplicate publish).
 */
const ORG = '00000000-0000-4000-8000-00000000000a';
const OTHER_ORG = '00000000-0000-4000-8000-00000000000b';
const WS = '00000000-0000-4000-8000-0000000000a1';
const E1 = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-0000000000f1';

describe('realtime publisher — per_scope mode (unchanged)', () => {
  it('claims every scope with exactly the pre-Phase-D SQL (limit 25, lease 60 s)', async () => {
    const { tenant, dataSource, statements, contexts } = fakeTenant((sql) => (sql.includes('WITH claimable') ? [[], 0] : []));
    await runRealtimeOutboxPublishCycle(dataSource as never, tenant as never, jest.fn(), 'test', {
      scopes: [{ organisationId: ORG, workspaceId: null }, { organisationId: ORG, workspaceId: WS }],
    });
    const claims = statements.filter((s) => s.sql.includes('WITH claimable'));
    expect(claims).toHaveLength(2);
    for (const c of claims) {
      expect(sha256(c.sql)).toBe(PRE_PHASE_D_SQL_SHA256.realtimeClaim);
      expect(c.params).toEqual([expect.any(String), '60', 25]);
    }
    expect(contexts).toEqual([
      { organisationId: ORG, workspaceId: null, userId: '', role: '', actorType: 'worker' },
      { organisationId: ORG, workspaceId: WS, userId: '', role: '', actorType: 'worker' },
    ]);
  });
});

/** A model of core.realtime_event: the columns the claim/complete/retry SQL reads and writes, RLS by organisation/workspace. */
class RealtimeTable {
  now = 0;
  rows = new Map<string, { org: string; ws: string | null; status: string; token: string | null; leaseExpiresAt: number | null; nextRetryAt: number | null; attempts: number }>();

  insert(id: string, org = ORG, ws: string | null = WS): void {
    this.rows.set(id, { org, ws, status: 'pending', token: null, leaseExpiresAt: null, nextRetryAt: null, attempts: 0 });
  }

  tenant() {
    const table = this;
    return {
      runInTenantContext: async <T>(ctx: { organisationId: string; workspaceId: string | null }, fn: (m: unknown) => Promise<T>) =>
        fn({
          query: async (sql: string, params: unknown[]) => table.execute(ctx, sql, params),
        }),
    };
  }

  private visible(ctx: { organisationId: string; workspaceId: string | null }) {
    return [...this.rows.entries()].filter(([, r]) => r.org === ctx.organisationId && (r.ws === null || r.ws === ctx.workspaceId));
  }

  private execute(ctx: { organisationId: string; workspaceId: string | null }, sql: string, params: unknown[]): unknown {
    if (sql.includes('WITH claimable')) {
      const [token, lease, limit, ids] = params as [string, string, number, string[] | undefined];
      const due = this.visible(ctx)
        .filter(([id, r]) => (ids ? ids.includes(id) : true))
        .filter(([, r]) => ((r.status === 'pending' || r.status === 'retry') && (r.nextRetryAt === null || r.nextRetryAt <= this.now)) || (r.status === 'processing' && (r.leaseExpiresAt ?? 0) < this.now))
        .slice(0, limit);
      for (const [, r] of due) {
        r.status = 'processing';
        r.token = token;
        r.leaseExpiresAt = this.now + Number(lease) * 1000;
      }
      return [
        due.map(([id, r]) => ({
          id, organisation_id: r.org, workspace_id: r.ws, target_user_id: USER, event_type: 'offer.sent', entity_type: 'job_offer', entity_id: id,
          payload: {}, schema_version: 1, attempt_count: r.attempts, max_attempts: 5, claim_token: token, created_at: new Date(0),
        })),
        due.length,
      ];
    }
    if (sql.startsWith(`UPDATE core.realtime_event SET status = 'completed'`)) {
      const [id, token] = params as [string, string];
      const r = this.visible(ctx).find(([rid]) => rid === id)?.[1];
      if (!r || r.status !== 'processing' || r.token !== token) return [[], 0];
      r.status = 'completed';
      return [[{ id }], 1];
    }
    if (sql.includes('SET attempt_count = attempt_count + 1')) {
      const [id, token] = params as [string, string];
      const r = this.visible(ctx).find(([rid]) => rid === id)?.[1];
      if (!r || r.status !== 'processing' || r.token !== token) return [[], 0];
      r.attempts += 1;
      r.status = 'retry';
      r.token = null;
      return [[{ status: 'retry' }], 1];
    }
    throw new Error(`unexpected SQL in the model: ${sql.slice(0, 60)}`);
  }
}

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('realtime publisher — global mode scope', () => {
  it('restricts the existing claim to the claimed ids (same CTE, SKIP LOCKED, lease and token)', async () => {
    const { tenant, statements, contexts } = fakeTenant((sql) => (sql.includes('WITH claimable') ? [[], 0] : []));
    await publishRealtimeScope(tenant as never, jest.fn(), 'test', { organisationId: ORG, workspaceId: WS }, { ids: [E1] });
    expect(contexts).toEqual([{ organisationId: ORG, workspaceId: WS, userId: '', role: '', actorType: 'worker' }]);
    const [claim] = statements;
    expect(claim!.sql).toContain('WITH claimable AS MATERIALIZED');
    expect(claim!.sql).toContain('AND id = ANY($4::uuid[])');
    expect(claim!.sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(claim!.params).toEqual([expect.any(String), '60', 1, [E1]]);
  });

  it('global and per_scope share the eligibility predicate text (global only wraps it and adds the id restriction)', async () => {
    const respond = (sql: string) => (sql.includes('WITH claimable') ? [[], 0] : []);
    const a = fakeTenant(respond);
    await runRealtimeOutboxPublishCycle(a.dataSource as never, a.tenant as never, jest.fn(), 'test', { scopes: [{ organisationId: ORG, workspaceId: null }] });
    const b = fakeTenant(respond);
    await publishRealtimeScope(b.tenant as never, jest.fn(), 'test', { organisationId: ORG, workspaceId: WS }, { ids: [E1] });
    const predicate = (sql: string) => sql.slice(sql.indexOf('WHERE') + 'WHERE'.length, sql.indexOf('ORDER BY')).replace(/\s+/g, ' ').trim();
    const claim = (s: { sql: string }[]) => s.find((x) => x.sql.includes('WITH claimable'))!.sql;
    expect(predicate(claim(b.statements))).toBe(`(${predicate(claim(a.statements))}) AND id = ANY($4::uuid[])`);
  });

  it('LEASE: a re-visit (pointer lease expired) while the row lease is held claims nothing — no duplicate publish', async () => {
    const table = new RealtimeTable();
    table.insert(E1);
    const gate = deferred();
    const publishA = jest.fn(() => gate.promise.then(() => 1));
    const a = publishRealtimeScope(table.tenant() as never, publishA, 'test', { organisationId: ORG, workspaceId: WS }, { ids: [E1] });
    await new Promise((r) => setImmediate(r));
    table.now += 20_000; // beyond a 15 s pointer lease, inside the 60 s row lease
    const publishB = jest.fn(async () => 1);
    const b = await publishRealtimeScope(table.tenant() as never, publishB, 'test', { organisationId: ORG, workspaceId: WS }, { ids: [E1] });
    expect(b).toMatchObject({ claimed: 0, published: 0 });
    expect(publishB).not.toHaveBeenCalled();
    gate.resolve();
    await expect(a).resolves.toMatchObject({ claimed: 1, published: 1 });
    expect(table.rows.get(E1)!.status).toBe('completed');
  });

  it('LEASE: after the ROW lease expired another Worker re-claims and completes; the old Worker\'s late completion is rejected', async () => {
    const table = new RealtimeTable();
    table.insert(E1);
    const gate = deferred();
    const a = publishRealtimeScope(table.tenant() as never, () => gate.promise.then(() => 1), 'test', { organisationId: ORG, workspaceId: WS }, { ids: [E1] });
    await new Promise((r) => setImmediate(r));
    const tokenA = table.rows.get(E1)!.token;
    table.now += 61_000; // the row lease (60 s) has expired: A is presumed dead
    const b = await publishRealtimeScope(table.tenant() as never, async () => 1, 'test', { organisationId: ORG, workspaceId: WS }, { ids: [E1] });
    expect(b).toMatchObject({ claimed: 1, published: 1 });
    const tokenB = table.rows.get(E1)!.token;
    expect(tokenB).not.toBe(tokenA);
    gate.resolve(); // A wakes up and tries to complete with its old token
    await expect(a).resolves.toMatchObject({ claimed: 1, published: 0, failed: 1 });
    expect(table.rows.get(E1)).toMatchObject({ status: 'completed', token: tokenB });
  });

  it('LEASE: the old Worker\'s late retry write is rejected too (lost_lease), never overwriting the newer outcome', async () => {
    const table = new RealtimeTable();
    table.insert(E1);
    const gate = deferred();
    const a = publishRealtimeScope(table.tenant() as never, () => gate.promise.then(() => 1), 'test', { organisationId: ORG, workspaceId: WS }, { ids: [E1] });
    await new Promise((r) => setImmediate(r));
    table.now += 61_000;
    await publishRealtimeScope(table.tenant() as never, async () => 1, 'test', { organisationId: ORG, workspaceId: WS }, { ids: [E1] });
    gate.reject(new Error('redis down'));
    await expect(a).resolves.toMatchObject({ retried: 0, failed: 1 });
    expect(table.rows.get(E1)!.status).toBe('completed');
  });

  it('FORGED POINTER: an id of another organisation claimed under this pointer\'s scope finds nothing (RLS) and publishes nothing', async () => {
    const table = new RealtimeTable();
    table.insert(E1, OTHER_ORG, null);
    const publish = jest.fn(async () => 1);
    const result = await publishRealtimeScope(table.tenant() as never, publish, 'test', { organisationId: ORG, workspaceId: WS }, { ids: [E1] });
    expect(result.claimed).toBe(0);
    expect(publish).not.toHaveBeenCalled();
    expect(table.rows.get(E1)!.status).toBe('pending');
  });
});

/**
 * D-Q5a (§5.2, audit §13 #6 realtime half): a lease reclaim counts as an attempt and is capped. Only the UPDATE's SET /
 * RETURNING changed; the MATERIALIZED CTE (eligibility, order, LIMIT, FOR UPDATE SKIP LOCKED) is byte-identical to the
 * pre-Phase-D per_scope claim and to the D1 global claim. The real-PostgreSQL proof is
 * dq5-realtime-lease-reclaim.integration.spec.ts.
 */
describe('D-Q5a realtime lease-reclaim cap', () => {
  /** sha256 of the claim SQL up to (not including) `UPDATE core.realtime_event`, from the sources before D-Q5a. */
  const PRE_DQ5A_CTE_SHA256 = {
    perScope: '8f04334f6c70f8200ed3a542e3c171fd80760c32d041073794e260622964b5ea',
    global: '5228ed1c92d57abad5d68828a9f4bade18597de35bf5385f37182222e129d9ca',
  };
  const cte = (sql: string) => sql.slice(0, sql.indexOf('UPDATE core.realtime_event'));
  const claimRow = (id: string, status: string, attempt = 0) => ({
    id, organisation_id: ORG, workspace_id: WS, target_user_id: USER, event_type: 'offer.sent', entity_type: 'job_offer', entity_id: id,
    payload: {}, schema_version: 1, attempt_count: attempt, max_attempts: 10, claim_token: 't', created_at: new Date(0), status,
  });

  it.each([
    ['per_scope', undefined, PRE_DQ5A_CTE_SHA256.perScope],
    ['global', [E1], PRE_DQ5A_CTE_SHA256.global],
  ] as const)('%s: the CTE (eligibility, order, limit, locking) is byte-identical to before D-Q5a', async (_mode, ids, expected) => {
    const { tenant, statements } = fakeTenant((sql) => (sql.includes('WITH claimable') ? [[], 0] : []));
    await publishRealtimeScope(tenant as never, jest.fn(), 'test', { organisationId: ORG, workspaceId: WS }, ids ? { ids: [...ids] } : {});
    expect(sha256(cte(statements[0]!.sql))).toBe(expected);
  });

  it.each([['per_scope', undefined], ['global', [E1]]] as const)('%s: the UPDATE counts a reclaim and fails it at max_attempts (same arithmetic as markRealtimeEventRetry)', async (_mode, ids) => {
    const { tenant, statements } = fakeTenant((sql) => (sql.includes('WITH claimable') ? [[], 0] : []));
    await publishRealtimeScope(tenant as never, jest.fn(), 'test', { organisationId: ORG, workspaceId: WS }, ids ? { ids: [...ids] } : {});
    const update = statements[0]!.sql.slice(statements[0]!.sql.indexOf('UPDATE core.realtime_event')).replace(/\s+/g, ' ');
    expect(update).toContain("WHEN status = 'processing' THEN attempt_count + 1 ELSE attempt_count END");
    expect(update).toContain("status = 'processing' AND attempt_count + 1 >= max_attempts");
    expect(update).toContain("'LEASE_RECLAIM_EXHAUSTED'");
    expect(update).toContain('WHERE id IN (SELECT id FROM claimable)');
    expect(update).toMatch(/RETURNING .*\bstatus$/);
  });

  it('a row the claim ended failed (exhausted) is not published, is counted as failed, and is not a claimed row', async () => {
    const E2 = '00000000-0000-4000-8000-000000000002';
    const { tenant, statements } = fakeTenant((sql) => (sql.includes('WITH claimable') ? [[claimRow(E1, 'failed', 10), claimRow(E2, 'processing')], 2] : [[{ id: E2 }], 1]));
    const publish = jest.fn(async () => 1);
    const result = await publishRealtimeScope(tenant as never, publish, 'test', { organisationId: ORG, workspaceId: WS }, { ids: [E1, E2] });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(JSON.parse((publish.mock.calls[0] as unknown as [string, string])[1]).eventId).toBe(E2);
    expect(result).toMatchObject({ claimed: 1, published: 1, failed: 1 });
    // No write is issued for the exhausted row: the claim statement already ended it.
    expect(statements.filter((s) => s.params.includes(E1) && !s.sql.includes('WITH claimable'))).toEqual([]);
  });

  it('rows from a responder without a status column (pre-D-Q5a shape) are all returned — only an explicit failed row is withheld', async () => {
    const { tenant } = fakeTenant((sql) => (sql.includes('WITH claimable') ? [[{ ...claimRow(E1, 'processing'), status: undefined }], 1] : [[{ id: E1 }], 1]));
    const result = await publishRealtimeScope(tenant as never, jest.fn(async () => 1), 'test', { organisationId: ORG, workspaceId: WS }, { ids: [E1] });
    expect(result).toMatchObject({ claimed: 1, published: 1, failed: 0 });
  });
});

/** D-Q5a (CodeRabbit on #47): a live claimant renews its lease once half of it has elapsed; a normal batch never does. */
describe('D-Q5a realtime lease renewal during a slow batch', () => {
  const ids = ['00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000014'];
  const claimRows = ids.map((id) => ({
    id, organisation_id: ORG, workspace_id: WS, target_user_id: USER, event_type: 'offer.sent', entity_type: 'job_offer', entity_id: id,
    payload: {}, schema_version: 1, attempt_count: 0, max_attempts: 10, claim_token: 't', created_at: new Date(0), status: 'processing',
  }));
  const isRenew = (sql: string) => sql.includes('SET lease_expires_at = now()') && !sql.includes('WITH claimable');
  let clock = 0;
  beforeEach(() => {
    clock = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
  });
  afterEach(() => jest.restoreAllMocks());

  it('a batch that finishes inside half the lease issues NO renewal (identical statements to before)', async () => {
    const { tenant, statements } = fakeTenant((sql) => (sql.includes('WITH claimable') ? [claimRows, 4] : [[{ id: 'x' }], 1]));
    const publish = jest.fn(async () => {
      clock += 1_000;
      return 1;
    });
    const result = await publishRealtimeScope(tenant as never, publish, 'test', { organisationId: ORG, workspaceId: WS }, {});
    expect(result).toMatchObject({ claimed: 4, published: 4 });
    expect(statements.filter((s) => isRenew(s.sql))).toEqual([]);
  });

  it('once half the 60 s lease has elapsed, ONE fenced renewal covers exactly the rows still to do', async () => {
    const { tenant, statements } = fakeTenant((sql) => (sql.includes('WITH claimable') ? [claimRows, 4] : isRenew(sql) ? [[{ id: ids[2] }, { id: ids[3] }], 2] : [[{ id: 'x' }], 1]));
    const publish = jest.fn(async () => {
      clock += 20_000; // a slow (but alive) publisher
      return 1;
    });
    const result = await publishRealtimeScope(tenant as never, publish, 'test', { organisationId: ORG, workspaceId: WS }, {});
    expect(result).toMatchObject({ claimed: 4, published: 4 });
    const renewals = statements.filter((s) => isRenew(s.sql));
    expect(renewals).toHaveLength(1);
    const claimToken = statements.find((s) => s.sql.includes('WITH claimable'))!.params[0];
    expect(renewals[0]!.params).toEqual([[ids[2], ids[3]], claimToken, '60']);
    expect(renewals[0]!.sql).toContain("status = 'processing' AND claim_token = $2");
  });

  it('NEGATIVE: a renewal that throws does not stop the batch (falls back to the pre-renewal behaviour)', async () => {
    const { tenant } = fakeTenant((sql) => {
      if (sql.includes('WITH claimable')) return [claimRows, 4];
      if (isRenew(sql)) throw new Error('connection reset');
      return [[{ id: 'x' }], 1];
    });
    const publish = jest.fn(async () => {
      clock += 20_000;
      return 1;
    });
    await expect(publishRealtimeScope(tenant as never, publish, 'test', { organisationId: ORG, workspaceId: WS }, {})).resolves.toMatchObject({ claimed: 4, published: 4 });
  });
});
