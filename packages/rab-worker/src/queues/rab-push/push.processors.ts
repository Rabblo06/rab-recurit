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
    const { runtimeDataSource, tenantContext, pushQueue, pushService, logger } = this.deps.get();
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
