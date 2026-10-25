import './helpers/ai-env';

import { createHash, randomUUID } from 'node:crypto';

import { AuthCacheRedisClientProvider } from '../../engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { AiConfigService } from '../../modules/ai/services/ai-config.service';
import { AiModelSettingsService } from '../../modules/ai/services/ai-model-settings.service';
import { TEST_MOCK_MODEL_ID, TEST_SMART_MODEL_ID } from '../support/ai/test-catalogue';
import { AiKit, aiOrganisation, bearer, bootAiKit, manager } from './helpers/ai-test-kit';
import { TestIdentity } from './helpers/test-identities';

/**
 * T-S1 / T-S2 (docs/ai/PHASE1_TWENTY_PLAN.md §7, D6/D7): Settings → AI "AI models" on the real AppModule, PostgreSQL
 * (crewflow_app, FORCE RLS) and Redis. Five layers: PermissionGuard(ai.settings) → service (flag re-read, CEO, both
 * switches, Inspect refusal, step-up + reason) → org-scoped query → RLS (organisation) → RLS writer predicate
 * `core.ai_settings_writer()` (CEO only). Pins are lookup keys: only an AVAILABLE model of the tier can be written.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const ORIGIN = 'http://localhost:5173';
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const sidOf = (token: string): string => (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { sid: string }).sid;
const pgCode = (e: unknown) => (e as { driverError?: { code?: string }; code?: string })?.driverError?.code ?? (e as { code?: string })?.code;

describeIfDb('Settings → AI model choice (integration)', () => {
  jest.setTimeout(240_000);
  let kit: AiKit;
  let tenant: TenantContextService;
  let authRedis: AuthCacheRedisClientProvider;

  beforeAll(async () => {
    kit = await bootAiKit();
    tenant = kit.moduleRef.get(TenantContextService);
    authRedis = kit.moduleRef.get(AuthCacheRedisClientProvider);
  });
  afterAll(async () => {
    await kit?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  const SETTINGS = '/rest/v1/ai/settings/models';
  const put = (token: string, tier: string, body: Record<string, unknown>) => kit.http().put(`${SETTINGS}/${tier}`).set(bearer(token)).set('Origin', ORIGIN).send(body);
  const del = (token: string, tier: string, body: Record<string, unknown>) => kit.http().delete(`${SETTINGS}/${tier}`).set(bearer(token)).set('Origin', ORIGIN).send(body);
  const staleToken = async (who: TestIdentity) => {
    const token = await kit.factory.login(who, { applicationTarget: 'manager_web' });
    await authRedis.client.del(`crewflow:test:step-up:${sha256(sidOf(token))}`);
    return token;
  };
  const pins = (orgId: string) => kit.owner.query(`SELECT tier, model_id, updated_by, reason FROM core.organisation_ai_model_preference WHERE organisation_id = $1 ORDER BY tier`, [orgId]);
  const asTenant = <T>(who: Pick<TestIdentity, 'organisationId' | 'workspaceId' | 'userId'>, sql: string, params: unknown[] = []) =>
    tenant.runInTenantContext({ organisationId: who.organisationId, workspaceId: who.workspaceId, userId: who.userId, role: '' }, (m) => m.query(sql, params) as Promise<T>);

  // ── T-S1 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  it('the CEO sees every model with its state; pins fast (fresh sign-in = step-up) with a reason; availability now uses the pin; audited', async () => {
    const org = await aiOrganisation(kit, 'ai-set-ceo');
    const view = await kit.http().get(SETTINGS).set(bearer(org.token));
    expect(view.status).toBe(200);
    expect(view.body.setup).toBeNull();
    const byId = Object.fromEntries((view.body.models as Array<{ id: string; state: string; selectable: boolean }>).map((m) => [m.id, m]));
    expect(byId[TEST_MOCK_MODEL_ID]).toMatchObject({ state: 'available', selectable: true, tier: 'fast' });
    expect(byId['anthropic-claude-haiku-5-5']).toMatchObject({ state: 'key_not_configured', selectable: false, stateLabel: 'Key not configured', priceUsdPerMTok: { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 } });
    expect(byId['anthropic-claude-sonnet-5-5']).toMatchObject({ state: 'not_approved', selectable: false });
    expect(byId['openai-gpt-6-luna-eu']).toMatchObject({ state: 'not_approved', priceUsdPerMTok: { input: 0.11, output: 0.55 }, region: 'eu' });
    expect(view.body.tiers).toEqual([
      { tier: 'fast', pinnedModelId: null, pinUnusable: false, resolved: { id: TEST_MOCK_MODEL_ID, label: expect.any(String), source: 'any' }, updatedAt: null },
      { tier: 'smart', pinnedModelId: null, pinUnusable: false, resolved: { id: TEST_SMART_MODEL_ID, label: expect.any(String), source: 'any' }, updatedAt: null },
    ]);

    const res = await put(org.token, 'fast', { modelId: TEST_MOCK_MODEL_ID, reason: 'pilot the fast model' });
    expect(res.status).toBe(200);
    expect(res.body.tiers[0]).toMatchObject({ tier: 'fast', pinnedModelId: TEST_MOCK_MODEL_ID, pinUnusable: false, resolved: { id: TEST_MOCK_MODEL_ID, source: 'pin' } });
    expect(await pins(org.orgId)).toEqual([{ tier: 'fast', model_id: TEST_MOCK_MODEL_ID, updated_by: org.ceo.userId, reason: 'pilot the fast model' }]);
    expect((await kit.http().get('/rest/v1/ai/availability').set(bearer(org.token))).body).toMatchObject({ available: true, model: { id: TEST_MOCK_MODEL_ID, source: 'pin' } });

    const cleared = await del(org.token, 'fast', { reason: 'back to automatic' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.tiers[0]).toMatchObject({ pinnedModelId: null, resolved: { source: 'any' } });
    expect(await pins(org.orgId)).toEqual([]);
    const audit = await kit.owner.query(`SELECT actor_user_id, metadata FROM core.audit_log WHERE organisation_id = $1 AND action = 'ai.default_changed' ORDER BY created_at`, [org.orgId]);
    expect(audit).toEqual([
      { actor_user_id: org.ceo.userId, metadata: { tier: 'fast', from: null, to: TEST_MOCK_MODEL_ID, reason: 'pilot the fast model' } },
      { actor_user_id: org.ceo.userId, metadata: { tier: 'fast', from: TEST_MOCK_MODEL_ID, to: null, reason: 'back to automatic' } },
    ]);
  });

  it('only an AVAILABLE model of THAT tier can be pinned: unknown, unavailable (unapproved / keyless) or wrong tier ⇒ 400, nothing written', async () => {
    const org = await aiOrganisation(kit, 'ai-set-400');
    for (const modelId of ['no-such-model', 'anthropic-claude-haiku-5-5', 'anthropic-claude-opus-5-5', 'openai-gpt-6-luna-eu', TEST_SMART_MODEL_ID]) {
      const res = await put(org.token, 'fast', { modelId, reason: 'try it' });
      expect({ modelId, status: res.status, body: res.body }).toEqual({ modelId, status: 400, body: { statusCode: 400, code: 'AI_MODEL_NOT_AVAILABLE', message: 'That model cannot be chosen.' } });
    }
    expect((await put(org.token, 'smart', { modelId: TEST_SMART_MODEL_ID, reason: 'smart one' })).status).toBe(200);
    expect((await put(org.token, 'medium', { modelId: TEST_MOCK_MODEL_ID, reason: 'bad tier' })).status).toBe(404);
    expect(await pins(org.orgId)).toEqual([expect.objectContaining({ tier: 'smart', model_id: TEST_SMART_MODEL_ID })]);
  });

  it('mass assignment: a body carrying organisationId / status / updatedBy / tier, or no reason, is a 400 and never applied', async () => {
    const org = await aiOrganisation(kit, 'ai-set-mass');
    for (const extra of [{ organisationId: randomUUID() }, { status: 'pinned' }, { updatedBy: randomUUID() }, { tier: 'smart' }]) {
      expect((await put(org.token, 'fast', { modelId: TEST_MOCK_MODEL_ID, reason: 'valid reason', ...extra })).status).toBe(400);
    }
    expect((await put(org.token, 'fast', { modelId: TEST_MOCK_MODEL_ID })).status).toBe(400);
    expect((await put(org.token, 'fast', { modelId: TEST_MOCK_MODEL_ID, reason: 'x' })).status).toBe(400);
    expect((await del(org.token, 'fast', {})).status).toBe(400);
    expect((await put(org.token, 'fast', { modelId: 'Bad Id!', reason: 'valid reason' })).status).toBe(400);
    expect(await pins(org.orgId)).toEqual([]);
  });

  it('without ai.settings (the Initial Manager, who may USE AI) ⇒ 403 on every settings route', async () => {
    const org = await aiOrganisation(kit, 'ai-set-noflag');
    const im = await manager(kit, org.orgId, { initial: true });
    expect((await kit.http().get('/rest/v1/ai/availability').set(bearer(im.token))).body).toMatchObject({ available: true });
    expect((await kit.http().get(SETTINGS).set(bearer(im.token))).status).toBe(403);
    expect((await put(im.token, 'fast', { modelId: TEST_MOCK_MODEL_ID, reason: 'not mine' })).status).toBe(403);
    expect((await del(im.token, 'fast', { reason: 'not mine' })).status).toBe(403);
    expect(await pins(org.orgId)).toEqual([]);
  });

  it('a NON-CEO granted ai.settings (custom role / override) gets the uniform 404 from the service, and RLS refuses a direct write', async () => {
    const org = await aiOrganisation(kit, 'ai-set-custom');
    const other = await manager(kit, org.orgId);
    await kit.owner.query(
      `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect) SELECT $1, id, $2, 'grant' FROM core.permission WHERE key = 'ai.settings'`,
      [other.id.userId, org.orgId],
    );
    await kit.owner.query(`UPDATE core."user" SET security_version = security_version + 1 WHERE id = $1`, [other.id.userId]).catch(() => undefined);
    const token = await kit.factory.login(other.id);
    expect((await kit.http().get(SETTINGS).set(bearer(token))).body).toMatchObject({ code: 'AI_NOT_AVAILABLE' });
    expect((await kit.http().get(SETTINGS).set(bearer(token))).status).toBe(404);
    expect((await put(token, 'fast', { modelId: TEST_MOCK_MODEL_ID, reason: 'not the CEO' })).status).toBe(404);
    // Layer 5 on its own: the same user, bound to its own organisation, writing the table directly.
    expect(pgCode(await asTenant(other.id, `INSERT INTO core.organisation_ai_model_preference (organisation_id, tier, model_id, updated_by, reason) VALUES ($1, 'fast', $2, $3, 'direct write')`, [org.orgId, TEST_MOCK_MODEL_ID, other.id.userId]).catch((e) => e))).toBe('42501');
    await put(org.token, 'fast', { modelId: TEST_MOCK_MODEL_ID, reason: 'the CEO pins it' });
    expect(await asTenant<unknown[]>(other.id, `UPDATE core.organisation_ai_model_preference SET model_id = 'x-other', updated_by = $2 WHERE organisation_id = $1 RETURNING tier`, [org.orgId, other.id.userId])).toEqual([[], 0]);
    expect(await asTenant<unknown[]>(other.id, `DELETE FROM core.organisation_ai_model_preference WHERE organisation_id = $1 RETURNING tier`, [org.orgId])).toEqual([[], 0]);
    expect(await pins(org.orgId)).toEqual([expect.objectContaining({ tier: 'fast', model_id: TEST_MOCK_MODEL_ID })]);
  });

  it('step-up: a STALE session is refused 403 STEP_UP_REQUIRED (nothing written, refusal audited); after POST /auth/step-up it works', async () => {
    const org = await aiOrganisation(kit, 'ai-set-stepup');
    const stale = await staleToken(org.ceo);
    for (const res of [await put(stale, 'fast', { modelId: TEST_MOCK_MODEL_ID, reason: 'stale probe' }), await del(stale, 'fast', { reason: 'stale probe' })]) {
      expect({ status: res.status, code: res.body.code }).toEqual({ status: 403, code: 'STEP_UP_REQUIRED' });
    }
    expect(await pins(org.orgId)).toEqual([]);
    const [{ n }] = await kit.owner.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE actor_user_id = $1 AND action = 'auth.step_up_failed' AND metadata->>'action' = 'organisation.ai.model.update'`, [org.ceo.userId]);
    expect(n).toBe(2);
    expect((await kit.http().post('/rest/v1/auth/step-up').set(bearer(stale)).set('Origin', ORIGIN).send({ currentPassword: org.ceo.password })).status).toBe(200);
    expect((await put(stale, 'fast', { modelId: TEST_MOCK_MODEL_ID, reason: 'after step-up' })).status).toBe(200);
  });

  it('both switches gate the settings: organisation AI off or the platform kill switch ⇒ 404 (no model choice for an AI-off organisation)', async () => {
    const off = await aiOrganisation(kit, 'ai-set-off', { aiEnabled: false });
    expect((await kit.http().get(SETTINGS).set(bearer(off.token))).status).toBe(404);
    expect((await put(off.token, 'fast', { modelId: TEST_MOCK_MODEL_ID, reason: 'org is off' })).status).toBe(404);
    const on = await aiOrganisation(kit, 'ai-set-kill');
    jest.spyOn(kit.moduleRef.get(AiConfigService), 'enabled', 'get').mockReturnValue(false);
    expect((await kit.http().get(SETTINGS).set(bearer(on.token))).status).toBe(404);
  });

  it('Admin Inspect is refused (service layer, layer 2), for reads and writes', async () => {
    const org = await aiOrganisation(kit, 'ai-set-inspect');
    const svc = kit.moduleRef.get(AiModelSettingsService);
    const ctx = { organisationId: org.ceo.organisationId, workspaceId: org.ceo.workspaceId, userId: org.ceo.userId, role: '', inspectedBy: randomUUID(), sessionId: randomUUID() };
    await expect(svc.view(ctx)).rejects.toMatchObject({ status: 404 });
    await expect(svc.pin(ctx, 'fast', TEST_MOCK_MODEL_ID, 'inspect probe')).rejects.toMatchObject({ status: 404 });
    await expect(svc.unpin(ctx, 'fast', 'inspect probe')).rejects.toMatchObject({ status: 404 });
  });

  it('a stale pin (model no longer usable) is reported and SKIPPED — never called — and the resolver falls back', async () => {
    const org = await aiOrganisation(kit, 'ai-set-stale');
    await kit.owner.query(`INSERT INTO core.organisation_ai_model_preference (organisation_id, tier, model_id, updated_by, reason) VALUES ($1, 'fast', 'anthropic-claude-opus-5-5', $2, 'seeded stale pin')`, [org.orgId, org.ceo.userId]);
    const view = await kit.http().get(SETTINGS).set(bearer(org.token));
    expect(view.body.tiers[0]).toMatchObject({ pinnedModelId: 'anthropic-claude-opus-5-5', pinUnusable: true, resolved: { id: TEST_MOCK_MODEL_ID, source: 'any' } });
    expect((await kit.http().get('/rest/v1/ai/availability').set(bearer(org.token))).body).toMatchObject({ available: true, model: { id: TEST_MOCK_MODEL_ID, source: 'any' } });
  });

  // ── T-S2: the M2 table under RLS ────────────────────────────────────────────────────────────────────────────────────
  describe('T-S2 core.organisation_ai_model_preference (FORCE RLS, CEO writer predicate, column grants)', () => {
    it('zero rows with no tenant context bound; a foreign organisation reads 0 rows', async () => {
      const a = await aiOrganisation(kit, 'ai-set-rls-a');
      const b = await aiOrganisation(kit, 'ai-set-rls-b');
      await put(a.token, 'fast', { modelId: TEST_MOCK_MODEL_ID, reason: 'org A pin' });
      expect((await kit.owner.query(`SELECT count(*)::int AS n FROM core.organisation_ai_model_preference WHERE organisation_id = $1`, [a.orgId]))[0].n).toBe(1);
      expect(await kit.runtime.query(`SELECT count(*)::int AS n FROM core.organisation_ai_model_preference`)).toEqual([{ n: 0 }]);
      expect(await asTenant(b.ceo, `SELECT * FROM core.organisation_ai_model_preference WHERE organisation_id = $1`, [a.orgId])).toEqual([]);
      // B's CEO cannot write A's row either (WITH CHECK on the bound organisation).
      expect(pgCode(await asTenant(b.ceo, `INSERT INTO core.organisation_ai_model_preference (organisation_id, tier, model_id, updated_by, reason) VALUES ($1, 'smart', $2, $3, 'cross-tenant')`, [a.orgId, TEST_SMART_MODEL_ID, b.ceo.userId]).catch((e) => e))).toBe('42501');
      expect(await asTenant<unknown[]>(b.ceo, `UPDATE core.organisation_ai_model_preference SET model_id = 'x', updated_by = $2 WHERE organisation_id = $1 RETURNING tier`, [a.orgId, b.ceo.userId])).toEqual([[], 0]);
    });

    it('the CEO cannot forge updated_by, move a row to another organisation/tier, or TRUNCATE (column grants + WITH CHECK)', async () => {
      const org = await aiOrganisation(kit, 'ai-set-grants');
      expect(pgCode(await asTenant(org.ceo, `INSERT INTO core.organisation_ai_model_preference (organisation_id, tier, model_id, updated_by, reason) VALUES ($1, 'fast', $2, $3, 'forged author')`, [org.orgId, TEST_MOCK_MODEL_ID, randomUUID()]).catch((e) => e))).toBe('42501');
      await asTenant(org.ceo, `INSERT INTO core.organisation_ai_model_preference (organisation_id, tier, model_id, updated_by, reason) VALUES ($1, 'fast', $2, $3, 'direct CEO write')`, [org.orgId, TEST_MOCK_MODEL_ID, org.ceo.userId]);
      for (const sql of [
        `UPDATE core.organisation_ai_model_preference SET organisation_id = gen_random_uuid() WHERE organisation_id = $1`,
        `UPDATE core.organisation_ai_model_preference SET tier = 'smart' WHERE organisation_id = $1`,
        `UPDATE core.organisation_ai_model_preference SET created_at = now() WHERE organisation_id = $1`,
      ]) {
        expect(pgCode(await asTenant(org.ceo, sql, [org.orgId]).catch((e) => e))).toBe('42501');
      }
      expect(pgCode(await asTenant(org.ceo, `TRUNCATE core.organisation_ai_model_preference`).catch((e) => e))).toBe('42501');
      expect(pgCode(await asTenant(org.ceo, `INSERT INTO core.organisation_ai_model_preference (organisation_id, tier, model_id, updated_by, reason) VALUES ($1, 'smart', 'Not An Id', $2, 'bad id')`, [org.orgId, org.ceo.userId]).catch((e) => e))).toBe('23514');
    });

    it('the organisation AI switch row stays platform-admin-only: a CEO can neither insert nor update it', async () => {
      const org = await aiOrganisation(kit, 'ai-set-switch', { aiEnabled: false });
      expect(await asTenant<unknown[]>(org.ceo, `UPDATE core.organisation_ai_setting SET enabled = true WHERE organisation_id = $1 RETURNING organisation_id`, [org.orgId])).toEqual([[], 0]);
      const fresh = await kit.factory.createOrganisation('ai-set-switch-new');
      const ceo = await kit.factory.createCeo(fresh, { permissions: 'production' });
      expect(pgCode(await asTenant(ceo, `INSERT INTO core.organisation_ai_setting (organisation_id, enabled) VALUES ($1, true)`, [fresh.id]).catch((e) => e))).toBe('42501');
      const [row] = await kit.owner.query(`SELECT enabled FROM core.organisation_ai_setting WHERE organisation_id = $1`, [org.orgId]);
      expect(row.enabled).toBe(false);
    });

    it('core.ai_settings_writer() is true only for the bound organisation\'s CEO (not an Initial Manager, not unbound)', async () => {
      const org = await aiOrganisation(kit, 'ai-set-writer');
      const im = await manager(kit, org.orgId, { initial: true });
      expect(await asTenant(org.ceo, `SELECT core.ai_settings_writer() AS w`)).toEqual([{ w: true }]);
      expect(await asTenant(im.id, `SELECT core.ai_settings_writer() AS w`)).toEqual([{ w: false }]);
      expect(await kit.runtime.query(`SELECT core.ai_settings_writer() AS w`)).toEqual([{ w: false }]);
    });
  });
});
