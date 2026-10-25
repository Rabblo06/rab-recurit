import { randomUUID } from 'node:crypto';

import type { LanguageModelV3 } from '@ai-sdk/provider';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../../app.module';
import { AiCatalogueModel } from '../../../engine/core-modules/ai/models/catalog';
import { PasswordHashingService } from '../../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AiTurnJobData } from '../../../engine/worker-shared/ai-queue.constants';
import { AI_TEST_MODEL_CATALOGUE } from '../../../modules/ai/constants/ai.constants';
import { AI_LANGUAGE_MODEL_FACTORY, AiLanguageModelFactory } from '../../../modules/ai/gateway/model-gateway.service';
import { TEST_MODEL_CATALOGUE, testModelFactory } from '../../support/ai/test-catalogue';
import { AiRedisClientProvider } from '../../../modules/ai/services/ai-redis-client.provider';
import { AiTurnRunnerService } from '../../../modules/ai/services/ai-turn-runner.service';
import { createAdminDataSource } from './admin-datasource';
import { TestIdentity, TestIdentityFactory } from './test-identities';

/**
 * Shared harness of the AI Phase 1 integration suites (`ai-*.integration.spec.ts`): the REAL AppModule (guards, pipes,
 * RLS on crewflow_app, Redis, BullMQ producer) with the two TEST-ONLY seams — the in-process test catalogue and the
 * language-model factory, so a suite can plug a recorded/scripted model (`MockLanguageModelV3` from `ai/test`) instead of
 * the deterministic default (src/__tests__/support/ai/). The
 * Worker step loop (`AiTurnRunnerService`) is the same provider the rab-ai consumer calls.
 */
export interface AiKit {
  app: INestApplication;
  moduleRef: TestingModule;
  /** Bootstrap/superuser connection — fixtures and assertions only, never the code under test. */
  owner: DataSource;
  /** The app's own runtime connection (crewflow_app, RLS-bound). */
  runtime: DataSource;
  factory: TestIdentityFactory;
  runner: AiTurnRunnerService;
  redis: AiRedisClientProvider['client'];
  /** Replace the model for the next turns (null = the deterministic default). */
  setModel(model: LanguageModelV3 | null): void;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export async function bootAiKit(opts: { testModels?: readonly AiCatalogueModel[] | null } = {}): Promise<AiKit> {
  const holder: { model: LanguageModelV3 | null } = { model: null };
  const factoryOverride: AiLanguageModelFactory = (model, apiKey) => holder.model ?? testModelFactory(model, apiKey);
  // The test-only seams (PHASE1_TWENTY_PLAN §5): the in-process test catalogue (honoured only under NODE_ENV=test) and the
  // model factory. Production code provides neither a mock nor a test model.
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AI_TEST_MODEL_CATALOGUE)
    .useValue('testModels' in opts ? (opts.testModels ?? null) : TEST_MODEL_CATALOGUE)
    .overrideProvider(AI_LANGUAGE_MODEL_FACTORY)
    .useValue(factoryOverride)
    .compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.init();
  const owner = createAdminDataSource();
  await owner.initialize();
  const runtime = moduleRef.get(DataSource);
  const factory = new TestIdentityFactory({ app, dataSource: runtime, adminDataSource: owner, tenantContext: moduleRef.get(TenantContextService), passwordHashing: moduleRef.get(PasswordHashingService) });
  return {
    app,
    moduleRef,
    owner,
    runtime,
    factory,
    runner: moduleRef.get(AiTurnRunnerService),
    redis: moduleRef.get(AiRedisClientProvider).client,
    setModel: (model) => {
      holder.model = model;
    },
    http: () => request(app.getHttpServer()),
    close: async () => {
      await app.close();
      await owner.destroy();
    },
  };
}

