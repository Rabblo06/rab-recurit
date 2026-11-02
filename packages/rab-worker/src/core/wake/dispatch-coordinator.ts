import {
  DISPATCH_CLAIM_COUNT_ALERT_THRESHOLD,
  DispatchQueryable,
  DispatchQueue,
  DispatchScopeWork,
  GlobalDispatchReport,
  isDispatchQueue,
  runGlobalDispatch,
} from '../database/dispatch-claims';
import { ClaimCountAlerter } from './claim-count-alert';
import { DispatchQueueRunner } from './dispatch-runner';
import { captureLegacyBatchLimit } from './legacy-batch-limit';

/**
 * Phase D (D1/D2) — per-process coordinator of the four dispatch queues in `WORKER_CLAIM_MODE=global`.
 *
 * Three ways a queue's global claim runs, all through ONE `DispatchQueueRunner` per queue (never two claim loops for a
 * queue at once in this process; concurrent requests coalesce into one follow-up run):
 *   - `tick(queue)` — the queue's existing scan tick (interval or bullmq scheduler). In `poll` mode at the scan's own
 *     interval; in `event` mode main.ts sets that interval to WORKER_DISPATCH_BACKSTOP_SECONDS, so the tick IS the
 *     backstop that runs regardless of notifications. A tick also runs the LEGACY per-scope cycle (the processor's
 *     original handler, unchanged) when the reconciliation sweep is due (every WORKER_DISPATCH_RECONCILE_SECONDS, and on
 *     the first tick after start: it picks up rows written before the pointer triggers existed and any drift).
 *   - `wake(queue)` — a NOTIFY hint from the listener, debounced per queue.
 *   - `wakeAll()` — catch-up after the listener (re)connected (notifications sent while disconnected are lost).
 * Each run claims until a claim comes back EMPTY (wave 5, F-W4-1: a short batch is the per-organisation cap, not "done"),
 * bounded by `maxBatchesPerRun`; a run that hits the bound with rows still coming schedules a prompt coalesced follow-up.
 *
 * #24 — bounded, fair follow-up reconciliation. The legacy sweep claims at most one batch per queue and scope (email /
 * push 50 per organisation, realtime 25 per scope, statements 200 per workspace). When any scope comes back FULL
 * (`legacy-batch-limit.ts`), more pointerless work may remain, so instead of waiting a whole reconcile interval the
 * coordinator schedules a follow-up sweep `followUpDelayMs` later, through the same per-queue runner (one loop per queue)
 * and `executeWake` (scan slot, metrics, shutdown drain). Bounded: at most `maxFollowUpsPerInterval` follow-ups per
 * reconcile window (so at most 1 + that many sweeps per window and queue in this process); a sweep that reaches no
 * limit, or an exhausted budget, returns to the regular cadence; a failed sweep keeps the existing 60 s retry and
 * schedules no follow-up. Fair: every sweep walks every organisation / scope and takes at most one batch from each, so
 * one large backlog cannot starve the others. Idle-neutral: with no full batch nothing extra runs.
 */
export interface DispatchQueueBinding {
  queue: DispatchQueue;
  /** The processor's original per-scope cycle (unchanged) — the reconciliation sweep. */
  legacy: (...args: unknown[]) => Promise<boolean | void | unknown>;
  /** One scope of the global claim: the queue's EXISTING scoped transaction restricted to `scope.subjectIds`. Returns rows acted on. */
  processScope: (scope: DispatchScopeWork) => Promise<number>;
}

export interface DispatchCoordinatorLogger {
  log(message: string): void;
  warn(message: string): void;
  error?(message: string, error?: unknown): void;
}

