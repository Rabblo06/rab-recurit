import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';

import { Process, Processor } from './decorators';
import { buildHandlerRegistry, ProcessorExplorer, ProcessorRegistrationError, validateHandlerRegistry } from './processor-explorer';
import { CONSUMER_QUEUES, SCAN_QUEUES } from './queue-registry';
import { SCAN_JOBS } from './scan-jobs';
import { assertSupportedBullmqApi, RedisPreflightError } from './redis-preflight';

/** Startup failure modes of processor discovery (M2/M7): duplicate handler, scheduled job without handler, unknown queue, orphan. */
async function explore(...providers: Array<new (...args: never[]) => unknown>) {
  @Module({ imports: [DiscoveryModule], providers: [ProcessorExplorer, ...providers] })
  class TestModule {}
  const ref = await Test.createTestingModule({ imports: [TestModule] }).compile();
  try {
    return ref.get(ProcessorExplorer).explore();
  } finally {
    await ref.close();
  }
}

@Processor(SCAN_QUEUES.email)
class EmailA {
  @Process('email-dispatch')
  async dispatch(): Promise<boolean> {
    return true;
  }
}

@Processor(SCAN_QUEUES.email)
class EmailB {
  @Process('email-dispatch')
  async dispatchAgain(): Promise<boolean> {
    return true;
  }
}

@Processor('crewflow-scan-typo')
class UnknownQueue {
  @Process('email-dispatch')
  async x(): Promise<void> {}
}

@Processor(SCAN_QUEUES.email)
class Orphan {
  @Process('email-dispatch')
  async dispatch(): Promise<boolean> {
    return true;
  }

  @Process('not-scheduled-anywhere')
  async orphan(): Promise<void> {}
}

describe('processor explorer (Nest DiscoveryService)', () => {
  it('discovers @Process methods bound to their provider instance', async () => {
    const registry = await explore(EmailA);
    const h = registry.get(SCAN_QUEUES.email, 'email-dispatch');
    expect(h?.source).toBe('EmailA.dispatch');
    await expect(h!.handler()).resolves.toBe(true);
  });

  it('refuses a duplicate handler for the same queue/job', async () => {
    await expect(explore(EmailA, EmailB)).rejects.toThrow(/duplicate handler for crewflow-scan-email\/email-dispatch: EmailA.dispatch and EmailB.dispatchAgain/);
  });

  it('refuses a processor on a queue that is not in the typed registry', async () => {
    await expect(explore(UnknownQueue)).rejects.toThrow(ProcessorRegistrationError);
    await expect(explore(UnknownQueue)).rejects.toThrow(/@Processor\("crewflow-scan-typo"\) is not a queue in the typed queue registry/);
  });

  it('refuses a scheduled job without a handler and a consumer queue without its handler', async () => {
    const registry = await explore(EmailA);
    expect(() => validateHandlerRegistry(registry)).toThrow(/scheduled job crewflow:crewflow-scan-push:push-dispatch has no @Process handler/);
    expect(() => validateHandlerRegistry(registry)).toThrow(/consumer queue rab-email has no @Process\("send-email"\) handler/);
    expect(() => registry.scan(SCAN_JOBS[2]!)).toThrow(/has no @Process handler/);
  });

  it('refuses an orphan handler (a job nothing schedules or publishes)', async () => {
    const registry = await explore(Orphan);
    expect(() => validateHandlerRegistry(registry, [SCAN_JOBS[1]!])).toThrow(/Orphan.orphan: @Process\("not-scheduled-anywhere"\) on crewflow-scan-email handles a job nothing schedules/);
  });

  it('accepts a complete registry (every scan + every consumer covered exactly once)', () => {
    const handlers = [
      ...SCAN_JOBS.map((d) => ({ queue: d.queue, jobName: d.jobName, source: d.jobName, handler: async () => undefined })),
      ...Object.values(CONSUMER_QUEUES).map((q) => ({ queue: q.name, jobName: q.jobName, source: q.name, handler: async () => undefined })),
    ];
    expect(() => validateHandlerRegistry(buildHandlerRegistry(handlers))).not.toThrow();
  });

  it('decorators refuse unsupported usage (no queue / no job name)', () => {
    expect(() => Processor('')).toThrow(/requires a queue name/);
    expect(() => Process('')).toThrow(/requires a job name/);
  });

  it('unsupported BullMQ API (no job schedulers) refuses bullmq mode instead of degrading', () => {
    class OldQueue {
      add() {}
    }
    expect(() => assertSupportedBullmqApi(OldQueue)).toThrow(RedisPreflightError);
    expect(() => assertSupportedBullmqApi(OldQueue)).toThrow(/upsertJobScheduler, getJobSchedulers, getJobScheduler, removeJobScheduler/);
    expect(() => assertSupportedBullmqApi()).not.toThrow();
  });
});
