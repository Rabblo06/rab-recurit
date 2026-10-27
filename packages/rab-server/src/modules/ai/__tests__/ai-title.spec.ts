/**
 * AI Phase 2 titles — EX-1 on the title call (T2-12), with NO network: the real `@ai-sdk/anthropic` model object behind
 * a fake `fetch` that only counts. The title service, the real gateway and the real payload scan run; the database,
 * Redis and access are in-memory fakes. A refusal must happen BEFORE any request (fetch count 0) and be audited with
 * category / reason codes only.
 */
jest.mock('ai', () => {
  const actual = jest.requireActual('ai');
  return { ...actual, streamText: jest.fn((options: unknown) => actual.streamText(options)) };
});

import { streamText } from 'ai';

import { AiRuntimeDatabaseFacts } from '../../../engine/core-modules/ai/ai-readiness';
import { AI_HAIKU_MODEL_ID, catalogueEntry } from '../../../engine/core-modules/ai/models/catalog';
import { EnvironmentService } from '../../../engine/core-modules/environment/environment.service';
import { ModelGatewayService } from '../gateway/model-gateway.service';
import { createProviderModel } from '../gateway/provider-factory';
import { AiConfigService } from '../services/ai-config.service';
import { AiTitleService } from '../services/ai-title.service';
import { titleJobData } from '../services/ai-turn-queue.service';

const CANARY = 'sk-ant-title-canary-'.padEnd(48, 'Q');
const DEV_DB: AiRuntimeDatabaseFacts = { runtimeEnvironment: 'development', classification: 'LOCAL' };
const streamTextMock = streamText as unknown as jest.Mock;
const ID = '3f1c6a2e-8b7d-4c1e-9f0a-1b2c3d4e5f60';

function realDevConfig(): AiConfigService {
  const all: Record<string, unknown> = {
    NODE_ENV: 'development',
    AI_ENABLED: true,
    AI_MAX_OUTPUT_TOKENS: 1500,
    AI_MAX_STEPS: 8,
    AI_ORG_DAILY_TOKEN_BUDGET: 200_000,
    AI_TURN_TIMEOUT_SECONDS: 30,
    AI_DAILY_BUDGET_USD: 2,
    AI_DEV_ALLOW_REAL_PROVIDERS: true,
    ANTHROPIC_API_KEY: CANARY,
  };
  const env = { get: (key: string) => all[key] } as unknown as EnvironmentService;
  const c = new AiConfigService(env, null);
  jest.spyOn(c, 'runtimeDatabase').mockReturnValue(DEV_DB);
  return c;
}

function harness(opts: { question: string; syntheticCheck?: string; hang?: boolean }) {
  const cfg = realDevConfig();
  cfg.onModuleInit();
  const fetches: unknown[] = [];
  const fakeFetch = (async (...args: unknown[]) => {
    fetches.push(args);
    if (opts.hang) {
      const signal = (args[1] as RequestInit | undefined)?.signal;
      await new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted'))));
    }
    // 400 (not retryable): the request is answered with an error, never retried.
    return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'nope' } }), { status: 400, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const gateway = new ModelGatewayService(cfg, (entry) => createProviderModel({ model: entry, apiKey: CANARY, fetch: fakeFetch }));
  const haiku = catalogueEntry(AI_HAIKU_MODEL_ID)!;
  const queries: Array<[string, unknown[]]> = [];
  const m = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      queries.push([sql, params]);
      if (sql.includes('FROM core.ai_conversation c WHERE c.id')) return [{ title_source: 'auto', first: opts.question, session_id: ID }];
      if (sql.includes("SET title_source = 'pending'")) return [{ id: ID }];
      return [];
    }),
  };
  const tenantContext = { runInTenantContext: jest.fn(async (_c: unknown, fn: (mm: typeof m) => unknown) => fn(m)) };
  const access = {
    rebuildForWorker: jest.fn(async (i: Record<string, string>) => ({ ...i, timezone: 'Europe/London', permissions: new Set(), model: haiku, realProviderPermitted: true })),
    assertStillAllowed: jest.fn(async () => undefined),
    syntheticCheckForRealRequest: jest.fn(async () => opts.syntheticCheck ?? 'ok'),
  };
  const quota = { budgetKeyExists: jest.fn(async () => true), reserveBudget: jest.fn(async () => ({})), adjustBudget: jest.fn(async () => undefined) };
  const costMeter = { reserveSeeded: jest.fn(async () => ({ admitted: true })), settle: jest.fn(async () => undefined) };
  const usageLedger = { insertTerminal: jest.fn(async () => true), userDayCostMicros: jest.fn(async () => 0) };
  const usage = { recordTitle: jest.fn(async () => undefined), dayTokens: jest.fn(async () => 0), dayCostMicros: jest.fn(async () => 0) };
  const streams = { publishIfOpen: jest.fn(async () => true) };
  const audit = { record: jest.fn(async () => undefined) };
  const env = { get: (k: string) => (k === 'AI_TITLE_GENERATION' ? true : undefined) } as unknown as EnvironmentService;
  const titles = new AiTitleService(cfg, env, access as never, gateway, quota as never, costMeter as never, usage as never, streams as never, audit as never, tenantContext as never, usageLedger as never);
  const job = titleJobData({ turnId: ID, conversationId: ID, organisationId: ID, workspaceId: ID, userId: ID });
  return { titles, job, fetches, audit, access, queries, usage, everything: () => JSON.stringify([queries, audit.record.mock.calls, usage.recordTitle.mock.calls, streams.publishIfOpen.mock.calls]) };
}

