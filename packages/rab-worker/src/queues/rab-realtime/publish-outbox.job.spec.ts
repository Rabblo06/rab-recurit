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
