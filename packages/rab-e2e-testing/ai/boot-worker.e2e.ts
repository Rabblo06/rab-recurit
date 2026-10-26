/**
 * TEST-ONLY AI worker boot for the AI end-to-end run (run-ai-e2e.sh). NEVER a production entrypoint.
 *
 * The real `rab-worker` imports `@rab/server` from the compiled `dist`, where the deterministic mock does not exist (it is
 * test-only since Phase 1), so it cannot answer on a test database. This file runs the SAME step loop the `rab-ai`
 * consumer runs — `AiTurnRunnerService.run(job.data)` from the shared `AiCoreModule` (queues/rab-ai/ai.processors.ts is a
 * one-line adapter to it) — from SOURCE (ts-node `--transpile-only`), NODE_ENV=test, with the two test seams of
 * helpers/ai-test-kit.ts overridden. It consumes ONLY the `rab-ai` queue (`ai-turn` jobs, legacy `bull` prefix,
 * concurrency 4 like CONSUMER_QUEUES.ai); the worker's scan loops are not needed by the AI e2e and are not started.
 * Nothing under packages/rab-server/src or packages/rab-worker/src is changed.
 */
import 'reflect-metadata';

if (process.env.NODE_ENV !== 'test') {
  // eslint-disable-next-line no-console
  console.error('[ai-e2e boot-worker] refused: NODE_ENV must be "test"');
  process.exit(2);
}

async function main(): Promise<void> {
  const { Test } = await import('@nestjs/testing');
  const { Worker } = await import('bullmq');
  const { default: Redis } = await import('ioredis');
  const { DataSource } = await import('typeorm');
  const src = '../../rab-server/src';
  const { assertRuntimeDatabaseIdentity } = await import(`${src}/database/typeorm/core/runtime-database-guard`);
  const { AppModule } = await import(`${src}/app.module`);
  const { assertRuntimeDbRole } = await import(`${src}/engine/utils/assert-runtime-db-role`);
  const { AI_QUEUE_NAME, AI_TURN_JOB_NAME } = await import(`${src}/engine/worker-shared/ai-queue.constants`);
  const { AI_TEST_MODEL_CATALOGUE } = await import(`${src}/modules/ai/constants/ai.constants`);
  const { AI_LANGUAGE_MODEL_FACTORY } = await import(`${src}/modules/ai/gateway/model-gateway.service`);
  const { AiTurnRunnerService } = await import(`${src}/modules/ai/services/ai-turn-runner.service`);
  const { TEST_MODEL_CATALOGUE, testModelFactory } = await import(`${src}/__tests__/support/ai/test-catalogue`);

  await assertRuntimeDatabaseIdentity('worker');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AI_TEST_MODEL_CATALOGUE)
    .useValue(TEST_MODEL_CATALOGUE)
    .overrideProvider(AI_LANGUAGE_MODEL_FACTORY)
    .useValue(testModelFactory)
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  await assertRuntimeDbRole(app.get(DataSource), 'AI worker (ai-e2e test boot)');
  const runner = app.get(AiTurnRunnerService);

  const connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  const worker = new Worker(
    AI_QUEUE_NAME,
    async (job: { name: string; data: Parameters<typeof runner.run>[0] }) => {
      if (job.name !== AI_TURN_JOB_NAME) return 'skipped';
      return runner.run(job.data);
    },
    { connection, concurrency: 4 },
  );
  await worker.waitUntilReady();
  // eslint-disable-next-line no-console
  console.log('[ai-e2e boot-worker] rab-ai consumer ready (test model seams on, NODE_ENV=test)');

  const stop = async () => {
    runner.abortAll();
    await worker.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    connection.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[ai-e2e boot-worker] failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
});
