import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { EntityManager } from 'typeorm';

import { AfterCommitPublisher } from '../after-commit/after-commit-publisher';
import { createSecurityAuditSink, SecurityAuditEvent, SecurityAuditSink, securityAuditSinkConfig } from '../audit-sink/security-audit-sink';
import { EnvironmentService } from '../environment/environment.service';
import { AUDIT_EVENT_JOB_NAME, AUDIT_EVENT_QUEUE_NAME, AuditEventJobData, auditEventJobId } from '../../worker-shared/audit-event.contract';
import { enqueueRegisteredJob, RegisteredJob, registeredJob } from '../../worker-shared/queue-enqueue';
import { boundedPublish, closeQueueProducer, createQueueProducerConnection } from '../../worker-shared/queue-producer-connection';
import { AuditEventShipper, AuditRowToShip, registerAuditEventShipper, unregisterAuditEventShipper } from './audit-event-shipping';
import { classifyAuditAction } from './security-audit-event-catalogue';

/** Bound on audit-event publishes held for ONE transaction (a bulk payroll approval stays inside it). Beyond it: dropped, logged. */
export const AUDIT_EVENT_MAX_PER_TRANSACTION = 1_000;
/** Process-wide bound on publishes / pre-auth emits in flight (each publish is also bounded by `boundedPublish`, 3 s). */
export const AUDIT_EVENT_MAX_IN_FLIGHT = 1_000;
/** How long shutdown waits for publishes already in flight (a CLI command exits right after its commit). */
export const AUDIT_EVENT_DRAIN_TIMEOUT_MS = 3_500;

type AuditEventJob = RegisteredJob<typeof AUDIT_EVENT_QUEUE_NAME, AuditEventJobData>;

export interface AuditEventProducerDeps {
  /** Adds one validated job to `crewflow-audit-events` (bounded). Rejects on any Redis problem. */
  publish(job: AuditEventJob): Promise<unknown>;
  /** The sink pre-auth events are written to (the process's configured sink). */
  sink: SecurityAuditSink;
  logger: { warn(message: string): void };
  maxPerTransaction?: number;
  maxInFlight?: number;
}

/**
 * Phase X Part 2, X1.1: the producer side of the off-host copy (plain class; the Nest wrapper below owns Redis). Twenty's
 * event-logs: the event is handed off after the action and a queue/sink writes it; the action never waits for it.
 *
 *  - `afterCommit(manager, row)`: for a row whose action is in the security catalogue, validates the ids-only job
 *    (`registeredJob`: organisation scope, payload keys, deterministic jobId) and registers its publish on the engine
 *    AfterCommitPublisher — fired only after the OUTERMOST commit, discarded by a TypeORM rollback, detached from the caller,
 *    bounded per transaction and in flight. A rollback the publisher cannot see (a raw `ROLLBACK TO SAVEPOINT`) is still
 *    safe: the Worker re-reads the row by id and ships nothing when it does not exist. With no open transaction the insert
 *    already committed, so the publish starts at once (detached).
 *  - `shipPreAuth(event)`: the pre-authentication login failure, which has no row and no organisation: written to the sink
 *    directly, detached, never awaited.
 *  Every failure is logged by error NAME only and swallowed. NOTHING here can block, delay or roll back the caller.
 */
export class AuditEventProducer implements AuditEventShipper {
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly maxInFlight: number;
  private readonly publisher: AfterCommitPublisher;

  constructor(private readonly deps: AuditEventProducerDeps) {
    this.maxInFlight = deps.maxInFlight ?? AUDIT_EVENT_MAX_IN_FLIGHT;
    this.publisher = new AfterCommitPublisher({
      maxPerTransaction: deps.maxPerTransaction ?? AUDIT_EVENT_MAX_PER_TRANSACTION,
      maxInFlight: this.maxInFlight,
      failureMessage: (name) => `audit event publish failed (${name}); the row stays in core.audit_log and is not shipped (best effort)`,
      logger: deps.logger,
    });
  }

