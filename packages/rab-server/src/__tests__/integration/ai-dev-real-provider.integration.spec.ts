import './helpers/ai-env';

import { randomUUID } from 'node:crypto';

// Canary BEFORE AppModule loads (ConfigModule reads the environment once). NODE_ENV=test refuses every real provider, so
// the chat resolves to the in-process test model and the key is never used — it only has to stay invisible everywhere.
const CANARY = 'sk-ant-api03-INTEGRATION-CANARY-'.padEnd(72, 'K');
process.env.ANTHROPIC_API_KEY = CANARY;

import Redis from 'ioredis';

import { AiAvailabilityContext, NO_LEGACY_AI_ENV } from '../../engine/core-modules/ai/ai-readiness';
import { AI_HAIKU_MODEL_ID, AI_MODEL_CATALOGUE } from '../../engine/core-modules/ai/models/catalog';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { AiQuotaUnavailableError } from '../../modules/ai/exceptions/ai.exceptions';
import { AiAccessService } from '../../modules/ai/services/ai-access.service';
import { AiConfigService } from '../../modules/ai/services/ai-config.service';
import { AiCostBudgetExhaustedError, AiCostMeterService } from '../../modules/ai/services/ai-cost-meter.service';
import { utcDay } from '../../modules/ai/services/ai-quota.service';
import { AiTitleService } from '../../modules/ai/services/ai-title.service';
import { titleJobData } from '../../modules/ai/services/ai-turn-queue.service';
import { AiUsageService } from '../../modules/ai/services/ai-usage.service';
import { countingDeterministicModel } from './helpers/ai-models';
import { AiKit, aiOrganisation, ask, bearer, bootAiKit, jobFor, newConversation, turnRow } from './helpers/ai-test-kit';

