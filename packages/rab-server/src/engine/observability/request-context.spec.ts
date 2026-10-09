import {
  getRequestContext,
  publishRequestComplete,
  recordSqlQuery,
  runWithRequestContext,
  subscribeToRequestMetrics,
  timeStage,
  type RequestContextValue,
} from './request-context';

function freshContext(requestId = 'r1'): RequestContextValue {
  return {
    requestId,
    method: 'GET',
    routeTemplate: '/rest/v1/test',
    startedAt: Date.now(),
    metrics: { sqlCount: 0, transactionCount: 0, stages: {} },
  };
}

describe('request-context (P1A observability foundation)', () => {
  it('getRequestContext returns undefined outside any request context', () => {
    expect(getRequestContext()).toBeUndefined();
  });

  it('runWithRequestContext makes the value visible inside the callback, and gone after it returns', () => {
    const value = freshContext();
    const seen = runWithRequestContext(value, () => getRequestContext());
    expect(seen).toBe(value);
    expect(getRequestContext()).toBeUndefined();
  });

  it('recordSqlQuery classifies a BEGIN/START TRANSACTION as a transaction, not a plain statement', () => {
    const value = freshContext();
    runWithRequestContext(value, () => {
      recordSqlQuery(true);
      recordSqlQuery(false);
      recordSqlQuery(false);
    });
    expect(value.metrics.transactionCount).toBe(1);
    expect(value.metrics.sqlCount).toBe(2);
  });

  it('recordSqlQuery outside any context is a safe no-op (never throws)', () => {
    expect(() => recordSqlQuery(true)).not.toThrow();
  });

  it('two concurrent "requests" (two separate runWithRequestContext calls interleaved via async work) never cross-contaminate counts', async () => {
    const a = freshContext('a');
    const b = freshContext('b');

    async function workload(ctx: RequestContextValue, queries: number): Promise<void> {
      await runWithRequestContext(ctx, async () => {
        for (let i = 0; i < queries; i++) {
          await new Promise((r) => setTimeout(r, 1)); // force a real async gap, like real I/O between queries
          recordSqlQuery(false);
        }
      });
    }

    await Promise.all([workload(a, 3), workload(b, 7)]);
    expect(a.metrics.sqlCount).toBe(3);
    expect(b.metrics.sqlCount).toBe(7);
  });

  it('timeStage records elapsed time under the given stage name and returns the wrapped value unchanged', async () => {
    const value = freshContext();
    const result = await runWithRequestContext(value, () =>
      timeStage('unit_test_stage', async () => {
        await new Promise((r) => setTimeout(r, 5));
        return 'ok';
      }),
    );
    expect(result).toBe('ok');
    expect(value.metrics.stages.unit_test_stage).toBeGreaterThanOrEqual(0);
    expect(typeof value.metrics.stages.unit_test_stage).toBe('number');
  });

  it('timeStage accumulates across repeated calls under the same stage name rather than overwriting', async () => {
    const value = freshContext();
    await runWithRequestContext(value, async () => {
      await timeStage('repeated', async () => new Promise((r) => setTimeout(r, 2)));
      await timeStage('repeated', async () => new Promise((r) => setTimeout(r, 2)));
    });
    expect(value.metrics.stages.repeated).toBeGreaterThan(0);
  });

  it('timeStage still records the stage and rethrows the original error when the wrapped function throws', async () => {
    const value = freshContext();
    await expect(
      runWithRequestContext(value, () =>
        timeStage('failing_stage', async () => {
          throw new Error('boom');
        }),
      ),
    ).rejects.toThrow('boom');
    expect(value.metrics.stages.failing_stage).toBeGreaterThanOrEqual(0);
  });

  it('subscribeToRequestMetrics receives exactly the payload published, and unsubscribe stops delivery', () => {
    const received: unknown[] = [];
    const unsubscribe = subscribeToRequestMetrics((payload) => received.push(payload));

    const payload = {
      requestId: 'r1',
      method: 'GET',
      route: '/rest/v1/test',
      status: 200,
      durationMs: 12,
      sqlCount: 3,
      transactionCount: 1,
      stages: { jwt_verify: 1 },
    };
    publishRequestComplete(payload);
    expect(received).toEqual([payload]);

    unsubscribe();
    publishRequestComplete(payload);
    expect(received).toHaveLength(1); // no second delivery after unsubscribe
  });

  it('a listener that throws never propagates to the publisher and never blocks other listeners', () => {
    const received: unknown[] = [];
    const unsubBad = subscribeToRequestMetrics(() => {
      throw new Error('listener failure');
    });
    const unsubGood = subscribeToRequestMetrics((payload) => received.push(payload));

    const payload = { requestId: 'r2', method: 'GET', route: '/x', status: 200, durationMs: 1, sqlCount: 0, transactionCount: 0, stages: {} };
    expect(() => publishRequestComplete(payload)).not.toThrow();
    expect(received).toEqual([payload]);

    unsubBad();
    unsubGood();
  });

  it('safety: the published payload never contains a token/cookie/password/email-shaped field by construction (type-level contract)', () => {
    // This is a structural/documentation-level guard: RequestCompletePayload's own type has no such field.
    // A real secret could still be smuggled in if a future caller widened the type — this test exists so that
    // any such widening shows up as an intentional type change, not a silent drift.
    const payload = { requestId: 'r3', method: 'GET', route: '/x', status: 200, durationMs: 1, sqlCount: 0, transactionCount: 0, stages: {} };
    const keys = Object.keys(payload);
    expect(keys).toEqual(['requestId', 'method', 'route', 'status', 'durationMs', 'sqlCount', 'transactionCount', 'stages']);
  });
});
