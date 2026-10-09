import { DataSource } from 'typeorm';

/**
 * TEST-ONLY instrumentation of the integration-test runtime connection pool. Reads the underlying node-postgres Pool that TypeORM's
 * postgres driver holds as `driver.master` (see node_modules/typeorm/driver/postgres/PostgresDriver.js). Read-only: this never changes
 * pool size, database settings or timeouts, and it is never imported by application code.
 */
export interface PoolSnapshot {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  /** Connections currently checked out and in use (totalCount - idleCount). */
  checkedOut: number;
}

export function samplePool(dataSource: DataSource): PoolSnapshot | null {
  const master = (
    dataSource.driver as unknown as { master?: { totalCount: number; idleCount: number; waitingCount: number } }
  ).master;
  if (!master) return null;
  return {
    totalCount: master.totalCount,
    idleCount: master.idleCount,
    waitingCount: master.waitingCount,
    checkedOut: master.totalCount - master.idleCount,
  };
}

/**
 * Runs `fn`, sampling the pool every 100ms for the duration, and logs a POOL-TRACE line with before/after snapshots and the peak
 * waitingCount and checkedOut seen while it ran. Always logs (not only when slow), so a fast run is direct evidence against a pool-wait
 * explanation for a slow one. Never alters the pool or any timeout.
 */
export async function withPoolTrace<T>(dataSource: DataSource, label: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  const before = samplePool(dataSource);
  let peakWaiting = before?.waitingCount ?? 0;
  let peakCheckedOut = before?.checkedOut ?? 0;
  const interval = setInterval(() => {
    const s = samplePool(dataSource);
    if (s) {
      peakWaiting = Math.max(peakWaiting, s.waitingCount);
      peakCheckedOut = Math.max(peakCheckedOut, s.checkedOut);
    }
  }, 100);
  try {
    return await fn();
  } finally {
    clearInterval(interval);
    const elapsed = Date.now() - start;
    const after = samplePool(dataSource);
    // eslint-disable-next-line no-console
    console.log(
      `POOL-TRACE ${label}: ${elapsed}ms before=${JSON.stringify(before)} after=${JSON.stringify(after)} peakWaiting=${peakWaiting} peakCheckedOut=${peakCheckedOut}${elapsed > 3000 ? ' SLOW' : ''}`,
    );
  }
}
