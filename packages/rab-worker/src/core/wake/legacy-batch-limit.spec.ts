import { catalogue, DQ5A_SQL_SHA256, fakeTenant, PRE_PHASE_D_SQL_SHA256, sha256 } from '../../__tests__/helpers/dispatch-fakes';
import { dispatchEmailScope, runEmailDispatchCycle } from '../../queues/rab-email/email-dispatch.job';
import { dispatchPushScope, runPushDispatchCycle } from '../../queues/rab-push/push-dispatch.job';
import { publishRealtimeScope } from '../../queues/rab-realtime/publish-outbox.job';
import { runShiftStatementDispatchCycle } from '../../queues/rab-reports/shift-statement.job';
import { captureLegacyBatchLimit, noteLegacyBatchLimitReached } from './legacy-batch-limit';

/**
 * #24 — the "legacy sweep reached its batch limit" signal. Each per_scope cycle notes a FULL batch for a scope (email /
 * push 50 per organisation, realtime 25 per scope, statements 200 per workspace) and nothing else: one row short of the
 * limit is not a signal, and the global-mode (ids) path never signals. per_scope SQL stays byte-for-byte unchanged.
 */
const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';
const WS = '00000000-0000-4000-8000-0000000000a1';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rows = (n: number, make: (i: number) => Record<string, unknown>) => Array.from({ length: n }, (_, i) => make(i + 1));

