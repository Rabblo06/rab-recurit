import { Job } from 'bullmq';

import { TimerTriggerQueueService } from '@rab/server/engine/core-modules/timer-trigger/timer-trigger-queue.service';
import { TimerTriggerKind, TimerTriggerOutcome } from '@rab/server/engine/worker-shared/timer-trigger.contract';
import { runScopedForOrg } from '../../core/database/scoped-job';
import { Process, Processor } from '../../core/scheduler/decorators';
import { CONSUMER_QUEUES } from '../../core/scheduler/queue-registry';
import { WorkerDependencies, WorkerJobDependencies } from '../../core/scheduler/worker-dependencies';
import { expireOfferCandidate, runManagerConfirmationTimeoutCycle } from '../rab-offers/offer-expiry.job';
import { flagLateClockInCandidate } from '../rab-shifts/late-clock-in.job';
import { flagNoShowCandidate } from '../rab-shifts/shift-monitor.job';
import { handleTimerTrigger, TimerTriggerAction } from './timer-trigger.handler';

/**
 * The scans' OWN per-candidate bodies, one per trigger kind — never a copy (D-Q4b rule). Each runs in a fresh
 * `runScopedForOrg` transaction bound to the payload's organisation/workspace (SET LOCAL + FORCE RLS), exactly as the scan
 * runs it for a discovered candidate; the body re-reads and revalidates the subject itself (Pass A / claim / Pass B).
 *  - offer-expiry: `expireOfferCandidate` (offer-expiry.job.ts) — the `claimExpiredOffer` CAS + audit + notify + realtime.
 *  - manager-confirmation: a WAKE — the existing `runManagerConfirmationTimeoutCycle` (definer claim of due pointers, from
 *    the Worker only; the pointer is the authority, DBA-01 grants untouched).
 *  - no-show: `flagNoShowCandidate` (shift-monitor.job.ts) — worker_event `no-show:<id>`, row lock, status CAS.
 *  - late-clock-in: `flagLateClockInCandidate` (late-clock-in.job.ts) — worker_event `late-clock-in:<id>`, Pass A/B.
 */
export function buildTimerTriggerActions(deps: WorkerJobDependencies): Readonly<Record<TimerTriggerKind, TimerTriggerAction>> {
  const { tenantContext, notificationService, auditService, realtimeEventService, environmentService, runtimeDataSource } = deps;
  const scoped = <T>(p: { organisationId: string; workspaceId: string }, fn: Parameters<typeof runScopedForOrg<T>>[3]) =>
    runScopedForOrg(tenantContext, p.organisationId, p.workspaceId, fn);
  return Object.freeze({
    'offer-expiry': (p) =>
      scoped(p, (manager) =>
        expireOfferCandidate(manager, { notificationService, auditService, realtimeEventService }, { offer_id: p.subjectId, organisation_id: p.organisationId, workspace_id: p.workspaceId }),
      ),
    'manager-confirmation': async () => {
      const result = await runManagerConfirmationTimeoutCycle(
        runtimeDataSource,
        tenantContext,
        notificationService,
        auditService,
        realtimeEventService,
        environmentService.get('MANAGER_CONFIRMATION_TIMEOUT_MINUTES'),
      );
      return result.confirmed > 0;
    },
    'no-show': (p) =>
      scoped(p, (manager) =>
        flagNoShowCandidate(manager, { notificationService, auditService }, { assignment_id: p.subjectId, organisation_id: p.organisationId, workspace_id: p.workspaceId }),
      ),
    'late-clock-in': (p) =>
      scoped(p, (manager) =>
        flagLateClockInCandidate(
          manager,
          { notificationService, auditService },
          { assignment_id: p.subjectId, organisation_id: p.organisationId, workspace_id: p.workspaceId },
          environmentService.get('LATE_CLOCK_IN_GRACE_MINUTES'),
        ),
      ),
  });
}

/**
 * Phase D-Q4b: the `crewflow-timer-triggers` consumer (legacy `bull` prefix, concurrency 2). main.ts creates its BullMQ
 * Worker only when WORKER_TIMER_TRIGGERS is shadow or on; the handler is always registered (handler-registry coverage).
 * Every accepted job name (the four `<kind>-trigger` names) reaches this one method; an unregistered name was already
 * failed closed by `createConsumerJobProcessor`.
 */
@Processor(CONSUMER_QUEUES.timerTriggers.name)
export class TimerTriggerConsumer {
  private actions?: Readonly<Record<TimerTriggerKind, TimerTriggerAction>>;

  constructor(
    private readonly deps: WorkerDependencies,
    private readonly producer: TimerTriggerQueueService,
  ) {}

  @Process(CONSUMER_QUEUES.timerTriggers.jobName)
  async trigger(job: Job<unknown>, token?: string): Promise<{ outcome: TimerTriggerOutcome }> {
    const deps = this.deps.get();
    this.actions ??= buildTimerTriggerActions(deps);
    const { settings } = this.producer;
    return handleTimerTrigger(job, token, {
      mode: settings.mode,
      enabled: (kind) => settings.enabled(kind),
      runScoped: (organisationId, workspaceId, fn) => runScopedForOrg(deps.tenantContext, organisationId, workspaceId, fn),
      actions: this.actions,
      managerConfirmationTimeoutMinutes: deps.environmentService.get('MANAGER_CONFIRMATION_TIMEOUT_MINUTES'),
      lateClockInGraceMinutes: deps.environmentService.get('LATE_CLOCK_IN_GRACE_MINUTES'),
      recordOutcome: deps.timerTriggerOutcomes ?? (() => undefined),
      logger: deps.logger,
    });
  }
}
