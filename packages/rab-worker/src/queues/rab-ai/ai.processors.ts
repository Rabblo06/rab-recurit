import { Optional } from '@nestjs/common';
import { Job } from 'bullmq';

import { AI_AGENT_RUN_JOB_NAME, AI_JOB_NAME_FOR_KIND, AI_TITLE_JOB_NAME, AiJobKind } from '@rab/server/engine/worker-shared/ai-jobs.contract';
import { AI_TURN_JOB_NAME } from '@rab/server/engine/worker-shared/ai-queue.constants';
import { AiRetentionService } from '@rab/server/modules/ai/services/ai-retention.service';
import { AiStaleTurnSweepService } from '@rab/server/modules/ai/services/ai-stale-turn-sweep.service';
import { AiTitleService } from '@rab/server/modules/ai/services/ai-title.service';
import { AiTurnRunnerService } from '@rab/server/modules/ai/services/ai-turn-runner.service';
import { withAdvisoryLock } from '../../core/locking/advisory-lock';
import { Process, Processor } from '../../core/scheduler/decorators';
import { CONSUMER_QUEUES, SCAN_QUEUES } from '../../core/scheduler/queue-registry';
import { WorkerDependencies } from '../../core/scheduler/worker-dependencies';

/** Session advisory lock: one replica runs AI retention at a time (the purge function is safe either way). */
export const AI_RETENTION_LOCK = 'crewflow:ai-retention:v1';

/** The kind a job's data claims: a Phase 1 v1 payload is a `turn`; null = unknown / malformed. */
export function aiJobKind(data: unknown): AiJobKind | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { v?: unknown; kind?: unknown };
  if (d.v === 1) return 'turn';
  if (d.v !== 2) return null;
  return d.kind === 'turn' || d.kind === 'title' || d.kind === 'resume' || d.kind === 'agent-run' ? d.kind : null;
}

/**
 * The `rab-ai` consumer (legacy `bull` prefix, concurrency 4). Every job on the queue reaches this one handler, which
 * dispatches on the BullMQ job NAME and refuses a job whose data `kind` does not belong to that name
 * (`AI_JOB_NAME_FOR_KIND`, fail closed):
 *   `ai-turn`  kind `turn` (or a Phase 1 v1 payload)  → the shared `AiTurnRunnerService` step loop
 *   `ai-title` kind `title`                          → `AiTitleService`
 *   `ai-turn`  kind `resume` (5b: the continuation after a decided proposal) → the same step loop (the turn row carries
 *              the references; the job's ids are lookup inputs only)
 *   `ai-agent-run` (Phase 6b, EX-3 not approved) → REFUSED: not supported yet, nothing read.
 * The payload is IDs only; the services re-read every row under RLS and rebuild authority from PostgreSQL. Never throws
 * for an expected outcome (a refused/failed turn is FINALISED, not retried — attempts: 1); `deferred` is a normal result
 * (the job completes; the successor's delayed job carries on).
 */
@Processor(CONSUMER_QUEUES.ai.name)
export class AiTurnConsumer {
  constructor(
    private readonly runner: AiTurnRunnerService,
    private readonly titles: AiTitleService,
  ) {}

  @Process(CONSUMER_QUEUES.ai.jobName)
  async turn(job: Job<unknown>): Promise<string> {
    const kind = aiJobKind(job.data);
    if (job.name === AI_AGENT_RUN_JOB_NAME || kind === 'agent-run') return 'refused';
    if (!kind || AI_JOB_NAME_FOR_KIND[kind] !== job.name) return 'skipped';
    if (job.name === AI_TURN_JOB_NAME) return this.runner.run(job.data as Parameters<AiTurnRunnerService['run']>[0]);
    if (job.name === AI_TITLE_JOB_NAME) return this.titles.run(job.data);
    return 'skipped';
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
    // Phase D-Q2. Always provided by AiWorkerCoreModule in the Worker graph; optional so existing unit constructions
    // keep compiling (absent ⇒ the sweep does nothing).
    @Optional() private readonly staleTurns?: AiStaleTurnSweepService,
  ) {}

  /**
   * Phase D-Q2 (AI_STALE_TURN_SWEEP, default false ⇒ not scheduled; `false` here too as defence in depth): finalises AI
   * turns stuck `queued` past AI_STALE_TURN_THRESHOLD_MINUTES (their BullMQ job was lost) as failed AI_WORKER_INTERRUPTED.
   * Never re-runs or requeues. Runtime connection (RLS), per-user tenant context, compare-and-set per turn — safe with
   * several replicas without a lock (the CAS lets exactly one finalise each turn).
   */
  @Process('ai-stale-turn-sweep')
  async aiStaleTurnSweep(): Promise<boolean> {
    if (!this.staleTurns) return false;
    const { runtimeDataSource, logger } = this.deps.get();
    const r = await this.staleTurns.runCycle(runtimeDataSource);
    if (!r.ran) return false;
    if (r.finalised > 0 || r.skipped > 0) {
      logger.log(`ai stale-turn sweep: workspaces=${r.workspaces} users=${r.users} candidates=${r.candidates} finalised=${r.finalised} skipped=${r.skipped}`);
    }
    return r.finalised > 0;
  }

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
