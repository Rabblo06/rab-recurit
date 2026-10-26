import './helpers/ai-env';

import { randomUUID } from 'node:crypto';

import { AI_MODEL_LEVEL_KEYS } from '@rab/shared';

import { AiConfigService } from '../../modules/ai/services/ai-config.service';
import { TEST_MOCK_MODEL_ID, TEST_MODEL_CATALOGUE } from '../support/ai/test-catalogue';
import { AiKit, aiOrganisation, bearer, bootAiKit, jobFor, manager, newConversation, setOrgAi } from './helpers/ai-test-kit';

/**
 * C1 / CD-1 runner wiring: a level named on submit, end to end on the real AppModule, PostgreSQL (crewflow_app, FORCE
 * RLS) and Redis, with the in-process test model only. Abuse cases first: an unknown level and mass assignment are a
 * 400; a level the organisation does not allow is a 409 with NO turn, no audit and no reservation; a queued turn whose
 * level stops being allowed is refused at Worker start (no model call). Then the behaviour: the level and effort a turn
 * ran at are stamped, the level's cap bounds the reservation, and the composer's availability signal is on.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('C1 / CD-1: submit with a level, Worker wiring (integration)', () => {
  jest.setTimeout(240_000);
  let kit: AiKit;
  let config: AiConfigService;
  let org: Awaited<ReturnType<typeof aiOrganisation>>;

  beforeAll(async () => {
    kit = await bootAiKit();
    config = kit.moduleRef.get(AiConfigService);
    org = await aiOrganisation(kit, 'cd1-level');
  });
  afterEach(() => kit.setModel(null));
  afterAll(async () => {
    await kit?.close();
  });

  const submit = (token: string, conversationId: string, body: Record<string, unknown>) =>
    kit.http().post(`/rest/v1/ai/conversations/${conversationId}/messages`).set(bearer(token)).send({ content: 'How many shifts are unfilled this week?', clientRequestId: randomUUID(), ...body });
  const row = async (turnId: string) =>
    (await kit.owner.query(`SELECT status, level, effort, error_code, reserved_tokens, output_tokens FROM core.ai_message WHERE id = $1`, [turnId]))[0] as Record<string, unknown>;
  const turnsIn = async (conversationId: string) => (await kit.owner.query(`SELECT count(*)::int AS n FROM core.ai_message WHERE conversation_id = $1`, [conversationId]))[0].n as number;
  const setPolicy = (orgId: string, userId: string, chatLevel: string, allowed: string[]) =>
    kit.owner.query(
      `INSERT INTO core.organisation_ai_model_policy (organisation_id, chat_level, allowed_levels, updated_by, reason) VALUES ($1, $2, $3, $4, 'cd1 test')
       ON CONFLICT (organisation_id) DO UPDATE SET chat_level = EXCLUDED.chat_level, allowed_levels = EXCLUDED.allowed_levels`,
      [orgId, chatLevel, allowed, userId],
    );
  const perStep = (levelCap: number) => config.levelOutputTokens(TEST_MODEL_CATALOGUE.find((m) => m.id === TEST_MOCK_MODEL_ID)!, levelCap);

  // ── abuse cases ──────────────────────────────────────────────────────────────────────────────────────────────────
  it('an unknown level, a non-string level and a level beside forbidden keys are a 400; nothing is queued', async () => {
    const conversationId = await newConversation(kit, org.token);
    for (const body of [{ level: 'turbo' }, { level: 3 }, { level: 'EXTRA_FAST' }, { level: 'extra_fast', organisationId: org.orgId }, { level: 'extra_fast', model: TEST_MOCK_MODEL_ID }, { level: 'extra_fast', effort: 'high' }]) {
      expect({ body, status: (await submit(org.token, conversationId, body)).status }).toEqual({ body, status: 400 });
    }
    expect(await turnsIn(conversationId)).toBe(0);
  });

  it('a level outside allowedLevels is 409 AI_LEVEL_UNAVAILABLE: no turn, no audit, no reservation; never a fallback', async () => {
    const conversationId = await newConversation(kit, org.token);
    const auditsBefore = (await kit.owner.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE organisation_id = $1 AND action = 'ai.turn_started'`, [org.orgId]))[0].n;
    // Default policy: allowed = extra_fast + fast.
    for (const level of ['balanced', 'smart', 'extra_smart']) {
      const res = await submit(org.token, conversationId, { level });
      expect({ level, status: res.status, code: res.body.code }).toEqual({ level, status: 409, code: 'AI_LEVEL_UNAVAILABLE' });
      expect(JSON.stringify(res.body)).not.toMatch(/anthropic|haiku|sonnet|opus|test-/i);
    }
    expect(await turnsIn(conversationId)).toBe(0);
    expect((await kit.owner.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE organisation_id = $1 AND action = 'ai.turn_started'`, [org.orgId]))[0].n).toBe(auditsBefore);
  });

  it('the earlier gates still answer first: AI off for the organisation is the uniform 404, whatever level is named', async () => {
    const off = await aiOrganisation(kit, 'cd1-level-off');
    const conversationId = await newConversation(kit, off.token);
    await setOrgAi(kit, off.orgId, false);
    for (const level of ['extra_fast', 'extra_smart']) expect((await submit(off.token, conversationId, { level })).status).toBe(404);
  });

  it('a queued turn whose named level stops being allowed is refused at Worker start: failed, service unavailable, no model output', async () => {
    const own = await aiOrganisation(kit, 'cd1-level-narrowed');
    const conversationId = await newConversation(kit, own.token);
    const res = await submit(own.token, conversationId, { level: 'fast' });
    expect(res.status).toBe(202);
    expect((await row(res.body.turnId)).level).toBe('fast');
    await setPolicy(own.orgId, own.ceo.userId, 'extra_fast', ['extra_fast']);
    expect(await kit.runner.run(jobFor(own.ceo, conversationId, res.body.turnId))).toBe('failed');
    expect(await row(res.body.turnId)).toMatchObject({ status: 'failed', error_code: 'AI_SERVICE_UNAVAILABLE', output_tokens: 0 });
  });

  it('an Initial Manager (no ai.settings) may still name an allowed level for their own question (ai.use is the gate)', async () => {
    const im = await manager(kit, org.orgId, { initial: true });
    const conversationId = await newConversation(kit, im.token);
    expect((await submit(im.token, conversationId, { level: 'extra_fast' })).status).toBe(202);
  });

  // ── behaviour ────────────────────────────────────────────────────────────────────────────────────────────────────
  it('availability tells the composer that submit accepts `level`', async () => {
    const view = await kit.http().get('/rest/v1/ai/availability').set(bearer(org.token));
    expect(view.body.levels).toMatchObject({ chatLevel: 'extra_fast', submitAcceptsLevel: true });
    for (const option of view.body.levels.options) expect(AI_MODEL_LEVEL_KEYS).toContain(option.level);
  });

  it.each([
    ['extra_fast', 'low', 1_500],
    ['fast', 'medium', 4_000],
  ] as const)('named level %s: queued with it, run at it, effort %s stamped, reservation bounded by its cap', async (level, effort, cap) => {
    const conversationId = await newConversation(kit, org.token);
    const res = await submit(org.token, conversationId, { level });
    expect(res.status).toBe(202);
    expect(await row(res.body.turnId)).toMatchObject({ status: 'queued', level, effort: null, reserved_tokens: config.turnTokenReservationFor(perStep(cap)) });
    expect(await kit.runner.run(jobFor(org.ceo, conversationId, res.body.turnId))).toBe('completed');
    expect(await row(res.body.turnId)).toMatchObject({ status: 'completed', level, effort });
    const detail = await kit.http().get(`/rest/v1/ai/conversations/${conversationId}`).set(bearer(org.token));
    const [user, assistant] = detail.body.messages;
    expect(user).toMatchObject({ role: 'user', level: null, effort: null, reasoningMs: null });
    expect(assistant).toMatchObject({ role: 'assistant', level, effort });
  });

  it('no level named: queued with NULL, the Worker runs the organisation chat level and stamps level + effort', async () => {
    const own = await aiOrganisation(kit, 'cd1-level-default');
    const conversationId = await newConversation(kit, own.token);
    const first = await submit(own.token, conversationId, {});
    expect((await row(first.body.turnId)).level).toBeNull();
    expect(await kit.runner.run(jobFor(own.ceo, conversationId, first.body.turnId))).toBe('completed');
    expect(await row(first.body.turnId)).toMatchObject({ level: 'extra_fast', effort: 'low' });
  });
});
