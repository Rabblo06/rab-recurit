import { EventEmitter } from 'node:events';

import { DispatchWakeListener, parseWakePayload, WORKER_WAKE_CHANNEL } from './dispatch-listener';

/**
 * Phase D (D2): the LISTEN side of the wake-up hint. A fake connection stands in for ReconnectingPgClient (whose own
 * reconnect/backoff behaviour has its own spec): the listener must LISTEN on every new session, run a catch-up after
 * every (re)connect (notifications sent while disconnected are lost), and treat the payload as a queue label only.
 */
class FakeClient extends EventEmitter {
  readonly queries: string[] = [];
  failListen = false;
  async query(sql: string): Promise<{ rows: unknown[] }> {
    this.queries.push(sql);
    if (this.failListen && sql.startsWith('LISTEN')) throw new Error('listen failed');
    return { rows: [] };
  }
  notify(channel: string, payload?: string): void {
    this.emit('notification', { channel, payload, processId: 1 });
  }
}

class FakeConnection {
  current: FakeClient | null = null;
  broken = false;
  closed = false;
  connects = 0;
  failNext = false;
  async acquire(): Promise<FakeClient> {
    if (this.closed) throw new Error('closed');
    if (this.current && !this.broken) return this.current;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('connect refused');
    }
    this.connects += 1;
    this.current = new FakeClient();
    this.broken = false;
    return this.current;
  }
  /** Simulates the server session dying (failover, pg_terminate_backend, network drop). */
  drop(): void {
    this.broken = true;
    this.current?.emit('error', new Error('terminated'));
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

const logger = { log: jest.fn(), warn: jest.fn() };

function setup() {
  const connection = new FakeConnection();
  const woken: string[] = [];
  const connected = jest.fn();
  const verify = jest.fn(async () => undefined);
  const listener = new DispatchWakeListener(connection, {
    onWake: (queue) => woken.push(queue),
    onConnected: connected,
    verifyIdentity: verify,
    logger,
    ensureIntervalMs: 0, // no timer in unit tests: ensure() is driven by hand
  });
  return { connection, woken, connected, verify, listener };
}

describe('parseWakePayload', () => {
  it('accepts exactly the four queue labels; anything else (ids, JSON, empty) is ignored — the payload is a hint, never data', () => {
    expect(['email', 'push', 'realtime', 'statement'].map(parseWakePayload)).toEqual(['email', 'push', 'realtime', 'statement']);
    for (const bad of ['', undefined, 'EMAIL', 'email ', 'email:00000000-0000-4000-8000-000000000001', '{"queue":"email"}', 'statements']) {
      expect(parseWakePayload(bad)).toBeNull();
    }
  });
});

describe('DispatchWakeListener', () => {
  it('start(): verifies the session identity, LISTENs on crewflow_worker_wake and runs one catch-up', async () => {
    const { connection, connected, verify, listener } = setup();
    await listener.start();
    expect(WORKER_WAKE_CHANNEL).toBe('crewflow_worker_wake');
    expect(verify).toHaveBeenCalledTimes(1);
    expect(connection.current!.queries).toEqual(['LISTEN crewflow_worker_wake']);
    expect(connected).toHaveBeenCalledTimes(1);
  });

  it('start() fails closed when the first LISTEN fails (boot refuses rather than silently running without wake-ups)', async () => {
    const connection = new FakeConnection();
    const original = connection.acquire.bind(connection);
    connection.acquire = async () => {
      const c = await original();
      c.failListen = true;
      return c;
    };
    const listener = new DispatchWakeListener(connection, { onWake: jest.fn(), onConnected: jest.fn(), verifyIdentity: async () => undefined, logger, ensureIntervalMs: 0 });
    await expect(listener.start()).rejects.toThrow('listen failed');
  });

  it('routes a notification on the channel to onWake(queue); other channels and bad payloads are ignored', async () => {
    const { connection, woken, listener } = setup();
    await listener.start();
    connection.current!.notify(WORKER_WAKE_CHANNEL, 'email');
    connection.current!.notify(WORKER_WAKE_CHANNEL, 'realtime');
    connection.current!.notify('another_channel', 'email');
    connection.current!.notify(WORKER_WAKE_CHANNEL, 'not-a-queue');
    expect(woken).toEqual(['email', 'realtime']);
  });

  it('after the session is lost: re-LISTEN on the NEW session, verify it again, and run a catch-up claim', async () => {
    const { connection, woken, connected, verify, listener } = setup();
    await listener.start();
    const first = connection.current!;
    connection.drop();
    await listener.ensure();
    const second = connection.current!;
    expect(second).not.toBe(first);
    expect(second.queries).toEqual(['LISTEN crewflow_worker_wake']);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(connected).toHaveBeenCalledTimes(2);
    // Only the live session's notifications count; the dead one is detached.
    first.notify(WORKER_WAKE_CHANNEL, 'push');
    second.notify(WORKER_WAKE_CHANNEL, 'statement');
    expect(woken).toEqual(['statement']);
  });

  it('ensure() on a healthy session is a no-op (no second LISTEN, no extra catch-up)', async () => {
    const { connection, connected, listener } = setup();
    await listener.start();
    await listener.ensure();
    await listener.ensure();
    expect(connection.connects).toBe(1);
    expect(connection.current!.queries).toEqual(['LISTEN crewflow_worker_wake']);
    expect(connected).toHaveBeenCalledTimes(1);
  });

  it('a failed reconnect is logged and retried by the next ensure(); it never throws out of the timer path', async () => {
    const { connection, connected, listener } = setup();
    await listener.start();
    connection.drop();
    connection.failNext = true;
    await expect(listener.ensure()).resolves.toBeUndefined();
    expect(listener.listening).toBe(false);
    await listener.ensure();
    expect(listener.listening).toBe(true);
    expect(connected).toHaveBeenCalledTimes(2);
  });

  it('stop() closes the session and ignores later notifications', async () => {
    const { connection, woken, listener } = setup();
    await listener.start();
    const client = connection.current!;
    await listener.stop();
    expect(connection.closed).toBe(true);
    client.notify(WORKER_WAKE_CHANNEL, 'email');
    expect(woken).toEqual([]);
  });
});
