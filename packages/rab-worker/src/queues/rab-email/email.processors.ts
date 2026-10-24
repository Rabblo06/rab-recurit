import { Job } from 'bullmq';

import { EmailQueueJobData } from '@rab/server/engine/core-modules/email/email-queue.constants';
import { Process, Processor } from '../../core/scheduler/decorators';
import { CONSUMER_QUEUES, SCAN_QUEUES } from '../../core/scheduler/queue-registry';
import { WorkerDependencies } from '../../core/scheduler/worker-dependencies';
import { runEmailDispatchCycle } from './email-dispatch.job';
import { createEmailSendProcessor } from './email-send.processor';

/**
 * Thin adapters (BullMQ migration, Lane A M3): each method is the pre-migration main.ts loop body, verbatim — the SAME
 * `run*Cycle` call with the SAME arguments, the same log line and the same return value (`false` = do not stamp
 * lastRunAt). Used by BOTH scheduler modes: interval mode's `runtime.every()` and bullmq mode's scan-queue consumer call
 * these exact methods, so the two modes cannot drift apart.
 */
@Processor(SCAN_QUEUES.email)
export class EmailScanProcessor {
  constructor(private readonly deps: WorkerDependencies) {}

  @Process('email-dispatch')
  async emailDispatch(): Promise<boolean> {
    const { runtimeDataSource, tenantContext, emailQueue, emailService, logger } = this.deps.get();
    const result = await runEmailDispatchCycle(
      runtimeDataSource,
      tenantContext,
      (id, orgId) => emailQueue.publish(id, orgId),
      (id, orgId, generation) => emailQueue.republish(id, orgId, generation),
      emailService.ambiguousDeliverySafeToRetry,
    );
    if (result.claimed) logger.log(`email dispatch: claimed=${result.claimed} published=${result.published} recovered=${result.recovered} deliveryUncertain=${result.deliveryUncertain}`);
    return Boolean(result.claimed); // only stamps lastEmailDispatchAt when it actually claimed rows
  }
}

/** The existing `rab-email` consumer (legacy `bull` prefix, concurrency 5): the same processor function as before. */
@Processor(CONSUMER_QUEUES.email.name)
export class EmailSendConsumer {
  private processor?: ReturnType<typeof createEmailSendProcessor>;

  constructor(private readonly deps: WorkerDependencies) {}

  @Process(CONSUMER_QUEUES.email.jobName)
  async send(job: Job<EmailQueueJobData>): Promise<void> {
    if (!this.processor) {
      const { tenantContext, emailService, auditService, fileService } = this.deps.get();
      this.processor = createEmailSendProcessor({ tenantContext, emailService, auditService, fileService });
    }
    return this.processor(job);
  }
}
