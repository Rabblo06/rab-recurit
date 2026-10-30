/**
 * Phase B (B4/B5): internal database metrics for this process — connection pools and the optional read replica.
 *
 * Same discipline as engine/observability/request-context.ts: no metrics library, no endpoint, nothing exported to the
 * network. The registry lives in memory; DatabaseRuntimeModule logs a one-line summary on an interval, and code (tests,
 * a future internal exporter) reads `snapshot()`.
 *
 * SAFETY: every key is a fixed, low-cardinality name chosen in code (pool names 'primary' / 'replica' / 'worker-direct',
 * fallback reasons from FallbackReason, histogram bucket bounds). Nothing here ever stores a URL, host, user name,
 * password, SQL text, bound parameter, error message, organisation/workspace/user id or any other tenant data. Errors are
 * reduced to a counter by CLASS (timeout or not) before they reach this file.
 */

/** Pool names used by this codebase. A pool is registered once under one of these. */
export type DbPoolName = 'primary' | 'replica' | 'worker-direct';

/** Why a read that asked for the replica ran on the primary. */
export type ReplicaFallbackReason =
  /** Replica configured but its boot/periodic validation has not passed yet (e.g. migration ledger behind). */
  | 'not-validated'
  /** Replica unreachable, or its last probe failed. */
  | 'unavailable'
  /** Replay is behind the primary by more than PG_DATABASE_REPLICA_MAX_LAG_MS, or lag could not be measured. */
  | 'stale'
  /** Replica refused for a configuration reason (writable primary, wrong role, identity mismatch, ...). */
  | 'refused'
  /** The replica transaction failed with a connection/recovery-conflict error; the read was re-run on the primary. */
  | 'replica-error';

export const REPLICA_FALLBACK_REASONS: readonly ReplicaFallbackReason[] = ['not-validated', 'unavailable', 'stale', 'refused', 'replica-error'];

/** Acquisition-time histogram bucket upper bounds, milliseconds. The last bucket is +Inf. */
export const ACQUIRE_BUCKETS_MS: readonly number[] = [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000];

/** The pg-pool surface the gauges read (pg-pool 3.x): totalCount / idleCount / waitingCount / options.max. */
export interface PgPoolLike {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  options?: { max?: number };
  connect: (...args: unknown[]) => unknown;
}

class Histogram {
  readonly counts: number[] = new Array(ACQUIRE_BUCKETS_MS.length + 1).fill(0);
  count = 0;
  sumMs = 0;
  maxMs = 0;

  observe(ms: number): void {
    const value = Math.max(0, ms);
    let i = ACQUIRE_BUCKETS_MS.findIndex((bound) => value <= bound);
    if (i === -1) i = ACQUIRE_BUCKETS_MS.length;
    this.counts[i] += 1;
    this.count += 1;
    this.sumMs += value;
    if (value > this.maxMs) this.maxMs = value;
  }

  /** Upper bound of the bucket holding the q-quantile (coarse, bucketed); null when empty; Infinity in the overflow. */
  quantile(q: number): number | null {
    if (this.count === 0) return null;
    const rank = Math.ceil(q * this.count);
    let seen = 0;
    for (let i = 0; i < this.counts.length; i += 1) {
      seen += this.counts[i];
      if (seen >= rank) return i < ACQUIRE_BUCKETS_MS.length ? ACQUIRE_BUCKETS_MS[i] : Number.POSITIVE_INFINITY;
    }
    return Number.POSITIVE_INFINITY;
  }
}

interface PoolEntry {
  pool: PgPoolLike | null;
  acquisition: Histogram;
  acquisitionFailures: number;
  acquisitionTimeouts: number;
  queryTimeouts: number;
  idleInTransactionTimeouts: number;
}

export interface PoolSnapshot {
  name: DbPoolName;
  registered: boolean;
  total: number | null;
  idle: number | null;
  waiting: number | null;
  max: number | null;
  acquisitions: number;
  acquisitionMsP50: number | null;
  acquisitionMsP99: number | null;
  acquisitionMsMax: number;
  acquisitionBuckets: Array<{ leMs: number | 'inf'; count: number }>;
  acquisitionFailures: number;
  acquisitionTimeouts: number;
  queryTimeouts: number;
  idleInTransactionTimeouts: number;
}

export type ReplicaStateName = 'not-configured' | 'not-validated' | 'validated' | 'unavailable' | 'refused';

export interface ReplicaSnapshot {
  configured: boolean;
  state: ReplicaStateName;
  /** 1 when reads would currently go to the replica (validated AND fresh), else 0. */
  available: 0 | 1;
  /** Lower bound of the replay lag: age of the oldest primary LSN sample the replica has not replayed yet. 0 = caught up. Null = unknown. */
  lagMs: number | null;
  /** Bytes between the replica's received and replayed WAL (pg_last_wal_receive_lsn - pg_last_wal_replay_lsn). */
  replayBacklogBytes: number | null;
  reads: number;
  fallbacks: Record<ReplicaFallbackReason, number>;
  connectionFailures: number;
  configurationFailures: number;
  validationFailures: number;
  probes: number;
  probeFailures: number;
}

