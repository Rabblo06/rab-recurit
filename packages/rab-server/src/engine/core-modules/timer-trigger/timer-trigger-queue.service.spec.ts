import { bullmqJobOptionsOf } from '../../worker-shared/queue-registry';
import { TIMER_TRIGGER_QUEUE_NAME } from '../../worker-shared/timer-trigger.contract';
import { TIMER_TRIGGER_MAX_PER_TRANSACTION, TimerTriggerArm, TimerTriggerQueueService } from './timer-trigger-queue.service';

/**
 * Phase D-Q4b producer contract (no database; Redis only where stated, and then an UNREACHABLE one):
 *  - off (default) = today exactly: no Redis connection, no Queue, no subscriber, no job;
 *  - shadow/on: a trigger is added only AFTER the outermost commit, never on rollback, with the registry's options, an
 *    ids-only payload, the deterministic jobId and delay = dueAt − now;
 *  - a kind not in WORKER_TIMER_TRIGGER_KINDS is off; an invalid id is refused without throwing into the transaction;
 *  - Redis down: the publish fails fast and is swallowed (the backstop scan handles the subject).
 */
const UNREACHABLE = 'redis://127.0.0.1:1';
const ORG = '11111111-1111-4111-8111-111111111111';
const WS = '33333333-3333-4333-8333-333333333333';
const OFFER = '44444444-4444-4444-8444-444444444444';

type Sub = { afterTransactionCommit: (e: { queryRunner: unknown }) => unknown; afterTransactionRollback: (e: { queryRunner: unknown }) => unknown };

function make(values: Record<string, string | undefined>) {
  const env = { get: (key: string) => (key === 'REDIS_URL' ? UNREACHABLE : values[key]) };
  const service = new TimerTriggerQueueService(env as never);
  const internals = service as unknown as { queue: { add: jest.Mock } | null; connection: unknown };
  const add = jest.fn(async () => undefined);
  if (internals.queue) internals.queue.add = add;
  // boundedPublish checks the connection status first; stub it as ready so the add mock decides the outcome.
  if (internals.connection) (internals.connection as { status: string }).status = 'ready';
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
  return { service, internals, add, subscribers, manager, runner, commit, rollback };
}
const flush = () => new Promise((r) => setImmediate(r));
const arm = (over: Partial<TimerTriggerArm> = {}): TimerTriggerArm => ({
  kind: 'offer-expiry',
  organisationId: ORG,
  workspaceId: WS,
  subjectId: OFFER,
  dueAt: new Date(Date.now() + 60 * 60_000),
  ...over,
});

