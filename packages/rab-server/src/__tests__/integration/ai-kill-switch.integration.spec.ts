// Platform kill switch OFF (the shipped default). Set before AppModule loads (ConfigModule validates on first load);
// explicit because an earlier AI suite in the same Jest process may have turned it on.
process.env.AI_ENABLED = 'false';

import { randomUUID } from 'node:crypto';

import { AiKit, aiOrganisation, bearer, bootAiKit, jobFor, turnRow } from './helpers/ai-test-kit';

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('AI platform kill switch OFF (integration)', () => {
  jest.setTimeout(120_000);
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
});
