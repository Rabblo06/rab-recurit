import { EntityManager } from 'typeorm';

/**
 * The worker's cross-tenant discovery scans bracket their read in
 * `ALTER TABLE ... DISABLE / ENABLE ROW LEVEL SECURITY` (forced-RLS tables are
 * invisible to the owner connection otherwise). That DDL takes an ACCESS
 * EXCLUSIVE lock, which is a real hazard on the API's hot tables (`shift`,
 * `shift_assignment`, `attendance`): it queues BEHIND every in-flight
 * transaction and every NEW reader then queues behind IT, and two tables locked
 * in an order that differs from a request's read order can deadlock.
 *
 * Measured (attendance-clock-in.load.spec.ts): 100 simultaneous clock-ins while
 * a discovery loop ran ~1000x more often than production's 5-minute cadence ->
 * 38 of 100 clock-ins failed with HTTP 500 (38 Postgres deadlocks).
 *
 * The fix is to make the WORKER the one that always loses. Postgres only starts
 * deadlock detection after `deadlock_timeout` (1 s by default). A `lock_timeout`
 * far below that means the scan gives up (SQLSTATE 55P03) long before a
 * deadlock can be declared, so the API transaction is never chosen as the
 * victim, and the worst stall a request can see is bounded by this value. The
 * scan simply retries on its next tick (its DDL is transactional, so RLS is
 * restored by the rollback).
 *
 * Call it AFTER acquiring the job's advisory lock (waiting for another worker
 * replica there is fine and unbounded) and BEFORE the first ALTER TABLE.
 */
export const DISCOVERY_LOCK_TIMEOUT_MS = 250;

export async function beginRlsDiscovery(manager: EntityManager): Promise<void> {
  await manager.query(`SET LOCAL lock_timeout = '${DISCOVERY_LOCK_TIMEOUT_MS}ms'`);
}

/** SQLSTATE 55P03 (`lock_not_available`) — a discovery scan that yielded to API traffic. Expected, not a failure. */
export function isLockUnavailable(error: unknown): boolean {
  const e = error as { code?: string; driverError?: { code?: string } } | null;
  return e?.code === '55P03' || e?.driverError?.code === '55P03';
}
