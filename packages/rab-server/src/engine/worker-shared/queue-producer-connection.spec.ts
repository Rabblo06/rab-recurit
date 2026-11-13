import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { Queue, RedisConnection } from 'bullmq';
import Redis from 'ioredis';

import { closeQueueProducer, createQueueProducerConnection, ProducerRedisConnection } from './queue-producer-connection';

/**
 * CI crash 2026-11-13 (timer-trigger-queue.service.spec.ts "Redis down"; then a sibling test failing with a bare
 * `connect ECONNREFUSED 127.0.0.1:1`): a producer Queue closed while its client was still making a connect attempt to a
 * dead Redis left BullMQ's readiness wait pending; disconnecting the client then rejected it and the BullMQ wrapper
 * emitted 'error' with no listener left — an uncaught exception that kills the process (or fails whichever test runs then).
 *
 * The race is forced here, deterministically: close the queue, wait until the client is INSIDE a connect attempt, then
 * disconnect (closeQueueProducer's own order). The control proves the test reaches the failure with BullMQ's plain wrapper;
 * the producer wrapper must never let it escape. Redis is unreachable (127.0.0.1:1): no server is needed.
 */
const UNREACHABLE = 'redis://127.0.0.1:1';
jest.setTimeout(30_000);

type Wrapper = typeof RedisConnection;

/**
 * BullMQ's plain wrapper, instrumented for the control only: records an 'error' emitted when nobody listens (which the plain
 * wrapper would throw as an uncaught exception — under Jest that fails whichever test is running, exactly the CI symptom)
 * and drops it so the control itself can report it.
 */
const unheard: unknown[] = [];
class RecordingPlainConnection extends RedisConnection {
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'error' && this.listenerCount('error') === 0) {
      unheard.push(args[0]);
      return false;
    }
    return super.emit(event, ...args);
  }
}

/**
 * The forced race. With ProducerRedisConnection an escaped error would be an uncaught exception, which Jest reports as a
 * failure of the running test — so a passing test is the proof that nothing escaped.
 */
async function forcedShutdownRace(Connection: Wrapper): Promise<void> {
  const connection = createQueueProducerConnection(UNREACHABLE);
  const queue = new Queue('producer-connection-race', { connection }, Connection);
  queue.on('error', () => undefined); // what every producer service does
  await new Promise<void>((resolve) => connection.once('reconnecting', () => resolve())); // the first attempt failed
  await queue.close(); // removes every listener from BullMQ's wrapper; its readiness wait is still pending
  await new Promise<void>((resolve) => connection.once('connecting', () => resolve())); // a retry is in flight
  const ended = new Promise<void>((resolve) => connection.once('end', () => resolve()));
  connection.disconnect(); // in 'connecting' this ends the client ('end'), which rejects the pending wait
  await ended;
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); // let the rejection and its re-emit run
}

describe('ProducerRedisConnection (producer queues never leak an unhandled Redis error)', () => {

  it('control: with BullMQ\'s wrapper the forced shutdown race emits the ECONNREFUSED with no listener (the CI crash)', async () => {
    unheard.length = 0;
    await forcedShutdownRace(RecordingPlainConnection);
    expect(unheard).toHaveLength(1);
    expect((unheard[0] as NodeJS.ErrnoException).code).toBe('ECONNREFUSED');
  });

  it('with ProducerRedisConnection the same race leaks nothing (repeated; an escape would fail this test)', async () => {
    for (let i = 0; i < 5; i++) await forcedShutdownRace(ProducerRedisConnection);
  });

  it('while the queue is open, errors still reach the queue\'s own listener (nothing is silenced early)', async () => {
    const connection = new Redis(UNREACHABLE, { lazyConnect: true, enableOfflineQueue: false });
    connection.on('error', () => undefined);
    const queue = new Queue('producer-connection-forward', { connection }, ProducerRedisConnection);
    const seen: Error[] = [];
    queue.on('error', (error) => seen.push(error));
    const wrapper = (queue as unknown as { connection: RedisConnection }).connection;
    wrapper.emit('error', new Error('forwarded'));
    expect(seen.map((e) => e.message)).toContain('forwarded');
    await closeQueueProducer(queue, connection);
    expect(() => wrapper.emit('error', new Error('after close'))).not.toThrow();
  });

  it('every producer Queue built on createQueueProducerConnection uses ProducerRedisConnection (server and worker sources)', () => {
    const packagesRoot = join(__dirname, '../../../..');
    // Producer queues live in the engine (server) and the Worker; scanning only those keeps this test cheap.
    const roots = [join(packagesRoot, 'rab-server/src/engine'), join(packagesRoot, 'rab-worker/src')];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== '__tests__') walk(full);
        } else if (/\.ts$/.test(entry.name) && !/\.(spec|test)\.ts$/.test(entry.name)) files.push(full);
      }
    };
    roots.forEach(walk);
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const producerFile = /createQueueProducerConnection|producerConnection/.test(text) && /\b(new Queue\b|extends Queue\b)/.test(text);
      if (!producerFile || file.endsWith('queue-producer-connection.ts')) continue;
      const queueCreations = text.match(/new Queue(<[^>]*>)?\([^;]*?\);|super\(name, \{[^;]*?\);/gs) ?? [];
      if (queueCreations.length === 0 || queueCreations.some((call) => !call.includes('ProducerRedisConnection'))) offenders.push(relative(packagesRoot, file));
    }
    expect(offenders).toEqual([]);
  });
});
