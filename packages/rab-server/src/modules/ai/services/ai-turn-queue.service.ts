import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';

import { EnvironmentService } from '../../../engine/core-modules/environment/environment.service';
import { AI_TITLE_JOB_NAME, AiJobDataV2, AiResumeJobData, AiTitleJobData, AiTurnJobDataV2 } from '../../../engine/worker-shared/ai-jobs.contract';
import { AI_QUEUE_NAME, AI_TURN_JOB_NAME, aiTitleJobId, aiTurnJobId } from '../../../engine/worker-shared/ai-queue.constants';
import { enqueueRegisteredJob, RegisteredJob, registeredJob } from '../../../engine/worker-shared/queue-enqueue';
import { QUEUE_PRODUCER_REDIS_OPTIONS } from '../../../engine/worker-shared/queue-producer-connection';
import { bullmqJobOptionsOf } from '../../../engine/worker-shared/queue-registry';

/**
 * BullMQ options of every `rab-ai` job. attempts: 1 — a failed turn or title is never re-run automatically (the user
 * resubmits); a stalled job's second delivery finds the turn `running` with an expired lease and ends it
 * AI_WORKER_INTERRUPTED instead of calling the model again. Kept short in Redis: the turn row in PostgreSQL is the record.
 * D-Q1: read from the queue registry (attempts 1; retention since X3.4 is the shared QUEUE_RETENTION: 4 h / 1000
 * completed, 7 d / 1000 failed).
 */
export const AI_TURN_JOB_OPTIONS = Object.freeze(bullmqJobOptionsOf(AI_QUEUE_NAME));

export type AiJobIds = Pick<AiTurnJobDataV2, 'turnId' | 'conversationId' | 'organisationId' | 'workspaceId' | 'userId'>;

/**
 * D-Q1: the declared tenant scope of an AI job — the turn's own organisation (from the turn row / the caller's verified
 * AuthContext, never a client value). `registeredJob` refuses a payload whose organisationId differs from it.
 */
function scopeOf(ids: AiJobIds): { kind: 'organisation'; organisationId: string } {
  return { kind: 'organisation', organisationId: ids.organisationId };
}

/** The ONLY job payloads: identifiers, built field by field (never a spread of a caller object). */
export function turnJobData(ids: AiJobIds): AiTurnJobDataV2 {
  return { v: 2, kind: 'turn', turnId: ids.turnId, conversationId: ids.conversationId, organisationId: ids.organisationId, workspaceId: ids.workspaceId, userId: ids.userId };
}
/** 5b: the continuation turn after a decided proposal (job name `ai-turn`; the turn row itself carries the references). */
export function resumeJobData(ids: AiJobIds, ref: Pick<AiResumeJobData, 'pausedTurnId' | 'cause' | 'refId'>): AiResumeJobData {
  return { v: 2, kind: 'resume', turnId: ids.turnId, conversationId: ids.conversationId, organisationId: ids.organisationId, workspaceId: ids.workspaceId, userId: ids.userId, pausedTurnId: ref.pausedTurnId, cause: ref.cause, refId: ref.refId };
}
export function titleJobData(ids: AiJobIds): AiTitleJobData {
  return { v: 2, kind: 'title', turnId: ids.turnId, conversationId: ids.conversationId, organisationId: ids.organisationId, workspaceId: ids.workspaceId, userId: ids.userId };
}

/**
 * Producer of the `rab-ai` queue (legacy `bull` prefix, like rab-email / rab-push — PHASE1_PLAN §4.1), in `AiCoreModule`:
 * the API enqueues new turns and titles; the Worker enqueues only a queued successor's deferred claim and its promotion
 * (PHASE2_TWENTY_PLAN §2.1). Its own bounded connection: no offline queue and short timeouts, so an outage makes the
 * submit fail (503) at once instead of waiting; the caller then marks the turn failed and releases its reservations.
 */
@Injectable()
export class AiTurnQueueService implements OnModuleDestroy {
  private readonly connection: Redis;
  private readonly queue: Queue<AiJobDataV2>;

  constructor(env: EnvironmentService) {
    // Fail fast: exactly the four values of QUEUE_PRODUCER_REDIS_OPTIONS (D-Q1 reads them from there; unchanged).
    this.connection = new Redis(env.get('REDIS_URL'), { ...QUEUE_PRODUCER_REDIS_OPTIONS });
    this.connection.on('error', () => undefined);
    this.queue = new Queue<AiJobDataV2>(AI_QUEUE_NAME, { connection: this.connection });
    this.queue.on('error', () => undefined);
  }

  /** A new turn (submit): job id `ai-turn.<turnId>`, deduplicated. */
  async enqueue(ids: AiJobIds): Promise<void> {
    await this.enqueueTurn(ids);
  }

  /**
   * A turn job. `jobId` defaults to `ai-turn.<turnId>`; the Worker passes `ai-turn.<id>.w<n>` (deferred claim, with
   * `delayMs`) or `ai-turn.<id>.next` (promotion). Every id is deterministic, so a duplicate add is a no-op.
   */
  async enqueueTurn(ids: AiJobIds, opts: { jobId?: string; delayMs?: number } = {}): Promise<void> {
    await this.add(registeredJob(AI_QUEUE_NAME, AI_TURN_JOB_NAME, scopeOf(ids), turnJobData(ids), { jobId: opts.jobId ?? aiTurnJobId(ids.turnId), delayMs: opts.delayMs }));
  }

  /** 5b: the continuation turn job (id `ai-turn.<turnId>`, so a duplicate add is a no-op). */
  async enqueueResume(ids: AiJobIds, ref: Pick<AiResumeJobData, 'pausedTurnId' | 'cause' | 'refId'>): Promise<void> {
    await this.add(registeredJob(AI_QUEUE_NAME, AI_TURN_JOB_NAME, scopeOf(ids), resumeJobData(ids, ref), { jobId: aiTurnJobId(ids.turnId) }));
  }

  /** The conversation's title job: id `ai-title.<conversationId>`, so at most one ever. `turnId` = the first turn. */
  async enqueueTitle(ids: AiJobIds): Promise<void> {
    await this.add(registeredJob(AI_QUEUE_NAME, AI_TITLE_JOB_NAME, scopeOf(ids), titleJobData(ids), { jobId: aiTitleJobId(ids.conversationId) }));
  }

  private async add(job: RegisteredJob<typeof AI_QUEUE_NAME, AiJobDataV2>): Promise<void> {
    await enqueueRegisteredJob(this.queue, job);
  }

  /** Waiting/active/failed counts for the admin health view (metadata only). */
  async counts(): Promise<Record<string, number>> {
    return this.queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close().catch(() => undefined);
    await this.connection.quit().catch(() => this.connection.disconnect());
  }
}
