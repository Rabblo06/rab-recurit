import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { EntityManager } from 'typeorm';

import { AfterCommitPublisher } from '../after-commit/after-commit-publisher';
import { securityAuditSinkConfig } from '../audit-sink/security-audit-sink';
import { EnvironmentService } from '../environment/environment.service';
import {
  AUDIT_BACKLOG_CACHE_MS,
  AUDIT_EVENT_JOB_NAME,
  AUDIT_EVENT_QUEUE_NAME,
  AUDIT_PREAUTH_BACKLOG_LIMIT,
  AUDIT_PREAUTH_JOB_NAME,
  AuditEventJobData,
  auditEventJobId,
  AuditPreAuthJobData,
  auditPreAuthDropsKey,
  auditPreAuthJobId,
} from '../../worker-shared/audit-event.contract';
import { enqueueRegisteredJob, RegisteredJob, registeredJob, registeredSystemScopedJob } from '../../worker-shared/queue-enqueue';
import { boundedPublish, closeQueueProducer, createQueueProducerConnection, QUEUE_PUBLISH_TIMEOUT_MS } from '../../worker-shared/queue-producer-connection';
import { AuditEventShipper, AuditRowToShip, PreAuthLoginFailure, registerAuditEventShipper, unregisterAuditEventShipper } from './audit-event-shipping';
import { maskEmailForAudit } from './build-security-audit-event';
import { classifyAuditAction } from './security-audit-event-catalogue';

/** Bound on audit-event publishes held for ONE transaction (a bulk payroll approval stays inside it). Beyond it: dropped, logged. */
export const AUDIT_EVENT_MAX_PER_TRANSACTION = 1_000;
/** Process-wide bound on publishes in flight (each publish is also bounded by `boundedPublish`, 3 s). */
export const AUDIT_EVENT_MAX_IN_FLIGHT = 1_000;
/** How long shutdown waits for publishes already in flight (a CLI command exits right after its commit). */
export const AUDIT_EVENT_DRAIN_TIMEOUT_MS = 3_500;

type AuditEventJob = RegisteredJob<typeof AUDIT_EVENT_QUEUE_NAME, AuditEventJobData | AuditPreAuthJobData>;

export interface AuditEventProducerDeps {
  /** Adds one validated job to `crewflow-audit-events` (bounded). Rejects on any Redis problem. */
  publish(job: AuditEventJob): Promise<unknown>;
  /** The audit queue's backlog: waiting + delayed + prioritized jobs (bounded). Rejects when it cannot be read. */
  readBacklog(): Promise<number>;
  /** Adds `n` to the durable drop total (bounded INCRBY on one dedicated key). */
  incrementDrops(n: number): Promise<unknown>;
  logger: { warn(message: string): void };
  now?: () => number;
  maxPerTransaction?: number;
  maxInFlight?: number;
}

export interface PreAuthDropStats {
  /** Failed-login events this process dropped above the backlog limit (or at the in-flight bound) since it started. */
  sinceProcessStart: number;
  /** The last backlog reading of this process (null: none yet, or the read failed). */
  lastBacklog: number | null;
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
 *    already committed, so the publish starts at once (detached). NEVER dropped by the backlog guard.
 *  - `shipPreAuthLoginFailure(failure)` (owner decision 2026-11-12 b): the pre-authentication failed login — no row, no
 *    organisation — goes to the same queue as a system-scoped job, fire-and-forget. OWNER GUARD: when the queue's backlog
 *    is over AUDIT_PREAUTH_BACKLOG_LIMIT (10,000) the event is DROPPED and counted (process counter + a batched Redis
 *    INCRBY on one dedicated key, shown on the platform-admin Health tab).
 *    Backlog reading: one count per process every AUDIT_BACKLOG_CACHE_MS (2 s), refreshed in the background (never awaited
 *    by a login), and bumped by one for every event this process sends in between, so a burst trips the guard without
 *    waiting for the next reading. When the backlog cannot be read (or before the first reading) the event is SENT: the
 *    add itself is bounded (fail-fast connection, 3 s, in-flight cap), so a Redis outage costs only lost events, while
 *    dropping on a failed READ would lose events whenever a count call hiccups on a healthy Redis.
 *  Every failure is logged by error NAME only and swallowed. NOTHING here can block, delay or roll back the caller.
 */
export class AuditEventProducer implements AuditEventShipper {
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly maxInFlight: number;
  private readonly publisher: AfterCommitPublisher;
  private readonly now: () => number;
  private backlog: number | null = null;
  private lastBacklogReadAt = -Infinity;
  private refreshing = false;
  private dropsSinceStart = 0;
  private dropsPending = 0;

