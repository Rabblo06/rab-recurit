import './helpers/ai-env';

import { randomUUID } from 'node:crypto';

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
    expect(res.body).toMatchObject({ platformEnabled: true, provider: 'mock', model: 'crewflow-mock-1', modelAllowlisted: true, credentialsConfigured: false, telemetry: 'disabled', retention: { days: 90, mode: 'off' } });
    expect(res.body.tools.map((t: { name: string }) => t.name).sort()).toEqual(['compare_payroll_runs', 'get_attendance_summary', 'get_fill_rate', 'get_offer_status', 'list_unfilled_shifts']);
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
