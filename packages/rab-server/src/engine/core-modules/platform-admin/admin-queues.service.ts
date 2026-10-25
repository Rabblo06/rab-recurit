import { ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { Job, Metrics, Queue } from 'bullmq';
import Redis from 'ioredis';

import { AuditService } from '../audit/audit.service';
import { StepUpReauthService } from '../auth/services/step-up-reauth.service';
import { EnvironmentService } from '../environment/environment.service';
import { AuthContext } from '../tenant/auth-context.interface';
import { TenantContextService } from '../tenant/tenant-context.service';
import { ThrottlerRedisClientProvider } from '../throttler/throttler-redis-client.provider';
import {
  PROVISIONER_CYCLE_DURATIONS_KEY,
  WORKER_CYCLE_DURATIONS_KEY,
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_TTL_SECONDS,
  WORKER_SCHEDULER_STATUS_KEY,
  WORKER_STATS_KEY,
} from '../../worker-shared/heartbeat.constants';
import { CONSUMER_QUEUES, LEGACY_BULL_PREFIX, SCAN_QUEUE_NAMES, WORKER_METRICS_MAX_DATA_POINTS } from '../../worker-shared/queue-registry';
import { assertActivePlatformAdmin, isUuid, refuseInspection, requireReason, withTimeout } from './admin-actor';
import { ADMIN_PANEL_AUDIT_ACTION, recordAdminPanelAudit } from './admin-panel-audit-actions';
import { ADMIN_METRICS_RANGES, AdminJobState, AdminMetricsRange, JOB_ID_PATTERN } from './dto/admin-panel.dto';
import { parseSchedulerStatus } from './outbox-operations.service';
import { PlatformAdminService } from './platform-admin.service';

type Actor = Pick<AuthContext, 'userId' | 'organisationId' | 'workspaceId' | 'sessionId' | 'inspectedBy'>;

type QueueKind = 'consumer' | 'scan';

interface QueueDefinition {
  name: string;
  kind: QueueKind;
  prefix: string;
  /** D7 (owner, 2026-10-24): which job states each action may touch. Empty = the action is not available on this queue. */
  retryStates: readonly AdminJobState[];
  deleteStates: readonly AdminJobState[];
  /** Whether a job's `data` carries the allowlisted id keys (email/push outbox ids + organisation id). */
  idKeys: readonly string[];
  /** Why actions are refused (shown in the UI). */
  lockedReason: string | null;
}

export interface AdminQueueSummary {
  name: string;
  kind: QueueKind;
  counts: Partial<Record<'failed' | 'active' | 'waiting' | 'delayed' | 'completed' | 'paused' | 'prioritized', number>> | null;
  actions: { retry: readonly AdminJobState[]; delete: readonly AdminJobState[]; lockedReason: string | null };
}

export interface AdminWorkerCycle {
  source: 'worker' | 'provisioner';
  loop: string;
  runs: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  lastMs: number | null;
  succeeded: number;
  idle: number;
  failed: number;
  skipped: number;
  measuredAt: string | null;
}

export interface AdminQueuesOverview {
  mode: 'interval' | 'bullmq';
  queues: AdminQueueSummary[];
  /** BullMQ metrics are recorded by every Worker (one-minute points, one week kept); the chart reads `/:queue/metrics`. */
  metrics: { collected: true; retentionMinutes: number };
  worker: { heartbeatAgeSeconds: number | null; stale: boolean; scheduler: { reconciledAt: string | null; schedulers: number | null } | null };
  cycles: AdminWorkerCycle[];
  lastRuns: Array<{ key: string; at: string }>;
}

export interface AdminJobItem {
  id: string;
  name: string;
  state: AdminJobState;
  createdAt: string | null;
  processedAt: string | null;
  finishedAt: string | null;
  attemptsMade: number;
  maxAttempts: number | null;
  /** A safe error CLASS only — never the failure message, stack trace or return value. */
  errorClass: string | null;
  organisationId: string | null;
  /** email/push: the outbox row id the job delivers (no payload). */
  entityId: string | null;
  scheduler: boolean;
}

export interface AdminQueueMetricsBucket {
  /** Bucket start (ISO). One minute for 1H, one hour for every other range. */
  at: string;
  completed: number;
  failed: number;
}

export interface AdminQueueMetrics {
  queue: string;
  range: AdminMetricsRange;
  bucketMinutes: 1 | 60;
  from: string;
  to: string;
  /** False = "Metrics unavailable": no data point was ever recorded for this queue, or Redis did not answer in 2 s. */
  available: boolean;
  reason: 'NO_DATA' | 'UNAVAILABLE' | null;
  buckets: AdminQueueMetricsBucket[];
  totals: { completed: number; failed: number };
  generatedAt: string;
}

export interface AdminJobActionResult {
  queue: string;
  done: string[];
  skipped: Array<{ id: string; reason: 'not_found' | 'wrong_state' | 'scheduler' }>;
}

const STATES: readonly AdminJobState[] = ['failed', 'active', 'waiting', 'delayed', 'completed'];
const COUNT_STATES = ['failed', 'active', 'waiting', 'delayed', 'completed', 'paused', 'prioritized'] as const;
const LOOP_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const STAT_LAST_KEY = /^last[A-Z][A-Za-z0-9]{0,62}At$/;

/** Fixed error classes; `failedReason` itself never leaves this process. */
export function classifyFailure(reason: unknown): string | null {
  if (typeof reason !== 'string' || reason === '') return null;
  if (/unrecoverable/i.test(reason)) return 'UNRECOVERABLE';
  if (/\b429\b|rate.?limit/i.test(reason)) return 'PROVIDER_429';
  if (/timed? ?out|ETIMEDOUT/i.test(reason)) return 'TIMEOUT';
  if (/stalled/i.test(reason)) return 'STALLED';
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EPIPE/.test(reason)) return 'NETWORK';
  if (/^[A-Z][A-Z0-9_]{2,63}$/.test(reason)) return reason;
  return 'SEE_WORKER_LOG';
}

