import { catalogue, fakeTenant, PRE_PHASE_D_SQL_SHA256, sha256 } from '../../__tests__/helpers/dispatch-fakes';
import { dispatchEmailScope, MAX_DISPATCH_GENERATIONS, runEmailDispatchCycle } from './email-dispatch.job';

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

/**
 * D-Q5b (OC-1 + OD-5): the claim now counts the in-flight attempt, so a PROCESSING row whose lease expired at count = max
 * is "the last allowed attempt died". If that attempt had already reached the provider (marker set) — including a
 * confirmed send whose SENT write failed (OD-5) — the email may have gone out: it is marked DELIVERY_UNCERTAIN (manual
 * review, replay only with the explicit allow-uncertain flag), never re-sent and never labelled a plain exhausted failure
 * that a replay would resend. Without the marker nothing was sent: STUCK_LEASE_ATTEMPTS_EXHAUSTED, as before.
 */
describe('email dispatch — D-Q5b exhausted lease classification', () => {
  const MARKER = new Date('2026-11-04T10:00:00Z');
  for (const safe of [false, true]) {
    it(`PROCESSING at the cap WITH the provider-call marker → DELIVERY_UNCERTAIN, never republished (driver safe to retry: ${safe})`, async () => {
      const { tenant, statements } = fakeTenant(responder([ROW(R1, 'PROCESSING', { infrastructure_attempt_count: 5, provider_call_started_at: MARKER })]));
      const publish = jest.fn(async () => undefined);
      const republish = jest.fn(async () => undefined);
      const result = await dispatchEmailScope(tenant as never, ORG_A, [R1], publish, republish, safe);
      expect(publish).not.toHaveBeenCalled();
      expect(republish).not.toHaveBeenCalled();
      expect(result).toMatchObject({ deliveryUncertain: 1, failedExhausted: 0, published: 0 });
      const uncertain = statements.filter((s) => s.sql.includes("last_error_code = 'DELIVERY_UNCERTAIN'"));
      expect(uncertain).toHaveLength(1);
      expect(uncertain[0]!.params).toEqual([[R1]]);
      expect(uncertain[0]!.sql).toContain('Attempt cap reached'); // its own reason, not "the driver cannot safely retry"
      expect(uncertain[0]!.sql).not.toContain('cannot safely confirm or retry');
      expect(statements.some((s) => s.sql.includes('STUCK_LEASE_ATTEMPTS_EXHAUSTED'))).toBe(false);
      expect(statements.some((s) => s.sql.includes('INSERT INTO core.audit_log') && String(s.params[1]) === 'email.delivery_uncertain')).toBe(true);
    });
  }

  it('PROCESSING at the cap WITHOUT the marker (nothing was sent) → STUCK_LEASE_ATTEMPTS_EXHAUSTED, unchanged', async () => {
    const { tenant, statements } = fakeTenant(responder([ROW(R1, 'PROCESSING', { infrastructure_attempt_count: 5 })]));
    const result = await dispatchEmailScope(tenant as never, ORG_A, [R1], jest.fn(), jest.fn(), true);
    expect(result).toMatchObject({ failedExhausted: 1, deliveryUncertain: 0 });
    expect(statements.find((s) => s.sql.includes('STUCK_LEASE_ATTEMPTS_EXHAUSTED'))?.params).toEqual([[R1]]);
  });

  it('RETRY at the cap keeps the exhausted label even with an old marker (OD-6: no change to the RETRY-marker rule)', async () => {
    const { tenant } = fakeTenant(responder([ROW(R1, 'RETRY', { infrastructure_attempt_count: 5, provider_call_started_at: MARKER })]));
    const result = await dispatchEmailScope(tenant as never, ORG_A, [R1], jest.fn(), jest.fn(), false);
    expect(result).toMatchObject({ failedExhausted: 1, deliveryUncertain: 0 });
  });

  it('below the cap a PROCESSING row with the marker is unchanged: SMTP → DELIVERY_UNCERTAIN, Resend → republished (same delivery key)', async () => {
    const smtp = fakeTenant(responder([ROW(R2, 'PROCESSING', { infrastructure_attempt_count: 2, provider_call_started_at: MARKER })]));
    expect(await dispatchEmailScope(smtp.tenant as never, ORG_A, [R2], jest.fn(), jest.fn(), false)).toMatchObject({ deliveryUncertain: 1 });
    const resend = fakeTenant(responder([ROW(R2, 'PROCESSING', { infrastructure_attempt_count: 2, provider_call_started_at: MARKER })]));
    const republish = jest.fn(async () => undefined);
    expect(await dispatchEmailScope(resend.tenant as never, ORG_A, [R2], jest.fn(), republish, true)).toMatchObject({ recovered: 1, deliveryUncertain: 0 });
    expect(republish).toHaveBeenCalledWith(R2, ORG_A, 1);
  });
});

