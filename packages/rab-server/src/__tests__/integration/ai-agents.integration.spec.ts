import './helpers/ai-env';
import './helpers/ai-agents-env';

import { createHash, randomUUID } from 'node:crypto';

import { AuthCacheRedisClientProvider } from '../../engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { EnvironmentVariables } from '../../engine/core-modules/environment/environment-variables';
import { PermissionsService } from '../../engine/core-modules/permissions/permissions.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { MemberRolePolicyService } from '../../modules/identity/services/member-role-policy.service';
import { decideAgentRun } from '../../modules/ai/agents/agent-principal.policy';
import { AiAgentPrincipalService } from '../../modules/ai/services/ai-agent-principal.service';
import { AiAgentService } from '../../modules/ai/services/ai-agent.service';
import { AiKit, aiOrganisation, bearer, bootAiKit, manager, setOrgAi } from './helpers/ai-test-kit';
import { TestIdentity } from './helpers/test-identities';

/**
 * AI Phase 6a — agent DEFINITIONS AND STORAGE on the real AppModule, PostgreSQL (crewflow_app, FORCE RLS) and Redis
 * (docs/ai/PHASE6_TWENTY_PLAN.md §3–§4, T6-P4 / T6-R1 / T6-T1 subsets that exist in 6a). EX-3 is NOT approved: nothing
 * runs, no trigger can be enabled. Five layers: AiAgentsSwitchGuard + PermissionGuard(ai.agents.manage) → the services
 * (AiAgentAuthority: Inspect, switches, flag re-read, CEO, org switches; step-up + reason; content rules; limits; audit)
 * → organisation + workspace scoped queries → RLS (organisation + workspace + eligible reader) → CEO writer, `kind =
 * 'custom'`, `updated_by`, column grants, CHECK `ai_agent_trigger_ex3_gate`, the agent-role FKs and the unchanged
 * member-role backstop.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const ORIGIN = 'http://localhost:5173';
const BASE = '/rest/v1/ai/agents';
const sha256 = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');
const sidOf = (token: string): string => (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { sid: string }).sid;
const pgCode = (e: unknown) => (e as { driverError?: { code?: string }; code?: string })?.driverError?.code ?? (e as { code?: string })?.code;

const agentBody = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  label: `Agent ${name}`,
  description: 'Checks the weekend cover.',
  prompt: 'List next weekend’s unfilled shifts and suggest who could cover them.',
  model: { tier: 'fast', modelId: null },
  reason: 'integration test',
  ...extra,
});
const scheduleTrigger = (extra: Record<string, unknown> = {}) => ({ kind: 'schedule', schedule: { every: 'week', at: '09:00', dow: 4 }, reason: 'weekly check', ...extra });
const eventTrigger = (extra: Record<string, unknown> = {}) => ({ kind: 'record_event', eventTypes: ['shift.published', 'shift.created'], reason: 'on shift changes', ...extra });

describeIfDb('AI agents — Phase 6a storage, execution off (integration)', () => {
  jest.setTimeout(600_000);
  let kit: AiKit;
  let tenant: TenantContextService;
  let authRedis: AuthCacheRedisClientProvider;
  let env: EnvironmentService;

  beforeAll(async () => {
    kit = await bootAiKit();
    tenant = kit.moduleRef.get(TenantContextService);
    authRedis = kit.moduleRef.get(AuthCacheRedisClientProvider);
    env = kit.moduleRef.get(EnvironmentService);
  });
  /**
   * Leave no agent rows or agent roles behind in the shared test database: `custom-role-backfill-forced-rls` re-executes the
   * frozen backfill 1786717600000 against the head schema, and that migration (written before agent roles existed) tries
   * to give EVERY workspace custom role object rules — which the M6.2 FK refuses for an agent role. On a real database the
   * backfill runs before M6.2 and never meets an agent role (REQUEST.md, "known limitations").
   */
  const createdOrgs: string[] = [];
  afterAll(async () => {
    if (kit?.owner?.isInitialized && createdOrgs.length > 0) {
      await kit.owner.query(`DELETE FROM core.ai_agent WHERE organisation_id = ANY($1::uuid[])`, [createdOrgs]);
      await kit.owner.query(`DELETE FROM core.role WHERE assignable_to_agents AND organisation_id = ANY($1::uuid[])`, [createdOrgs]);
    }
    await kit?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  const http = () => kit.http();
  const post = (token: string, path: string, body: Record<string, unknown>) => http().post(`${BASE}${path}`).set(bearer(token)).set('Origin', ORIGIN).send(body);
  const patch = (token: string, path: string, body: Record<string, unknown>) => http().patch(`${BASE}${path}`).set(bearer(token)).set('Origin', ORIGIN).send(body);
  const put = (token: string, path: string, body: Record<string, unknown>) => http().put(`${BASE}${path}`).set(bearer(token)).set('Origin', ORIGIN).send(body);
  const del = (token: string, path: string, body: Record<string, unknown>) => http().delete(`${BASE}${path}`).set(bearer(token)).set('Origin', ORIGIN).send(body);
  const get = (token: string, path = '') => http().get(`${BASE}${path}`).set(bearer(token));

  const setOrgAgents = (orgId: string, on: boolean) => kit.owner.query(`UPDATE core.organisation_ai_setting SET agents_enabled = $2 WHERE organisation_id = $1`, [orgId, on]);
  const agentsOrg = async (label: string) => {
    const org = await aiOrganisation(kit, label);
    createdOrgs.push(org.orgId);
    await setOrgAgents(org.orgId, true);
    return org;
  };
  const create = async (token: string, name: string, extra: Record<string, unknown> = {}): Promise<string> => {
    const res = await post(token, '', agentBody(name, extra));
    if (res.status !== 201) throw new Error(`create ${name}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.id as string;
  };
  const addTrigger = async (token: string, agentId: string, body: Record<string, unknown>): Promise<string> => {
    const res = await post(token, `/${agentId}/triggers`, body);
    if (res.status !== 201) throw new Error(`trigger: ${res.status} ${JSON.stringify(res.body)}`);
    return (res.body.triggers as Array<{ id: string }>).at(-1)!.id;
  };
  const agentRows = (orgId: string) =>
    kit.owner.query(`SELECT id, name, label, prompt, kind, deleted_at, role_id, config_version, updated_by FROM core.ai_agent WHERE organisation_id = $1 ORDER BY created_at`, [orgId]);
  const triggerRows = (orgId: string) => kit.owner.query(`SELECT id, kind, enabled, run_as_user_id, schedule, event_types FROM core.ai_agent_trigger WHERE organisation_id = $1 ORDER BY created_at`, [orgId]);
  const asTenant = <T = unknown>(who: Pick<TestIdentity, 'organisationId' | 'workspaceId' | 'userId'>, sql: string, params: unknown[] = []) =>
    tenant.runInTenantContext({ organisationId: who.organisationId, workspaceId: who.workspaceId, userId: who.userId, role: '' }, (m) => m.query(sql, params) as Promise<T>);
  const insertAgentAs = (who: TestIdentity, cols: Record<string, unknown>) => {
    const values = {
      organisation_id: who.organisationId,
      workspace_id: who.workspaceId,
      name: `direct-${randomUUID().slice(0, 8)}`,
      label: 'Direct',
      prompt: 'Direct write.',
      model_tier: 'fast',
      created_by: who.userId,
      updated_by: who.userId,
      ...cols,
    };
    const keys = Object.keys(values);
    return asTenant(who, `INSERT INTO core.ai_agent (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(values));
  };
  const staleToken = async (who: TestIdentity) => {
    const token = await kit.factory.login(who, { applicationTarget: 'manager_web' });
    await authRedis.client.del(`crewflow:test:step-up:${sha256(sidOf(token))}`);
    return token;
  };
  const switchOff = (key: 'AI_AGENTS_ENABLED' | 'AI_ENABLED') => {
    const realGet = env.get.bind(env);
    jest.spyOn(env, 'get').mockImplementation(((k: keyof EnvironmentVariables) => (k === key ? false : realGet(k))) as EnvironmentService['get']);
  };

  // ── Happy path ──────────────────────────────────────────────────────────────────────────────────────────────────────
  it('the CEO creates, reads, edits and soft-deletes an agent and its triggers; triggers are stored switched off', async () => {
    const org = await agentsOrg('ai-agent-ceo');
    expect((await get(org.token)).body).toEqual([]);
    const id = await create(org.token, 'cover-watcher');
    const view = (await get(org.token, `/${id}`)).body;
    expect(view).toMatchObject({
      id,
      kind: 'custom',
      readOnly: false,
      name: 'cover-watcher',
      label: 'Agent cover-watcher',
      model: { tier: 'fast', modelId: null },
      responseFormat: 'text',
      roleId: null,
      isActive: false,
      configVersion: 1,
      triggers: [],
    });

    // Label-only edit keeps config_version; a prompt edit bumps it (server-maintained).
    expect((await patch(org.token, `/${id}`, { label: 'Weekend cover', reason: 'rename' })).body).toMatchObject({ label: 'Weekend cover', configVersion: 1 });
    expect((await patch(org.token, `/${id}`, { prompt: 'Only Saturday shifts.', model: { tier: 'smart', modelId: null }, reason: 'narrow' })).body).toMatchObject({
      prompt: 'Only Saturday shifts.',
      model: { tier: 'smart', modelId: null },
      configVersion: 2,
    });

    const s = await addTrigger(org.token, id, scheduleTrigger());
    const e = await addTrigger(org.token, id, eventTrigger());
    const withTriggers = (await get(org.token, `/${id}`)).body;
    expect(withTriggers.triggers).toEqual([
      { id: s, agentId: id, kind: 'schedule', schedule: { every: 'week', at: '09:00', dow: 4 }, eventTypes: [], enabled: false, runAsUserId: null, pausedReason: null, nextRunAt: null, lastRunAt: null },
      { id: e, agentId: id, kind: 'record_event', schedule: null, eventTypes: ['shift.created', 'shift.published'], enabled: false, runAsUserId: null, pausedReason: null, nextRunAt: null, lastRunAt: null },
    ]);
    expect((await patch(org.token, `/${id}/triggers/${s}`, { schedule: { every: 'day', at: '07:30' }, reason: 'daily' })).body.triggers[0].schedule).toEqual({ every: 'day', at: '07:30' });
    expect((await patch(org.token, `/${id}/triggers/${s}`, { eventTypes: ['shift.created'], reason: 'wrong field' })).status).toBe(400);
    expect((await post(org.token, `/${id}/triggers/${s}/disable`, { reason: 'make sure' })).status).toBe(200);
    expect((await del(org.token, `/${id}/triggers/${e}`, { reason: 'not needed' })).body.triggers.map((t: { id: string }) => t.id)).toEqual([s]);

    expect((await del(org.token, `/${id}`, { reason: 'done' })).body).toEqual({ deleted: true, id });
    expect((await get(org.token)).body).toEqual([]);
    expect((await get(org.token, `/${id}`)).status).toBe(404);
    const [row] = await agentRows(org.orgId);
    expect(row.deleted_at).not.toBeNull();
    expect(await triggerRows(org.orgId)).toEqual([]);
  });

  // ── EX-3: enable is refused at every layer ───────────────────────────────────────────────────────────────────────────
  it('trigger ENABLE is refused: 409 AI_AGENT_EXECUTION_NOT_APPROVED, nothing written; the database refuses it too', async () => {
    const org = await agentsOrg('ai-agent-enable');
    const id = await create(org.token, 'enable-probe');
    const t = await addTrigger(org.token, id, scheduleTrigger());
    const res = await post(org.token, `/${id}/triggers/${t}/enable`, { reason: 'turn it on' });
    expect({ status: res.status, code: res.body.code }).toEqual({ status: 409, code: 'AI_AGENT_EXECUTION_NOT_APPROVED' });
    expect((await post(org.token, `/${id}/triggers/${t}/enable`, {})).status).toBe(400); // still a validated named action
    expect(await triggerRows(org.orgId)).toEqual([expect.objectContaining({ id: t, enabled: false, run_as_user_id: null })]);
    // A foreign or missing trigger is the uniform 404, before the 409.
    expect((await post(org.token, `/${id}/triggers/${randomUUID()}/enable`, { reason: 'probe' })).status).toBe(404);
    // Layer 5: crewflow_app as the CEO — enabling (even as self) or naming a run-as user is refused by policy / grants.
    expect(pgCode(await asTenant(org.ceo, `UPDATE core.ai_agent_trigger SET enabled = true, updated_by = $2 WHERE id = $1`, [t, org.ceo.userId]).catch((e) => e))).toBe('42501');
    expect(pgCode(await asTenant(org.ceo, `UPDATE core.ai_agent_trigger SET run_as_user_id = $2 WHERE id = $1`, [t, org.ceo.userId]).catch((e) => e))).toBe('42501');
    expect(pgCode(await asTenant(org.ceo, `INSERT INTO core.ai_agent_trigger (organisation_id, workspace_id, agent_id, kind, schedule, enabled, created_by, updated_by) VALUES ($1, $2, $3, 'schedule', '{"every":"day","at":"09:00"}', true, $4, $4)`, [org.orgId, org.ceo.workspaceId, id, org.ceo.userId]).catch((e) => e))).toBe('42501');
    // Layer 4: the EX-3 CHECK holds even for the bootstrap superuser.
    expect(pgCode(await kit.owner.query(`UPDATE core.ai_agent_trigger SET enabled = true, run_as_user_id = $2, enabled_at = now() WHERE id = $1`, [t, org.ceo.userId]).catch((e) => e))).toBe('23514');
    expect(pgCode(await kit.owner.query(`UPDATE core.ai_agent_trigger SET next_run_at = now() WHERE id = $1`, [t]).catch((e) => e))).toBe('23514');
    expect(await triggerRows(org.orgId)).toEqual([expect.objectContaining({ id: t, enabled: false, run_as_user_id: null })]);
    const [{ n }] = await kit.owner.query(`SELECT count(*)::int AS n FROM core.worker_due_work WHERE organisation_id = $1`, [org.orgId]);
    expect(n).toBe(0);
  });

  // ── T6-T1 tenancy ────────────────────────────────────────────────────────────────────────────────────────────────────
  it('T6-T1 zero rows with no tenant context; another organisation gets 404 on every route and 0 rows / 42501 below', async () => {
    const a = await agentsOrg('ai-agent-rls-a');
    const b = await agentsOrg('ai-agent-rls-b');
    const id = await create(a.token, 'a-secret');
    const t = await addTrigger(a.token, id, scheduleTrigger());
    expect((await kit.owner.query(`SELECT count(*)::int AS n FROM core.ai_agent WHERE organisation_id = $1`, [a.orgId]))[0].n).toBe(1);
    for (const table of ['ai_agent', 'ai_agent_trigger', 'ai_agent_event']) {
      expect(await kit.runtime.query(`SELECT count(*)::int AS n FROM core.${table}`)).toEqual([{ n: 0 }]);
    }
    for (const res of [
      await get(b.token, `/${id}`),
      await patch(b.token, `/${id}`, { label: 'stolen', reason: 'probe' }),
      await del(b.token, `/${id}`, { reason: 'probe' }),
      await get(b.token, `/${id}/role`),
      await put(b.token, `/${id}/role`, { flags: ['schedule.view'], reason: 'probe' }),
      await post(b.token, `/${id}/triggers`, scheduleTrigger()),
      await patch(b.token, `/${id}/triggers/${t}`, { schedule: { every: 'day', at: '01:00' }, reason: 'probe' }),
      await del(b.token, `/${id}/triggers/${t}`, { reason: 'probe' }),
      await post(b.token, `/${id}/triggers/${t}/enable`, { reason: 'probe' }),
      await post(b.token, `/${id}/triggers/${t}/disable`, { reason: 'probe' }),
    ]) {
      expect(res.status).toBe(404);
    }
    expect((await get(b.token)).body).toEqual([]);
    expect(await asTenant(b.ceo, `SELECT id FROM core.ai_agent WHERE organisation_id = $1`, [a.orgId])).toEqual([]);
    expect(await asTenant(b.ceo, `SELECT id FROM core.ai_agent_trigger WHERE organisation_id = $1`, [a.orgId])).toEqual([]);
    expect(pgCode(await insertAgentAs(b.ceo, { organisation_id: a.orgId }).catch((e) => e))).toBe('42501');
    expect(await asTenant(b.ceo, `UPDATE core.ai_agent SET label = 'x', updated_by = $2 WHERE id = $1 RETURNING id`, [id, b.ceo.userId])).toEqual([[], 0]);
    expect(await asTenant(b.ceo, `DELETE FROM core.ai_agent_trigger WHERE id = $1 RETURNING id`, [t])).toEqual([[], 0]);
    expect(pgCode(await asTenant(a.ceo, `INSERT INTO core.ai_agent_event (organisation_id, workspace_id, trigger_id, event_type, entity_type, entity_id, occurred_at) VALUES ($1, $2, $3, 'shift.created', 'shift', $4, now())`, [a.orgId, a.ceo.workspaceId, t, randomUUID()]).catch((e) => e))).toBe('42501');
    expect((await agentRows(a.orgId))[0]).toMatchObject({ label: 'Agent a-secret', deleted_at: null });
  });

  // ── Non-CEO ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  it('a non-CEO: without the flag 403 on every route; granted the flag 404 (CEO only); direct writes 42501; IM reads, VM / staff read 0 rows', async () => {
    const org = await agentsOrg('ai-agent-nonceo');
    const id = await create(org.token, 'ceo-agent');
    await addTrigger(org.token, id, scheduleTrigger());
    const im = await manager(kit, org.orgId, { initial: true });
    expect((await get(im.token)).status).toBe(403);
    expect((await post(im.token, '', agentBody('im-agent'))).status).toBe(403);
    expect((await patch(im.token, `/${id}`, { label: 'x', reason: 'not mine' })).status).toBe(403);

    const other = await manager(kit, org.orgId);
    await kit.owner.query(
      `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect) SELECT $1, id, $2, 'grant' FROM core.permission WHERE key = 'ai.agents.manage'`,
      [other.id.userId, org.orgId],
    );
    const token = await kit.factory.login(other.id);
    const list = await get(token);
    expect({ status: list.status, code: list.body.code }).toEqual({ status: 404, code: 'AI_NOT_AVAILABLE' });
    expect((await post(token, '', agentBody('granted-non-ceo'))).status).toBe(404);
    expect(pgCode(await insertAgentAs(other.id, {}).catch((e) => e))).toBe('42501');
    expect(pgCode(await insertAgentAs(im.id, { workspace_id: org.ceo.workspaceId }).catch((e) => e))).toBe('42501');

    // RLS readers: the current Initial Manager is AI-eligible but in ANOTHER workspace (0 rows); the CEO reads its own.
    expect(await asTenant(im.id, `SELECT id FROM core.ai_agent`)).toEqual([]);
    const vm = await kit.factory.createVenueManager({ id: org.orgId }, { owner: org.ceo, permissions: 'production' });
    expect(await asTenant(vm, `SELECT id FROM core.ai_agent`)).toEqual([]);
    expect(await asTenant(vm, `SELECT id FROM core.ai_agent_trigger`)).toEqual([]);
    expect(await asTenant(org.ceo, `SELECT name FROM core.ai_agent`)).toEqual([{ name: 'ceo-agent' }]);
    expect((await agentRows(org.orgId)).map((r: { name: string }) => r.name)).toEqual(['ceo-agent']);
  });

  it('Admin Inspect is refused by the service (layer 2) for reads and writes', async () => {
    const org = await agentsOrg('ai-agent-inspect');
    const service = kit.moduleRef.get(AiAgentService);
    const ctx = { organisationId: org.ceo.organisationId, workspaceId: org.ceo.workspaceId, userId: org.ceo.userId, role: '', inspectedBy: randomUUID(), sessionId: randomUUID() };
    await expect(service.list(ctx)).rejects.toMatchObject({ status: 404 });
    await expect(service.create(ctx, agentBody('inspect') as never)).rejects.toMatchObject({ status: 404 });
    expect(await agentRows(org.orgId)).toEqual([]);
  });

  // ── Mass assignment, step-up, reason ─────────────────────────────────────────────────────────────────────────────────
  it('mass assignment (organisationId, workspaceId, runAsUserId, enabled, status, configVersion, kind, isActive, …) ⇒ 400, never applied', async () => {
    const org = await agentsOrg('ai-agent-mass');
    const id = await create(org.token, 'mass-target');
    const t = await addTrigger(org.token, id, scheduleTrigger());
    const forged = [
      { organisationId: randomUUID() },
      { workspaceId: randomUUID() },
      { runAsUserId: org.ceo.userId },
      { enabled: true },
      { status: 'active' },
      { configVersion: 99 },
      { kind: 'standard' },
      { isActive: true },
      { createdBy: randomUUID() },
      { triggers: [] },
    ];
    for (const extra of forged) {
      expect((await post(org.token, '', agentBody('mass-probe', extra))).status).toBe(400);
      expect((await patch(org.token, `/${id}`, { label: 'New', reason: 'mass probe', ...extra })).status).toBe(400);
      expect((await post(org.token, `/${id}/triggers`, scheduleTrigger(extra))).status).toBe(400);
      expect((await patch(org.token, `/${id}/triggers/${t}`, { schedule: { every: 'day', at: '08:00' }, reason: 'mass probe', ...extra })).status).toBe(400);
    }
    expect((await patch(org.token, `/${id}`, { name: 'renamed', reason: 'rename probe' })).status).toBe(400);
    expect((await post(org.token, '', agentBody('nested-probe', { model: { tier: 'fast', modelId: null, providerModelId: 'x' } }))).status).toBe(400);
    expect((await post(org.token, `/${id}/triggers`, scheduleTrigger({ schedule: { every: 'day', at: '09:00', cron: '* * * * *' } }))).status).toBe(400);
    expect((await patch(org.token, `/${id}`, { reason: 'nothing' })).status).toBe(400);
    expect((await agentRows(org.orgId))).toEqual([expect.objectContaining({ name: 'mass-target', label: 'Agent mass-target', kind: 'custom', config_version: 1 })]);
    expect(await triggerRows(org.orgId)).toEqual([expect.objectContaining({ id: t, enabled: false, run_as_user_id: null, schedule: { every: 'week', at: '09:00', dow: 4 } })]);
  });

  it('every write needs this session’s step-up (403 STEP_UP_REQUIRED, nothing written, refusal audited) and a 3..500 reason', async () => {
    const org = await agentsOrg('ai-agent-stepup');
    const id = await create(org.token, 'stepup-target');
    const t = await addTrigger(org.token, id, scheduleTrigger());
    const stale = await staleToken(org.ceo);
    for (const res of [
      await post(stale, '', agentBody('stale-create')),
      await patch(stale, `/${id}`, { label: 'stale', reason: 'stale probe' }),
      await del(stale, `/${id}`, { reason: 'stale probe' }),
      await put(stale, `/${id}/role`, { flags: ['schedule.view'], reason: 'stale probe' }),
      await post(stale, `/${id}/triggers`, scheduleTrigger()),
      await patch(stale, `/${id}/triggers/${t}`, { schedule: { every: 'day', at: '01:00' }, reason: 'stale probe' }),
      await del(stale, `/${id}/triggers/${t}`, { reason: 'stale probe' }),
      await post(stale, `/${id}/triggers/${t}/disable`, { reason: 'stale probe' }),
    ]) {
      expect({ status: res.status, code: res.body.code }).toEqual({ status: 403, code: 'STEP_UP_REQUIRED' });
    }
    // Reads need no step-up; enable is refused 409 without asking for one (nothing can happen).
    expect((await get(stale, `/${id}`)).status).toBe(200);
    expect((await post(stale, `/${id}/triggers/${t}/enable`, { reason: 'stale probe' })).status).toBe(409);
    const [{ n }] = await kit.owner.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE actor_user_id = $1 AND action = 'auth.step_up_failed' AND metadata->>'action' = 'organisation.ai.agent.update'`, [org.ceo.userId]);
    expect(n).toBe(8);
    expect((await agentRows(org.orgId)).map((r: { label: string }) => r.label)).toEqual(['Agent stepup-target']);
    expect((await kit.http().post('/rest/v1/auth/step-up').set(bearer(stale)).set('Origin', ORIGIN).send({ currentPassword: org.ceo.password })).status).toBe(200);
    expect((await patch(stale, `/${id}`, { label: 'After step-up', reason: 'stepped up' })).status).toBe(200);
    for (const reason of [undefined, 'x', 'r'.repeat(501)]) {
      expect((await patch(org.token, `/${id}`, { label: 'No reason', ...(reason === undefined ? {} : { reason }) })).status).toBe(400);
      expect((await del(org.token, `/${id}`, reason === undefined ? {} : { reason })).status).toBe(400);
    }
  });

  // ── Standard / system agents ─────────────────────────────────────────────────────────────────────────────────────────
  it('standard and system agents can be read but never edited or deleted (409 at the API, 0 rows / 42501 below)', async () => {
    const org = await agentsOrg('ai-agent-standard');
    const ids: Record<string, string> = {};
    for (const kind of ['standard', 'system']) {
      const [row] = await kit.owner.query(
        `INSERT INTO core.ai_agent (organisation_id, workspace_id, kind, name, label, prompt, model_tier, created_by, updated_by)
         VALUES ($1, $2, $3, $4, 'Helper', 'Answer questions about Crewflow.', 'fast', $5, $5) RETURNING id`,
        [org.orgId, org.ceo.workspaceId, kind, `${kind}-helper`, org.ceo.userId],
      );
      ids[kind] = row.id;
    }
    const list = (await get(org.token)).body as Array<{ id: string; kind: string; readOnly: boolean }>;
    expect(list.map((a) => [a.kind, a.readOnly]).sort()).toEqual([['standard', true], ['system', true]]);
    for (const id of Object.values(ids)) {
      for (const res of [
        await patch(org.token, `/${id}`, { label: 'Mine now', reason: 'probe' }),
        await del(org.token, `/${id}`, { reason: 'probe' }),
        await post(org.token, `/${id}/triggers`, scheduleTrigger()),
        await put(org.token, `/${id}/role`, { flags: ['schedule.view'], reason: 'probe' }),
      ]) {
        expect({ status: res.status, code: res.body.code }).toEqual({ status: 409, code: 'AI_AGENT_READ_ONLY' });
      }
      expect(await asTenant(org.ceo, `UPDATE core.ai_agent SET label = 'x', updated_by = $2 WHERE id = $1 RETURNING id`, [id, org.ceo.userId])).toEqual([[], 0]);
      expect(await asTenant(org.ceo, `UPDATE core.ai_agent SET deleted_at = now(), updated_by = $2 WHERE id = $1 RETURNING id`, [id, org.ceo.userId])).toEqual([[], 0]);
    }
    expect(pgCode(await insertAgentAs(org.ceo, { kind: 'standard' }).catch((e) => e))).toBe('42501');
    expect(pgCode(await asTenant(org.ceo, `DELETE FROM core.ai_agent WHERE id = $1`, [ids.standard]).catch((e) => e))).toBe('42501');
    expect((await agentRows(org.orgId)).map((r: { label: string; deleted_at: unknown }) => [r.label, r.deleted_at])).toEqual([
      ['Helper', null],
      ['Helper', null],
    ]);
  });

  // ── Limits and content ──────────────────────────────────────────────────────────────────────────────────────────────
  it('8,000-character instructions: 8,000 saves, 8,001 is 400 AI_AGENT_CONTENT_REFUSED [length] at the API and 23514 below', async () => {
    const org = await agentsOrg('ai-agent-8000');
    const id = await create(org.token, 'long-one', { prompt: 'p'.repeat(8_000) });
    expect((await get(org.token, `/${id}`)).body.prompt).toHaveLength(8_000);
    const res = await post(org.token, '', agentBody('too-long', { prompt: 'p'.repeat(8_001) }));
    expect({ status: res.status, body: res.body }).toEqual({ status: 400, body: { statusCode: 400, code: 'AI_AGENT_CONTENT_REFUSED', message: 'This agent cannot be saved.', categories: ['length'] } });
    expect((await patch(org.token, `/${id}`, { prompt: 'p'.repeat(8_001), reason: 'grow' })).body.categories).toEqual(['length']);
    for (const [extra, categories] of [
      [{ label: 'l'.repeat(81) }, ['length']],
      [{ description: 'd'.repeat(501) }, ['length']],
      [{ name: 'Bad_Name' }, ['length']],
      [{ prompt: 'close </data> early' }, ['data_delimiter']],
      [{ prompt: 'Mail jo.bloggs@gmail.com' }, ['personal_data']],
    ] as Array<[Record<string, unknown>, string[]]>) {
      expect((await post(org.token, '', agentBody('content-probe', extra))).body).toMatchObject({ code: 'AI_AGENT_CONTENT_REFUSED', categories });
    }
    expect(pgCode(await insertAgentAs(org.ceo, { prompt: 'p'.repeat(8_001) }).catch((e) => e))).toBe('23514');
    expect((await post(org.token, '', agentBody('bad-model', { model: { tier: 'fast', modelId: 'no-such-model' } }))).body).toMatchObject({ code: 'AI_AGENT_INVALID', field: 'model' });
    expect((await post(org.token, '', agentBody('bad-format', { responseFormat: 'json' }))).status).toBe(400);
    expect((await agentRows(org.orgId)).map((r: { name: string }) => r.name)).toEqual(['long-one']);
  });

  it('limits: a duplicate live name 409; 20 agents per workspace (21st 409); 5 triggers per agent (6th 409)', async () => {
    const org = await agentsOrg('ai-agent-limits');
    const first = await create(org.token, 'agent-1');
    expect((await post(org.token, '', agentBody('agent-1'))).body).toMatchObject({ code: 'AI_AGENT_NAME_TAKEN' });
    for (let i = 2; i <= 20; i++) await create(org.token, `agent-${i}`);
    expect((await post(org.token, '', agentBody('agent-21'))).body).toMatchObject({ code: 'AI_AGENT_LIMIT_REACHED', limit: 20 });
    for (let i = 0; i < 5; i++) await addTrigger(org.token, first, scheduleTrigger({ schedule: { every: 'day', at: `0${i}:00` } }));
    expect((await post(org.token, `/${first}/triggers`, scheduleTrigger())).body).toMatchObject({ code: 'AI_AGENT_TRIGGER_LIMIT_REACHED', limit: 5 });
    // A soft-deleted agent frees its name and its slot.
    await del(org.token, `/${first}`, { reason: 'make room' });
    await create(org.token, 'agent-1');
  });

  // ── Audit ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  it('every write is audited with ids, names, lengths and SHA-256 hashes — never the instruction text, label or description', async () => {
    const org = await agentsOrg('ai-agent-audit');
    const prompt = 'Marker-prompt-41ab: list the gaps.';
    const id = await create(org.token, 'audited', { prompt, label: 'Marker-label-77cd', description: 'Marker-description-55ef' });
    const edited = 'Marker-prompt-edited-99aa: only Saturdays.';
    await patch(org.token, `/${id}`, { prompt: edited, reason: 'edit it' });
    const t = await addTrigger(org.token, id, eventTrigger());
    await patch(org.token, `/${id}/triggers/${t}`, { eventTypes: ['attendance.under_review'], reason: 'retarget' });
    await put(org.token, `/${id}/role`, { flags: ['schedule.view'], reason: 'see shifts' });
    await post(org.token, `/${id}/triggers/${t}/disable`, { reason: 'already off' });
    await del(org.token, `/${id}/triggers/${t}`, { reason: 'drop it' });
    await del(org.token, `/${id}`, { reason: 'remove it' });
    const audit = await kit.owner.query(`SELECT action, actor_user_id, entity_type, entity_id, metadata FROM core.audit_log WHERE organisation_id = $1 AND action LIKE 'ai.agent%' ORDER BY created_at, id`, [org.orgId]);
    expect(audit.map((a: { action: string }) => a.action)).toEqual([
      'ai.agent_created',
      'ai.agent_updated',
      'ai.agent_trigger_created',
      'ai.agent_trigger_updated',
      'ai.agent_role_updated',
      'ai.agent_trigger_deleted',
      'ai.agent_deleted',
    ]);
    for (const a of audit) expect(a).toMatchObject({ actor_user_id: org.ceo.userId, metadata: expect.objectContaining({ agentId: id }) });
    expect(audit[0].metadata).toEqual({
      agentId: id,
      name: 'audited',
      modelTier: 'fast',
      modelId: null,
      roleId: null,
      configVersion: 1,
      labelLength: 'Marker-label-77cd'.length,
      descriptionLength: 'Marker-description-55ef'.length,
      promptLength: prompt.length,
      promptSha256: sha256(prompt),
      reason: 'integration test',
    });
    expect(audit[1].metadata).toMatchObject({ changed: ['prompt'], configVersion: 2, promptSha256: sha256(edited), previousPromptSha256: sha256(prompt), reason: 'edit it' });
    expect(audit[4].metadata).toMatchObject({ flags: ['schedule.view'], previousFlags: [], roleCreated: true });
    expect(audit[6].metadata).toMatchObject({ roleDeleted: true, triggersDeleted: 0, promptSha256: sha256(edited) });
    const all = JSON.stringify(audit);
    for (const marker of ['Marker-prompt-41ab', 'Marker-prompt-edited-99aa', 'Marker-label-77cd', 'Marker-description-55ef', 'list the gaps', 'only Saturdays']) expect(all).not.toContain(marker);
  });

  // ── Switches ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  it('off switches ⇒ the uniform 404 for everyone: AI_AGENTS_ENABLED, AI_ENABLED, the organisation agents switch, the organisation AI switch', async () => {
    const org = await agentsOrg('ai-agent-switches');
    const id = await create(org.token, 'switch-target');
    const plain = await manager(kit, org.orgId);
    switchOff('AI_AGENTS_ENABLED');
    for (const res of [await get(org.token), await get(org.token, `/${id}`), await post(org.token, '', agentBody('off-create')), await get(plain.token)]) {
      expect({ status: res.status, code: res.body.code }).toEqual({ status: 404, code: 'AI_NOT_AVAILABLE' });
    }
    jest.restoreAllMocks();
    switchOff('AI_ENABLED');
    expect((await get(org.token)).status).toBe(404);
    jest.restoreAllMocks();
    await setOrgAgents(org.orgId, false);
    expect((await get(org.token)).status).toBe(404);
    expect((await patch(org.token, `/${id}`, { label: 'x', reason: 'org off' })).status).toBe(404);
    await setOrgAgents(org.orgId, true);
    await setOrgAi(kit, org.orgId, false);
    expect((await get(org.token)).status).toBe(404);
    await setOrgAi(kit, org.orgId, true);
    expect((await get(org.token)).status).toBe(200);
    expect((await agentRows(org.orgId)).map((r: { name: string }) => r.name)).toEqual(['switch-target']);
  });

  // ── Agent roles (M6.2, B10) ──────────────────────────────────────────────────────────────────────────────────────────
  it('agent role: flags limited to the 6a set, no escalation, a dedicated agent-only role; no human can hold it; the backstop is unchanged', async () => {
    const org = await agentsOrg('ai-agent-role');
    const id = await create(org.token, 'role-agent');
    const empty = (await get(org.token, `/${id}/role`)).body;
    expect(empty.roleId).toBeNull();
    expect(empty.flags.map((f: { flag: string; held: boolean }) => [f.flag, f.held])).toEqual([
      ['schedule.view', false],
      ['venue.view', false],
      ['staff.view', false],
      ['attendance.view', false],
      ['payroll.view', false],
      ['schedule.create', false],
      ['staff.edit', false],
    ]);
    expect([...empty.grantable].sort()).toEqual(['schedule.view', 'staff.view', 'venue.view']);

    const ceoFlagsBefore = await kit.owner.query(`SELECT DISTINCT p.key FROM core.user_role ur JOIN core.role_permission rp ON rp.role_id = ur.role_id JOIN core.permission p ON p.id = rp.permission_id WHERE ur.user_id = $1 ORDER BY 1`, [org.ceo.userId]);
    const set = await put(org.token, `/${id}/role`, { flags: ['schedule.view', 'venue.view'], reason: 'see shifts and venues' });
    expect(set.status).toBe(200);
    const roleId = set.body.roleId as string;
    expect(set.body.flags.filter((f: { held: boolean }) => f.held).map((f: { flag: string }) => f.flag)).toEqual(['schedule.view', 'venue.view']);
    const [role] = await kit.owner.query(`SELECT key, is_system, workspace_id, assignable_to_members, can_read_all_objects, assignable_to_agents FROM core.role WHERE id = $1`, [roleId]);
    expect(role).toMatchObject({ is_system: false, workspace_id: org.ceo.workspaceId, assignable_to_members: false, can_read_all_objects: false, assignable_to_agents: true });
    expect(role.key).toMatch(/^custom_agent_[0-9a-f]{12}$/);
    expect((await get(org.token, `/${id}`)).body.roleId).toBe(roleId);

    // B10: anything beyond the three member view flags is refused (API 400, and the unchanged backstop below).
    expect((await put(org.token, `/${id}/role`, { flags: ['payroll.view'], reason: 'payroll' })).body).toMatchObject({ code: 'AI_AGENT_ROLE_FLAG_NOT_ALLOWED', flags: ['payroll.view'] });
    expect((await put(org.token, `/${id}/role`, { flags: ['attendance.view', 'schedule.view'], reason: 'attendance' })).body).toMatchObject({ code: 'AI_AGENT_ROLE_FLAG_NOT_ALLOWED', flags: ['attendance.view'] });
    expect((await put(org.token, `/${id}/role`, { flags: ['role.manage'], reason: 'escalate' })).status).toBe(400);
    expect((await put(org.token, `/${id}/role`, { flags: ['ai.agents.manage'], reason: 'escalate' })).status).toBe(400);
    const addFlag = (who: TestIdentity, rid: string, key: string) =>
      asTenant(who, `INSERT INTO core.role_permission (organisation_id, role_id, permission_id) SELECT $1, $2, id FROM core.permission WHERE key = $3`, [who.organisationId, rid, key]);
    for (const key of ['attendance.view', 'payroll.view', 'schedule.create', 'ai.agents.manage']) expect(pgCode(await addFlag(org.ceo, roleId, key).catch((e) => e))).toBe('23514');
    const [{ md5 }] = await kit.owner.query(`SELECT md5(replace(p.prosrc, E'\\r', '')) AS md5 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'core' AND p.proname = 'enforce_member_role_permission_allowlist'`);
    expect(md5).toBe('096abf0edec03fb2f7d15a87de6614e4');

    // No escalation: the CEO without staff.view cannot give it to the agent.
    await kit.owner.query(`INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect) SELECT $1, id, $2, 'revoke' FROM core.permission WHERE key = 'staff.view'`, [org.ceo.userId, org.orgId]);
    expect((await put(org.token, `/${id}/role`, { flags: ['staff.view'], reason: 'escalate' })).body).toMatchObject({ code: 'ROLE_ESCALATION' });
    expect((await get(org.token, `/${id}/role`)).body.grantable.sort()).toEqual(['schedule.view', 'venue.view']);

    // No human can ever hold an agent role, and an agent role never gets object / field rules — even as the superuser.
    expect(pgCode(await kit.owner.query(`INSERT INTO core.user_role (user_id, role_id, organisation_id) VALUES ($1, $2, $3)`, [org.ceo.userId, roleId, org.orgId]).catch((e) => e))).toBe('23503');
    expect(pgCode(await asTenant(org.ceo, `INSERT INTO core.user_role (user_id, role_id, organisation_id) VALUES ($1, $2, $3)`, [org.ceo.userId, roleId, org.orgId]).catch((e) => e))).toBe('23503');
    expect(
      pgCode(await kit.owner.query(`INSERT INTO core.role_object_permission (role_id, workspace_id, organisation_id, object_key, can_read) VALUES ($1, $2, $3, 'staff', true)`, [roleId, org.ceo.workspaceId, org.orgId]).catch((e) => e)),
    ).toBe('23503');
    expect(
      pgCode(await kit.owner.query(`INSERT INTO core.role_field_permission (role_id, workspace_id, organisation_id, object_key, field_key, can_read) VALUES ($1, $2, $3, 'staff', 'phone', true)`, [roleId, org.ceo.workspaceId, org.orgId]).catch((e) => e)),
    ).toBe('23503');
    // The kind never flips; the shape CHECK refuses an agent role that is also a member / system / read-all role.
    expect(pgCode(await kit.owner.query(`UPDATE core.role SET assignable_to_agents = false WHERE id = $1`, [roleId]).catch((e) => e))).toBe('23514');
    expect(pgCode(await kit.owner.query(`UPDATE core.role SET assignable_to_members = true WHERE id = $1`, [roleId]).catch((e) => e))).toBe('23514');
    expect(pgCode(await kit.owner.query(`UPDATE core.role SET can_read_all_objects = true WHERE id = $1`, [roleId]).catch((e) => e))).toBe('23514');
    // The member-role editor and the invitation flow never touch it.
    const roleDef = { name: 'Hijack', description: null, icon: null, assignableToMembers: true, readAllObjects: false, objects: [] };
    const editorPut = await kit.http().put(`/rest/v1/roles/${roleId}`).set(bearer(org.token)).set('Origin', ORIGIN).send(roleDef);
    expect({ status: editorPut.status, code: editorPut.body.code }).toEqual({ status: 409, code: 'AGENT_ROLE_MANAGED_IN_AI_SETTINGS' });
    const editorDel = await kit.http().delete(`/rest/v1/roles/${roleId}`).set(bearer(org.token)).set('Origin', ORIGIN);
    expect({ status: editorDel.status, code: editorDel.body.code }).toEqual({ status: 409, code: 'AGENT_ROLE_MANAGED_IN_AI_SETTINGS' });
    const policy = kit.moduleRef.get(MemberRolePolicyService);
    const ctx = { organisationId: org.ceo.organisationId, workspaceId: org.ceo.workspaceId, userId: org.ceo.userId, role: '' };
    await expect(tenant.runInTenantContext(ctx, (m) => policy.loadAssignableTx(m, ctx, roleId))).rejects.toMatchObject({ status: 404 });
    expect((await tenant.runInTenantContext(ctx, (m) => policy.listAssignableTx(m, ctx))).map((r) => r.id)).not.toContain(roleId);

    // No human role gained anything: the CEO's role flags are unchanged and the agent role has no holder.
    expect(await kit.owner.query(`SELECT DISTINCT p.key FROM core.user_role ur JOIN core.role_permission rp ON rp.role_id = ur.role_id JOIN core.permission p ON p.id = rp.permission_id WHERE ur.user_id = $1 ORDER BY 1`, [org.ceo.userId])).toEqual(ceoFlagsBefore);
    expect((await kit.owner.query(`SELECT count(*)::int AS n FROM core.user_role WHERE role_id = $1`, [roleId]))[0].n).toBe(0);
    // A member role still cannot get attendance.view (backstop unchanged for humans too).
    const [memberRole] = await kit.owner.query(
      `INSERT INTO core.role (organisation_id, workspace_id, key, name, is_system, assignable_to_members) VALUES ($1, $2, $3, 'Member probe', false, true) RETURNING id`,
      [org.orgId, org.ceo.workspaceId, `custom_probe_${randomUUID().slice(0, 8)}`],
    );
    expect(pgCode(await addFlag(org.ceo, memberRole.id, 'attendance.view').catch((e) => e))).toBe('23514');
    // A member role can never be attached to an agent (composite FK + service 400).
    expect((await patch(org.token, `/${id}`, { roleId: memberRole.id, reason: 'member role' })).body).toMatchObject({ code: 'AI_AGENT_INVALID', field: 'roleId' });
    expect(pgCode(await asTenant(org.ceo, `UPDATE core.ai_agent SET role_id = $2, updated_by = $3 WHERE id = $1`, [id, memberRole.id, org.ceo.userId]).catch((e) => e))).toBe('23503');
    const permissions = kit.moduleRef.get(PermissionsService);
    expect(await tenant.runInTenantContext(ctx, (m) => permissions.userHasPermissionTx(m, ctx, 'attendance.view'))).toBe(true);
  });

  // ── The principal (post-gate code; never a run path in 6a) ───────────────────────────────────────────────────────────
  it('T6-P3 the principal refuses on the gate; its facts query runs as the run-as user under RLS (no system context)', async () => {
    const org = await agentsOrg('ai-agent-principal');
    const id = await create(org.token, 'principal-agent');
    await put(org.token, `/${id}/role`, { flags: ['schedule.view'], reason: 'see shifts' });
    const principal = kit.moduleRef.get(AiAgentPrincipalService);
    const job = { v: 2 as const, kind: 'agent-run' as const, organisationId: org.orgId, workspaceId: org.ceo.workspaceId!, userId: org.ceo.userId, conversationId: randomUUID(), turnId: randomUUID(), agentId: id, triggerId: null };
    await expect(principal.rebuildForAgentRun(job)).resolves.toEqual({ refused: true, reason: 'execution_not_approved' });
    const loadFacts = (principal as unknown as { loadFacts: (...a: unknown[]) => Promise<{ facts: Parameters<typeof decideAgentRun>[0] }> }).loadFacts.bind(principal);
    const { facts } = await loadFacts(org.orgId, org.ceo.workspaceId, org.ceo.userId, id, null);
    expect(facts).toMatchObject({
      switches: { aiEnabled: true, agentsEnabled: true, orgAiEnabled: true, orgAgentsEnabled: true },
      organisation: { suspended: false, maintenance: false },
      user: { status: 'active', mustResetPassword: false },
      membershipActive: true,
      eligible: true,
      holdsAiUse: true,
      holdsAgentsManage: true,
      agent: { live: true, configVersion: 2, roleFlags: ['schedule.view'] },
      trigger: null,
    });
    const decision = decideAgentRun(facts, new Date());
    expect(decision.ok && [...decision.effectivePermissions]).toEqual(['schedule.view']);
    // Another organisation's user sees nothing of this agent through the same query (RLS as the run-as user).
    const other = await agentsOrg('ai-agent-principal-b');
    expect((await loadFacts(org.orgId, org.ceo.workspaceId, other.ceo.userId, id, null)).facts).toMatchObject({ eligible: false, agent: null, membershipActive: false });
  });
});
