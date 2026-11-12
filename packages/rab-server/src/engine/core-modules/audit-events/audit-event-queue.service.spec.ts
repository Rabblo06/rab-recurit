import { AuditAction } from '../audit/audit.service';
import { AUDIT_BACKLOG_CACHE_MS, AUDIT_EVENT_QUEUE_NAME, AUDIT_PREAUTH_BACKLOG_LIMIT, auditEventJobId } from '../../worker-shared/audit-event.contract';
import { bullmqJobOptionsOf } from '../../worker-shared/queue-registry';
import { currentAuditEventShipperForTests, shipAuditRowAfterCommit, shipPreAuthLoginFailure } from './audit-event-shipping';
import { AuditEventProducer, AuditEventQueueService } from './audit-event-queue.service';

/**
 * X1.1 producer contract (no database, no reachable Redis):
 *  - CREWFLOW_AUDIT_SINK unset / none: no Redis connection, no Queue, nothing registered — today exactly;
 *  - a security row is queued only AFTER the outermost commit, never on rollback, with the registry's options, an ids-only
 *    payload and the deterministic jobId; a non-security row is never queued;
 *  - a queue (Redis) failure or a sink failure never reaches the caller: the action is never blocked or rolled back.
 */
const ORG = '11111111-1111-4111-8111-111111111111';
const ROW = '44444444-4444-4444-8444-444444444444';
const ROW2 = '55555555-5555-4555-8555-555555555555';

type Sub = { afterTransactionCommit: (e: { queryRunner: unknown }) => unknown; afterTransactionRollback: (e: { queryRunner: unknown }) => unknown };
const flush = () => new Promise((r) => setImmediate(r));

function tx() {
  const subscribers: Sub[] = [];
  const runner = { isReleased: false, isTransactionActive: true };
  const manager = { queryRunner: runner, connection: { subscribers } } as never;
  return {
    manager,
    commit: (outermost = true) => {
      runner.isTransactionActive = !outermost;
      subscribers.forEach((s) => s.afterTransactionCommit({ queryRunner: runner }));
    },
    rollback: () => {
      runner.isTransactionActive = false;
      subscribers.forEach((s) => s.afterTransactionRollback({ queryRunner: runner }));
    },
  };
}

function producer(over: { publish?: jest.Mock; readBacklog?: jest.Mock; incrementDrops?: jest.Mock } = {}) {
  const publish = over.publish ?? jest.fn(async () => undefined);
  const readBacklog = over.readBacklog ?? jest.fn(async () => 0);
  const incrementDrops = over.incrementDrops ?? jest.fn(async () => 1);
  const warnings: string[] = [];
  let clock = 1_800_000_000_000;
  const p = new AuditEventProducer({ publish, readBacklog, incrementDrops, now: () => clock, logger: { warn: (m) => void warnings.push(m) } });
  return { p, publish, readBacklog, incrementDrops, warnings, advance: (ms: number) => (clock += ms) };
}
const FAILURE = { email: 'Alice.Smith@Example.com', reason: 'invalid_credentials' as const, provider: 'password' };