/**
 * email-twenty owner decisions 2026-11-07.
 * Decision 1 ("SPLIT"): a RETRY row carries a RECORDED outcome (the processor classified the failure as retryable), so a
 * lost job is re-presented automatically even though the marker of that earlier attempt is still set (fault case b3).
 * DELIVERY_UNCERTAIN is kept for a PROCESSING row with the marker (this attempt reached the provider, outcome lost: a crash
 * mid-send, or OD-5). Decision 2 ("CAP IT"): a stale QUEUED row already re-queued 20 times is FAILED
 * DISPATCH_GENERATIONS_EXHAUSTED and never re-queued.
 */
describe('email dispatch — email-twenty Decision 1: recorded refusal re-presented, true mid-send loss uncertain', () => {
  const MARKER = new Date('2026-11-07T10:00:00Z');

  it('b3: a stale RETRY row with an older marker (451 recorded) is republished under a new generation on SMTP, NOT DELIVERY_UNCERTAIN', async () => {
    const { tenant, statements } = fakeTenant(responder([ROW(R2, 'RETRY', { infrastructure_attempt_count: 2, provider_call_started_at: MARKER })]));
    const republish = jest.fn(async () => undefined);
    const result = await dispatchEmailScope(tenant as never, ORG_A, [R2], jest.fn(), republish, false);
    expect(result).toMatchObject({ recovered: 1, deliveryUncertain: 0 });
    expect(republish).toHaveBeenCalledWith(R2, ORG_A, 1);
    expect(statements.some((s) => s.sql.includes("'DELIVERY_UNCERTAIN'"))).toBe(false);
  });

  it('a stale QUEUED row recovered from such a RETRY (older marker) is also re-presented on SMTP', async () => {
    const { tenant } = fakeTenant(responder([ROW(R2, 'QUEUED', { infrastructure_attempt_count: 2, provider_call_started_at: MARKER, dispatch_generation: 1 })]));
    const republish = jest.fn(async () => undefined);
    expect(await dispatchEmailScope(tenant as never, ORG_A, [R2], jest.fn(), republish, false)).toMatchObject({ recovered: 1, deliveryUncertain: 0 });
  });

  it('a true mid-send loss (PROCESSING with this attempt\'s marker) still ends DELIVERY_UNCERTAIN on SMTP, never republished', async () => {
    const { tenant, statements } = fakeTenant(responder([ROW(R2, 'PROCESSING', { infrastructure_attempt_count: 2, provider_call_started_at: MARKER })]));
    const republish = jest.fn(async () => undefined);
    expect(await dispatchEmailScope(tenant as never, ORG_A, [R2], jest.fn(), republish, false)).toMatchObject({ deliveryUncertain: 1, recovered: 0 });
    expect(republish).not.toHaveBeenCalled();
    expect(statements.some((s) => s.sql.includes("last_error_code = 'DELIVERY_UNCERTAIN'"))).toBe(true);
  });

  it('a PROCESSING row with NO marker (crash between the claim and this attempt\'s marker) is a safe republish', async () => {
    const { tenant } = fakeTenant(responder([ROW(R2, 'PROCESSING', { infrastructure_attempt_count: 2 })]));
    const republish = jest.fn(async () => undefined);
    expect(await dispatchEmailScope(tenant as never, ORG_A, [R2], jest.fn(), republish, false)).toMatchObject({ recovered: 1, deliveryUncertain: 0 });
  });
});