const refusalAudit = (h: ReturnType<typeof harness>) =>
  h.audit.record.mock.calls.filter((c: unknown[]) => c[2] === 'ai.turn_refused').map((c: unknown[]) => (c[3] as { metadata: unknown }).metadata);

describe('AiTitleService under EX-1 (real provider object, fake fetch, no network)', () => {
  beforeEach(() => streamTextMock.mockClear());

  it.each([
    ['an NI number', 'Check AB123456C before Friday', ['ni_number']],
    ['a UK postcode', 'Venue at SW1A 1AA needs staff', ['postcode']],
  ])('a first message containing %s is refused before any request; audited with codes only', async (_label, question, categories) => {
    const h = harness({ question });
    await expect(h.titles.run(h.job)).resolves.toBe('refused');
    expect(h.fetches).toHaveLength(0);
    expect(refusalAudit(h)).toEqual([{ reason: 'content_refused', stage: 'title', categories }]);
    expect(h.everything()).not.toMatch(/AB123456C|SW1A|Friday|Venue at/);
    // The fallback stays: pending is reverted, nothing is written as a title.
    expect(h.queries.some(([sql]) => sql.includes("SET title_source = 'auto'"))).toBe(true);
    expect(h.queries.some(([sql]) => sql.includes("title_source = 'model'"))).toBe(false);
  });

  it('a test-marked database (or any non-synthetic answer of the request-time check) refuses before any request', async () => {
    const h = harness({ question: 'How many shifts are open?', syntheticCheck: 'test_database' });
    await expect(h.titles.run(h.job)).resolves.toBe('refused');
    expect(h.fetches).toHaveLength(0);
    expect(refusalAudit(h)).toEqual([{ reason: 'content_refused', stage: 'title', categories: ['test_database'] }]);
    expect(h.access.syntheticCheckForRealRequest).toHaveBeenCalledTimes(1);
  });

  it('shutdown (abortAll) stops an in-flight title call; the fallback stays', async () => {
    const h = harness({ question: 'How many shifts are open this week?', hang: true });
    const pending = h.titles.run(h.job);
    for (let i = 0; i < 100 && h.fetches.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(h.titles.inflightCount).toBe(1);
    expect(h.titles.abortAll()).toBe(1);
    await expect(pending).resolves.toBe('failed');
    expect(h.titles.inflightCount).toBe(0);
    expect(h.fetches).toHaveLength(1);
    expect(h.queries.some(([sql]) => sql.includes("title_source = 'model'"))).toBe(false);
  });

  it('a clean message reaches the (fake) provider exactly once, telemetry off, the key never in a log/row/audit; a provider failure keeps the fallback', async () => {
    const h = harness({ question: 'How many shifts are open this week?' });
    await expect(h.titles.run(h.job)).resolves.toBe('failed');
    expect(h.fetches).toHaveLength(1);
    expect(streamTextMock).toHaveBeenCalledTimes(1);
    const options = streamTextMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(options.experimental_telemetry).toEqual({ isEnabled: false, recordInputs: false, recordOutputs: false });
    expect(options.tools).toEqual({});
    expect(h.everything()).not.toContain(CANARY);
    expect(h.queries.some(([sql]) => sql.includes("title_source = 'model'"))).toBe(false);
  });
});
