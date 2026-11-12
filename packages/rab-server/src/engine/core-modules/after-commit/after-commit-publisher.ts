import { DataSource, EntityManager, QueryRunner } from 'typeorm';

export type AfterCommitTask = () => Promise<void>;

export interface AfterCommitPublisherOptions {
  /** The warning line for a failed task, from the error's NAME only (never its message, ids or values). */
  readonly failureMessage: (errorName: string) => string;
  /** Bound on tasks held for ONE transaction; beyond it a task is simply not registered (the backstop handles the row). */
  readonly maxPerTransaction: number;
  /**
   * Process-wide bound on tasks in flight at once. Beyond it a task is not attempted (the backstop handles the row), so a
   * Redis outage or a slow producer never piles up pending publishes in memory.
   */
  readonly maxInFlight: number;
  readonly logger: { warn(message: string): void };
}

/**
 * Phase D-Q4b: the AFTER-COMMIT publish mechanism #35 introduced for `NotifyFastPublishService`, generalised to an engine
 * helper so other producers (the D-Q4b timer triggers) reuse the exact same rules instead of a second implementation:
 *
 *  - NEVER before commit. A task is registered against the transaction's own QueryRunner and fired only from TypeORM's
 *    `AfterTransactionCommit` broadcast for the OUTERMOST commit (`isTransactionActive === false`; a savepoint release is
 *    ignored). ANY rollback on that QueryRunner — of the whole transaction or of a savepoint inside it — discards every task
 *    registered on it (conservative: whatever did commit is handled by the backstop instead). Outside an open transaction
 *    nothing is registered.
 *  - Detached: the commit broadcast (and so the caller's `transaction()` promise) never waits for a task. A failing task is
 *    logged and swallowed; the caller's result never depends on it.
 *  - Bounded: `maxPerTransaction` tasks per transaction, `maxInFlight` tasks in flight per process (each task is expected to
 *    bound itself too — the queue producers use `boundedPublish`, 3 s).
 *
 * Plain class (no Nest): each producer owns one instance with its own bounds and warning line. Behaviour for the notify fast path
 * is byte-identical to the code it was extracted from (notify-fast-publish.service.spec.ts runs unchanged).
 */
export class AfterCommitPublisher {
  private readonly pending = new WeakMap<QueryRunner, AfterCommitTask[]>();
  private inFlight = 0;
  private readonly subscriber = {
    afterTransactionCommit: (event: { queryRunner: QueryRunner }): void => this.onCommit(event.queryRunner),
    afterTransactionRollback: (event: { queryRunner: QueryRunner }): void => this.onRollback(event.queryRunner),
  };

  constructor(private readonly options: AfterCommitPublisherOptions) {}

  /** Registers `task` to run after `manager`'s outermost commit. True when registered (an open transaction, under the bound). */
  defer(manager: EntityManager, task: AfterCommitTask): boolean {
    const runner = manager.queryRunner;
    // Only inside an open transaction: there must be a commit to wait for.
    if (!runner || runner.isReleased || !runner.isTransactionActive) return false;
    this.subscribe(manager.connection);
    const tasks = this.pending.get(runner) ?? [];
    if (tasks.length >= this.options.maxPerTransaction) return false;
    tasks.push(task);
    this.pending.set(runner, tasks);
    return true;
  }

  /** Tasks still held for this QueryRunner (tests / diagnostics). */
  heldFor(runner: QueryRunner | undefined): number {
    return runner ? (this.pending.get(runner)?.length ?? 0) : 0;
  }

  /** Tasks currently in flight (tests / diagnostics). */
  get inFlightCount(): number {
    return this.inFlight;
  }

  /** Registers the commit/rollback listener on the transaction's own DataSource, once. */
  private subscribe(connection: DataSource): void {
    if (!connection.subscribers.includes(this.subscriber as never)) connection.subscribers.push(this.subscriber as never);
  }

  private onCommit(runner: QueryRunner): void {
    // A savepoint release (nested transaction) is not a commit: the outer transaction may still roll back.
    if (runner.isTransactionActive) return;
    const tasks = this.pending.get(runner);
    if (!tasks) return;
    this.pending.delete(runner);
    // Detached on purpose: the broadcast (and so the caller's transaction() promise) never waits for Redis.
    void this.flush(tasks);
  }

  private onRollback(runner: QueryRunner): void {
    this.pending.delete(runner);
  }

  /** Concurrently: one slow or hanging task never holds back the others. A task beyond the in-flight bound is skipped. */
  private async flush(tasks: readonly AfterCommitTask[]): Promise<void> {
    await Promise.all(
      tasks.map(async (task) => {
        if (this.inFlight >= this.options.maxInFlight) return;
        this.inFlight++;
        try {
          await task();
        } catch (error) {
          this.options.logger.warn(this.options.failureMessage((error as Error)?.name ?? 'Error'));
        } finally {
          this.inFlight--;
        }
      }),
    );
  }
}
