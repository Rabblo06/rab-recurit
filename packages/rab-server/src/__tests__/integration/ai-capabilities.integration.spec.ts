import './helpers/ai-env';

import { randomUUID } from 'node:crypto';

import { AI_BUILTIN_SKILL_NAMES, AI_WRITE_TOOL_NAMES, PermissionFlagType } from '@rab/shared';

import { AiCapabilitiesService } from '../../modules/ai/services/ai-capabilities.service';
import { AiConfigService } from '../../modules/ai/services/ai-config.service';
import { AiToolRegistry } from '../../modules/ai/tools/ai-tool-registry.service';
import { AiKit, aiOrganisation, bearer, bootAiKit, manager, setOrgAi } from './helpers/ai-test-kit';

/**
 * Batch 3 S4 — `GET /rest/v1/ai/capabilities` (C1 CD-8) on the real AppModule (crewflow_app, FORCE RLS):
 *   - exactly the caller's permitted read tools (the registry's own filter, flags read from PostgreSQL), then the write
 *     tools the caller could only PROPOSE (labelled approval-only), then the active skills (no content);
 *   - nothing the caller lacks: a narrow user sees only their flags' tools and no write tool; a revoked flag disappears
 *     at once; a switched-off skill is not listed;
 *   - abuse: AI off, the kill switch, a user without ai.use / not eligible, Admin Inspect → the uniform 404.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const CAPS = '/rest/v1/ai/capabilities';

describeIfDb('AI S4: GET /ai/capabilities (integration)', () => {
  jest.setTimeout(240_000);
  let kit: AiKit;
  let registry: AiToolRegistry;

  beforeAll(async () => {
    kit = await bootAiKit();
    registry = kit.moduleRef.get(AiToolRegistry);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await kit?.close();
  });

  type Caps = { tools: Array<{ name: string; label: string; summary: string }>; skills: Array<Record<string, unknown>> };
  const caps = async (token: string) => kit.http().get(CAPS).set(bearer(token));
  const allFlags = () => new Set(registry.catalogue().flatMap((t) => (t.permission ? [t.permission] : [])) as PermissionFlagType[]);

  it('the CEO: every permitted read tool, the three write tools as approval-only, the active built-in skills (no content)', async () => {
    const org = await aiOrganisation(kit, 's4-ceo');
    const res = await caps(org.token);
    expect(res.status).toBe(200);
    const body = res.body as Caps;
    expect(Object.keys(body).sort()).toEqual(['skills', 'tools']);
    const reads = registry.catalogueFor(allFlags()).map((l) => l.name);
    expect(body.tools.map((t) => t.name)).toEqual([...reads, ...[...AI_WRITE_TOOL_NAMES].sort()]);
    for (const t of body.tools) expect(Object.keys(t).sort()).toEqual(['label', 'name', 'summary']);
    for (const w of body.tools.filter((t) => (AI_WRITE_TOOL_NAMES as readonly string[]).includes(t.name))) {
      expect(w.summary).toMatch(/approve/);
      expect(w.label).toMatch(/^Suggest/);
    }
    expect(body.skills.map((s) => s.name).sort()).toEqual([...AI_BUILTIN_SKILL_NAMES].sort());
    for (const s of body.skills) expect(Object.keys(s).sort()).toEqual(['description', 'label', 'name']);
    // Never a pause/meta tool, never an SDK schema.
    expect(JSON.stringify(body)).not.toMatch(/propose_action|ask_question|request_form|execute_tool|inputSchema/);
  });

  it('a narrow user sees only their own flags’ tools and NO write tool (nothing they lack appears)', async () => {
    const org = await kit.factory.createOrganisation('s4-narrow');
    await setOrgAi(kit, org.id, true);
    const ceo = await kit.factory.createCeo(org, { permissions: ['ai.use', 'schedule.view'] });
    const token = await kit.factory.login(ceo);
    const res = await caps(token);
    expect(res.status).toBe(200);
    const names = (res.body as Caps).tools.map((t) => t.name);
    expect(names).toEqual(registry.catalogueFor(new Set(['schedule.view' as PermissionFlagType])).map((l) => l.name));
    expect(names).not.toContain('compare_payroll_runs');
    for (const w of AI_WRITE_TOOL_NAMES) expect(names).not.toContain(w);
  });

  it('a revoked flag disappears at once (read from PostgreSQL per request, never the token); a switched-off skill is not listed', async () => {
    const org = await aiOrganisation(kit, 's4-revoke');
    expect(((await caps(org.token)).body as Caps).tools.map((t) => t.name)).toContain('compare_payroll_runs');
    await kit.owner.query(
      `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect) SELECT $1, id, $2, 'revoke' FROM core.permission WHERE key IN ('payroll.view', 'schedule.create')`,
      [org.ceo.userId, org.orgId],
    );
    await kit.owner.query(
      `INSERT INTO core.ai_skill (organisation_id, name, is_system, is_active, created_by, updated_by, reason) VALUES ($1, 'shift-filling', true, false, $2, $2, 'test fixture')
       ON CONFLICT (organisation_id, name) DO UPDATE SET is_active = false`,
      [org.orgId, org.ceo.userId],
    );
    const body = (await caps(org.token)).body as Caps;
    const names = body.tools.map((t) => t.name);
    expect(names).not.toContain('compare_payroll_runs');
    expect(names).not.toContain('create_draft_shift');
    expect(names).not.toContain('update_draft_shift');
    expect(names).toContain('add_staff_note'); // staff.edit still held
    expect(body.skills.map((s) => s.name)).not.toContain('shift-filling');
  });

  it('abuse: AI off, the kill switch, a user who may not use AI, and Admin Inspect all get the uniform 404', async () => {
    const off = await aiOrganisation(kit, 's4-off', { aiEnabled: false });
    expect({ status: (await caps(off.token)).status, code: (await caps(off.token)).body.code }).toEqual({ status: 404, code: 'AI_NOT_AVAILABLE' });
    const org = await aiOrganisation(kit, 's4-abuse');
    const plain = await manager(kit, org.orgId); // not the Initial Manager: not AI-eligible
    const res = await caps(plain.token);
    expect({ status: res.status, code: res.body.code }).toEqual({ status: 404, code: 'AI_NOT_AVAILABLE' });
    expect(JSON.stringify(res.body)).not.toMatch(/find_shifts|skills/);
    const svc = kit.moduleRef.get(AiCapabilitiesService);
    await expect(svc.view({ organisationId: org.orgId, workspaceId: org.ceo.workspaceId, userId: org.ceo.userId, role: '', inspectedBy: randomUUID(), sessionId: randomUUID() })).rejects.toMatchObject({ status: 404 });
    jest.spyOn(kit.moduleRef.get(AiConfigService), 'enabled', 'get').mockReturnValue(false);
    expect((await caps(org.token)).status).toBe(404);
  });
});
