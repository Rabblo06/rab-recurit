import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { EntityManager } from 'typeorm';
import { DataSource } from 'typeorm';

import { EMAIL_QUEUE_NAME } from '../email/email-queue.constants';
import { EmailQueueService } from '../email/email-queue.service';
import { EnvironmentService } from '../environment/environment.service';
import { PUSH_QUEUE_NAME } from '../push/push-queue.constants';
import { AuthContext } from '../tenant/auth-context.interface';
import { TenantContextService } from '../tenant/tenant-context.service';
import { ThrottlerRedisClientProvider } from '../throttler/throttler-redis-client.provider';
import { organisationIds, storageScopes } from '../../worker-shared/maintenance-catalogue';
import { WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_TTL_SECONDS, WORKER_STATS_KEY } from '../../worker-shared/heartbeat.constants';
import { OutboxKind } from './dto/outbox-operations.dto';
import { PlatformAdminService } from './platform-admin.service';

/**
 * One FAILED outbox/event row as an operator may see it: identifiers, type, counters, error CODE and timestamps.
 * Never a body, subject, recipient address, payload, token, provider message id or sanitised error text.
 */
export interface FailedOutboxItem {
  kind: OutboxKind;
  id: string;
  organisationId: string;
  workspaceId: string | null;
  type: string | null;
  attempts: number;
  lastErrorCode: string | null;
  failedAt: string | null;
  createdAt: string;
  /** email only: whether a replay is possible at all (body still present and delivery not uncertain). */
  replayable?: boolean;
  /** email only: the row's dispatch generation (replay bumps it). */
  dispatchGeneration?: number;
}

export type ReplayResult = 'REPLAYED' | 'NOT_FOUND' | 'NO_BODY' | 'UNCERTAIN';

export interface QueueHealth {
  queues: Array<{ name: string; counts: Record<string, number> | null; error?: string }>;
  worker: { heartbeatAgeSeconds: number | null; stale: boolean; stats: Record<string, string> };
}

const DEFAULT_LIMIT = 50;
/** BullMQ queues the engine owns (statements live in the payroll module; their loop stats are in the worker stats hash). */
const OBSERVED_QUEUES = [EMAIL_QUEUE_NAME, PUSH_QUEUE_NAME];
const JOB_STATES = ['waiting', 'active', 'delayed', 'completed', 'failed', 'paused', 'prioritized', 'waiting-children'] as const;

interface ScopedQuery {
  kind: OutboxKind;
  workspaceTagged: boolean;
  sql: string;
}

// Column lists are explicit: no body/subject/recipient/payload/token/provider-id/error-message column is ever selected.
const FAILED_QUERIES: readonly ScopedQuery[] = [
  {
    kind: 'email',
    workspaceTagged: false,
    sql: `SELECT id, organisation_id, workspace_id, job_type AS type, infrastructure_attempt_count AS attempts, last_error_code,
                 failed_at, created_at, dispatch_generation,
                 (rendered_html IS NOT NULL OR rendered_text IS NOT NULL) AS has_body
            FROM core.email_outbox WHERE status = 'FAILED' ORDER BY failed_at DESC NULLS LAST, id LIMIT $1`,
  },
  {
    kind: 'push',
    workspaceTagged: false,
    sql: `SELECT id, organisation_id, NULL::uuid AS workspace_id, 'PUSH'::text AS type, attempt_count AS attempts, last_error_code,
                 failed_at, created_at
            FROM core.push_delivery WHERE status = 'FAILED' ORDER BY failed_at DESC NULLS LAST, id LIMIT $1`,
  },
  {
    kind: 'realtime',
    workspaceTagged: true,
    sql: `SELECT id, organisation_id, workspace_id, event_type AS type, attempt_count AS attempts, last_error_code,
                 last_error_at AS failed_at, created_at
            FROM core.realtime_event WHERE status = 'failed' AND workspace_id IS NOT DISTINCT FROM core.current_workspace()
           ORDER BY last_error_at DESC NULLS LAST, id LIMIT $1`,
  },
  {
    kind: 'worker_event',
    workspaceTagged: true,
    sql: `SELECT id, organisation_id, workspace_id, event_type AS type, attempt_count AS attempts, last_error_code,
                 last_error_at AS failed_at, created_at
            FROM core.worker_event WHERE status = 'failed' AND workspace_id IS NOT DISTINCT FROM core.current_workspace()
           ORDER BY last_error_at DESC NULLS LAST, id LIMIT $1`,
  },
];

