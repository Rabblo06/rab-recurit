import { catalogue, fakeTenant, PRE_PHASE_D_SQL_SHA256, sha256 } from '../../__tests__/helpers/dispatch-fakes';
import { dispatchEmailScope, runEmailDispatchCycle } from './email-dispatch.job';

/**
 * Phase D (D1): the email dispatcher's per-organisation body is shared by both claim modes. per_scope mode must issue
 * byte-for-byte the pre-Phase-D SQL; global mode runs the SAME scoped transaction with the claim restricted to the
 * claimed ids (`AND id = ANY($2::uuid[])`) — row locks, SKIP LOCKED, status transitions, generation bumps, audit rows and
 * jobIds exactly as before.
 */
const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';
const ROW = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  organisation_id: ORG_A,
  status,
  infrastructure_attempt_count: 0,
  max_infrastructure_attempts: 5,
  provider_call_started_at: null,
  dispatch_generation: 0,
  ...extra,
});
const R1 = '00000000-0000-4000-8000-000000000001';
const R2 = '00000000-0000-4000-8000-000000000002';

function responder(claimRows: unknown[]) {
  const orgs = catalogue([ORG_A, ORG_B]);
  return (sql: string, params: unknown[]) => {
    const page = orgs(sql, params);
    if (page !== undefined) return page;
    if (sql.includes('FROM core.email_outbox')) return claimRows;
    if (sql.includes('dispatch_generation = dispatch_generation + 1')) return [[{ id: R2, dispatch_generation: 1 }], 1];
    return [];
  };
}

describe('email dispatch — per_scope mode (unchanged)', () => {
  it('claims with exactly the pre-Phase-D SQL, per organisation, batch 50, in the same tenant context as before', async () => {
    const { tenant, dataSource, statements, contexts } = fakeTenant(responder([]));
    const publish = jest.fn(async () => undefined);
    await runEmailDispatchCycle(dataSource as never, tenant as never, publish, jest.fn(), false);
    const claims = statements.filter((s) => s.sql.includes('FROM core.email_outbox'));
    expect(claims).toHaveLength(2);
    for (const c of claims) {
      expect(sha256(c.sql)).toBe(PRE_PHASE_D_SQL_SHA256.emailClaim);
      expect(c.params).toEqual([50]);
    }
    expect(contexts).toEqual([
      { organisationId: ORG_A, workspaceId: null, userId: '', role: '' },
      { organisationId: ORG_B, workspaceId: null, userId: '', role: '' },
    ]);
  });
});

describe('email dispatch — global mode scope', () => {
  it('runs one scoped transaction for the organisation with the claim restricted to the claimed ids', async () => {
    const { tenant, statements, contexts } = fakeTenant(responder([ROW(R1, 'PENDING')]));
    const publish = jest.fn(async () => undefined);
    const result = await dispatchEmailScope(tenant as never, ORG_A, [R1, R2], publish, jest.fn(), false);
    expect(contexts).toEqual([{ organisationId: ORG_A, workspaceId: null, userId: '', role: '' }]);
    const [claim] = statements.filter((s) => s.sql.includes('FROM core.email_outbox'));
    expect(claim!.sql).toContain("WHERE (status = 'PENDING'");
    expect(claim!.sql).toContain('AND id = ANY($2::uuid[])');
    expect(claim!.sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(claim!.params).toEqual([2, [R1, R2]]);
    // Same transition and jobId as per_scope: PENDING → QUEUED, then publish(id, org) (attempt.0) AFTER the commit.
    expect(statements.some((s) => s.sql === `UPDATE core.email_outbox SET status = 'QUEUED', queued_at = now() WHERE id = ANY($1::uuid[])`)).toBe(true);
    expect(publish).toHaveBeenCalledWith(R1, ORG_A);
    expect(result).toMatchObject({ claimed: 1, published: 1 });
  });

  it('the eligibility predicate is the SAME text as per_scope mode (only the id restriction and the limit differ)', async () => {
    const perScope = fakeTenant(responder([]));
    await runEmailDispatchCycle(perScope.dataSource as never, perScope.tenant as never, jest.fn(), jest.fn(), false);
    const global = fakeTenant(responder([]));
    await dispatchEmailScope(global.tenant as never, ORG_A, [R1], jest.fn(), jest.fn(), false);
    const legacySql = perScope.statements.find((s) => s.sql.includes('FROM core.email_outbox'))!.sql;
    const globalSql = global.statements.find((s) => s.sql.includes('FROM core.email_outbox'))!.sql;
    const predicate = (sql: string) => sql.slice(sql.indexOf("status = 'PENDING'"), sql.indexOf('ORDER BY')).replace(/\)\s*AND id = ANY\(\$2::uuid\[\]\)\s*$/, '').trim();
    expect(predicate(globalSql)).toBe(predicate(legacySql));
  });

  it('a recovered row gets its generation bumped and is republished under the new jobId generation (unchanged)', async () => {
    const { tenant } = fakeTenant(responder([ROW(R2, 'QUEUED')]));
    const republish = jest.fn(async () => undefined);
    const result = await dispatchEmailScope(tenant as never, ORG_A, [R2], jest.fn(), republish, false);
    expect(republish).toHaveBeenCalledWith(R2, ORG_A, 1);
    expect(result).toMatchObject({ recovered: 1 });
  });

  it('an empty id list touches nothing (no transaction)', async () => {
    const { tenant, statements } = fakeTenant(responder([]));
    await dispatchEmailScope(tenant as never, ORG_A, [], jest.fn(), jest.fn(), false);
    expect(statements).toHaveLength(0);
  });
});
