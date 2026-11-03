import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Phase D follow-up (#24): the "a legacy sweep reached its batch limit" signal.
 *
 * In `WORKER_CLAIM_MODE=global` the reconciliation sweep is the processor's ORIGINAL per_scope handler (a `boolean`
 * "did work" adapter, shared with per_scope mode and both schedulers). Each per_scope cycle claims at most one batch per
 * queue and scope (email / push 50 per organisation, realtime 25 per scope, statements 200 per workspace), so when a
 * batch comes back FULL more due work may remain in that scope. The cycles report that through this side channel
 * instead of a changed return type, so per_scope mode — its SQL, its return values, its stats — stays byte-for-byte the
 * same: outside `captureLegacyBatchLimit` (i.e. always in per_scope mode) `noteLegacyBatchLimitReached` is a no-op.
 *
 * The capture is per call (AsyncLocalStorage), so concurrent sweeps of different queues never see each other's signal.
 */
interface LegacyBatchLimitCapture {
  reached: number;
}

const capture = new AsyncLocalStorage<LegacyBatchLimitCapture>();

/** Called by a per_scope cycle when one scope's claim / discovery returned a full batch. No-op outside a capture. */
export function noteLegacyBatchLimitReached(): void {
  const current = capture.getStore();
  if (current) current.reached += 1;
}

/** Runs one legacy sweep and reports how many scopes reached their batch limit during it. A throw propagates unchanged. */
export async function captureLegacyBatchLimit<T>(
  sweep: () => Promise<T>,
): Promise<{ value: T; scopesAtLimit: number }> {
  const store: LegacyBatchLimitCapture = { reached: 0 };
  const value = await capture.run(store, sweep);
  return { value, scopesAtLimit: store.reached };
}