  afterCommit(manager: EntityManager, row: AuditRowToShip): boolean {
    if (!classifyAuditAction(row.action)) return false;
    let job: AuditEventJob;
    try {
      job = registeredJob(AUDIT_EVENT_QUEUE_NAME, AUDIT_EVENT_JOB_NAME, { kind: 'organisation', organisationId: row.organisationId }, { organisationId: row.organisationId, auditLogId: row.auditLogId }, {
        jobId: auditEventJobId(row.auditLogId),
      });
    } catch (error) {
      this.deps.logger.warn(`audit event not shipped (${(error as Error)?.name ?? 'Error'}): the job was refused before Redis`);
      return false;
    }
    const runner = manager.queryRunner;
    if (runner && !runner.isReleased && runner.isTransactionActive) {
      const registered = this.publisher.defer(manager, async () => {
        await this.track(this.deps.publish(job));
      });
      if (!registered) this.deps.logger.warn('audit event not shipped: the per-transaction bound was reached (the row stays in core.audit_log)');
      return registered;
    }
    // No open transaction: the insert has already committed. Publish now, detached.
    if (this.inFlight.size >= this.maxInFlight) return false;
    void this.track(this.deps.publish(job)).catch((error: Error) => this.deps.logger.warn(`audit event publish failed (${error?.name ?? 'Error'}); not shipped (best effort)`));
    return true;
  }

  shipPreAuth(event: SecurityAuditEvent): void {
    if (this.inFlight.size >= this.maxInFlight) return;
    let pending: Promise<void>;
    try {
      pending = this.deps.sink.emit(event);
    } catch (error) {
      this.deps.logger.warn(`pre-auth security event not written (${(error as Error)?.name ?? 'Error'}); continuing (best effort)`);
      return;
    }
    void this.track(pending).catch((error: Error) => this.deps.logger.warn(`pre-auth security event not written (${error?.name ?? 'Error'}); continuing (best effort)`));
  }

  /** Publishes / emits currently in flight (tests / diagnostics). */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /** Waits (bounded) for what is already in flight. Never rejects. */
  async drain(timeoutMs: number = AUDIT_EVENT_DRAIN_TIMEOUT_MS): Promise<void> {
    if (this.inFlight.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.allSettled([...this.inFlight]), new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
    if (timer) clearTimeout(timer);
  }

  private track<T>(pending: Promise<T>): Promise<T> {
    this.inFlight.add(pending);
    const done = () => this.inFlight.delete(pending);
    pending.then(done, done);
    return pending;
  }
}

/**
 * The Nest owner of the producer: global through AuditModule, so the API, the Worker and the CLI each build exactly one.
 * CREWFLOW_AUDIT_SINK unset / `none` (development, tests) → disabled: no Redis connection, no Queue, nothing registered,
 * every audit write behaves exactly as before. Otherwise (production: `stdout`, validated by `securityAuditSinkConfig`,
 * fail closed on an invalid value) it opens one fail-fast producer connection and registers itself as the process's
 * audit-event shipper (audit-event-shipping.ts).
 */
@Injectable()
export class AuditEventQueueService implements OnModuleDestroy {
  private readonly logger = new Logger('AuditEvents');
  readonly enabled: boolean;
  readonly producer: AuditEventProducer | null = null;
  private readonly connection: Redis | null = null;
  private readonly queue: Queue<AuditEventJobData> | null = null;

  constructor(env: EnvironmentService) {
    const config = securityAuditSinkConfig(process.env);
    this.enabled = config.mode !== 'none';
    if (!this.enabled) return;
    const connection = createQueueProducerConnection(env.get('REDIS_URL'));
    const queue = new Queue<AuditEventJobData>(AUDIT_EVENT_QUEUE_NAME, { connection });
    queue.on('error', () => undefined);
    this.connection = connection;
    this.queue = queue;
    this.producer = new AuditEventProducer({
      publish: (job) => boundedPublish(connection, 'audit event publish', () => enqueueRegisteredJob(queue, job)),
      sink: createSecurityAuditSink(config, { log: (line) => this.logger.warn(line) }),
      logger: this.logger,
    });
    registerAuditEventShipper(this.producer);
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.producer) return;
    unregisterAuditEventShipper(this.producer);
    await this.producer.drain();
    if (this.queue && this.connection) await closeQueueProducer(this.queue, this.connection);
  }
}
