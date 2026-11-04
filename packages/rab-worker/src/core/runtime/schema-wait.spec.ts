import { SchemaCompatibilityError } from '@rab/server/database/boot-checks/schema-compatibility';

import { isPendingOnly, resolveSchemaWaitMs, SchemaWaitConfigError, waitForCompatibleSchema } from './schema-wait';

/** The Worker's bounded wait for "schema current" (it never migrates; the API start or the release step does). */
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}
const pending = (n = 1) => new SchemaCompatibilityError('pending-migrations', ['pending'], `${n} migration(s) are not applied.`);

describe('worker schema wait', () => {
  it('pending, then compatible: waits (polling), logs once per change, then returns', async () => {
    const c = clock();
    const results = [pending(3), pending(3), pending(1), null];
    const logs: string[] = [];
    const r = await waitForCompatibleSchema({
      check: async () => {
        const next = results.shift();
        if (next) throw next;
      },
      maxWaitMs: 900_000,
      log: (l) => logs.push(l),
      ...c,
    });
    expect(r).toEqual({ waitedMs: 30_000, checks: 4 });
    expect(logs.filter((l) => l.includes('waiting'))).toHaveLength(2); // 3 pending (logged once), then 1 pending
    expect(logs.at(-1)).toMatch(/now compatible .* after 30 s/);
  });

  it('compatible at once: no wait, no log', async () => {
    const logs: string[] = [];
    expect(await waitForCompatibleSchema({ check: async () => undefined, maxWaitMs: 1000, log: (l) => logs.push(l), ...clock() })).toEqual({ waitedMs: 0, checks: 1 });
    expect(logs).toEqual([]);
  });

  it('still pending at the limit: refused (bounded), naming the limit; the Worker never migrates', async () => {
    await expect(waitForCompatibleSchema({ check: async () => Promise.reject(pending()), maxWaitMs: 60_000, log: () => undefined, ...clock() })).rejects.toThrow(
      /still pending after \d+ s \(CREWFLOW_WORKER_SCHEMA_WAIT_SECONDS limit 60 s\)\. The Worker never migrates/,
    );
  });

  it('anything but pending-only is NOT a wait: refused at once (unknown / interleaved migration, unreadable ledger, other errors)', async () => {
    const cases = [
      new SchemaCompatibilityError('schema-compatibility', ['pending', 'unknown-interleaved'], 'mixed'),
      new SchemaCompatibilityError('schema-compatibility', ['ledger-ahead' as never], 'ahead'),
      new SchemaCompatibilityError('pending-migrations', [], 'the migration ledger could not be read'),
      new Error('connection refused'),
    ];
    for (const error of cases) {
      let checks = 0;
      await expect(
        waitForCompatibleSchema({
          check: async () => {
            checks += 1;
            throw error;
          },
          maxWaitMs: 900_000,
          log: () => undefined,
          ...clock(),
        }),
      ).rejects.toBe(error);
      expect(checks).toBe(1);
    }
    expect(isPendingOnly(pending())).toBe(true);
  });

  it('a limit of 0 refuses on the first pending (the previous behaviour); shutdown stops the wait', async () => {
    await expect(waitForCompatibleSchema({ check: async () => Promise.reject(pending()), maxWaitMs: 0, log: () => undefined, ...clock() })).rejects.toThrow(/still pending/);
    await expect(
      waitForCompatibleSchema({ check: async () => Promise.reject(pending()), maxWaitMs: 900_000, log: () => undefined, shouldAbort: () => true, ...clock() }),
    ).rejects.toThrow(/shutdown requested/);
  });

  it('CREWFLOW_WORKER_SCHEMA_WAIT_SECONDS: whole seconds 0..3600, default 900', () => {
    expect(resolveSchemaWaitMs({})).toBe(900_000);
    expect(resolveSchemaWaitMs({ CREWFLOW_WORKER_SCHEMA_WAIT_SECONDS: '0' })).toBe(0);
    expect(resolveSchemaWaitMs({ CREWFLOW_WORKER_SCHEMA_WAIT_SECONDS: '3600' })).toBe(3_600_000);
    for (const bad of ['3601', '-1', '10m', ' 5']) expect(() => resolveSchemaWaitMs({ CREWFLOW_WORKER_SCHEMA_WAIT_SECONDS: bad })).toThrow(SchemaWaitConfigError);
  });
});
