import { catalogue, fakeTenant, PRE_PHASE_D_SQL_SHA256, sha256 } from '../../__tests__/helpers/dispatch-fakes';
import { dispatchPushScope, runPushDispatchCycle } from './push-dispatch.job';

/** Phase D (D1): push dispatcher — per_scope byte-for-byte; global = same scoped transaction restricted to claimed ids. */
const ORG_A = '00000000-0000-4000-8000-00000000000a';
const R1 = '00000000-0000-4000-8000-000000000001';
const R2 = '00000000-0000-4000-8000-000000000002';
const row = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, organisation_id: ORG_A, status, attempt_count: 1, max_attempts: 5, provider_call_started_at: null, ...extra,
});

function responder(claimRows: unknown[]) {
  const orgs = catalogue([ORG_A]);
  return (sql: string, params: unknown[]) => {
    const page = orgs(sql, params);
    if (page !== undefined) return page;
    if (sql.includes('FROM core.push_delivery')) return claimRows;
    if (sql.includes('dispatch_generation = dispatch_generation + 1')) return [[{ dispatch_generation: 3 }], 1];
    return [];
  };
}

describe('push dispatch', () => {
  it('per_scope: exactly the pre-Phase-D claim SQL, batch 50, org-only context', async () => {
    const { tenant, dataSource, statements, contexts } = fakeTenant(responder([]));
    await runPushDispatchCycle(dataSource as never, tenant as never, jest.fn(), jest.fn(), false);
    const [claim] = statements.filter((s) => s.sql.includes('FROM core.push_delivery'));
    expect(sha256(claim!.sql)).toBe(PRE_PHASE_D_SQL_SHA256.pushClaim);
    expect(claim!.params).toEqual([50]);
    expect(contexts).toEqual([{ organisationId: ORG_A, workspaceId: null, userId: '', role: '' }]);
  });

  it('global: same transaction shape restricted to the claimed ids; recovery bumps the generation as before', async () => {
    const { tenant, statements, contexts } = fakeTenant(responder([row(R1, 'PENDING', { attempt_count: 0 }), row(R2, 'RETRY')]));
    const publish = jest.fn(async () => undefined);
    const republish = jest.fn(async () => undefined);
    const result = await dispatchPushScope(tenant as never, ORG_A, [R1, R2], publish, republish, false);
    expect(contexts).toEqual([{ organisationId: ORG_A, workspaceId: null, userId: '', role: '' }]);
    const [claim] = statements.filter((s) => s.sql.includes('FROM core.push_delivery'));
    expect(claim!.sql).toContain('AND id = ANY($2::uuid[])');
    expect(claim!.sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(claim!.params).toEqual([2, [R1, R2]]);
    expect(publish).toHaveBeenCalledWith(R1, ORG_A);
    expect(republish).toHaveBeenCalledWith(R2, ORG_A, 3);
    expect(result).toMatchObject({ claimed: 2, published: 2, recovered: 1 });
  });

  it('global and per_scope share the eligibility predicate text', async () => {
    const a = fakeTenant(responder([]));
    await runPushDispatchCycle(a.dataSource as never, a.tenant as never, jest.fn(), jest.fn(), false);
    const b = fakeTenant(responder([]));
    await dispatchPushScope(b.tenant as never, ORG_A, [R1], jest.fn(), jest.fn(), false);
    // From WHERE (the select list also mentions status = 'PENDING' since the stale-PENDING fix).
    const predicate = (sql: string) =>
      sql.slice(sql.indexOf('WHERE') + 'WHERE'.length, sql.indexOf('ORDER BY')).trim().replace(/^\(/, '').replace(/\)\s*AND id = ANY\(\$2::uuid\[\]\)$/, '').trim();
    expect(predicate(b.statements.find((s) => s.sql.includes('push_delivery'))!.sql)).toBe(predicate(a.statements.find((s) => s.sql.includes('push_delivery'))!.sql));
  });
});

/**
 * Lead follow-up (C-report §6.2, E8 long-race residue): a PENDING row was re-published every cycle as `.attempt.0`. Once
 * ANY job with that id is retained (completed 7 d / failed 30 d — e.g. an E8 not-visible job that exhausted its attempts),
 * BullMQ silently drops the re-add and the row is stranded PENDING forever. Mirror email: stamp `queued_at` on the first
 * publish; a PENDING row whose `queued_at` is older than 2 min is recovered with a generation bump and re-published
 * under a FRESH `.attempt.<gen>` id; a PENDING row with generation > 0 is always published under its current generation.
 */
describe('push dispatch — stale PENDING recovery (fresh jobId generation)', () => {
  function pendingResponder(row: Record<string, unknown>, bumpedTo = 1) {
    const orgs = catalogue([ORG_A]);
    return (sql: string, params: unknown[]) => {
      const page = orgs(sql, params);
      if (page !== undefined) return page;
      if (sql.includes('FROM core.push_delivery')) return [row];
      if (sql.includes('dispatch_generation = dispatch_generation + 1')) return [[{ dispatch_generation: bumpedTo }], 1];
      return [[], 1];
    };
  }
  const pending = (extra: Record<string, unknown>) => row(R1, 'PENDING', { attempt_count: 0, dispatch_generation: 0, queued_at: null, stale_pending: false, ...extra });

  it('first publish of a PENDING row stamps queued_at and keeps the stable attempt.0 publish', async () => {
    const { tenant, statements } = fakeTenant(pendingResponder(pending({})));
    const publish = jest.fn(async () => undefined);
    const republish = jest.fn(async () => undefined);
    await dispatchPushScope(tenant as never, ORG_A, undefined, publish, republish, false);
    expect(statements.some((s) => /SET queued_at = now\(\)/.test(s.sql) && /queued_at IS NULL/.test(s.sql))).toBe(true);
    expect(publish).toHaveBeenCalledWith(R1, ORG_A);
    expect(republish).not.toHaveBeenCalled();
  });

  it('a PENDING row queued > 2 min ago is recovered: generation bumped, queued_at re-stamped, republished under .attempt.<gen>', async () => {
    const { tenant, statements } = fakeTenant(pendingResponder(pending({ queued_at: new Date(Date.now() - 10 * 60_000), stale_pending: true }), 1));
    const publish = jest.fn(async () => undefined);
    const republish = jest.fn(async () => undefined);
    const result = await dispatchPushScope(tenant as never, ORG_A, undefined, publish, republish, false);
    const bump = statements.find((s) => s.sql.includes('dispatch_generation = dispatch_generation + 1'));
    expect(bump!.sql).toContain('queued_at = now()');
    expect(bump!.sql).toContain("status = 'PENDING'"); // stays PENDING (the consumer's CAS accepts PENDING/RETRY)
    expect(republish).toHaveBeenCalledWith(R1, ORG_A, 1);
    expect(publish).not.toHaveBeenCalled();
    expect(result).toMatchObject({ published: 1, recovered: 1 });
  });

  it('a fresh PENDING row of generation > 0 is published under ITS generation, never attempt.0 (no bump)', async () => {
    const { tenant, statements } = fakeTenant(pendingResponder(pending({ dispatch_generation: 2, queued_at: new Date() })));
    const publish = jest.fn(async () => undefined);
    const republish = jest.fn(async () => undefined);
    await dispatchPushScope(tenant as never, ORG_A, undefined, publish, republish, false);
    expect(republish).toHaveBeenCalledWith(R1, ORG_A, 2);
    expect(publish).not.toHaveBeenCalled();
    expect(statements.some((s) => s.sql.includes('dispatch_generation = dispatch_generation + 1'))).toBe(false);
  });

  it('PROCESSING/RETRY recovery also re-stamps queued_at, so the recovered row is not re-recovered on the next cycle', async () => {
    const { tenant, statements } = fakeTenant(pendingResponder(row(R1, 'RETRY', { queued_at: new Date(Date.now() - 60 * 60_000), stale_pending: false }), 4));
    const republish = jest.fn(async () => undefined);
    await dispatchPushScope(tenant as never, ORG_A, undefined, jest.fn(), republish, false);
    const bump = statements.find((s) => s.sql.includes('dispatch_generation = dispatch_generation + 1'));
    expect(bump!.sql).toContain('queued_at = now()');
    expect(republish).toHaveBeenCalledWith(R1, ORG_A, 4);
  });

  it('the stale test is computed by the database clock in the claim (both modes), never by the Worker clock', async () => {
    const a = fakeTenant(pendingResponder(pending({})));
    await runPushDispatchCycle(a.dataSource as never, a.tenant as never, jest.fn(), jest.fn(), false);
    const b = fakeTenant(pendingResponder(pending({})));
    await dispatchPushScope(b.tenant as never, ORG_A, [R1], jest.fn(), jest.fn(), false);
    for (const sql of [a, b].map((f) => f.statements.find((s) => s.sql.includes('FROM core.push_delivery'))!.sql)) {
      expect(sql).toContain("(status = 'PENDING' AND queued_at < now() - interval '2 minutes') AS stale_pending");
    }
  });
});
