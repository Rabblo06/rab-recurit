/**
 * Phase B (B4/P5): the optional read replica. Absent PG_DATABASE_REPLICA_URL → every read runs on the primary and this
 * service does nothing.
 *
 * When configured (API process only; the Worker, CLI and migrate never use a replica):
 *   - ONE separate TypeORM DataSource, built by the connection factory with role 'replica': the same restricted
 *     crewflow_app login, the same TLS rules, the same per-session timeouts, plus default_transaction_read_only=on.
 *     Same entities as the primary; no migrations, no synchronize.
 *   - Boot validation (replica-validation.ts). A configuration error (writable primary, wrong role, other cluster,
 *     FORCE RLS drift, identity mismatch, replica connection budget) REFUSES STARTUP. An unreachable or not-yet-consistent
 *     replica does not block startup: reads stay on the primary and the probe retries.
 *   - A probe every PG_DATABASE_REPLICA_PROBE_INTERVAL (maxLag/4, 250 ms–5 s) samples the primary's WAL position and the
 *     replica's replay position (replica-freshness.ts), re-checks pg_is_in_recovery() (a promoted standby is refused),
 *     and re-validates every 60 s.
 *   - routeRead() hands out the replica DataSource only while it is validated AND fresh; otherwise it names the reason
 *     and the caller (TenantContextService) runs the read on the primary.
 *   - A replica transaction that fails with a connection-class or recovery-conflict error is reported here
 *     (shouldRetryOnPrimary): the caller re-runs the read on the primary, and a connection failure marks the replica
 *     unavailable until the next successful probe.
 *
 * Which reads may ask for the replica is an explicit register (replica-read-register.ts, enforced by its spec). Nothing is
 * routed to the replica automatically.
 */
import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

import {
  createPgDataSource,
  currentPgProcessRole,
  isPgProductionEnvironment,
  PgPoolRequest,
  readReplicaDatabaseUrl,
  resolvePgEnvironmentCached,
} from '../../postgres';
import { isDatabaseUnreachable } from '../../boot-checks/database-boot-gate-rules';
import { readDeploymentShape, readServerCapacity, usableCapacity } from '../connection-budget';
import { DatabaseMetrics, databaseMetrics, isPoolAcquisitionTimeout, ReplicaFallbackReason, ReplicaStateName, registerDataSourcePoolMetrics } from '../database-metrics';
import { parseLsn, ReplicaFreshness } from './replica-freshness';
import { ReplicaConfigurationError, ReplicaQuery, sameLedgerHead, validateReplica } from './replica-validation';

export const PG_REPLICA_OPTIONS = Symbol('PG_REPLICA_OPTIONS');

export const REPLICA_TIMEOUT_DEFAULT_MS = 30_000;
export const REPLICA_MAX_LAG_DEFAULT_MS = 5_000;
/** How long a replica connection attempt may take before the read falls back (the factory's connectTimeoutMs). */
export const REPLICA_CONNECT_TIMEOUT_MS = 2_000;
export const REPLICA_REVALIDATE_MS = 60_000;

export interface PgReplicaOptions {
  /** Explicit replica URL (tests and labs). Default: the factory's readReplicaDatabaseUrl() (PG_DATABASE_REPLICA_URL). */
  url?: string | null;
  maxLagMs?: number;
  timeoutMs?: number;
  probeIntervalMs?: number;
  /** Default: true only in the API process. */
  enabled?: boolean;
  production?: boolean;
  /** Pool max for the replica pool (default: this process's PG_POOL_MAX_CONNECTIONS). */
  poolMax?: number;
  metrics?: DatabaseMetrics;
  now?: () => number;
  env?: Record<string, string | undefined>;
  /** Set false to skip starting the background probe (tests drive probe() themselves). */
  startProbe?: boolean;
}

export type ReplicaRoute = { dataSource: DataSource } | { dataSource: null; reason: ReplicaFallbackReason | 'not-configured' };

type Env = Record<string, string | undefined>;