describe('email dispatch — email-twenty Decision 2: re-queue cap', () => {
  it('a stale QUEUED row already re-queued 20 times → FAILED DISPATCH_GENERATIONS_EXHAUSTED + audit, never republished', async () => {
    const { tenant, statements } = fakeTenant(responder([ROW(R2, 'QUEUED', { dispatch_generation: MAX_DISPATCH_GENERATIONS })]));
    const publish = jest.fn(async () => undefined);
    const republish = jest.fn(async () => undefined);
    const result = await dispatchEmailScope(tenant as never, ORG_A, [R2], publish, republish, false);
    expect(MAX_DISPATCH_GENERATIONS).toBe(20);
    expect(result).toMatchObject({ generationsExhausted: 1, recovered: 0, published: 0 });
    expect(publish).not.toHaveBeenCalled();
    expect(republish).not.toHaveBeenCalled();
    const failed = statements.find((s) => s.sql.includes("last_error_code = 'DISPATCH_GENERATIONS_EXHAUSTED'"));
    expect(failed?.params).toEqual([[R2]]);
    expect(failed?.sql).toContain("AND status = 'QUEUED'");
    expect(statements.some((s) => s.sql.includes('dispatch_generation = dispatch_generation + 1'))).toBe(false);
    const audit = statements.find((s) => s.sql.includes('INSERT INTO core.audit_log'));
    expect(audit?.params[1]).toBe('email.delivery_failed');
    expect(JSON.parse(String(audit?.params[2]))).toMatchObject({ emailOutboxId: R2, errorCode: 'DISPATCH_GENERATIONS_EXHAUSTED', generations: 20 });
  });

  it('below the cap (19 re-queues) the stale QUEUED row is re-queued as before', async () => {
    const { tenant } = fakeTenant(responder([ROW(R2, 'QUEUED', { dispatch_generation: 19 })]));
    const republish = jest.fn(async () => undefined);
    expect(await dispatchEmailScope(tenant as never, ORG_A, [R2], jest.fn(), republish, false)).toMatchObject({ recovered: 1, generationsExhausted: 0 });
  });

  it('the cap applies to stale QUEUED only: a RETRY row at a high generation (counted attempts) is still re-presented', async () => {
    const { tenant } = fakeTenant(responder([ROW(R2, 'RETRY', { dispatch_generation: 25, infrastructure_attempt_count: 1 })]));
    const republish = jest.fn(async () => undefined);
    expect(await dispatchEmailScope(tenant as never, ORG_A, [R2], jest.fn(), republish, false)).toMatchObject({ recovered: 1, generationsExhausted: 0 });
  });

  it('a re-queue whose publication fails (Redis down) gives its generation back, so an outage does not spend the cap', async () => {
    const { tenant, statements } = fakeTenant(responder([ROW(R2, 'QUEUED', { dispatch_generation: 0 })]));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const republish = jest.fn(async () => {
      throw new Error('Redis unavailable');
    });
    const result = await dispatchEmailScope(tenant as never, ORG_A, [R2], jest.fn(), republish, false);
    errorSpy.mockRestore();
    expect(result).toMatchObject({ published: 0, recovered: 0 });
    const giveBack = statements.find((s) => s.sql.includes('dispatch_generation = dispatch_generation - 1'));
    expect(giveBack?.params).toEqual([R2, 1]);
    expect(giveBack?.sql).toContain("status = 'QUEUED' AND dispatch_generation = $2");
  });

  it('a first-attempt publication failure gives nothing back (its generation was not bumped this cycle)', async () => {
    const { tenant, statements } = fakeTenant(responder([ROW(R1, 'PENDING', { dispatch_generation: 3 })]));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const republish = jest.fn(async () => {
      throw new Error('Redis unavailable');
    });
    await dispatchEmailScope(tenant as never, ORG_A, [R1], jest.fn(), republish, false);
    errorSpy.mockRestore();
    expect(statements.some((s) => s.sql.includes('dispatch_generation = dispatch_generation - 1'))).toBe(false);
  });
});
