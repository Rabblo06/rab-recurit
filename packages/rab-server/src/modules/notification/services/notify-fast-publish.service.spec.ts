import {
  NOTIFY_FAST_PUBLISH_MAX_IN_FLIGHT,
  NOTIFY_FAST_PUBLISH_MAX_PER_TRANSACTION,
  NotifyFastPublishService,
} from './notify-fast-publish.service';

/**
 * Phase D-Q3 unit contract of the after-commit fast publish (no database, no Redis): the publish is registered against
 * the transaction's QueryRunner and fired only by the OUTERMOST commit broadcast; any rollback discards it; off by
 * default; never inside a transaction; failures and slowness are swallowed and never block the commit broadcast.
 */
type Sub = {
  afterTransactionCommit: (e: { queryRunner: unknown }) => unknown;
  afterTransactionRollback: (e: { queryRunner: unknown }) => unknown;
};

function harness(...args: [unknown?]) {
  const flag = args.length > 0 ? args[0] : true;
  const subscribers: Sub[] = [];
  const connection = { subscribers };
  const runner = { isReleased: false, isTransactionActive: true };
  const manager = { queryRunner: runner, connection } as never;
  const email = { publish: jest.fn(async (): Promise<void> => undefined) };
  const push = { publish: jest.fn(async (): Promise<void> => undefined) };
  const env = {
    get: jest.fn((key: string) =>
      key === 'WORKER_FAST_PUBLISH_NOTIFY' ? flag : undefined,
    ),
  };
  const service = new NotifyFastPublishService(
    env as never,
    email as never,
    push as never,
  );
  const commit = (outermost = true) => {
    runner.isTransactionActive = !outermost;
    return subscribers.map((s) =>
      s.afterTransactionCommit({ queryRunner: runner }),
    );
  };
  const rollback = (outermost = true) => {
    runner.isTransactionActive = !outermost;
    subscribers.forEach((s) =>
      s.afterTransactionRollback({ queryRunner: runner }),
    );
  };
  return {
    service,
    manager,
    runner,
    email,
    push,
    env,
    subscribers,
    commit,
    rollback,
  };
}
const flush = () => new Promise((r) => setImmediate(r));
const ORG = '00000000-0000-4000-8000-0000000000aa';

