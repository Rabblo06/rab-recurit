import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';

import { EnvironmentService } from '../../../engine/core-modules/environment/environment.service';
import { AI_QUEUE_NAME, AI_TURN_JOB_NAME, AiTurnJobData, aiTurnJobId } from '../../../engine/worker-shared/ai-queue.constants';

/**
 * BullMQ options of an `ai-turn` job. attempts: 1 — a failed turn is never re-run automatically (the user resubmits);
 * a stalled job's second delivery finds the turn `running` with an expired lease and ends it AI_WORKER_INTERRUPTED
 * instead of calling the model again. Kept short in Redis: the turn row in PostgreSQL is the record.
 */
export const AI_TURN_JOB_OPTIONS = Object.freeze({
  attempts: 1,
  removeOnComplete: Object.freeze({ age: 3600, count: 1000 }),
  removeOnFail: Object.freeze({ age: 7 * 24 * 3600, count: 5000 }),
});

/**
 * API-side producer of the `rab-ai` queue (legacy `bull` prefix, like rab-email / rab-push — PHASE1_PLAN §4.1). Its own
 * bounded connection: no offline queue and short timeouts, so an outage makes the submit fail (503) at once instead of
 * waiting; the caller then marks the turn failed and releases its reservations.
 */
@Injectable()
export class AiTurnQueueService implements OnModuleDestroy {
  private readonly connection: Redis;
  private readonly queue: Queue<AiTurnJobData>;

  constructor(env: EnvironmentService) {
    this.connection = new Redis(env.get('REDIS_URL'), { enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 2_000, commandTimeout: 3_000 });
    this.connection.on('error', () => undefined);
    this.queue = new Queue<AiTurnJobData>(AI_QUEUE_NAME, { connection: this.connection });
    this.queue.on('error', () => undefined);
  }

  async enqueue(data: Omit<AiTurnJobData, 'v'>): Promise<void> {
    const payload: AiTurnJobData = { v: 1, turnId: data.turnId, conversationId: data.conversationId, organisationId: data.organisationId, workspaceId: data.workspaceId, userId: data.userId };
    await this.queue.add(AI_TURN_JOB_NAME, payload, { jobId: aiTurnJobId(data.turnId), ...AI_TURN_JOB_OPTIONS });
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
