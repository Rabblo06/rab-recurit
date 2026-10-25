import { ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
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
import { CONSUMER_QUEUES, LEGACY_BULL_PREFIX, SCAN_QUEUE_NAMES } from '../../worker-shared/queue-registry';
import { assertActivePlatformAdmin, isUuid, refuseInspection, requireReason, withTimeout } from './admin-actor';
import { ADMIN_PANEL_AUDIT_ACTION, recordAdminPanelAudit } from './admin-panel-audit-actions';
import { AdminJobState, JOB_ID_PATTERN } from './dto/admin-panel.dto';
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
  /** BullMQ metrics are not enabled on any Worker (owner decision pending) — the chart has no data source. */
  metrics: { available: false; reason: 'WORKER_METRICS_DISABLED' };
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
      metrics: { available: false, reason: 'WORKER_METRICS_DISABLED' },
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
    await this.stepUp.assertRecentStepUp(actor);

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