export interface DispatchCoordinatorOptions {
  /** Autocommit connection the claim/release functions run on (the Worker's runtime DataSource as crewflow_worker). */
  claimer: DispatchQueryable;
  /** WORKER_DISPATCH_CLAIM_BATCH. */
  batch: number;
  /** Claim calls per run at most (default 10). */
  maxBatchesPerRun?: number;
  /** WORKER_DISPATCH_RECONCILE_SECONDS × 1000. */
  reconcileMs: number;
  /** Per-queue debounce for wake-ups (default 200 ms). */
  debounceMs?: number;
  logger: DispatchCoordinatorLogger;
  /**
   * Wraps a wake-driven run (main.ts: `WorkerRuntime.runOnce` → scan-concurrency slot, stats, metrics, shutdown drain).
   * Default: run directly.
   */
  executeWake?: (queue: DispatchQueue, run: () => Promise<boolean>, trigger: DispatchRunTrigger) => Promise<unknown>;
  /** #24: delay before a follow-up sweep (default 5 s). */
  followUpDelayMs?: number;
  /** #24: follow-up sweeps per reconcile window and queue (default 30). 0 disables follow-ups. */
  maxFollowUpsPerInterval?: number;
  /**
   * OD-1: per-run claim statistics (main.ts adds them to the queue's cycle metrics: `claimsRepeated`, `claimsOver20`).
   * Called after every run that claimed, including a run that failed after its claim.
   */
  onRunStats?: (queue: DispatchQueue, stats: DispatchRunClaimStats) => void;
  /** OD-1: throttle window of the claim-count alert per (queue, subject). Default 15 min. */
  claimAlertThrottleMs?: number;
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

/** OD-1 per-run claim statistics: claims, claims with claim_count > 1, claims with claim_count > 20. */
export interface DispatchRunClaimStats {
  claimed: number;
  repeatedClaims: number;
  highClaimCount: number;
}

/** A failed reconciliation sweep is retried after this long (not on every 2 s tick). */
export const RECONCILE_RETRY_AFTER_FAILURE_MS = 60_000;
export const DEFAULT_MAX_BATCHES_PER_RUN = 10;
export const DEFAULT_WAKE_DEBOUNCE_MS = 200;
/** #24: delay between a legacy sweep that reached a batch limit and its follow-up sweep. */
export const DEFAULT_RECONCILE_FOLLOW_UP_DELAY_MS = 5_000;
/** #24: follow-up sweeps per reconcile window and queue, at most (so at most 31 sweeps per window). */
export const DEFAULT_MAX_RECONCILE_FOLLOW_UPS = 30;

/** Why a coordinator-initiated run started: a NOTIFY wake-up or a #24 follow-up reconciliation sweep. */
export type DispatchRunTrigger = 'wake' | 'reconcile';

interface QueueState {
  binding: DispatchQueueBinding;
  runner: DispatchQueueRunner<boolean>;
  /** Next time the legacy sweep is due (0 = at the first tick). */
  reconcileDueAt: number;
  /** #24: start of the current reconcile window (the regular sweep that opened it), and its follow-up budget left. */
  windowStartedAt: number;
  followUpsLeft: number;
  /** #24: the pending follow-up sweep timer, and whether a follow-up sweep is owed (honoured even if the timer fires early). */
  followUp: ReturnType<typeof setTimeout> | null;
  followUpArmed: boolean;
  debounce: ReturnType<typeof setTimeout> | null;
  wakeInFlight: boolean;
  wakeAgain: boolean;
  /** The arguments of the latest tick (the scan's CycleContext), handed to the legacy handler unchanged. */
  legacyArgs: unknown[];
  /** OD-1: throttled claim_count > 20 alerts for this queue. */
  alerter: ClaimCountAlerter;
}

export class DispatchCoordinator {
  private readonly states = new Map<DispatchQueue, QueueState>();
  private stopped = false;
  private readonly now: () => number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly wakeRuns = new Set<Promise<unknown>>();

  constructor(
    bindings: readonly DispatchQueueBinding[],
    private readonly options: DispatchCoordinatorOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimeout ?? setTimeout;
    this.clearTimer = options.clearTimeout ?? clearTimeout;
    for (const binding of bindings) {
      if (this.states.has(binding.queue)) throw new Error(`dispatch queue ${binding.queue} is bound twice`);
      const state: QueueState = {
        binding,
        reconcileDueAt: 0,
        windowStartedAt: Number.NEGATIVE_INFINITY,
        followUpsLeft: 0,
        followUp: null,
        followUpArmed: false,
        debounce: null,
        wakeInFlight: false,
        wakeAgain: false,
        legacyArgs: [],
        alerter: new ClaimCountAlerter({ logger: options.logger, throttleMs: options.claimAlertThrottleMs, now: options.now }),
        runner: new DispatchQueueRunner<boolean>((reasons) => this.execute(state, reasons)),
      };
      this.states.set(binding.queue, state);
    }
  }

  /** The queues this process dispatches (only enabled ones are bound). */
  get queues(): DispatchQueue[] {
    return [...this.states.keys()];
  }

  /** Scan tick (poll interval / event-mode backstop). Resolves true when rows were acted on or the sweep did work. */
  async tick(queue: DispatchQueue, ...legacyArgs: unknown[]): Promise<boolean> {
    const state = this.states.get(queue);
    if (!state || this.stopped) return false;
    state.legacyArgs = legacyArgs;
    return (await state.runner.run('tick')) === true;
  }