describe('TimerTriggerQueueService (D-Q4b producer)', () => {
  afterEach(() => jest.useRealTimers());

  it('off (default): no Redis connection, no Queue, no subscriber, nothing armed — today exactly', async () => {
    for (const values of [{}, { WORKER_TIMER_TRIGGERS: 'off' }, { WORKER_TIMER_TRIGGERS: 'off', WORKER_TIMER_TRIGGER_KINDS: 'offer-expiry' }]) {
      const h = make(values);
      expect(h.internals.connection).toBeNull();
      expect(h.internals.queue).toBeNull();
      expect(h.service.afterCommit(h.manager, arm())).toBe(false);
      expect(await h.service.publishNow(arm({ kind: 'no-show' }))).toBe(false);
      h.commit();
      await flush();
      expect(h.subscribers).toHaveLength(0);
      await h.service.onModuleDestroy();
    }
  });

  it.each(['shadow', 'on'])('%s: nothing is added while the transaction is open; the outermost commit adds the registered job', async (mode) => {
    const h = make({ WORKER_TIMER_TRIGGERS: mode });
    const dueAt = new Date(Date.now() + 48 * 3600_000);
    expect(h.service.afterCommit(h.manager, arm({ dueAt }))).toBe(true);
    await flush();
    expect(h.add).not.toHaveBeenCalled();
    h.commit(false); // a savepoint release is not a commit
    await flush();
    expect(h.add).not.toHaveBeenCalled();
    h.commit(true);
    await flush();
    expect(h.add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = h.add.mock.calls[0] as unknown as [string, object, { jobId: string; delay: number }];
    expect(name).toBe('offer-expiry-trigger');
    expect(data).toEqual({ organisationId: ORG, workspaceId: WS, subjectId: OFFER, dueAtEpochMs: dueAt.getTime() }); // ids only
    expect(opts).toMatchObject({ jobId: `offer-expiry.${OFFER}.${dueAt.getTime()}`, ...bullmqJobOptionsOf(TIMER_TRIGGER_QUEUE_NAME) });
    expect(opts.delay).toBeGreaterThan(48 * 3600_000 - 5_000);
    expect(opts.delay).toBeLessThanOrEqual(48 * 3600_000);
    await h.service.onModuleDestroy();
  });

  it('rollback (of the whole transaction or a savepoint inside it): nothing is ever added', async () => {
    const h = make({ WORKER_TIMER_TRIGGERS: 'on' });
    expect(h.service.afterCommit(h.manager, arm())).toBe(true);
    h.rollback();
    h.commit();
    await flush();
    expect(h.add).not.toHaveBeenCalled();
    await h.service.onModuleDestroy();
  });

  it('outside an open transaction nothing is registered (the backstop scan handles it)', async () => {
    const h = make({ WORKER_TIMER_TRIGGERS: 'on' });
    expect(h.service.afterCommit({ queryRunner: undefined, connection: { subscribers: [] } } as never, arm())).toBe(false);
    h.runner.isTransactionActive = false;
    expect(h.service.afterCommit(h.manager, arm())).toBe(false);
    await h.service.onModuleDestroy();
  });

  it('a past due time is added with no delay (fires at once; the consumer decides on the database clock)', async () => {
    const h = make({ WORKER_TIMER_TRIGGERS: 'on' });
    expect(await h.service.publishNow(arm({ kind: 'no-show', dueAt: new Date(Date.now() - 60_000) }))).toBe(true);
    const opts = h.add.mock.calls[0]![2] as { delay?: number };
    expect(opts.delay).toBeUndefined();
    await h.service.onModuleDestroy();
  });

  it('OD-3: a kind not in WORKER_TIMER_TRIGGER_KINDS is off for that kind', async () => {
    const h = make({ WORKER_TIMER_TRIGGERS: 'on', WORKER_TIMER_TRIGGER_KINDS: 'offer-expiry' });
    expect(h.service.enabled('offer-expiry')).toBe(true);
    expect(h.service.enabled('manager-confirmation')).toBe(false);
    expect(h.service.afterCommit(h.manager, arm({ kind: 'manager-confirmation' }))).toBe(false);
    expect(await h.service.publishNow(arm({ kind: 'no-show' }))).toBe(false);
    h.commit();
    await flush();
    expect(h.add).not.toHaveBeenCalled();
    await h.service.onModuleDestroy();
  });

  it('an invalid id is refused before Redis and NEVER throws into the business transaction', async () => {
    const h = make({ WORKER_TIMER_TRIGGERS: 'on' });
    expect(() => h.service.afterCommit(h.manager, arm({ organisationId: 'not-a-uuid' }))).not.toThrow();
    expect(h.service.afterCommit(h.manager, arm({ organisationId: 'not-a-uuid' }))).toBe(false);
    expect(h.service.afterCommit(h.manager, arm({ dueAt: new Date(NaN) }))).toBe(false);
    h.commit();
    await flush();
    expect(h.add).not.toHaveBeenCalled();
    await h.service.onModuleDestroy();
  });

  it(`bounded per transaction (${TIMER_TRIGGER_MAX_PER_TRANSACTION}); beyond it the backstop scan handles the subject`, async () => {
    const h = make({ WORKER_TIMER_TRIGGERS: 'on' });
    let registered = 0;
    for (let i = 0; i < TIMER_TRIGGER_MAX_PER_TRANSACTION + 5; i++) if (h.service.afterCommit(h.manager, arm({ dueAt: new Date(Date.now() + 60_000 + i) }))) registered++;
    expect(registered).toBe(TIMER_TRIGGER_MAX_PER_TRANSACTION);
    expect(h.subscribers).toHaveLength(1);
    await h.service.onModuleDestroy();
  });

  it('Redis down: publishNow resolves false quickly; an after-commit publish failure is swallowed (the commit never waits)', async () => {
    const env = { get: (key: string) => (key === 'REDIS_URL' ? UNREACHABLE : key === 'WORKER_TIMER_TRIGGERS' ? 'on' : undefined) };
    const service = new TimerTriggerQueueService(env as never);
    const started = Date.now();
    expect(await service.publishNow(arm({ kind: 'late-clock-in' }))).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
    const subscribers: Sub[] = [];
    const runner = { isReleased: false, isTransactionActive: true };
    expect(service.afterCommit({ queryRunner: runner, connection: { subscribers } } as never, arm())).toBe(true);
    runner.isTransactionActive = false;
    expect(() => subscribers.forEach((s) => s.afterTransactionCommit({ queryRunner: runner }))).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));
    await service.onModuleDestroy();
  });
});
