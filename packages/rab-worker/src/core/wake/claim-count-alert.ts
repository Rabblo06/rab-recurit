import { DISPATCH_CLAIM_COUNT_ALERT_THRESHOLD, DispatchClaim, DispatchQueue } from '../database/dispatch-claims';

/**
 * Phase D wave 2 — OD-1 visibility (owner decision 2026-11-01, accepted temporarily).
 *
 * A pointer whose `claim_count` exceeds 20 has been leased over and over without its subject reaching a state its trigger
 * handles (a stuck subject, a scope that keeps failing, or a forged pointer that matches nothing). The Worker never
 * deletes pointers; it makes them VISIBLE so an operator can follow the supervised cleanup runbook:
 *   `dispatch claim-count alert: queue=<label> subject=<uuid> organisation=<uuid> claimCount=<n> (> 20)`
 * Routing ids and the count only — no claim token, no workspace, no payload, no email address or other personal data.
 *
 * Throttled per (queue, subject): at most one line per CLAIM_COUNT_ALERT_THROTTLE_MS, and at most `maxLinesPerRun` lines
 * per claim run (the rest are summarised in one count-only line). The throttle memory is bounded.
 */
export const CLAIM_COUNT_ALERT_THROTTLE_MS = 15 * 60_000;
export const CLAIM_COUNT_ALERT_MAX_LINES_PER_RUN = 10;
export const CLAIM_COUNT_ALERT_MAX_TRACKED = 10_000;

export interface ClaimCountAlerterOptions {
  logger: { warn(message: string): void };
  throttleMs?: number;
  maxLinesPerRun?: number;
  maxTracked?: number;
  now?: () => number;
}

export class ClaimCountAlerter {
  private readonly lastWarnedAt = new Map<string, number>();
  private lastPruneAt = 0;
  private linesThisRun = 0;
  private suppressedThisRun = 0;
  private readonly now: () => number;
  private readonly throttleMs: number;
  private readonly maxLines: number;
  private readonly maxTracked: number;

  constructor(private readonly options: ClaimCountAlerterOptions) {
    this.now = options.now ?? Date.now;
    this.throttleMs = options.throttleMs ?? CLAIM_COUNT_ALERT_THROTTLE_MS;
    this.maxLines = options.maxLinesPerRun ?? CLAIM_COUNT_ALERT_MAX_LINES_PER_RUN;
    this.maxTracked = options.maxTracked ?? CLAIM_COUNT_ALERT_MAX_TRACKED;
  }

  /** Entries currently remembered by the throttle (bounded by `maxTracked`). */
  get trackedCount(): number {
    return this.lastWarnedAt.size;
  }

  beginRun(): void {
    this.linesThisRun = 0;
    this.suppressedThisRun = 0;
  }

  /** One claim from a run; alerts when its count exceeds the threshold and it was not alerted within the throttle window. */
  note(queue: DispatchQueue, claim: Pick<DispatchClaim, 'subjectId' | 'organisationId' | 'claimCount'>): void {
    if (!(claim.claimCount > DISPATCH_CLAIM_COUNT_ALERT_THRESHOLD)) return;
    const now = this.now();
    const key = `${queue}|${claim.subjectId}`;
    const last = this.lastWarnedAt.get(key);
    if (last !== undefined && now - last < this.throttleMs) return;
    if (this.linesThisRun >= this.maxLines) {
      this.suppressedThisRun += 1;
      return;
    }
    this.remember(key, now);
    this.linesThisRun += 1;
    this.options.logger.warn(
      `dispatch claim-count alert: queue=${queue} subject=${claim.subjectId} organisation=${claim.organisationId} claimCount=${claim.claimCount} (> ${DISPATCH_CLAIM_COUNT_ALERT_THRESHOLD})`,
    );
  }

  /** Ends a run: one count-only summary line when lines were suppressed by the per-run cap. */
  endRun(queue: DispatchQueue): void {
    if (this.suppressedThisRun > 0) {
      this.options.logger.warn(
        `dispatch claim-count alert: queue=${queue} ${this.suppressedThisRun} more pointer(s) with claimCount > ${DISPATCH_CLAIM_COUNT_ALERT_THRESHOLD} this run (lines suppressed)`,
      );
    }
    const now = this.now();
    if (now - this.lastPruneAt >= this.throttleMs) {
      this.lastPruneAt = now;
      for (const [k, at] of this.lastWarnedAt) if (now - at >= this.throttleMs) this.lastWarnedAt.delete(k);
    }
    this.beginRun();
  }

  private remember(key: string, now: number): void {
    if (this.lastWarnedAt.size >= this.maxTracked) {
      for (const [k, at] of this.lastWarnedAt) if (now - at >= this.throttleMs) this.lastWarnedAt.delete(k);
      // Still full: forget everything rather than grow (worst case: one repeated line per subject, never unbounded memory).
      if (this.lastWarnedAt.size >= this.maxTracked) this.lastWarnedAt.clear();
    }
    this.lastWarnedAt.set(key, now);
  }
}
