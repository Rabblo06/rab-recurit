import { Process, Processor } from '../../core/scheduler/decorators';
import { SCAN_QUEUES } from '../../core/scheduler/queue-registry';
import { WorkerDependencies } from '../../core/scheduler/worker-dependencies';
import { runManagerConfirmationTimeoutCycle, runOfferExpiryCycle } from './offer-expiry.job';
import { runReplacementStaffCycle } from './replacement-staff.job';

/** Thin adapters — the pre-migration main.ts loop bodies, verbatim (see rab-email/email.processors.ts). */
@Processor(SCAN_QUEUES.offers)
export class OfferScanProcessor {
  constructor(private readonly deps: WorkerDependencies) {}

  @Process('offer-expiry')
  async offerExpiry(): Promise<void> {
    const { runtimeDataSource, tenantContext, notificationService, auditService, logger } = this.deps.get();
    const result = await runOfferExpiryCycle(runtimeDataSource, tenantContext, notificationService, auditService);
    if (result.expired) logger.log(`offer expiry: expired=${result.expired}`);
  }

  @Process('manager-confirmation-timeout')
  async managerConfirmationTimeout(): Promise<void> {
    const { runtimeDataSource, tenantContext, notificationService, auditService, realtimeEventService, environmentService, logger } = this.deps.get();
    const result = await runManagerConfirmationTimeoutCycle(
      runtimeDataSource,
      tenantContext,
      notificationService,
      auditService,
      realtimeEventService,
      environmentService.get('MANAGER_CONFIRMATION_TIMEOUT_MINUTES'),
    );
    if (result.confirmed) logger.log(`manager confirmation timeout: confirmed=${result.confirmed}`);
  }

  @Process('replacement-staff')
  async replacementStaff(): Promise<void> {
    const { runtimeDataSource, tenantContext, notificationService, auditService, logger } = this.deps.get();
    const result = await runReplacementStaffCycle(runtimeDataSource, tenantContext, notificationService, auditService);
    if (result.created) logger.log(`replacement staff: created=${result.created} noCandidates=${result.noCandidates}`);
  }
}