function intSetting(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d{1,9}$/.test(raw)) throw new ReplicaConfigurationError('budget', `${name} must be a whole number of milliseconds.`);
  const n = Number(raw);
  if (n < min || n > max) throw new ReplicaConfigurationError('budget', `${name} must be between ${min} and ${max}.`);
  return n;
}

/** The replica URL through the connection factory (PG_DATABASE_REPLICA_URL, trimmed; null when unset). */
function factoryReplicaUrl(env: Env): string | null {
  return readReplicaDatabaseUrl(env)?.value ?? null;
}

const REPLICA_POSITION_SQL = `SELECT pg_catalog.pg_is_in_recovery() AS in_recovery,
       pg_catalog.pg_last_wal_replay_lsn()::text AS replay,
       pg_catalog.pg_last_wal_receive_lsn()::text AS receive`;
const PRIMARY_POSITION_SQL = 'SELECT pg_catalog.pg_current_wal_lsn()::text AS lsn';

/** Recovery conflicts a hot standby raises on a running query (retry on the primary, the replica itself is fine). */
function isRecoveryConflict(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return (code === '40001' || code === '40P01') && error instanceof Error && /conflict with recovery/i.test(error.message);
}

/** 42P01 undefined_table / 3F000 invalid_schema_name: the replica has not replayed a just-created relation or schema. */
function isMissingOnReplica(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === '42P01' || code === '3F000';
}

