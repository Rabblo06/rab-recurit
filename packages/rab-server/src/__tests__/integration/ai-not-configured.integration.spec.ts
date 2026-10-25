import './helpers/ai-env';

import { randomUUID } from 'node:crypto';

const CANARY = 'sk-ant-api03-NOTCONFIGURED-CANARY-'.padEnd(72, 'N');

import { AiAvailabilityContext, NO_LEGACY_AI_ENV } from '../../engine/core-modules/ai/ai-readiness';
import { AI_HAIKU_MODEL_ID, AI_MODEL_CATALOGUE } from '../../engine/core-modules/ai/models/catalog';
import { TEST_MODEL_CATALOGUE } from '../support/ai/test-catalogue';
import { AiConversationService } from '../../modules/ai/services/ai-conversation.service';
import { AiConfigService } from '../../modules/ai/services/ai-config.service';
import { AiKit, aiOrganisation, bearer, bootAiKit, manager } from './helpers/ai-test-kit';

/**
 * T-A1 / T-A2 (docs/ai/PHASE1_TWENTY_PLAN.md §6): "real models only" — with NO usable model the app does not fake an
 * answer. This suite boots the real AppModule WITHOUT the test catalogue, so under NODE_ENV=test nothing resolves (no
 * provider key, and test refuses real providers): exactly the "no key set anywhere" state. Rows 3–11 of the §6 table,
 * per AI route, in the disclosure ORDER: 404 for everyone before eligibility + both switches; 503 AI_NOT_CONFIGURED /
 * 403 AI_DEMO_DATA_ONLY only for an eligible user of an enabled organisation; /availability always 200; DELETE ungated.
 * Where a row needs a different PLATFORM state the test replaces only `availabilityContext` (env + catalogue).
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const PROVIDER_TEXT = "AI isn't set up yet. A platform admin needs to add a provider key";
const MODEL_TEXT = 'Choose a model in Settings → AI';
const DEMO_TEXT = 'AI is available for demo data only until the provider checklist is complete.';

describeIfDb('AI not configured: ordered 404 / 503 / 403 (integration)', () => {
  jest.setTimeout(240_000);
  let kit: AiKit;
  let config: AiConfigService;

  beforeAll(async () => {
    kit = await bootAiKit({ testModels: null });
    config = kit.moduleRef.get(AiConfigService);
  });
  afterAll(async () => {
    await kit?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  const withContext = (ctx: { env: Partial<AiAvailabilityContext['env']>; runtimeDb?: AiAvailabilityContext['runtimeDb']; catalogue?: AiAvailabilityContext['catalogue'] }) =>
    jest.spyOn(config, 'availabilityContext').mockReturnValue({
      env: { NODE_ENV: 'test', AI_ENABLED: true, AI_DEV_ALLOW_REAL_PROVIDERS: false, ...ctx.env },
      runtimeDb: ctx.runtimeDb ?? null,
      legacy: NO_LEGACY_AI_ENV,
      catalogue: ctx.catalogue ?? AI_MODEL_CATALOGUE,
    });
  const devReady = () => withContext({ env: { NODE_ENV: 'development', ANTHROPIC_API_KEY: CANARY, AI_DEV_ALLOW_REAL_PROVIDERS: true }, runtimeDb: { runtimeEnvironment: 'development', classification: 'LOCAL' } });
  const testReady = () => withContext({ env: {}, catalogue: [...AI_MODEL_CATALOGUE, ...TEST_MODEL_CATALOGUE] });

  const routes = (conversationId: string, turnId: string) =>
    [
      ['get', '/rest/v1/ai/conversations'],
      ['post', '/rest/v1/ai/conversations'],
      ['get', `/rest/v1/ai/conversations/${conversationId}`],
      ['post', `/rest/v1/ai/conversations/${conversationId}/messages`],
      ['post', `/rest/v1/ai/conversations/${conversationId}/turns/${turnId}/cancel`],
      ['get', `/rest/v1/ai/conversations/${conversationId}/stream?turnId=${turnId}`],
    ] as const;
  async function statuses(token: string, conversationId = randomUUID(), turnId = randomUUID()) {
    const out: Array<{ url: string; status: number; body: unknown }> = [];
    for (const [method, url] of routes(conversationId, turnId)) {
      const req = kit.http()[method](url).set(bearer(token));
      const res = method === 'post' ? await req.send(url.endsWith('/messages') ? { content: 'Which shifts this weekend are unfilled?', clientRequestId: randomUUID() } : {}) : await req;
      out.push({ url, status: res.status, body: res.body });
    }
    return out;
  }
  const availability = async (token: string) => (await kit.http().get('/rest/v1/ai/availability').set(bearer(token))).body as Record<string, unknown>;
  const nothingWritten = async (orgId: string) => {
    const [row] = await kit.owner.query(
      `SELECT (SELECT count(*) FROM core.ai_message WHERE organisation_id = $1)::int AS messages, (SELECT count(*) FROM core.ai_usage_daily WHERE organisation_id = $1)::int AS usage`,
      [orgId],
    );
    expect(row).toEqual({ messages: 0, usage: 0 });
  };

  it('row 7: eligible CEO, organisation on, NO provider key ⇒ every AI route 503 with the byte-equal fixed body; nothing sent or recorded', async () => {
    const org = await aiOrganisation(kit, 'ai-nc-provider');
    const expected = { statusCode: 503, code: 'AI_NOT_CONFIGURED', setup: 'provider', message: PROVIDER_TEXT };
    for (const r of await statuses(org.token)) expect({ url: r.url, status: r.status, body: r.body }).toEqual({ url: r.url, status: 503, body: expected });
    expect(await availability(org.token)).toMatchObject({ available: false, reason: 'not_configured', setup: 'provider', message: PROVIDER_TEXT, usage: null });
    await nothingWritten(org.orgId);
  });

  it('row 8: a key is set but this environment refuses real providers (test) ⇒ the same 503 setup "provider"; the key appears nowhere', async () => {
    const org = await aiOrganisation(kit, 'ai-nc-env');
    withContext({ env: { ANTHROPIC_API_KEY: CANARY } });
    const res = await kit.http().get('/rest/v1/ai/conversations').set(bearer(org.token));
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ statusCode: 503, code: 'AI_NOT_CONFIGURED', setup: 'provider', message: PROVIDER_TEXT });
    const avail = await availability(org.token);
    expect(avail).toMatchObject({ reason: 'not_configured', setup: 'provider' });
    expect(JSON.stringify([res.body, avail])).not.toContain(CANARY);
  });

  it('row 9: a key is set and real providers are permitted, but NO model resolves ⇒ 503 setup "model" ("Choose a model in Settings → AI")', async () => {
    const org = await aiOrganisation(kit, 'ai-nc-model');
    withContext({ env: { NODE_ENV: 'development', ANTHROPIC_API_KEY: CANARY, AI_DEV_ALLOW_REAL_PROVIDERS: true, AI_MODELS_DEFAULT_DISABLED: AI_HAIKU_MODEL_ID }, runtimeDb: { runtimeEnvironment: 'development', classification: 'LOCAL' } });
    const expected = { statusCode: 503, code: 'AI_NOT_CONFIGURED', setup: 'model', message: MODEL_TEXT };
    for (const r of await statuses(org.token)) expect({ url: r.url, status: r.status, body: r.body }).toEqual({ url: r.url, status: 503, body: expected });
    expect(await availability(org.token)).toMatchObject({ reason: 'not_configured', setup: 'model', message: MODEL_TEXT });
    await nothingWritten(org.orgId);
  });

  it('row 10: a real model is ready but the organisation is not synthetic ⇒ every AI route 403 AI_DEMO_DATA_ONLY (fixed body)', async () => {
    const org = await aiOrganisation(kit, 'ai-nc-demo');
    devReady();
    const expected = { statusCode: 403, code: 'AI_DEMO_DATA_ONLY', message: DEMO_TEXT };
    for (const r of await statuses(org.token)) expect({ url: r.url, status: r.status, body: r.body }).toEqual({ url: r.url, status: 403, body: expected });
    expect(await availability(org.token)).toMatchObject({ available: false, reason: 'demo_data_only', message: DEMO_TEXT });
    await nothingWritten(org.orgId);
  });

  it('rows 3–6 come FIRST: an ineligible manager, a CEO without ai.use, an org-off CEO and the kill switch all get the uniform 404 even with no key', async () => {
    const org = await aiOrganisation(kit, 'ai-nc-order');
    const other = await manager(kit, org.orgId); // an additional Internal Manager holding ai.use: not eligible
    for (const r of await statuses(other.token)) expect({ url: r.url, status: r.status, code: (r.body as { code?: string }).code }).toEqual({ url: r.url, status: 404, code: 'AI_NOT_AVAILABLE' });
    expect(await availability(other.token)).toEqual(expect.objectContaining({ available: false, reason: 'not_permitted' }));
    expect(await availability(other.token)).not.toHaveProperty('setup');

    const noUse = await kit.factory.createOrganisation('ai-nc-nouse');
    await kit.owner.query(`INSERT INTO core.organisation_ai_setting (organisation_id, enabled) VALUES ($1, true)`, [noUse.id]);
    const ceoNoUse = await kit.factory.createCeo(noUse, { permissions: ['schedule.view'] });
    const t = await kit.factory.login(ceoNoUse);
    for (const r of await statuses(t)) expect(r.status).toBe(404);
    expect(await availability(t)).toMatchObject({ reason: 'not_permitted' });

    const off = await aiOrganisation(kit, 'ai-nc-off', { aiEnabled: false });
    for (const r of await statuses(off.token)) expect(r.status).toBe(404);
    expect(await availability(off.token)).toMatchObject({ reason: 'organisation_disabled' });

    jest.spyOn(config, 'enabled', 'get').mockReturnValue(false);
    for (const r of await statuses(org.token)) expect(r.status).toBe(404);
    expect(await availability(org.token)).toMatchObject({ reason: 'platform_disabled' });
    // …and the ineligible manager still learns only "not permitted" while the kill switch is off.
    expect(await availability(other.token)).toMatchObject({ reason: 'not_permitted' });
  });

  it('row 3: an Admin Inspect context is refused before anything (service layer), never 503', async () => {
    const { ceo } = await aiOrganisation(kit, 'ai-nc-inspect');
    const svc = kit.moduleRef.get(AiConversationService);
    const ctx = { organisationId: ceo.organisationId, workspaceId: ceo.workspaceId, userId: ceo.userId, role: '', inspectedBy: randomUUID() };
    await expect(svc.list(ctx, {})).rejects.toMatchObject({ status: 404, response: { code: 'AI_NOT_AVAILABLE' } });
    expect(await svc.availability(ctx)).toMatchObject({ available: false, reason: 'not_permitted' });
  });

  it('row 11 + T-A2: when a model resolves everything works; DELETE stays ungated when AI is not configured (erasure never depends on it)', async () => {
    const org = await aiOrganisation(kit, 'ai-nc-delete');
    testReady();
    expect(await availability(org.token)).toMatchObject({ available: true, reason: null, model: { id: 'crewflow-mock-1', tier: 'fast', source: 'any' } });
    const created = await kit.http().post('/rest/v1/ai/conversations').set(bearer(org.token)).send({});
    expect(created.status).toBe(201);
    jest.restoreAllMocks(); // back to "no model"
    expect((await kit.http().get(`/rest/v1/ai/conversations/${created.body.id}`).set(bearer(org.token))).status).toBe(503);
    expect((await kit.http().delete(`/rest/v1/ai/conversations/${created.body.id}`).set(bearer(org.token))).status).toBe(204);
    const [{ n }] = await kit.owner.query(`SELECT count(*)::int AS n FROM core.ai_conversation WHERE id = $1`, [created.body.id]);
    expect(n).toBe(0);
  });
});