/**
 * Wave 5 lane OPS — failed-outbox inspection, audited FAILED-email replay and queue observability for platform admins.
 *
 * Layers: `JwtAuthGuard` + `PlatformAdminGuard` on the controller (1); `assertPlatformAdmin` HERE, because the
 * `outbox:replay` CLI and any future caller reach this service without a guard (2); every read/replay runs inside
 * `TenantContextService` bound to the TARGET organisation (and workspace, for workspace-tagged event rows) with the
 * acting admin's user id (3/4: FORCE RLS on all four tables); the replay itself is lane DB5's
 * `core.replay_failed_email` (SECURITY INVOKER), which re-checks status = FAILED under the row lock, refuses a
 * scrubbed (token-bearing) body and a DELIVERY_UNCERTAIN row, moves the row to RETRY with `dispatch_generation + 1` and
 * writes the `email.replay_requested` audit row in the same transaction (actor = `core.current_uid()`).
 *
 * EXACTLY ONCE: the function moves FAILED -> RETRY at most once per failure (a second call sees RETRY -> NOT_FOUND);
 * this service publishes the row once under the bumped generation's jobId after the commit (the dispatcher's stale-RETRY
 * recovery is the backstop); the send processor's PROCESSING compare-and-set lets only one job send. Concurrency of two admins
 * clicking replay together: one REPLAYED, one NOT_FOUND (404).
 *
 * A platform admin selects the TARGET organisation explicitly (the same model as organisation suspension); that id is
 * a target selector authorised by platform-admin status, never the caller's tenant context.
 */
