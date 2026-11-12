import type { DispatchQueryable } from '../database/dispatch-claims';
import type { DispatchConfig } from './dispatch-wiring';

/**
 * Phase D wave 2 — OD-2 (owner decision 2026-11-01): LISTEN/NOTIFY is a hint, and PostgreSQL's NOTIFY queue is shared by
 * the whole cluster (8 GB of SLRU pages by default). If a session sits idle in an open transaction while LISTENing, the
 * queue cannot be truncated past it and fills; at 100 % every NOTIFY — i.e. every producer transaction that fires a
 * pointer trigger — fails at COMMIT. So, before event mode is enabled anywhere, the Worker samples
 * `pg_notification_queue_usage()` (fraction 0..1, no privilege needed) at the backstop cadence on its existing runtime
 * connection, reports it in health/metrics, warns above 0.1 and escalates (error level) above 0.5.
 *
 * The operator half of OD-2 — a role-level `idle_in_transaction_session_timeout` ≈ 60 s on crewflow / crewflow_app /
 * crewflow_worker — is a runbook step, never a migration and never done by this code.
 *
 * Poll mode never constructs this (`createNotificationQueueMonitor` returns null): poll mode issues no NOTIFY at all.
 * Reported values are a number and a level word only — no configuration, URL, tenant id or SQL text.
 */
export const NOTIFICATION_QUEUE_USAGE_SQL = 'SELECT pg_notification_queue_usage() AS usage';
export const NOTIFICATION_QUEUE_WARN_ABOVE = 0.1;
export const NOTIFICATION_QUEUE_ESCALATE_ABOVE = 0.5;
/** While a non-ok level persists, it is logged again at most this often. */
export const NOTIFICATION_QUEUE_REPEAT_LOG_MS = 5 * 60_000;
/**
 * Wave 3 (owner decision): the sample query is bounded to at most 5 s — server-side (`SET LOCAL statement_timeout` in the
 * sample's own short transaction on the normal pool) and client-side (the wait for a pool connection included).
 */
export const NOTIFICATION_QUEUE_QUERY_TIMEOUT_MAX_MS = 5_000;

/**
 * The Worker's NORMAL pool (main.ts: the runtime TypeORM DataSource). With `transaction`, the sample runs in one short
 * transaction with a server-side statement timeout; without it (tests / a plain queryable) it is a single autocommit query.
 * Never a new connection.
 */
export type NotificationQueuePool = DispatchQueryable & {
  transaction?: <T>(work: (manager: DispatchQueryable) => Promise<T>) => Promise<T>;
};

export type NotificationQueueLevel = 'ok' | 'warn' | 'escalate' | 'unknown';

export interface NotificationQueueSample {
  /** Fraction 0..1, or null when the sample failed. */
  usage: number | null;
  level: NotificationQueueLevel;
  at: number;
}

export function classifyNotificationQueueUsage(usage: number | null): NotificationQueueLevel {
  if (usage === null || !Number.isFinite(usage)) return 'unknown';
  if (usage > NOTIFICATION_QUEUE_ESCALATE_ABOVE) return 'escalate';
  if (usage > NOTIFICATION_QUEUE_WARN_ABOVE) return 'warn';
  return 'ok';
}

export interface NotificationQueueMonitorOptions {
  logger: { log(message: string): void; warn(message: string): void; error?(message: string): void };
  /** Sampling cadence (main.ts: WORKER_DISPATCH_BACKSTOP_SECONDS × 1000). */
  intervalMs: number;
  /** Health/metrics sink (main.ts: WorkerRuntime.setGauges → rab:worker:stats + the instance heartbeat file). */
  onSample?: (sample: NotificationQueueSample) => void;
  repeatLogMs?: number;
  /** Per-sample query timeout; default and maximum NOTIFICATION_QUEUE_QUERY_TIMEOUT_MAX_MS (5 s). */
  queryTimeoutMs?: number;
  now?: () => number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

export class NotificationQueueMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSample: NotificationQueueSample | null = null;
  private loggedLevel: NotificationQueueLevel = 'ok';
  private loggedAt = Number.NEGATIVE_INFINITY;
  /** The sample's QUERY (not the sample): set until the query itself settles, even after a client-side timeout. */
  private queryInFlight: Promise<unknown> | null = null;
  private skipped = 0;
  private readonly now: () => number;
  readonly queryTimeoutMs: number;

  constructor(
    private readonly db: NotificationQueuePool,
    private readonly options: NotificationQueueMonitorOptions,
  ) {
    this.now = options.now ?? Date.now;
    const requested = Math.trunc(options.queryTimeoutMs ?? NOTIFICATION_QUEUE_QUERY_TIMEOUT_MAX_MS);
    this.queryTimeoutMs = Number.isFinite(requested) && requested > 0 ? Math.min(requested, NOTIFICATION_QUEUE_QUERY_TIMEOUT_MAX_MS) : NOTIFICATION_QUEUE_QUERY_TIMEOUT_MAX_MS;
  }

  /** Ticks skipped because the previous sample's query was still in flight (never two sample queries at once). */
  get skippedTicks(): number {
    return this.skipped;
  }

