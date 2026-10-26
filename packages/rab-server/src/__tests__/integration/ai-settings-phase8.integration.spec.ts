import './helpers/ai-env';

import { createHash, randomUUID } from 'node:crypto';

import { AI_BUILTIN_SKILL_NAMES, AI_PROMPT_SECTION_SEPARATOR, AI_WRITE_TOOL_NAMES, AiToolCatalogueEntryView } from '@rab/shared';
import { tool } from 'ai';
import { z } from 'zod';

import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { ModelGatewayService } from '../../modules/ai/gateway/model-gateway.service';
import { buildSystemPrompt } from '../../modules/ai/prompt/system-prompt';
import { skillCatalogueLines } from '../../modules/ai/skills/skill-catalogue';
import { AiConfigService } from '../../modules/ai/services/ai-config.service';
import { AiSkillService } from '../../modules/ai/services/ai-skill.service';
import { AiPromptPreviewService } from '../../modules/ai/services/ai-prompt-preview.service';
import { AI_SETTINGS_FEATURES, AiSettingsOverviewService } from '../../modules/ai/services/ai-settings-overview.service';
import { localToday } from '../../modules/ai/services/ai-turn-runner.service';
import { AiToolRegistry } from '../../modules/ai/tools/ai-tool-registry.service';
import { AiKit, aiOrganisation, ask, bearer, bootAiKit, jobFor, manager, newConversation, setOrgAi } from './helpers/ai-test-kit';

/**
 * T8-P1 / T8-P2 / T8-P3 (docs/ai/PHASE8_TWENTY_PLAN.md §5, brief 8a): the three Phase 8 Settings → AI read endpoints on
 * the real AppModule, PostgreSQL (crewflow_app, FORCE RLS) and Redis, with the deterministic test model only.
 *   GET /rest/v1/ai/settings                 feature flags + limits
 *   GET /rest/v1/ai/settings/tools           registry catalogue + permission labels + the caller's `held`
 *   GET /rest/v1/ai/settings/prompt-preview  the fixed prompt prefix for this caller (audited, secret-scanned)
 * Five layers: PermissionGuard(ai.settings) → service (flag re-read, Inspect refused, CEO, both switches) → org-bound
 * query → RLS. Abuse cases: no flag = 403; a non-CEO granted the flag = the uniform 404; AI off = 404; Inspect = 404.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const CANARY = 'sk-ant-p8canary-'.padEnd(48, 'Q');
const ROUTES = ['/rest/v1/ai/settings', '/rest/v1/ai/settings/tools', '/rest/v1/ai/settings/prompt-preview'];
// p3 merge: CD-9 `parameters` joins the entry (the registry catalogue carries them).
/** 4w: the skill catalogue lines the runner and the preview read for this signed-in user (built-ins are active by default). */
async function skillLinesFor(kit: AiKit, who: { organisationId: string; workspaceId: string | null; userId: string }, token: string) {
  const sid = (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { sid: string }).sid;
  return kit.moduleRef.get(AiSkillService).catalogueFor({ organisationId: who.organisationId, workspaceId: who.workspaceId!, userId: who.userId, sessionId: sid } as never);
}

const ENTRY_KEYS = ['held', 'kind', 'label', 'maxBytes', 'maxRows', 'name', 'parameters', 'permission', 'permissionLabel', 'requiresApproval', 'summary'];

