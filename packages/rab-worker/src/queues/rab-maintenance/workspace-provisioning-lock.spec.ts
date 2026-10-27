import { Client } from 'pg';

import { PROVISIONING_LOCK_WAIT_MS, runWorkspaceProvisioningCycle, tryAcquireProvisioningLock } from './workspace-provisioning.job';

/**
 * Phase A (pa-provisioner): the provisioning session lock is acquired with a bounded, non-blocking try-lock loop instead of
 * an unbounded `pg_advisory_lock` wait, and is always released after a cycle that took it. Fake clients and a fake clock:
 * no database. The real-database behaviour (another session holding the lock) is in
 * __tests__/integration/workspace-provisioner-optin.integration.spec.ts.
 */
type Query = { text: string; values?: unknown[] };

function fakeClient(lockResults: boolean[], candidates: string[] = []) {
  const queries: Query[] = [];
  const client = {
    query: jest.fn(async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      if (/pg_try_advisory_lock/.test(text)) return { rows: [{ locked: lockResults.length > 0 ? lockResults.shift() : false }] };
      if (/worker_list_pending_workspace_schemas/.test(text)) return { rows: candidates.map((workspace_id) => ({ workspace_id })) };
      if (/pg_advisory_unlock/.test(text)) return { rows: [{ pg_advisory_unlock: true }] };
      throw new Error(`unexpected query: ${text}`);
    }),
  };
  return { client: client as unknown as Client, queries };
}

function fakeClock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), advance: (ms: number) => void (t += ms) };
}

describe('provisioning lock (Phase A)', () => {
  it('never issues the blocking pg_advisory_lock', async () => {
    const { client, queries } = fakeClient([true]);
    await runWorkspaceProvisioningCycle(client);
    expect(queries.some((q) => /pg_advisory_lock\(/.test(q.text))).toBe(false);
    expect(queries[0]!.text).toMatch(/SELECT pg_try_advisory_lock\(hashtext\('rab_workspace_provisioning'\)\)/);
  });

  it('acquired on the first try → runs the cycle and releases the lock exactly once', async () => {
    const { client, queries } = fakeClient([true], []);
    const result = await runWorkspaceProvisioningCycle(client);
    expect(result).toEqual({ attempted: 0, ready: 0, failed: 0, lockAcquired: true });
    expect(queries.map((q) => q.text.match(/pg_try_advisory_lock|worker_list_pending|pg_advisory_unlock/)?.[0])).toEqual([
      'pg_try_advisory_lock',
      'worker_list_pending',
      'pg_advisory_unlock',
    ]);
  });

  it('busy then free within the bound → acquires after polling', async () => {
    const clock = fakeClock();
    const { client, queries } = fakeClient([false, false, true]);
    expect(await tryAcquireProvisioningLock(client, { waitMs: 5_000, pollMs: 250, now: clock.now, sleep: clock.sleep })).toBe(true);
    expect(queries.filter((q) => /pg_try_advisory_lock/.test(q.text))).toHaveLength(3);
  });

  it('still busy at the deadline → gives up (bounded), and the cycle skips without discovery, DDL or unlock', async () => {
    const clock = fakeClock();
    const { client, queries } = fakeClient([]); // always busy
    const started = clock.now();
    const result = await runWorkspaceProvisioningCycle(client, undefined, { waitMs: 2_000, pollMs: 250, now: clock.now, sleep: clock.sleep });
    expect(result).toEqual({ attempted: 0, ready: 0, failed: 0, lockAcquired: false });
    expect(clock.now() - started).toBe(2_000);
    const attempts = queries.filter((q) => /pg_try_advisory_lock/.test(q.text)).length;
    expect(attempts).toBe(9); // t=0, 250, ..., 2000
    expect(queries.some((q) => /worker_list_pending|pg_advisory_unlock/.test(q.text))).toBe(false);
  });

  it('the wait is clamped: a huge or invalid waitMs cannot make it unbounded', async () => {
    const clock = fakeClock();
    const { client } = fakeClient([]);
    const t0 = clock.now();
    expect(await tryAcquireProvisioningLock(client, { waitMs: 10_000_000, pollMs: 1_000, now: clock.now, sleep: clock.sleep })).toBe(false);
    expect(clock.now() - t0).toBe(60_000); // clamped to the 60 s ceiling
    const tInf = clock.now();
    expect(await tryAcquireProvisioningLock(client, { waitMs: Number.POSITIVE_INFINITY, pollMs: 1_000, now: clock.now, sleep: clock.sleep })).toBe(false);
    expect(clock.now() - tInf).toBe(0); // non-finite → treated as 0 (one attempt), never "forever"
    const t1 = clock.now();
    expect(await tryAcquireProvisioningLock(client, { waitMs: Number.NaN, now: clock.now, sleep: clock.sleep })).toBe(false);
    expect(clock.now() - t1).toBe(0); // NaN → 0 → a single attempt
    expect(PROVISIONING_LOCK_WAIT_MS).toBe(10_000);
  });

  it('waitMs 0 → exactly one non-blocking attempt', async () => {
    const clock = fakeClock();
    const { client, queries } = fakeClient([]);
    expect(await tryAcquireProvisioningLock(client, { waitMs: 0, now: clock.now, sleep: clock.sleep })).toBe(false);
    expect(queries).toHaveLength(1);
  });

  it('shutdown aborts the wait at once (no attempt after shouldAbort turns true)', async () => {
    const clock = fakeClock();
    const { client, queries } = fakeClient([]);
    let aborted = false;
    const sleep = async (ms: number) => {
      clock.advance(ms);
      aborted = true; // shutdown requested while waiting
    };
    expect(await tryAcquireProvisioningLock(client, { waitMs: 10_000, pollMs: 250, now: clock.now, sleep, shouldAbort: () => aborted })).toBe(false);
    expect(queries).toHaveLength(1);
  });

  it('a failing cycle still releases the lock it took', async () => {
    const queries: string[] = [];
    const client = {
      query: jest.fn(async (text: string) => {
        queries.push(text);
        if (/pg_try_advisory_lock/.test(text)) return { rows: [{ locked: true }] };
        if (/worker_list_pending/.test(text)) throw new Error('discovery failed');
        return { rows: [] };
      }),
    } as unknown as Client;
    await expect(runWorkspaceProvisioningCycle(client)).rejects.toThrow('discovery failed');
    expect(queries.filter((q) => /pg_advisory_unlock/.test(q))).toHaveLength(1);
  });
});
