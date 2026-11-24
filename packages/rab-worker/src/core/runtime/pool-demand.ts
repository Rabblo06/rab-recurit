/**
 * XP-08 / XD-06 (Phase X audit, SUSPECTED, not measured): the Worker's runtime pool (PG_POOL_MAX_CONNECTIONS, 12 in every
 * committed compose file) against the most database work this process can start at once:
 *   - every enabled BullMQ consumer at its registry concurrency (email 5, push 10, statements 2, AI 4, timer triggers 2,
 *     audit events 2 — each job holds at most one pooled connection at a time; the audit found no nested acquisition);
 *   - the periodic cycles: at most `scanSlots` at once (WORKER_SCAN_CONCURRENCY), each walking up to `perScanParallel`
 *     workspaces in parallel (workspace-discovery.ts), one scope transaction each.
 *
 * Above the pool this is queueing, not deadlock: a job waits up to PG_CONNECT_TIMEOUT_MS for a connection. Whether it
 * matters is a load measurement (the `db pool primary: … waiting=` line every 5 min), not a configuration change, and
 * the pool size also feeds the deployment's connection budget (PG_EXPECTED_WORKER_POOL_MAX). So this changes NOTHING at
 * runtime: it prints the arithmetic once at boot, so the operator measuring a burst knows the ceiling to compare with.
 */
export interface WorkerPoolDemandInput {
  /** The consumers this process actually started, with their registry concurrency. */
  consumers: ReadonlyArray<{ name: string; concurrency: number }>;
  scanSlots: number;
  perScanParallel: number;
  poolMax: number;
}

export interface WorkerPoolDemand {
  consumerDemand: number;
  scanDemand: number;
  worstCase: number;
  poolMax: number;
  exceedsPool: boolean;
}

function nonNegativeInt(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`worker pool demand: ${what} must be a non-negative integer (got ${value})`);
  return value;
}

export function workerPoolDemand(input: WorkerPoolDemandInput): WorkerPoolDemand {
  const consumerDemand = input.consumers.reduce((sum, c) => sum + nonNegativeInt(c.concurrency, `${c.name} concurrency`), 0);
  const scanDemand = nonNegativeInt(input.scanSlots, 'scan slots') * nonNegativeInt(input.perScanParallel, 'per-scan parallelism');
  const poolMax = nonNegativeInt(input.poolMax, 'pool max');
  const worstCase = consumerDemand + scanDemand;
  return { consumerDemand, scanDemand, worstCase, poolMax, exceedsPool: worstCase > poolMax };
}

/** One boot line: the pool, the worst case and its parts. Names and numbers only. */
export function describeWorkerPoolDemand(input: WorkerPoolDemandInput, demand: WorkerPoolDemand = workerPoolDemand(input)): string {
  const consumers = input.consumers.map((c) => `${c.name} ${c.concurrency}`).join(', ') || 'none';
  const head =
    `db pool demand: PG_POOL_MAX_CONNECTIONS=${demand.poolMax}, worst case ${demand.worstCase} concurrent database users ` +
    `(consumers ${demand.consumerDemand}: ${consumers}; periodic cycles ${input.scanSlots} × ${input.perScanParallel} workspaces = ${demand.scanDemand})`;
  return demand.exceedsPool
    ? `${head} — above the pool: a burst queues for connections (XP-08). Measure with the "db pool primary: … waiting=" line before resizing; a larger pool must also fit PG_EXPECTED_WORKER_POOL_MAX.`
    : `${head} — within the pool.`;
}