/**
 * Crewflow Platform Admin Panel — Health tab: queue registry counts, worker heartbeat / scheduler / cycle durations, and
 * the BullMQ job list with D7-gated retry/delete.
 *
 * D7 (owner, 2026-10-24): retry FAILED jobs on rab-email / rab-push (the processors re-check the outbox row, so a
 * retried job can never send twice) and on the crewflow-scan-* queues; delete COMPLETED/FAILED jobs on the scan queues
 * only; NOTHING on rab-shift-statements (payroll); never an active job, never a job scheduler / repeatable definition.
 * Retry and delete need a reason and a recent step-up of this session, refuse Admin Inspect, re-fetch every job and
 * re-check its state (a retry of a job that is no longer failed is a no-op), and are audited in the admin's organisation.
 *
 * Job DATA is never returned: ids, timestamps, attempt counters, an error CLASS (`classifyFailure`), and from `data` only
 * the allowlisted id keys (`emailOutboxId` / `pushDeliveryId` / `organisationId`, uuids only).
 *
 * Scan queues exist only when a `WORKER_SCHEDULER=bullmq` jobs replica is alive (its short-TTL scheduler status key names
 * the prefix); in interval mode they are not listed, and the "Worker cycles" table is the source of truth.
 */
@Injectable()
export class AdminQueuesService implements OnModuleDestroy {
  private readonly logger = new Logger(AdminQueuesService.name);
  private connection: Redis | null = null;
  private readonly queues = new Map<string, Queue>();
  /** Metrics answers cached ~30 s per queue + range (at most 10 queues x 5 ranges): 15 s polling by N admins costs one read. */
  private readonly metricsCache = new Map<string, { at: number; value: AdminQueueMetrics }>();

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly platformAdmin: PlatformAdminService,
    private readonly audit: AuditService,
    private readonly stepUp: StepUpReauthService,
    private readonly env: EnvironmentService,
    private readonly redis: ThrottlerRedisClientProvider,
  ) {}

  private async schedulerStatus() {
    try {
      return parseSchedulerStatus(await withTimeout(this.redis.client.hgetall(WORKER_SCHEDULER_STATUS_KEY), 2_000));
    } catch {
      return null;
    }
  }

  private async definitions(): Promise<{ mode: 'interval' | 'bullmq'; defs: QueueDefinition[]; scheduler: Awaited<ReturnType<AdminQueuesService['schedulerStatus']>> }> {
    const scheduler = await this.schedulerStatus();
    const defs: QueueDefinition[] = [
      { name: CONSUMER_QUEUES.email.name, kind: 'consumer', prefix: LEGACY_BULL_PREFIX, retryStates: ['failed'], deleteStates: [], idKeys: ['emailOutboxId', 'organisationId'], lockedReason: null },
      { name: CONSUMER_QUEUES.push.name, kind: 'consumer', prefix: LEGACY_BULL_PREFIX, retryStates: ['failed'], deleteStates: [], idKeys: ['pushDeliveryId', 'organisationId'], lockedReason: null },
      {
        name: CONSUMER_QUEUES.shiftStatements.name,
        kind: 'consumer',
        prefix: LEGACY_BULL_PREFIX,
        retryStates: [],
        deleteStates: [],
        idKeys: [],
        lockedReason: 'Payroll statements cannot be retried or deleted from here.',
      },
    ];
    if (scheduler) {
      for (const name of SCAN_QUEUE_NAMES) {
        defs.push({ name, kind: 'scan', prefix: scheduler.prefix, retryStates: ['failed'], deleteStates: ['completed', 'failed'], idKeys: [], lockedReason: null });
      }
    }
    return { mode: scheduler ? 'bullmq' : 'interval', defs, scheduler };
  }

  private queue(def: QueueDefinition): Queue {
    const key = `${def.prefix}|${def.name}`;
    let queue = this.queues.get(key);
    if (!queue) {
      this.connection ??= new Redis(this.env.get('REDIS_URL'), { maxRetriesPerRequest: null, connectTimeout: 1_000, lazyConnect: true });
      this.connection.on('error', () => undefined);
      queue = new Queue(def.name, { connection: this.connection, prefix: def.prefix });
      this.queues.set(key, queue);
    }
    return queue;
  }

  private async resolve(name: string): Promise<QueueDefinition> {
    const { defs } = await this.definitions();
    const def = defs.find((d) => d.name === name);
    if (!def) throw new NotFoundException('Queue not found.');
    return def;
  }

  async overview(actor: Actor): Promise<AdminQueuesOverview> {
    await assertActivePlatformAdmin(this.platformAdmin, actor);
    const { mode, defs, scheduler } = await this.definitions();
    const queues = await Promise.all(
      defs.map(async (def): Promise<AdminQueueSummary> => {
        let counts: AdminQueueSummary['counts'] = null;
        try {
          const raw = await withTimeout(this.queue(def).getJobCounts(...COUNT_STATES), 2_000);
          counts = Object.fromEntries(COUNT_STATES.map((s) => [s, Number(raw[s] ?? 0)]));
        } catch (error) {
          this.logger.debug(`queue counts for ${def.name} unavailable: ${(error as Error).message}`);
        }
        return { name: def.name, kind: def.kind, counts, actions: { retry: def.retryStates, delete: def.deleteStates, lockedReason: def.lockedReason } };
      }),
    );
    let heartbeatAgeSeconds: number | null = null;
    let cycles: AdminWorkerCycle[] = [];
    let lastRuns: AdminQueuesOverview['lastRuns'] = [];
    try {
      const [beat, stats, workerDurations, provisionerDurations] = await withTimeout(
        Promise.all([
          this.redis.client.get(WORKER_HEARTBEAT_KEY),
          this.redis.client.hgetall(WORKER_STATS_KEY),
          this.redis.client.hgetall(WORKER_CYCLE_DURATIONS_KEY),
          this.redis.client.hgetall(PROVISIONER_CYCLE_DURATIONS_KEY),
        ]),
        2_000,
      );
      const beatMs = Number(beat);
      heartbeatAgeSeconds = beat && Number.isFinite(beatMs) ? Math.max(0, Math.round((Date.now() - beatMs) / 1000)) : null;
      cycles = [...parseCycles('worker', workerDurations), ...parseCycles('provisioner', provisionerDurations)];
      lastRuns = Object.entries(stats ?? {})
        .filter(([k, v]) => STAT_LAST_KEY.test(k) && /^\d{10,15}$/.test(String(v)))
        .map(([key, v]) => ({ key, at: new Date(Number(v)).toISOString() }))
        .sort((a, b) => a.key.localeCompare(b.key));
    } catch {
      // Redis unavailable: report unknown, never throw from a health read.
    }
    return {
      mode,
      queues,
      metrics: { collected: true, retentionMinutes: WORKER_METRICS_MAX_DATA_POINTS },
      worker: {
        heartbeatAgeSeconds,
        stale: heartbeatAgeSeconds === null || heartbeatAgeSeconds > WORKER_HEARTBEAT_TTL_SECONDS,
        scheduler: scheduler ? { reconciledAt: scheduler.reconciledAt ? new Date(scheduler.reconciledAt).toISOString() : null, schedulers: scheduler.schedulers } : null,
      },
      cycles,
      lastRuns,
    };
  }

  async listJobs(actor: Actor, queueName: string, state: AdminJobState, offset = 0, limit = 25): Promise<{ items: AdminJobItem[]; total: number | null }> {
    await assertActivePlatformAdmin(this.platformAdmin, actor);
    if (!STATES.includes(state)) throw new NotFoundException();
    const def = await this.resolve(queueName);
    const size = Math.min(Math.max(limit, 1), 50);
    const queue = this.queue(def);
    try {
      const [jobs, counts] = await withTimeout(Promise.all([queue.getJobs([state], offset, offset + size - 1, false), queue.getJobCounts(state)]), 2_000);
      return { items: jobs.filter((j): j is Job => Boolean(j)).map((j) => toJobItem(j, state, def)), total: Number(counts[state] ?? 0) };
    } catch (error) {
      this.logger.debug(`job list for ${def.name} unavailable: ${(error as Error).message}`);
      return { items: [], total: null };
    }
  }

  /**
   * Health chart: completed vs failed jobs per bucket for one registry queue, from BullMQ's own metrics (`Queue.getMetrics`,
   * recorded by the Workers with `maxDataPoints = MetricsTime.ONE_WEEK`). Counts only: no job id, name, data or error text
   * can appear (the metrics keys hold integers). Bounded: at most 10 080 points read per type (7D), 2 s timeout, at most
   * 168 buckets returned, cached 30 s. Never synthesised from job counts: no recorded point means `available: false`.
   */
  async metrics(actor: Actor, queueName: string, range: AdminMetricsRange): Promise<AdminQueueMetrics> {
    await assertActivePlatformAdmin(this.platformAdmin, actor);
    if (!(ADMIN_METRICS_RANGES as readonly string[]).includes(range)) throw new NotFoundException();
    const def = await this.resolve(queueName);
    const key = `${def.prefix}|${def.name}|${range}`;
    const now = Date.now();
    const hit = this.metricsCache.get(key);
    if (hit && now - hit.at < METRICS_CACHE_MS) return hit.value;
    const spec = METRICS_RANGE_SPEC[range];
    let value: AdminQueueMetrics;
    try {
      const queue = this.queue(def);
      const [completed, failed] = await withTimeout(
        Promise.all([queue.getMetrics('completed', 0, spec.minutes - 1), queue.getMetrics('failed', 0, spec.minutes - 1)]),
        2_000,
      );
      value = bucketQueueMetrics(def.name, range, completed, failed, now);
    } catch (error) {
      this.logger.debug(`metrics for ${def.name} unavailable: ${(error as Error).message}`);
      value = { ...bucketQueueMetrics(def.name, range, null, null, now), available: false, reason: 'UNAVAILABLE' };
    }
    this.metricsCache.set(key, { at: now, value });
    return value;
  }

  async retryJobs(actor: Actor, queueName: string, jobIds: unknown, reasonInput: unknown): Promise<AdminJobActionResult> {
    return this.act(actor, queueName, jobIds, reasonInput, 'retry');
  }

  async deleteJobs(actor: Actor, queueName: string, jobIds: unknown, reasonInput: unknown): Promise<AdminJobActionResult> {
    return this.act(actor, queueName, jobIds, reasonInput, 'delete');
  }

  private async act(actor: Actor, queueName: string, jobIdsInput: unknown, reasonInput: unknown, action: 'retry' | 'delete'): Promise<AdminJobActionResult> {
    refuseInspection(actor);
    await assertActivePlatformAdmin(this.platformAdmin, actor);
    const reason = requireReason(reasonInput);
    const jobIds = Array.isArray(jobIdsInput) ? [...new Set(jobIdsInput)] : [];
    if (jobIds.length === 0 || jobIds.length > 100 || !jobIds.every((id) => typeof id === 'string' && JOB_ID_PATTERN.test(id))) {
      throw new ConflictException({ code: 'INVALID_JOB_IDS', message: 'Select between 1 and 100 jobs.' });
    }
    const def = await this.resolve(queueName);
    const allowed = action === 'retry' ? def.retryStates : def.deleteStates;
    if (allowed.length === 0) {
      throw new ConflictException({
        code: 'QUEUE_ACTION_NOT_ALLOWED',
        message: def.lockedReason ?? (action === 'delete' ? 'Jobs on this queue cannot be deleted. Failed outbox messages can still be replayed.' : 'Jobs on this queue cannot be retried.'),
      });
    }
    await this.stepUp.assertRecentStepUp(actor, action === 'retry' ? 'platform.queue_jobs.retry' : 'platform.queue_jobs.delete');

    const queue = this.queue(def);
    const done: string[] = [];
    const skipped: AdminJobActionResult['skipped'] = [];
    for (const id of jobIds as string[]) {
      if (id.startsWith('repeat:')) {
        skipped.push({ id, reason: 'scheduler' });
        continue;
      }
      const job = await withTimeout(queue.getJob(id), 2_000).catch(() => undefined);
      if (!job) {
        skipped.push({ id, reason: 'not_found' });
        continue;
      }
      if (job.repeatJobKey || (job.opts as { repeat?: unknown }).repeat) {
        skipped.push({ id, reason: 'scheduler' });
        continue;
      }
      const state = (await withTimeout(job.getState(), 2_000).catch(() => 'unknown')) as string;
      if (!(allowed as readonly string[]).includes(state)) {
        skipped.push({ id, reason: 'wrong_state' });
        continue;
      }
      try {
        if (action === 'retry') await job.retry('failed');
        else await job.remove();
        done.push(id);
      } catch {
        skipped.push({ id, reason: 'wrong_state' }); // changed state between the check and the action (BullMQ refuses)
      }
    }
    await this.tenantContext.runInTenantContext({ organisationId: actor.organisationId, workspaceId: null, userId: actor.userId, role: '' }, (manager) =>
      recordAdminPanelAudit(this.audit, manager, actor, action === 'retry' ? ADMIN_PANEL_AUDIT_ACTION.QUEUE_JOBS_RETRIED : ADMIN_PANEL_AUDIT_ACTION.QUEUE_JOBS_DELETED, {
        metadata: { queue: def.name, count: done.length, jobIds: done, skipped: skipped.length, reason },
      }),
    );
    return { queue: def.name, done, skipped };
  }

  async onModuleDestroy(): Promise<void> {
    for (const queue of this.queues.values()) await queue.close().catch(() => undefined);
    await this.connection?.quit().catch(() => undefined);
  }
}