@Injectable()
export class PgReplicaService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('PgReplica');
  private readonly options: PgReplicaOptions;
  private readonly metrics: DatabaseMetrics;
  private readonly now: () => number;
  private replica: DataSource | null = null;
  private state: ReplicaStateName = 'not-configured';
  private freshness: ReplicaFreshness | null = null;
  private timer: NodeJS.Timeout | null = null;
  private probing: Promise<void> | null = null;
  private lastValidatedAt = 0;
  private closing = false;
  private maxLagMs = REPLICA_MAX_LAG_DEFAULT_MS;

  constructor(
    private readonly primary: DataSource,
    @Optional() @Inject(PG_REPLICA_OPTIONS) options?: PgReplicaOptions,
  ) {
    this.options = options ?? {};
    this.metrics = this.options.metrics ?? databaseMetrics;
    this.now = this.options.now ?? Date.now;
  }

  get currentState(): ReplicaStateName {
    return this.state;
  }

  async onModuleInit(): Promise<void> {
    const env = this.options.env ?? process.env;
    const enabled = this.options.enabled ?? currentPgProcessRole() === 'api';
    const url = this.options.url !== undefined ? this.options.url : factoryReplicaUrl(env);
    if (!enabled || !url) {
      this.setState('not-configured');
      return;
    }
    this.maxLagMs = this.options.maxLagMs ?? intSetting(env, 'PG_DATABASE_REPLICA_MAX_LAG_MS', REPLICA_MAX_LAG_DEFAULT_MS, 100, 600_000);
    const timeoutMs = this.options.timeoutMs ?? intSetting(env, 'PG_DATABASE_REPLICA_TIMEOUT_MS', REPLICA_TIMEOUT_DEFAULT_MS, 1_000, 3_600_000);
    this.freshness = new ReplicaFreshness(this.maxLagMs, this.now);
    this.replica = this.buildDataSource(url, timeoutMs, env);
    this.setState('unavailable');

    try {
      await this.replica.initialize();
      registerDataSourcePoolMetrics('replica', this.replica, this.metrics);
    } catch (error) {
      if (error instanceof ReplicaConfigurationError) throw error;
      this.metrics.recordReplicaConnectionFailure();
      this.logger.warn('read replica not reachable at startup; every read stays on the primary until it is (probe retries).');
      this.startProbe();
      return;
    }
    // A configuration error here refuses startup (thrown out of Nest init). Anything else: primary until the probe passes.
    try {
      await this.validate();
      await this.checkReplicaBudget(env);
      if (this.state === 'validated') await this.sampleLag();
    } catch (error) {
      if (error instanceof ReplicaConfigurationError) {
        this.metrics.recordReplicaConfigurationFailure();
        this.setState('refused');
        await this.replica.destroy().catch(() => undefined);
        throw error;
      }
      this.markUnavailable(error);
    }
    this.startProbe();
  }

  async onApplicationShutdown(): Promise<void> {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.probing?.catch(() => undefined);
    if (this.replica?.isInitialized) await this.replica.destroy().catch(() => undefined);
  }

  /** Where a read that opted into the replica should run right now. */
  routeRead(): ReplicaRoute {
    if (this.state === 'not-configured') return { dataSource: null, reason: 'not-configured' };
    if (this.state === 'refused') return { dataSource: null, reason: 'refused' };
    if (this.state === 'unavailable' || !this.replica?.isInitialized) return { dataSource: null, reason: 'unavailable' };
    if (this.state === 'not-validated') return { dataSource: null, reason: 'not-validated' };
    if (!this.freshness?.isFresh()) return { dataSource: null, reason: 'stale' };
    return { dataSource: this.replica };
  }

  /**
   * Called by TenantContextService when a replica transaction failed. True = the read may be re-run on the primary (the
   * replica transaction was READ ONLY, so nothing was written). A connection failure also marks the replica unavailable.
   */
  shouldRetryOnPrimary(error: unknown): boolean {
    if (isDatabaseUnreachable(error) || isPoolAcquisitionTimeout(error)) {
      this.metrics.recordReplicaConnectionFailure();
      this.markUnavailable(error);
      return true;
    }
    return isRecoveryConflict(error) || isMissingOnReplica(error);
  }

  /** One probe (single-flight). Public for tests and the lab; the timer calls it. */
  probe(): Promise<void> {
    if (!this.probing) {
      this.probing = this.runProbe().finally(() => {
        this.probing = null;
      });
    }
    return this.probing;
  }

  private async runProbe(): Promise<void> {
    if (this.closing || this.state === 'not-configured' || this.state === 'refused' || !this.replica) return;
    try {
      if (!this.replica.isInitialized) {
        try {
          await this.replica.initialize();
          registerDataSourcePoolMetrics('replica', this.replica, this.metrics);
        } catch (error) {
          this.metrics.recordReplicaConnectionFailure();
          throw error;
        }
      }
      if (this.state !== 'validated' || this.now() - this.lastValidatedAt >= REPLICA_REVALIDATE_MS) {
        await this.validate();
      } else if (!(await sameLedgerHead(this.primaryQuery, this.replicaQuery))) {
        this.metrics.recordReplicaValidationFailure();
        this.setState('not-validated');
      }
      if (this.state === 'validated') await this.sampleLag();
      this.metrics.recordReplicaProbe(true);
    } catch (error) {
      this.metrics.recordReplicaProbe(false);
      if (error instanceof ReplicaConfigurationError) {
        this.refuse(error);
        return;
      }
      this.markUnavailable(error);
    } finally {
      this.publish();
    }
  }

  private readonly primaryQuery: ReplicaQuery = (sql, params) => this.primary.query(sql, params);
  private readonly replicaQuery: ReplicaQuery = (sql, params) => {
    if (!this.replica) throw new Error('replica not configured');
    return this.replica.query(sql, params);
  };

  private async validate(): Promise<void> {
    const production = this.options.production ?? isPgProductionEnvironment(this.options.env ?? process.env);
    const result = await validateReplica({ primary: this.primaryQuery, replica: this.replicaQuery, production });
    for (const warning of result.warnings) this.logger.warn(`read replica: ${warning}`);
    if (result.ok) {
      if (this.state !== 'validated') this.logger.log('read replica validated (standby, crewflow_app, same cluster, FORCE RLS, identity, ledger head).');
      this.lastValidatedAt = this.now();
      this.setState('validated');
    } else {
      this.metrics.recordReplicaValidationFailure();
      this.freshness?.markUnknown();
      this.setState('not-validated');
    }
  }

  /** The replica server must hold every API instance's replica pool (only the API uses it). */
  private async checkReplicaBudget(env: Env): Promise<void> {
    const { shape } = readDeploymentShape(env);
    if (!shape || !this.replica) return;
    const poolMax = this.replicaPoolMax(env);
    const capacity = usableCapacity(await readServerCapacity((sql) => this.replica!.query(sql)), shape.providerReserved);
    const needed = shape.apiInstances * poolMax + 1; // the probe uses the pool; +1 for an operator session
    if (needed > capacity) {
      throw new ReplicaConfigurationError('budget', `the API replica pools need up to ${needed} connections but the replica allows ${capacity}.`);
    }
  }

  private async sampleLag(): Promise<void> {
    if (!this.freshness) return;
    const at = this.now(); // taken BEFORE the primary query: conservative (replica-freshness.ts)
    let primaryLsn: bigint | null = null;
    try {
      const [row] = await this.primary.query(PRIMARY_POSITION_SQL);
      primaryLsn = parseLsn(row?.lsn);
    } catch {
      primaryLsn = null; // not permitted / primary in recovery / failed: lag cannot be measured → not fresh
    }
    if (primaryLsn === null) {
      this.freshness.markUnknown();
      this.metrics.setReplicaLag(null, null);
      return;
    }
    this.freshness.recordPrimarySample(primaryLsn, at);
    const [position] = await this.replica!.query(REPLICA_POSITION_SQL);
    if (position?.in_recovery !== true) {
      throw new ReplicaConfigurationError('recovery', 'the replica left recovery (promoted to a writable primary). It is no longer used.');
    }
    const replay = parseLsn(position.replay);
    const receive = parseLsn(position.receive);
    if (replay === null) this.freshness.markUnknown();
    else this.freshness.recordReplay(replay);
    this.metrics.setReplicaLag(this.freshness.lagEstimateMs(), replay !== null && receive !== null && receive >= replay ? Number(receive - replay) : null);
  }

  private refuse(error: ReplicaConfigurationError): void {
    this.metrics.recordReplicaConfigurationFailure();
    this.logger.error(`${error.message} Every read now runs on the primary.`);
    this.freshness?.markUnknown();
    this.setState('refused');
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    void this.replica?.destroy().catch(() => undefined);
  }

  private markUnavailable(error: unknown): void {
    this.freshness?.markUnknown();
    if (this.state !== 'refused' && this.state !== 'not-configured') {
      if (this.state !== 'unavailable') {
        const code = (error as { code?: string } | null)?.code;
        this.logger.warn(`read replica unavailable${code ? ` (SQLSTATE/code ${code})` : ''}; reads use the primary until a probe succeeds.`);
      }
      this.setState('unavailable');
    }
  }

  private setState(state: ReplicaStateName): void {
    this.state = state;
    this.publish();
  }

  private publish(): void {
    this.metrics.setReplicaState(this.state, this.state === 'validated' && (this.freshness?.isFresh() ?? false));
  }

  private startProbe(): void {
    if (this.options.startProbe === false || this.timer) return;
    const interval = this.options.probeIntervalMs ?? Math.min(5_000, Math.max(250, Math.floor(this.maxLagMs / 4)));
    this.timer = setInterval(() => void this.probe(), interval);
    this.timer.unref?.();
  }

  private replicaPoolMax(env: Env): number {
    return this.options.poolMax ?? resolvePgEnvironmentCached(env).pool.max;
  }

  private buildDataSource(url: string, timeoutMs: number, env: Env): DataSource {
    const resolved = resolvePgEnvironmentCached(env);
    // A short connect timeout (2 s, also the pool's wait for a free connection): a slow replica falls back to the primary.
    const request: PgPoolRequest = {
      url,
      urlLabel: 'PG_DATABASE_REPLICA_URL',
      role: 'replica',
      purpose: 'runtime',
      queryTimeoutMs: timeoutMs,
      max: this.replicaPoolMax(env),
      connectTimeoutMs: REPLICA_CONNECT_TIMEOUT_MS,
    };
    // Same entities and logger as the primary (its own options), never its connection fields.
    const core = this.primary.options as PostgresConnectionOptions;
    return createPgDataSource(resolved, request, {
      name: 'crewflow-replica',
      synchronize: false,
      entities: core.entities,
      logging: core.logging,
      logger: core.logger,
      maxQueryExecutionTime: core.maxQueryExecutionTime,
    });
  }
}