  /** NOTIFY hint: debounced per queue. A queue not bound here (disabled, unknown) is ignored. */
  wake(queue: string): void {
    if (this.stopped || !isDispatchQueue(queue)) return;
    const state = this.states.get(queue);
    if (!state || state.debounce) return;
    state.debounce = this.setTimer(() => {
      state.debounce = null;
      this.fireWake(state);
    }, this.options.debounceMs ?? DEFAULT_WAKE_DEBOUNCE_MS);
  }

  /** Catch-up after the listener (re)connected. */
  wakeAll(): void {
    for (const queue of this.states.keys()) this.wake(queue);
  }

  /** Shutdown: cancel pending wake-ups; no new run starts. */
  stop(): void {
    this.stopped = true;
    for (const state of this.states.values()) {
      if (state.debounce) this.clearTimer(state.debounce);
      state.debounce = null;
      if (state.followUp) this.clearTimer(state.followUp);
      state.followUp = null;
      state.followUpArmed = false;
      state.runner.stop();
    }
  }

  /** Waits for every in-flight run (ticks and wakes). Never rejects. */
  async idle(): Promise<void> {
    for (;;) {
      const pending = [...this.wakeRuns];
      await Promise.allSettled(pending);
      await Promise.all([...this.states.values()].map((s) => s.runner.idle()));
      if (this.wakeRuns.size === 0 && [...this.states.values()].every((s) => !s.runner.busy)) return;
    }
  }

  private fireWake(state: QueueState): void {
    if (this.stopped) return;
    if (state.wakeInFlight) {
      state.wakeAgain = true;
      return;
    }
    state.wakeInFlight = true;
    const run = () => state.runner.run('wake').then((claimed) => claimed === true);
    const promise: Promise<unknown> = Promise.resolve()
      .then(() => this.executeTriggered(state.binding.queue, run, 'wake'))
      .catch((error: unknown) => {
        this.options.logger.warn(`${state.binding.queue} dispatch wake-up run failed: ${(error as Error)?.name ?? 'error'}`);
      })
      .finally(() => {
        this.wakeRuns.delete(promise);
        state.wakeInFlight = false;
        if (state.wakeAgain) {
          state.wakeAgain = false;
          this.wake(state.binding.queue);
        }
      });
    this.wakeRuns.add(promise);
  }

  private executeTriggered(queue: DispatchQueue, run: () => Promise<boolean>, trigger: DispatchRunTrigger): Promise<unknown> {
    return this.options.executeWake ? this.options.executeWake(queue, run, trigger) : run();
  }

  /**
   * #24: one follow-up sweep, `delayMs` from now (armed at the END of the run that asked for it, after its global claim,
   * so the run's own `executeWake` slot is free when the timer fires). A tick that comes first and finds it due runs it
   * instead; any sweep clears a pending timer and the armed flag.
   */
  private scheduleFollowUp(state: QueueState, delayMs: number): void {
    if (this.stopped) return;
    if (state.followUp) this.clearTimer(state.followUp);
    state.reconcileDueAt = this.now() + delayMs;
    state.followUpArmed = true;
    state.followUp = this.setTimer(() => {
      state.followUp = null;
      if (this.stopped) return;
      const run = () => state.runner.run('reconcile').then((acted) => acted === true);
      const promise: Promise<unknown> = Promise.resolve()
        .then(() => this.executeTriggered(state.binding.queue, run, 'reconcile'))
        .catch((error: unknown) => {
          this.options.logger.warn(`${state.binding.queue} dispatch follow-up reconciliation failed: ${(error as Error)?.name ?? 'error'}`);
        })
        .finally(() => this.wakeRuns.delete(promise));
      this.wakeRuns.add(promise);
    }, delayMs);
  }

