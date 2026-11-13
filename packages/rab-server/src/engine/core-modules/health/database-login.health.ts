import { Inject, Injectable, Logger } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';

import { createPgClient, resolvePgEnvironmentCached } from '../../../database/postgres';

/**
 * /healthz `databaseLogin` (owner decision 2026-11-13, "fix 'API health check stays green when the DB login fails'").
 *
 * Observed live: the runtime login's password changed in the database while rab-api kept running. Every NEW connection
 * then failed with 28P01, but the `database` ping (TypeORM `SELECT 1`) kept succeeding on connections the pool had opened
 * before the change, so /healthz — and with it the container health check — stayed green until the pool happened to need
 * a new connection. This indicator proves the API can still OPEN a session: a dedicated client (never a pool connection)
 * with the runtime pool's own target, login, TLS and startup options (the connection factory, purpose `health`, read-only
 * session), `SELECT 1`, closed at once.
 *
 * Bounded so a public, unauthenticated /healthz can never be used to make the API churn logins:
 *  - single flight: concurrent requests share the one probe in progress;
 *  - cached: a result (up OR down) is reused for DATABASE_LOGIN_PROBE_CACHE_MS, so at most one login every 5 s whatever
 *    the request rate (the container check runs every 10 s and therefore always gets a fresh reading);
 *  - deadline: connect 2.5 s, query 1.5 s and the whole probe 3 s (inside the container check's 5 s timeout); a probe
 *    still running at the deadline is reported down and its client is closed.
 * Never exposes details: the response carries only `status` and the fixed text below — no URL, host, user, SQLSTATE or
 * driver message. The server log gets one line per CHANGE of state with the SQLSTATE class only (e.g. 28P01), never the
 * driver's message (it names the login).
 *
 * Twenty (twentyhq/twenty; checked at a6372e28 — eedb0a73 is not in the local reference clone) keeps /healthz itself
 * empty (packages/twenty-server/src/engine/core-modules/health/controllers/health.controller.ts:12-17) and checks the
 * database only in the admin panel, through the POOLED DataSource
 * (packages/twenty-server/src/engine/core-modules/admin-panel/indicators/database.health.ts:39-74), with a 3 s deadline
 * (admin-panel/utils/health-check-timeout.util.ts:4-13, admin-panel/constants/health-indicators-timeout.conts.ts:1) and
 * fixed failure texts (database.health.ts:105-122, admin-panel/constants/health-error-messages.constants.ts:4-6). The
 * deadline and the fixed texts are matched here; the fresh login is ours (a pooled query cannot see a revoked login).
 */
export const DATABASE_LOGIN_KEY = 'databaseLogin';
export const DATABASE_LOGIN_DOWN_MESSAGE = 'database login failed';
export const DATABASE_LOGIN_PROBE_CACHE_MS = 5_000;
export const DATABASE_LOGIN_PROBE_DEADLINE_MS = 3_000;
const CONNECT_TIMEOUT_MS = 2_500;
const QUERY_TIMEOUT_MS = 1_500;

/** The slice of a pg Client the probe uses. */
export interface DatabaseLoginProbeClient {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  end(): Promise<unknown>;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export const DATABASE_LOGIN_PROBE_CLIENT = Symbol('DATABASE_LOGIN_PROBE_CLIENT');
export type DatabaseLoginProbeClientFactory = () => DatabaseLoginProbeClient;

/** Production factory: one dedicated client, the runtime pool's own connection settings (never a pool checkout). */
export const createDatabaseLoginProbeClient: DatabaseLoginProbeClientFactory = () =>
  createPgClient(resolvePgEnvironmentCached(process.env), {
    endpoint: 'primary',
    purpose: 'health',
    readOnly: true,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    statementTimeoutMs: QUERY_TIMEOUT_MS,
    queryTimeoutMs: QUERY_TIMEOUT_MS,
  });

/** What failed, for the server log only: the SQLSTATE when it is one (e.g. 28P01), else a fixed word. Never a message. */
function failureCode(error: unknown): string {
  if (error === DEADLINE) return 'timeout';
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'connection-error';
}

const DEADLINE = Symbol('deadline');

@Injectable()
export class DatabaseLoginHealthIndicator {
  private readonly logger = new Logger('DatabaseLoginHealth');
  private last: { ok: boolean; at: number } | null = null;
  private inFlight: Promise<boolean> | null = null;

  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    @Inject(DATABASE_LOGIN_PROBE_CLIENT) private readonly createClient: DatabaseLoginProbeClientFactory,
  ) {}

  async isHealthy(): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(DATABASE_LOGIN_KEY);
    return (await this.canLogIn()) ? indicator.up() : indicator.down({ message: DATABASE_LOGIN_DOWN_MESSAGE });
  }

  /** Cached, single-flight result of a fresh login. Never rejects. */
  canLogIn(): Promise<boolean> {
    if (this.last && Date.now() - this.last.at < DATABASE_LOGIN_PROBE_CACHE_MS) return Promise.resolve(this.last.ok);
    if (!this.inFlight) {
      this.inFlight = this.probe().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async probe(): Promise<boolean> {
    let ok = false;
    let code = '';
    try {
      await this.loginOnce();
      ok = true;
    } catch (error) {
      code = failureCode(error);
    }
    const previous = this.last?.ok;
    this.last = { ok, at: Date.now() };
    if (!ok && previous !== false) this.logger.error(`a new database connection could not be opened (${code}); /healthz reports databaseLogin down`);
    if (ok && previous === false) this.logger.log('a new database connection opened again; /healthz reports databaseLogin up');
    return ok;
  }

  private async loginOnce(): Promise<void> {
    let client: DatabaseLoginProbeClient | null = null;
    let timer: NodeJS.Timeout | undefined;
    try {
      client = this.createClient();
      // A dedicated client with no listener would turn a late socket error into an uncaught 'error' event.
      client.on('error', () => undefined);
      const opened = client;
      const work = (async () => {
        await opened.connect();
        await opened.query('SELECT 1');
      })();
      work.catch(() => undefined); // abandoned at the deadline: never an unhandled rejection
      await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(DEADLINE), DATABASE_LOGIN_PROBE_DEADLINE_MS);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      // Bounded close: end() on a dead socket can wait; the probe's answer never does.
      if (client) void client.end().catch(() => undefined);
    }
  }
}
