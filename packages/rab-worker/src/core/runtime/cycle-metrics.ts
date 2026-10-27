/**
 * M1 (BullMQ migration) — per-cycle duration instrumentation, both scheduler modes.
 *
 * Process-local ring buffers (the last `capacity` executed cycles per loop) from which p50/p95/p99/max are computed with
 * the nearest-rank method. Additive observability only: nothing here changes whether, when or how a cycle runs. The
 * summary is periodically written to a Redis hash (one field per loop, a small JSON object of numbers and counts) and
 * logged; it carries loop names, millisecond durations and counters only — never configuration, URLs, tenant ids or
 * business data.
 *
 * These measurements are what the BullMQ scan-queue lock durations are derived from (p99 × 3, floored at BullMQ's own
 * 30 s default) — see core/scheduler/scan-jobs.ts and docs/ultimate/CREWFLOW_BULLMQ_WORKER_MIGRATION_REPORT.md.
 */
export type CycleOutcome = 'succeeded' | 'idle' | 'failed' | 'skipped-running' | 'skipped-locked' | 'skipped-shutdown';

export interface CycleDurationSummary {
  /** Executed cycles in the current window (≤ capacity). */
  n: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  lastMs: number | null;
  /** Cumulative counters since this process started. */
  succeeded: number;
  idle: number;
  failed: number;
  skipped: number;
}

interface LoopSamples {
  ring: number[];
  next: number;
  lastMs: number | null;
  succeeded: number;
  idle: number;
  failed: number;
  skipped: number;
  dirty: boolean;
}

/** Nearest-rank percentile over an ascending-sorted array (p in (0, 100]). */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export class CycleMetrics {
  private readonly loops = new Map<string, LoopSamples>();

  constructor(private readonly capacity = 1024) {}

  private loop(key: string): LoopSamples {
    let entry = this.loops.get(key);
    if (!entry) {
      entry = { ring: [], next: 0, lastMs: null, succeeded: 0, idle: 0, failed: 0, skipped: 0, dirty: false };
      this.loops.set(key, entry);
    }
    return entry;
  }

  /** Records one finished cycle. Skips carry no duration (nothing ran). */
  record(key: string, outcome: CycleOutcome, durationMs?: number): void {
    const entry = this.loop(key);
    entry.dirty = true;
    if (outcome === 'skipped-running' || outcome === 'skipped-locked' || outcome === 'skipped-shutdown') {
      entry.skipped += 1;
      return;
    }
    if (outcome === 'succeeded') entry.succeeded += 1;
    else if (outcome === 'idle') entry.idle += 1;
    else entry.failed += 1;
    if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0) {
      const ms = Math.round(durationMs);
      if (entry.ring.length < this.capacity) entry.ring.push(ms);
      else entry.ring[entry.next] = ms;
      entry.next = (entry.next + 1) % this.capacity;
      entry.lastMs = ms;
    }
  }

  summary(key: string): CycleDurationSummary | null {
    const entry = this.loops.get(key);
    if (!entry) return null;
    const sorted = [...entry.ring].sort((a, b) => a - b);
    return {
      n: sorted.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted.length ? sorted[sorted.length - 1]! : null,
      lastMs: entry.lastMs,
      succeeded: entry.succeeded,
      idle: entry.idle,
      failed: entry.failed,
      skipped: entry.skipped,
    };
  }

  keys(): string[] {
    return [...this.loops.keys()];
  }

  /** Summaries of loops that changed since the previous call (for the periodic Redis write); clears the dirty marks. */
  takeDirty(): Array<[string, CycleDurationSummary]> {
    const out: Array<[string, CycleDurationSummary]> = [];
    for (const [key, entry] of this.loops) {
      if (!entry.dirty) continue;
      entry.dirty = false;
      out.push([key, this.summary(key)!]);
    }
    return out;
  }
}
