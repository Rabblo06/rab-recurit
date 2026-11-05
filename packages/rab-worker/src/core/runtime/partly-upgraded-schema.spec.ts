import { Logger } from '@nestjs/common';
import Redis from 'ioredis';

import { SchemaCompatibilityError } from '@rab/server/database/boot-checks/schema-compatibility';
import { QUEUE_SETTINGS } from '@rab/server/engine/worker-shared/queue-registry';

import { createConsumerJobProcessor, createScanJobProcessor } from '../scheduler/bullmq-scheduler';
import { SCAN_JOBS } from '../scheduler/scan-jobs';
import { partlyUpgradedSchemaWarning, waitForCompatibleSchema, warnIfPartlyUpgraded } from './schema-wait';
import { WorkerRuntime } from './worker-runtime';

/**
 * Owner decision 2026-11-05 (changed): "the Worker starts too, like Twenty". After a FAILED upgrade (the API serves under
 * CREWFLOW_UPGRADE_FAILURE=continue) the Worker logs ONE loud WARNING naming the first pending migration and starts every
 * consumer and scan. A job that needs the missing schema fails (42P01 undefined_table, 42703 undefined_column, ...) and is
 * retried under the existing rules; it is always a FAILED JOB, never an unhandled rejection or a crashed process. A foreign,
 * unknown or interleaved ledger is still refused exactly as before.
 */
const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

function fakeRedis(): Redis {
  const multi = () => {
    const chain = { hset: () => chain, hincrby: () => chain, expire: () => chain, exec: () => Promise.resolve([]) };
    return chain;
  };
  return { hset: () => Promise.resolve(0), multi } as unknown as Redis;
}

/** Fails the test if anything rejects unhandled while `work` runs (and for one macrotask after it). */
async function withoutUnhandledRejection<T>(work: () => Promise<T>): Promise<T> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const result = await work();
    await new Promise((r) => setTimeout(r, 10));
    expect(unhandled).toEqual([]);
    return result;
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
}

describe('partly-upgraded schema: one loud start-up WARNING', () => {
  const expected = ['Init1786000000000', 'AddThing1786100000000', 'Broken1786200000000', 'Later1786300000000'];

  it('names the FIRST pending migration in chain order and the count; null when nothing is pending', () => {
    expect(partlyUpgradedSchemaWarning(expected, expected)).toBeNull();
    const warning = partlyUpgradedSchemaWarning(expected, ['Init1786000000000', 'AddThing1786100000000'])!;
    expect(warning).toMatch(/WARNING running on a partly-upgraded schema: 2 migration\(s\) .* first pending Broken1786200000000/);
    expect(warning).toMatch(/Starting every consumer and scan anyway/);
  });

  it('is logged exactly ONCE at start', async () => {
    const log = jest.fn();
    const query = jest.fn(async () => [{ name: 'Init1786000000000' }, { name: 'AddThing1786100000000' }]);
    const warning = await warnIfPartlyUpgraded({ query, expected, log });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(warning);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('logs nothing when the schema is current, or when the ledger cannot be read (the boot gates already decided)', async () => {
    const log = jest.fn();
    expect(await warnIfPartlyUpgraded({ query: async () => expected.map((name) => ({ name })), expected, log })).toBeNull();
    expect(await warnIfPartlyUpgraded({ query: async () => Promise.reject(pgError('42P01', 'relation "core.migrations" does not exist')), expected, log })).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });
});

describe('a job that hits the missing schema is a failed job, never a crash', () => {
  it.each([
    ['42P01', 'relation "core.new_table" does not exist'],
    ['42703', 'column "new_column" does not exist'],
    ['42883', 'function core.new_function() does not exist'],
  ])('scan job (%s): the cycle fails, BullMQ gets the fixed failure (the next tick retries), the process survives', async (code, message) => {
    const runtime = new WorkerRuntime(fakeRedis(), { metricsLogMs: 0 });
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const def = SCAN_JOBS.find((d) => d.jobName === 'offer-expiry')!;
    const recordOutcome = jest.fn();
    const processor = createScanJobProcessor({
      defs: new Map([[def.jobName, def]]),
      isEnabled: () => true,
      registry: { scan: () => async () => Promise.reject(pgError(code, message)) },
      intervalOf: () => 60_000,
      runtime,
      lock: async (_id, work) => ({ acquired: true, value: await work() }),
      recordOutcome,
    });
    await withoutUnhandledRejection(async () => {
      await expect(processor({ name: def.jobName })).rejects.toThrow(`${def.name} cycle failed (details in the worker log)`);
    });
    expect(recordOutcome).toHaveBeenCalledWith(def, 'failed');
    // The next scheduled tick runs the cycle again (nothing is disabled or stuck): it succeeds once the schema is there.
    const processorAfterFix = createScanJobProcessor({
      defs: new Map([[def.jobName, def]]),
      isEnabled: () => true,
      registry: { scan: () => async () => undefined },
      intervalOf: () => 60_000,
      runtime,
      lock: async (_id, work) => ({ acquired: true, value: await work() }),
      recordOutcome,
    });
    await expect(processorAfterFix({ name: def.jobName })).resolves.toEqual({ outcome: 'succeeded' });
  });

  it('consumer job (rab-email, 42P01): the processor rejects, so BullMQ fails the job and retries it under the queue rules (5 attempts, backoff)', async () => {
    const handler = jest.fn(async () => Promise.reject(pgError('42P01', 'relation "core.email_outbox_v2" does not exist')));
    const processor = createConsumerJobProcessor({ name: 'rab-email', logName: 'email' }, handler, { warn: jest.fn() });
    await withoutUnhandledRejection(async () => {
      await expect(processor({ id: '1', name: QUEUE_SETTINGS['rab-email'].jobNames[0]! })).rejects.toMatchObject({ code: '42P01' });
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(QUEUE_SETTINGS['rab-email'].job.attempts).toBe(5);
    expect(QUEUE_SETTINGS['rab-email'].job.backoff).not.toBeNull();
  });
});

describe('the refusal path is unchanged for a foreign database', () => {
  it.each([['ledger-interleaved'], ['ledger-ahead'], ['provision-function-unknown']])('a %s finding is refused at once (no wait, no start)', async (finding) => {
    const check = jest.fn(async () => {
      throw new SchemaCompatibilityError('schema-compatibility', [finding as never], `Refusing to start the worker process: ${finding}.`);
    });
    await expect(waitForCompatibleSchema({ check, maxWaitMs: 900_000, log: () => undefined, sleep: async () => undefined })).rejects.toThrow(finding);
    expect(check).toHaveBeenCalledTimes(1);
  });
});
