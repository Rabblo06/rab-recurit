import { Process, Processor } from '../../core/scheduler/decorators';
import { SCAN_QUEUES } from '../../core/scheduler/queue-registry';
import { WorkerDependencies } from '../../core/scheduler/worker-dependencies';
import { runConfirmationDeadlineBackstopScan, runManagerConfirmationDeadlineCycle, runOfferExpiryCycle } from './offer-expiry.job';
import { runReplacementStaffCycle } from './replacement-staff.job';

/** Thin adapters — the pre-migration main.ts loop bodies, verbatim (see rab-email/email.processors.ts). */
@Processor(SCAN_QUEUES.offers)
export class OfferScanProcessor {
  constructor(private readonly deps: WorkerDependencies) {}

  @Process('offer-expiry')
  async offerExpiry(): Promise<void> {
    const { runtimeDataSource, tenantContext, notificationService, auditService, realtimeEventService, logger } = this.deps.get();
    const result = await runOfferExpiryCycle(runtimeDataSource, tenantContext, notificationService, auditService, realtimeEventService);
    if (result.expired) logger.log(`offer expiry: expired=${result.expired}`);
  }

  /**
   * The scan job keeps its historical name (queue-registry pins); it now runs the manager-confirmation DEADLINE: the
   * due-work pointer cycle, then the backstop scan for offers without a pointer. It withdraws; it never confirms.
   */
  @Process('manager-confirmation-timeout')
  async managerConfirmationTimeout(): Promise<void> {
    const { runtimeDataSource, tenantContext, notificationService, auditService, realtimeEventService, logger } = this.deps.get();
    const pointer = await runManagerConfirmationDeadlineCycle(runtimeDataSource, tenantContext, notificationService, auditService, realtimeEventService);
    const scan = await runConfirmationDeadlineBackstopScan(runtimeDataSource, tenantContext, notificationService, auditService, realtimeEventService);
    if (pointer.withdrawn || scan.withdrawn) logger.log(`manager confirmation deadline: withdrawn=${pointer.withdrawn + scan.withdrawn} (pointer=${pointer.withdrawn} scan=${scan.withdrawn})`);
  }

  @Process('replacement-staff')
  async replacementStaff(): Promise<void> {
    const { runtimeDataSource, tenantContext, notificationService, auditService, logger } = this.deps.get();
    const result = await runReplacementStaffCycle(runtimeDataSource, tenantContext, notificationService, auditService);
    if (result.created) logger.log(`replacement staff: created=${result.created} noCandidates=${result.noCandidates}`);
  }
}
