/**
 * Phase D (D2): per-queue mutual exclusion with coalescing — NEVER two claim loops for one queue in one process.
 *
 * `run(reason)` starts the work at once when idle. While a run is in flight, every further call joins ONE queued
 * follow-up run (its reasons are merged), which starts as soon as the current run settles. So any number of wake-ups,
 * scan ticks and catch-ups arriving during a run cost exactly one more run — enough to pick up whatever was committed
 * after the in-flight run's last claim, and never a second concurrent loop. A failed run never blocks the next one; its
 * error reaches only the callers that awaited that run.
 */
export class DispatchQueueRunner<T> {
  private active: Promise<T> | null = null;
  private queued: { promise: Promise<T | undefined>; reasons: Set<string> } | null = null;
  private stopped = false;

  constructor(private readonly work: (reasons: ReadonlySet<string>) => Promise<T>) {}

  get busy(): boolean {
    return this.active !== null;
  }

  run(reason: string): Promise<T | undefined> {
    if (this.stopped) return Promise.resolve(undefined);
    // Join a queued follow-up FIRST: between a run settling (start()'s finally clears `active`) and the follow-up's own
    // reaction starting it, `active` is null while `queued` is set; starting here would run two loops at once.
    if (this.queued) {
      this.queued.reasons.add(reason);
      return this.queued.promise;
    }
    if (!this.active) return this.start(new Set([reason]));
    const reasons = new Set([reason]);
    const promise = this.active
      .catch(() => undefined)
      .then(() => {
        this.queued = null;
        if (this.stopped) return undefined;
        return this.start(reasons);
      });
    this.queued = { promise, reasons };
    return promise;
  }

  /** No new run starts after this (a queued follow-up resolves `undefined` without running). */
  stop(): void {
    this.stopped = true;
  }

  /** Resolves when nothing is running or queued (never rejects). */
  async idle(): Promise<void> {
    while (this.active || this.queued) {
      await (this.queued?.promise ?? this.active)!.catch(() => undefined);
    }
  }

  private start(reasons: ReadonlySet<string>): Promise<T> {
    const promise: Promise<T> = Promise.resolve()
      .then(() => this.work(reasons))
      .finally(() => {
        if (this.active === promise) this.active = null;
      });
    this.active = promise;
    return promise;
  }
}
