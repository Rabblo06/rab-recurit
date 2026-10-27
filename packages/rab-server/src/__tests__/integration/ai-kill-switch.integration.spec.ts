// Platform kill switch OFF (the shipped default). Set before AppModule loads (ConfigModule validates on first load);
// explicit because an earlier AI suite in the same Jest process may have turned it on.
process.env.AI_ENABLED = 'false';

import { randomUUID } from 'node:crypto';

import { AiConfigService } from '../../modules/ai/services/ai-config.service';
import { AiTitleService } from '../../modules/ai/services/ai-title.service';
import { titleJobData } from '../../modules/ai/services/ai-turn-queue.service';
import { scriptedModel, textParts, toolCallParts } from './helpers/ai-models';
import { AiKit, aiOrganisation, bearer, bootAiKit, jobFor, turnRow } from './helpers/ai-test-kit';

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('AI platform kill switch OFF (integration)', () => {
  jest.setTimeout(240_000);
  let kit: AiKit;

  beforeAll(async () => {
    kit = await bootAiKit();
  });
  afterAll(async () => {
    await kit?.close();
  });

  it('every AI route answers 404 AI_NOT_AVAILABLE even for an eligible CEO whose organisation switch is ON', async () => {
    const { token } = await aiOrganisation(kit, 'ai-kill');
    const id = randomUUID();
    for (const [method, url] of [
      ['get', '/rest/v1/ai/conversations'],
      ['post', '/rest/v1/ai/conversations'],
      ['get', `/rest/v1/ai/conversations/${id}`],
      ['post', `/rest/v1/ai/conversations/${id}/messages`],
      ['post', `/rest/v1/ai/conversations/${id}/turns/${randomUUID()}/cancel`],
      ['get', `/rest/v1/ai/conversations/${id}/stream?turnId=${randomUUID()}`],
    ] as const) {
      const req = kit.http()[method](url).set(bearer(token));
      const res = method === 'post' ? await req.send(url.endsWith('messages') ? { content: 'hi' } : {}) : await req;
      expect({ url, status: res.status, code: res.body?.code }).toEqual({ url, status: 404, code: 'AI_NOT_AVAILABLE' });
    }
    expect((await kit.http().get('/rest/v1/ai/availability').set(bearer(token))).body).toMatchObject({ available: false, reason: 'platform_disabled' });
  });

  it('the Worker refuses a turn that was queued before the switch went off (no model call, AI_ACCESS_REVOKED)', async () => {
    const { orgId, ceo, token } = await aiOrganisation(kit, 'ai-kill-w');
    const sid = (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { sid: string }).sid;
    const [conv] = await kit.owner.query(`INSERT INTO core.ai_conversation (organisation_id, workspace_id, user_id) VALUES ($1, $2, $3) RETURNING id`, [orgId, ceo.workspaceId, ceo.userId]);
    const [q] = await kit.owner.query(
      `INSERT INTO core.ai_message (organisation_id, workspace_id, user_id, conversation_id, seq, role, content) VALUES ($1, $2, $3, $4, 1, 'user', 'hello') RETURNING id`,
      [orgId, ceo.workspaceId, ceo.userId, conv.id],
    );
    const [t] = await kit.owner.query(
      `INSERT INTO core.ai_message (organisation_id, workspace_id, user_id, conversation_id, seq, role, status, request_message_id, session_id, reserved_tokens)
       VALUES ($1, $2, $3, $4, 2, 'assistant', 'queued', $5, $6, 100) RETURNING id`,
      [orgId, ceo.workspaceId, ceo.userId, conv.id, q.id, sid],
    );
    expect(await kit.runner.run(jobFor(ceo, conv.id, t.id))).toBe('failed');
    expect(await turnRow(kit, t.id)).toMatchObject({ status: 'failed', error_code: 'AI_ACCESS_REVOKED', content: '' });
  });

  // ── Phase 2 (T2-13) ─────────────────────────────────────────────────────────────────────────────────────────────────
  /** A conversation with a question and an assistant turn in `status`, inserted as the bootstrap identity (AI is off). */
  async function seeded(label: string, statuses: Array<'queued' | 'running'>) {
    const { orgId, ceo, token } = await aiOrganisation(kit, label);
    const sid = (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { sid: string }).sid;
    const [conv] = await kit.owner.query(`INSERT INTO core.ai_conversation (organisation_id, workspace_id, user_id) VALUES ($1, $2, $3) RETURNING id`, [orgId, ceo.workspaceId, ceo.userId]);
    const turns: string[] = [];
    let seq = 1;
    for (const status of statuses) {
      const [q] = await kit.owner.query(
        `INSERT INTO core.ai_message (organisation_id, workspace_id, user_id, conversation_id, seq, role, content) VALUES ($1, $2, $3, $4, $5, 'user', 'hello') RETURNING id`,
        [orgId, ceo.workspaceId, ceo.userId, conv.id, seq++],
      );
      const [t] = await kit.owner.query(
        `INSERT INTO core.ai_message (organisation_id, workspace_id, user_id, conversation_id, seq, role, status, request_message_id, session_id, reserved_tokens, lease_token, lease_expires_at)
         VALUES ($1, $2, $3, $4, $5, 'assistant', $6, $7, $8, 100, CASE WHEN $6 = 'running' THEN gen_random_uuid() END, CASE WHEN $6 = 'running' THEN now() + interval '5 minutes' END) RETURNING id`,
        [orgId, ceo.workspaceId, ceo.userId, conv.id, seq++, status, q.id, sid],
      );
      turns.push(t.id);
    }
    return { orgId, ceo, conversationId: conv.id as string, turns };
  }

  it('T2-13: a queued successor (behind a running turn) and a pending title job are refused with no model call', async () => {
    const s = await seeded('ai-kill-p2', ['running', 'queued']);
    const scripted = scriptedModel([textParts('never')]);
    kit.setModel(scripted.model);
    try {
      // While the predecessor runs the successor only defers (row unchanged); once it is gone the successor is claimed
      // and refused at Worker start (kill switch), before any model call.
      expect(await kit.runner.run(jobFor(s.ceo, s.conversationId, s.turns[1]!))).toBe('deferred');
      await kit.owner.query(`UPDATE core.ai_message SET status = 'failed', error_code = 'AI_INTERNAL_ERROR', lease_token = NULL, lease_expires_at = NULL WHERE id = $1`, [s.turns[0]]);
      expect(await kit.runner.run(jobFor(s.ceo, s.conversationId, s.turns[1]!))).toBe('failed');
      expect(await turnRow(kit, s.turns[1]!)).toMatchObject({ status: 'failed', error_code: 'AI_ACCESS_REVOKED', content: '' });
      const titles = kit.moduleRef.get(AiTitleService);
      const job = titleJobData({ turnId: s.turns[1]!, conversationId: s.conversationId, organisationId: s.orgId, workspaceId: s.ceo.workspaceId!, userId: s.ceo.userId });
      expect(await titles.run(job)).toBe('refused');
      expect(scripted.seen).toHaveLength(0);
      const [audit] = await kit.owner.query(`SELECT metadata FROM core.audit_log WHERE action = 'ai.turn_refused' AND entity_id = $1`, [s.conversationId]);
      expect(audit.metadata).toEqual({ reason: 'platform_disabled', stage: 'title' });
    } finally {
      kit.setModel(null);
    }
  });

  it('T2-13: the kill switch going OFF during a running turn stops it before its next model step', async () => {
    const config = kit.moduleRef.get(AiConfigService);
    const enabled = jest.spyOn(config, 'enabled', 'get').mockReturnValue(true);
    const s = await seeded('ai-kill-p2-running', ['queued']);
    // Step 1 asks for a tool; the switch goes off while that step streams; step 2 must never be requested.
    const scripted = scriptedModel([
      () => {
        enabled.mockReturnValue(false);
        return toolCallParts('get_fill_rate', { from: '2026-10-01', to: '2026-10-07' });
      },
      textParts('should never be generated'),
    ]);
    kit.setModel(scripted.model);
    try {
      expect(await kit.runner.run(jobFor(s.ceo, s.conversationId, s.turns[0]!))).toBe('failed');
      expect(scripted.seen).toHaveLength(1);
      expect(await turnRow(kit, s.turns[0]!)).toMatchObject({ status: 'failed', error_code: 'AI_ACCESS_REVOKED' });
    } finally {
      kit.setModel(null);
      enabled.mockRestore();
    }
  });
});
