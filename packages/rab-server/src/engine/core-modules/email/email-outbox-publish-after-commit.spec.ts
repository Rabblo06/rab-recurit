import { EMAIL_FAST_PUBLISH_MAX_PER_TRANSACTION, EmailOutboxService } from './email-outbox.service';

/**
 * Unit contract of `EmailOutboxService.publishAfterCommit` (no database, no Redis). Soak review defect (a): seven account and
 * auth emails fast-published from INSIDE the transaction that wrote their outbox row, so the Worker could run the job before
 * COMMIT, find no row, and spend a BullMQ retry on "not visible yet". The publish must now wait for the OUTERMOST commit, be
 * dropped by any rollback, and keep today's immediate publish only when there is no open transaction at all.
 */
type Sub = {
  afterTransactionCommit: (e: { queryRunner: unknown }) => unknown;
  afterTransactionRollback: (e: { queryRunner: unknown }) => unknown;
};

const ORG = '00000000-0000-4000-8000-0000000000aa';
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
  const subscribers: Sub[] = [];
  const runner = { isReleased: false, isTransactionActive: true };
  const manager = { queryRunner: runner, connection: { subscribers } } as never;
  const calls: Array<{ id: string; organisationId: string; inTransaction: boolean }> = [];
  const publish = jest.fn(async (id: string, organisationId: string): Promise<void> => {
    calls.push({ id, organisationId, inTransaction: runner.isTransactionActive });
  });
  const service = new EmailOutboxService();
  const warn = jest.spyOn((service as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => undefined);
  const commit = (outermost = true) => {
    runner.isTransactionActive = !outermost;
    subscribers.forEach((s) => s.afterTransactionCommit({ queryRunner: runner }));
  };
  const rollback = (outermost = true) => {
    runner.isTransactionActive = !outermost;
    subscribers.forEach((s) => s.afterTransactionRollback({ queryRunner: runner }));
  };
  return { service, manager, runner, publish, calls, warn, commit, rollback, subscribers };
}

describe('EmailOutboxService.publishAfterCommit', () => {
  it('inside an open transaction nothing is published until the outermost commit, then exactly once with the row ids', async () => {
    const h = harness();
    h.service.publishAfterCommit(h.manager, h.publish, { id: 'row-1', organisationId: ORG });
    await flush();
    expect(h.publish).not.toHaveBeenCalled();
    h.commit();
    await flush();
    expect(h.calls).toEqual([{ id: 'row-1', organisationId: ORG, inTransaction: false }]);
    h.commit();
    await flush();
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it('a savepoint release is not a commit: nothing until the outer transaction commits', async () => {
    const h = harness();
    h.service.publishAfterCommit(h.manager, h.publish, { id: 'row-1', organisationId: ORG });
    h.commit(false);
    await flush();
    expect(h.publish).not.toHaveBeenCalled();
    h.commit();
    await flush();
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it('a rollback publishes nothing, even if the same QueryRunner later commits another transaction', async () => {
    const h = harness();
    h.service.publishAfterCommit(h.manager, h.publish, { id: 'row-1', organisationId: ORG });
    h.rollback();
    await flush();
    h.runner.isTransactionActive = true;
    h.commit();
    await flush();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('a savepoint rollback discards the publish too (conservative: the dispatcher handles whatever did commit)', async () => {
    const h = harness();
    h.service.publishAfterCommit(h.manager, h.publish, { id: 'row-1', organisationId: ORG });
    h.rollback(false);
    h.commit();
    await flush();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('publishes the ids captured at registration, not whatever the row object holds at commit', async () => {
    const h = harness();
    const row = { id: 'row-1', organisationId: ORG };
    h.service.publishAfterCommit(h.manager, h.publish, row);
    row.id = 'mutated';
    h.commit();
    await flush();
    expect(h.publish).toHaveBeenCalledWith('row-1', ORG);
  });

  it('no open transaction (no QueryRunner, released, or idle) keeps today\'s behaviour: published at once', async () => {
    const service = new EmailOutboxService();
    const cases = [
      {},
      { queryRunner: { isReleased: true, isTransactionActive: true } },
      { queryRunner: { isReleased: false, isTransactionActive: false } },
    ];
    for (const manager of cases) {
      const publish = jest.fn(async (): Promise<void> => undefined);
      service.publishAfterCommit({ ...manager, connection: { subscribers: [] } } as never, publish, { id: 'row-1', organisationId: ORG });
      await flush();
      expect(publish).toHaveBeenCalledWith('row-1', ORG);
    }
  });

  it('never throws and never makes the commit broadcast wait: a failing or hanging publish is swallowed and logged', async () => {
    const h = harness();
    const failing = jest.fn(async (): Promise<void> => {
      throw new Error('redis down');
    });
    const hanging = jest.fn((): Promise<void> => new Promise(() => undefined));
    expect(() => h.service.publishAfterCommit(h.manager, failing, { id: 'row-1', organisationId: ORG })).not.toThrow();
    h.service.publishAfterCommit(h.manager, hanging, { id: 'row-2', organisationId: ORG });
    const results = h.subscribers.map((s) => {
      h.runner.isTransactionActive = false;
      return s.afterTransactionCommit({ queryRunner: h.runner });
    });
    expect(results.every((r) => r === undefined)).toBe(true);
    await flush();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(hanging).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(String((h.warn.mock.calls[0] as unknown[])[0])).toContain('row-1');
  });

  it('beyond the per-transaction bound a publish is not registered (and not published early): the dispatcher handles it', async () => {
    const h = harness();
    for (let i = 0; i <= EMAIL_FAST_PUBLISH_MAX_PER_TRANSACTION; i++) h.service.publishAfterCommit(h.manager, h.publish, { id: `row-${i}`, organisationId: ORG });
    await flush();
    expect(h.publish).not.toHaveBeenCalled();
    h.commit();
    await flush();
    expect(h.publish).toHaveBeenCalledTimes(EMAIL_FAST_PUBLISH_MAX_PER_TRANSACTION);
    expect(h.calls.every((c) => !c.inTransaction)).toBe(true);
  });
});
