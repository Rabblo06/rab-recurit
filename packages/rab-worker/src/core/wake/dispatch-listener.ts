import { DispatchQueue, isDispatchQueue } from '../database/dispatch-claims';

/**
 * Phase D (D2, `WORKER_DISPATCH_MODE=event`) — the LISTEN side of the wake-up hint.
 *
 * The pointer triggers issue `pg_notify('crewflow_worker_wake', '<queue label>')`; PostgreSQL delivers it only after the
 * producer's transaction COMMITS, and drops it on rollback. A notification is a HINT ONLY: rows are the truth, the
 * payload carries nothing but a queue label (any login can LISTEN/NOTIFY on any channel, so it must never carry ids or
 * tenant data), and an unknown payload is ignored. A forged NOTIFY causes at most one extra, debounced, bounded claim.
 *
 * Notifications are not queued for a disconnected listener, so after EVERY (re)connect this re-issues LISTEN on the new
 * session and runs a catch-up (`onConnected` → one claim per queue). The coordinator's backstop tick
 * (WORKER_DISPATCH_BACKSTOP_SECONDS) runs regardless, so a lost notification or a listener outage delays work by at most
 * one backstop interval — never loses it.
 *
 * Connection: ONE dedicated long-lived session per Worker replica (the connection budget's listener row), built by
 * main.ts on the factory's direct `lock` endpoint (session-affine; a transaction pooler would drop LISTEN state) as a
 * `ReconnectingPgClient`. The session's identity is verified on every new session before LISTEN.
 */
export const WORKER_WAKE_CHANNEL = 'crewflow_worker_wake';
const LISTEN_SQL = `LISTEN ${WORKER_WAKE_CHANNEL}`;

/** Exactly one of the four queue labels, nothing else (no ids, no JSON, no whitespace). */
export function parseWakePayload(payload: unknown): DispatchQueue | null {
  return isDispatchQueue(payload) ? payload : null;
}

/** The subset of `pg.Client` the listener uses ('notification', 'error', 'end' events). */
export interface WakeClient {
  query(sql: string): Promise<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
}

/** The subset of `ReconnectingPgClient` the listener uses (reconnect + backoff live there). */
export interface WakeConnection<C extends WakeClient = WakeClient> {
  acquire(): Promise<C>;
  close(): Promise<void>;
}

export interface DispatchWakeListenerOptions<C extends WakeClient> {
  onWake: (queue: DispatchQueue) => void;
  /** Called after every successful LISTEN on a new session (first connect and every reconnect): run the catch-up. */
  onConnected: () => void;
  /** Proves the new session's identity before LISTEN (main.ts: the runtime role guard on a pg shim). Throws to refuse. */
  verifyIdentity: (client: C) => Promise<void>;
  logger: { log(message: string): void; warn(message: string): void };
  /** How often the session is re-checked (reconnect + re-LISTEN after a loss). 0 = no timer (tests). Default 5000. */
  ensureIntervalMs?: number;
}

export class DispatchWakeListener<C extends WakeClient = WakeClient> {
  private current: C | null = null;
  private handlers: { notification: (m: { channel: string; payload?: string }) => void; lost: () => void } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ensuring: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly connection: WakeConnection<C>,
    private readonly options: DispatchWakeListenerOptions<C>,
  ) {}

  /** True while a verified session holds an active LISTEN. */
  get listening(): boolean {
    return this.current !== null;
  }

  /** First connect: verify + LISTEN + catch-up. Throws (boot refuses) if that fails. Then starts the re-check timer. */
  async start(): Promise<void> {
    await this.connectIfNeeded();
    const every = this.options.ensureIntervalMs ?? 5_000;
    if (every > 0 && !this.timer) {
      this.timer = setInterval(() => void this.ensure(), every);
      this.timer.unref?.();
    }
  }

  /** Re-checks the session: a lost one is replaced, re-LISTENed and caught up. Never throws (timer path). */
  ensure(): Promise<void> {
    this.ensuring ??= this.connectIfNeeded()
      .catch((error: Error) => {
        this.options.logger.warn(`wake listener: (re)connect failed (${error.name}: ${error.message}); retrying, backstop claims continue`);
      })
      .finally(() => {
        this.ensuring = null;
      });
    return this.ensuring;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.detach();
    await this.connection.close();
  }

  private async connectIfNeeded(): Promise<void> {
    if (this.stopped) return;
    const client = await this.connection.acquire();
    if (client === this.current) return;
    // A new session: the previous one (if any) is gone together with its LISTEN state.
    this.detach();
    await this.options.verifyIdentity(client);
    const notification = (message: { channel: string; payload?: string }) => {
      if (this.stopped || this.current !== client || message.channel !== WORKER_WAKE_CHANNEL) return;
      const queue = parseWakePayload(message.payload);
      if (queue) this.options.onWake(queue);
    };
    const lost = () => {
      if (this.current !== client) return;
      this.detach();
      // Re-establish promptly (ReconnectingPgClient applies its own backoff); the timer retries if this attempt fails.
      if (!this.stopped) setImmediate(() => void this.ensure());
    };
    client.on('notification', notification);
    client.on('error', lost);
    client.on('end', lost);
    try {
      await client.query(LISTEN_SQL);
    } catch (error) {
      client.removeListener('notification', notification);
      client.removeListener('error', lost);
      client.removeListener('end', lost);
      throw error;
    }
    this.current = client;
    this.handlers = { notification, lost };
    this.options.onConnected();
  }

  private detach(): void {
    const client = this.current;
    const handlers = this.handlers;
    this.current = null;
    this.handlers = null;
    if (client && handlers) {
      client.removeListener('notification', handlers.notification);
      client.removeListener('error', handlers.lost);
      client.removeListener('end', handlers.lost);
    }
  }
}