/** The per-organisation AI switch, written as the bootstrap identity (fixture). The product path is the admin route. */
export async function setOrgAi(kit: AiKit, organisationId: string, enabled: boolean): Promise<void> {
  await kit.owner.query(
    `INSERT INTO core.organisation_ai_setting (organisation_id, enabled) VALUES ($1, $2)
     ON CONFLICT (organisation_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
    [organisationId, enabled],
  );
}

/** An organisation with AI switched on and its CEO (production permissions, own workspace) signed in. */
export async function aiOrganisation(kit: AiKit, label: string, opts: { aiEnabled?: boolean } = {}): Promise<{ orgId: string; ceo: TestIdentity; token: string }> {
  const org = await kit.factory.createOrganisation(label);
  const ceo = await kit.factory.createCeo(org, { permissions: 'production' });
  await setOrgAi(kit, org.id, opts.aiEnabled ?? true);
  return { orgId: org.id, ceo, token: await kit.factory.login(ceo) };
}

/** An Internal Manager of `orgId` (own workspace), optionally marked as the organisation's CURRENT Initial Manager. */
export async function manager(kit: AiKit, orgId: string, opts: { initial?: boolean } = {}): Promise<{ id: TestIdentity; token: string }> {
  const id = await kit.factory.createInternalManager({ id: orgId }, { permissions: 'production' });
  if (opts.initial) await kit.owner.query(`UPDATE core.manager_profile SET is_initial_manager = true WHERE user_id = $1`, [id.userId]);
  return { id, token: await kit.factory.login(id) };
}

export async function newConversation(kit: AiKit, token: string): Promise<string> {
  const res = await kit.http().post('/rest/v1/ai/conversations').set(bearer(token)).send({});
  if (res.status !== 201) throw new Error(`create conversation: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id as string;
}

/** Submits a question over HTTP (202) and returns the queued turn. */
export async function ask(kit: AiKit, token: string, conversationId: string, content: string): Promise<{ turnId: string; status: number; body: Record<string, unknown> }> {
  const res = await kit.http().post(`/rest/v1/ai/conversations/${conversationId}/messages`).set(bearer(token)).send({ content, clientRequestId: randomUUID() });
  return { turnId: res.body?.turnId as string, status: res.status, body: res.body };
}

/** The exact job the API enqueued for a turn (IDs only), for running the Worker step loop in-process. */
export function jobFor(identity: Pick<TestIdentity, 'organisationId' | 'workspaceId' | 'userId'>, conversationId: string, turnId: string): AiTurnJobData {
  return { v: 1, turnId, conversationId, organisationId: identity.organisationId, workspaceId: identity.workspaceId!, userId: identity.userId };
}

export async function turnRow(kit: AiKit, turnId: string): Promise<Record<string, unknown>> {
  const [row] = await kit.owner.query(`SELECT status, content, error_code, tool_calls, input_tokens, output_tokens, reserved_tokens FROM core.ai_message WHERE id = $1`, [turnId]);
  return row;
}

/** Reads an SSE response to its end and returns the parsed events (`id`, `event`, `data`). */
export async function readSse(kit: AiKit, token: string, conversationId: string, turnId: string, lastEventId?: string): Promise<{ status: number; events: Array<{ id?: string; event?: string; data: Record<string, unknown> }> }> {
  const req = kit.http().get(`/rest/v1/ai/conversations/${conversationId}/stream?turnId=${turnId}`).set(bearer(token)).set('Accept', 'text/event-stream');
  if (lastEventId) req.set('Last-Event-ID', lastEventId);
  const res = await req.buffer(true).parse((r, cb) => {
    let text = '';
    r.setEncoding('utf8');
    r.on('data', (c: string) => (text += c));
    r.on('end', () => cb(null, text));
  });
  const events: Array<{ id?: string; event?: string; data: Record<string, unknown> }> = [];
  if (res.status === 200) {
    for (const block of String(res.body).split('\n\n')) {
      const lines = block.split('\n');
      const data = lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
      if (!data) continue;
      events.push({ id: lines.find((l) => l.startsWith('id: '))?.slice(4), event: lines.find((l) => l.startsWith('event: '))?.slice(7), data: JSON.parse(data) });
    }
  }
  return { status: res.status, events };
}