  constructor(private readonly deps: AuditEventProducerDeps) {
    this.maxInFlight = deps.maxInFlight ?? AUDIT_EVENT_MAX_IN_FLIGHT;
    this.now = deps.now ?? Date.now;
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

  shipPreAuthLoginFailure(failure: PreAuthLoginFailure): void {
    this.refreshIfStale();
    if ((this.backlog !== null && this.backlog > AUDIT_PREAUTH_BACKLOG_LIMIT) || this.inFlight.size >= this.maxInFlight) {
      this.dropsSinceStart++;
      this.dropsPending++;
      return;
    }
    let job: AuditEventJob;
    try {
      const data: AuditPreAuthJobData = {
        v: 1,
        reason: failure.reason,
        provider: String(failure.provider).slice(0, 32),
        ...(failure.providerReason ? { providerReason: String(failure.providerReason).slice(0, 64) } : {}),
        email: maskEmailForAudit(failure.email).slice(0, 128),
        at: this.now(),
      };
      job = registeredSystemScopedJob(AUDIT_EVENT_QUEUE_NAME, AUDIT_PREAUTH_JOB_NAME, data, { jobId: auditPreAuthJobId(randomUUID()) });
    } catch (error) {
      this.deps.logger.warn(`pre-auth audit event not queued (${(error as Error)?.name ?? 'Error'}): refused before Redis`);
      return;
    }
    if (this.backlog !== null) this.backlog++;
    void this.track(this.deps.publish(job)).catch((error: Error) => this.deps.logger.warn(`pre-auth audit event publish failed (${error?.name ?? 'Error'}); not shipped (best effort)`));
  }

  /** Drop counts and the last backlog reading of this process (platform-admin Health tab). */
  get preAuthDropStats(): PreAuthDropStats {
    return { sinceProcessStart: this.dropsSinceStart, lastBacklog: this.backlog };
  }

  /** Publishes currently in flight (tests / diagnostics). */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /** Waits (bounded) for what is already in flight, then flushes the pending drop count once. Never rejects. */
  async drain(timeoutMs: number = AUDIT_EVENT_DRAIN_TIMEOUT_MS): Promise<void> {
    const pending: Array<Promise<unknown>> = [...this.inFlight];
    const flush = this.flushDrops();
    if (flush) pending.push(flush);
    if (pending.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.allSettled(pending), new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
    if (timer) clearTimeout(timer);
  }

  /** At most one background backlog read (and drop-count flush) per AUDIT_BACKLOG_CACHE_MS. Never awaited by a caller. */
  private refreshIfStale(): void {
    const now = this.now();
    if (this.refreshing || now - this.lastBacklogReadAt < AUDIT_BACKLOG_CACHE_MS) return;
    this.refreshing = true;
    this.lastBacklogReadAt = now;
    void this.flushDrops();
    let read: Promise<number>;
    try {
      read = this.deps.readBacklog();
    } catch {
      read = Promise.reject(new Error('read failed'));
    }
    void read
      .then(
        (n) => {
          this.backlog = Number.isFinite(n) && n >= 0 ? n : null;
        },
        () => {
          this.backlog = null; // unknown → send (see the class comment)
        },
      )
      .finally(() => {
        this.refreshing = false;
      });
  }

  /** Adds the pending drops to the durable total; on failure they are kept for the next flush. */
  private flushDrops(): Promise<unknown> | null {
    const n = this.dropsPending;
    if (n === 0) return null;
    this.dropsPending = 0;
    let pending: Promise<unknown>;
    try {
      pending = this.deps.incrementDrops(n);
    } catch (error) {
      pending = Promise.reject(error);
    }
    return pending.catch(() => {
      this.dropsPending += n;
    });
  }

  private track<T>(pending: Promise<T>): Promise<T> {
    this.inFlight.add(pending);
    const done = () => this.inFlight.delete(pending);
    pending.then(done, done);
    return pending;
  }
}

const withTimeout = <T>(pending: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  pending.catch(() => undefined);
  return Promise.race([
    pending,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
      timer.unref?.();
    }),
  ]).finally(() => timer && clearTimeout(timer));
};

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
  private readonly queue: Queue<AuditEventJobData | AuditPreAuthJobData> | null = null;
  private readonly dropsKey: string;

  constructor(env: EnvironmentService) {
    const config = securityAuditSinkConfig(process.env);
    this.enabled = config.mode !== 'none';
    this.dropsKey = auditPreAuthDropsKey(process.env.NODE_ENV?.trim() || 'development');
    if (!this.enabled) return;
    const connection = createQueueProducerConnection(env.get('REDIS_URL'));
    const queue = new Queue<AuditEventJobData | AuditPreAuthJobData>(AUDIT_EVENT_QUEUE_NAME, { connection });
    queue.on('error', () => undefined);
    this.connection = connection;
    this.queue = queue;
    this.producer = new AuditEventProducer({
      publish: (job) => boundedPublish(connection, 'audit event publish', () => enqueueRegisteredJob(queue, job)),
      readBacklog: async () => {
        const counts = await withTimeout(queue.getJobCounts('waiting', 'delayed', 'prioritized'), QUEUE_PUBLISH_TIMEOUT_MS);
        return Number(counts.waiting ?? 0) + Number(counts.delayed ?? 0) + Number(counts.prioritized ?? 0);
      },
      incrementDrops: (n) => withTimeout(connection.incrby(this.dropsKey, n), QUEUE_PUBLISH_TIMEOUT_MS),
      logger: this.logger,
    });
    registerAuditEventShipper(this.producer);
  }

  /**
   * The failed-login drop counts for the platform-admin Health tab: this process's counter, and the durable total across
   * every process (one bounded GET of the dedicated key; null when Redis does not answer or the shipper is disabled).
   */
  async preAuthDropReport(): Promise<{ enabled: boolean; total: number | null; sinceProcessStart: number; lastBacklog: number | null }> {
    const local = this.producer?.preAuthDropStats ?? { sinceProcessStart: 0, lastBacklog: null };
    if (!this.connection) return { enabled: false, total: null, ...local };
    try {
      const raw = await withTimeout(this.connection.get(this.dropsKey), 1_000);
      const total = raw === null ? 0 : Number(raw);
      return { enabled: true, total: Number.isFinite(total) ? total : null, ...local };
    } catch {
      return { enabled: true, total: null, ...local };
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.producer) return;
    unregisterAuditEventShipper(this.producer);
    await this.producer.drain();
    if (this.queue && this.connection) await closeQueueProducer(this.queue, this.connection);
  }
}