/**
 * AI Part A (docs/ai/PART_A_PLAN.md) + Phase 1 "real models only" on the REAL database (crewflow_app, FORCE RLS) and the
 * REAL Redis — never a real provider: this database carries the disposable-test marker, so the real-provider gate refuses
 * here by construction, and NODE_ENV=test refuses real providers in availability as well. Where a test needs "a ready
 * real provider" it replaces only the PLATFORM half of availability (env + runtime guard, `availabilityContext`) with the
 * development answer and the PRODUCTION catalogue (no test models); every per-organisation and database check stays real.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const DEV_DB = { runtimeEnvironment: 'development', classification: 'LOCAL' };
const devContext = (env: Partial<AiAvailabilityContext['env']> = {}): AiAvailabilityContext => ({
  env: { NODE_ENV: 'development', AI_ENABLED: true, ANTHROPIC_API_KEY: CANARY, AI_DEV_ALLOW_REAL_PROVIDERS: true, ...env },
  runtimeDb: DEV_DB,
  legacy: NO_LEGACY_AI_ENV,
  catalogue: AI_MODEL_CATALOGUE,
});

describeIfDb('AI Part A: dev real-provider gate, synthetic marker, cost meter (integration)', () => {
  jest.setTimeout(180_000);
  let kit: AiKit;
  let tenant: TenantContextService;
  let config: AiConfigService;

  beforeAll(async () => {
    kit = await bootAiKit();
    tenant = kit.moduleRef.get(TenantContextService);
    config = kit.moduleRef.get(AiConfigService);
  });
  afterAll(async () => {
    await kit?.close();
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => jest.restoreAllMocks());

  const asTenant = <T>(ctx: { organisationId: string; workspaceId: string | null; userId: string }, sql: string, params: unknown[] = []) =>
    tenant.runInTenantContext({ ...ctx, role: '' }, (m) => m.query(sql, params) as Promise<T>);
  const pgCode = (e: unknown) => (e as { driverError?: { code?: string }; code?: string })?.driverError?.code ?? (e as { code?: string })?.code;

  // ── synthetic_data: writable only through the definer, which the runtime role cannot run ───────────────────────────
  describe('organisation_ai_setting.synthetic_data', () => {
    it('crewflow_app can neither insert nor update the marker column (column grants), even as a platform administrator', async () => {
      const org = await kit.factory.createOrganisation('ai-synth-grant');
      const admin = await kit.factory.createCeo(org, { permissions: 'production', platformAdmin: true });
      const ctx = { organisationId: org.id, workspaceId: null, userId: admin.userId };
      expect(pgCode(await asTenant(ctx, `INSERT INTO core.organisation_ai_setting (organisation_id, enabled, synthetic_data) VALUES ($1, false, true)`, [org.id]).catch((e) => e))).toBe('42501');
      await asTenant(ctx, `INSERT INTO core.organisation_ai_setting (organisation_id, enabled) VALUES ($1, false)`, [org.id]); // the admin switch's own columns still work
      const update = await asTenant(ctx, `UPDATE core.organisation_ai_setting SET synthetic_data = true WHERE organisation_id = $1`, [org.id]).catch((e) => e);
      expect(pgCode(update)).toBe('42501');
      const insert = await asTenant(ctx, `INSERT INTO core.organisation_ai_setting (organisation_id, synthetic_data) VALUES ($1, true) ON CONFLICT (organisation_id) DO UPDATE SET synthetic_data = true`, [org.id]).catch((e) => e);
      expect(pgCode(insert)).toBe('42501');
      const [row] = await kit.owner.query(`SELECT synthetic_data FROM core.organisation_ai_setting WHERE organisation_id = $1`, [org.id]);
      expect(row.synthetic_data).toBe(false);
    });

    it('crewflow_app cannot execute the marker function; the function itself refuses a disposable test database', async () => {
      const org = await kit.factory.createOrganisation('ai-synth-fn');
      const ceo = await kit.factory.createCeo(org, { permissions: 'production', platformAdmin: true });
      const denied = await asTenant({ organisationId: org.id, workspaceId: null, userId: ceo.userId }, `SELECT core.ai_dev_mark_organisation_synthetic($1)`, [org.id]).catch((e) => e);
      expect(pgCode(denied)).toBe('42501');
      // The bootstrap identity CAN execute it: this database's catalog marker stops it (even with the session value faked).
      const refused = await kit.owner
        .transaction(async (m) => {
          await m.query(`SET LOCAL crewflow.disposable_test_database = 'false'`);
          return m.query(`SELECT core.ai_dev_mark_organisation_synthetic($1)`, [org.id]);
        })
        .catch((e) => e);
      expect(pgCode(refused)).toBe('55000');
      expect(String((refused as Error).message)).toMatch(/disposable test database/);
    });

    it('the marker cannot be set by a session-level SET of the GUC the definer uses', async () => {
      const org = await kit.factory.createOrganisation('ai-synth-guc');
      const admin = await kit.factory.createCeo(org, { permissions: 'production', platformAdmin: true });
      const result = await tenant
        .runInTenantContext({ organisationId: org.id, workspaceId: null, userId: admin.userId, role: '' }, async (m) => {
          await m.query(`SELECT set_config('rab.ai_synthetic_marker', 'on', true)`);
          return m.query(`UPDATE core.organisation_ai_setting SET synthetic_data = true WHERE organisation_id = $1`, [org.id]);
        })
        .catch((e) => e);
      expect(pgCode(result)).toBe('42501');
    });
  });

  // ── the per-organisation real-provider gate (owner condition 5) ─────────────────────────────────────────────────────
  describe('real provider: only a synthetic organisation, never on a test database', () => {
    it('with a READY real provider (Haiku resolves), a non-synthetic organisation gets 403 AI_DEMO_DATA_ONLY (eligible users only, D8)', async () => {
      const org = await aiOrganisation(kit, 'ai-real-nonsynthetic');
      jest.spyOn(config, 'availabilityContext').mockReturnValue(devContext());
      const availability = await kit.http().get('/rest/v1/ai/availability').set(bearer(org.token));
      expect(availability.status).toBe(200);
      expect(availability.body).toMatchObject({ available: false, reason: 'demo_data_only', message: 'AI is available for demo data only until the provider checklist is complete.' });
      const created = await kit.http().post('/rest/v1/ai/conversations').set(bearer(org.token)).send({});
      expect(created.status).toBe(403);
      expect(created.body).toEqual({ statusCode: 403, code: 'AI_DEMO_DATA_ONLY', message: 'AI is available for demo data only until the provider checklist is complete.' });
      expect(JSON.stringify(created.body)).not.toMatch(/haiku|anthropic|synthetic_data|CANARY/i);
    });

    it('even a synthetic organisation is refused on a database marked as a disposable test database', async () => {
      const org = await aiOrganisation(kit, 'ai-real-synthetic-testdb');
      await kit.owner.query(`UPDATE core.organisation_ai_setting SET synthetic_data = true WHERE organisation_id = $1`, [org.orgId]);
      jest.spyOn(config, 'availabilityContext').mockReturnValue(devContext());
      const availability = await kit.http().get('/rest/v1/ai/availability').set(bearer(org.token));
      expect(availability.body).toMatchObject({ available: false, reason: 'demo_data_only' });
    });

    it('a turn already queued is refused by the Worker before any model call (fixed AI_SERVICE_UNAVAILABLE)', async () => {
      const org = await aiOrganisation(kit, 'ai-real-worker');
      const conversationId = await newConversation(kit, org.token);
      const turn = await ask(kit, org.token, conversationId, 'How many shifts are unfilled this week?');
      expect(turn.status).toBe(202);
      const counting = countingDeterministicModel();
      kit.setModel(counting.model);
      try {
        jest.spyOn(config, 'availabilityContext').mockReturnValue(devContext());
        await expect(kit.runner.run(jobFor(org.ceo, conversationId, turn.turnId))).resolves.toBe('failed');
      } finally {
        kit.setModel(null);
      }
      expect(counting.calls.n).toBe(0);
      expect(await turnRow(kit, turn.turnId)).toMatchObject({ status: 'failed', error_code: 'AI_SERVICE_UNAVAILABLE', content: '' });
      const [audit] = await kit.owner.query(`SELECT metadata FROM core.audit_log WHERE action = 'ai.turn_refused' AND entity_id = $1`, [turn.turnId]);
      expect(audit.metadata).toMatchObject({ reason: 'real_provider_not_permitted', stage: 'worker_start' });
    });

    it('T2-12: a title job for a NON-synthetic organisation is refused before any request (no model built or called), codes only', async () => {
      const org = await aiOrganisation(kit, 'ai-real-title');
      const conversationId = await newConversation(kit, org.token);
      const turn = await ask(kit, org.token, conversationId, 'Plans for AB123456C at SW1A 1AA');
      expect(turn.status).toBe(202);
      const counting = countingDeterministicModel();
      kit.setModel(counting.model);
      try {
        jest.spyOn(config, 'availabilityContext').mockReturnValue(devContext());
        const job = titleJobData({ turnId: turn.turnId, conversationId, organisationId: org.orgId, workspaceId: org.ceo.workspaceId!, userId: org.ceo.userId });
        await expect(kit.moduleRef.get(AiTitleService).run(job)).resolves.toBe('refused');
      } finally {
        kit.setModel(null);
      }
      expect(counting.calls.n).toBe(0);
      const [audit] = await kit.owner.query(`SELECT metadata FROM core.audit_log WHERE action = 'ai.turn_refused' AND entity_id = $1`, [conversationId]);
      expect(audit.metadata).toEqual({ reason: 'real_provider_not_permitted', stage: 'title' });
      expect(JSON.stringify(audit)).not.toMatch(/AB123456C|SW1A/);
      expect((await kit.owner.query(`SELECT title_source FROM core.ai_conversation WHERE id = $1`, [conversationId]))[0].title_source).toBe('auto');
    });

    it('nothing usable (key removed / only unapproved models) makes AI "not configured" without stopping the API', async () => {
      const org = await aiOrganisation(kit, 'ai-unready');
      jest.spyOn(config, 'availabilityContext').mockReturnValue(devContext({ ANTHROPIC_API_KEY: undefined }));
      expect((await kit.http().get('/rest/v1/ai/availability').set(bearer(org.token))).body).toMatchObject({ available: false, reason: 'not_configured', setup: 'provider' });
      const res = await kit.http().get('/rest/v1/ai/conversations').set(bearer(org.token));
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: 'AI_NOT_CONFIGURED', setup: 'provider' });
      // Keyed, but the only approved model is disabled: setup 'model' ("Choose a model in Settings → AI").
      jest.spyOn(config, 'availabilityContext').mockReturnValue(devContext({ AI_MODELS_DEFAULT_DISABLED: AI_HAIKU_MODEL_ID }));
      expect((await kit.http().get('/rest/v1/ai/availability').set(bearer(org.token))).body).toMatchObject({ available: false, reason: 'not_configured', setup: 'model', message: 'Choose a model in Settings → AI' });
      expect((await kit.http().get('/healthz')).status).toBeLessThan(500);
    });
  });

  // ── owner-approved exception, control (a): request-time re-verification of the organisation's data ────────────────
  describe('core.ai_dev_synthetic_check() (re-verified before every real-provider request)', () => {
    const access = () => kit.moduleRef.get(AiAccessService);

    it('answers only for the bound organisation, read-only, with a fixed reason code', async () => {
      expect(await kit.runtime.query(`SELECT core.ai_dev_synthetic_check() AS r`)).toEqual([{ r: 'no_context' }]);
      const org = await aiOrganisation(kit, 'ai-synth-check');
      const actor = { organisationId: org.orgId, workspaceId: org.ceo.workspaceId!, userId: org.ceo.userId, sessionId: randomUUID() };
      expect(await access().syntheticCheckForRealRequest(actor)).toBe('not_synthetic');
      await kit.owner.query(`UPDATE core.organisation_ai_setting SET synthetic_data = true WHERE organisation_id = $1`, [org.orgId]);
      // Every user is @example.test (test identities), so the only remaining refusal on THIS database is its test marker.
      expect(await access().syntheticCheckForRealRequest(actor)).toBe('test_database');
      // A seeded non-@example.test user flips it at once (no cache).
      await kit.owner.query(`INSERT INTO core."user" (organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'Real', 'Person', 'invited')`, [org.orgId, `real-${randomUUID()}@gmail.com`]);
      expect(await access().syntheticCheckForRealRequest(actor)).toBe('non_synthetic_user');
    });

    it('cannot be used about another organisation (no parameter; the bound organisation only)', async () => {
      const a = await aiOrganisation(kit, 'ai-synth-check-a');
      const b = await aiOrganisation(kit, 'ai-synth-check-b');
      await kit.owner.query(`UPDATE core.organisation_ai_setting SET synthetic_data = true WHERE organisation_id = $1`, [b.orgId]);
      const [row] = await asTenant<Array<{ r: string }>>({ organisationId: a.orgId, workspaceId: a.ceo.workspaceId, userId: a.ceo.userId }, `SELECT core.ai_dev_synthetic_check() AS r`);
      expect(row!.r).toBe('not_synthetic');
    });
  });

  // ── per-model usage rows ─────────────────────────────────────────────────────────────────────────────────────────────
  it('a turn writes its usage row under the model it ran on, with an estimated cost (0 for the mock)', async () => {
    const org = await aiOrganisation(kit, 'ai-usage-model');
    const conversationId = await newConversation(kit, org.token);
    const turn = await ask(kit, org.token, conversationId, 'How many offers are awaiting replies?');
    await expect(kit.runner.run(jobFor(org.ceo, conversationId, turn.turnId))).resolves.toBe('completed');
    const rows = await kit.owner.query(`SELECT model, turns, cost_usd_micros::text AS cost FROM core.ai_usage_daily WHERE organisation_id = $1 AND usage_date = $2::date`, [org.orgId, utcDay()]);
    expect(rows).toEqual([{ model: 'crewflow-mock-1', turns: 1, cost: '0' }]);
    // crewflow_app may update the cost counter, never the model key.
    const ctx = { organisationId: org.orgId, workspaceId: org.ceo.workspaceId, userId: org.ceo.userId };
    await asTenant(ctx, `UPDATE core.ai_usage_daily SET cost_usd_micros = cost_usd_micros WHERE organisation_id = $1`, [org.orgId]);
    expect(pgCode(await asTenant(ctx, `UPDATE core.ai_usage_daily SET model = 'other' WHERE organisation_id = $1`, [org.orgId]).catch((e) => e))).toBe('42501');
  });

  // ── AI_DAILY_BUDGET_USD meter on the real Redis ──────────────────────────────────────────────────────────────────────
  describe('cost meter (atomic Redis reservation, seeded from ai_usage_daily, fail closed)', () => {
    const meter = () => kit.moduleRef.get(AiCostMeterService);

    it('concurrent reservations at the limit: exactly floor(budget / step) are admitted, never more', async () => {
      const org = randomUUID();
      const day = utcDay();
      const budget = config.dailyBudgetUsdMicros; // 2 USD
      const step = 300_000;
      const results = await Promise.allSettled(Array.from({ length: 25 }, () => meter().reserve(org, day, step, async () => 0)));
      const admitted = results.filter((r) => r.status === 'fulfilled').length;
      expect(admitted).toBe(Math.floor(budget / step));
      expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason instanceof AiCostBudgetExhaustedError)).toBe(true);
      expect(await meter().current(org, day)).toBe(admitted * step);
      await kit.redis.del(meter().meterKey(org, day));
    });

    it('settlement refunds the unused part of a reservation (never below zero)', async () => {
      const org = randomUUID();
      const day = utcDay();
      await meter().reserve(org, day, 500_000, async () => 0);
      await meter().settle(org, day, 120_000 - 500_000);
      expect(await meter().current(org, day)).toBe(120_000);
      await meter().settle(org, day, -10_000_000);
      expect(await meter().current(org, day)).toBe(0);
      await kit.redis.del(meter().meterKey(org, day));
    });

    it('a lost meter is re-seeded from the persisted cost, so a spent organisation stays spent', async () => {
      const org = await aiOrganisation(kit, 'ai-cost-reseed');
      const day = utcDay();
      await kit.owner.query(`INSERT INTO core.ai_usage_daily (organisation_id, usage_date, model, turns, cost_usd_micros) VALUES ($1, $2::date, $3, 3, 1900000)`, [org.orgId, day, AI_HAIKU_MODEL_ID]);
      await kit.redis.del(meter().meterKey(org.orgId, day));
      const ctx = { organisationId: org.orgId, workspaceId: org.ceo.workspaceId, userId: org.ceo.userId, role: '' };
      const seed = () => tenant.runInTenantContext(ctx, (m) => kit.moduleRef.get(AiUsageService).dayCostMicros(m, org.orgId, day));
      await expect(meter().reserve(org.orgId, day, 200_000, seed)).rejects.toBeInstanceOf(AiCostBudgetExhaustedError);
      await expect(meter().reserve(org.orgId, day, 50_000, seed)).resolves.toBe(50_000);
      expect(await meter().current(org.orgId, day)).toBe(1_950_000);
      await kit.redis.del(meter().meterKey(org.orgId, day));
    });

    it('Redis unavailable, or the seed read failing, refuses the step (AiQuotaUnavailableError)', async () => {
      const dead = new Redis('redis://127.0.0.1:1', { enableOfflineQueue: false, maxRetriesPerRequest: 0, connectTimeout: 200, lazyConnect: true, retryStrategy: () => null });
      dead.on('error', () => undefined);
      const broken = new AiCostMeterService(config, { client: dead } as never, {} as never, {} as never);
      await expect(broken.reserve(randomUUID(), utcDay(), 1, async () => 0)).rejects.toBeInstanceOf(AiQuotaUnavailableError);
      dead.disconnect();
      await expect(meter().reserve(randomUUID(), utcDay(), 1, async () => { throw new Error('db down'); })).rejects.toBeInstanceOf(AiQuotaUnavailableError);
    });
  });

  // ── the key stays invisible ─────────────────────────────────────────────────────────────────────────────────────────
  it('canary: the configured key never appears in the admin environment viewer, the AI overview or availability', async () => {
    const org = await kit.factory.createOrganisation('ai-canary-admin');
    const admin = await kit.factory.createCeo(org, { permissions: 'production', platformAdmin: true });
    const token = await kit.factory.login(admin);
    const env = await kit.http().get('/rest/v1/admin/config/environment').set(bearer(token));
    expect(env.status).toBe(200);
    const body = JSON.stringify(env.body);
    expect(body).not.toContain(CANARY);
    expect(body).not.toContain('INTEGRATION-CANARY');
    const row = (env.body.rows ?? env.body.environment ?? env.body).find?.((r: { key: string }) => r.key === 'ANTHROPIC_API_KEY');
    if (row) expect(row).toMatchObject({ state: 'set', value: null, source: 'env (secret)' });
    else expect(body).toContain('"key":"ANTHROPIC_API_KEY","state":"set","value":null');
    const overview = await kit.http().get('/rest/v1/admin/ai/overview').set(bearer(token));
    expect(overview.status).toBe(200);
    expect(JSON.stringify(overview.body)).not.toContain(CANARY);
    expect(overview.body.readiness).toMatchObject({ ready: true, realProvidersPermitted: false });
    expect(overview.body.models).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'crewflow-mock-1', state: 'available' }), expect.objectContaining({ id: AI_HAIKU_MODEL_ID, state: 'environment_refused' })]));
    expect(overview.body.providerKeys).toEqual(expect.arrayContaining([{ provider: 'anthropic', envName: 'ANTHROPIC_API_KEY', configured: true, sdkInstalled: true }]));
    for (const k of overview.body.providerKeys) expect(Object.keys(k).sort()).toEqual(['configured', 'envName', 'provider', 'sdkInstalled']);
    const tenantOrg = await aiOrganisation(kit, 'ai-canary-tenant');
    expect(JSON.stringify((await kit.http().get('/rest/v1/ai/availability').set(bearer(tenantOrg.token))).body)).not.toContain(CANARY);
  });
});
