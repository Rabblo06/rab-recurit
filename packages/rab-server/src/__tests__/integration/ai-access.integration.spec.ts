import './helpers/ai-env';

import { randomUUID } from 'node:crypto';

import { AiConversationService } from '../../modules/ai/services/ai-conversation.service';
import { AiKit, aiOrganisation, ask, bearer, bootAiKit, jobFor, manager, newConversation, setOrgAi, turnRow } from './helpers/ai-test-kit';

/**
 * AI Phase 1 — access refusals (brief §15 "Authentication and access"): organisation switch, ai.use, eligibility (CEO /
 * CURRENT Initial Manager only), mobile application targets, Admin Inspect, mass assignment; and the Worker's rebuild
 * from PostgreSQL when the authority changed AFTER the question was queued (suspended user / organisation, revoked
 * permission, ended session, switch turned off). Kill switch OFF: ai-kill-switch.integration.spec.ts.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

const sidOf = (token: string): string => (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { sid: string }).sid;

describeIfDb('AI access control (integration)', () => {
  jest.setTimeout(180_000);
  let kit: AiKit;

  beforeAll(async () => {
    kit = await bootAiKit();
  });
  afterAll(async () => {
    await kit?.close();
  });

  const routes = (conversationId: string) => [
    ['get', '/rest/v1/ai/conversations'],
    ['post', '/rest/v1/ai/conversations'],
    ['get', `/rest/v1/ai/conversations/${conversationId}`],
    ['post', `/rest/v1/ai/conversations/${conversationId}/messages`],
    ['get', `/rest/v1/ai/conversations/${conversationId}/stream?turnId=${randomUUID()}`],
  ] as const;

  async function expectAllUnavailable(token: string, conversationId: string): Promise<void> {
    for (const [method, url] of routes(conversationId)) {
      const req = kit.http()[method](url).set(bearer(token));
      const res = method === 'post' ? await req.send({ content: 'hello', clientRequestId: randomUUID() }) : await req;
      expect({ url, status: res.status, code: res.body?.code }).toEqual({ url, status: 404, code: 'AI_NOT_AVAILABLE' });
    }
  }

  it('organisation switch OFF (the default): every AI route answers the same 404, availability says organisation_disabled', async () => {
    const { token } = await aiOrganisation(kit, 'ai-off', { aiEnabled: false });
    await expectAllUnavailable(token, randomUUID());
    const availability = await kit.http().get('/rest/v1/ai/availability').set(bearer(token));
    expect(availability.status).toBe(200);
    expect(availability.body).toMatchObject({ available: false, reason: 'organisation_disabled' });
  });

  it('CEO with the organisation switch ON can open a conversation; the response carries no tenant identifiers', async () => {
    const { token } = await aiOrganisation(kit, 'ai-ceo');
    const availability = await kit.http().get('/rest/v1/ai/availability').set(bearer(token));
    expect(availability.body).toMatchObject({ available: true, reason: null, limits: { maxInputChars: 4000 } });
    const created = await kit.http().post('/rest/v1/ai/conversations').set(bearer(token)).send({ title: 'Weekend' });
    expect(created.status).toBe(201);
    expect(Object.keys(created.body).sort()).toEqual(['createdAt', 'id', 'lastMessageAt', 'messageCount', 'title']);
  });

  it('the CURRENT Initial Manager is eligible; an additional Internal Manager holding ai.use is not (uniform 404)', async () => {
    const { orgId } = await aiOrganisation(kit, 'ai-im');
    const initial = await manager(kit, orgId, { initial: true });
    const other = await manager(kit, orgId);
    expect((await kit.http().post('/rest/v1/ai/conversations').set(bearer(initial.token)).send({})).status).toBe(201);
    await expectAllUnavailable(other.token, randomUUID());
    expect((await kit.http().get('/rest/v1/ai/availability').set(bearer(other.token))).body).toMatchObject({ available: false, reason: 'not_permitted' });
    // A superseded Initial Manager loses access at once.
    await kit.owner.query(`UPDATE core.manager_profile SET superseded_at = now() WHERE user_id = $1`, [initial.id.userId]);
    expect((await kit.http().post('/rest/v1/ai/conversations').set(bearer(initial.token)).send({})).status).toBe(404);
  });

  it('missing ai.use (a CEO whose role lacks it, or a per-user revoke) is refused with the uniform 404', async () => {
    const org = await kit.factory.createOrganisation('ai-noperm');
    await setOrgAi(kit, org.id, true);
    const ceo = await kit.factory.createCeo(org, { permissions: ['schedule.view', 'attendance.view'] });
    await expectAllUnavailable(await kit.factory.login(ceo), randomUUID());
    const full = await aiOrganisation(kit, 'ai-revoke');
    await kit.owner.query(
      `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect) SELECT $1, id, $2, 'revoke' FROM core.permission WHERE key = 'ai.use'`,
      [full.ceo.userId, full.orgId],
    );
    await kit.owner.query(`UPDATE core."user" SET security_version = security_version + 1 WHERE id = $1`, [full.ceo.userId]).catch(() => undefined);
    await expectAllUnavailable(full.token, randomUUID());
  });

  it('Staff and Venue Manager mobile credentials are refused before the AI layer (@ManagerApplication)', async () => {
    const { orgId, ceo } = await aiOrganisation(kit, 'ai-mobile');
    const staff = await kit.factory.createStaff({ id: orgId }, { owner: ceo });
    const staffToken = await kit.factory.login(staff);
    const res = await kit.http().get('/rest/v1/ai/conversations').set(bearer(staffToken));
    expect(res.status).toBe(403);
    const mobileCeo = await kit.factory.login(ceo, { applicationTarget: 'staff_app' }).catch(() => null);
    if (mobileCeo) expect((await kit.http().get('/rest/v1/ai/availability').set(bearer(mobileCeo))).status).toBe(403);
  });

  it('an Admin Inspect context never reaches AI (service layer, layer 2)', async () => {
    const { ceo } = await aiOrganisation(kit, 'ai-inspect');
    const svc = kit.moduleRef.get(AiConversationService);
    const ctx = { organisationId: ceo.organisationId, workspaceId: ceo.workspaceId, userId: ceo.userId, role: '', inspectedBy: randomUUID() };
    await expect(svc.create(ctx, {})).rejects.toMatchObject({ response: { code: 'AI_NOT_AVAILABLE' } });
    await expect(svc.list(ctx, {})).rejects.toMatchObject({ status: 404 });
  });

  it('a body carrying organisationId / status / role / tools is a 400 (forbidNonWhitelisted), never applied', async () => {
    const { token } = await aiOrganisation(kit, 'ai-mass');
    const id = await newConversation(kit, token);
    for (const extra of [{ organisationId: randomUUID() }, { status: 'completed' }, { role: 'assistant' }, { tools: ['send_offers'] }, { workspaceId: randomUUID() }]) {
      const res = await kit.http().post(`/rest/v1/ai/conversations/${id}/messages`).set(bearer(token)).send({ content: 'hi', ...extra });
      expect(res.status).toBe(400);
    }
    expect((await kit.http().post('/rest/v1/ai/conversations').set(bearer(token)).send({ userId: randomUUID() })).status).toBe(400);
    const [{ n }] = await kit.owner.query(`SELECT count(*)::int AS n FROM core.ai_message WHERE conversation_id = $1`, [id]);
    expect(n).toBe(0);
  });

  describe('Worker rebuilds authority from PostgreSQL (revocation after queueing)', () => {
    async function queued(label: string) {
      const org = await aiOrganisation(kit, label);
      const conversationId = await newConversation(kit, org.token);
      const turn = await ask(kit, org.token, conversationId, 'What is our fill rate this week?');
      expect(turn.status).toBe(202);
      return { ...org, conversationId, turnId: turn.turnId };
    }

    const expectRevoked = async (q: Awaited<ReturnType<typeof queued>>) => {
      expect(await kit.runner.run(jobFor(q.ceo, q.conversationId, q.turnId))).toBe('failed');
      const row = await turnRow(kit, q.turnId);
      expect(row).toMatchObject({ status: 'failed', error_code: 'AI_ACCESS_REVOKED', content: '' });
      const tools = await kit.owner.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE entity_id = $1 AND action = 'ai.tool_called'`, [q.turnId]);
      expect(tools[0].n).toBe(0); // nothing ran
      const refused = await kit.owner.query(`SELECT metadata FROM core.audit_log WHERE entity_id = $1 AND action = 'ai.turn_refused'`, [q.turnId]);
      expect(refused).toHaveLength(1);
    };

    it('suspended user', async () => {
      const q = await queued('ai-w-user');
      await kit.owner.query(`UPDATE core."user" SET status = 'suspended' WHERE id = $1`, [q.ceo.userId]);
      await expectRevoked(q);
    });

    it('suspended organisation', async () => {
      const q = await queued('ai-w-org');
      await kit.owner.query(`UPDATE core.organisation SET suspended_at = now(), suspended_by = $2 WHERE id = $1`, [q.orgId, q.ceo.userId]);
      await expectRevoked(q);
      await kit.owner.query(`UPDATE core.organisation SET suspended_at = NULL, suspended_by = NULL WHERE id = $1`, [q.orgId]);
    });

    it('ai.use revoked mid-queue', async () => {
      const q = await queued('ai-w-perm');
      await kit.owner.query(
        `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect) SELECT $1, id, $2, 'revoke' FROM core.permission WHERE key = 'ai.use'`,
        [q.ceo.userId, q.orgId],
      );
      await expectRevoked(q);
    });

    it('session ended (revoked refresh family) — an expired/revoked session never runs a queued turn', async () => {
      const q = await queued('ai-w-session');
      await kit.owner.query(`UPDATE core.refresh_token SET revoked_at = now() WHERE family_id = $1`, [sidOf(q.token)]);
      await expectRevoked(q);
    });

    it('organisation switch turned OFF after queueing', async () => {
      const q = await queued('ai-w-switch');
      await setOrgAi(kit, q.orgId, false);
      await expectRevoked(q);
    });

    it('wrong workspace: a job whose ids do not match the turn is skipped (RLS shows nothing); the turn stays untouched', async () => {
      const q = await queued('ai-w-ws');
      const other = await manager(kit, q.orgId, { initial: true });
      expect(await kit.runner.run({ ...jobFor(q.ceo, q.conversationId, q.turnId), workspaceId: other.id.workspaceId! })).toBe('skipped');
      expect(await kit.runner.run({ ...jobFor(q.ceo, q.conversationId, q.turnId), userId: other.id.userId })).toBe('skipped');
      expect((await turnRow(kit, q.turnId)).status).toBe('queued');
      expect(await kit.runner.run(jobFor(q.ceo, q.conversationId, q.turnId))).toBe('completed');
    });
  });
});