@Injectable()
export class OutboxOperationsService implements OnModuleDestroy {
  private readonly logger = new Logger(OutboxOperationsService.name);
  private queueConnection: Redis | null = null;
  private readonly queues = new Map<string, Queue>();

  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
    private readonly platformAdmin: PlatformAdminService,
    private readonly env: EnvironmentService,
    private readonly redis: ThrottlerRedisClientProvider,
    private readonly emailQueue: EmailQueueService,
  ) {}

  private async assertPlatformAdmin(actor: Pick<AuthContext, 'userId'>): Promise<void> {
    let allowed = false;
    try {
      allowed = Boolean(actor.userId) && (await this.platformAdmin.isPlatformAdmin(actor));
    } catch {
      allowed = false; // fail closed
    }
    if (!allowed) throw new ForbiddenException('You do not have access to this. Ask an administrator if you need it.');
  }

  private inScope<T>(actor: Pick<AuthContext, 'userId'>, organisationId: string, workspaceId: string | null, fn: (m: EntityManager) => Promise<T>): Promise<T> {
    return this.tenantContext.runInTenantContext({ organisationId, workspaceId, userId: actor.userId, role: '' }, fn);
  }

  // ---------------------------------------------------------------------------------------------- failed listing

  async listFailed(
    actor: Pick<AuthContext, 'userId'>,
    query: { kind?: OutboxKind; organisationId?: string; limit?: number },
  ): Promise<FailedOutboxItem[]> {
    await this.assertPlatformAdmin(actor);
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), 200);
    const specs = FAILED_QUERIES.filter((q) => !query.kind || q.kind === query.kind);
    const items: FailedOutboxItem[] = [];
    for await (const scope of storageScopes(this.dataSource)) {
      if (query.organisationId && scope.organisationId !== query.organisationId) continue;
      const scoped = specs.filter((s) => scope.workspaceId === null || s.workspaceTagged);
      if (scoped.length === 0) continue;
      const rows = await this.inScope(actor, scope.organisationId, scope.workspaceId, async (manager) => {
        await manager.query('SET TRANSACTION READ ONLY');
        const out: FailedOutboxItem[] = [];
        for (const spec of scoped) {
          const result: Array<Record<string, unknown>> = await manager.query(spec.sql, [limit]);
          for (const r of result) out.push(toItem(spec.kind, r));
        }
        return out;
      });
      items.push(...rows);
      if (items.length >= limit * 4) break; // bounded scan; operators narrow with kind/organisationId
    }
    return items.sort((a, b) => (b.failedAt ?? '').localeCompare(a.failedAt ?? '') || a.id.localeCompare(b.id)).slice(0, limit);
  }

  // ---------------------------------------------------------------------------------------------- replay

  /** Raw outcome (no HTTP mapping) — used by the CLI. */
  async replayFailedEmailRaw(
    actor: Pick<AuthContext, 'userId'>,
    organisationId: string,
    emailId: string,
    options: { allowUncertain?: boolean } = {},
  ): Promise<ReplayResult> {
    await this.assertPlatformAdmin(actor);
    const { result, generation } = await this.inScope(actor, organisationId, null, async (manager) => {
      const rows: Array<{ r: string }> = await manager.query('SELECT core.replay_failed_email($1::uuid, $2::boolean) AS r', [
        emailId,
        options.allowUncertain === true,
      ]);
      const r = rows[0]?.r as ReplayResult | undefined;
      if (r !== 'REPLAYED') return { result: r, generation: null };
      const gen: Array<{ g: number }> = await manager.query('SELECT dispatch_generation AS g FROM core.email_outbox WHERE id = $1', [emailId]);
      return { result: r, generation: gen[0] ? Number(gen[0].g) : null };
    });
    if (result !== 'REPLAYED' && result !== 'NOT_FOUND' && result !== 'NO_BODY' && result !== 'UNCERTAIN') {
      throw new Error('replay_failed_email returned an unexpected result'); // fail closed on a contract change
    }
    // DB5's function leaves the row in RETRY with a bumped generation; the dispatcher would only republish it after its
    // 5-minute RETRY staleness window. Publish now, AFTER the commit, under that new generation's jobId (never used by an
    // earlier attempt, so BullMQ cannot dedupe it against the old failed job). If this publish fails the dispatcher's
    // recovery still sends it later; if both run, the processor's PROCESSING compare-and-set lets exactly one send.
    if (result === 'REPLAYED' && generation !== null) {
      await this.emailQueue.republish(emailId, organisationId, generation).catch((error: Error) => {
        this.logger.warn(`email replay: immediate publish failed (the dispatcher recovers it): ${error.message}`);
      });
    }
    this.logger.log(`email replay ${result}: organisation=${organisationId} email=${emailId} actor=${actor.userId}`);
    return result;
  }

  /** HTTP mapping: REPLAYED 200; NOT_FOUND 404 (absent / other tenant / not FAILED — indistinguishable); NO_BODY / UNCERTAIN 409. */
  async replayFailedEmail(
    actor: Pick<AuthContext, 'userId'>,
    organisationId: string,
    emailId: string,
    options: { allowUncertain?: boolean } = {},
  ): Promise<{ result: 'REPLAYED' }> {
    const result = await this.replayFailedEmailRaw(actor, organisationId, emailId, options);
    if (result === 'NOT_FOUND') throw new NotFoundException('Failed email not found.');
    if (result === 'NO_BODY') {
      throw new ConflictException({ code: 'NO_BODY', message: 'This email carried a one-time link and its body was cleared. Ask the user to request a new link.' });
    }
    if (result === 'UNCERTAIN') {
      throw new ConflictException({ code: 'DELIVERY_UNCERTAIN', message: 'The provider may already have sent this email. Replay only with allowUncertain=true.' });
    }
    return { result };
  }

  /** CLI helper: find which organisation holds `emailId` among the FAILED rows the admin can replay (ids only). */
  async *organisationsForCli(): AsyncGenerator<string> {
    yield* organisationIds(this.dataSource);
  }

  // ---------------------------------------------------------------------------------------------- queue observability

  async queueHealth(actor: Pick<AuthContext, 'userId'>): Promise<QueueHealth> {
    await this.assertPlatformAdmin(actor);
    const queues: QueueHealth['queues'] = [];
    for (const name of OBSERVED_QUEUES) {
      try {
        const counts = await withTimeout(this.queue(name).getJobCounts(...JOB_STATES), 2_000);
        queues.push({ name, counts });
      } catch (error) {
        queues.push({ name, counts: null, error: 'unavailable' });
        this.logger.debug(`queue counts for ${name} failed: ${(error as Error).message}`);
      }
    }
    let heartbeatAgeSeconds: number | null = null;
    let stats: Record<string, string> = {};
    try {
      const [beat, rawStats] = await Promise.all([this.redis.client.get(WORKER_HEARTBEAT_KEY), this.redis.client.hgetall(WORKER_STATS_KEY)]);
      heartbeatAgeSeconds = beat ? Math.max(0, Math.round((Date.now() - Number(beat)) / 1000)) : null;
      // Loop timestamps and failure counters only (the hash holds nothing else); values are numbers/short labels.
      stats = Object.fromEntries(Object.entries(rawStats ?? {}).filter(([k, v]) => /^[A-Za-z0-9_]{1,64}$/.test(k) && String(v).length <= 64));
    } catch {
      // Redis down: report unknown, never throw from a health read.
    }
    return { queues, worker: { heartbeatAgeSeconds, stale: heartbeatAgeSeconds === null || heartbeatAgeSeconds > WORKER_HEARTBEAT_TTL_SECONDS, stats } };
  }

  private queue(name: string): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      this.queueConnection ??= new Redis(this.env.get('REDIS_URL'), { maxRetriesPerRequest: null, connectTimeout: 1_000, lazyConnect: true });
      this.queueConnection.on('error', () => undefined);
      queue = new Queue(name, { connection: this.queueConnection });
      this.queues.set(name, queue);
    }
    return queue;
  }

  async onModuleDestroy(): Promise<void> {
    for (const queue of this.queues.values()) await queue.close().catch(() => undefined);
    await this.queueConnection?.quit().catch(() => undefined);
  }
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function toItem(kind: OutboxKind, r: Record<string, unknown>): FailedOutboxItem {
  const item: FailedOutboxItem = {
    kind,
    id: String(r.id),
    organisationId: String(r.organisation_id),
    workspaceId: (r.workspace_id as string | null) ?? null,
    type: (r.type as string | null) ?? null,
    attempts: Number(r.attempts ?? 0),
    lastErrorCode: (r.last_error_code as string | null) ?? null,
    failedAt: iso(r.failed_at),
    createdAt: iso(r.created_at)!,
  };
  if (kind === 'email') {
    item.dispatchGeneration = Number(r.dispatch_generation ?? 0);
    item.replayable = r.has_body === true && item.lastErrorCode !== 'DELIVERY_UNCERTAIN';
  }
  return item;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => timer && clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    }),
  ]);
}
