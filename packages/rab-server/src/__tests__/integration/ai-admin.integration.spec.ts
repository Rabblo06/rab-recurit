import './helpers/ai-env';

import { AI_READ_TOOL_NAMES } from '@rab/shared';

import { createHash, randomUUID } from 'node:crypto';

import { AuthCacheRedisClientProvider } from '../../engine/core-modules/auth/services/auth-cache-redis-client.provider';

import { AiAdminService } from '../../modules/ai/services/ai-admin.service';
import { utcDay } from '../../modules/ai/services/ai-quota.service';
import { AiKit, aiOrganisation, ask, bearer, bootAiKit, jobFor, newConversation } from './helpers/ai-test-kit';

/**
 * AI Phase 1 — platform administration (brief §13, §14): the per-organisation switch is platform-admin only, step-up
 * gated and audited in the TARGET organisation; usage is METADATA only (`core.ai_admin_usage_summary`); a platform
 * administrator has no route — and no RLS branch — to read anyone's transcript.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const USAGE_KEYS = ['aiEnabled', 'cancelledTurns', 'failedTurns', 'inputTokens', 'organisationId', 'organisationName', 'outputTokens', 'toolCalls', 'turns'];

describeIfDb('AI platform administration (integration)', () => {
  jest.setTimeout(180_000);
  let kit: AiKit;
  let admin: Awaited<ReturnType<typeof aiOrganisation>>;

  beforeAll(async () => {
    kit = await bootAiKit();
    const org = await kit.factory.createOrganisation('ai-admin-home');
    const ceo = await kit.factory.createCeo(org, { permissions: 'production', platformAdmin: true });
    admin = { orgId: org.id, ceo, token: await kit.factory.login(ceo) };
  });
  afterAll(async () => {
    await kit?.close();
  });

  it('a non-administrator (even an eligible CEO) gets 403 on every admin AI route', async () => {
    const tenant = await aiOrganisation(kit, 'ai-admin-tenant');
    for (const [method, url] of [
      ['get', '/rest/v1/admin/ai/overview'],
      ['get', `/rest/v1/admin/ai/usage?from=${utcDay()}&to=${utcDay()}`],
      ['get', `/rest/v1/admin/ai/organisations/${tenant.orgId}/setting`],
      ['put', `/rest/v1/admin/ai/organisations/${tenant.orgId}/setting`],
    ] as const) {
      const req = kit.http()[method](url).set(bearer(tenant.token));
      expect((method === 'put' ? await req.send({ enabled: true }) : await req).status).toBe(403);
    }
  });

  it('overview: configuration facts and queue health, never the provider key', async () => {
    const res = await kit.http().get('/rest/v1/admin/ai/overview').set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ platformEnabled: true, telemetry: 'disabled', retention: { days: 90, mode: 'off' }, defaults: { fast: [], smart: [], disabled: [] } });
    // Phase 1 "real models only": a model list with platform states and key status per provider (booleans only).
    expect(res.body.models.find((m: { id: string }) => m.id === 'crewflow-mock-1')).toMatchObject({ state: 'available', selectable: true });
    expect(res.body.models.find((m: { id: string }) => m.id === 'anthropic-claude-haiku-5-5')).toMatchObject({ state: 'key_not_configured', selectable: false });
    expect(res.body.models.find((m: { id: string }) => m.id === 'anthropic-claude-sonnet-5-5')).toMatchObject({ state: 'not_approved', stateLabel: 'Not approved' });
    expect(res.body.providerKeys.map((k: { envName: string; configured: boolean }) => `${k.envName}:${k.configured}`)).toEqual(['ANTHROPIC_API_KEY:false', 'OPENAI_API_KEY:false', 'GOOGLE_API_KEY:false', 'MISTRAL_API_KEY:false', 'XAI_API_KEY:false']);
    for (const legacy of ['provider', 'model', 'modelAllowlisted', 'credentialsConfigured', 'externalProvider', 'modelFacts']) expect(res.body).not.toHaveProperty(legacy);
    // AI Phase 3: the registry's full read set (12, no holiday tool), fixed text and flags only.
    expect(res.body.tools.map((t: { name: string }) => t.name).sort()).toEqual([...AI_READ_TOOL_NAMES].sort());
    expect(JSON.stringify(res.body)).not.toMatch(/AI_PROVIDER_API_KEY|apiKey|secret/i);
  });

  it('the organisation switch: admin turns it ON (step-up + audit in the target org), the CEO gains access; OFF removes it again', async () => {
    const org = await kit.factory.createOrganisation('ai-admin-switch');
    const ceo = await kit.factory.createCeo(org, { permissions: 'production' });
    const ceoToken = await kit.factory.login(ceo);
    expect((await kit.http().get('/rest/v1/ai/conversations').set(bearer(ceoToken))).status).toBe(404);
    const freshAdmin = await kit.factory.login(admin.ceo); // a fresh sign-in carries the step-up grant
    const on = await kit.http().put(`/rest/v1/admin/ai/organisations/${org.id}/setting`).set(bearer(freshAdmin)).send({ enabled: true, reason: 'pilot organisation' });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ organisationId: org.id, enabled: true });
    expect((await kit.http().get('/rest/v1/ai/conversations').set(bearer(ceoToken))).status).toBe(200);
    const audit = await kit.owner.query(`SELECT actor_user_id, metadata FROM core.audit_log WHERE organisation_id = $1 AND action = 'ai.organisation_setting_changed'`, [org.id]);
    expect(audit).toEqual([{ actor_user_id: admin.ceo.userId, metadata: { enabled: true, previous: false, via: 'platform_admin', reason: 'pilot organisation' } }]);
    const off = await kit.http().put(`/rest/v1/admin/ai/organisations/${org.id}/setting`).set(bearer(freshAdmin)).send({ enabled: false });
    expect(off.body.enabled).toBe(false);
    expect((await kit.http().get('/rest/v1/ai/conversations').set(bearer(ceoToken))).status).toBe(404);
    // Unknown organisation → 404; extra fields → 400.
    expect((await kit.http().put(`/rest/v1/admin/ai/organisations/${randomUUID()}/setting`).set(bearer(freshAdmin)).send({ enabled: true })).status).toBe(404);
    expect((await kit.http().put(`/rest/v1/admin/ai/organisations/${org.id}/setting`).set(bearer(freshAdmin)).send({ enabled: true, organisationId: randomUUID() })).status).toBe(400);
  });

  it('ABUSE (AI-F2): a stale admin session is refused 403 STEP_UP_REQUIRED, nothing is written, and the refusal names organisation.ai.update', async () => {
    const org = await kit.factory.createOrganisation('ai-admin-stale');
    const stale = await kit.factory.login(admin.ceo);
    const sid = (JSON.parse(Buffer.from(stale.split('.')[1]!, 'base64url').toString('utf8')) as { sid: string }).sid;
    await kit.moduleRef.get(AuthCacheRedisClientProvider).client.del(`crewflow:test:step-up:${createHash('sha256').update(sid).digest('hex')}`);
    const refusals = async () =>
      (await kit.owner.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE actor_user_id = $1 AND action = 'auth.step_up_failed' AND metadata->>'action' = 'organisation.ai.update'`, [admin.ceo.userId]))[0].n as number;
    const before = await refusals();
    const res = await kit.http().put(`/rest/v1/admin/ai/organisations/${org.id}/setting`).set(bearer(stale)).send({ enabled: true, reason: 'stale session' });
    expect({ status: res.status, code: res.body.code }).toEqual({ status: 403, code: 'STEP_UP_REQUIRED' });
    expect(await refusals()).toBe(before + 1);
    expect(await kit.owner.query(`SELECT 1 FROM core.organisation_ai_setting WHERE organisation_id = $1`, [org.id])).toEqual([]);
    // Service-direct (no guard): refused the same way.
    await expect(kit.moduleRef.get(AiAdminService).setOrganisationSetting({ userId: admin.ceo.userId, organisationId: admin.orgId, workspaceId: admin.ceo.workspaceId, sessionId: sid }, org.id, true)).rejects.toMatchObject({ status: 403 });
  });

  it('Admin Inspect cannot change the switch (service layer)', async () => {
    const svc = kit.moduleRef.get(AiAdminService);
    const org = await kit.factory.createOrganisation('ai-admin-inspect');
    await expect(svc.setOrganisationSetting({ userId: admin.ceo.userId, organisationId: admin.orgId, workspaceId: admin.ceo.workspaceId, inspectedBy: randomUUID() }, org.id, true)).rejects.toMatchObject({ status: 403 });
  });

  it('usage metadata: per-organisation counters only (exact column set); no prompt, answer or tool output; no transcript route for administrators', async () => {
    const tenant = await aiOrganisation(kit, 'ai-admin-usage');
    const conversationId = await newConversation(kit, tenant.token);
    const turn = await ask(kit, tenant.token, conversationId, 'What is our fill rate this week?');
    expect(await kit.runner.run(jobFor(tenant.ceo, conversationId, turn.turnId))).toBe('completed');
    const res = await kit.http().get(`/rest/v1/admin/ai/usage?from=${utcDay()}&to=${utcDay()}&limit=200`).set(bearer(admin.token));
    expect(res.status).toBe(200);
    const row = res.body.organisations.find((o: { organisationId: string }) => o.organisationId === tenant.orgId);
    expect(Object.keys(row).sort()).toEqual(USAGE_KEYS);
    expect(row).toMatchObject({ aiEnabled: true, turns: 1 });
    expect(row.inputTokens + row.outputTokens).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toMatch(/fill rate|seats|shift/i);
    // The administrator cannot open the tenant's conversation through the tenant API either (RLS owner predicate).
    expect((await kit.http().get(`/rest/v1/ai/conversations/${conversationId}`).set(bearer(admin.token))).status).toBe(404);
    // Range bound is enforced by the database function (≤ 93 days).
    expect((await kit.http().get(`/rest/v1/admin/ai/usage?from=2026-01-01&to=2026-12-31`).set(bearer(admin.token))).status).toBe(400);
  });
});
