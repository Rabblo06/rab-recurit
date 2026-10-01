import { EntityManager } from 'typeorm';

// Historical DDL contention fixtures only. Production discovery no longer toggles RLS.
export const DISCOVERY_LOCK_TIMEOUT_MS = 250;

export async function beginRlsDiscovery(manager: EntityManager): Promise<void> {
  await manager.query(`SET LOCAL lock_timeout = '${DISCOVERY_LOCK_TIMEOUT_MS}ms'`);
}

/** SQLSTATE 55P03 (`lock_not_available`) — a discovery scan that yielded to API traffic. Expected, not a failure. */
export function isLockUnavailable(error: unknown): boolean {
  const e = error as { code?: string; driverError?: { code?: string } } | null;
  return e?.code === '55P03' || e?.driverError?.code === '55P03';
}
