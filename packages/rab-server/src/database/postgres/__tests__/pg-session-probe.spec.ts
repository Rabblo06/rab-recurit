import { PgProbeClient, probePgSessionAffinity, PgSessionProbeError } from '../pg-session-probe';

// Phase B (P4): the probe's logic against a small in-memory model of PostgreSQL backends. "direct" gives every client its
// own backend for its whole life; "pooler" models a transaction-mode pooler: a client is bound to a backend only for the
// length of an explicit transaction, and each statement outside one goes to the next backend (round robin).
// The real-database check is in pg-session-probe.integration.spec.ts.

interface Backend {
  pid: number;
}

function model(mode: 'direct' | 'pooler', serverConnections = 1) {
  const backends: Backend[] = Array.from({ length: serverConnections }, (_, i) => ({ pid: 1000 + i }));
  const locks = new Map<string, { pid: number; count: number }>();
  let nextDirectPid = 2000;
  let rr = 0;

  const create = (): PgProbeClient => {
    const own: Backend | null = mode === 'direct' ? { pid: nextDirectPid++ } : null;
    let pinned: Backend | null = null;
    const backend = (): Backend => own ?? pinned ?? backends[rr++ % backends.length]!;
    return {
      connect: async () => undefined,
      end: async () => {
        if (own) for (const [k, v] of locks) if (v.pid === own.pid) locks.delete(k);
      },
      on: () => undefined,
      query: async <R>(sql: string, params: unknown[] = []): Promise<{ rows: R[] }> => {
        const rows = (r: unknown[]) => ({ rows: r as R[] });
        if (sql === 'BEGIN') {
          if (!own) pinned = backend();
          return rows([]);
        }
        if (sql === 'COMMIT' || sql === 'ROLLBACK') {
          pinned = null;
          return rows([]);
        }
        const b = backend();
        if (sql.includes('pg_backend_pid')) return rows([{ pid: b.pid }]);
        const key = String(params[0]);
        if (sql.includes('pg_try_advisory_lock')) {
          const held = locks.get(key);
          if (!held) {
            locks.set(key, { pid: b.pid, count: 1 });
            return rows([{ got: true }]);
          }
          if (held.pid === b.pid) {
            held.count += 1;
            return rows([{ got: true }]);
          }
          return rows([{ got: false }]);
        }
        if (sql.includes('pg_advisory_lock')) {
          const held = locks.get(key);
          if (held && held.pid !== b.pid) throw Object.assign(new Error('would block'), { code: '57014' });
          locks.set(key, { pid: b.pid, count: (held?.count ?? 0) + 1 });
          return rows([{}]);
        }
        if (sql.includes('pg_advisory_unlock')) {
          const held = locks.get(key);
          if (!held || held.pid !== b.pid) return rows([{ released: false }]);
          held.count -= 1;
          if (held.count === 0) locks.delete(key);
          return rows([{ released: true }]);
        }
        if (sql.includes('pg_locks')) {
          const k = ((BigInt(params[0] as number) << 32n) | BigInt(params[1] as number)).toString();
          const held = locks.get(k);
          return rows(held ? [{ pid: held.pid }] : []);
        }
        throw new Error(`unexpected SQL in the model: ${sql}`);
      },
    };
  };
  return { create, locks };
}

describe('pg-session-probe (model)', () => {
  it('passes on direct connections and leaves no lock behind', async () => {
    const m = model('direct');
    const result = await probePgSessionAffinity({}, { createClient: m.create, key: [7, 9] });
    expect(result.pidA).not.toBe(result.pidB);
    expect(m.locks.size).toBe(0);
  });

  it('refuses a transaction pooler with one server connection (both clients share a backend)', async () => {
    const m = model('pooler', 1);
    await expect(probePgSessionAffinity({}, { createClient: m.create, key: [7, 9], label: 'the lock connection' })).rejects.toThrow(
      /the lock connection is not session-stable \(two separate connections share one backend\)/,
    );
  });

  it.each([2, 3, 5])('refuses a transaction pooler with %i server connections', async (n) => {
    const m = model('pooler', n);
    await expect(probePgSessionAffinity({}, { createClient: m.create, key: [7, 9] })).rejects.toBeInstanceOf(PgSessionProbeError);
  });

  it('a connection failure refuses with the driver code only', async () => {
    const failing = (): PgProbeClient => ({
      connect: async () => {
        throw Object.assign(new Error('password authentication failed for user "secretuser"'), { code: '28P01' });
      },
      query: async () => ({ rows: [] }),
      end: async () => undefined,
      on: () => undefined,
    });
    const error = await probePgSessionAffinity({}, { createClient: failing }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(PgSessionProbeError);
    expect((error as Error).message).toMatch(/driver code 28P01/);
    expect((error as Error).message).not.toMatch(/secretuser/);
  });
});