const METRICS_CACHE_MS = 30_000;
const MINUTE_MS = 60_000;
export const METRICS_RANGE_SPEC: Readonly<Record<AdminMetricsRange, { minutes: number; bucketMinutes: 1 | 60 }>> = Object.freeze({
  '1H': { minutes: 60, bucketMinutes: 1 },
  '4H': { minutes: 240, bucketMinutes: 60 },
  '12H': { minutes: 720, bucketMinutes: 60 },
  '1D': { minutes: 1_440, bucketMinutes: 60 },
  '7D': { minutes: WORKER_METRICS_MAX_DATA_POINTS, bucketMinutes: 60 },
});

/** One BullMQ metrics answer as `minute index -> count`. */
function perMinute(m: Metrics | null): { recorded: boolean; counts: Map<number, number> } {
  const counts = new Map<number, number>();
  const prevTS = Number(m?.meta?.prevTS ?? 0);
  if (!m || !Number.isFinite(prevTS) || prevTS <= 0) return { recorded: false, counts };
  // BullMQ collectMetrics.lua (1-minute granularity): jobs finished since the last flush are still counted in
  // `meta.count - meta.prevCount` and belong to prevTS's minute; `data[0]` is the minute BEFORE it and `data[i]` is i
  // minutes earlier (LPUSH, gaps filled with zeros). Nothing finished after prevTS's minute (that would have flushed).
  const prevMinute = Math.floor(prevTS / MINUTE_MS);
  const pending = Number(m.meta.count) - Number(m.meta.prevCount);
  if (Number.isFinite(pending) && pending > 0) counts.set(prevMinute, pending);
  const data = Array.isArray(m.data) ? m.data : [];
  for (let i = 0; i < data.length; i += 1) {
    const n = Number(data[i]);
    if (Number.isFinite(n) && n > 0) counts.set(prevMinute - 1 - i, n);
  }
  return { recorded: true, counts };
}