describe('legacy batch-limit capture', () => {
  it('is a no-op outside a capture (per_scope mode)', () => {
    expect(() => noteLegacyBatchLimitReached()).not.toThrow();
  });

  it('counts the notes of one sweep, and concurrent captures never see each other', async () => {
    const tick = () => new Promise((r) => setImmediate(r));
    const [a, b] = await Promise.all([
      captureLegacyBatchLimit(async () => {
        noteLegacyBatchLimitReached();
        await tick();
        noteLegacyBatchLimitReached();
        return 'a';
      }),
      captureLegacyBatchLimit(async () => {
        await tick();
        return 'b';
      }),
    ]);
    expect(a).toEqual({ value: 'a', scopesAtLimit: 2 });
    expect(b).toEqual({ value: 'b', scopesAtLimit: 0 });
  });

  it('a throwing sweep propagates its error unchanged', async () => {
    await expect(captureLegacyBatchLimit(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });
});

describe('email per_scope cycle: one note per organisation whose 50-row batch came back full', () => {
  const emailRow = (i: number) => ({ id: id(i), organisation_id: ORG_A, status: 'PENDING', infrastructure_attempt_count: 0, max_infrastructure_attempts: 5, provider_call_started_at: null, dispatch_generation: 0 });
  const run = async (perOrg: Record<string, number>) => {
    const orgs = catalogue(Object.keys(perOrg));
    let ctxOrg = '';
    const { tenant, dataSource, statements } = fakeTenant((sql, params) => {
      const page = orgs(sql, params);
      if (page !== undefined) return page;
      if (sql.includes('FROM core.email_outbox')) return rows(perOrg[ctxOrg]!, emailRow);
      return [];
    });
    const wrapped = { runInTenantContext: (ctx: { organisationId: string }, fn: (m: unknown) => Promise<unknown>) => { ctxOrg = ctx.organisationId; return tenant.runInTenantContext(ctx as never, fn); } };
    const sweep = await captureLegacyBatchLimit(() => runEmailDispatchCycle(dataSource as never, wrapped as never, jest.fn(async () => undefined), jest.fn(), false));
    return { scopesAtLimit: sweep.scopesAtLimit, claims: statements.filter((s) => s.sql.includes('FROM core.email_outbox')) };
  };

  it.each([
    [{ [ORG_A]: 0, [ORG_B]: 0 }, 0],
    [{ [ORG_A]: 49, [ORG_B]: 0 }, 0],
    [{ [ORG_A]: 50, [ORG_B]: 0 }, 1],
    [{ [ORG_A]: 50, [ORG_B]: 50 }, 2],
  ])('claims %j → %i scope(s) at the limit; the claim SQL is unchanged', async (perOrg, expected) => {
    const { scopesAtLimit, claims } = await run(perOrg);
    expect(scopesAtLimit).toBe(expected);
    for (const c of claims) expect(sha256(c.sql)).toBe(PRE_PHASE_D_SQL_SHA256.emailClaim);
  });

  it('the global-mode (ids) claim never signals, even when it returns as many rows as the batch', async () => {
    const { tenant } = fakeTenant((sql) => (sql.includes('FROM core.email_outbox') ? rows(50, emailRow) : []));
    const ids = rows(50, emailRow).map((r) => r.id as string);
    const sweep = await captureLegacyBatchLimit(() => dispatchEmailScope(tenant as never, ORG_A, ids, jest.fn(async () => undefined), jest.fn(), false));
    expect(sweep.scopesAtLimit).toBe(0);
  });
});

describe('push per_scope cycle: one note per organisation whose 50-row batch came back full AND moved something', () => {
  // A never-published PENDING row (queued_at NULL): the pass stamps it — progress.
  const pushRow = (i: number) => ({ id: id(i), organisation_id: ORG_A, status: 'PENDING', attempt_count: 0, max_attempts: 5, provider_call_started_at: null, dispatch_generation: 0, queued_at: null, stale_pending: false });
  // Already published, consumer not caught up yet (PENDING, queued_at set, not stale): a re-visit moves nothing.
  const queuedRow = (i: number) => ({ ...pushRow(i), queued_at: new Date() });
  const run = async (n: number, ids?: string[], make: (i: number) => Record<string, unknown> = pushRow) => {
    const orgs = catalogue([ORG_A]);
    const { tenant, dataSource, statements } = fakeTenant((sql, params) => {
      const page = orgs(sql, params);
      if (page !== undefined) return page;
      if (sql.includes('FROM core.push_delivery')) return rows(n, make);
      return [];
    });
    const sweep = await captureLegacyBatchLimit(() => (ids
      ? dispatchPushScope(tenant as never, ORG_A, ids, jest.fn(async () => undefined), jest.fn(), false)
      : runPushDispatchCycle(dataSource as never, tenant as never, jest.fn(async () => undefined), jest.fn(), false)));
    return { scopesAtLimit: sweep.scopesAtLimit, claims: statements.filter((s) => s.sql.includes('FROM core.push_delivery')) };
  };

  it.each([[0, 0], [49, 0], [50, 1]])('%i claimed → %i', async (n, expected) => {
    const { scopesAtLimit, claims } = await run(n);
    expect(scopesAtLimit).toBe(expected);
    for (const c of claims) expect(sha256(c.sql)).toBe(PRE_PHASE_D_SQL_SHA256.pushClaim);
  });

  it('the global-mode (ids) claim never signals', async () => {
    expect((await run(50, rows(50, pushRow).map((r) => r.id as string))).scopesAtLimit).toBe(0);
  });

  it('a full batch of already-queued rows (the consumer is behind) does NOT signal: push drain is consumer-paced, never a re-walk loop', async () => {
    expect((await run(50, undefined, queuedRow)).scopesAtLimit).toBe(0);
  });

  it('a full batch with at least one row it actually moved (first publish) signals', async () => {
    expect((await run(50, undefined, (i) => (i === 50 ? pushRow(i) : queuedRow(i)))).scopesAtLimit).toBe(1);
  });

  it('a full batch whose rows are stale (re-published under a new generation) signals', async () => {
    const orgs = catalogue([ORG_A]);
    const { tenant, dataSource } = fakeTenant((sql, params) => {
      const page = orgs(sql, params);
      if (page !== undefined) return page;
      if (sql.includes('FROM core.push_delivery')) return rows(50, (i) => ({ ...queuedRow(i), stale_pending: true }));
      if (sql.includes('dispatch_generation = dispatch_generation + 1')) return [[{ dispatch_generation: 1 }], 1];
      return [];
    });
    const sweep = await captureLegacyBatchLimit(() => runPushDispatchCycle(dataSource as never, tenant as never, jest.fn(async () => undefined), jest.fn(async () => undefined), false));
    expect(sweep.scopesAtLimit).toBe(1);
  });
});

describe('realtime per_scope scope: one note per scope whose 25-event batch came back full', () => {
  const run = async (n: number, ids?: string[]) => {
    const { tenant, statements } = fakeTenant((sql) => (sql.includes('WITH claimable') ? [rows(n, () => ({})).map((_, i) => ({
      id: id(i + 1), organisation_id: ORG_A, workspace_id: WS, target_user_id: id(900), event_type: 'offer.sent', entity_type: 'job_offer', entity_id: id(i + 1),
      payload: {}, schema_version: 1, attempt_count: 0, max_attempts: 5, claim_token: 't', created_at: new Date(0),
    })), n] : [[], 0]));
    const sweep = await captureLegacyBatchLimit(() => publishRealtimeScope(tenant as never, jest.fn(async () => 1), 'test', { organisationId: ORG_A, workspaceId: WS }, ids ? { ids } : {}));
    return { scopesAtLimit: sweep.scopesAtLimit, claims: statements.filter((s) => s.sql.includes('WITH claimable')) };
  };

  it.each([[0, 0], [24, 0], [25, 1]])('%i claimed → %i; the claim SQL is unchanged', async (n, expected) => {
    const { scopesAtLimit, claims } = await run(n);
    expect(scopesAtLimit).toBe(expected);
    expect(sha256(claims[0]!.sql)).toBe(DQ5A_SQL_SHA256.realtimeClaim);
  });

  it('the global-mode (ids) claim never signals', async () => {
    expect((await run(25, rows(25, (i) => ({ i })).map((_, i) => id(i + 1)))).scopesAtLimit).toBe(0);
  });
});

describe('statement per_scope discovery: one note per workspace whose 200-record page came back full', () => {
  const run = async (n: number) => {
    let served = false;
    const { tenant, dataSource, statements } = fakeTenant((sql) => {
      if (sql.includes('worker_list_workspaces')) {
        if (served) return [];
        served = true;
        return [{ workspace_id: WS, organisation_id: ORG_A }];
      }
      if (sql.includes('FROM payroll_record WHERE')) return rows(n, (i) => ({ id: id(i), organisation_id: ORG_A, workspace_id: WS, statement_status: 'pending' }));
      if (sql.startsWith('UPDATE payroll_record')) return [[], 0]; // CAS lost: nothing claimed
      return [];
    });
    const sweep = await captureLegacyBatchLimit(() => runShiftStatementDispatchCycle(dataSource as never, tenant as never, jest.fn(async () => undefined)));
    return { scopesAtLimit: sweep.scopesAtLimit, scans: statements.filter((s) => s.sql.includes('FROM payroll_record WHERE')) };
  };

  it.each([[0, 0], [199, 0], [200, 1]])('%i discovered → %i; the discovery SQL is unchanged', async (n, expected) => {
    const { scopesAtLimit, scans } = await run(n);
    expect(scopesAtLimit).toBe(expected);
    expect(sha256(scans[0]!.sql)).toBe(PRE_PHASE_D_SQL_SHA256.statementScan);
  });
});

describe('D-Q5a: realtime rows the claim ended failed (lease-reclaim cap) still count toward a full batch', () => {
  it('24 returned + 1 exhausted = 25 rows taken by the LIMIT → one note (more due events may remain)', async () => {
    const make = (i: number, status: string) => ({
      id: id(i), organisation_id: ORG_A, workspace_id: WS, target_user_id: id(900), event_type: 'offer.sent', entity_type: 'job_offer', entity_id: id(i),
      payload: {}, schema_version: 1, attempt_count: 0, max_attempts: 5, claim_token: 't', created_at: new Date(0), status,
    });
    const claimRows = [...rows(24, (i) => make(i, 'processing')), make(25, 'failed')];
    const { tenant } = fakeTenant((sql) => (sql.includes('WITH claimable') ? [claimRows, 25] : [[{ id: id(1) }], 1]));
    const sweep = await captureLegacyBatchLimit(() => publishRealtimeScope(tenant as never, jest.fn(async () => 1), 'test', { organisationId: ORG_A, workspaceId: WS }, {}));
    expect(sweep.scopesAtLimit).toBe(1);
  });
});