  /** One exclusive run: the legacy sweep when a tick (or a #24 follow-up) finds it due, then the global claim. */
  private async execute(state: QueueState, reasons: ReadonlySet<string>): Promise<boolean> {
    const { binding } = state;
    let didWork = false;
    let sweepError: unknown = null;
    let followUpDelayMs: number | null = null;
    const due = this.now() >= state.reconcileDueAt;
    if ((reasons.has('tick') && due) || (reasons.has('reconcile') && (due || state.followUpArmed))) {
      const startedAt = this.now();
      const isFollowUp = state.followUpArmed;
      // Any sweep consumes an owed follow-up: clear its timer and flag (a later one is armed below if still needed).
      if (state.followUp) this.clearTimer(state.followUp);
      state.followUp = null;
      state.followUpArmed = false;
      if (!isFollowUp && startedAt >= state.windowStartedAt + this.options.reconcileMs) {
        // Only a regular sweep opens a new reconcile window with a fresh follow-up budget. A follow-up that starts after
        // the window has ended (slow sweeps) spends what is left of its window's budget, so a window never exceeds
        // 1 + maxFollowUpsPerInterval sweeps and the chain cannot renew itself.
        state.windowStartedAt = startedAt;
        state.followUpsLeft = this.options.maxFollowUpsPerInterval ?? DEFAULT_MAX_RECONCILE_FOLLOW_UPS;
      }
      try {
        const sweep = await captureLegacyBatchLimit(() => binding.legacy(...state.legacyArgs));
        didWork = sweep.value === true;
        if (sweep.scopesAtLimit > 0 && state.followUpsLeft > 0 && !this.stopped) {
          state.followUpsLeft -= 1;
          followUpDelayMs = this.options.followUpDelayMs ?? DEFAULT_RECONCILE_FOLLOW_UP_DELAY_MS;
          // Due again with the follow-up (its timer is armed after this run's global claim, below — also when that throws).
          state.reconcileDueAt = this.now() + followUpDelayMs;
        } else {
          if (sweep.scopesAtLimit > 0) {
            this.options.logger.warn(
              `${binding.queue} dispatch reconciliation: follow-up budget exhausted with ${sweep.scopesAtLimit} scope(s) at their batch limit; ` +
                'the backlog continues in the next reconcile window',
            );
          }
          state.reconcileDueAt = state.windowStartedAt + this.options.reconcileMs;
        }
      } catch (error) {
        sweepError = error;
        state.reconcileDueAt = startedAt + Math.min(RECONCILE_RETRY_AFTER_FAILURE_MS, this.options.reconcileMs);
      }
    }
    let acted = 0;
    const claimStats: DispatchRunClaimStats = { claimed: 0, repeatedClaims: 0, highClaimCount: 0 };
    state.alerter.beginRun();
    let report: GlobalDispatchReport;
    try {
      report = await runGlobalDispatch({
        claimer: this.options.claimer,
        queue: binding.queue,
        batch: this.options.batch,
        maxBatches: this.options.maxBatchesPerRun ?? DEFAULT_MAX_BATCHES_PER_RUN,
        logger: this.options.logger,
        processScope: async (scope) => {
          acted += await binding.processScope(scope);
        },
        onClaimed: (claims) => {
          claimStats.claimed += claims.length;
          for (const claim of claims) {
            if (claim.claimCount > 1) claimStats.repeatedClaims += 1;
            if (claim.claimCount > DISPATCH_CLAIM_COUNT_ALERT_THRESHOLD) claimStats.highClaimCount += 1;
          }
        },
        onHighClaimCount: (claim) => state.alerter.note(binding.queue, claim),
      });
    } finally {
      if (followUpDelayMs !== null) this.scheduleFollowUp(state, followUpDelayMs);
      state.alerter.endRun(binding.queue);
      if (claimStats.claimed > 0) {
        try {
          this.options.onRunStats?.(binding.queue, claimStats);
        } catch {
          // Metrics only.
        }
      }
    }
    if (report.skippedNotReady || report.invalidScope || report.releaseRefused || report.releaseFailed) {
      this.options.logger.log(
        `${binding.queue} dispatch (global): claimed=${report.claimed} scopes=${report.scopes} skippedNotReady=${report.skippedNotReady} ` +
          `invalidScope=${report.invalidScope} released=${report.released} releaseRefused=${report.releaseRefused} releaseFailed=${report.releaseFailed}`,
      );
    }
    // Wave 5 (F-W4-1): the run hit maxBatchesPerRun while claims still returned rows → a follow-up run now, not at the next
    // poll tick / backstop. Through wake(): debounced, run via executeWake (runtime scan slot, metrics, shutdown drain) and
    // the same per-queue runner, so it coalesces with any other request and never starts a second concurrent loop. It
    // chains only while each run keeps hitting the bound; a run that ends on an empty claim schedules nothing.
    if (report.boundReached && !this.stopped) this.wake(binding.queue);
    if (sweepError) throw sweepError;
    // Stamped (lastRunAt) only when rows were actually acted on — as per_scope mode stamps only when it claimed rows. A
    // claimed pointer whose subject was not due/visible in its scope is not "work".
    return didWork || acted > 0;
  }
}
