import { describeWorkerPoolDemand, workerPoolDemand } from './pool-demand';

/**
 * XP-08 / XD-06: the boot line that states the Worker pool against its worst-case concurrent database users. The numbers
 * are the committed production shape (pool 12; email 5, push 10, statements 2, AI 4, timer triggers 2, audit events 2;
 * 4 scan slots × 4 workspaces). Pure arithmetic: nothing here changes the pool or any concurrency.
 */
const PRODUCTION = {
  consumers: [
    { name: 'rab-email', concurrency: 5 },
    { name: 'rab-push', concurrency: 10 },
    { name: 'rab-shift-statements', concurrency: 2 },
    { name: 'rab-ai', concurrency: 4 },
    { name: 'crewflow-audit-events', concurrency: 2 },
  ],
  scanSlots: 4,
  perScanParallel: 4,
  poolMax: 12,
};

describe('Worker pool demand (XP-08)', () => {
  it('sums every started consumer and the periodic cycles; the production shape is above its pool of 12', () => {
    expect(workerPoolDemand(PRODUCTION)).toEqual({ consumerDemand: 23, scanDemand: 16, worstCase: 39, poolMax: 12, exceedsPool: true });
  });

  it('the boot line names the pool, the parts and how to measure, and says it is queueing, not a configuration change', () => {
    const line = describeWorkerPoolDemand(PRODUCTION);
    expect(line).toContain('PG_POOL_MAX_CONNECTIONS=12, worst case 39 concurrent database users');
    expect(line).toContain('rab-email 5, rab-push 10, rab-shift-statements 2, rab-ai 4, crewflow-audit-events 2');
    expect(line).toContain('periodic cycles 4 × 4 workspaces = 16');
    expect(line).toMatch(/queues for connections \(XP-08\)/);
    expect(line).toMatch(/db pool primary: … waiting=/);
    expect(line).toMatch(/PG_EXPECTED_WORKER_POOL_MAX/);
  });

  it('a consumer that was not started (timer triggers off, no audit sink) is not counted', () => {
    const fewer = { ...PRODUCTION, consumers: PRODUCTION.consumers.filter((c) => c.name !== 'crewflow-audit-events') };
    expect(workerPoolDemand(fewer).consumerDemand).toBe(21);
  });

  it('within the pool: one plain line, no warning text', () => {
    const small = { consumers: [{ name: 'rab-email', concurrency: 2 }], scanSlots: 1, perScanParallel: 2, poolMax: 12 };
    expect(workerPoolDemand(small).exceedsPool).toBe(false);
    expect(describeWorkerPoolDemand(small)).toMatch(/worst case 4 concurrent database users .* — within the pool\.$/);
    expect(describeWorkerPoolDemand({ ...small, consumers: [] })).toContain('consumers 0: none');
  });

  it.each([
    [{ ...PRODUCTION, poolMax: 1.5 }, /pool max must be a non-negative integer/],
    [{ ...PRODUCTION, scanSlots: -1 }, /scan slots/],
    [{ ...PRODUCTION, perScanParallel: NaN }, /per-scan parallelism/],
    [{ ...PRODUCTION, consumers: [{ name: 'rab-email', concurrency: Infinity }] }, /rab-email concurrency/],
  ])('refuses a malformed input instead of printing a wrong number (%#)', (input, message) => {
    expect(() => workerPoolDemand(input)).toThrow(message);
  });
});