describe('AuditEventQueueService (X1.1 producer)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('CREWFLOW_AUDIT_SINK unset or none: disabled — no Redis connection, no Queue, no shipper registered', async () => {
    for (const value of [undefined, '', 'none']) {
      if (value === undefined) delete process.env.CREWFLOW_AUDIT_SINK;
      else process.env.CREWFLOW_AUDIT_SINK = value;
      delete process.env.CREWFLOW_AUDIT_SINK_FILE;
      const service = new AuditEventQueueService({ get: () => 'redis://127.0.0.1:1' } as never);
      const internals = service as unknown as { connection: unknown; queue: unknown };
      expect(service.enabled).toBe(false);
      expect(service.producer).toBeNull();
      expect(internals.connection).toBeNull();
      expect(internals.queue).toBeNull();
      expect(currentAuditEventShipperForTests()).toBeNull();
      const t = tx();
      expect(shipAuditRowAfterCommit(t.manager, { organisationId: ORG, auditLogId: ROW, action: AuditAction.USER_DELETED })).toBe(false);
      expect(() => shipPreAuthLoginFailure(FAILURE)).not.toThrow();
      await service.onModuleDestroy();
    }
  });

  it('stdout: registers as the process shipper; unregisters and closes on destroy', async () => {
    process.env.CREWFLOW_AUDIT_SINK = 'stdout';
    const service = new AuditEventQueueService({ get: () => 'redis://127.0.0.1:1' } as never);
    expect(service.enabled).toBe(true);
    expect(currentAuditEventShipperForTests()).toBe(service.producer);
    // Let the unreachable client fail its first connect BEFORE the queue is closed (a closed queue has no error listener).
    const queue = (service as unknown as { queue: { waitUntilReady(): Promise<unknown> } }).queue;
    await Promise.race([queue.waitUntilReady().catch(() => undefined), new Promise((r) => setTimeout(r, 1_000))]);
    await service.onModuleDestroy();
    expect(currentAuditEventShipperForTests()).toBeNull();
  });

  it('a security row is queued only after the OUTERMOST commit, with the registry options and an ids-only payload', async () => {
    const { p, publish } = producer();
    const t = tx();
    expect(p.afterCommit(t.manager, { organisationId: ORG, auditLogId: ROW, action: AuditAction.PLATFORM_ADMIN_GRANTED })).toBe(true);
    await flush();
    expect(publish).not.toHaveBeenCalled(); // still open
    t.commit(false); // a savepoint release is not a commit
    await flush();
    expect(publish).not.toHaveBeenCalled();
    t.commit(true);
    await flush();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]![0]).toEqual({
      queue: AUDIT_EVENT_QUEUE_NAME,
      name: 'audit-event-ship',
      data: { organisationId: ORG, auditLogId: ROW },
      opts: { jobId: auditEventJobId(ROW), ...bullmqJobOptionsOf(AUDIT_EVENT_QUEUE_NAME) },
    });
  });

  it('a rolled-back transaction ships no event', async () => {
    const { p, publish } = producer();
    const t = tx();
    p.afterCommit(t.manager, { organisationId: ORG, auditLogId: ROW, action: AuditAction.USER_DELETED });
    p.afterCommit(t.manager, { organisationId: ORG, auditLogId: ROW2, action: AuditAction.MEMBER_ROLE_CHANGED });
    t.rollback();
    await flush();
    expect(publish).not.toHaveBeenCalled();
  });

  it('a non-security action is never queued (filtered before anything is registered)', async () => {
    const { p, publish } = producer();
    const t = tx();
    expect(p.afterCommit(t.manager, { organisationId: ORG, auditLogId: ROW, action: AuditAction.OFFER_SENT })).toBe(false);
    t.commit();
    await flush();
    expect(publish).not.toHaveBeenCalled();
  });

  it('an invalid id is refused before Redis and never throws into the caller', async () => {
    const { p, publish, warnings } = producer();
    const t = tx();
    expect(p.afterCommit(t.manager, { organisationId: 'not-a-uuid', auditLogId: ROW, action: AuditAction.USER_DELETED })).toBe(false);
    t.commit();
    await flush();
    expect(publish).not.toHaveBeenCalled();
    expect(warnings.join('\n')).toMatch(/QueueEnqueueRefusedError/);
  });

  it('no open transaction (the insert already committed): published at once, detached', async () => {
    const { p, publish } = producer();
    const manager = { queryRunner: undefined } as never;
    expect(p.afterCommit(manager, { organisationId: ORG, auditLogId: ROW, action: AuditAction.ACCOUNT_SUSPENDED })).toBe(true);
    await flush();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('a queue (Redis) failure is logged by name and swallowed: the caller never sees it', async () => {
    const publish = jest.fn(async () => {
      throw Object.assign(new Error('redis down'), { name: 'QueuePublishUnavailableError' });
    });
    const { p, warnings } = producer({ publish });
    const t = tx();
    expect(() => p.afterCommit(t.manager, { organisationId: ORG, auditLogId: ROW, action: AuditAction.PAYROLL_RECORD_APPROVED })).not.toThrow();
    t.commit();
    await flush();
    await flush();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(warnings.join('\n')).toMatch(/audit event publish failed \(QueuePublishUnavailableError\)/);
    expect(warnings.join('\n')).not.toContain('redis down');
  });

  it('pre-auth failed login: one system-scoped job, masked address, never awaited (synchronous return)', async () => {
    const { p, publish } = producer();
    expect(p.shipPreAuthLoginFailure(FAILURE)).toBeUndefined();
    await flush();
    expect(publish).toHaveBeenCalledTimes(1);
    const job = publish.mock.calls[0]![0];
    expect(job).toMatchObject({ queue: AUDIT_EVENT_QUEUE_NAME, name: 'audit-preauth-login-failed', data: { v: 1, reason: 'invalid_credentials', provider: 'password', email: 'a***@example.com' } });
    expect(job.opts.jobId).toMatch(/^audit-preauth\.[0-9a-f-]{36}$/);
    expect(JSON.stringify(job)).not.toMatch(/alice|smith/i);
  });

  it(`backlog ≤ ${AUDIT_PREAUTH_BACKLOG_LIMIT}: failed-login events are sent`, async () => {
    const { p, publish } = producer({ readBacklog: jest.fn(async () => AUDIT_PREAUTH_BACKLOG_LIMIT - 1) });
    p.shipPreAuthLoginFailure(FAILURE); // first call starts the reading; the event is sent
    await flush();
    p.shipPreAuthLoginFailure(FAILURE); // backlog 9,999 → sent (now 10,000)
    p.shipPreAuthLoginFailure(FAILURE); // 10,000 is not over the limit → sent (now 10,001)
    p.shipPreAuthLoginFailure(FAILURE); // 10,001 > 10,000 → dropped
    await flush();
    expect(publish).toHaveBeenCalledTimes(3);
    expect(p.preAuthDropStats.sinceProcessStart).toBe(1);
  });

  it(`backlog > ${AUDIT_PREAUTH_BACKLOG_LIMIT}: new failed-login events are DROPPED and counted (process counter + batched INCRBY)`, async () => {
    const { p, publish, incrementDrops, readBacklog, advance } = producer({ readBacklog: jest.fn(async () => AUDIT_PREAUTH_BACKLOG_LIMIT + 1) });
    p.shipPreAuthLoginFailure(FAILURE); // before the first reading completes: sent (unknown → send)
    await flush();
    for (let i = 0; i < 5; i++) p.shipPreAuthLoginFailure(FAILURE);
    await flush();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(p.preAuthDropStats).toEqual({ sinceProcessStart: 5, lastBacklog: AUDIT_PREAUTH_BACKLOG_LIMIT + 1 });
    expect(readBacklog).toHaveBeenCalledTimes(1); // cached: one count per interval, never one per login
    advance(AUDIT_BACKLOG_CACHE_MS);
    p.shipPreAuthLoginFailure(FAILURE); // refresh: the 5 pending drops go in ONE INCRBY; this one is dropped too
    await flush();
    expect(readBacklog).toHaveBeenCalledTimes(2);
    expect(incrementDrops).toHaveBeenCalledWith(5);
    await p.drain(1_000); // shutdown flushes the rest
    expect(incrementDrops).toHaveBeenLastCalledWith(1);
  });

  it('a failed INCRBY keeps the drops for the next flush', async () => {
    const incrementDrops = jest.fn().mockRejectedValueOnce(new Error('redis down')).mockResolvedValue(1);
    const { p, advance } = producer({ readBacklog: jest.fn(async () => AUDIT_PREAUTH_BACKLOG_LIMIT + 1), incrementDrops });
    p.shipPreAuthLoginFailure(FAILURE);
    await flush();
    p.shipPreAuthLoginFailure(FAILURE);
    p.shipPreAuthLoginFailure(FAILURE);
    advance(AUDIT_BACKLOG_CACHE_MS);
    p.shipPreAuthLoginFailure(FAILURE); // flush of 2 fails → kept; this event dropped → 3 pending
    await flush();
    await p.drain(1_000);
    expect(incrementDrops.mock.calls.map((c) => c[0])).toEqual([2, 3]);
  });

  it('backlog unreadable: the event is SENT (documented choice), and the login path never waits for the read', async () => {
    let rejectRead!: (e: Error) => void;
    const readBacklog = jest.fn(() => new Promise<number>((_, reject) => (rejectRead = reject)));
    const { p, publish } = producer({ readBacklog });
    p.shipPreAuthLoginFailure(FAILURE); // the read is still pending: returns at once, event sent
    expect(publish).toHaveBeenCalledTimes(1);
    rejectRead(new Error('timeout'));
    await flush();
    p.shipPreAuthLoginFailure(FAILURE);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(p.preAuthDropStats.lastBacklog).toBeNull();
  });

  it('a hung or failing queue add never delays or fails the caller', async () => {
    const hung = producer({ publish: jest.fn(() => new Promise(() => undefined)) });
    const started = Date.now();
    expect(() => hung.p.shipPreAuthLoginFailure(FAILURE)).not.toThrow();
    expect(Date.now() - started).toBeLessThan(50);
    expect(hung.p.inFlightCount).toBe(1); // still pending, the caller already returned
    const failing = producer({
      publish: jest.fn(async () => {
        throw Object.assign(new Error('Redis is unavailable'), { name: 'QueuePublishUnavailableError' });
      }),
    });
    expect(() => failing.p.shipPreAuthLoginFailure(FAILURE)).not.toThrow();
    await flush();
    expect(failing.warnings.join('\n')).toMatch(/pre-auth audit event publish failed \(QueuePublishUnavailableError\)/);
    const throwingRead = producer({
      readBacklog: jest.fn(() => {
        throw new Error('sync');
      }),
    });
    expect(() => throwingRead.p.shipPreAuthLoginFailure(FAILURE)).not.toThrow();
  });

  it('the backlog guard drops ONLY failed-login events: audit-row events are queued whatever the backlog', async () => {
    const { p, publish } = producer({ readBacklog: jest.fn(async () => AUDIT_PREAUTH_BACKLOG_LIMIT * 5) });
    p.shipPreAuthLoginFailure(FAILURE);
    await flush();
    publish.mockClear();
    p.shipPreAuthLoginFailure(FAILURE); // dropped
    const t = tx();
    expect(p.afterCommit(t.manager, { organisationId: ORG, auditLogId: ROW, action: AuditAction.PLATFORM_ADMIN_GRANTED })).toBe(true);
    expect(p.afterCommit({ queryRunner: undefined } as never, { organisationId: ORG, auditLogId: ROW2, action: AuditAction.USER_DELETED })).toBe(true);
    t.commit();
    await flush();
    expect(publish.mock.calls.map((c) => c[0].name)).toEqual(['audit-event-ship', 'audit-event-ship']);
    expect(p.preAuthDropStats.sinceProcessStart).toBe(1);
  });

  it('drain waits (bounded) for publishes in flight', async () => {
    let release!: () => void;
    const publish = jest.fn(() => new Promise<void>((r) => (release = r)));
    const { p } = producer({ publish });
    p.afterCommit({ queryRunner: undefined } as never, { organisationId: ORG, auditLogId: ROW, action: AuditAction.USER_DELETED });
    expect(p.inFlightCount).toBe(1);
    const started = Date.now();
    await p.drain(50);
    expect(Date.now() - started).toBeLessThan(1_000);
    release();
    await p.drain(1_000);
    expect(p.inFlightCount).toBe(0);
  });
});
