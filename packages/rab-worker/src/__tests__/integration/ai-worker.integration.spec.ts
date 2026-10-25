// FIRST: env is frozen when a module reading it is imported. Own Redis DB index (10) for this suite's BullMQ traffic.
const baseRedis = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.REDIS_URL = `${baseRedis.replace(/\/\d+$/, '')}/10`;
process.env.AI_ENABLED = 'true';
process.env.AI_PROVIDER = 'mock';
process.env.AI_MODEL = 'crewflow-mock-1';

import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue, QueueEvents, Worker } from 'bullmq';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AI_QUEUE_NAME, AI_TURN_JOB_NAME, aiTurnJobId, AiTurnJobData } from '@rab/server/engine/worker-shared/ai-queue.constants';
import { AiTurnRunnerService } from '@rab/server/modules/ai/services/ai-turn-runner.service';
import { createConsumerWorkers } from '../../core/scheduler/bullmq-scheduler';
import { ProcessorExplorer, validateHandlerRegistry } from '../../core/scheduler/processor-explorer';
import { CONSUMER_QUEUES } from '../../core/scheduler/queue-registry';
import { AiTurnConsumer } from '../../queues/rab-ai/ai.processors';
import { WorkerModule } from '../../worker.module';

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

/**
 * AI Phase 1 — the rab-ai consumer inside the REAL WorkerModule graph: registered exactly once (startup validation
 * passes with it), resolved from the same shared AiCoreModule as the API, running on the restricted crewflow_app role,
 * and consuming real BullMQ jobs from the `rab-ai` queue on the legacy `bull` prefix. A job is a lookup input only:
 * forged or malformed ids are skipped without touching anything. (The full API → queue → Worker → tools → model → SSE
 * path with real data is rab-server's ai-turn.integration.spec.ts, which runs the same AiTurnRunnerService.)
 */
describeIfDb('rab-ai consumer in the WorkerModule (integration)', () => {
  jest.setTimeout(120_000);
  let moduleRef: TestingModule;
  let connection: Redis;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    await moduleRef.init();
    connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  });
  afterAll(async () => {
    await connection?.quit();
    await moduleRef?.close();
  });

  it('registers rab-ai/ai-turn and maintenance/ai-retention exactly once; the full handler registry validates', () => {
    const registry = moduleRef.get(ProcessorExplorer).explore();
    expect(() => validateHandlerRegistry(registry)).not.toThrow();
    expect(registry.get(AI_QUEUE_NAME, AI_TURN_JOB_NAME)?.source).toBe('AiTurnConsumer.turn');
    expect(registry.get('crewflow-scan-maintenance', 'ai-retention')?.source).toBe('AiMaintenanceProcessor.aiRetention');
    expect(CONSUMER_QUEUES.ai).toMatchObject({ name: 'rab-ai', prefix: 'bull', concurrency: 4, lockDurationMs: 60_000 });
  });

  it('the step loop runs on the restricted runtime role (crewflow_app, no BYPASSRLS)', async () => {
    const [row] = await moduleRef.get(DataSource).query(`SELECT current_user AS u, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`);
    expect(row).toEqual({ u: 'crewflow_app', bypass: false });
    expect(moduleRef.get(AiTurnConsumer)).toBeInstanceOf(AiTurnConsumer);
    expect(moduleRef.get(AiTurnRunnerService, { strict: false })).toBeInstanceOf(AiTurnRunnerService);
  });

  it('consumes real rab-ai jobs: forged ids and a malformed payload are skipped (nothing read or written), with bounded options', async () => {
    const registry = moduleRef.get(ProcessorExplorer).explore();
    const queue = new Queue<AiTurnJobData>(AI_QUEUE_NAME, { connection });
    await queue.obliterate({ force: true });
    const events = new QueueEvents(AI_QUEUE_NAME, { connection: connection.duplicate() });
    const consumers = createConsumerWorkers(registry, connection, new Logger('ai-worker-test'));
    try {
      const forged: AiTurnJobData = { v: 1, turnId: randomUUID(), conversationId: randomUUID(), organisationId: randomUUID(), workspaceId: randomUUID(), userId: randomUUID() };
      const job = await queue.add(AI_TURN_JOB_NAME, forged, { jobId: aiTurnJobId(forged.turnId), attempts: 1 });
      expect(await job.waitUntilFinished(events, 30_000)).toBe('skipped');
      const malformed = await queue.add(AI_TURN_JOB_NAME, { v: 2 } as unknown as AiTurnJobData, { jobId: aiTurnJobId(randomUUID()), attempts: 1 });
      expect(await malformed.waitUntilFinished(events, 30_000)).toBe('skipped');
      // Duplicate add with the same jobId is deduplicated by BullMQ (one job per turn).
      const again = await queue.add(AI_TURN_JOB_NAME, forged, { jobId: aiTurnJobId(forged.turnId), attempts: 1 });
      expect(again.id).toBe(job.id);
      const w = consumers.get('ai') as Worker;
      expect(w.opts.concurrency).toBe(4);
      expect(w.opts.lockDuration).toBe(60_000);
    } finally {
      for (const w of consumers.values()) await w.close();
      await events.close();
      await queue.close();
    }
  });
});
