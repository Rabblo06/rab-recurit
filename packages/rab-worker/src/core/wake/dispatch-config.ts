import type { DispatchQueue } from '../database/dispatch-claims';
import type { ScanJobDefinition } from '../scheduler/scan-jobs';

/**
 * Phase D (D1/D2) dispatch switches — the PURE part of dispatch-wiring.ts, moved here unchanged (O3 C2) so the API's one-shot
 * scheduler registration (register-schedulers.ts) computes the scan intervals exactly as the Worker does without importing
 * the dispatch jobs. dispatch-wiring.ts re-exports everything here, so every existing import keeps working.
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