export interface DatabaseMetricsSnapshot {
  pools: PoolSnapshot[];
  replica: ReplicaSnapshot;
}

const POOL_TIMEOUT_MESSAGE = /timeout exceeded when trying to connect|Connection terminated due to connection timeout/i;
const INSTRUMENTED = Symbol.for('crewflow.dbPoolInstrumented');

/** True for pg-pool's own "no free connection in time" error (connectionTimeoutMillis applied to a waiting caller). */
export function isPoolAcquisitionTimeout(error: unknown): boolean {
  return error instanceof Error && POOL_TIMEOUT_MESSAGE.test(error.message);
}

/** Server statement_timeout / cancel (57014) or pg's client-side query_timeout. */
export function isQueryTimeout(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code === '57014') return true;
  return error instanceof Error && /Query read timeout/i.test(error.message);
}

export class DatabaseMetrics {
  private readonly pools = new Map<DbPoolName, PoolEntry>();
  private replicaState: ReplicaStateName = 'not-configured';
  private replicaAvailable = false;
  private replicaLagMs: number | null = null;
  private replicaBacklogBytes: number | null = null;
  private replicaReads = 0;
  private readonly replicaFallbacks = Object.fromEntries(REPLICA_FALLBACK_REASONS.map((r) => [r, 0])) as Record<ReplicaFallbackReason, number>;
  private replicaConnectionFailures = 0;
  private replicaConfigurationFailures = 0;
  private replicaValidationFailures = 0;
  private replicaProbes = 0;
  private replicaProbeFailures = 0;

  private entry(name: DbPoolName): PoolEntry {
    let entry = this.pools.get(name);
    if (!entry) {
      entry = { pool: null, acquisition: new Histogram(), acquisitionFailures: 0, acquisitionTimeouts: 0, queryTimeouts: 0, idleInTransactionTimeouts: 0 };
      this.pools.set(name, entry);
    }
    return entry;
  }

  /**
   * Registers a pg Pool under `name` and wraps its `connect` (both the callback form TypeORM uses and the promise form)
   * to time every acquisition and count failures. Idempotent per pool object. Behaviour of the pool is unchanged: the
   * wrapper only observes the result and passes it through untouched.
   */
  instrumentPool(name: DbPoolName, pool: PgPoolLike): void {
    const entry = this.entry(name);
    entry.pool = pool;
    const marked = pool as PgPoolLike & { [INSTRUMENTED]?: boolean };
    if (marked[INSTRUMENTED]) return;
    marked[INSTRUMENTED] = true;
    const original = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
    const observe = (startedAt: number, error: unknown) => {
      if (error) {
        entry.acquisitionFailures += 1;
        if (isPoolAcquisitionTimeout(error)) entry.acquisitionTimeouts += 1;
      } else {
        entry.acquisition.observe(Date.now() - startedAt);
      }
    };
    pool.connect = (...args: unknown[]) => {
      const startedAt = Date.now();
      const callback = args[0];
      if (typeof callback === 'function') {
        return original((error: unknown, client: unknown, release: unknown) => {
          observe(startedAt, error);
          (callback as (...a: unknown[]) => void)(error, client, release);
        });
      }
      return (original() as Promise<unknown>).then(
        (client) => {
          observe(startedAt, null);
          return client;
        },
        (error: unknown) => {
          observe(startedAt, error ?? new Error('pool connect failed'));
          throw error;
        },
      );
    };
  }

  /** Classifies a failed query/transaction on `pool`: only timeout CLASSES are counted, nothing about the error is stored. */
  recordQueryError(name: DbPoolName, error: unknown): void {
    const entry = this.entry(name);
    if (isQueryTimeout(error)) entry.queryTimeouts += 1;
    else if ((error as { code?: string } | null)?.code === '25P03') entry.idleInTransactionTimeouts += 1;
    else if (isPoolAcquisitionTimeout(error)) {
      // Already counted by the connect wrapper when the pool is instrumented; count here only for an uninstrumented pool.
      if (!entry.pool) {
        entry.acquisitionFailures += 1;
        entry.acquisitionTimeouts += 1;
      }
    }
  }

  setReplicaState(state: ReplicaStateName, available: boolean): void {
    this.replicaState = state;
    this.replicaAvailable = available;
  }

  setReplicaLag(lagMs: number | null, backlogBytes: number | null): void {
    this.replicaLagMs = lagMs;
    this.replicaBacklogBytes = backlogBytes;
  }

  recordReplicaRead(): void {
    this.replicaReads += 1;
  }

  recordReplicaFallback(reason: ReplicaFallbackReason): void {
    this.replicaFallbacks[reason] += 1;
  }

  recordReplicaConnectionFailure(): void {
    this.replicaConnectionFailures += 1;
  }

  recordReplicaConfigurationFailure(): void {
    this.replicaConfigurationFailures += 1;
  }

  recordReplicaValidationFailure(): void {
    this.replicaValidationFailures += 1;
  }

