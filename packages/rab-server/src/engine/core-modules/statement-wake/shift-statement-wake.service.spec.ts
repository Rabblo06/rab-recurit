import { bullmqJobOptionsOf, SCAN_QUEUES } from '../../worker-shared/queue-registry';
import { STATEMENT_WAKE_JOB_NAME, STATEMENT_WAKE_QUEUE, ShiftStatementWakeService } from './shift-statement-wake.service';

/**
 * Phase X J1b producer contract (no database; Redis only where stated, and then an UNREACHABLE one):
 *  - interval scheduler (development / test default): no Redis connection, no Queue, no subscriber, no job;
 *  - bullmq: ONE wake per transaction, added only AFTER the outermost commit, never on rollback, to the reports scan queue
 *    under the scan prefix, as the scheduler's own `shift-statement-dispatch` job: metadata-only payload, the registry's
 *    scan options and NO jobId (a fixed id would be swallowed by the 1 h completed-job retention);
 *  - Redis down: the wake fails fast and is swallowed (the statement sweep delivers).
 */
const UNREACHABLE = 'redis://127.0.0.1:1';

type Sub = { afterTransactionCommit: (e: { queryRunner: unknown }) => unknown; afterTransactionRollback: (e: { queryRunner: unknown }) => unknown };

function make(values: Record<string, string | undefined>) {
  const env = { get: (key: string) => (key === 'REDIS_URL' ? UNREACHABLE : values[key]) };
  const service = new ShiftStatementWakeService(env as never);
  const internals = service as unknown as { queue: { add: jest.Mock; name: string; opts: { prefix?: string } } | null; connection: unknown };
  const add = jest.fn(async (..._args: unknown[]) => undefined);
  const realAdd = internals.queue?.add;
  if (internals.queue) internals.queue.add = add;
  const real = internals.connection;
  if (real) internals.connection = { status: 'ready' };
  const destroy = async () => {
    internals.connection = real;
    if (internals.queue && realAdd) internals.queue.add = realAdd as jest.Mock;
    await settle(service);
    await service.onModuleDestroy();
  };
  const subscribers: Sub[] = [];
  const runner = { isReleased: false, isTransactionActive: true };
  const manager = { queryRunner: runner, connection: { subscribers } } as never;
  const commit = (outermost = true) => {
    runner.isTransactionActive = !outermost;
    subscribers.forEach((s) => s.afterTransactionCommit({ queryRunner: runner }));
  };
  const rollback = () => {
    runner.isTransactionActive = false;
    subscribers.forEach((s) => s.afterTransactionRollback({ queryRunner: runner }));
  };
  return { service, internals, add, subscribers, manager, runner, commit, rollback, destroy };
}
const flush = () => new Promise((r) => setImmediate(r));
const settle = (service: ShiftStatementWakeService) => {
  const queue = (service as unknown as { queue: { waitUntilReady(): Promise<unknown> } | null }).queue;
  return queue ? Promise.race([queue.waitUntilReady().catch(() => undefined), new Promise((r) => setTimeout(r, 1_000))]) : undefined;
};
const BULLMQ = { WORKER_SCHEDULER: 'bullmq', NODE_ENV: 'production' };

