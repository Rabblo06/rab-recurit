import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';

import { runWithRequestContext, type RequestContextValue } from '../../../engine/observability/request-context';
import { installSessionRoleResetOnAcquire, RESET_ROLE_SQL } from '../session-role-reset';

/**
 * Layer 1 of G-09 (checkout RESET ROLE) without a database: the reset is queued on every 'acquire', once per pool, and
 * (ST-05, T-1) counted in the request's sqlCount, which only TypeORM's logger fed before. Real PostgreSQL proof of the
 * reset itself: owner-login-guards.integration.spec.ts and tenant-context-framing.integration.spec.ts.
 */
function fakePool() {
  const pool = new EventEmitter() as unknown as Pool;
  const client = { query: jest.fn(async () => ({ rows: [] })) };
  return { pool, client, acquire: () => (pool as unknown as EventEmitter).emit('acquire', client) };
}
const ctx = (): RequestContextValue => ({ requestId: 'r', method: 'GET', routeTemplate: '/x', startedAt: 0, metrics: { sqlCount: 0, transactionCount: 0, stages: {} } });

describe('installSessionRoleResetOnAcquire', () => {
  it('queues RESET ROLE on every checkout, and installs only once per pool', () => {
    const { pool, client, acquire } = fakePool();
    installSessionRoleResetOnAcquire(pool, () => undefined);
    installSessionRoleResetOnAcquire(pool, () => undefined);
    acquire();
    acquire();
    expect(client.query.mock.calls).toEqual([[RESET_ROLE_SQL], [RESET_ROLE_SQL]]);
  });

  it('ST-05: each checkout reset counts as one statement in the request sqlCount (not as a transaction)', () => {
    const { pool, acquire } = fakePool();
    installSessionRoleResetOnAcquire(pool, () => undefined);
    const value = ctx();
    runWithRequestContext(value, () => {
      acquire();
      acquire();
    });
    expect(value.metrics.sqlCount).toBe(2);
    expect(value.metrics.transactionCount).toBe(0);
  });

  it('outside a request context (Worker, boot) the count is a no-op and the reset still runs', () => {
    const { pool, client, acquire } = fakePool();
    installSessionRoleResetOnAcquire(pool, () => undefined);
    expect(() => acquire()).not.toThrow();
    expect(client.query).toHaveBeenCalledWith(RESET_ROLE_SQL);
  });
});
