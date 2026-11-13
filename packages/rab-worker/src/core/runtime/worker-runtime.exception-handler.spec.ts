/**
 * Phase X3.2: the Worker cycle catch reports a failed cycle through ExceptionHandlerService (Sentry when on), like Twenty's
 * message-queue.explorer.ts reports a failed job. Reporting is best effort: it never changes the cycle's outcome, its
 * failure counter or the next cycle, and it never crashes the Worker.
 */
import { NotFoundException } from '@nestjs/common';
import Redis from 'ioredis';

import { WORKER_STATS_KEY } from '@rab/server/engine/worker-shared/heartbeat.constants';
import { WorkerLoopOptions, WorkerRuntime } from './worker-runtime';

/** The few ioredis calls WorkerRuntime makes (hset, multi().hset/hincrby/expire/exec), in memory. */
function fakeRedis() {
  const hashes = new Map<string, Record<string, string>>();
  const write = (key: string, field: string, value: (old: string | undefined) => string) => {
    const h = hashes.get(key) ?? {};
    h[field] = value(h[field]);
    hashes.set(key, h);
  };
  const hset = (key: string, a: Record<string, string | number> | string, b?: string | number) => {
    const obj = typeof a === 'string' ? { [a]: b! } : a;
    for (const [k, v] of Object.entries(obj)) write(key, k, () => String(v));
  };
  const redis = {
    hset: async (key: string, obj: Record<string, string | number>) => hset(key, obj),
    multi: () => {
      const ops: Array<() => void> = [];
      const chain = {
        hset: (key: string, a: Record<string, string | number> | string, b?: string | number) => (ops.push(() => hset(key, a, b)), chain),
        hincrby: (key: string, field: string, by: number) => (ops.push(() => write(key, field, (old) => String(Number(old ?? 0) + by))), chain),
        expire: () => chain,
        exec: async () => (ops.forEach((op) => op()), []),
      };
      return chain;
    },
  };
  return { redis: redis as unknown as Redis, hashes };
}

const flush = () => new Promise((r) => setImmediate(r));
const loop = (overrides: Partial<WorkerLoopOptions> = {}): WorkerLoopOptions => ({
  name: 'email dispatch',
  intervalMs: 60_000,
  statKeys: { lastRunAt: 'lastEmailDispatchAt', failures: 'emailDispatchFailures' },
  metricKey: 'email-dispatch',
  run: async () => true,
  ...overrides,
});

function quietRuntime(redis: Redis, exceptionHandler?: { captureExceptions: jest.Mock }): WorkerRuntime {
  const runtime = new WorkerRuntime(redis, { metricsLogMs: 0, ...(exceptionHandler ? { exceptionHandler } : {}) });
  jest.spyOn((runtime as unknown as { logger: { error: () => void } }).logger, 'error').mockImplementation(() => undefined);
  return runtime;
}

describe('WorkerRuntime cycle catch → ExceptionHandlerService (X3.2)', () => {
  it.each(['whole', 'fields'] as const)('a failed cycle (%s stats) calls the handler once with the error and the loop name', async () => {
    const { redis } = fakeRedis();
    const captureExceptions = jest.fn(() => ['event-1']);
    const runtime = quietRuntime(redis, { captureExceptions });
    const error = new Error('db down');
    expect(await runtime.runOnce(loop({ run: async () => Promise.reject(error) }))).toBe('failed');
    expect(captureExceptions).toHaveBeenCalledTimes(1);
    expect(captureExceptions).toHaveBeenCalledWith([error], { operation: { type: 'worker-cycle', name: 'email dispatch' } });
  });

  it('interval mode (`every`) reports a failed tick the same way', async () => {
    const { redis } = fakeRedis();
    const captureExceptions = jest.fn(() => []);
    const runtime = quietRuntime(redis, { captureExceptions });
    runtime.every(loop({ run: async () => Promise.reject(new Error('boom')) }));
    await flush();
    runtime.beginShutdown();
    await runtime.drain(1000);
    expect(captureExceptions).toHaveBeenCalledTimes(1);
  });

  it('succeeded, idle and skipped cycles are not reported', async () => {
    const { redis } = fakeRedis();
    const captureExceptions = jest.fn(() => []);
    const runtime = quietRuntime(redis, { captureExceptions });
    expect(await runtime.runOnce(loop())).toBe('succeeded');
    expect(await runtime.runOnce(loop({ run: async () => false }))).toBe('idle');
    expect(await runtime.runOnce(loop(), async () => ({ acquired: false }))).toBe('skipped-locked');
    expect(captureExceptions).not.toHaveBeenCalled();
  });

  it('a client error (HttpException < 500) thrown by a shared service is not reported (Twenty shouldCaptureException)', async () => {
    const { redis } = fakeRedis();
    const captureExceptions = jest.fn(() => []);
    const runtime = quietRuntime(redis, { captureExceptions });
    expect(await runtime.runOnce(loop({ run: async () => Promise.reject(new NotFoundException()) }))).toBe('failed');
    expect(captureExceptions).not.toHaveBeenCalled();
  });

  it('a throwing handler never changes the outcome, the failure counter or the next cycle, and never rejects', async () => {
    const { redis, hashes } = fakeRedis();
    const captureExceptions = jest.fn(() => {
      throw new Error('sentry down');
    });
    const runtime = quietRuntime(redis, { captureExceptions });
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await expect(runtime.runOnce(loop({ run: async () => Promise.reject(new Error('db down')) }))).resolves.toBe('failed');
      await flush();
      expect(captureExceptions).toHaveBeenCalledTimes(1);
      expect(hashes.get(WORKER_STATS_KEY)?.emailDispatchFailures).toBe('1');
      expect(await runtime.runOnce(loop())).toBe('succeeded');
      expect(runtime.inFlightCount).toBe(0);
      expect(runtime.progress().lastCycleSettledAt).not.toBeNull();
      await flush();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('with no handler given and no SENTRY_DSN (the default) a failed cycle is still just `failed`: a no-op report', async () => {
    const saved = process.env.SENTRY_DSN;
    delete process.env.SENTRY_DSN;
    try {
      const { redis, hashes } = fakeRedis();
      const runtime = quietRuntime(redis);
      expect(await runtime.runOnce(loop({ run: async () => Promise.reject(new Error('db down')) }))).toBe('failed');
      await flush();
      expect(hashes.get(WORKER_STATS_KEY)?.emailDispatchFailures).toBe('1');
    } finally {
      if (saved !== undefined) process.env.SENTRY_DSN = saved;
    }
  });
});
