/**
 * Phase B (P4): live check that a connection is SESSION-stable, run by the Worker at boot before it takes any session
 * advisory lock. PG_DATABASE_URL_IS_DIRECT=true does not skip it.
 *
 * Why: a session advisory lock belongs to one server backend. Behind a transaction-mode pooler (PgBouncer, Supavisor
 * :6543, Neon -pooler, a DigitalOcean pool, RDS Proxy) one client connection is served by different backends from one
 * transaction to the next, so a lock can be taken on one backend, "released" on another (a no-op plus a warning) and
 * leaked, or re-entered by a second client that happens to land on the holder's backend. The URL denylist
 * (pg-url-policy.ts) catches documented shapes; this probe catches the rest by behaviour.
 *
 * Steps, on two dedicated connections A and B (never pool connections):
 *   1. A reports pg_backend_pid() in two separate transactions: it must be the same backend both times;
 *   2. B reports its pid: it must be a different backend from A;
 *   3. A takes pg_advisory_lock(k) (k random per probe, so concurrent replicas never collide), then reports its pid in a
 *      third transaction: still the same backend;
 *   4. B's pg_try_advisory_lock(k) must return false, and pg_locks must show k granted to A's pid and nobody else;
 *   5. A's pg_advisory_unlock(k) must return true (it ran on the holder), and pg_locks must then show k gone.
 * Any deviation refuses the start. Errors carry no URL or credential.
 *
 * This is strong evidence, not proof: a pooler that happens to give A the same backend every time during the probe
 * (for example an idle PgBouncer with a single server connection free) could pass steps 1, 3 and 5; step 2 and 4 then
 * usually fail because B shares or contends for that backend, but a pooler with exactly the right timing could still
 * pass. That is why the URL denylist and the probe are both kept, and why a pooler must never be configured on purpose.
 */
import { randomBytes } from 'crypto';

import { Client, ClientConfig } from 'pg';

export class PgSessionProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PgSessionProbeError';
  }
}

export interface PgProbeClient {
  connect(): Promise<unknown>;
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
  end(): Promise<unknown>;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface PgSessionProbeResult {
  pidA: number;
  pidB: number;
}

export interface PgSessionProbeOptions {
  /** Test seam: builds each connection (default `new Client(config)`). */
  createClient?: (config: ClientConfig) => PgProbeClient;
  /** Test seam: the 62-bit lock key as [high 30 bits, low 32 bits]. */
  key?: [number, number];
  /** Named in refusals, e.g. 'worker lock connection'. */
  label?: string;
}

function randomKey(): [number, number] {
  const bytes = randomBytes(8);
  return [bytes.readUInt32BE(0) & 0x3fffffff, bytes.readUInt32BE(4)];
}

async function pidInOwnTransaction(client: PgProbeClient): Promise<number> {
  await client.query('BEGIN');
  try {
    const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    await client.query('COMMIT');
    return Number(rows[0]?.pid);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/** Runs the probe and closes both connections. Throws PgSessionProbeError when the connection is not session-stable. */
export async function probePgSessionAffinity(config: ClientConfig, options: PgSessionProbeOptions = {}): Promise<PgSessionProbeResult> {
  const label = options.label ?? 'database connection';
  const create = options.createClient ?? ((c: ClientConfig) => new Client(c) as unknown as PgProbeClient);
  const [high, low] = options.key ?? randomKey();
  const key = (BigInt(high) << 32n) | BigInt(low);
  const refuse = (why: string): never => {
    throw new PgSessionProbeError(
      `${label} is not session-stable (${why}). Session advisory locks need a direct connection, not a transaction pooler. Refusing to start.`,
    );
  };
  const holders = async (client: PgProbeClient): Promise<number[]> =>
    (
      await client.query<{ pid: number }>(
        `SELECT pid FROM pg_catalog.pg_locks WHERE locktype = 'advisory' AND granted AND classid = $1::oid AND objid = $2::oid AND objsubid = 1`,
        [high, low],
      )
    ).rows.map((r) => Number(r.pid));

  const a = create(config);
  const b = create(config);
  a.on('error', () => undefined);
  b.on('error', () => undefined);
  try {
    try {
      await a.connect();
      await b.connect();
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'unknown';
      throw new PgSessionProbeError(`cannot open the two ${label} probe connections (driver code ${code}). Refusing to start.`);
    }

    const pidA = await pidInOwnTransaction(a);
    if ((await pidInOwnTransaction(a)) !== pidA) refuse('connection A changed backend between two transactions');
    const pidB = Number((await b.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid);
    if (pidB === pidA) refuse('two separate connections share one backend');

    await a.query('SELECT pg_advisory_lock($1::bigint)', [key.toString()]);
    let locked = true;
    try {
      if ((await pidInOwnTransaction(a)) !== pidA) refuse('connection A changed backend after taking a session lock');
      const tried = (await b.query<{ got: boolean }>('SELECT pg_try_advisory_lock($1::bigint) AS got', [key.toString()])).rows[0]?.got;
      if (tried !== false) {
        await b.query('SELECT pg_advisory_unlock($1::bigint)', [key.toString()]).catch(() => undefined);
        refuse('a second connection could take a session lock the first one holds');
      }
      const held = await holders(b);
      if (held.length !== 1 || held[0] !== pidA) refuse('pg_locks does not show the session lock held by connection A\'s backend');
      const released = (await a.query<{ released: boolean }>('SELECT pg_advisory_unlock($1::bigint) AS released', [key.toString()])).rows[0]?.released;
      locked = false;
      if (released !== true) refuse('the unlock did not reach the backend holding the lock');
      if ((await holders(b)).length !== 0) refuse('the session lock is still held after it was released');
    } finally {
      if (locked) await a.query('SELECT pg_advisory_unlock($1::bigint)', [key.toString()]).catch(() => undefined);
    }
    return { pidA, pidB };
  } catch (error) {
    if (error instanceof PgSessionProbeError) throw error;
    const code = (error as { code?: string }).code ?? 'unknown';
    throw new PgSessionProbeError(`the ${label} session probe failed (driver code ${code}). Refusing to start.`);
  } finally {
    // Ending a session releases any session lock it still holds.
    await Promise.all([a.end().catch(() => undefined), b.end().catch(() => undefined)]);
  }
}
