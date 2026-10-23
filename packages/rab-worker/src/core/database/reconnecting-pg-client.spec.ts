import { EventEmitter } from 'node:events';
import { Client } from 'pg';

import { DatabaseReconnectDeferredError, ReconnectingPgClient } from './reconnecting-pg-client';

/** W6-E2E-05 unit coverage: error listener always present, reconnect on the next acquire, bounded exponential backoff. */
class FakeClient extends EventEmitter {
  ended = 0;
  constructor(private readonly behaviour: { failConnect?: Error }) {
    super();
  }
  async connect(): Promise<void> {
    if (this.behaviour.failConnect) throw this.behaviour.failConnect;
  }
  async end(): Promise<void> {
    this.ended += 1;
  }
}

function setup(plan: Array<{ failConnect?: Error }>) {
  let now = 1_000_000;
  const created: FakeClient[] = [];
  const logs: string[] = [];
  const holder = new ReconnectingPgClient(
    { connectionString: 'postgres://unused' },
    {
      label: 'provisioning',
      logger: { log: (m) => logs.push(`log ${m}`), warn: (m) => logs.push(`warn ${m}`) },
      initialBackoffMs: 1_000,
      maxBackoffMs: 8_000,
      now: () => now,
      createClient: () => {
        const c = new FakeClient(plan[created.length] ?? {});
        created.push(c);
        return c as unknown as Client;
      },
    },
  );
  return { holder, created, logs, advance: (ms: number) => (now += ms) };
}

const terminated = Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });

describe('ReconnectingPgClient (W6-E2E-05)', () => {
  it('reuses the connected client while it is healthy', async () => {
    const { holder, created } = setup([{}]);
    const a = await holder.acquire();
    const b = await holder.acquire();
    expect(a).toBe(b);
    expect(created).toHaveLength(1);
    expect(holder.healthy).toBe(true);
  });

  it("a server-side 'error' never escapes as an unhandled event; the next acquire reconnects", async () => {
    const { holder, created, logs } = setup([{}, {}]);
    await holder.acquire();
    expect(created[0]!.listenerCount('error')).toBeGreaterThan(0);
    // EventEmitter#emit('error') throws when nobody listens — this call returning proves the listener exists.
    expect(() => created[0]!.emit('error', terminated)).not.toThrow();
    expect(holder.healthy).toBe(false);
    expect(logs.join('\n')).toMatch(/provisioning database connection lost \(57P01: terminating connection/);

    const again = await holder.acquire();
    expect(again).toBe(created[1]);
    expect(created[0]!.ended).toBe(1); // the dead client is released
    expect(logs.join('\n')).toMatch(/provisioning database connection re-established/);
  });

  it("an unexpected 'end' (no error event) also marks the client broken", async () => {
    const { holder, created } = setup([{}, {}]);
    await holder.acquire();
    created[0]!.emit('end');
    expect(holder.healthy).toBe(false);
    expect(await holder.acquire()).toBe(created[1]);
  });

  it('failed reconnects back off exponentially (bounded) and fail fast inside the window', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const { holder, created, advance } = setup([{}, { failConnect: refused }, { failConnect: refused }, { failConnect: refused }, { failConnect: refused }, { failConnect: refused }, {}]);
    await holder.acquire();
    created[0]!.emit('error', terminated);

    await expect(holder.acquire()).rejects.toThrow('ECONNREFUSED'); // attempt 1 → backoff 1 s
    await expect(holder.acquire()).rejects.toBeInstanceOf(DatabaseReconnectDeferredError);
    expect(created).toHaveLength(2); // no new attempt inside the window

    const expected = [2_000, 4_000, 8_000, 8_000]; // after attempts 2..5 (capped at maxBackoffMs)
    advance(1_000);
    for (const backoff of expected) {
      await expect(holder.acquire()).rejects.toThrow('ECONNREFUSED');
      advance(backoff - 1);
      const deferred = await holder.acquire().catch((e) => e);
      expect(deferred).toBeInstanceOf(DatabaseReconnectDeferredError);
      expect((deferred as DatabaseReconnectDeferredError).retryInMs).toBe(1);
      advance(1);
    }
    expect(holder.consecutiveFailures).toBe(5);
    const client = await holder.acquire();
    expect(client).toBe(created[6]);
    expect(holder.consecutiveFailures).toBe(0);
    // Every failed attempt's client was closed, never leaked.
    for (const c of created.slice(1, 6)) expect(c.ended).toBe(1);
  });

  it('close() ends the client and refuses further acquires', async () => {
    const { holder, created } = setup([{}]);
    await holder.acquire();
    await holder.close();
    expect(created[0]!.ended).toBe(1);
    await expect(holder.acquire()).rejects.toThrow(/closed/);
  });
});
