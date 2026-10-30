import { DatabaseMetrics, isPoolAcquisitionTimeout, isQueryTimeout, PgPoolLike } from './database-metrics';

function fakePool(behaviour: 'ok' | 'timeout') {
  const pool: PgPoolLike & { connectCalls: number } = {
    totalCount: 3,
    idleCount: 1,
    waitingCount: 2,
    options: { max: 10 },
    connectCalls: 0,
    connect(...args: unknown[]) {
      pool.connectCalls += 1;
      const error = behaviour === 'timeout' ? new Error('timeout exceeded when trying to connect') : null;
      const cb = args[0] as ((e: Error | null, c?: unknown, r?: unknown) => void) | undefined;
      if (cb) {
        setImmediate(() => cb(error, error ? undefined : { client: true }, () => undefined));
        return undefined;
      }
      return error ? Promise.reject(error) : Promise.resolve({ client: true });
    },
  };
  return pool;
}

describe('database metrics (B5)', () => {
  it('times acquisitions through both connect forms and passes results through untouched', async () => {
    const metrics = new DatabaseMetrics();
    const pool = fakePool('ok');
    metrics.instrumentPool('primary', pool);
    metrics.instrumentPool('primary', pool); // idempotent
    const viaCallback = await new Promise((resolve) => pool.connect((_e: unknown, client: unknown) => resolve(client)));
    const viaPromise = await (pool.connect() as Promise<unknown>);
    expect(viaCallback).toEqual({ client: true });
    expect(viaPromise).toEqual({ client: true });
    const snap = metrics.snapshot().pools[0];
    expect(snap).toMatchObject({ name: 'primary', total: 3, idle: 1, waiting: 2, max: 10, acquisitions: 2, acquisitionFailures: 0 });
    expect(pool.connectCalls).toBe(2);
  });

  it('counts acquisition failures and pool-wait timeouts, and rethrows them', async () => {
    const metrics = new DatabaseMetrics();
    const pool = fakePool('timeout');
    metrics.instrumentPool('worker-direct', pool);
    await expect(pool.connect() as Promise<unknown>).rejects.toThrow(/timeout exceeded/);
    const err = await new Promise((resolve) => pool.connect((e: unknown) => resolve(e)));
    expect(isPoolAcquisitionTimeout(err)).toBe(true);
    expect(metrics.snapshot().pools[0]).toMatchObject({ acquisitionFailures: 2, acquisitionTimeouts: 2 });
  });

  it('classifies query timeouts (57014, client query_timeout) and idle-in-transaction terminations only by class', () => {
    const metrics = new DatabaseMetrics();
    metrics.recordQueryError('primary', Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
    metrics.recordQueryError('primary', new Error('Query read timeout'));
    metrics.recordQueryError('primary', Object.assign(new Error('terminating connection due to idle-in-transaction timeout'), { code: '25P03' }));
    metrics.recordQueryError('primary', Object.assign(new Error('duplicate key'), { code: '23505' }));
    expect(isQueryTimeout(Object.assign(new Error('x'), { code: '57014' }))).toBe(true);
    expect(metrics.snapshot().pools[0]).toMatchObject({ queryTimeouts: 2, idleInTransactionTimeouts: 1 });
  });

  it('replica counters and the log lines carry numbers and fixed names only — no URL, credential, SQL or tenant data', () => {
    const metrics = new DatabaseMetrics();
    metrics.instrumentPool('replica', fakePool('ok'));
    metrics.setReplicaState('validated', true);
    metrics.setReplicaLag(0, 0);
    metrics.recordReplicaRead();
    metrics.recordReplicaFallback('stale');
    metrics.recordReplicaFallback('replica-error');
    metrics.recordReplicaConnectionFailure();
    metrics.recordReplicaConfigurationFailure();
    // A secret-bearing error is reduced to its class before it reaches the registry.
    metrics.recordQueryError('replica', Object.assign(new Error('password authentication failed for user "crewflow_app" postgres://crewflow_app:s3cret@db:5432/x org 1111'), { code: '28P01' }));
    const snap = metrics.snapshot();
    expect(snap.replica).toMatchObject({ configured: true, state: 'validated', available: 1, reads: 1, connectionFailures: 1, configurationFailures: 1 });
    expect(snap.replica.fallbacks).toEqual({ 'not-validated': 0, unavailable: 0, stale: 1, refused: 0, 'replica-error': 1 });
    const text = JSON.stringify(snap) + metrics.summaryLines().join('\n');
    expect(text).not.toMatch(/postgres(ql)?:\/\/|s3cret|password|crewflow_app|@db|1111|SELECT/i);
  });
});
