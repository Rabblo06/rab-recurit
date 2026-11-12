import { AuditSinkError, SecurityAuditSink } from '../audit-sink/security-audit-sink';
import { AuditAction } from '../audit/audit.service';
import { AUDIT_EVENT_QUEUE_NAME, auditEventJobId } from '../../worker-shared/audit-event.contract';
import { bullmqJobOptionsOf } from '../../worker-shared/queue-registry';
import { currentAuditEventShipperForTests, shipAuditRowAfterCommit, shipPreAuthSecurityEvent } from './audit-event-shipping';
import { AuditEventProducer, AuditEventQueueService } from './audit-event-queue.service';
import { buildLoginFailedSecurityEvent } from './build-security-audit-event';

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

function producer(over: { publish?: jest.Mock; sink?: SecurityAuditSink } = {}) {
  const publish = over.publish ?? jest.fn(async () => undefined);
  const warnings: string[] = [];
  const sink: SecurityAuditSink = over.sink ?? { mode: 'stdout', emit: jest.fn(async () => undefined) };
  const p = new AuditEventProducer({ publish, sink, logger: { warn: (m) => void warnings.push(m) } });
  return { p, publish, sink, warnings };
}

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
      expect(() => shipPreAuthSecurityEvent(buildLoginFailedSecurityEvent({ email: 'a@b.co', reason: 'invalid_credentials', provider: 'password' }, 'api'))).not.toThrow();
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

  it('pre-auth event: written to the sink detached; a sink failure (refuse) is swallowed', async () => {
    const emit = jest.fn(async () => {
      throw new AuditSinkError('the security audit sink (stdout) could not record auth.login_failed (code EPIPE)');
    });
    const { p, warnings } = producer({ sink: { mode: 'stdout', emit } });
    expect(() => p.shipPreAuth(buildLoginFailedSecurityEvent({ email: 'a@b.co', reason: 'invalid_credentials', provider: 'password' }, 'api'))).not.toThrow();
    await p.drain(1_000);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(warnings.join('\n')).toMatch(/pre-auth security event not written \(AuditSinkError\)/);
  });

  it('a sink that throws synchronously is swallowed too', () => {
    const { p } = producer({
      sink: {
        mode: 'stdout',
        emit: () => {
          throw new Error('sync');
        },
      },
    });
    expect(() => p.shipPreAuth(buildLoginFailedSecurityEvent({ email: 'a@b.co', reason: 'invalid_credentials', provider: 'password' }, 'api'))).not.toThrow();
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
