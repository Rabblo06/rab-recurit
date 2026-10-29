import { Job } from 'bullmq';

import { PushQueueJobData } from '@rab/server/engine/core-modules/push/push-queue.constants';
import { Process, Processor } from '../../core/scheduler/decorators';
import { CONSUMER_QUEUES, SCAN_QUEUES } from '../../core/scheduler/queue-registry';
import { WorkerDependencies } from '../../core/scheduler/worker-dependencies';
import { runPushDispatchCycle } from './push-dispatch.job';
import { createPushSendProcessor } from './push-send.processor';

/** Thin adapters — the pre-migration main.ts loop body, verbatim (see rab-email/email.processors.ts). */
@Processor(SCAN_QUEUES.push)
export class PushScanProcessor {
  constructor(private readonly deps: WorkerDependencies) {}

  @Process('push-dispatch')
  async pushDispatch(): Promise<boolean> {
    const { runtimeDataSource, tenantContext, pushQueue, pushService, environmentService, logger } = this.deps.get();
    // Phase A gating (defence in depth — the scheduler should not register this job at all when push is off): with
    // PUSH_ENABLED=false `PushDeliveryService` creates no `core.push_delivery` rows, so the cycle would only walk every
    // organisation and claim nothing. Return idle BEFORE any SQL or queue call. Rows left PENDING/RETRY/PROCESSING from
    // before a flip to off are not touched; they are dispatched (BATCH_SIZE per organisation per cycle, unchanged) once
    // PUSH_ENABLED is true again. The `rab-push` send consumer is deliberately NOT gated: it polls nothing and only acts
    // on jobs this dispatcher already enqueued.
    if (!environmentService.get('PUSH_ENABLED')) return false;
    const result = await runPushDispatchCycle(
      runtimeDataSource,
      tenantContext,
      (id, orgId) => pushQueue.publish(id, orgId),
      (id, orgId, generation) => pushQueue.republish(id, orgId, generation),
      pushService.ambiguousDeliverySafeToRetry,
    );
    if (result.claimed) logger.log(`push dispatch: claimed=${result.claimed} published=${result.published} recovered=${result.recovered} deliveryUncertain=${result.deliveryUncertain}`);
    return Boolean(result.claimed);
  }
}

/** The existing `rab-push` consumer (legacy `bull` prefix, concurrency 10): the same processor function as before. */
@Processor(CONSUMER_QUEUES.push.name)
export class PushSendConsumer {
  private processor?: ReturnType<typeof createPushSendProcessor>;

  constructor(private readonly deps: WorkerDependencies) {}

  @Process(CONSUMER_QUEUES.push.jobName)
  async send(job: Job<PushQueueJobData>): Promise<void> {
    if (!this.processor) {
      const { tenantContext, pushService, secretEncryptionService, pushDeviceService } = this.deps.get();
      this.processor = createPushSendProcessor({ tenantContext, pushService, secretEncryption: secretEncryptionService, pushDeviceService });
    }
    return this.processor(job);
  }
}