describe('NotifyFastPublishService (after-commit only)', () => {
  it('flag off (default) ⇒ nothing registered, nothing published, no subscriber installed', async () => {
    for (const off of [false, undefined, 'true', 1]) {
      const h = harness(off);
      expect(
        h.service.afterCommitEmail(h.manager, {
          id: 'e1',
          organisationId: ORG,
        }),
      ).toBe(false);
      expect(
        h.service.afterCommitPush(h.manager, [
          { id: 'p1', organisationId: ORG },
        ]),
      ).toBe(0);
      h.commit();
      await flush();
      expect(h.email.publish).not.toHaveBeenCalled();
      expect(h.push.publish).not.toHaveBeenCalled();
      expect(h.subscribers).toHaveLength(0);
    }
  });

  it('flag on ⇒ nothing is published while the transaction is open; the outermost commit publishes the dispatcher-identical jobs', async () => {
    const h = harness();
    expect(
      h.service.afterCommitEmail(h.manager, { id: 'e1', organisationId: ORG }),
    ).toBe(true);
    expect(
      h.service.afterCommitPush(h.manager, [
        { id: 'p1', organisationId: ORG },
        { id: 'p2', organisationId: ORG },
      ]),
    ).toBe(2);
    await flush();
    expect(h.email.publish).not.toHaveBeenCalled();
    expect(h.push.publish).not.toHaveBeenCalled();
    expect(h.service.heldFor(h.runner as never)).toBe(3);
    h.commit();
    await flush();
    expect(h.email.publish).toHaveBeenCalledWith('e1', ORG);
    expect(h.push.publish.mock.calls).toEqual([
      ['p1', ORG],
      ['p2', ORG],
    ]);
    expect(h.service.heldFor(h.runner as never)).toBe(0);
  });

  it('a savepoint release (nested commit) does not publish; the outer commit does', async () => {
    const h = harness();
    h.service.afterCommitEmail(h.manager, { id: 'e1', organisationId: ORG });
    h.commit(false);
    await flush();
    expect(h.email.publish).not.toHaveBeenCalled();
    h.commit(true);
    await flush();
    expect(h.email.publish).toHaveBeenCalledTimes(1);
  });

  it('rollback ⇒ nothing is ever published (whole transaction or a savepoint inside it)', async () => {
    for (const outermost of [true, false]) {
      const h = harness();
      h.service.afterCommitEmail(h.manager, { id: 'e1', organisationId: ORG });
      h.rollback(outermost);
      h.commit(true);
      await flush();
      expect(h.email.publish).not.toHaveBeenCalled();
    }
  });

  it('outside an open transaction nothing is registered (the dispatcher publishes)', () => {
    const h = harness();
    expect(
      h.service.afterCommitEmail({ connection: { subscribers: [] } } as never, {
        id: 'e1',
        organisationId: ORG,
      }),
    ).toBe(false);
    h.runner.isTransactionActive = false;
    expect(
      h.service.afterCommitEmail(h.manager, { id: 'e1', organisationId: ORG }),
    ).toBe(false);
    h.runner.isTransactionActive = true;
    h.runner.isReleased = true;
    expect(
      h.service.afterCommitEmail(h.manager, { id: 'e1', organisationId: ORG }),
    ).toBe(false);
  });

  it('Redis down: a failing publish is swallowed and the next one still runs; a hanging publish never blocks the commit broadcast', async () => {
    const h = harness();
    h.email.publish.mockImplementationOnce(
      () => new Promise<void>(() => undefined),
    ); // never settles
    h.service.afterCommitEmail(h.manager, { id: 'e1', organisationId: ORG });
    const results = h.commit();
    expect(results.every((r) => r === undefined)).toBe(true); // synchronous: TypeORM has nothing to await
    const h2 = harness();
    h2.push.publish.mockRejectedValueOnce(new Error('Connection is closed.'));
    h2.service.afterCommitPush(h2.manager, [
      { id: 'p1', organisationId: ORG },
      { id: 'p2', organisationId: ORG },
    ]);
    h2.commit();
    await flush();
    await flush();
    expect(h2.push.publish).toHaveBeenCalledTimes(2);
  });

  it('bounded per transaction; the subscriber is installed once per DataSource', () => {
    const h = harness();
    for (let i = 0; i < NOTIFY_FAST_PUBLISH_MAX_PER_TRANSACTION; i++)
      expect(
        h.service.afterCommitEmail(h.manager, {
          id: `e${i}`,
          organisationId: ORG,
        }),
      ).toBe(true);
    expect(
      h.service.afterCommitEmail(h.manager, {
        id: 'over',
        organisationId: ORG,
      }),
    ).toBe(false);
    expect(h.subscribers).toHaveLength(1);
  });

  it('the job carries only the committed row id and its organisation (no other field can be passed)', async () => {
    const h = harness();
    h.service.afterCommitEmail(h.manager, {
      id: 'e1',
      organisationId: ORG,
      extra: 'x',
    } as never);
    h.commit();
    await flush();
    expect(h.email.publish).toHaveBeenCalledWith('e1', ORG);
    expect(h.email.publish.mock.calls[0]).toHaveLength(2);
  });

  it('process-wide in-flight bound: while publishes hang (Redis stalled), further ones are skipped (dispatcher publishes), never queued in memory', async () => {
    const h = harness();
    h.email.publish.mockImplementation(
      () => new Promise<void>(() => undefined),
    );
    // Several committed transactions on one service instance: 3 × 200 registrations.
    for (let t = 0; t < 3; t++) {
      h.runner.isTransactionActive = true;
      for (let i = 0; i < NOTIFY_FAST_PUBLISH_MAX_PER_TRANSACTION; i++)
        h.service.afterCommitEmail(h.manager, {
          id: `e${t}-${i}`,
          organisationId: ORG,
        });
      h.commit();
    }
    await flush();
    expect(h.service.inFlightCount).toBe(NOTIFY_FAST_PUBLISH_MAX_IN_FLIGHT);
    expect(h.email.publish).toHaveBeenCalledTimes(
      NOTIFY_FAST_PUBLISH_MAX_IN_FLIGHT,
    );
  });
});
