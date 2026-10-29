import { Process, Processor } from '../../core/scheduler/decorators';
import { SCAN_QUEUES } from '../../core/scheduler/queue-registry';
import { WorkerDependencies } from '../../core/scheduler/worker-dependencies';
import { runRealtimeOutboxPublishCycle } from './publish-outbox.job';

/**
 * Thin adapter — the pre-migration main.ts loop body, verbatim (see rab-email/email.processors.ts). Stage 2 Redis
 * Pub/Sub distribution for the durable outbox (`core.realtime_event`), `runtimeDataSource` only (crewflow_app).
 */
@Processor(SCAN_QUEUES.realtime)
export class RealtimeScanProcessor {
  constructor(private readonly deps: WorkerDependencies) {}

  @Process('realtime-outbox-publish')
  async realtimeOutboxPublish(): Promise<boolean> {
    const { runtimeDataSource, tenantContext, realtimePublish, environmentService, logger } = this.deps.get();
    // Phase A gating (defence in depth — the scheduler should not register this job at all when realtime is off): with
    // REALTIME_ENABLED=false no SSE client can be subscribed and the API writes no `core.realtime_event` rows, so the
    // cycle would only enumerate every organisation/workspace and claim nothing. Return idle BEFORE any SQL or Redis
    // call. Rows left `pending`/`processing` from before a flip to off are not touched; they are published (at most
    // `perScopeLimit` per scope per cycle, unchanged) once REALTIME_ENABLED is true again.
    if (!environmentService.get('REALTIME_ENABLED')) return false;
    const result = await runRealtimeOutboxPublishCycle(runtimeDataSource, tenantContext, realtimePublish, environmentService.get('NODE_ENV'));
    if (result.claimed) {
      logger.log(`realtime outbox publish: claimed=${result.claimed} published=${result.published} invalid=${result.invalid} retried=${result.retried} failed=${result.failed}`);
    }
    return Boolean(result.claimed);
  }
}