/**
 * Exported for its unit test. Buckets end with the CURRENT (partial) bucket: 1H = 60 one-minute buckets, the other ranges
 * one-hour buckets (4 / 12 / 24 / 168). Points outside the range are dropped; negative or non-numeric values are ignored.
 */
export function bucketQueueMetrics(queue: string, range: AdminMetricsRange, completed: Metrics | null, failed: Metrics | null, nowMs: number): AdminQueueMetrics {
  const spec = METRICS_RANGE_SPEC[range];
  const bucketMs = spec.bucketMinutes * MINUTE_MS;
  const count = Math.ceil(spec.minutes / spec.bucketMinutes);
  const lastStart = Math.floor(nowMs / bucketMs) * bucketMs;
  const firstStart = lastStart - (count - 1) * bucketMs;
  const buckets: AdminQueueMetricsBucket[] = Array.from({ length: count }, (_, i) => ({ at: new Date(firstStart + i * bucketMs).toISOString(), completed: 0, failed: 0 }));
  const c = perMinute(completed);
  const f = perMinute(failed);
  const place = (counts: Map<number, number>, field: 'completed' | 'failed') => {
    for (const [minute, n] of counts) {
      const index = Math.floor((minute * MINUTE_MS - firstStart) / bucketMs);
      if (index >= 0 && index < count) buckets[index]![field] += n;
    }
  };
  place(c.counts, 'completed');
  place(f.counts, 'failed');
  const recorded = c.recorded || f.recorded;
  return {
    queue,
    range,
    bucketMinutes: spec.bucketMinutes,
    from: new Date(firstStart).toISOString(),
    to: new Date(lastStart + bucketMs).toISOString(),
    available: recorded,
    reason: recorded ? null : 'NO_DATA',
    buckets,
    totals: { completed: buckets.reduce((sum, b) => sum + b.completed, 0), failed: buckets.reduce((sum, b) => sum + b.failed, 0) },
    generatedAt: new Date(nowMs).toISOString(),
  };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

/** One hash field per loop: JSON of numbers only. The `instance` field (host:pid) is never returned. */
export function parseCycles(source: 'worker' | 'provisioner', raw: Record<string, string> | null | undefined): AdminWorkerCycle[] {
  const out: AdminWorkerCycle[] = [];
  for (const [loop, value] of Object.entries(raw ?? {})) {
    if (!LOOP_KEY.test(loop) || typeof value !== 'string' || value.length > 2_000) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(value) as Record<string, unknown>;
    } catch {
      continue;
    }
    const at = num(parsed.at);
    out.push({
      source,
      loop,
      runs: num(parsed.n) ?? 0,
      p50Ms: num(parsed.p50),
      p95Ms: num(parsed.p95),
      maxMs: num(parsed.max),
      lastMs: num(parsed.lastMs),
      succeeded: num(parsed.succeeded) ?? 0,
      idle: num(parsed.idle) ?? 0,
      failed: num(parsed.failed) ?? 0,
      skipped: num(parsed.skipped) ?? 0,
      measuredAt: at ? new Date(at).toISOString() : null,
    });
  }
  return out.sort((a, b) => a.source.localeCompare(b.source) || a.loop.localeCompare(b.loop));
}

function ts(v: unknown): string | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? new Date(v).toISOString() : null;
}

export function toJobItem(job: Job, state: AdminJobState, def: Pick<QueueDefinition, 'idKeys'>): AdminJobItem {
  const data = (job.data && typeof job.data === 'object' ? job.data : {}) as Record<string, unknown>;
  const pick = (key: string) => (def.idKeys.includes(key) && isUuid(data[key]) ? (data[key] as string) : null);
  const name = typeof job.name === 'string' && /^[A-Za-z0-9:._-]{1,100}$/.test(job.name) ? job.name : 'job';
  return {
    id: String(job.id ?? ''),
    name,
    state,
    createdAt: ts(job.timestamp),
    processedAt: ts(job.processedOn),
    finishedAt: ts(job.finishedOn),
    attemptsMade: Number(job.attemptsMade ?? 0),
    maxAttempts: typeof job.opts?.attempts === 'number' ? job.opts.attempts : null,
    errorClass: state === 'failed' ? classifyFailure(job.failedReason) : null,
    organisationId: pick('organisationId'),
    entityId: pick('emailOutboxId') ?? pick('pushDeliveryId'),
    scheduler: Boolean(job.repeatJobKey) || String(job.id ?? '').startsWith('repeat:'),
  };
}
