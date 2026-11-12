import { Job } from 'bullmq';

import { createSecurityAuditSink, SecurityAuditSink, securityAuditSinkConfig } from '@rab/server/engine/core-modules/audit-sink/security-audit-sink';
import { runScopedForOrg } from '../../core/database/scoped-job';
import { Process, Processor } from '../../core/scheduler/decorators';
import { CONSUMER_QUEUES } from '../../core/scheduler/queue-registry';
import { WorkerDependencies } from '../../core/scheduler/worker-dependencies';
import { AUDIT_PREAUTH_JOB_NAME } from '@rab/server/engine/worker-shared/audit-event.contract';
import { AuditEventShipOutcome, readAuditRowForShipping, shipAuditEventJob, shipPreAuthEventJob } from './audit-event.handler';

/**
 * Phase X Part 2, X1.1: the `crewflow-audit-events` consumer (legacy `bull` prefix, concurrency 2). main.ts creates its
 * BullMQ Worker only when this process has a sink (CREWFLOW_AUDIT_SINK is not `none`); the handler is always registered
 * (handler-registry coverage). The sink is this process's configured one (`securityAuditSinkConfig`, validated at boot).
 */
@Processor(CONSUMER_QUEUES.auditEvents.name)
export class AuditEventConsumer {
  private sink?: SecurityAuditSink;

  constructor(private readonly deps: WorkerDependencies) {}

  @Process(CONSUMER_QUEUES.auditEvents.jobName)
  async ship(job: Job<unknown>): Promise<{ outcome: AuditEventShipOutcome }> {
    const { tenantContext, logger } = this.deps.get();
    this.sink ??= createSecurityAuditSink(securityAuditSinkConfig(process.env), { log: (line) => logger.warn(line) });
    // X1.1 (b): the system-scoped pre-auth failed login (every accepted job name of this queue reaches this one method).
    if (job.name === AUDIT_PREAUTH_JOB_NAME) return shipPreAuthEventJob(job, { sink: this.sink });
    return shipAuditEventJob(job, {
      readRow: (organisationId, auditLogId) =>
        readAuditRowForShipping((org, fn) => runScopedForOrg(tenantContext, org, null, (manager) => fn(manager)), organisationId, auditLogId),
      sink: this.sink,
      processLabel: 'worker',
    });
  }
}
