/**
 * TEST-ONLY API boot for the AI end-to-end run (run-ai-e2e.sh). NEVER a production entrypoint.
 *
 * Since AI Phase 1 the deterministic mock model is test-only (`packages/rab-server/src/__tests__/support/ai/`) and is NOT
 * in `dist`, so the compiled `dist/main.js` has no model at all on a test database. This file boots the REAL AppModule
 * from SOURCE (ts-node `--transpile-only`, never `tsx`: decorator metadata), NODE_ENV=test, with exactly the two test
 * seams the integration suites use (helpers/ai-test-kit.ts):
 *   - AI_TEST_MODEL_CATALOGUE  → the in-process test catalogue (honoured by AiConfigService only when NODE_ENV=test);
 *   (the model-factory seam is the worker boot's: since Phase 2 the API has no model side.)
 * Nothing under packages/rab-server/src is changed; the mock never enters the production build.
 *
 * It then applies the same HTTP setup as `rab-server/src/main.ts` (runtime database guards, trust proxy, the global
 * ValidationPipe with forbidNonWhitelisted, helmet, the workspace-aware CORS delegate) and listens on PORT.
 */
import 'reflect-metadata';

if (process.env.NODE_ENV !== 'test') {
  // eslint-disable-next-line no-console
  console.error('[ai-e2e boot-api] refused: NODE_ENV must be "test" (the test model seams are honoured only there)');
  process.exit(2);
}

async function main(): Promise<void> {
  const { ValidationPipe } = await import('@nestjs/common');
  const { Test } = await import('@nestjs/testing');
  const { default: helmet } = await import('helmet');
  const { DataSource } = await import('typeorm');
  const src = '../../rab-server/src';
  const { assertRuntimeDatabaseIdentity } = await import(`${src}/database/typeorm/core/runtime-database-guard`);
  const { AppModule } = await import(`${src}/app.module`);
  const { EnvironmentService } = await import(`${src}/engine/core-modules/environment/environment.service`);
  const { assertRuntimeDbRole } = await import(`${src}/engine/utils/assert-runtime-db-role`);
  const { buildTrustProxyPredicate } = await import(`${src}/engine/utils/trusted-proxy.util`);
  const { buildCorsOptionsDelegate, WorkspaceOriginTrustService } = await import(`${src}/engine/core-modules/workspace-host/workspace-origin-trust.service`);
  const { WorkspaceHostResolverService } = await import(`${src}/engine/core-modules/workspace-host/workspace-host-resolver.service`);
  const { AI_TEST_MODEL_CATALOGUE } = await import(`${src}/modules/ai/constants/ai.constants`);
  const { TEST_MODEL_CATALOGUE } = await import(`${src}/__tests__/support/ai/test-catalogue`);

  await assertRuntimeDatabaseIdentity('api');
  // Phase 2 (P2-C11): the API graph has no model side, so only the test catalogue seam applies here (availability and
  // Settings → AI see the test model); the model factory seam lives in the worker boot.
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AI_TEST_MODEL_CATALOGUE)
    .useValue(TEST_MODEL_CATALOGUE)
    .compile();
  const app = moduleRef.createNestApplication();
  await assertRuntimeDbRole(app.get(DataSource), 'API server (ai-e2e test boot)');
  const env = app.get(EnvironmentService);
  app.enableShutdownHooks();
  app.getHttpAdapter().getInstance().set('trust proxy', buildTrustProxyPredicate(env.trustedProxyCidrs));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.enableCors(buildCorsOptionsDelegate(app.get(WorkspaceOriginTrustService), app.get(WorkspaceHostResolverService), { credentials: true, exposedHeaders: ['Retry-After'] }));
  const port = env.get('PORT');
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`[ai-e2e boot-api] listening on :${port} (test model seams on, NODE_ENV=test)`);
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[ai-e2e boot-api] failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
});
