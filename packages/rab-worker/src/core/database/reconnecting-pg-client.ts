import { Client, ClientConfig } from 'pg';

/**
 * W6-E2E-05: a long-lived, single `pg` connection that survives the database going away.
 *
 * A bare `pg.Client` emits an 'error' event when its server session dies outside a query (Postgres restart or failover,
 * `pg_terminate_backend`, an idle-connection kill by a managed provider, a network drop). With no listener, Node turns that
 * event into an uncaught exception and the whole process exits — which, inside the Worker bundle, fails the jobs process
 * too. This wrapper:
 *
 *  - always has an 'error' listener on the current client, so a dropped session is logged and marked broken, never thrown;
 *  - hands out the current client from `acquire()`, replacing a broken (or ended) one with a fresh connection;
 *  - bounds reconnect attempts with exponential backoff (`initialBackoffMs` doubling up to `maxBackoffMs`): while the
 *    backoff window is open, `acquire()` fails fast with `DatabaseReconnectDeferredError` instead of hammering a database
 *    that is still restarting. The caller's periodic cycle simply fails that tick (counted, logged) and retries on the next.
 *
 * It never retries a query itself: a cycle interrupted by a dropped connection fails as a whole and the next cycle starts
 * from durable state (the provisioning job's lifecycle states and session advisory lock are designed for exactly that —
 * the lock is released by the server when the session dies).
 */
export class DatabaseReconnectDeferredError extends Error {
  constructor(readonly retryInMs: number) {
    super(`database reconnect deferred for ${retryInMs} ms (backoff after a lost connection)`);
    this.name = 'DatabaseReconnectDeferredError';
  }
}

export interface ReconnectingPgClientLogger {
  log(message: string): void;
  warn(message: string): void;
}

export interface ReconnectingPgClientOptions {
  /** Log prefix, e.g. `provisioning` → "provisioning database connection lost (...)". Never the connection string. */
  label: string;
  logger: ReconnectingPgClientLogger;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** Test seam. */
  now?: () => number;
  /** Test seam: builds the underlying client (defaults to `new Client(config)`). */
  createClient?: (config: ClientConfig) => Client;
}

export class ReconnectingPgClient {
  private client: Client | null = null;
  private broken = false;
  private closed = false;
  private failures = 0;
  private nextAttemptAt = 0;
  private everConnected = false;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;
  private readonly createClient: (config: ClientConfig) => Client;

  constructor(
    private readonly config: ClientConfig,
    private readonly options: ReconnectingPgClientOptions,
  ) {
    this.initialBackoffMs = options.initialBackoffMs ?? 1_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.createClient = options.createClient ?? ((c) => new Client(c));
  }

  /** True when a connected, unbroken client is held (no I/O). */
  get healthy(): boolean {
    return this.client !== null && !this.broken;
  }

  /** Number of consecutive failed connection attempts (0 once connected). */
  get consecutiveFailures(): number {
    return this.failures;
  }

  /**
   * Returns a connected client, reconnecting first if the previous one was lost. Throws `DatabaseReconnectDeferredError`
   * while a backoff window is open, or the connection error itself when an attempt fails.
   */
  async acquire(): Promise<Client> {
    if (this.closed) throw new Error(`${this.options.label} database connection is closed (shutting down)`);
    if (this.client && !this.broken) return this.client;
    if (this.client) await this.discard();
    const wait = this.nextAttemptAt - this.now();
    if (wait > 0) throw new DatabaseReconnectDeferredError(wait);

    const client = this.createClient(this.config);
    // Attached BEFORE connect(): an error during or after the handshake must never be an unhandled event.
    client.on('error', (error: Error & { code?: string }) => this.onClientError(client, error));
    client.on('end', () => {
      if (this.client === client && !this.closed) this.broken = true;
    });
    try {
      await client.connect();
    } catch (error) {
      this.failures += 1;
      const backoff = Math.min(this.maxBackoffMs, this.initialBackoffMs * 2 ** Math.min(this.failures - 1, 16));
      this.nextAttemptAt = this.now() + backoff;
      await client.end().catch(() => undefined);
      this.options.logger.warn(
        `${this.options.label} database connection attempt ${this.failures} failed (${describe(error)}); next attempt in ${backoff} ms`,
      );
      throw error;
    }
    if (this.everConnected) this.options.logger.log(`${this.options.label} database connection re-established`);
    this.everConnected = true;
    this.failures = 0;
    this.nextAttemptAt = 0;
    this.client = client;
    this.broken = false;
    return client;
  }

  /** Closes the current client (shutdown). Idempotent; never throws. */
  async close(): Promise<void> {
    this.closed = true;
    await this.discard();
  }

  private onClientError(client: Client, error: Error & { code?: string }): void {
    if (client !== this.client) return; // a client already discarded
    if (!this.broken) {
      this.options.logger.warn(`${this.options.label} database connection lost (${describe(error)}); reconnecting on the next cycle`);
    }
    this.broken = true;
  }

  private async discard(): Promise<void> {
    const old = this.client;
    this.client = null;
    this.broken = false;
    if (old) await old.end().catch(() => undefined);
  }
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code ? `${code}: ${error.message}` : error.message;
}