  get intervalMs(): number {
    return this.options.intervalMs;
  }

  get last(): NotificationQueueSample | null {
    return this.lastSample;
  }

  start(): void {
    if (this.timer) return;
    const set = this.options.setInterval ?? setInterval;
    this.timer = set(() => void this.sample(), this.options.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    (this.options.clearInterval ?? clearInterval)(this.timer);
    this.timer = null;
  }

  /**
   * One sample, never throws: query (bounded) → classify → report → log on level change / repeat window. Resolves `null`
   * (a SKIPPED tick, counted) while the previous sample's query is still in flight — including one that already timed
   * out client-side but has not returned its pool connection yet — so sample queries never overlap.
   */
  sample(): Promise<NotificationQueueSample | null> {
    if (this.queryInFlight) {
      this.skipped += 1;
      return Promise.resolve(null);
    }
    return this.takeSample();
  }

  private runQuery(): Promise<unknown> {
    const { transaction } = this.db;
    if (typeof transaction === 'function') {
      // queryTimeoutMs is an integer 1..5000 computed above — never caller text.
      return transaction.call(this.db, async (manager: DispatchQueryable) => {
        // sql-injection-reviewed: integer code constant / validated integer setting, not request data.
        await manager.query(`SET LOCAL statement_timeout = ${this.queryTimeoutMs}`);
        return manager.query(NOTIFICATION_QUEUE_USAGE_SQL);
      });
    }
    return this.db.query(NOTIFICATION_QUEUE_USAGE_SQL);
  }

  private async takeSample(): Promise<NotificationQueueSample> {
    let usage: number | null = null;
    const query = Promise.resolve().then(() => this.runQuery());
    const settled = query.then(
      () => undefined,
      () => undefined,
    );
    this.queryInFlight = settled;
    void settled.then(() => {
      if (this.queryInFlight === settled) this.queryInFlight = null;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.queryTimeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });
    try {
      const outcome = await Promise.race([query, timeout]);
      if (outcome !== 'timeout') {
        const rows = outcome as Array<{ usage?: unknown }>;
        const value = Number(Array.isArray(rows) ? rows[0]?.usage : Number.NaN);
        usage = Number.isFinite(value) ? value : null;
      }
    } catch {
      usage = null;
    } finally {
      if (timer) clearTimeout(timer);
    }
    const sample: NotificationQueueSample = { usage, level: classifyNotificationQueueUsage(usage), at: this.now() };
    this.lastSample = sample;
    try {
      this.options.onSample?.(sample);
    } catch {
      // Reporting is best effort.
    }
    this.logLevel(sample);
    return sample;
  }

  private logLevel(sample: NotificationQueueSample): void {
    const { level } = sample;
    const changed = level !== this.loggedLevel;
    const repeatDue = sample.at - this.loggedAt >= (this.options.repeatLogMs ?? NOTIFICATION_QUEUE_REPEAT_LOG_MS);
    if (level === 'ok') {
      if (changed && this.loggedLevel !== 'unknown') {
        this.options.logger.log(`NOTIFY queue recovered: pg_notification_queue_usage=${sample.usage!.toFixed(6)} (<= ${NOTIFICATION_QUEUE_WARN_ABOVE})`);
      }
      this.loggedLevel = 'ok';
      return;
    }
    if (!changed && !repeatDue) return;
    this.loggedLevel = level;
    this.loggedAt = sample.at;
    if (level === 'unknown') {
      this.options.logger.warn('NOTIFY queue usage could not be sampled (pg_notification_queue_usage failed); retrying at the backstop cadence');
      return;
    }
    const value = sample.usage!.toFixed(6);
    if (level === 'escalate') {
      const message =
        `NOTIFY queue usage critical: pg_notification_queue_usage=${value} (> ${NOTIFICATION_QUEUE_ESCALATE_ABOVE}) — a LISTENing session is probably idle in ` +
        'an open transaction; at 1.0 every pointer-trigger NOTIFY fails its COMMIT. Escalate: find it in pg_stat_activity; check idle_in_transaction_session_timeout (OD-2 runbook)';
      if (this.options.logger.error) this.options.logger.error(message);
      else this.options.logger.warn(message);
      return;
    }
    this.options.logger.warn(
      `NOTIFY queue usage high: pg_notification_queue_usage=${value} (> ${NOTIFICATION_QUEUE_WARN_ABOVE}) — check for long-open transactions on LISTEN sessions (OD-2 runbook)`,
    );
  }
}

/** Event mode only: a monitor at the backstop cadence. Poll mode → null (nothing constructed, nothing sampled). */
export function createNotificationQueueMonitor(
  config: Pick<DispatchConfig, 'dispatchMode' | 'backstopSeconds'>,
  db: NotificationQueuePool,
  options: Omit<NotificationQueueMonitorOptions, 'intervalMs'>,
): NotificationQueueMonitor | null {
  if (config.dispatchMode !== 'event') return null;
  return new NotificationQueueMonitor(db, { ...options, intervalMs: config.backstopSeconds * 1000 });
}
