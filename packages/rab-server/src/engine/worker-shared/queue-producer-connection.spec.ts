import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { Queue, RedisConnection } from 'bullmq';
import Redis from 'ioredis';
import * as ts from 'typescript';

import { AiTurnQueueService } from '../../modules/ai/services/ai-turn-queue.service';
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
  await raceShutdown(connection, () => queue.close());
}

/** close (removes every listener from BullMQ's wrapper; its readiness wait stays pending) → a retry in flight → disconnect. */
async function raceShutdown(connection: Redis, close: () => Promise<unknown>): Promise<void> {
  await new Promise<void>((resolve) => connection.once('reconnecting', () => resolve())); // the first attempt failed
  await close();
  await new Promise<void>((resolve) => connection.once('connecting', () => resolve())); // a retry is in flight
  const ended = new Promise<void>((resolve) => connection.once('end', () => resolve()));
  connection.disconnect(); // in 'connecting' this ends the client ('end'), which rejects the pending wait
  await ended;
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); // let the rejection and its re-emit run
}

/**
 * Source scan: every BullMQ `new Queue(...)` and every `super(...)` of a class that `extends Queue` must pass
 * ProducerRedisConnection as its third argument. No allow-list: every Queue in production code (the producers, the admin
 * panel's lazy inspection queues, the Worker's scheduler queues) can be closed while its client is mid-connect.
 * `Queue` is matched only when imported from 'bullmq' (aliases included).
 */
function unwrappedQueueSites(fileName: string, text: string): number[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const queueNames = new Set<string>();
  const lines: number[] = [];
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const wrapped = (args: ts.NodeArray<ts.Expression> | undefined) => {
    const third = args?.[2];
    return !!third && ts.isIdentifier(third) && third.text === 'ProducerRedisConnection';
  };
  const visit = (node: ts.Node, inQueueSubclass: boolean): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'bullmq') {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) if ((el.propertyName ?? el.name).text === 'Queue') queueNames.add(el.name.text);
      }
    }
    let subclass = inQueueSubclass;
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      subclass = !!node.heritageClauses?.some(
        (h) => h.token === ts.SyntaxKind.ExtendsKeyword && h.types.some((t) => ts.isIdentifier(t.expression) && queueNames.has(t.expression.text)),
      );
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && queueNames.has(node.expression.text) && !wrapped(node.arguments)) lines.push(lineOf(node));
    if (subclass && ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword && !wrapped(node.arguments)) lines.push(lineOf(node));
    ts.forEachChild(node, (child) => visit(child, subclass));
  };
  visit(source, false);
  return lines;
}

/** Every production .ts file of rab-server/src (engine AND modules) and rab-worker/src; specs and __tests__ excluded. */
function productionSources(packagesRoot: string): string[] {
  const roots = [join(packagesRoot, 'rab-server/src'), join(packagesRoot, 'rab-worker/src')];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '__tests__') walk(full);
      } else if (/\.ts$/.test(entry.name) && !/\.(spec|test)\.ts$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(full);
    }
  };
  roots.forEach(walk);
  return files;
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

  it('AiTurnQueueService (modules/ai): the same race against the real service leaks nothing', async () => {
    for (let i = 0; i < 3; i++) {
      const service = new AiTurnQueueService({ get: (key: string) => (key === 'REDIS_URL' ? UNREACHABLE : undefined) } as never);
      const internals = service as unknown as { connection: Redis; queue: Queue };
      expect((internals.queue as unknown as { connection: unknown }).connection).toBeInstanceOf(ProducerRedisConnection);
      await raceShutdown(internals.connection, () => internals.queue.close());
    }
  });

  it('scan self-test: an unwrapped Queue (a `new Queue` or a Queue subclass super call) under modules/ is reported; wrapped ones are not', () => {
    const fixture = [
      "import { Queue as BullQueue } from 'bullmq';",
      "import { ProducerRedisConnection } from '../../engine/worker-shared/queue-producer-connection';",
      "const a = new BullQueue('a', { connection });",
      "const b = new BullQueue('b', { connection }, ProducerRedisConnection);",
      'class C extends BullQueue {',
      "  constructor() { super('c', { connection }); }",
      '}',
      'class D extends BullQueue {',
      "  constructor() { super('d', { connection }, ProducerRedisConnection); }",
      '}',
    ].join('\n');
    expect(unwrappedQueueSites('packages/rab-server/src/modules/fixture/fixture-queue.ts', fixture)).toEqual([3, 6]);
    // A `Queue` that is not BullMQ's is not a Queue site.
    expect(unwrappedQueueSites('x.ts', "import { Queue } from './mine';\nnew Queue('x', {});")).toEqual([]);
  });

  it('every BullMQ Queue in production code (rab-server/src incl. modules, rab-worker/src) uses ProducerRedisConnection', () => {
    const packagesRoot = join(__dirname, '../../../..');
    const files = productionSources(packagesRoot);
    // The scan really covers modules/ (where AiTurnQueueService lives), not only the engine.
    expect(files.some((f) => relative(packagesRoot, f).split('\\').join('/') === 'rab-server/src/modules/ai/services/ai-turn-queue.service.ts')).toBe(true);
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('bullmq')) continue;
      for (const line of unwrappedQueueSites(file, text)) offenders.push(`${relative(packagesRoot, file)}:${line}`);
    }
    expect(offenders).toEqual([]);
  });
});