  recordReplicaProbe(ok: boolean): void {
    this.replicaProbes += 1;
    if (!ok) this.replicaProbeFailures += 1;
  }

  snapshot(): DatabaseMetricsSnapshot {
    const pools: PoolSnapshot[] = [];
    for (const [name, e] of this.pools) {
      const p = e.pool;
      pools.push({
        name,
        registered: p !== null,
        total: p ? p.totalCount : null,
        idle: p ? p.idleCount : null,
        waiting: p ? p.waitingCount : null,
        max: p && typeof p.options?.max === 'number' ? p.options.max : null,
        acquisitions: e.acquisition.count,
        acquisitionMsP50: e.acquisition.quantile(0.5),
        acquisitionMsP99: e.acquisition.quantile(0.99),
        acquisitionMsMax: e.acquisition.maxMs,
        acquisitionBuckets: e.acquisition.counts.map((count, i) => ({ leMs: i < ACQUIRE_BUCKETS_MS.length ? ACQUIRE_BUCKETS_MS[i] : ('inf' as const), count })),
        acquisitionFailures: e.acquisitionFailures,
        acquisitionTimeouts: e.acquisitionTimeouts,
        queryTimeouts: e.queryTimeouts,
        idleInTransactionTimeouts: e.idleInTransactionTimeouts,
      });
    }
    return {
      pools,
      replica: {
        configured: this.replicaState !== 'not-configured',
        state: this.replicaState,
        available: this.replicaAvailable ? 1 : 0,
        lagMs: this.replicaLagMs,
        replayBacklogBytes: this.replicaBacklogBytes,
        reads: this.replicaReads,
        fallbacks: { ...this.replicaFallbacks },
        connectionFailures: this.replicaConnectionFailures,
        configurationFailures: this.replicaConfigurationFailures,
        validationFailures: this.replicaValidationFailures,
        probes: this.replicaProbes,
        probeFailures: this.replicaProbeFailures,
      },
    };
  }

  /** One log line per pool plus one for the replica. Numbers and fixed names only. */
  summaryLines(): string[] {
    const s = this.snapshot();
    const lines = s.pools.map(
      (p) =>
        `db pool ${p.name}: total=${p.total ?? '-'} idle=${p.idle ?? '-'} waiting=${p.waiting ?? '-'} max=${p.max ?? '-'} ` +
        `acquisitions=${p.acquisitions} p50<=${p.acquisitionMsP50 ?? '-'}ms p99<=${p.acquisitionMsP99 ?? '-'}ms max=${p.acquisitionMsMax}ms ` +
        `acquireFailures=${p.acquisitionFailures} acquireTimeouts=${p.acquisitionTimeouts} queryTimeouts=${p.queryTimeouts} idleInTxTimeouts=${p.idleInTransactionTimeouts}`,
    );
    const r = s.replica;
    if (r.configured) {
      lines.push(
        `db replica: state=${r.state} available=${r.available} lagMs=${r.lagMs ?? '-'} backlogBytes=${r.replayBacklogBytes ?? '-'} reads=${r.reads} ` +
          `fallbacks=${REPLICA_FALLBACK_REASONS.map((k) => `${k}:${r.fallbacks[k]}`).join(',')} connectionFailures=${r.connectionFailures} ` +
          `configurationFailures=${r.configurationFailures} validationFailures=${r.validationFailures} probes=${r.probes} probeFailures=${r.probeFailures}`,
      );
    }
    return lines;
  }

  /** Test seam: forget everything. */
  reset(): void {
    this.pools.clear();
    this.replicaState = 'not-configured';
    this.replicaAvailable = false;
    this.replicaLagMs = null;
    this.replicaBacklogBytes = null;
    this.replicaReads = 0;
    for (const r of REPLICA_FALLBACK_REASONS) this.replicaFallbacks[r] = 0;
    this.replicaConnectionFailures = 0;
    this.replicaConfigurationFailures = 0;
    this.replicaValidationFailures = 0;
    this.replicaProbes = 0;
    this.replicaProbeFailures = 0;
  }
}

/** The process-wide registry. */
export const databaseMetrics = new DatabaseMetrics();

/** The pg Pool behind a TypeORM postgres DataSource (TypeORM 0.3: `driver.master`), or null before initialize(). */
export function pgPoolOf(dataSource: { driver: unknown }): PgPoolLike | null {
  const master = (dataSource.driver as { master?: PgPoolLike } | undefined)?.master;
  return master && typeof master.connect === 'function' ? master : null;
}

/**
 * Registers a TypeORM DataSource's pool. For the Worker's direct (lock) pool, main.ts calls
 * `registerDataSourcePoolMetrics('worker-direct', directDataSource)` after initialize().
 */
export function registerDataSourcePoolMetrics(name: DbPoolName, dataSource: { driver: unknown }, metrics: DatabaseMetrics = databaseMetrics): boolean {
  const pool = pgPoolOf(dataSource);
  if (!pool) return false;
  metrics.instrumentPool(name, pool);
  return true;
}