describeIfDb('Settings → AI Phase 8 read endpoints (integration)', () => {
  jest.setTimeout(240_000);
  let kit: AiKit;

  beforeAll(async () => {
    kit = await bootAiKit();
  });
  afterAll(async () => {
    await kit?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  const get = (path: string, token: string) => kit.http().get(path).set(bearer(token));
  const previews = (orgId: string) =>
    kit.owner.query<Array<{ actor_user_id: string; metadata: Record<string, unknown> }>>(`SELECT actor_user_id, metadata FROM core.audit_log WHERE organisation_id = $1 AND action = 'ai.prompt_previewed' ORDER BY created_at`, [orgId]);

  // ── T8-P3 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  it('T8-P3: GET /ai/settings returns exactly what this server serves; agentExecution is always false', async () => {
    const org = await aiOrganisation(kit, 'p8-features');
    const res = await get('/rest/v1/ai/settings', org.token);
    expect(res.status).toBe(200);
    expect(res.body.features).toEqual({ skills: true, tools: true, usage: true, promptPreview: true, approvals: false, agents: false, agentExecution: false, assistant: true, instructions: true, levels: true, capabilities: true });
    expect(res.body.features).toEqual(AI_SETTINGS_FEATURES);
    const cfg = kit.moduleRef.get(AiConfigService);
    expect(res.body.limits).toEqual({
      maxInputChars: cfg.maxInputChars,
      userRatePerMinute: cfg.userRatePerMinute,
      // 7b: the owner's limits are enforced and served (no placeholder 0s).
      orgRatePerMinute: cfg.orgRatePerMinute,
      userTurnsPerDay: cfg.userTurnsPerDay,
      orgDailyTokenBudget: cfg.orgDailyTokenBudget,
      orgDailyCostCeilingMicros: cfg.dailyBudgetUsdMicros,
      userDailyCostCeilingMicros: cfg.userDailyBudgetUsdMicros,
    });
    expect(Object.keys(res.body).sort()).toEqual(['counts', 'features', 'limits']);
    // p4 merge: built-in skills are active until switched off (P4-D2), so a fresh organisation counts all six.
    expect(res.body.counts).toEqual({ myConversations: 0, orgQuestionsThisMonth: 0, activeSkills: AI_BUILTIN_SKILL_NAMES.length, tools: kit.moduleRef.get(AiToolRegistry).catalogue().length });
  });

  it('CD-10: counts are the caller’s OWN conversations (another user’s are never counted) and the org’s turns this month — counts only', async () => {
    const org = await aiOrganisation(kit, 'p8-counts');
    const im = await manager(kit, org.orgId, { initial: true });
    await newConversation(kit, im.token);
    await newConversation(kit, im.token);
    await newConversation(kit, org.token);
    const today = new Date().toISOString().slice(0, 10);
    // Per-model rows (AiDevRealProvider1786720230000): two models today sum to the organisation's 7 questions.
    await kit.owner.query(`INSERT INTO core.ai_usage_daily (organisation_id, usage_date, model, turns) VALUES ($1, $2::date, 'crewflow-mock-1', 5), ($1, $2::date, 'crewflow-mock-smart-1', 2)`, [org.orgId, today]);
    const res = await get('/rest/v1/ai/settings', org.token);
    expect(res.body.counts).toMatchObject({ myConversations: 1, orgQuestionsThisMonth: 7 });
    const other = await aiOrganisation(kit, 'p8-counts-other');
    expect((await get('/rest/v1/ai/settings', other.token)).body.counts).toMatchObject({ myConversations: 0, orgQuestionsThisMonth: 0 });
  });

  // ── access: layers 1 and 2 ─────────────────────────────────────────────────────────────────────────────────────────
  it('without ai.settings (the Initial Manager, who may USE AI) ⇒ 403 on all three routes; nothing audited', async () => {
    const org = await aiOrganisation(kit, 'p8-noflag');
    const im = await manager(kit, org.orgId, { initial: true });
    expect((await get('/rest/v1/ai/availability', im.token)).body).toMatchObject({ available: true });
    for (const path of ROUTES) expect({ path, status: (await get(path, im.token)).status }).toEqual({ path, status: 403 });
    expect(await previews(org.orgId)).toEqual([]);
  });

  it('a NON-CEO granted ai.settings gets the uniform 404 from the service (layer 2), on all three routes', async () => {
    const org = await aiOrganisation(kit, 'p8-custom');
    const other = await manager(kit, org.orgId);
    await kit.owner.query(
      `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect) SELECT $1, id, $2, 'grant' FROM core.permission WHERE key = 'ai.settings'`,
      [other.id.userId, org.orgId],
    );
    const token = await kit.factory.login(other.id);
    for (const path of ROUTES) {
      const res = await get(path, token);
      expect({ path, status: res.status, code: res.body?.code }).toEqual({ path, status: 404, code: 'AI_NOT_AVAILABLE' });
    }
    expect(await previews(org.orgId)).toEqual([]);
  });

  it("the organisation's AI switched OFF ⇒ 404 for the CEO on all three routes", async () => {
    const org = await aiOrganisation(kit, 'p8-off');
    await setOrgAi(kit, org.orgId, false);
    for (const path of ROUTES) expect({ path, status: (await get(path, org.token)).status }).toEqual({ path, status: 404 });
  });

  it('Admin Inspect is refused by the services themselves (jobs and other services never pass the guard)', async () => {
    const org = await aiOrganisation(kit, 'p8-inspect');
    const ctx: AuthContext = { organisationId: org.ceo.organisationId, workspaceId: org.ceo.workspaceId, userId: org.ceo.userId, role: '', inspectedBy: randomUUID(), sessionId: randomUUID() };
    const overview = kit.moduleRef.get(AiSettingsOverviewService);
    await expect(overview.overview(ctx)).rejects.toMatchObject({ status: 404 });
    await expect(overview.tools(ctx)).rejects.toMatchObject({ status: 404 });
    await expect(kit.moduleRef.get(AiPromptPreviewService).preview(ctx)).rejects.toMatchObject({ status: 404 });
    expect(await previews(org.orgId)).toEqual([]);
  });

  // ── T8-P2 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  it('T8-P2: the tools endpoint IS registry.catalogue() (+ label, the offered description, permission label, held) and nothing more', async () => {
    const org = await aiOrganisation(kit, 'p8-tools');
    const res = await get('/rest/v1/ai/settings/tools', org.token);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['tools']);
    const tools = res.body.tools as AiToolCatalogueEntryView[];
    const registry = kit.moduleRef.get(AiToolRegistry);
    const catalogue = registry.catalogue();
    expect(tools.map(({ name, kind, permission, maxRows, maxBytes, parameters }) => ({ name, kind, permission, maxRows, maxBytes, parameters }))).toEqual(
      catalogue.map(({ name, kind, permission, maxRows, maxBytes, parameters }) => ({ name, kind, permission, maxRows, maxBytes, parameters })),
    );
    const labels = Object.fromEntries((await kit.owner.query<Array<{ key: string; description: string }>>(`SELECT key, description FROM core.permission`)).map((r) => [r.key, r.description]));
    for (const t of tools) {
      expect(Object.keys(t).sort()).toEqual(ENTRY_KEYS);
      expect(t).toMatchObject({ held: true, requiresApproval: false, permissionLabel: labels[t.permission!] ?? null });
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.summary.length).toBeGreaterThan(0);
    }
    // No schema internals leave: no zod/JSON-schema keys anywhere in the body.
    expect(JSON.stringify(res.body)).not.toMatch(/"(input|inputSchema|outputKeys|properties|jsonSchema|run)"/);
  });

  it('T8-P2: `held` is resolved from PostgreSQL for THIS caller — a revoked payroll.view shows held:false (and the tool leaves the prompt)', async () => {
    const org = await aiOrganisation(kit, 'p8-held');
    await kit.owner.query(
      `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect) SELECT $1, id, $2, 'revoke' FROM core.permission WHERE key = 'payroll.view'`,
      [org.ceo.userId, org.orgId],
    );
    const token = await kit.factory.login(org.ceo);
    const tools = (await get('/rest/v1/ai/settings/tools', token)).body.tools as AiToolCatalogueEntryView[];
    const payroll = tools.filter((t) => t.permission === 'payroll.view');
    expect(payroll.length).toBeGreaterThan(0);
    for (const t of payroll) expect(t.held).toBe(false);
    for (const t of tools.filter((x) => x.permission !== 'payroll.view')) expect(t.held).toBe(true);
    const preview = (await get('/rest/v1/ai/settings/prompt-preview', token)).body as { toolCatalogue: Array<{ name: string }> };
    // 3w: the prompt's catalogue is exactly the HELD read tools (name-sorted); the model is offered only the meta tools.
    expect(preview.toolCatalogue.map((t) => t.name)).toEqual(tools.filter((t) => t.held && t.kind === 'read').map((t) => t.name).sort());
  });

  // ── T8-P1 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  it('T8-P1: the preview is the fixed prefix only — no other user’s conversation, no record text, no address; audited (metadata only)', async () => {
    const org = await aiOrganisation(kit, 'p8-preview');
    const im = await manager(kit, org.orgId, { initial: true });
    const convMarker = `P8-CONV-MARKER-${randomUUID()}`;
    const noteMarker = `P8-NOTE-MARKER-${randomUUID()}`;
    // A second user's conversation with a unique marker…
    const imConv = await newConversation(kit, im.token);
    expect((await ask(kit, im.token, imConv, `Which shifts are unfilled? ${convMarker}`)).status).toBe(202);
    // …and a shift note with a unique marker.
    const ws = org.ceo.workspaceId!;
    const [venue] = await kit.owner.query(`INSERT INTO core.venue (organisation_id, name, created_by, workspace_id) VALUES ($1, 'Pier Hall', $2, $3) RETURNING id`, [org.orgId, org.ceo.userId, ws]);
    const [role] = await kit.owner.query(`INSERT INTO core.job_role (organisation_id, name, default_rate_pence, created_by, workspace_id) VALUES ($1, 'Bar staff', 1200, $2, $3) RETURNING id`, [org.orgId, org.ceo.userId, ws]);
    const start = Date.now() + 48 * 3_600_000;
    await kit.owner.query(
      `INSERT INTO core.shift (organisation_id, venue_id, job_role_id, starts_at, ends_at, break_minutes, required_count, pay_rate_pence, status, created_by, workspace_id, notes)
       VALUES ($1, $2, $3, $4, $5, 30, 2, 1200, 'open', $6, $7, $8)`,
      [org.orgId, venue.id, role.id, new Date(start), new Date(start + 8 * 3_600_000), org.ceo.userId, ws, noteMarker],
    );

    const res = await get('/rest/v1/ai/settings/prompt-preview', org.token);
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(convMarker);
    expect(body).not.toContain(noteMarker);
    expect(body).not.toContain('Pier Hall');
    expect(body).not.toMatch(/@example\.test/i);
    expect(body).not.toContain(org.ceo.userId);
    expect(Object.keys(res.body).sort()).toEqual(['generatedAt', 'modelId', 'promptCache', 'promptVersion', 'sdkTools', 'sections', 'skillCatalogue', 'systemPrompt', 'tier', 'tokenEstimate', 'toolCatalogue', 'totalTokenEstimate']);
    // CD-5: the sections join byte-equal to the prompt, in order, and none carries a user name.
    expect((res.body.sections as Array<{ text: string }>).map((s) => s.text).join(AI_PROMPT_SECTION_SEPARATOR)).toBe(res.body.systemPrompt);
    // 3w: the permitted read tools are a prompt section (the catalogue) between the format and the context.
    expect((res.body.sections as Array<{ key: string }>).map((s) => s.key)).toEqual(['rules', 'format', 'skills', 'tools', 'context']);
    const [{ timezone }] = await kit.owner.query(`SELECT timezone FROM core.organisation WHERE id = $1`, [org.orgId]);
    // A CEO holds every tool flag the registry knows.
    const registry = kit.moduleRef.get(AiToolRegistry);
    const catalogue = registry.catalogueFor(new Set(registry.catalogue().flatMap((t) => (t.permission ? [t.permission] : []))));
    const skills = await skillLinesFor(kit, org.ceo, org.token);
    expect(res.body).toMatchObject({ tier: 'fast', skillCatalogue: skillCatalogueLines(skills), promptCache: 'none', systemPrompt: buildSystemPrompt(localToday(timezone || 'Europe/London'), { tools: catalogue, skills }) });
    expect(res.body.tokenEstimate.estimate).toBeGreaterThan(0);
    expect(res.body.tokenEstimate.upperBound).toBeGreaterThanOrEqual(res.body.tokenEstimate.estimate);
    // 3w: the SDK tools are the fixed meta tools; the catalogue is the CEO's permitted read tools.
    expect((res.body.sdkTools as Array<{ name: string }>).map((t) => t.name)).toEqual(['ask_question', 'execute_tool', 'learn_tools', 'load_skills', 'propose_action', 'request_form', 'update_plan']);
    expect((res.body.toolCatalogue as Array<{ name: string }>).map((t) => t.name)).toEqual(catalogue.map((l) => l.name));

    const audit = await previews(org.orgId);
    expect(audit).toEqual([{ actor_user_id: org.ceo.userId, metadata: { promptVersion: res.body.promptVersion, tools: res.body.toolCatalogue.length, tokenEstimate: res.body.tokenEstimate.estimate } }]);
  });

  it('T8-P1: byte-equal to what the gateway receives for the same actor (system prompt and the offered tool names)', async () => {
    const org = await aiOrganisation(kit, 'p8-equal');
    const preview = (await get('/rest/v1/ai/settings/prompt-preview', org.token)).body as { systemPrompt: string; sdkTools: Array<{ name: string }> };
    const gateway = kit.moduleRef.get(ModelGatewayService);
    const seen: Array<{ system: string; tools: Array<[string, string]> }> = [];
    const original = gateway.stream.bind(gateway);
    jest.spyOn(gateway, 'stream').mockImplementation((input) => {
      seen.push({ system: input.system, tools: Object.entries(input.tools).map(([n, t]) => [n, String((t as { description?: string }).description)]) });
      return original(input);
    });
    const conv = await newConversation(kit, org.token);
    const turn = await ask(kit, org.token, conv, 'What is our fill rate this week?');
    expect(turn.status).toBe(202);
    await kit.runner.run(jobFor(org.ceo, conv, turn.turnId));
    expect(seen).toHaveLength(1);
    expect(Buffer.from(seen[0]!.system, 'utf8').equals(Buffer.from(preview.systemPrompt, 'utf8'))).toBe(true);
    // 3w: the gateway is offered exactly the preview's SDK tools, with the registry's fixed descriptions.
    // 5b: a CEO holds every write flag, so propose_action is offered (narrowed to all three write tools).
    const sdk = kit.moduleRef.get(AiToolRegistry).sdkToolDefinitions([...AI_WRITE_TOOL_NAMES]);
    expect(seen[0]!.tools).toEqual(preview.sdkTools.map((t) => [t.name, String((sdk[t.name] as { description?: string }).description)]));
  });

  it('CD-4: the workspace instructions are in the preview exactly as the runner sends them — this organisation’s only', async () => {
    const org = await aiOrganisation(kit, 'p8-instr');
    const other = await aiOrganisation(kit, 'p8-instr-other');
    const text = `Always answer in British English. P8-INSTR-${randomUUID()}`;
    await kit.owner.query(
      `INSERT INTO core.organisation_ai_instruction (organisation_id, content, content_sha256, updated_by, reason) VALUES ($1, $2, $3, $4, 'p8 test')`,
      [org.orgId, text, createHash('sha256').update(text, 'utf8').digest('hex'), org.ceo.userId],
    );
    const preview = (await get('/rest/v1/ai/settings/prompt-preview', org.token)).body as { systemPrompt: string; sections: Array<{ key: string; text: string }> };
    expect(preview.systemPrompt).toContain(text);
    expect(preview.sections.map((sct) => sct.key)).toEqual(['rules', 'format', 'instructions', 'skills', 'tools', 'context']);
    expect(preview.sections.map((sct) => sct.text).join(AI_PROMPT_SECTION_SEPARATOR)).toBe(preview.systemPrompt);
    // Another organisation's preview never carries it (organisation-bound query + RLS).
    expect(JSON.stringify((await get('/rest/v1/ai/settings/prompt-preview', other.token)).body)).not.toContain('P8-INSTR-');
    // The audit row is metadata only: never the instruction text.
    expect(JSON.stringify(await previews(org.orgId))).not.toContain('P8-INSTR-');

    // Byte-equal to the gateway's system prompt for a real turn of the same actor.
    const gateway = kit.moduleRef.get(ModelGatewayService);
    const seen: string[] = [];
    const original = gateway.stream.bind(gateway);
    jest.spyOn(gateway, 'stream').mockImplementation((input) => {
      seen.push(input.system);
      return original(input);
    });
    const conv = await newConversation(kit, org.token);
    const turn = await ask(kit, org.token, conv, 'What is our fill rate this week?');
    await kit.runner.run(jobFor(org.ceo, conv, turn.turnId));
    expect(seen).toHaveLength(1);
    expect(Buffer.from(seen[0]!, 'utf8').equals(Buffer.from(preview.systemPrompt, 'utf8'))).toBe(true);
  });

  it('T8-P1: the provider-key canary never leaves — a configured key is absent from the preview; a key reaching the text is a 500 with a fixed code', async () => {
    const org = await aiOrganisation(kit, 'p8-canary');
    const cfg = kit.moduleRef.get(AiConfigService);
    const realFacts = cfg.envFacts.bind(cfg);
    jest.spyOn(cfg, 'envFacts').mockImplementation(() => ({ ...realFacts(), ANTHROPIC_API_KEY: CANARY }));
    const clean = await get('/rest/v1/ai/settings/prompt-preview', org.token);
    expect(clean.status).toBe(200);
    expect(JSON.stringify(clean.body)).not.toContain(CANARY);

    // A defect that put the key into an offered tool description is refused by the scan, with a fixed body.
    const overview = kit.moduleRef.get(AiSettingsOverviewService);
    jest.spyOn(overview, 'offeredTools').mockReturnValue({ leaky_tool: tool({ description: `uses ${CANARY}`, inputSchema: z.object({}), execute: async () => ({}) }) });
    const leaked = await get('/rest/v1/ai/settings/prompt-preview', org.token);
    expect(leaked.status).toBe(500);
    expect(leaked.body).toEqual({ statusCode: 500, code: 'AI_PROMPT_PREVIEW_REFUSED', message: 'The prompt preview could not be shown.' });
    expect(JSON.stringify(leaked.body)).not.toContain(CANARY);
    // A JWT-shaped string is refused the same way (session/JWT shape check).
    jest.spyOn(overview, 'offeredTools').mockReturnValue({ leaky_tool: tool({ description: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4eXoxMjMifQ.c2lnbmF0dXJlMTIz', inputSchema: z.object({}), execute: async () => ({}) }) });
    expect((await get('/rest/v1/ai/settings/prompt-preview', org.token)).status).toBe(500);
    // Only the clean view was audited.
    expect(await previews(org.orgId)).toHaveLength(1);
  });

  it('the endpoints are reads: unknown query parameters change nothing and no body is accepted on GET', async () => {
    const org = await aiOrganisation(kit, 'p8-reads');
    const a = await kit.http().get('/rest/v1/ai/settings?organisationId=' + randomUUID()).set(bearer(org.token));
    expect(a.status).toBe(200);
    expect(a.body.features).toEqual(AI_SETTINGS_FEATURES);
  });
});
