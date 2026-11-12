import type { ProcessHandler, HandlerRegistry } from '../scheduler/processor-explorer';
import type { ScanJobDefinition } from '../scheduler/scan-jobs';
import type { WorkerJobDependencies } from '../scheduler/worker-dependencies';
import { dispatchEmailScope } from '../../queues/rab-email/email-dispatch.job';
import { dispatchPushScope } from '../../queues/rab-push/push-dispatch.job';
import { publishRealtimeScope } from '../../queues/rab-realtime/publish-outbox.job';
import { enqueueShiftStatement } from '../../queues/rab-reports/shift-statement-enqueue';
import { dispatchStatementScope } from '../../queues/rab-reports/shift-statement.job';
import type { DispatchCoordinator, DispatchQueueBinding } from './dispatch-coordinator';
import { DISPATCH_SCAN_JOBS } from './dispatch-config';

/**
 * Phase D (D1/D2) wiring between main.ts, the scan registry and the dispatch coordinator.
 *
 * per_scope mode (the DEFAULT) installs NOTHING from this file: main.ts keeps the discovered registry and the scan
 * intervals exactly as before, so the four dispatchers run their pre-Phase-D per-organisation / per-workspace cycles.
 *
 * global mode wraps the registry so the four dispatch scans call `coordinator.tick(queue, ctx)` (reconciliation sweep when
 * due + global claim). event mode additionally sets those four scans' interval to the backstop and starts the listener.
 */

// O3 C2: the pure dispatch switches live in dispatch-config.ts (shared with the API's one-shot scheduler registration);
// re-exported here unchanged so every existing import keeps working.
export { DISPATCH_SCAN_JOBS, DispatchConfigError, dispatchIntervalOf, resolveDispatchConfig } from './dispatch-config';
export type { DispatchConfig, WorkerClaimMode, WorkerDispatchMode } from './dispatch-config';

/** The registry the schedulers use in global mode: the bound dispatch scans → coordinator.tick; everything else unchanged. */
export function withGlobalDispatch(registry: HandlerRegistry, coordinator: Pick<DispatchCoordinator, 'queues' | 'tick'>): HandlerRegistry {
  const bound = new Set<string>(coordinator.queues);
  return {
    handlers: registry.handlers,
    get: registry.get,
    scan: (def: ScanJobDefinition): ProcessHandler => {
      const queue = DISPATCH_SCAN_JOBS[def.jobName];
      if (queue && bound.has(queue)) return (...args: unknown[]) => coordinator.tick(queue, ...args);
      return registry.scan(def);
    },
  };
}

/**
 * The coordinator's bindings for the queues ENABLED in this process (push only with PUSH_ENABLED=true, realtime only
 * with REALTIME_ENABLED=true — the same predicate that registers their scans). `legacy` is the processor's ORIGINAL
 * handler (the per_scope cycle, unchanged); `processScope` calls the queue's shared scope function with the claimed ids
 * and the SAME publishers / jobIds the processors use.
 */
export function buildDispatchBindings(
  deps: WorkerJobDependencies,
  registry: HandlerRegistry,
  scanJobs: readonly ScanJobDefinition[],
  isEnabled: (def: ScanJobDefinition) => boolean,
): DispatchQueueBinding[] {
  const { tenantContext, emailQueue, emailService, pushQueue, pushService, realtimePublish, environmentService, shiftStatementQueue, logger } = deps;
  const bindings: DispatchQueueBinding[] = [];
  for (const def of scanJobs) {
    const queue = DISPATCH_SCAN_JOBS[def.jobName];
    if (!queue || !isEnabled(def)) continue;
    const legacy = registry.scan(def);
    let processScope: DispatchQueueBinding['processScope'];
    switch (queue) {
      case 'email':
        processScope = async (scope) => {
          const r = await dispatchEmailScope(
            tenantContext,
            scope.organisationId,
            scope.subjectIds,
            (id, orgId) => emailQueue.publish(id, orgId),
            (id, orgId, generation) => emailQueue.republish(id, orgId, generation),
            emailService.ambiguousDeliverySafeToRetry,
            (id, generation) => emailQueue.isLive(id, generation),
          );
          if (r.claimed) logger.log(`email dispatch (global): claimed=${r.claimed} published=${r.published} recovered=${r.recovered} deliveryUncertain=${r.deliveryUncertain} generationsExhausted=${r.generationsExhausted}`);
          return r.claimed;
        };
        break;
      case 'push':
        processScope = async (scope) => {
          if (!environmentService.get('PUSH_ENABLED')) return 0; // defence in depth, as the processor
          const r = await dispatchPushScope(
            tenantContext,
            scope.organisationId,
            scope.subjectIds,
            (id, orgId) => pushQueue.publish(id, orgId),
            (id, orgId, generation) => pushQueue.republish(id, orgId, generation),
            pushService.ambiguousDeliverySafeToRetry,
          );
          if (r.claimed) logger.log(`push dispatch (global): claimed=${r.claimed} published=${r.published} recovered=${r.recovered} deliveryUncertain=${r.deliveryUncertain}`);
          return r.claimed;
        };
        break;
      case 'realtime':
        processScope = async (scope) => {
          if (!environmentService.get('REALTIME_ENABLED')) return 0; // defence in depth, as the processor
          const r = await publishRealtimeScope(tenantContext, realtimePublish, environmentService.get('NODE_ENV'), scope, { ids: scope.subjectIds });
          // D-Q5a: also log a cycle whose only outcome was a lease reclaim that exhausted max_attempts (failed, none claimed).
          if (r.claimed || r.failed || r.lostLease) logger.log(`realtime outbox publish (global): claimed=${r.claimed} published=${r.published} invalid=${r.invalid} retried=${r.retried} failed=${r.failed} lostLease=${r.lostLease}`);
          return r.claimed;
        };
        break;
      case 'statement':
        processScope = async (scope) => {
          if (scope.workspaceId === null) return 0; // statements are per workspace (runGlobalDispatch already filters these)
          const r = await dispatchStatementScope(tenantContext, scope.organisationId, scope.workspaceId, scope.subjectIds, async (data) => {
            await enqueueShiftStatement(shiftStatementQueue, data); // D-Q1: the same registered builder as per_scope
          });
          if (r.claimed) {
            logger.log(`shift statement dispatch (global): claimed=${r.claimed} published=${r.published} reconciledMissing=${r.reconciledMissing} requeued=${r.requeued} publishFailed=${r.publishFailed}`);
          }
          return r.claimed;
        };
        break;
    }
    bindings.push({ queue, legacy, processScope });
  }
  return bindings;
}
