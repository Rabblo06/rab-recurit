import type { ProcessHandler, HandlerRegistry } from '../scheduler/processor-explorer';
import type { ScanJobDefinition } from '../scheduler/scan-jobs';
import type { WorkerJobDependencies } from '../scheduler/worker-dependencies';
import { DispatchQueue } from '../database/dispatch-claims';
import { dispatchEmailScope } from '../../queues/rab-email/email-dispatch.job';
import { dispatchPushScope } from '../../queues/rab-push/push-dispatch.job';
import { publishRealtimeScope } from '../../queues/rab-realtime/publish-outbox.job';
import { enqueueShiftStatement } from '../../queues/rab-reports/shift-statement-enqueue';
import { dispatchStatementScope } from '../../queues/rab-reports/shift-statement.job';
import type { DispatchCoordinator, DispatchQueueBinding } from './dispatch-coordinator';

/**
 * Phase D (D1/D2) wiring between main.ts, the scan registry and the dispatch coordinator.
 *
 * per_scope mode (the DEFAULT) installs NOTHING from this file: main.ts keeps the discovered registry and the scan
 * intervals exactly as before, so the four dispatchers run their pre-Phase-D per-organisation / per-workspace cycles.
 *
 * global mode wraps the registry so the four dispatch scans call `coordinator.tick(queue, ctx)` (reconciliation sweep when
 * due + global claim). event mode additionally sets those four scans' interval to the backstop and starts the listener.
 */

export type WorkerClaimMode = 'per_scope' | 'global';
export type WorkerDispatchMode = 'poll' | 'event';

export interface DispatchConfig {
  claimMode: WorkerClaimMode;
  dispatchMode: WorkerDispatchMode;
  backstopSeconds: number;
  reconcileSeconds: number;
  claimBatch: number;
}

/** The four dispatch scans → their pointer queue labels (contract). */
export const DISPATCH_SCAN_JOBS: Readonly<Record<string, DispatchQueue>> = Object.freeze({
  'email-dispatch': 'email',
  'push-dispatch': 'push',
  'realtime-outbox-publish': 'realtime',
  'shift-statement-dispatch': 'statement',
});

export class DispatchConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DispatchConfigError';
  }
}

function intSetting(env: { get(key: string): unknown }, key: string, fallback: number, min: number, max: number): number {
  const raw = env.get(key);
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new DispatchConfigError(`${key} must be a whole number ${min}–${max}`);
  return value;
}

/**
 * Reads the Phase D switches (validated by env.validation.ts — Agent C — and re-checked here, fail closed). Defaults never
 * change behaviour: per_scope + poll. event without global is refused (the same combination rule the boot validation has).
 */
export function resolveDispatchConfig(env: { get(key: string): unknown }): DispatchConfig {
  const claimRaw = env.get('WORKER_CLAIM_MODE') ?? 'per_scope';
  if (claimRaw !== 'per_scope' && claimRaw !== 'global') throw new DispatchConfigError('WORKER_CLAIM_MODE must be exactly per_scope or global');
  const dispatchRaw = env.get('WORKER_DISPATCH_MODE') ?? 'poll';
  if (dispatchRaw !== 'poll' && dispatchRaw !== 'event') throw new DispatchConfigError('WORKER_DISPATCH_MODE must be exactly poll or event');
  if (dispatchRaw === 'event' && claimRaw !== 'global') {
    throw new DispatchConfigError('WORKER_DISPATCH_MODE=event requires WORKER_CLAIM_MODE=global');
  }
  return {
    claimMode: claimRaw,
    dispatchMode: dispatchRaw,
    backstopSeconds: intSetting(env, 'WORKER_DISPATCH_BACKSTOP_SECONDS', 30, 10, 120),
    reconcileSeconds: intSetting(env, 'WORKER_DISPATCH_RECONCILE_SECONDS', 900, 60, 900), // wave 3: capped at 900 s (server env config)
    claimBatch: intSetting(env, 'WORKER_DISPATCH_CLAIM_BATCH', 100, 1, 200),
  };
}

/** A scan's interval under the dispatch config: event mode → the four dispatch scans tick at the backstop; else unchanged. */
export function dispatchIntervalOf(def: Pick<ScanJobDefinition, 'jobName'>, baseMs: number, config: DispatchConfig): number {
  if (config.dispatchMode === 'event' && def.jobName in DISPATCH_SCAN_JOBS) return config.backstopSeconds * 1000;
  return baseMs;
}

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
          );
          if (r.claimed) logger.log(`email dispatch (global): claimed=${r.claimed} published=${r.published} recovered=${r.recovered} deliveryUncertain=${r.deliveryUncertain}`);
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