describe('ShiftStatementWakeService (Phase X J1b)', () => {
  it('interval scheduler: no Redis connection, no Queue, no subscriber, nothing published', async () => {
    for (const values of [{}, { WORKER_SCHEDULER: 'interval' }, { WORKER_SCHEDULER: 'interval', NODE_ENV: 'production' }]) {
      const h = make(values);
      expect(h.service.enabled).toBe(false);
      expect(h.internals.connection).toBeNull();
      expect(h.internals.queue).toBeNull();
      expect(h.service.afterCommit(h.manager)).toBe(false);
      h.commit();
      await flush();
      expect(h.subscribers).toHaveLength(0);
      await h.destroy();
    }
  });

  it('bullmq: the queue is the reports scan queue under the resolved scan prefix (where the Worker consumes the dispatcher)', async () => {
    const h = make(BULLMQ);
    expect(STATEMENT_WAKE_QUEUE).toBe(SCAN_QUEUES.reports);
    expect(h.internals.queue!.name).toBe('crewflow-scan-reports');
    expect(h.internals.queue!.opts.prefix).toBe('crewflow:production:bull');
    await h.destroy();
    const custom = make({ ...BULLMQ, BULLMQ_PREFIX: 'crewflow:prod-eu:bull' });
    expect(custom.internals.queue!.opts.prefix).toBe('crewflow:prod-eu:bull');
    await custom.destroy();
  });

  it('nothing is added while the transaction is open or at a savepoint release; the outermost commit adds ONE wake', async () => {
    const h = make(BULLMQ);
    expect(h.service.afterCommit(h.manager)).toBe(true);
    await flush();
    expect(h.add).not.toHaveBeenCalled();
    h.commit(false);
    await flush();
    expect(h.add).not.toHaveBeenCalled();
    h.commit(true);
    await flush();
    expect(h.add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = h.add.mock.calls[0] as unknown as [string, object, Record<string, unknown>];
    expect(name).toBe(STATEMENT_WAKE_JOB_NAME);
    expect(name).toBe('shift-statement-dispatch');
    // The scheduler's own metadata-only payload: no organisation, record or user id reaches Redis.
    expect(data).toEqual({ v: 1 });
    expect(opts).toEqual(bullmqJobOptionsOf(SCAN_QUEUES.reports));
    await h.destroy();
  });

  it('NO jobId on any wake: two commits give two independent adds (a fixed id would be swallowed for 1 h)', async () => {
    const h = make(BULLMQ);
    h.service.afterCommit(h.manager);
    h.commit();
    await flush();
    h.runner.isTransactionActive = true;
    h.service.afterCommit(h.manager);
    h.commit();
    await flush();
    expect(h.add).toHaveBeenCalledTimes(2);
    for (const call of h.add.mock.calls) expect((call[2] as Record<string, unknown>).jobId).toBeUndefined();
    await h.destroy();
  });

  it('one wake per transaction, however many records it approved', async () => {
    const h = make(BULLMQ);
    expect(h.service.afterCommit(h.manager)).toBe(true);
    expect(h.service.afterCommit(h.manager)).toBe(false);
    h.commit();
    await flush();
    expect(h.add).toHaveBeenCalledTimes(1);
    await h.destroy();
  });

  it('rollback (whole transaction or a savepoint inside it): nothing is ever added', async () => {
    const h = make(BULLMQ);
    expect(h.service.afterCommit(h.manager)).toBe(true);
    h.rollback();
    h.commit();
    await flush();
    expect(h.add).not.toHaveBeenCalled();
    await h.destroy();
  });

  it('outside an open transaction nothing is registered', async () => {
    const h = make(BULLMQ);
    expect(h.service.afterCommit({ queryRunner: undefined, connection: { subscribers: [] } } as never)).toBe(false);
    h.runner.isTransactionActive = false;
    expect(h.service.afterCommit(h.manager)).toBe(false);
    await h.destroy();
  });

  it('a failing add is logged by error name and swallowed: the caller is never affected', async () => {
    const h = make(BULLMQ);
    const warn = jest.spyOn((h.service as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn').mockImplementation(() => undefined);
    h.add.mockRejectedValueOnce(Object.assign(new Error('boom organisation 11111111-1111-4111-8111-111111111111'), { name: 'ReplyError' }));
    h.service.afterCommit(h.manager);
    expect(() => h.commit()).not.toThrow();
    await flush();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/statement dispatcher wake not published \(QueuePublishUnavailableError\); the statement sweep delivers it/);
    expect(warn.mock.calls[0]![0]).not.toMatch(/1111/);
    expect(h.service.inFlightCount).toBe(0);
    await h.destroy();
  });

  it('Redis really down (unreachable host): the wake fails fast and is swallowed, nothing pends in memory', async () => {
    const env = { get: (key: string) => (key === 'REDIS_URL' ? UNREACHABLE : (BULLMQ as Record<string, string>)[key]) };
    const service = new ShiftStatementWakeService(env as never);
    const warn = jest.spyOn((service as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn').mockImplementation(() => undefined);
    const subscribers: Sub[] = [];
    const runner = { isReleased: false, isTransactionActive: true };
    expect(service.afterCommit({ queryRunner: runner, connection: { subscribers } } as never)).toBe(true);
    runner.isTransactionActive = false;
    const started = Date.now();
    subscribers.forEach((s) => s.afterTransactionCommit({ queryRunner: runner }));
    while (service.inFlightCount > 0 && Date.now() - started < 5_000) await new Promise((r) => setTimeout(r, 20));
    expect(service.inFlightCount).toBe(0);
    expect(Date.now() - started).toBeLessThan(4_500); // bounded by boundedPublish (3 s), never hangs
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/statement dispatcher wake not published/));
    await settle(service);
    await service.onModuleDestroy();
  });
});
