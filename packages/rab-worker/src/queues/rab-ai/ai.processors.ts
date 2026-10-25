import { Job } from 'bullmq';

import type { AiTurnJobData } from '@rab/server/engine/worker-shared/ai-queue.constants';
import { AiRetentionService } from '@rab/server/modules/ai/services/ai-retention.service';
import { AiTurnRunnerService } from '@rab/server/modules/ai/services/ai-turn-runner.service';
import { withAdvisoryLock } from '../../core/locking/advisory-lock';
import { Process, Processor } from '../../core/scheduler/decorators';
import { CONSUMER_QUEUES, SCAN_QUEUES } from '../../core/scheduler/queue-registry';
import { WorkerDependencies } from '../../core/scheduler/worker-dependencies';

/** Session advisory lock: one replica runs AI retention at a time (the purge function is safe either way). */
export const AI_RETENTION_LOCK = 'crewflow:ai-retention:v1';

/**
 * AI Phase 1 — the `rab-ai` consumer (legacy `bull` prefix, concurrency 4, job `ai-turn`). A thin adapter: the job's
 * payload is IDs only and is handed to the shared `AiTurnRunnerService` step loop (rab-server `modules/ai`), which
 * re-reads the turn under RLS, rebuilds the caller's authority from PostgreSQL and is idempotent across redeliveries.
 * Never throws for an expected outcome (a refused/failed turn is FINALISED, not retried — attempts: 1).
 */
@Processor(CONSUMER_QUEUES.ai.name)
export class AiTurnConsumer {
  constructor(private readonly runner: AiTurnRunnerService) {}

  @Process(CONSUMER_QUEUES.ai.jobName)
  async turn(job: Job<AiTurnJobData>): Promise<string> {
    return this.runner.run(job.data);
  }
}

/**
 * AI conversation retention scan (maintenance queue, every AI_RETENTION_INTERVAL_MINUTES). OFF by default
 * (AI_RETENTION_MODE=off → returns false, never stamped as a run); `report` counts, `purge` deletes through the
 * authorised `core.ai_purge_expired_conversations`, one organisation at a time, under one cross-replica advisory lock.
 */
@Processor(SCAN_QUEUES.maintenance)
export class AiMaintenanceProcessor {
  constructor(
    private readonly deps: WorkerDependencies,
    private readonly retention: AiRetentionService,
  ) {}

  @Process('ai-retention')
  async aiRetention(): Promise<boolean> {
    const { runtimeDataSource, directDataSource, environmentService: env, logger } = this.deps.get();
    const mode = env.get('AI_RETENTION_MODE');
    if (mode === 'off') return false;
    const locked = await withAdvisoryLock(directDataSource, AI_RETENTION_LOCK, () => this.retention.runCycle(runtimeDataSource, mode));
    if (!locked.acquired) return false;
    const r = locked.value;
    logger.log(`ai retention (${r.mode}): organisations=${r.organisations} conversations=${r.conversations} truncated=${r.truncated}`);
    return r.ran;
  }
}
